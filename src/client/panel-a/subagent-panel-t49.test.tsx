/**
 * t49: red-first tests for the t45 findings on Panel A v2.1 (F1–F6).
 * Store tests drive the real store through a fake ApiClient; component tests
 * render SubagentPanel with react-dom/server.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createSubagentStore, diffSubagentPatch, suppressAgentOptions, supportsContinuable, capsOf } from './subagent-panel-store';
import { SubagentPanel } from './SubagentPanel';
import type { ApiClient } from '../shared/api-client';
import type { MutationSuccessResponse, StateResponse, SubagentProviderInfo, SubagentRow } from '../shared/api-types';

const ALL = { agentOptions: true, depthLimit: true, continuable: true, persona: true, toolFilter: true };
const NONE = { agentOptions: false, depthLimit: false, continuable: false, persona: false, toolFilter: false };
const p = (name: string, capabilities: SubagentProviderInfo['capabilities'], kind: SubagentProviderInfo['kind']): SubagentProviderInfo =>
  ({ name, kind, capabilities, source: 'runtime' });

const SPAWN = p('spawn', ALL, 'in-process');
const FORK = p('fork', ALL, 'in-process');
const CCACP = p('ccacp', NONE, 'acp');
/** Contract §1 `unknown` kind: not spawn, but takes agentOptions and is continuable. */
const CUSTOM = p('custom', { ...ALL, persona: false }, 'unknown');

const CATALOG = { providers: [{ id: 'gpt-gateway', models: [{ id: 'gpt-6-luna', reasoningEfforts: ['high', 'max'] }] }] };

