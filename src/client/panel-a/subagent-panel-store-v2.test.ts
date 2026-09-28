/**
 * t41 TDD tests for Panel A v2.1:
 * - Provider list from state.subagentProviders
 * - Capability-driven form fields
 * - Registered ACP rows editable; unregistered rows readonly
 * - hostApi < 2 compatibility fallback
 * - All existing spawn/fork tests still pass
 *
 * These tests are WRITTEN FIRST and are expected to fail until the store
 * and panel are updated to support v2.1.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSubagentStore, suppressAgentOptions } from './subagent-panel-store';
import type { ApiClient } from '../shared/api-client';
import type {
  StateResponse,
  MutationSuccessResponse,
  SubagentProviderInfo,
} from '../shared/api-types';

const ACP_CAPS: SubagentProviderInfo['capabilities'] = {
  agentOptions: false,
  depthLimit: false,
  continuable: false,
  persona: false,
  toolFilter: false,
};

const SPAWN_CAPS: SubagentProviderInfo['capabilities'] = {
  agentOptions: true,
  depthLimit: true,
  continuable: true,
  persona: true,
  toolFilter: true,
};

/** Real in-process fork capabilities (all five true); agentOptions is suppressed by name only. */
const FORK_CAPS: SubagentProviderInfo['capabilities'] = {
  agentOptions: true,
  depthLimit: true,
  continuable: true,
  persona: true,
  toolFilter: true,
};

/** Helpers */
function makeProvider(name: string, caps: SubagentProviderInfo['capabilities'], kind: SubagentProviderInfo['kind'] = 'acp'): SubagentProviderInfo {
  return { name, kind, capabilities: caps, source: 'patch' };
}

function baseState(extra?: Partial<StateResponse>): StateResponse {
  return {
    revision: 'rev1',
    catalog: { providers: [{ id: 'gpt-gateway', models: [{ id: 'gpt-6-luna', reasoningEfforts: ['max'] }] }] },
    subagents: [],
    teamProfiles: [],
    profile: 'standard-acp',
    members: [],
    errors: {},
    subagentProviders: [
      makeProvider('spawn', SPAWN_CAPS, 'in-process'),
      makeProvider('fork', FORK_CAPS, 'in-process'),
      makeProvider('cursoracp', ACP_CAPS),
      makeProvider('ccacp', ACP_CAPS),
    ],
    diagnostics: {
      atomicWrite: { loaded: true },
      catalogSource: 'runtime',
      hostApi: 2,
    },
    ...extra,
  };
}

function createMockApi(stateOrFn?: StateResponse | (() => StateResponse)): ApiClient {
  const fn = typeof stateOrFn === 'function' ? stateOrFn : () => stateOrFn ?? baseState();
  return {
    getState: vi.fn(async () => fn()),
    mutateSubagents: vi.fn(async () => ({ ...fn(), notice: '已保存，新建会话后生效' } as MutationSuccessResponse)),
    mutateMembers: vi.fn(async () => { throw new Error('not used'); }),
  };
}

// ============================================================================
// 1. provider list comes from state.subagentProviders
// ============================================================================
describe('v2.1 subagentProviders in state', () => {
  it('stores subagentProviders from the response', async () => {
    const api = createMockApi();
    const store = createSubagentStore(api);
    await store.load();
    const { subagentProviders } = store.getSnapshot();
    expect(subagentProviders.map((p) => p.name)).toEqual(['spawn', 'fork', 'cursoracp', 'ccacp']);
  });

  it('falls back to spawn/fork defaults when response lacks subagentProviders', async () => {
    const api = createMockApi(baseState({ subagentProviders: undefined }));
    const store = createSubagentStore(api);
    await store.load();
    const { subagentProviders } = store.getSnapshot();
    expect(subagentProviders.map((p) => p.name)).toEqual(['spawn', 'fork']);
    expect(subagentProviders[0].capabilities.agentOptions).toBe(true);
  });

  it('falls back when hostApi is absent (old Host)', async () => {
    const api = createMockApi(baseState({ subagentProviders: undefined, diagnostics: { atomicWrite: { loaded: true }, catalogSource: 'patch' } }));
    const store = createSubagentStore(api);
    await store.load();
    expect(store.getSnapshot().hostApiV2).toBe(false);
  });

  it('sets hostApiV2 true when hostApi >= 2', async () => {
    const api = createMockApi();
    const store = createSubagentStore(api);
    await store.load();
    expect(store.getSnapshot().hostApiV2).toBe(true);
  });
});

