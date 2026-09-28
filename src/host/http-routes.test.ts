import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { createRoutes, MAX_BODY_BYTES } from './http-routes.js';
import type { RouteContext } from './http-routes.js';
import type { PatchIO } from './patch-file.js';
import { readCatalog } from './catalog.js';
import type { ModelCatalog } from './catalog.js';
import { computeRevision } from './patch-io.js';
import { listSubagents } from './subagent-manager.js';
import { listMembers } from './members-editor.js';

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function createRawReq(method: string, url: string, raw: string | Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const readable = Readable.from([typeof raw === 'string' ? Buffer.from(raw) : raw]);
  return Object.assign(readable, { method, url, headers }) as unknown as IncomingMessage;
}

function createMockReq(method: string, url: string, body?: Record<string, unknown>): IncomingMessage {
  return createRawReq(method, url, body ? JSON.stringify(body) : '');
}

function createMockRes(): [ServerResponse, () => MockResponse] {
  const response: MockResponse = { statusCode: 200, headers: {}, body: '' };
  const chunks: Buffer[] = [];

  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });

  const res = Object.assign(writable, {
    writeHead(code: number, headers?: Record<string, string>) {
      response.statusCode = code;
      if (headers) Object.assign(response.headers, headers);
    },
    end(data?: string | Buffer) {
      if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      response.body = Buffer.concat(chunks).toString('utf8');
    },
  }) as unknown as ServerResponse;

  return [res, () => response];
}

const REAL_FIXTURE = readFileSync(resolve(__dirname, '../../test/fixtures/real-web-cordis.patch.yml'), 'utf8');

/** In-memory PatchIO with the same revision contract as createPatchIO. */
function memoryIO(initial: string): { io: PatchIO; text: () => string } {
  let current = initial;
  return {
    text: () => current,
    io: {
      async readPatch() {
        return current;
      },
      async writePatchLocked(expectedRevision, transform) {
        if (computeRevision(current) !== expectedRevision) {
          const err = new Error('配置已被其他地方修改，请刷新后重试') as Error & { code: string };
          err.code = 'STALE_REVISION';
          throw err;
        }
        current = await transform(current);
        return computeRevision(current);
      },
    },
  };
}

/** Production-shaped catalog provider: always async, like buildCatalog awaiting ctx.llm. */
function asyncCatalog(catalog?: ModelCatalog): RouteContext['getCatalog'] {
  return async (yamlText) => {
    await new Promise((resolveTick) => setImmediate(resolveTick));
    return catalog ?? readCatalog(yamlText);
  };
}

async function call(
  routes: ReturnType<typeof createRoutes>,
  suffix: string,
  req: IncomingMessage,
): Promise<{ status: number; data: any; raw: string }> {
  const route = routes.find((r) => r.path.endsWith(suffix));
  expect(route).toBeDefined();
  const [res, getResponse] = createMockRes();
  await route!.handler(req, res);
  const response = getResponse();
  return { status: response.statusCode, data: response.body ? JSON.parse(response.body) : undefined, raw: response.body };
}

