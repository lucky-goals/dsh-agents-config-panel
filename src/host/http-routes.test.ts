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
import { listAcps } from './acp-manager.js';
import { ensureStandardAcpPreset, presetInitNotice } from './preset-bootstrap.js';

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
    expect(data.subagentProviders.map((provider: any) => provider.name)).toEqual(['spawn', 'fork']);
    expect(data.diagnostics.hostApi).toBe(2);
    expect(data.diagnostics.subagentProvidersSource).toBe('patch');
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

  it('F0: state exposes the real ACP provider directory and host API version', async () => {
    const { status, data } = await call(routes, '/state', createMockReq('GET', '/plugins/dsh-wuyou-agent/api/state'));

    expect(status).toBe(200);
    expect(data.subagentProviders.map((provider: any) => provider.name)).toEqual([
      'spawn',
      'fork',
      'ccacp',
      'cursoracp',
      'kiroopsuacp',
      'kirogptacp',
    ]);
    expect(data.subagentProviders.slice(2).every((provider: any) => provider.kind === 'acp')).toBe(true);
    expect(data.diagnostics.hostApi).toBe(2);
    expect(data.diagnostics.subagentProvidersSource).toBe('patch');
  });
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
      hostApi: 2,
      atomicWrite: { loaded: false, tried: ['file:///a', 'file:///b'] },
      catalogSource: 'runtime',
      catalogErrors: ['resolveModelInfo(x, y): boom'],
      subagentProvidersSource: 'patch',
      subagentProviderErrors: ['subagents 服务尚未绑定，provider 能力来自配置推断'],
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
      hostApi: 2,
      atomicWrite: { loaded: true, anchor: 'file:///anchor/package.json', resolvedPath: '/resolved/index.js' },
      catalogSource: 'patch',
      subagentProvidersSource: 'patch',
      subagentProviderErrors: ['subagents 服务尚未绑定，provider 能力来自配置推断'],
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

  for (const [field, value] of [
    ['maxDepth', 2],
    ['modelSelectionSettings', true],
    ['persona', 'temporary persona'],
    ['toolFilter', ['subagent']],
  ] as const) {
    it(`rejects immutable subagent field ${field} before reading or locking`, async () => {
      const tracked = trackedIO();
      const routes = createRoutes({ io: tracked.io, profileDefault: 'standard-acp', getCatalog: asyncCatalog() });
      const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', {
        expectedRevision: REV,
        action: 'update',
        id: 'tool-subagent-coder',
        patch: { [field]: value },
      }));

      expect(status).toBe(400);
      expect(data).toEqual({ code: 'INVALID', message: `字段 ${field} 不能通过此接口修改` });
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