// ============================================================================
// 2. ACP row editable when provider is registered
// ============================================================================
describe('v2.1 ACP row editability', () => {
  it('ACP row with registered provider is editable', async () => {
    const api = createMockApi(baseState({
      subagents: [{
        id: 'tool-subagent-cursor',
        disabled: false,
        editable: true,
        config: { toolName: 'subagent_cursor', provider: 'cursoracp' },
      }],
    }));
    const store = createSubagentStore(api);
    await store.load();
    store.openEdit('tool-subagent-cursor');
    const state = store.getSnapshot();
    expect(state.form.mode).toBe('edit');
    expect(state.form.values.provider).toBe('cursoracp');
  });

  it('ACP row with unregistered provider is readonly with correct message', async () => {
    const api = createMockApi(baseState({
      subagents: [{
        id: 'tool-subagent-codex',
        disabled: true,
        editable: false,
        readOnlyReason: "provider 'codex' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑",
        config: { toolName: 'subagent_codex', provider: 'codex' },
      }],
    }));
    const store = createSubagentStore(api);
    await store.load();
    store.openEdit('tool-subagent-codex');
    const state = store.getSnapshot();
    expect(state.form.mode).toBeNull();
    expect(state.error).toBe("provider 'codex' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑");
  });

  it('openEdit uses readOnlyReason when present, falls back to MSG.readOnly for old rows', async () => {
    const api = createMockApi(baseState({
      subagents: [{
        id: 'tool-subagent-acp',
        disabled: false,
        editable: false,
        // no readOnlyReason → old v2.0 Host
        config: { toolName: 'subagent_acp', provider: 'acp' },
      }],
    }));
    const store = createSubagentStore(api);
    await store.load();
    store.openEdit('tool-subagent-acp');
    const state = store.getSnapshot();
    expect(state.form.mode).toBeNull();
    // v2.1 Host without readOnlyReason on the row: the client derives the contract wording.
    expect(state.error).toBe("provider 'acp' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑");
  });
});