describe('http-routes', () => {
  const fixtureYaml = `
- insert:
    - id: preset-standard-acp
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard-acp
        plugins:
          - id: delegation
            name: cordis:group
            config:
              - id: tool-subagent-coder
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent_coder
                  agentOptions:
                    provider: test-provider
                    model: test-model
- id: agent-teams
  name: '@nanmicoder/dsh-agent-teams'
  config:
    profiles:
      standard-acp:
        members:
          - name: tester
            role: test role
`;

  const catalog: ModelCatalog = {
    providers: [
      {
        id: 'test-provider',
        models: [
          { id: 'test-model', reasoningEfforts: ['low', 'high'] },
        ],
      },
    ],
  };

  let currentYaml: string;
  let io: PatchIO;

  beforeEach(() => {
    currentYaml = fixtureYaml;
    io = {
      async readPatch() {
        return currentYaml;
      },
      async writePatchLocked(expectedRevision, transform) {
        const rev = computeRevision(currentYaml);
        if (rev !== expectedRevision) {
          const err = new Error('配置已被其他地方修改，请刷新后重试') as Error & { code: string };
          err.code = 'STALE_REVISION';
          throw err;
        }
        currentYaml = await transform(currentYaml);
        return computeRevision(currentYaml);
      },
    };
  });

  it('GET state returns current state', async () => {
    const routes = createRoutes({
      io,
      profileDefault: 'standard-acp',
      getCatalog: asyncCatalog(catalog),
      logger: undefined,
    });

    const { status, data } = await call(routes, '/state', createMockReq('GET', '/plugins/dsh-wuyou-agent/api/state?profile=standard-acp'));

    expect(status).toBe(200);
    expect(data.revision).toBe(computeRevision(fixtureYaml));
    expect(data.catalog).toEqual(catalog);
    expect(data.subagents).toHaveLength(1);
    expect(data.subagents[0].id).toBe('tool-subagent-coder');
    expect(data.members).toHaveLength(1);
    expect(data.members[0].name).toBe('tester');
  });

  it('POST subagents creates new subagent', async () => {
    const routes = createRoutes({
      io,
      profileDefault: 'standard-acp',
      getCatalog: asyncCatalog(catalog),
      logger: undefined,
    });

    const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', {
      expectedRevision: computeRevision(currentYaml),
      action: 'create',
      input: {
        toolName: 'subagent_new',
        provider: 'spawn',
        agentOptions: { provider: 'test-provider', model: 'test-model' },
      },
    }));

    expect(status).toBe(200);
    expect(data.notice).toBe('已保存，新建会话后生效');
    expect(data.subagents).toHaveLength(2);
    expect(data.subagents.some((s: any) => s.id === 'tool-subagent-new')).toBe(true);
  });

  it('POST subagents returns 409 on stale revision', async () => {
    const routes = createRoutes({
      io,
      profileDefault: 'standard-acp',
      getCatalog: asyncCatalog(catalog),
      logger: undefined,
    });

    const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', {
      // Well-formed but stale (malformed revisions are a 400, see F22-INPUT).
      expectedRevision: '0'.repeat(64),
      action: 'create',
      input: {
        toolName: 'subagent_new',
        provider: 'spawn',
        agentOptions: { provider: 'test-provider', model: 'test-model' },
      },
    }));

    expect(status).toBe(409);
    expect(data.code).toBe('STALE_REVISION');
    expect(data.message).toContain('配置已被其他地方修改');
  });

  it('POST members adds new member', async () => {
    const routes = createRoutes({
      io,
      profileDefault: 'standard-acp',
      getCatalog: asyncCatalog(catalog),
      logger: undefined,
    });

    const { status, data } = await call(routes, '/members', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/members', {
      expectedRevision: computeRevision(currentYaml),
      profile: 'standard-acp',
      action: 'add',
      member: {
        name: 'newmember',
        provider: 'test-provider',
        model: 'test-model',
      },
    }));

    expect(status).toBe(200);
    expect(data.notice).toBe('已保存，新建会话后生效');
    expect(data.members).toHaveLength(2);
    expect(data.members.some((m: any) => m.name === 'newmember')).toBe(true);
  });

  it('returns 405 for non-POST on mutation routes', async () => {
    const routes = createRoutes({
      io,
      profileDefault: 'standard-acp',
      getCatalog: asyncCatalog(catalog),
      logger: undefined,
    });

    const route = routes.find((r) => r.path.endsWith('/subagents'));
    const [res, getResponse] = createMockRes();
    await route!.handler(createMockReq('GET', '/plugins/dsh-wuyou-agent/api/subagents'), res);
    expect(getResponse().statusCode).toBe(405);
  });
});