describe('v2.3 ACP routes (real fixture)', () => {
  let store: ReturnType<typeof memoryIO>;
  let routes: ReturnType<typeof createRoutes>;

  beforeEach(() => {
    store = memoryIO(REAL_FIXTURE);
    routes = createRoutes({
      io: store.io,
      profileDefault: 'standard-acp',
      getCatalog: asyncCatalog(),
      getAtomicWriteDiagnostics: () => ({ loaded: true }),
      dshProfile: { name: 'desktop', patchPath: '/home/u/.dsh/profiles/desktop/cordis.patch.yml' },
    });
  });

  const post = (suffix: string, body: Record<string, unknown>) =>
    call(routes, suffix, createMockReq('POST', `/plugins/dsh-wuyou-agent/api${suffix}`, body));
  const rev = () => computeRevision(store.text());
  const GEMINI = { providerName: 'geminiacp', command: '/opt/example/bin/gemini', args: ['--experimental-acp'], permission: 'reject' };

  it('GET state carries the ACP rows and the bound DSH profile', async () => {
    const { status, data } = await call(routes, '/state', createMockReq('GET', '/plugins/dsh-wuyou-agent/api/state'));
    expect(status).toBe(200);
    expect(data.dshProfile).toEqual({ name: 'desktop', patchPath: '/home/u/.dsh/profiles/desktop/cordis.patch.yml' });
    expect(data.acps.map((a: any) => a.id)).toEqual(['subagent-acp', 'subagent-acp-cursor', 'subagent-acp-kiro', 'subagent-acp-kiro-gpt']);
    expect(data.errors.acps).toBeUndefined();
  });

  it('create → update → remove through POST /acps, each with the restart notice', async () => {
    const created = await post('/acps', { expectedRevision: rev(), action: 'create', input: GEMINI });
    expect(created.status).toBe(200);
    expect(created.data.notice).toBe('已保存。ACP 变更需重启 DSH 后生效');
    expect(created.data.acps.at(-1).config.providerName).toBe('geminiacp');

    const updated = await post('/acps', { expectedRevision: rev(), action: 'update', id: 'subagent-acp-geminiacp', patch: { permission: 'allow' } });
    expect(updated.status).toBe(200);
    expect(updated.data.acps.at(-1).config.permission).toBe('allow');

    const removed = await post('/acps', { expectedRevision: rev(), action: 'remove', id: 'subagent-acp-geminiacp' });
    expect(removed.status).toBe(200);
    expect(listAcpsNames(store.text())).toEqual(['ccacp', 'cursoracp', 'kiroopsuacp', 'kirogptacp']);
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  it('removing an ACP still used by a subagent is 409 IN_USE and writes nothing', async () => {
    const { status, data } = await post('/acps', { expectedRevision: rev(), action: 'remove', id: 'subagent-acp' });
    expect(status).toBe(409);
    expect(data.code).toBe('IN_USE');
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  it.each([
    [{ action: 'create', input: { ...GEMINI, extra: 1 } }, 'input.extra'],
    [{ action: 'create', input: { ...GEMINI, args: 'acp' } }, 'input.args'],
    [{ action: 'create', input: { ...GEMINI, env: { A: 1 } } }, 'input.env'],
    [{ action: 'update', id: 'subagent-acp', patch: { providerName: 'x' } }, 'patch.providerName'],
    [{ action: 'update', patch: { command: '/x' } }, 'id'],
  ])('rejects malformed body %j naming %s', async (body, field) => {
    const { status, data } = await post('/acps', { expectedRevision: rev(), ...body });
    expect(status).toBe(400);
    expect(data.message).toContain(field);
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  it('POST /subagents/import writes ACPs and subagents in one revision and reports skips', async () => {
    const { status, data } = await post('/subagents/import', {
      expectedRevision: rev(),
      bundle: {
        acps: [GEMINI],
        subagents: [
          { toolName: 'subagent_gemini', provider: 'geminiacp', backgroundMode: 'one-shot' },
          { toolName: 'subagent_coder', provider: 'spawn', backgroundMode: 'continuable', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
        ],
      },
    });
    expect(status).toBe(200);
    expect(data.revision).toBe(rev());
    expect(data.notice).toBe('已保存。ACP 变更需重启 DSH 后生效');
    expect(data.importReport.created).toEqual({ acps: ['geminiacp'], subagents: ['subagent_gemini'] });
    expect(data.importReport.skipped).toEqual([expect.objectContaining({ kind: 'subagent', name: 'subagent_coder' })]);
    expect(listSubagents(store.text()).some((r) => r.config.toolName === 'subagent_gemini')).toBe(true);
  });

  it('POST /subagents/import rejects a stale revision and a non-array list', async () => {
    const stale = await post('/subagents/import', { expectedRevision: '0'.repeat(64), bundle: { acps: [GEMINI] } });
    expect(stale.status).toBe(409);
    const bad = await post('/subagents/import', { expectedRevision: rev(), bundle: { acps: {} } });
    expect(bad.status).toBe(400);
    expect(bad.data.message).toContain('bundle.acps');
    expect(store.text()).toBe(REAL_FIXTURE);
  });
});

function listAcpsNames(text: string): string[] {
  return listAcps(text).map((a) => a.config.providerName);
}

describe('v2.4 POST /acps/test (real fixture)', () => {
  function routesWith(probe: RouteContext['probeAcp']) {
    const store = memoryIO(REAL_FIXTURE);
    return createRoutes({ io: store.io, profileDefault: 'standard-acp', getCatalog: asyncCatalog(), probeAcp: probe });
  }
  const post = (routes: ReturnType<typeof createRoutes>, body: Record<string, unknown>) =>
    call(routes, '/acps/test', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/acps/test', body));

  it('tests the saved config of the named row; handshake only when asked', async () => {
    const calls: Array<[unknown, unknown]> = [];
    const routes = routesWith(async (config, options) => {
      calls.push([config, options]);
      return { ok: true, handshake: !!options?.handshake, checks: [], durationMs: 1 };
    });
    const { status, data } = await post(routes, { id: 'subagent-acp-kiro' });
    expect(status).toBe(200);
    expect(data).toMatchObject({ id: 'subagent-acp-kiro', providerName: 'kiroopsuacp', ok: true, handshake: false });
    expect(calls[0][0]).toEqual(listAcps(REAL_FIXTURE)[2].config);
    expect(calls[0][1]).toEqual({ handshake: false });
    await post(routes, { id: 'subagent-acp-kiro', handshake: true });
    expect(calls[1][1]).toEqual({ handshake: true });
  });

  it('rejects an unknown id, a missing id or a bad flag, ignores a command in the body, and refuses a concurrent test', async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const running = new Promise<void>((r) => { started = r; });
    const seen: unknown[] = [];
    const routes = routesWith((config) => {
      seen.push(config);
      started();
      return new Promise((done) => { release = () => done({ ok: true, handshake: true, checks: [], durationMs: 1 }); });
    });
    expect((await post(routes, { id: 'nope' })).status).toBe(404);
    expect((await post(routes, {})).status).toBe(400);
    expect((await post(routes, { id: 'subagent-acp', handshake: 'yes' })).status).toBe(400);

    // The body cannot choose what runs: an injected command is ignored.
    const first = post(routes, { id: 'subagent-acp', handshake: true, command: '/bin/rm', args: ['-rf', '/'] });
    await running;
    expect(seen[0]).toEqual(listAcps(REAL_FIXTURE)[0].config);
    const second = await post(routes, { id: 'subagent-acp', handshake: true });
    expect(second.status).toBe(409);
    expect(second.data.code).toBe('BUSY');
    release();
    expect((await first).status).toBe(200);
  });

  it('with the real probe, the fixture command paths (/opt/example/...) fail the executable check', async () => {
    const routes = createRoutes({ io: memoryIO(REAL_FIXTURE).io, profileDefault: 'standard-acp', getCatalog: asyncCatalog() });
    const { status, data } = await post(routes, { id: 'subagent-acp', handshake: true });
    expect(status).toBe(200);
    expect(data.ok).toBe(false);
    expect(data.checks.map((c: any) => [c.key, c.status])).toEqual([
      ['command', 'fail'], ['interpreter', 'skip'], ['cwd', 'skip'], ['handshake', 'skip'],
    ]);
    expect(data.checks[0].detail).toBe('/opt/example/bin/claude-agent-acp 不存在');
  });
});

describe('v2.6 team routes (real fixture)', () => {
  let store: ReturnType<typeof memoryIO>;
  let routes: ReturnType<typeof createRoutes>;
  beforeEach(() => {
    store = memoryIO(REAL_FIXTURE);
    routes = createRoutes({ io: store.io, profileDefault: 'standard-acp', getCatalog: asyncCatalog(), dshProfile: { name: 'web', patchPath: '/p/web/cordis.patch.yml' } });
  });
  const post = (suffix: string, body: Record<string, unknown>) =>
    call(routes, suffix, createMockReq('POST', `/plugins/dsh-wuyou-agent/api${suffix}`, body));
  const rev = () => computeRevision(store.text());

  it('GET /teams returns every team profile with its full config and the revision', async () => {
    const { status, data } = await call(routes, '/teams', createMockReq('GET', '/plugins/dsh-wuyou-agent/api/teams'));
    expect(status).toBe(200);
    expect(data.revision).toBe(rev());
    expect(Object.keys(data.profiles)).toEqual(['standard-acp']);
    expect(data.profiles['standard-acp'].members).toHaveLength(5);
    expect(data.dshProfile.name).toBe('web');
  });

  it('POST /teams clones a team; the response state is the new team, selectable at once', async () => {
    const { status, data } = await post('/teams', { expectedRevision: rev(), action: 'create', name: 'copy', from: 'standard-acp' });
    expect(status).toBe(200);
    expect(data.teamProfiles).toEqual(['standard-acp', 'copy']);
    expect(data.profile).toBe('copy');
    expect(data.members.map((m: any) => m.name)).toEqual(['claude', 'coder', 'tester', 'front-designer', 'generalist']);
  });

  it('POST /teams creates a blank team; rejects duplicates, bad bodies and stale revisions', async () => {
    const created = await post('/teams', { expectedRevision: rev(), action: 'create', name: 'solo', firstMember: 'worker', description: '单人' });
    expect(created.status).toBe(200);
    expect(created.data.members).toEqual([{ name: 'worker' }]);
    expect((await post('/teams', { expectedRevision: rev(), action: 'create', name: 'solo', firstMember: 'w' })).data.code).toBe('DUPLICATE');
    expect((await post('/teams', { expectedRevision: rev(), action: 'create', name: 'x', from: 'solo', firstMember: 'w' })).status).toBe(400);
    expect((await post('/teams', { expectedRevision: rev(), action: 'delete', name: 'x' })).status).toBe(400);
    expect((await post('/teams', { expectedRevision: '0'.repeat(64), action: 'create', name: 'y', firstMember: 'w' })).status).toBe(409);
  });

  it('POST /teams/import applies creates and chosen overwrites in one revision and reports skips', async () => {
    await post('/teams', { expectedRevision: rev(), action: 'create', name: 'solo', firstMember: 'worker' });
    const { status, data } = await post('/teams/import', {
      expectedRevision: rev(),
      teams: [
        { name: 'standard-acp', profile: { members: [{ name: 'only' }] } },
        { name: 'solo', profile: { description: '覆盖后', members: [{ name: 'a' }, { name: 'b' }] } },
        { name: 'review', profile: { members: [{ name: 'reviewer' }] } },
      ],
      overwrite: ['solo'],
    });
    expect(status).toBe(200);
    expect(data.importReport).toEqual({
      created: ['review'],
      overwritten: ['solo'],
      skipped: [{ name: 'standard-acp', reason: "团队 'standard-acp' 已存在，未选择覆盖" }],
    });
    expect(data.teamProfiles).toEqual(['standard-acp', 'solo', 'review']);
    expect(data.revision).toBe(rev());
  });

  it('POST /teams/import validates the body shape', async () => {
    for (const body of [{ teams: {} }, { teams: [{ name: 1, profile: {} }] }, { teams: [{ name: 'a', profile: {}, scope: 'x' }] }, { teams: [], overwrite: 'a' }]) {
      const { status } = await post('/teams/import', { expectedRevision: rev(), ...body });
      expect(status, JSON.stringify(body)).toBe(400);
    }
    expect(store.text()).toBe(REAL_FIXTURE);
  });
});

describe('v2.7 POST /teams remove (real fixture)', () => {
  let store: ReturnType<typeof memoryIO>;
  let routes: ReturnType<typeof createRoutes>;
  beforeEach(() => {
    store = memoryIO(REAL_FIXTURE);
    routes = createRoutes({ io: store.io, profileDefault: 'standard-acp', getCatalog: asyncCatalog() });
  });
  const post = (body: Record<string, unknown>, query = '') =>
    call(routes, '/teams', createMockReq('POST', `/plugins/dsh-wuyou-agent/api/teams${query}`, body));
  const rev = () => computeRevision(store.text());

  it('removes a team only with confirm "thinktwice"; the response switches away from the removed team', async () => {
    await post({ expectedRevision: rev(), action: 'create', name: 'copy', from: 'standard-acp' });
    const withClone = store.text();

    for (const confirm of [undefined, '', 'ThinkTwice', 'think twice']) {
      const { status, data } = await post({ expectedRevision: rev(), action: 'remove', name: 'copy', ...(confirm === undefined ? {} : { confirm }) });
      expect(status, String(confirm)).toBe(400);
      expect(data.message).toContain('thinktwice');
    }
    expect(store.text()).toBe(withClone);

    const { status, data } = await post({ expectedRevision: rev(), action: 'remove', name: 'copy', confirm: 'thinktwice' }, '?profile=copy');
    expect(status).toBe(200);
    expect(data.teamProfiles).toEqual(['standard-acp']);
    expect(data.profile).toBe('standard-acp');
    expect(data.members).toHaveLength(5);
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  it('keeps the viewed team when another one is removed', async () => {
    await post({ expectedRevision: rev(), action: 'create', name: 'copy', from: 'standard-acp' });
    const { data } = await post({ expectedRevision: rev(), action: 'remove', name: 'standard-acp', confirm: 'thinktwice' }, '?profile=copy');
    expect(data.profile).toBe('copy');
    expect(data.teamProfiles).toEqual(['copy']);
  });

  it('the last team is 422 LAST_TEAM, an unknown team 404, a stale revision 409; nothing is written', async () => {
    expect(await post({ expectedRevision: rev(), action: 'remove', name: 'standard-acp', confirm: 'thinktwice' })).toMatchObject({ status: 422, data: { code: 'LAST_TEAM' } });
    expect((await post({ expectedRevision: rev(), action: 'remove', name: 'nope', confirm: 'thinktwice' })).status).toBe(404);
    expect((await post({ expectedRevision: '0'.repeat(64), action: 'remove', name: 'standard-acp', confirm: 'thinktwice' })).status).toBe(409);
    expect(store.text()).toBe(REAL_FIXTURE);
  });
});

describe('agent-teams bootstrap', () => {
  const userPatch = `# user layer
- id: locale
  config:
    preference: zh
- id: wuyou-agent
  disabled: false
`;
  const bundleConfig = { stateDir: '.agent-teams', memberProvider: 'spawn' };

  it('reports an installed package and writes the basic profile once', async () => {
    const store = memoryIO(userPatch);
    const routes = createRoutes({
      io: store.io,
      profileDefault: 'standard-acp',
      getCatalog: asyncCatalog(),
      getAtomicWriteDiagnostics: () => ({ loaded: true }),
      readInstalledAgentTeams: () => ({ version: '0.1.22-rc.1', config: bundleConfig }),
    });
    const before = await call(routes, '/state', createMockReq('GET', '/plugins/dsh-wuyou-agent/api/state?profile=standard-acp'));
    expect(before.status).toBe(200);
    expect(before.data.agentTeams).toEqual({ installed: true, seedable: true, version: '0.1.22-rc.1' });
    expect(before.data.errors.members).toContain('已安装 @nanmicoder/dsh-agent-teams@0.1.22-rc.1');
    expect(before.data.teamProfiles).toEqual([]);

    const seeded = await call(routes, '/teams/bootstrap', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/teams/bootstrap?profile=standard-acp', {
      expectedRevision: before.data.revision,
    }));
    expect(seeded.status).toBe(200);
    expect(seeded.data.notice).toContain('generalist');
    expect(seeded.data.teamProfiles).toEqual(['standard-acp']);
    expect(seeded.data.members.map((member: { name: string }) => member.name)).toEqual(['generalist']);
    expect(seeded.data.errors.members).toBeUndefined();
    expect(store.text()).toContain('stateDir: .agent-teams');
    expect(store.text()).toContain('memberProvider: spawn');
    expect(store.text().startsWith(userPatch.trimEnd())).toBe(true);

    const again = await call(routes, '/teams/bootstrap', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/teams/bootstrap?profile=standard-acp', {
      expectedRevision: seeded.data.revision,
    }));
    expect(again.status).toBe(200);
    expect(again.data.notice).toContain('无需初始化');
    expect(again.data.revision).toBe(seeded.data.revision);
  });

  it('keeps the original missing-plugin message when the package is not installed', async () => {
    const store = memoryIO(userPatch);
    const routes = createRoutes({
      io: store.io,
      profileDefault: 'standard-acp',
      getCatalog: asyncCatalog(),
      readInstalledAgentTeams: () => undefined,
    });
    const { data } = await call(routes, '/state', createMockReq('GET', '/plugins/dsh-wuyou-agent/api/state'));
    expect(data.agentTeams).toBeUndefined();
    expect(data.errors.members).toBe('未找到 agent-teams 配置，请确认已安装 @nanmicoder/dsh-agent-teams');
    const denied = await call(routes, '/teams/bootstrap', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/teams/bootstrap', {
      expectedRevision: data.revision,
    }));
    expect(denied.status).toBe(500);
    expect(denied.data.code).toBe('STRUCTURE');
    expect(store.text()).toBe(userPatch);
  });
});

describe('preset bootstrap on state', () => {
  it('GET /state seeds a missing preset-standard-acp before listing subagents', async () => {
    const bare = '- id: locale\n  name: locale\n';
    const store = memoryIO(bare);
    let notice: string | null = null;
    const routes = createRoutes({
      io: store.io,
      profileDefault: 'standard-acp',
      getCatalog: asyncCatalog(),
      ensurePreset: async () => {
        const result = await ensureStandardAcpPreset(store.io, undefined, { info() {}, warn() {}, error() {} });
        if (result.notice) notice = result.notice;
        return { yamlText: result.yamlText, notice };
      },
    });
    const { status, data } = await call(routes, '/state', createMockReq('GET', '/plugins/dsh-wuyou-agent/api/state'));
    expect(status).toBe(200);
    expect(data.errors.subagents).toBeUndefined();
    expect(data.subagents.map((row: { id: string }) => row.id)).toContain('tool-subagent');
    expect(data.notice).toBe(presetInitNotice('minimal', false));
    expect(store.text().startsWith(bare)).toBe(true);

    const again = await call(routes, '/state', createMockReq('GET', '/plugins/dsh-wuyou-agent/api/state'));
    expect(again.status).toBe(200);
    expect(again.data.notice).toBe(data.notice);
    expect(again.data.revision).toBe(data.revision);
    expect(store.text().match(/id: preset-standard-acp/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// K16 (v2.12): POST /subagents with action 'move'.
// ---------------------------------------------------------------------------
describe('v2.12 POST /subagents move (K16, real fixture)', () => {
  const REV = computeRevision(REAL_FIXTURE);
  const UP_NOTICE = '已上移。只改变列表顺序，不影响模型看到的工具顺序';
  const DOWN_NOTICE = '已下移。只改变列表顺序，不影响模型看到的工具顺序';

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

  function routesFor(io: PatchIO) {
    return createRoutes({ io, profileDefault: 'standard-acp', getCatalog: asyncCatalog() });
  }

  function moveBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { expectedRevision: REV, action: 'move', id: 'tool-subagent-fork', direction: 'down', ...overrides };
  }

  it('moves the coder row up: 200, the up notice, the pair swapped, revision is the new sha256', async () => {
    const store = memoryIO(REAL_FIXTURE);
    const routes = routesFor(store.io);
    const before = listSubagents(REAL_FIXTURE).map((row) => row.id);

    const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', {
      expectedRevision: REV,
      action: 'move',
      id: 'tool-subagent-coder',
      direction: 'up',
    }));

    expect(status).toBe(200);
    expect(data.notice).toBe(UP_NOTICE);
    expect(store.text()).not.toBe(REAL_FIXTURE);
    expect(data.revision).toBe(computeRevision(store.text()));

    const expected = [...before];
    const index = before.indexOf('tool-subagent-coder');
    expected[index - 1] = 'tool-subagent-coder';
    expected[index] = 'tool-subagent-reviewer';
    expect(listSubagents(store.text()).map((row) => row.id)).toEqual(expected);
    expect(data.subagents.map((row: { id: string }) => row.id)).toEqual(expected);
  });

  it('moves the fork row down: 200 and the down notice, with the file really written', async () => {
    const store = memoryIO(REAL_FIXTURE);
    const routes = routesFor(store.io);

    const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', moveBody()));

    expect(status).toBe(200);
    expect(data.notice).toBe(DOWN_NOTICE);
    const ids = listSubagents(store.text()).map((row) => row.id);
    expect(ids.indexOf('tool-subagent-acp')).toBeLessThan(ids.indexOf('tool-subagent-fork'));
    expect(data.revision).toBe(computeRevision(store.text()));
  });

  it('the first row cannot move up: 400 INVALID and the file stays byte-identical', async () => {
    const store = memoryIO(REAL_FIXTURE);
    const routes = routesFor(store.io);

    const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', moveBody({
      id: 'tool-subagent',
      direction: 'up',
    })));

    expect(status).toBe(400);
    expect(data).toEqual({ code: 'INVALID', message: '已经是第一个 subagent，不能上移' });
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  it('the last row cannot move down: 400 INVALID and the file stays byte-identical', async () => {
    const store = memoryIO(REAL_FIXTURE);
    const routes = routesFor(store.io);

    const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', moveBody({
      id: 'tool-subagent-claude-code',
      direction: 'down',
    })));

    expect(status).toBe(400);
    expect(data).toEqual({ code: 'INVALID', message: '已经是最后一个 subagent，不能下移' });
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  const invalidBodies: Array<[string, Record<string, unknown>, string]> = [
    ['direction left', moveBody({ direction: 'left' }), '字段 direction 必须是 up、down 之一'],
    ['direction up-ish', moveBody({ direction: 'UP' }), '字段 direction 必须是 up、down 之一'],
    ['direction missing', { expectedRevision: REV, action: 'move', id: 'tool-subagent-fork' }, '字段 direction 必须是 up、down 之一'],
    ['direction null', moveBody({ direction: null }), '字段 direction 必须是 up、down 之一'],
    ['id missing', { expectedRevision: REV, action: 'move', direction: 'down' }, '字段 id 必须是非空字符串'],
    ['id empty', moveBody({ id: '' }), '字段 id 必须是非空字符串'],
    ['input carried', moveBody({ input: { toolName: 'subagent_x', provider: 'fork' } }), '字段 input 不支持'],
    ['patch carried', moveBody({ patch: { backgroundMode: 'one-shot' } }), '字段 patch 不支持'],
  ];

  for (const [label, body, message] of invalidBodies) {
    it(`rejects ${label} with 400 before any read or lock, file unchanged`, async () => {
      const tracked = trackedIO();
      const routes = routesFor(tracked.io);

      const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', body));

      expect(status).toBe(400);
      expect(data).toEqual({ code: 'INVALID', message });
      expect(tracked.touched).toEqual({ reads: 0, locks: 0 });
      expect(tracked.text()).toBe(REAL_FIXTURE);
    });
  }

  it('the unknown-action message now names move', async () => {
    const tracked = trackedIO();
    const routes = routesFor(tracked.io);

    const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', {
      expectedRevision: REV,
      action: 'add',
      input: { toolName: 'subagent_x', provider: 'fork' },
    }));

    expect(status).toBe(400);
    expect(data).toEqual({ code: 'INVALID', message: '字段 action 必须是 create、update、remove、move 之一' });
    expect(tracked.touched).toEqual({ reads: 0, locks: 0 });
    expect(tracked.text()).toBe(REAL_FIXTURE);
  });

  it('a stale revision is 409 STALE_REVISION and writes nothing', async () => {
    const store = memoryIO(REAL_FIXTURE);
    const routes = routesFor(store.io);

    const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', moveBody({
      expectedRevision: '0'.repeat(64),
    })));

    expect(status).toBe(409);
    expect(data.code).toBe('STALE_REVISION');
    expect(data.message).toBe('配置已被其他地方修改，请刷新后重试');
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  it.each(['workflow-ptc', 'missing'])('an id outside the subagent rows (%s) is 404 NOT_FOUND and writes nothing', async (id) => {
    const store = memoryIO(REAL_FIXTURE);
    const routes = routesFor(store.io);

    const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', moveBody({ id })));

    expect(status).toBe(404);
    expect(data).toEqual({ code: 'NOT_FOUND', message: `未找到 subagent '${id}'` });
    expect(store.text()).toBe(REAL_FIXTURE);
  });

  it('moves an unregistered read-only row (codex) down with 200, not 422', async () => {
    const store = memoryIO(REAL_FIXTURE);
    const routes = routesFor(store.io);

    const { status, data } = await call(routes, '/subagents', createMockReq('POST', '/plugins/dsh-wuyou-agent/api/subagents', moveBody({
      id: 'tool-subagent-codex',
      direction: 'down',
    })));

    expect(status).toBe(200);
    expect(data.notice).toBe(DOWN_NOTICE);
    const ids = listSubagents(store.text()).map((row) => row.id);
    expect(ids.indexOf('tool-subagent-claude-code')).toBeLessThan(ids.indexOf('tool-subagent-codex'));
    const codexRow = (data.subagents as Array<{ id: string; editable: boolean; disabled: boolean; config: Record<string, unknown> }>)
      .find((row) => row.id === 'tool-subagent-codex');
    expect(codexRow).toMatchObject({ editable: false, disabled: true, config: { provider: 'codex' } });
    expect(listSubagents(store.text()).find((row) => row.id === 'tool-subagent-claude-code'))
      .toMatchObject({ editable: false, disabled: true, config: { provider: 'claude-code' } });
  });
});
