import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { appendFile, copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPatchIO } from '../../src/host/patch-file.js';
import { computeRevision } from '../../src/host/patch-io.js';
import { readCatalog } from '../../src/host/catalog.js';
import { listMembers, listSubagents } from '../../src/index.js';
import { createRoutes, type RouteDescriptor } from '../../src/host/http-routes.js';

const fixturePath = fileURLToPath(new URL('../fixtures/real-web-cordis.patch.yml', import.meta.url));

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not receive a TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function request(
  base: string,
  path: string,
  method = 'GET',
  body?: Record<string, unknown>,
  authenticated = true,
): Promise<HttpResult> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(authenticated ? { 'x-test-auth': 'ok' } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text.length > 0) parsed = JSON.parse(text) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

describe('real fixture HTTP route integration', () => {
  let profileDir: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'wuyou-route-integration-'));
    await copyFile(fixturePath, join(profileDir, 'cordis.patch.yml'));
    await writeFile(join(profileDir, 'package.json'), '{"name":"route-test-profile"}\n', 'utf8');

    const withFileLock = async <T>(_lockPath: string, operation: () => Promise<T>): Promise<T> => operation();
    const writeFileAtomic = async (path: string, content: string): Promise<void> => {
      const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporaryPath, content, 'utf8');
      await rename(temporaryPath, path);
    };
    const io = createPatchIO(profileDir, withFileLock, writeFileAtomic);
    const routes = createRoutes({
      io,
      profileDefault: 'standard-acp',
      getCatalog: (yamlText) => readCatalog(yamlText),
    });
    const routeByPath = new Map(routes.map((route) => [route.path, route]));

    server = createServer(async (req, res) => {
      if (req.headers['x-test-auth'] !== 'ok') {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const route = routeByPath.get(pathname);
      if (!route) {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        await route.handler(req, res);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    base = await listen(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(profileDir, { recursive: true, force: true });
  });

  it('enforces authentication before serving state', async () => {
    const response = await request(base, '/plugins/dsh-wuyou-agent/api/state?profile=standard-acp', 'GET', undefined, false);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('serves parsed state from a copied real patch', async () => {
    const response = await request(base, '/plugins/dsh-wuyou-agent/api/state?profile=standard-acp');
    expect(response.status).toBe(200);
    expect(response.body.profile).toBe('standard-acp');
    expect(response.body.errors).toEqual({});
    expect(response.body.subagents).toHaveLength(13);
    expect(response.body.members).toHaveLength(5);
    expect((response.body.catalog as { providers: unknown[] }).providers).toHaveLength(2);
  });

  it('persists a subagent mutation and rereads it from disk', async () => {
    const state = await request(base, '/plugins/dsh-wuyou-agent/api/state?profile=standard-acp');
    const expectedRevision = String(state.body.revision);
    const response = await request(base, '/plugins/dsh-wuyou-agent/api/subagents', 'POST', {
      expectedRevision,
      action: 'create',
      input: {
        toolName: 'subagent_route_test',
        provider: 'spawn',
        backgroundMode: 'continuable',
        agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'high' },
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.notice).toBe('已保存，新建会话后生效');

    const persisted = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8');
    expect(listSubagents(persisted).some((row) => row.id === 'tool-subagent-route-test')).toBe(true);
    expect(String(response.body.revision)).toBe(computeRevision(persisted));
  });

  it('updates one member while preserving the real fixture tail keys', async () => {
    const beforeState = await request(base, '/plugins/dsh-wuyou-agent/api/state?profile=standard-acp');
    const response = await request(base, '/plugins/dsh-wuyou-agent/api/members', 'POST', {
      expectedRevision: String(beforeState.body.revision),
      profile: 'standard-acp',
      action: 'update',
      name: 'coder',
      patch: { role: 'route integration updated' },
    });
    expect(response.status).toBe(200);

    const persisted = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8');
    const members = listMembers(persisted, 'standard-acp');
    expect(members.find((member) => member.name === 'coder')?.role).toBe('route integration updated');
    expect(persisted).toContain('  value:\n  op: add\n  path:\n');
  expect(String(response.body.revision)).toBe(computeRevision(persisted));
  expect(response.body.members).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'coder', role: 'route integration updated' }),
  ]));
  expect(response.body.members).toHaveLength(5);
});

  it('allows registered ACP updates and rejects unregistered providers without changing the file', async () => {
    const initial = await request(base, '/plugins/dsh-wuyou-agent/api/state?profile=standard-acp');
    const initialRevision = String(initial.body.revision);
    const acpUpdate = await request(base, '/plugins/dsh-wuyou-agent/api/subagents', 'POST', {
      expectedRevision: initialRevision,
      action: 'update',
      id: 'tool-subagent-acp',
      patch: { toolName: 'subagent_route_acp' },
    });
    expect(acpUpdate.status).toBe(200);
    expect(acpUpdate.body.notice).toBe('已保存，新建会话后生效');
    const afterAcp = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8');
    expect(listSubagents(afterAcp).find((row) => row.id === 'tool-subagent-route-acp')?.config.toolName).toBe('subagent_route_acp');

    const beforeReadOnly = afterAcp;
    const readOnly = await request(base, '/plugins/dsh-wuyou-agent/api/subagents', 'POST', {
      expectedRevision: String(acpUpdate.body.revision),
      action: 'update',
      id: 'tool-subagent-codex',
      patch: { backgroundMode: 'one-shot' },
    });
    expect(readOnly.status).toBe(422);
    expect(readOnly.body.code).toBe('READ_ONLY');
    expect(readOnly.body.message).toBe("provider 'codex' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑");
    expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(beforeReadOnly);

    await appendFile(join(profileDir, 'cordis.patch.yml'), '\n# external revision change\n', 'utf8');
    const beforeStale = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8');
    const stale = await request(base, '/plugins/dsh-wuyou-agent/api/subagents', 'POST', {
      expectedRevision: initialRevision,
      action: 'create',
      input: {
        toolName: 'subagent_stale_test',
        provider: 'spawn',
        agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' },
      },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    expect(stale.body.message).toBe('配置已被其他地方修改，请刷新后重试');
    expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(beforeStale);
  });

  it('moves a subagent down and back up through the route, restoring the fixture bytes', async () => {
    const original = await readFile(fixturePath, 'utf8');
    const patchPath = join(profileDir, 'cordis.patch.yml');
    const state = await request(base, '/plugins/dsh-wuyou-agent/api/state?profile=standard-acp');

    const down = await request(base, '/plugins/dsh-wuyou-agent/api/subagents', 'POST', {
      expectedRevision: String(state.body.revision),
      action: 'move',
      id: 'tool-subagent-fork',
      direction: 'down',
    });
    expect(down.status).toBe(200);
    expect(down.body.notice).toBe('已下移。只改变列表顺序，不影响模型看到的工具顺序');

    const moved = await readFile(patchPath, 'utf8');
    expect(moved).not.toBe(original);
    expect(String(down.body.revision)).toBe(computeRevision(moved));
    const movedIds = listSubagents(moved).map((row) => row.id);
    expect(movedIds.indexOf('tool-subagent-acp')).toBeLessThan(movedIds.indexOf('tool-subagent-fork'));
    expect((down.body.subagents as Array<{ id: string }>).map((row) => row.id)).toEqual(movedIds);

    const up = await request(base, '/plugins/dsh-wuyou-agent/api/subagents', 'POST', {
      expectedRevision: String(down.body.revision),
      action: 'move',
      id: 'tool-subagent-fork',
      direction: 'up',
    });
    expect(up.status).toBe(200);
    expect(up.body.notice).toBe('已上移。只改变列表顺序，不影响模型看到的工具顺序');
    expect(await readFile(patchPath, 'utf8')).toBe(original);
  });

});
