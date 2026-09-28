import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name } from './index.js';

type RegisteredRoute = {
  kind: 'exact';
  path: string;
  handler(req: any, res: any): Promise<void>;
};

type ServiceListener = (name: string, value: unknown) => void;

const temporaryDirectories = new Set<string>();

function createLogger() {
  const methods = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return Object.assign(vi.fn(() => methods), methods);
}

function createWebServer() {
  const routes: RegisteredRoute[] = [];
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  const register = vi.fn((route: RegisteredRoute) => {
    routes.push(route);
    const dispose = vi.fn(() => {
      const index = routes.indexOf(route);
      if (index >= 0) routes.splice(index, 1);
    });
    disposers.push(dispose);
    return dispose;
  });

  return { server: { register }, register, routes, disposers };
}

function createProfileContext(dir = '/test/profile') {
  return {
    name: 'wuyou-test',
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(dir, 'package.json'),
    cwd: '/test/workspace',
    home: '/test/home',
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  };
}

function createContext(initialServices: Record<string, unknown> = {}) {
  const services = new Map(Object.entries(initialServices));
  const serviceListeners = new Set<ServiceListener>();
  const effectDisposers: Array<() => void> = [];
  const logger = createLogger();

  const ctx = {
    get: vi.fn((key: string) => services.get(key)),
    logger,
    effect: vi.fn((execute: () => void | (() => void)) => {
      const disposer = execute();
      if (typeof disposer === 'function') effectDisposers.push(disposer);
      return vi.fn();
    }),
    on: vi.fn((event: string, listener: ServiceListener) => {
      if (event === 'internal/service') serviceListeners.add(listener);
      return () => serviceListeners.delete(listener);
    }),
  };

  return {
    ctx,
    effectDisposers,
    setService(key: string, value: unknown) {
      if (value === undefined) services.delete(key);
      else services.set(key, value);
      for (const listener of serviceListeners) listener(key, value);
    },
  };
}

async function createFixtureProfile() {
  const dir = await mkdtemp(join(tmpdir(), 'wuyou-agent-index-'));
  temporaryDirectories.add(dir);
  const fixture = await readFile(
    new URL('../test/fixtures/real-web-cordis.patch.yml', import.meta.url),
    'utf8'
  );
  await writeFile(join(dir, 'cordis.patch.yml'), fixture, 'utf8');
  return dir;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((dir) => rm(dir, { recursive: true, force: true }))
  );
  temporaryDirectories.clear();
});

describe('index', () => {
  it('exports plugin name', () => {
    expect(name).toBe('wuyou-agent');
  });

  it('does not throw when webServer is missing and listens for a later binding', () => {
    const harness = createContext();

    expect(() => apply(harness.ctx as any, undefined)).not.toThrow();
    expect(harness.ctx.logger.info).toHaveBeenCalledWith(
      'wuyou-agent: webServer not available, waiting to register HTTP routes'
    );
    expect(harness.ctx.on).toHaveBeenCalledWith('internal/service', expect.any(Function));
  });

  it.each([
    ['undefined config', undefined],
    ['empty config', {}],
  ])('registers three routes and defaults to standard-acp with %s', async (_label, config) => {
    const profileDir = await createFixtureProfile();
    const web = createWebServer();
    const connection = { requestRejection: vi.fn().mockReturnValue(undefined) };
    const harness = createContext({
      webServer: web.server,
      connection,
      profileContext: createProfileContext(profileDir),
    });

    expect(() => apply(harness.ctx as any, config)).not.toThrow();

    expect(web.routes.map((route) => route.path)).toEqual([
      '/plugins/dsh-wuyou-agent/api/state',
      '/plugins/dsh-wuyou-agent/api/subagents',
      '/plugins/dsh-wuyou-agent/api/members',
    ]);
    expect(harness.ctx.effect).toHaveBeenCalledTimes(3);
    expect(harness.effectDisposers).toEqual(web.disposers);

    const stateRoute = web.routes.find(
      (route) => route.path === '/plugins/dsh-wuyou-agent/api/state'
    );
    expect(stateRoute).toBeDefined();

    let responseBody = '';
    const response = {
      writeHead: vi.fn(),
      end: vi.fn((body?: string) => {
        responseBody = body ?? '';
      }),
    };
    await stateRoute!.handler(
      { method: 'GET', url: '/plugins/dsh-wuyou-agent/api/state' },
      response
    );

    expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(JSON.parse(responseBody).profile).toBe('standard-acp');
  });

  it('registers once when webServer binds after apply', () => {
    const web = createWebServer();
    const harness = createContext({ profileContext: createProfileContext() });

    apply(harness.ctx as any, {});
    expect(web.register).not.toHaveBeenCalled();

    harness.setService('webServer', web.server);
    expect(web.register).toHaveBeenCalledTimes(3);

    harness.setService('webServer', web.server);
    harness.setService('unrelated', {});
    expect(web.register).toHaveBeenCalledTimes(3);
  });

  it('wraps handlers with the real connection service object shape', async () => {
    const web = createWebServer();
    const requestRejection = vi.fn().mockReturnValue(401);
    const harness = createContext({
      webServer: web.server,
      connection: { requestRejection },
      profileContext: createProfileContext(),
    });

    apply(harness.ctx as any, {});
    const stateRoute = web.routes.find(
      (route) => route.path === '/plugins/dsh-wuyou-agent/api/state'
    );
    expect(stateRoute).toBeDefined();

    const request = { url: '/plugins/dsh-wuyou-agent/api/state' };
    const response = { writeHead: vi.fn(), end: vi.fn() };
    await stateRoute!.handler(request, response);

    expect(requestRejection).toHaveBeenCalledWith(request);
    expect(response.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('unauthorized'));
  });

  it('fails closed with 503 while the connection service is unavailable', async () => {
    const web = createWebServer();
    const harness = createContext({
      webServer: web.server,
      profileContext: createProfileContext(),
    });

    apply(harness.ctx as any, {});
    expect(web.register).toHaveBeenCalledTimes(3);

    const stateRoute = web.routes.find(
      (route) => route.path === '/plugins/dsh-wuyou-agent/api/state'
    );
    const response = { writeHead: vi.fn(), end: vi.fn() };
    await stateRoute!.handler(
      { url: '/plugins/dsh-wuyou-agent/api/state' },
      response
    );

    expect(response.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(response.end).toHaveBeenCalledWith(
      JSON.stringify({ error: 'authentication unavailable' })
    );
  });
});
