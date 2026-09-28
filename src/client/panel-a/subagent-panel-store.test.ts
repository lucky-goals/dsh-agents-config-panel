import { describe, it, expect, vi } from 'vitest';
import { createSubagentStore } from './subagent-panel-store';
import type { ApiClient } from '../shared/api-client';
import type { StateResponse, MutationSuccessResponse } from '../shared/api-types';

describe('SubagentPanelStore', () => {
  function createMockApi(): ApiClient {
    return {
      getState: vi.fn(),
      mutateSubagents: vi.fn(),
      mutateMembers: vi.fn(),
    };
  }

  it('provides getSnapshot and subscribe', () => {
    const api = createMockApi();
    const store = createSubagentStore(api);

    expect(typeof store.getSnapshot).toBe('function');
    expect(typeof store.subscribe).toBe('function');
    
    const snapshot = store.getSnapshot();
    expect(snapshot.loading).toBe(false);
    expect(snapshot.rows).toEqual([]);
  });

  it('notifies subscribers when state changes', () => {
    const api = createMockApi();
    const store = createSubagentStore(api);
    
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    
    store.openCreate();
    expect(listener).toHaveBeenCalled();
    
    unsubscribe();
    listener.mockClear();
    store.cancel();
    expect(listener).not.toHaveBeenCalled();
  });

  it('loads state successfully', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: {
        providers: [
          { id: 'gpt-gateway', models: [{ id: 'gpt-6-luna', reasoningEfforts: ['low', 'medium', 'high', 'max'] }] },
        ],
      },
      subagents: [
        {
          id: 'tool-subagent-coder',
          disabled: false,
          editable: true,
          config: {
            toolName: 'subagent_coder',
            provider: 'spawn',
            agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' },
          },
        },
      ],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockState);
    
    const store = createSubagentStore(api);
    await store.load('standard-acp');
    
    const state = store.getSnapshot();
    expect(state.loading).toBe(false);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].id).toBe('tool-subagent-coder');
    expect(state.revision).toBe('rev123');
    expect(state.catalog.providers).toHaveLength(1);
  });

  it('opens create form with empty values', () => {
    const api = createMockApi();
    const store = createSubagentStore(api);
    
    store.openCreate();
    
    const state = store.getSnapshot();
    expect(state.form.mode).toBe('create');
    expect(state.form.values.toolName).toBe('');
    expect(state.form.values.provider).toBe('spawn');
  });

  it('opens edit form with row data', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [
        {
          id: 'tool-subagent-coder',
          disabled: false,
          editable: true,
          config: {
            toolName: 'subagent_coder',
            provider: 'spawn',
            backgroundMode: 'continuable',
            agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' },
          },
        },
      ],
      teamProfiles: [],
      profile: 'standard-acp',
      members: [],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockState);
    
    const store = createSubagentStore(api);
    await store.load('standard-acp');
    store.openEdit('tool-subagent-coder');
    
    const state = store.getSnapshot();
    expect(state.form.mode).toBe('edit');
    expect(state.form.editingId).toBe('tool-subagent-coder');
    expect(state.form.values.toolName).toBe('subagent_coder');
    expect(state.form.values.agentOptions.model).toBe('gpt-6-luna');
  });

  it('blocks editing read-only ACP rows', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [
        {
          id: 'tool-subagent-cursor',
          disabled: false,
          editable: false, // ACP row
          config: { toolName: 'subagent_cursor', provider: 'cursoracp' },
        },
      ],
      teamProfiles: [],
      profile: 'standard-acp',
      members: [],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockState);
    
    const store = createSubagentStore(api);
    await store.load('standard-acp');
    store.openEdit('tool-subagent-cursor');
    
    const state = store.getSnapshot();
    expect(state.form.mode).toBeNull();
    expect(state.error).toBe('ACP 后端的 subagent 工具为只读');
  });

  it('validates toolName format', async () => {
    const api = createMockApi();
    const store = createSubagentStore(api);
    
    store.openCreate();
    store.setField('toolName', 'invalid-name'); // doesn't match pattern
    await store.submit();
    
    const state = store.getSnapshot();
    // Same wording as the Host (subagent-manager.ts validateSubagentInput).
    expect(state.form.errors.toolName).toBe("工具名 'invalid-name' 格式不合法");
    expect(api.mutateSubagents).not.toHaveBeenCalled();
  });

  it('validates duplicate toolName client-side', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [
        {
          id: 'tool-subagent-coder',
          disabled: false,
          editable: true,
          config: { toolName: 'subagent_coder', provider: 'spawn', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
        },
      ],
      teamProfiles: [],
      profile: 'standard-acp',
      members: [],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockState);
    
    const store = createSubagentStore(api);
    await store.load('standard-acp');
    
    store.openCreate();
    store.setField('toolName', 'subagent_coder'); // duplicate
    store.setField('agentOptions', { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'medium' });
    await store.submit();
    
    const state = store.getSnapshot();
    expect(state.form.errors.toolName).toContain('已存在');
    expect(api.mutateSubagents).not.toHaveBeenCalled();
  });

  it('validates spawn requires agentOptions', async () => {
    const api = createMockApi();
    const store = createSubagentStore(api);
    
    store.openCreate();
    store.setField('toolName', 'subagent_test');
    store.setField('provider', 'spawn');
    // Don't set agentOptions
    await store.submit();
    
    const state = store.getSnapshot();
    expect(state.form.errors.agentOptions?.provider).toBe('agentOptions.provider 必填');
    expect(state.form.errors.agentOptions?.model).toBe('agentOptions.model 必填');
  });

  it('submits create successfully', async () => {
    const mockResponse: MutationSuccessResponse = {
      revision: 'rev456',
      catalog: { providers: [] },
      subagents: [
        {
          id: 'tool-subagent-test',
          disabled: false,
          editable: true,
          config: { toolName: 'subagent_test', provider: 'spawn', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
        },
      ],
      teamProfiles: [],
      profile: 'standard-acp',
      members: [],
      errors: {},
      notice: '已保存，新建会话后生效',
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue({
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: [],
      profile: 'standard-acp',
      members: [],
      errors: {},
    });
    vi.mocked(api.mutateSubagents).mockResolvedValue(mockResponse);
    
    const store = createSubagentStore(api);
    await store.load('standard-acp');
    
    store.openCreate();
    store.setField('toolName', 'subagent_test');
    store.setField('provider', 'spawn');
    store.setField('agentOptions', { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'medium' });
    await store.submit();
    
    expect(api.mutateSubagents).toHaveBeenCalledWith({
      expectedRevision: 'rev123',
      action: 'create',
      input: {
        toolName: 'subagent_test',
        provider: 'spawn',
        backgroundMode: 'continuable',
        agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'medium' },
      },
    });
    
    const state = store.getSnapshot();
    expect(state.form.mode).toBeNull();
    expect(state.notice).toBe('已保存，新建会话后生效');
    expect(state.rows).toHaveLength(1);
    expect(state.revision).toBe('rev456');
  });

  it('handles 409 STALE_REVISION with auto-refresh', async () => {
    const mockStateInitial: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: [],
      profile: 'standard-acp',
      members: [],
      errors: {},
    };

    const mockStateRefreshed: StateResponse = {
      revision: 'rev999',
      catalog: { providers: [] },
      subagents: [
        {
          id: 'tool-subagent-other',
          disabled: false,
          editable: true,
          config: { toolName: 'subagent_other', provider: 'spawn', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
        },
      ],
      teamProfiles: [],
      profile: 'standard-acp',
      members: [],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValueOnce(mockStateInitial).mockResolvedValueOnce(mockStateRefreshed);
    
    const conflictError = new Error('配置已被其他地方修改，请刷新后重试') as any;
    conflictError.code = 'STALE_REVISION';
    vi.mocked(api.mutateSubagents).mockRejectedValue(conflictError);
    
    const store = createSubagentStore(api);
    await store.load('standard-acp');
    
    store.openCreate();
    store.setField('toolName', 'subagent_test');
    store.setField('provider', 'spawn');
    store.setField('agentOptions', { provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'medium' });
    await store.submit();
    
    const state = store.getSnapshot();
    expect(state.conflict).toBe('配置已被其他地方修改，请刷新后重试');
    expect(state.revision).toBe('rev999'); // Auto-refreshed
    expect(state.rows).toHaveLength(1); // Got updated data
  });

  it('requests delete with confirmation', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [
        {
          id: 'tool-subagent-test',
          disabled: false,
          editable: true,
          config: { toolName: 'subagent_test', provider: 'spawn', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
        },
      ],
      teamProfiles: [],
      profile: 'standard-acp',
      members: [],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockState);
    
    const store = createSubagentStore(api);
    await store.load('standard-acp');
    
    store.requestDelete('tool-subagent-test');
    
    const state = store.getSnapshot();
    expect(state.confirmDelete.id).toBe('tool-subagent-test');
    expect(state.confirmDelete.toolName).toBe('subagent_test');
    expect(api.mutateSubagents).not.toHaveBeenCalled(); // Not deleted yet
  });

  it('confirms and executes delete', async () => {
    const mockStateInitial: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [
        {
          id: 'tool-subagent-test',
          disabled: false,
          editable: true,
          config: { toolName: 'subagent_test', provider: 'spawn', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
        },
      ],
      teamProfiles: [],
      profile: 'standard-acp',
      members: [],
      errors: {},
    };

    const mockResponse: MutationSuccessResponse = {
      revision: 'rev456',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: [],
      profile: 'standard-acp',
      members: [],
      errors: {},
      notice: '已保存，新建会话后生效',
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockStateInitial);
    vi.mocked(api.mutateSubagents).mockResolvedValue(mockResponse);
    
    const store = createSubagentStore(api);
    await store.load('standard-acp');
    
    store.requestDelete('tool-subagent-test');
    await store.confirmDelete();
    
    expect(api.mutateSubagents).toHaveBeenCalledWith({
      expectedRevision: 'rev123',
      action: 'remove',
      id: 'tool-subagent-test',
    });
    
    const state = store.getSnapshot();
    expect(state.confirmDelete.id).toBeNull();
    expect(state.rows).toHaveLength(0);
  });

  it('blocks delete request for read-only ACP rows', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [
        {
          id: 'tool-subagent-cursor',
          disabled: false,
          editable: false,
          config: { toolName: 'subagent_cursor', provider: 'cursoracp' },
        },
      ],
      teamProfiles: [],
      profile: 'standard-acp',
      members: [],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockState);
    
    const store = createSubagentStore(api);
    await store.load('standard-acp');
    
    store.requestDelete('tool-subagent-cursor');
    
    const state = store.getSnapshot();
    expect(state.error).toBe('ACP 后端的 subagent 工具为只读');
    expect(state.confirmDelete.id).toBeNull();
  });

  describe('diagnostics', () => {
    const forkRow = {
      id: 'tool-subagent-fork',
      disabled: false,
      editable: true,
      config: { toolName: 'subagent_fork', provider: 'fork' },
    };
    function stateWith(diagnostics?: StateResponse['diagnostics']): StateResponse {
      return {
        revision: 'rev1',
        catalog: { providers: [] },
        subagents: [forkRow],
        teamProfiles: ['standard-acp'],
        profile: 'standard-acp',
        members: [],
        errors: {},
        diagnostics,
      };
    }

    it('load() without an argument queries the default team profile', async () => {
      const api = createMockApi();
      vi.mocked(api.getState).mockResolvedValue(stateWith());
      const store = createSubagentStore(api);
      await store.load();
      expect(api.getState).toHaveBeenCalledWith('standard-acp');
      expect(store.getSnapshot().diagnostics).toBeNull();
    });

    it('blocks create and remove when atomic-write is not loaded', async () => {
      const api = createMockApi();
      vi.mocked(api.getState).mockResolvedValue(
        stateWith({ atomicWrite: { loaded: false, tried: ['file:///a'] }, catalogSource: 'runtime' }),
      );
      const store = createSubagentStore(api);
      await store.load();

      store.requestDelete('tool-subagent-fork');
      await store.confirmDelete();
      store.openCreate();
      store.setField('toolName', 'subagent_new');
      store.setField('provider', 'fork');
      await store.submit();

      expect(api.mutateSubagents).not.toHaveBeenCalled();
      expect(store.getSnapshot().error).toBe('写入依赖 @deepseek-ai/dsh-atomic-write 未加载，暂时只能查看配置');
    });

    it('keeps diagnostics from the mutation response', async () => {
      const api = createMockApi();
      vi.mocked(api.getState).mockResolvedValue(stateWith({ atomicWrite: { loaded: true }, catalogSource: 'runtime' }));
      vi.mocked(api.mutateSubagents).mockResolvedValue({
        ...stateWith({ atomicWrite: { loaded: true }, catalogSource: 'patch' }),
        subagents: [],
        notice: '已保存，新建会话后生效',
      });
      const store = createSubagentStore(api);
      await store.load();
      store.requestDelete('tool-subagent-fork');
      await store.confirmDelete();

      expect(store.getSnapshot().diagnostics?.catalogSource).toBe('patch');
      expect(store.getSnapshot().notice).toBe('已保存，新建会话后生效');
    });
  });
});