// ============================================================================
// 3. Capability-driven form: ACP provider has agentOptions=false
// ============================================================================
describe('v2.1 capability-driven form fields', () => {
  it('switching to ACP provider exposes capabilities in snapshot', async () => {
    const api = createMockApi();
    const store = createSubagentStore(api);
    await store.load();
    store.openCreate();
    // Switch to an ACP provider
    store.setField('provider', 'cursoracp');
    const state = store.getSnapshot();
    const caps = store.getProviderCapabilities('cursoracp');
    expect(caps?.agentOptions).toBe(false);
    expect(caps?.continuable).toBe(false);
  });

  it('spawn provider has agentOptions=true', async () => {
    const api = createMockApi();
    const store = createSubagentStore(api);
    await store.load();
    const caps = store.getProviderCapabilities('spawn');
    expect(caps?.agentOptions).toBe(true);
    expect(caps?.continuable).toBe(true);
  });

  it('fork: all five capabilities are true, agentOptions is suppressed by the name exception only', async () => {
    const api = createMockApi();
    const store = createSubagentStore(api);
    await store.load();
    const caps = store.getProviderCapabilities('fork');
    expect(caps).toEqual({ agentOptions: true, depthLimit: true, continuable: true, persona: true, toolFilter: true });
    expect(suppressAgentOptions('fork', caps)).toBe(true);
    expect(suppressAgentOptions('spawn', store.getProviderCapabilities('spawn'))).toBe(false);
    // A fork edit therefore never carries agentOptions, even with the capability set.
    const fork = { toolName: 'subagent_fork', provider: 'fork', backgroundMode: 'continuable' as const, agentOptions: { provider: '', model: '', reasoningEffort: '' } };
    const withStale = { ...fork, backgroundMode: 'one-shot' as const, agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: '' } };
    expect(diffSubagentPatch(fork, withStale, store.getSnapshot().subagentProviders)).toEqual({ backgroundMode: 'one-shot' });
  });

  it('switching from spawn to ACP clears agentOptions validation and allows submit without them', async () => {
    const mutateResponse = { ...baseState(), notice: '已保存，新建会话后生效' } as MutationSuccessResponse;
    const api = createMockApi();
    vi.mocked(api.mutateSubagents).mockResolvedValue(mutateResponse);
    const store = createSubagentStore(api);
    await store.load();
    store.openCreate();
    store.setField('toolName', 'subagent_test_acp');
    store.setField('provider', 'cursoracp');
    // No agentOptions set — should NOT fail validation for ACP provider
    await store.submit();
    const state = store.getSnapshot();
    // No agentOptions errors
    expect(state.form.errors.agentOptions).toBeUndefined();
    // Submit was called
    expect(api.mutateSubagents).toHaveBeenCalled();
    // The request should not contain agentOptions
    const req = vi.mocked(api.mutateSubagents).mock.calls[0][0];
    expect(req.input?.agentOptions).toBeUndefined();
  });

  it('ACP create: backgroundMode defaults to one-shot, not continuable', async () => {
    const api = createMockApi();
    vi.mocked(api.mutateSubagents).mockResolvedValue({ ...baseState(), notice: '已保存' } as MutationSuccessResponse);
    const store = createSubagentStore(api);
    await store.load();
    store.openCreate();
    store.setField('toolName', 'subagent_myacp');
    store.setField('provider', 'cursoracp');
    await store.submit();
    const req = vi.mocked(api.mutateSubagents).mock.calls[0][0];
    expect(req.input?.backgroundMode).toBe('one-shot');
  });

  it('spawn validation still requires agentOptions', async () => {
    const api = createMockApi();
    const store = createSubagentStore(api);
    await store.load();
    store.openCreate();
    store.setField('toolName', 'subagent_s');
    store.setField('provider', 'spawn');
    await store.submit();
    const errors = store.getSnapshot().form.errors;
    expect(errors.agentOptions?.provider).toBe('agentOptions.provider 必填');
    expect(api.mutateSubagents).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 4. hostApi < 2 compatibility mode
// ============================================================================
describe('v2.1 hostApi compatibility', () => {
  it('hostApiV2 is false when hostApi is missing', async () => {
    const api = createMockApi(baseState({ diagnostics: { atomicWrite: { loaded: true }, catalogSource: 'patch' } }));
    const store = createSubagentStore(api);
    await store.load();
    expect(store.getSnapshot().hostApiV2).toBe(false);
  });

  it('hostApiV2 is false when hostApi < 2', async () => {
    const api = createMockApi(baseState({ diagnostics: { atomicWrite: { loaded: true }, catalogSource: 'patch', hostApi: 1 } }));
    const store = createSubagentStore(api);
    await store.load();
    expect(store.getSnapshot().hostApiV2).toBe(false);
  });

  it('hostApi !== 2: drop-down is spawn/fork only and no ACP write is sent (contract §9)', async () => {
    // Worst case: the response still carries a provider list and marks the ACP row editable.
    const api = createMockApi(baseState({
      diagnostics: { atomicWrite: { loaded: true }, catalogSource: 'patch', hostApi: 1 },
      subagents: [
        { id: 'tool-subagent-cursor', disabled: false, editable: true, config: { toolName: 'subagent_cursor', provider: 'cursoracp', backgroundMode: 'one-shot' } },
        { id: 'tool-subagent-fork', disabled: false, editable: true, config: { toolName: 'subagent_fork', provider: 'fork', backgroundMode: 'continuable' } },
      ],
    }));
    const store = createSubagentStore(api);
    await store.load();
    expect(store.getSnapshot().subagentProviders.map((p) => p.name)).toEqual(['spawn', 'fork']);

    // ACP row: edit and delete are refused locally, nothing is sent.
    store.openEdit('tool-subagent-cursor');
    expect(store.getSnapshot().form.mode).toBeNull();
    expect(store.getSnapshot().error).toBe('当前界面已更新，Subagent 的 ACP 编辑需要重启 DSH 后生效');
    store.requestDelete('tool-subagent-cursor');
    expect(store.getSnapshot().confirmDelete.id).toBeNull();

    // Creating an ACP row is rejected by validateForm.
    store.openCreate();
    expect(store.getSnapshot().form.values.provider).toBe('spawn');
    store.setField('toolName', 'subagent_new_acp');
    store.setField('provider', 'cursoracp');
    await store.submit();
    expect(store.getSnapshot().form.errors.provider).toBe("provider 'cursoracp' 未注册");

    // Moving the fork row onto an ACP provider is rejected too.
    store.openEdit('tool-subagent-fork');
    store.setField('provider', 'ccacp');
    await store.submit();
    expect(store.getSnapshot().form.errors.provider).toBe("provider 'ccacp' 未注册");
    expect(api.mutateSubagents).not.toHaveBeenCalled();
  });

  it('when hostApiV2 is false and row is editable:false with no readOnlyReason, still uses MSG fallback', async () => {
    // Old Host doesn't send readOnlyReason, but row.editable is false
    const api = createMockApi(baseState({
      subagentProviders: undefined,
      diagnostics: { atomicWrite: { loaded: true }, catalogSource: 'patch' },
      subagents: [{
        id: 'tool-subagent-cursor',
        disabled: false,
        editable: false,
        config: { toolName: 'subagent_cursor', provider: 'cursoracp' },
      }],
    }));
    const store = createSubagentStore(api);
    await store.load();
    store.openEdit('tool-subagent-cursor');
    const state = store.getSnapshot();
    expect(state.form.mode).toBeNull();
    expect(state.error).toBe('ACP 后端的 subagent 工具为只读');
  });
});

// ============================================================================
// 5. diffSubagentPatch for ACP providers (no agentOptions)
// ============================================================================
import { diffSubagentPatch } from './subagent-panel-store';

describe('v2.1 diffSubagentPatch ACP', () => {
  it('ACP→ACP provider change: only sends provider', () => {
    const original = { toolName: 'subagent_c', provider: 'cursoracp', backgroundMode: 'one-shot' as const, agentOptions: { provider: '', model: '', reasoningEffort: '' } };
    const values = { ...original, provider: 'ccacp' };
    const patch = diffSubagentPatch(original, values);
    expect(patch).toEqual({ provider: 'ccacp' });
    expect(patch.agentOptions).toBeUndefined();
  });

  it('ACP→spawn sends provider and full agentOptions', () => {
    const original = { toolName: 'subagent_c', provider: 'cursoracp', backgroundMode: 'one-shot' as const, agentOptions: { provider: '', model: '', reasoningEffort: '' } };
    const values = { ...original, provider: 'spawn', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: '' } };
    const patch = diffSubagentPatch(original, values);
    expect(patch.provider).toBe('spawn');
    expect(patch.agentOptions).toMatchObject({ provider: 'gpt-gateway', model: 'gpt-6-luna' });
  });

  it('spawn→ACP sends only provider (Host handles the rest)', () => {
    const original = { toolName: 'subagent_c', provider: 'spawn', backgroundMode: 'continuable' as const, agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' } };
    const values = { ...original, provider: 'cursoracp', agentOptions: { provider: '', model: '', reasoningEffort: '' } };
    const patch = diffSubagentPatch(original, values);
    expect(patch.provider).toBe('cursoracp');
    expect(patch.agentOptions).toBeUndefined();
  });
});
