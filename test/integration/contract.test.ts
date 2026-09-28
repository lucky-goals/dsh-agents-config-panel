import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createPatchIO } from '../../src/host/patch-file.js';
import { createRoutes, type RouteDescriptor } from '../../src/host/http-routes.js';
import { readCatalog } from '../../src/host/catalog.js';
import { createApiClient } from '../../src/client/shared/api-client';
import { createSubagentStore, type SubagentPanelStore } from '../../src/client/panel-a/subagent-panel-store';
import { createMembersStore, type MembersPanelStore } from '../../src/client/panel-b/members-panel-store';
import type { ModelCatalog } from '../../src/client/shared/api-types';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(THIS_DIR, '../fixtures/real-web-cordis.patch.yml');
const TEAM_PROFILE = 'standard-acp';
const STATE_BASE = '/plugins/dsh-wuyou-agent/api';

interface Harness {
  profileDir: string;
  patchPath: string;
  subagents: SubagentPanelStore;
  members: MembersPanelStore;
  routes: RouteDescriptor[];
}

const profiles: string[] = [];

afterEach(async () => {
  await Promise.all(profiles.splice(0).map((profileDir) => rm(profileDir, { recursive: true, force: true })));
});

function requestHeaders(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const input = init?.headers;
  if (!input) return headers;
  if (input instanceof Headers) {
    input.forEach((value, key) => { headers[key] = value; });
    return headers;
  }
  if (Array.isArray(input)) {
    for (const [key, value] of input) headers[key] = value;
    return headers;
  }
  for (const [key, value] of Object.entries(input)) headers[key] = String(value);
  return headers;
}

/** Adapt the route handlers to fetch without replacing the HTTP API contract. */
function makeFetch(routes: RouteDescriptor[]): typeof fetch {
  return async (input, init) => {
    const requestUrl = new URL(String(input), 'http://contract.test');
    const route = routes.find((candidate) => candidate.path === requestUrl.pathname);
    if (!route) return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'route not found' }), { status: 404 });

    const body = typeof init?.body === 'string' ? init.body : '';
    const request = Object.assign(
      Readable.from(body ? [Buffer.from(body)] : []),
      {
        method: init?.method ?? 'GET',
        url: `${requestUrl.pathname}${requestUrl.search}`,
        headers: requestHeaders(init),
      },
    ) as unknown as IncomingMessage;

    let status = 200;
    const responseHeaders: Record<string, string> = {};
    let responseBody = '';
    const response = {
      writeHead(code: number, headers?: Record<string, string | string[]>) {
        status = code;
        for (const [key, value] of Object.entries(headers ?? {})) {
          responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
        }
      },
      end(value?: string | Buffer) {
        responseBody = value === undefined ? '' : Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      },
    };

    await route.handler(request, response as never);
    return new Response(responseBody, { status, headers: responseHeaders });
  };
}

async function createHarness(): Promise<Harness> {
  const profileDir = await mkdtemp(join('/tmp', 'wuyou-agent-contract-'));
  profiles.push(profileDir);
  const patchPath = join(profileDir, 'cordis.patch.yml');
  await cp(FIXTURE, patchPath);
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'wuyou-agent-contract-profile',
    version: '0.0.0',
    private: true,
  }) + '\n');

  const withFileLock = async <T>(_lockPath: string, operation: () => Promise<T>): Promise<T> => operation();
  const writeFileAtomic = async (path: string, content: string, options: { mode: number }): Promise<void> => {
    await writeFile(path, content, { mode: options.mode });
  };
  const io = createPatchIO(profileDir, withFileLock, writeFileAtomic);
  const routes = createRoutes({
    io,
    profileDefault: TEAM_PROFILE,
    // Keep this asynchronous to exercise the production route ordering around catalog lookup.
    getCatalog: async (yamlText) => {
      await Promise.resolve();
      return {
        catalog: readCatalog(yamlText),
        source: 'patch' as const,
        errors: [],
      };
    },
    getAtomicWriteDiagnostics: () => ({
      loaded: true,
      anchor: 'contract-test',
      resolvedPath: '/tmp/contract-test/@deepseek-ai/dsh-atomic-write/index.js',
    }),
  });
  const api = createApiClient({ fetch: makeFetch(routes), base: STATE_BASE });

  return {
    profileDir,
    patchPath,
    routes,
    subagents: createSubagentStore(api),
    members: createMembersStore(api, TEAM_PROFILE),
  };
}

function firstModel(catalog: ModelCatalog): { provider: string; model: string; reasoningEffort: string } {
  const provider = catalog.providers.find((candidate) => candidate.models.length > 0);
  if (!provider) throw new Error('fixture catalog has no provider/model route');
  const model = provider.models[0];
  return {
    provider: provider.id,
    model: model.id,
    reasoningEffort: model.reasoningEfforts[0] ?? 'off',
  };
}

function setSpawnForm(store: SubagentPanelStore, toolName: string, route: ReturnType<typeof firstModel>): void {
  store.openCreate();
  store.setField('toolName', toolName);
  store.setField('provider', 'spawn');
  store.setField('backgroundMode', 'one-shot');
  store.setField('agentOptions', route);
}