const ROWS: SubagentRow[] = [
  { id: 'tool-subagent-coder', disabled: false, editable: true, config: { provider: 'spawn', toolName: 'subagent_coder', backgroundMode: 'continuable', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' } } },
  { id: 'tool-subagent-fork', disabled: false, editable: true, config: { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable' } },
  { id: 'tool-subagent-acp', disabled: false, editable: true, config: { provider: 'ccacp', toolName: 'subagent_acp', backgroundMode: 'one-shot', maxDepth: 'provider-managed' } },
  { id: 'tool-subagent-custom', disabled: false, editable: true, config: { provider: 'custom', toolName: 'subagent_custom', backgroundMode: 'continuable', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' } } },
];

function state(extra: Partial<StateResponse> = {}): StateResponse {
  return {
    revision: 'rev1',
    catalog: CATALOG,
    subagents: ROWS,
    subagentProviders: [SPAWN, FORK, CCACP, CUSTOM],
    teamProfiles: ['standard-acp'],
    profile: 'standard-acp',
    members: [],
    errors: {},
    diagnostics: { atomicWrite: { loaded: true }, catalogSource: 'runtime', hostApi: 2, subagentProvidersSource: 'runtime' },
    ...extra,
  };
}

function api(s: StateResponse = state()): ApiClient {
  return {
    getState: vi.fn(async () => s),
    mutateSubagents: vi.fn(async () => ({ ...s, notice: '已保存，新建会话后生效' }) as MutationSuccessResponse),
    mutateMembers: vi.fn(),
  };
}

async function loaded(s?: StateResponse) {
  const client = api(s);
  const store = createSubagentStore(client);
  await store.load();
  return { client, store };
}

const lastRequest = (client: ApiClient) => vi.mocked(client.mutateSubagents).mock.calls.at(-1)?.[0];

// ---------------------------------------------------------------------------
// F1 (high): diff decides agentOptions by capability, not by the name 'spawn'
// ---------------------------------------------------------------------------
describe('F1 diffSubagentPatch follows capabilities', () => {
  it('editing reasoningEffort on a non-spawn provider with agentOptions sends that patch', async () => {
    const { client, store } = await loaded();
    store.openEdit('tool-subagent-custom');
    store.setField('agentOptions', { ...store.getSnapshot().form.values.agentOptions, reasoningEffort: 'high' });
    await store.submit();
    expect(store.getSnapshot().notice).not.toBe('没有改动');
    expect(lastRequest(client)).toMatchObject({ action: 'update', id: 'tool-subagent-custom', patch: { agentOptions: { reasoningEffort: 'high' } } });
  });

  it('ACP → custom sends provider plus the complete agentOptions block', () => {
    const providers = [SPAWN, FORK, CCACP, CUSTOM];
    const original = { toolName: 'subagent_acp', provider: 'ccacp', backgroundMode: 'one-shot' as const, agentOptions: { provider: '', model: '', reasoningEffort: '' } };
    const values = { ...original, provider: 'custom', backgroundMode: 'continuable' as const, agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' } };
    expect(diffSubagentPatch(original, values, providers)).toEqual({
      provider: 'custom',
      backgroundMode: 'continuable',
      agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' },
    });
  });

  it('custom → spawn (both take agentOptions) diffs only the changed keys', () => {
    const providers = [SPAWN, FORK, CCACP, CUSTOM];
    const base = { toolName: 'subagent_custom', provider: 'custom', backgroundMode: 'continuable' as const, agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' } };
    expect(diffSubagentPatch(base, { ...base, provider: 'spawn' }, providers)).toEqual({ provider: 'spawn' });
  });

  it('the fork exception lives in suppressAgentOptions only', () => {
    expect(suppressAgentOptions('fork', ALL)).toBe(true);
    expect(suppressAgentOptions('spawn', ALL)).toBe(false);
    expect(suppressAgentOptions('custom', CUSTOM.capabilities)).toBe(false);
    expect(suppressAgentOptions('ccacp', NONE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F2: switching provider adjusts backgroundMode by continuable capability (§3/§4/§8)
// ---------------------------------------------------------------------------
describe('F2 backgroundMode follows continuable on provider switch', () => {
  it('ACP → spawn: Background Mode becomes continuable and is sent', async () => {
    const { client, store } = await loaded();
    store.openEdit('tool-subagent-acp');
    store.setField('provider', 'spawn');
    expect(store.getSnapshot().form.values.backgroundMode).toBe('continuable');
    store.setField('agentOptions', { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: '' });
    await store.submit();
    expect(lastRequest(client)?.patch).toEqual({ provider: 'spawn', backgroundMode: 'continuable', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } });
  });

  it('ACP → fork: form defaults to continuable and sends it (§4 table)', async () => {
    const { client, store } = await loaded();
    store.openEdit('tool-subagent-acp');
    store.setField('provider', 'fork');
    expect(store.getSnapshot().form.values.backgroundMode).toBe('continuable');
    await store.submit();
    expect(lastRequest(client)?.patch).toEqual({ provider: 'fork', backgroundMode: 'continuable' });
  });

  it('spawn → ACP: Background Mode becomes one-shot', async () => {
    const { store } = await loaded();
    store.openEdit('tool-subagent-coder');
    store.setField('provider', 'ccacp');
    expect(store.getSnapshot().form.values.backgroundMode).toBe('one-shot');
  });

  it('continuable → continuable keeps the user choice (spawn one-shot → fork stays one-shot)', async () => {
    const { store } = await loaded();
    store.openEdit('tool-subagent-coder');
    store.setField('backgroundMode', 'one-shot');
    store.setField('provider', 'fork');
    expect(store.getSnapshot().form.values.backgroundMode).toBe('one-shot');
  });

  it('create: switching the default provider to ACP forces one-shot, back to spawn restores continuable', async () => {
    const { store } = await loaded();
    store.openCreate();
    store.setField('provider', 'ccacp');
    expect(store.getSnapshot().form.values.backgroundMode).toBe('one-shot');
    store.setField('provider', 'spawn');
    expect(store.getSnapshot().form.values.backgroundMode).toBe('continuable');
  });

  it('opening an ACP row without backgroundMode and saving unchanged sends nothing', async () => {
    const rows = [{ ...ROWS[2], config: { provider: 'ccacp', toolName: 'subagent_acp', maxDepth: 'provider-managed' } }];
    const { client, store } = await loaded(state({ subagents: rows }));
    store.openEdit('tool-subagent-acp');
    expect(store.getSnapshot().form.values.backgroundMode).toBe('one-shot');
    await store.submit();
    expect(client.mutateSubagents).not.toHaveBeenCalled();
    expect(store.getSnapshot().notice).toBe('没有改动');
  });
});

// ---------------------------------------------------------------------------
// F3: provider must be in the list; create default is subagentProviders[0]
// ---------------------------------------------------------------------------
describe('F3 provider list validation and create default', () => {
  it('runtime list with only ccacp: create defaults to ccacp, not spawn', async () => {
    const { store } = await loaded(state({ subagentProviders: [CCACP] }));
    store.openCreate();
    expect(store.getSnapshot().form.values.provider).toBe('ccacp');
    expect(store.getSnapshot().form.values.backgroundMode).toBe('one-shot');
  });

  it('a provider missing from subagentProviders is rejected client-side', async () => {
    const { client, store } = await loaded(state({ subagentProviders: [CCACP] }));
    store.openCreate();
    store.setField('toolName', 'subagent_x');
    store.setField('provider', 'spawn');
    await store.submit();
    expect(store.getSnapshot().form.errors.provider).toBe("provider 'spawn' 未注册");
    expect(client.mutateSubagents).not.toHaveBeenCalled();
  });

  it('empty runtime list: create has no default provider and cannot submit', async () => {
    const { client, store } = await loaded(state({ subagentProviders: [] }));
    store.openCreate();
    expect(store.getSnapshot().form.values.provider).toBe('');
    store.setField('toolName', 'subagent_x');
    await store.submit();
    expect(store.getSnapshot().form.errors.provider).toBe("provider '' 未注册");
    expect(client.mutateSubagents).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F6: one continuable predicate for rendering and submit
// ---------------------------------------------------------------------------
describe('F6 continuable predicate', () => {
  it('supportsContinuable is caps?.continuable === true; unknown providers are not continuable', () => {
    expect(supportsContinuable(capsOf([SPAWN, FORK], 'fork'))).toBe(true);
    expect(supportsContinuable(capsOf([SPAWN, FORK], 'nope'))).toBe(false);
    expect(supportsContinuable(capsOf([CCACP], 'ccacp'))).toBe(false);
  });

  it('the panel renders read-only one-shot exactly when submit would force one-shot', async () => {
    const { store } = await loaded(state({ subagentProviders: [SPAWN, CCACP] }));
    store.openEdit('tool-subagent-fork'); // fork row, but fork is not registered in this runtime list
    // Row is editable per Host flag; the provider is unknown to this list → not continuable.
    const html = renderToString(<SubagentPanel store={store} />);
    expect(html).toContain('aria-label="Background Mode: one-shot (read-only)"');
  });
});

// ---------------------------------------------------------------------------
// F4 / F5 / §8 component checks
// ---------------------------------------------------------------------------
const dialog = (html: string) => html.slice(html.indexOf('role="dialog"'));

describe('F4 dialog fields per provider (§3 / §8)', () => {
  it('ACP dialog: no cascade, read-only one-shot and read-only maxDepth：provider-managed', async () => {
    const { store } = await loaded();
    store.openEdit('tool-subagent-acp');
    const html = dialog(renderToString(<SubagentPanel store={store} />));
    expect(html).toContain('maxDepth：provider-managed');
    expect(html).toContain('aria-label="Background Mode: one-shot (read-only)"');
    expect(html).not.toContain('Agent Provider');
    expect(html).not.toContain('<option value="continuable"');
  });

  it('spawn dialog: cascade and Background Mode select, no maxDepth text', async () => {
    const { store } = await loaded();
    store.openEdit('tool-subagent-coder');
    const html = dialog(renderToString(<SubagentPanel store={store} />));
    expect(html).toContain('Agent Provider');
    expect(html).toContain('<option value="continuable"');
    expect(html).not.toContain('provider-managed');
  });

  it('fork dialog: no cascade, Background Mode select, no maxDepth text', async () => {
    const { store } = await loaded();
    store.openEdit('tool-subagent-fork');
    const html = dialog(renderToString(<SubagentPanel store={store} />));
    expect(html).not.toContain('Agent Provider');
    expect(html).toContain('<option value="continuable"');
    expect(html).not.toContain('provider-managed');
  });

  it('provider drop-down lists subagentProviders in array order', async () => {
    const { store } = await loaded();
    store.openCreate();
    const html = dialog(renderToString(<SubagentPanel store={store} />));
    const select = html.match(/<select[^>]*>([\s\S]*?)<\/select>/)![1];
    expect([...select.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual(['spawn', 'fork', 'ccacp', 'custom']);
  });
});

const OLD_HOST_TEXT = '当前界面已更新，Subagent 的 ACP 编辑需要重启 DSH 后生效';

describe('F5 old-Host notice (§9)', () => {
  it('not shown before the first load completes', () => {
    const store = createSubagentStore(api());
    expect(store.getSnapshot().hostApiV2).toBeNull();
    expect(renderToString(<SubagentPanel store={store} />)).not.toContain(OLD_HOST_TEXT);
  });

  it('shown with label-secondary colour when hostApi is missing; drop-down falls back to spawn/fork', async () => {
    const { store } = await loaded(state({ diagnostics: { atomicWrite: { loaded: true }, catalogSource: 'patch' } }));
    const html = renderToString(<SubagentPanel store={store} />);
    const notice = html.match(new RegExp(`<p[^>]*>${OLD_HOST_TEXT}</p>`))?.[0];
    expect(notice).toBeDefined();
    expect(notice).toContain('color:var(--dsw-alias-label-secondary)');
    expect(store.getSnapshot().subagentProviders.map((x) => x.name)).toEqual(['spawn', 'fork']);
  });

  it('hostApi 1 is treated as old even if the response carries a provider list', async () => {
    const { store } = await loaded(state({ diagnostics: { atomicWrite: { loaded: true }, catalogSource: 'patch', hostApi: 1 } }));
    expect(store.getSnapshot().hostApiV2).toBe(false);
    expect(store.getSnapshot().subagentProviders.map((x) => x.name)).toEqual(['spawn', 'fork']);
  });

  it('not shown for hostApi 2', async () => {
    const { store } = await loaded();
    expect(renderToString(<SubagentPanel store={store} />)).not.toContain(OLD_HOST_TEXT);
  });
});