// Regression suite for t16 F1/F4/F5/F6/F7. Every case injects an async
// getCatalog (the production shape) over the redacted real fixture.
describe('http-routes with async catalog on the real fixture', () => {
  let store: ReturnType<typeof memoryIO>;
  let routes: ReturnType<typeof createRoutes>;

  beforeEach(() => {
    store = memoryIO(REAL_FIXTURE);
    routes = createRoutes({
      io: store.io,
      profileDefault: 'standard-acp',
      getCatalog: asyncCatalog(),
      getAtomicWriteDiagnostics: () => ({ loaded: true, anchor: 'file:///anchor/package.json', resolvedPath: '/resolved/index.js' }),
      logger: undefined,
    });
  });

  const post = (suffix: string, body: Record<string, unknown>) =>
    call(routes, suffix, createMockReq('POST', `/plugins/dsh-wuyou-agent/api${suffix}`, body));

  it('F1: spawn create with an async catalog returns 200 and writes the row', async () => {
    const { status, data } = await post('/subagents', {
      expectedRevision: computeRevision(REAL_FIXTURE),
      action: 'create',
      input: {
        toolName: 'subagent_async_check',
        provider: 'spawn',
        backgroundMode: 'continuable',
        agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' },
      },
    });

    expect(status).toBe(200);
    expect(data.revision).toBe(computeRevision(store.text()));
    expect(listSubagents(store.text()).map((row) => row.id)).toContain('tool-subagent-async-check');
  });

  it('F1: spawn update (backgroundMode only) with an async catalog returns 200', async () => {
    const { status } = await post('/subagents', {
      expectedRevision: computeRevision(REAL_FIXTURE),
      action: 'update',
      id: 'tool-subagent-coder',
      patch: { backgroundMode: 'one-shot' },
    });

    expect(status).toBe(200);
    expect(listSubagents(store.text()).find((row) => row.id === 'tool-subagent-coder')?.config.backgroundMode).toBe('one-shot');
  });

  it('F1: updating only the role of a member with a model returns 200', async () => {
    const { status, data } = await post('/members', {
      expectedRevision: computeRevision(REAL_FIXTURE),
      profile: 'standard-acp',
      action: 'update',
      name: 'claude',
      patch: { role: '只改角色' },
    });

    expect(status).toBe(200);
    const claude = listMembers(store.text(), 'standard-acp').find((member) => member.name === 'claude');
    expect(claude).toMatchObject({ role: '只改角色', provider: 'gusu-gateway', model: 'claude-opus-5-5' });
    expect(data.members.find((member: any) => member.name === 'claude').role).toBe('只改角色');
  });

  it('F1: adding a member with a model returns 200', async () => {
    const { status } = await post('/members', {
      expectedRevision: computeRevision(REAL_FIXTURE),
      profile: 'standard-acp',
      action: 'add',
      member: { name: 'async-member', provider: 'gpt-gateway', model: 'gpt-6-luna', reasoning_effort: 'max' },
    });

    expect(status).toBe(200);
    expect(listMembers(store.text(), 'standard-acp').map((member) => member.name)).toContain('async-member');
  });

  it('F6: editing a spawn row to fork drops its agentOptions and returns 200', async () => {
    const { status } = await post('/subagents', {
      expectedRevision: computeRevision(REAL_FIXTURE),
      action: 'update',
      id: 'tool-subagent-coder',
      patch: { provider: 'fork' },
    });

    expect(status).toBe(200);
    const row = listSubagents(store.text()).find((entry) => entry.id === 'tool-subagent-coder');
    expect(row?.config.provider).toBe('fork');
    expect(row?.config).not.toHaveProperty('agentOptions');
  });

  it('F6: spawn → fork with explicit agentOptions is still INVALID', async () => {
    const { status, data } = await post('/subagents', {
      expectedRevision: computeRevision(REAL_FIXTURE),
      action: 'update',
      id: 'tool-subagent-coder',
      patch: { provider: 'fork', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
    });

    expect(status).toBe(400);
    expect(data.code).toBe('INVALID');
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  it('F4: a body over 1MB returns 413 PAYLOAD_TOO_LARGE without writing', async () => {
    const huge = JSON.stringify({ expectedRevision: computeRevision(REAL_FIXTURE), action: 'create', pad: 'x'.repeat(MAX_BODY_BYTES) });
    const { status, data } = await call(routes, '/subagents', createRawReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', huge));

    expect(status).toBe(413);
    expect(data).toEqual({ code: 'PAYLOAD_TOO_LARGE', message: '请求体超过 1MB 上限' });
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  it('F4: a declared content-length over 1MB is rejected with 413 before reading', async () => {
    const req = createRawReq('POST', '/plugins/dsh-wuyou-agent/api/members', '{}', { 'content-length': String(MAX_BODY_BYTES + 1) });
    const { status, data } = await call(routes, '/members', req);

    expect(status).toBe(413);
    expect(data.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('F4: malformed JSON returns 400 INVALID', async () => {
    const { status, data } = await call(routes, '/members', createRawReq('POST', '/plugins/dsh-wuyou-agent/api/members', '{"expectedRevision":'));

    expect(status).toBe(400);
    expect(data).toEqual({ code: 'INVALID', message: '请求体不是合法 JSON' });
  });

  it('F5: writing to a missing team profile returns 404 NOT_FOUND', async () => {
    const { status, data } = await post('/members', {
      expectedRevision: computeRevision(REAL_FIXTURE),
      profile: 'no-such-profile',
      action: 'add',
      member: { name: 'ghost' },
    });

    expect(status).toBe(404);
    expect(data).toEqual({ code: 'NOT_FOUND', message: "未找到团队 profile 'no-such-profile'" });
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  it('F5: a patch without agent-teams returns 500 STRUCTURE', async () => {
    const withoutTeams = '- id: tool-bash\n  name: \'@deepseek-ai/dsh-tool-bash\'\n';
    const bare = memoryIO(withoutTeams);
    const bareRoutes = createRoutes({ io: bare.io, profileDefault: 'standard-acp', getCatalog: asyncCatalog() });
    const { status, data } = await call(bareRoutes, '/members', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/members', {
      expectedRevision: computeRevision(withoutTeams),
      profile: 'standard-acp',
      action: 'add',
      member: { name: 'ghost' },
    }));

    expect(status).toBe(500);
    expect(data.code).toBe('STRUCTURE');
    expect(Object.keys(data).sort()).toEqual(['code', 'message']);
  });

  it('F5: GET state for a missing profile stays 200 with members [] and errors.members', async () => {
    const { status, data } = await call(routes, '/state', createMockReq('GET', '/plugins/dsh-wuyou-agent/api/state?profile=no-such-profile'));

    expect(status).toBe(200);
    expect(data.members).toEqual([]);
    expect(data.errors.members).toBe("未找到团队 profile 'no-such-profile'");
    expect(data.teamProfiles).toContain('standard-acp');
  });

  it('unexpected failures return {code, message} without a stack', async () => {
    const broken = createRoutes({
      io: { readPatch: async () => { throw new Error('EACCES: secret /path'); }, writePatchLocked: async () => '' },
      profileDefault: 'standard-acp',
      getCatalog: asyncCatalog(),
    });
    const { status, data, raw } = await call(broken, '/state', createMockReq('GET', '/plugins/dsh-wuyou-agent/api/state'));

    expect(status).toBe(500);
    expect(Object.keys(data).sort()).toEqual(['code', 'message']);
    expect(raw).not.toMatch(/stack|EACCES|at .*\.ts/);
  });

  it('F7: state exposes atomic-write and catalog-source diagnostics', async () => {
    const withSource = createRoutes({
      io: store.io,
      profileDefault: 'standard-acp',
      getCatalog: async (yamlText) => ({ catalog: readCatalog(yamlText), source: 'runtime' as const, errors: ['resolveModelInfo(x, y): boom'] }),
      getAtomicWriteDiagnostics: () => ({ loaded: false, tried: ['file:///a', 'file:///b'] }),
    });
    const { status, data } = await call(withSource, '/state', createMockReq('GET', '/plugins/dsh-wuyou-agent/api/state'));

    expect(status).toBe(200);
    expect(data.diagnostics).toEqual({
      atomicWrite: { loaded: false, tried: ['file:///a', 'file:///b'] },
      catalogSource: 'runtime',
      catalogErrors: ['resolveModelInfo(x, y): boom'],
    });
  });

  it('F7: a plain catalog is reported as source patch; mutation responses carry diagnostics', async () => {
    const { data } = await post('/members', {
      expectedRevision: computeRevision(REAL_FIXTURE),
      profile: 'standard-acp',
      action: 'update',
      name: 'tester',
      patch: { role: '诊断' },
    });

    expect(data.diagnostics).toEqual({
      atomicWrite: { loaded: true, anchor: 'file:///anchor/package.json', resolvedPath: '/resolved/index.js' },
      catalogSource: 'patch',
    });
  });

  it('B02: re-saving tester unchanged through the route is 200 and leaves the file byte-identical', async () => {
    const tester = listMembers(REAL_FIXTURE, 'standard-acp').find((member) => member.name === 'tester')!;
    const { status, data } = await post('/members', {
      expectedRevision: computeRevision(REAL_FIXTURE),
      profile: 'standard-acp',
      action: 'update',
      name: 'tester',
      patch: { ...tester },
    });

    expect(status).toBe(200);
    expect(data.revision).toBe(computeRevision(REAL_FIXTURE));
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  it('B07: a write that succeeds on a patch without agent-teams returns 200 with errors.members', async () => {
    const start = REAL_FIXTURE.indexOf('\n- id: agent-teams\n') + 1;
    const end = REAL_FIXTURE.indexOf('\n- id: ui-theme\n') + 1;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const withoutTeams = `${REAL_FIXTURE.slice(0, start)}${REAL_FIXTURE.slice(end)}`;
    const bare = memoryIO(withoutTeams);
    const bareRoutes = createRoutes({ io: bare.io, profileDefault: 'standard-acp', getCatalog: asyncCatalog() });

    const { status, data } = await call(bareRoutes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', {
      expectedRevision: computeRevision(withoutTeams),
      action: 'create',
      input: { toolName: 'subagent_fork_qa', provider: 'fork' },
    }));

    expect(status).toBe(200);
    expect(bare.text()).not.toBe(withoutTeams);
    expect(listSubagents(bare.text()).map((row) => row.id)).toContain('tool-subagent-fork-qa');
    expect(data.revision).toBe(computeRevision(bare.text()));
    expect(data.members).toEqual([]);
    expect(data.teamProfiles).toEqual([]);
    expect(data.errors.members).toBe('未找到 agent-teams 配置，请确认已安装 @nanmicoder/dsh-agent-teams');
    expect(data.notice).toBe('已保存，新建会话后生效');
  });

  it('POST /subagents takes the response profile from the query string', async () => {
    const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents?profile=no-such-profile', {
      expectedRevision: computeRevision(REAL_FIXTURE),
      action: 'create',
      input: { toolName: 'subagent_query_profile', provider: 'fork' },
    }));

    expect(status).toBe(200);
    expect(data.profile).toBe('no-such-profile');
    expect(data.members).toEqual([]);
    expect(data.errors.members).toBe("未找到团队 profile 'no-such-profile'");
  });
});

// F22-INPUT: malformed write bodies are rejected with 400 before the lock.
describe('write request validation (F22-INPUT)', () => {
  const REV = computeRevision(REAL_FIXTURE);

  /** PatchIO that records any lock/read, to prove validation runs first. */
  function trackedIO() {
    const inner = memoryIO(REAL_FIXTURE);
    const touched = { reads: 0, locks: 0 };
    const io: PatchIO = {
      async readPatch() {
        touched.reads += 1;
        return inner.io.readPatch();
      },
      async writePatchLocked(expected, transform) {
        touched.locks += 1;
        return inner.io.writePatchLocked(expected, transform);
      },
    };
    return { io, touched, text: inner.text };
  }

  const cases: Array<[string, '/subagents' | '/members', Record<string, unknown>, RegExp]> = [
    ['missing expectedRevision', '/subagents', { action: 'remove', id: 'tool-subagent-coder' }, /^字段 expectedRevision /],
    ['malformed expectedRevision', '/subagents', { expectedRevision: 'wrong-revision', action: 'remove', id: 'tool-subagent-coder' }, /^字段 expectedRevision /],
    ['uppercase expectedRevision', '/members', { expectedRevision: REV.toUpperCase(), profile: 'standard-acp', action: 'remove', name: 'claude' }, /^字段 expectedRevision /],
    ['unknown subagents action', '/subagents', { expectedRevision: REV, action: 'add', input: { toolName: 'subagent_x', provider: 'fork' } }, /^字段 action /],
    ['unknown members action', '/members', { expectedRevision: REV, profile: 'standard-acp', action: 'create', member: { name: 'x' } }, /^字段 action /],
    ['subagents patch=[]', '/subagents', { expectedRevision: REV, action: 'update', id: 'tool-subagent-coder', patch: [] }, /^字段 patch /],
    ['subagents patch={}', '/subagents', { expectedRevision: REV, action: 'update', id: 'tool-subagent-coder', patch: {} }, /^字段 patch /],
    ['members patch=[]', '/members', { expectedRevision: REV, profile: 'standard-acp', action: 'update', name: 'tester', patch: [] }, /^字段 patch /],
    ['members patch=null', '/members', { expectedRevision: REV, profile: 'standard-acp', action: 'update', name: 'tester', patch: null }, /^字段 patch /],
    ['create input is a string', '/subagents', { expectedRevision: REV, action: 'create', input: 'subagent_x' }, /^字段 input /],
    ['add member is an array', '/members', { expectedRevision: REV, profile: 'standard-acp', action: 'add', member: [{ name: 'x' }] }, /^字段 member /],
    ['update without id', '/subagents', { expectedRevision: REV, action: 'update', patch: { backgroundMode: 'one-shot' } }, /^字段 id /],
    ['remove with empty id', '/subagents', { expectedRevision: REV, action: 'remove', id: '' }, /^字段 id /],
    ['remove with numeric name', '/members', { expectedRevision: REV, profile: 'standard-acp', action: 'remove', name: 7 }, /^字段 name /],
    ['members without profile', '/members', { expectedRevision: REV, action: 'remove', name: 'claude' }, /^字段 profile /],
    ['members with empty profile', '/members', { expectedRevision: REV, profile: '', action: 'remove', name: 'claude' }, /^字段 profile /],
  ];

  for (const [label, suffix, body, message] of cases) {
    it(`${label} → 400 INVALID before any read or lock`, async () => {
      const tracked = trackedIO();
      const routes = createRoutes({ io: tracked.io, profileDefault: 'standard-acp', getCatalog: asyncCatalog() });
      const { status, data } = await call(routes, suffix, createMockReq('POST', `/plugins/dsh-wuyou-agent/api${suffix}`, body));

      expect(status).toBe(400);
      expect(Object.keys(data).sort()).toEqual(['code', 'message']);
      expect(data.code).toBe('INVALID');
      expect(data.message).toMatch(message);
      expect(tracked.touched).toEqual({ reads: 0, locks: 0 });
      expect(tracked.text()).toBe(REAL_FIXTURE);
    });
  }

  it('a valid unchanged tester re-save still returns 200 and leaves the file byte-identical', async () => {
    const tracked = trackedIO();
    const routes = createRoutes({ io: tracked.io, profileDefault: 'standard-acp', getCatalog: asyncCatalog() });
    const tester = listMembers(REAL_FIXTURE, 'standard-acp').find((member) => member.name === 'tester')!;
    const { status, data } = await call(routes, '/members', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/members', {
      expectedRevision: REV,
      profile: 'standard-acp',
      action: 'update',
      name: 'tester',
      patch: { ...tester },
    }));

    expect(status).toBe(200);
    expect(data.revision).toBe(REV);
    expect(tracked.text()).toBe(REAL_FIXTURE);
  });

  it('M2: null values for clearable fields pass validation and clear the keys', async () => {
    const tracked = trackedIO();
    const routes = createRoutes({ io: tracked.io, profileDefault: 'standard-acp', getCatalog: asyncCatalog() });

    const member = await call(routes, '/members', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/members', {
      expectedRevision: REV,
      profile: 'standard-acp',
      action: 'update',
      name: 'coder',
      patch: { name: 'coder', role: null, provider: null, model: null, reasoning_effort: null },
    }));
    expect(member.status).toBe(200);
    expect(member.data.members.find((entry: any) => entry.name === 'coder')).toEqual({ name: 'coder' });

    const subagent = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', {
      expectedRevision: member.data.revision,
      action: 'update',
      id: 'tool-subagent-coder',
      patch: { agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: null } },
    }));
    expect(subagent.status).toBe(200);
    const coderRow = subagent.data.subagents.find((row: any) => row.id === 'tool-subagent-coder');
    expect(coderRow.config.agentOptions).toEqual({ provider: 'gpt-gateway', model: 'gpt-6-luna' });
    expect(listSubagents(tracked.text()).find((row) => row.id === 'tool-subagent-coder')?.config.agentOptions)
      .toEqual({ provider: 'gpt-gateway', model: 'gpt-6-luna' });
  });

  it('M2: null for a required field is a 400 naming the field, file unchanged', async () => {
    const tracked = trackedIO();
    const routes = createRoutes({ io: tracked.io, profileDefault: 'standard-acp', getCatalog: asyncCatalog() });
    const { status, data } = await call(routes, '/members', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/members', {
      expectedRevision: REV,
      profile: 'standard-acp',
      action: 'update',
      name: 'coder',
      patch: { name: null },
    }));
    expect(status).toBe(400);
    expect(data).toEqual({ code: 'INVALID', message: '字段 name 不能清空' });
    expect(tracked.text()).toBe(REAL_FIXTURE);
  });
});