describe('real fixture host/client contract', () => {
  it('loads all real delegation rows and standard-acp members through the API stores', async () => {
    const harness = await createHarness();

    await harness.subagents.load(TEAM_PROFILE);
    await harness.members.load(TEAM_PROFILE);

    const subagentState = harness.subagents.getSnapshot();
    const memberState = harness.members.getSnapshot();
    expect(subagentState.rows).toHaveLength(13);
    expect(subagentState.rows.map((row) => row.id)).toContain('tool-subagent-fork');
    expect(subagentState.rows.map((row) => row.id)).toContain('tool-subagent-acp');
    expect(memberState.members).toHaveLength(5);
    expect(memberState.members.map((member) => member.name)).toEqual(
      expect.arrayContaining(['claude', 'coder', 'tester', 'front-designer', 'generalist']),
    );
    expect(memberState.profile).toBe(TEAM_PROFILE);
    expect(memberState.teamProfiles).toEqual([TEAM_PROFILE]);
    expect(subagentState.diagnostics?.atomicWrite.loaded).toBe(true);
    expect(subagentState.diagnostics?.atomicWrite.anchor).toBe('contract-test');
  });

  it('creates a valid spawn row using a provider, model, and reasoning effort from the catalog', async () => {
    const harness = await createHarness();
    await harness.subagents.load(TEAM_PROFILE);
    const route = firstModel(harness.subagents.getSnapshot().catalog);

    setSpawnForm(harness.subagents, 'subagent_contract_spawn', route);
    await harness.subagents.submit();

    const state = harness.subagents.getSnapshot();
    const created = state.rows.find((row) => row.config.toolName === 'subagent_contract_spawn');
    expect(created).toBeDefined();
    expect(created?.id).toBe('tool-subagent-contract-spawn');
    expect(created?.config).toMatchObject({
      provider: 'spawn',
      toolName: 'subagent_contract_spawn',
      backgroundMode: 'one-shot',
      agentOptions: route,
    });
    expect(state.form.mode).toBeNull();
    expect(state.error).toBeNull();
  });

  it('keeps the real YAML byte-identical when tester is resaved without changes', async () => {
    const harness = await createHarness();
    const before = await readFile(harness.patchPath, 'utf8');

    await harness.members.load(TEAM_PROFILE);
    harness.members.openEdit('tester');
    expect(harness.members.getSnapshot().form.values.role).toContain('tester');
    await harness.members.submit();

    const after = await readFile(harness.patchPath, 'utf8');
    expect(after).toBe(before);
    expect(harness.members.getSnapshot().members.find((member) => member.name === 'tester')).toMatchObject({
      name: 'tester',
      provider: 'gpt-gateway',
      model: 'gpt-6-luna',
      reasoning_effort: 'max',
    });
  });

  it('adds a member without role, then fills the role through the same store', async () => {
    const harness = await createHarness();
    await harness.members.load(TEAM_PROFILE);

    harness.members.openCreate();
    harness.members.setField('name', 'contract-helper');
    await harness.members.submit();
    expect(harness.members.getSnapshot().members.find((member) => member.name === 'contract-helper')).toEqual({
      name: 'contract-helper',
    });

    harness.members.openEdit('contract-helper');
    harness.members.setField('role', 'contract helper');
    await harness.members.submit();
    expect(harness.members.getSnapshot().members.find((member) => member.name === 'contract-helper')).toMatchObject({
      name: 'contract-helper',
      role: 'contract helper',
    });
  });

  it('converts the real fork row into a catalog-backed spawn row', async () => {
    const harness = await createHarness();
    await harness.subagents.load(TEAM_PROFILE);
    const route = firstModel(harness.subagents.getSnapshot().catalog);

    harness.subagents.openEdit('tool-subagent-fork');
    expect(harness.subagents.getSnapshot().form.values.provider).toBe('fork');
    harness.subagents.setField('provider', 'spawn');
    harness.subagents.setField('agentOptions', route);
    await harness.subagents.submit();

    const converted = harness.subagents.getSnapshot().rows.find((row) => row.id === 'tool-subagent-fork');
    expect(converted?.config).toMatchObject({
      provider: 'spawn',
      toolName: 'subagent_fork',
      agentOptions: route,
    });
  });

  it('returns 409 for a stale store and auto-refreshes its rows while keeping conflict text', async () => {
    const harness = await createHarness();
    const external = createSubagentStore(createApiClient({ fetch: makeFetch(harness.routes), base: STATE_BASE }));
    await harness.subagents.load(TEAM_PROFILE);
    await external.load(TEAM_PROFILE);
    const route = firstModel(harness.subagents.getSnapshot().catalog);

    setSpawnForm(external, 'subagent_contract_external', route);
    await external.submit();

    setSpawnForm(harness.subagents, 'subagent_contract_local', route);
    await harness.subagents.submit();

    const refreshed = harness.subagents.getSnapshot();
    expect(refreshed.conflict).toContain('配置已被其他地方修改');
    expect(refreshed.rows.map((row) => row.config.toolName)).toContain('subagent_contract_external');
    expect(refreshed.rows.map((row) => row.config.toolName)).not.toContain('subagent_contract_local');
    expect(refreshed.revision).toBe(external.getSnapshot().revision);
  });

  it('blocks ACP edits in the client before any write is attempted', async () => {
    const harness = await createHarness();
    await harness.subagents.load(TEAM_PROFILE);
    const before = await readFile(harness.patchPath, 'utf8');

    harness.subagents.openEdit('tool-subagent-acp');

    const state = harness.subagents.getSnapshot();
    expect(state.form.mode).toBeNull();
    expect(state.error).toBe('ACP 后端的 subagent 工具为只读');
    expect(await readFile(harness.patchPath, 'utf8')).toBe(before);
  });
});
