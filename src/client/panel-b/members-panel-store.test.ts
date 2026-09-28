import { describe, it, expect, vi } from 'vitest';
import { createMembersStore } from './members-panel-store';
import type { ApiClient } from '../shared/api-client';
import type { StateResponse, MutationSuccessResponse } from '../shared/api-types';

describe('MembersPanelStore', () => {
  function createMockApi(): ApiClient {
    return {
      getState: vi.fn(),
      mutateSubagents: vi.fn(),
      mutateMembers: vi.fn(),
    };
  }

  it('provides getSnapshot and subscribe', () => {
    const api = createMockApi();
    const store = createMembersStore(api);

    expect(typeof store.getSnapshot).toBe('function');
    expect(typeof store.subscribe).toBe('function');
    
    const snapshot = store.getSnapshot();
    expect(snapshot.loading).toBe(false);
    expect(snapshot.members).toEqual([]);
  });

  it('notifies subscribers when state changes', () => {
    const api = createMockApi();
    const store = createMembersStore(api);
    
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    
    store.openCreate();
    expect(listener).toHaveBeenCalled();
    
    unsubscribe();
    listener.mockClear();
    store.cancel();
    expect(listener).not.toHaveBeenCalled();
  });

  it('loads members successfully', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: {
        providers: [
          { id: 'gpt-gateway', models: [{ id: 'gpt-6-luna', reasoningEfforts: ['low', 'medium', 'high', 'max'] }] },
        ],
      },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [
        { name: 'claude', provider: 'gusu-gateway', model: 'claude-opus-5-5', reasoning_effort: 'high', role: 'worker' },
        { name: 'coder', provider: 'gusu-gateway', model: 'claude-opus-5-5', reasoning_effort: 'high', role: 'implementation' },
      ],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockState);
    
    const store = createMembersStore(api);
    await store.load('standard-acp');
    
    const state = store.getSnapshot();
    expect(state.loading).toBe(false);
    expect(state.members).toHaveLength(2);
    expect(state.members[0].name).toBe('claude');
    expect(state.revision).toBe('rev123');
  });

  it('opens create form with empty values', () => {
    const api = createMockApi();
    const store = createMembersStore(api);
    
    store.openCreate();
    
    const state = store.getSnapshot();
    expect(state.form.mode).toBe('add');
    expect(state.form.values.name).toBe('');
    expect(state.form.values.role).toBe('');
  });

  it('opens edit form with member data', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [
        { name: 'claude', provider: 'gusu-gateway', model: 'claude-opus-5-5', reasoning_effort: 'high', role: 'worker' },
      ],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockState);
    
    const store = createMembersStore(api);
    await store.load('standard-acp');
    store.openEdit('claude');
    
    const state = store.getSnapshot();
    expect(state.form.mode).toBe('edit');
    expect(state.form.editingName).toBe('claude');
    expect(state.form.values.name).toBe('claude');
    expect(state.form.values.model).toBe('claude-opus-5-5');
  });

  it('validates member name format', async () => {
    const api = createMockApi();
    const store = createMembersStore(api);
    
    store.openCreate();
    store.setField('name', 'Invalid_Name'); // doesn't match pattern (uppercase not allowed)
    await store.submit();
    
    const state = store.getSnapshot();
    // Same wording as the Host (members-editor.ts validateMember).
    expect(state.form.errors.name).toBe("成员名 'Invalid_Name' 格式不合法");
    expect(api.mutateMembers).not.toHaveBeenCalled();
  });

  it('validates duplicate member name client-side', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [
        { name: 'alice' },
      ],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockState);
    
    const store = createMembersStore(api);
    await store.load('standard-acp');
    
    store.openCreate();
    store.setField('name', 'alice'); // duplicate
    await store.submit();
    
    const state = store.getSnapshot();
    expect(state.form.errors.name).toContain('已存在');
    expect(api.mutateMembers).not.toHaveBeenCalled();
  });

  it('validates provider/model must be both or neither', async () => {
    const api = createMockApi();
    const store = createMembersStore(api);
    
    store.openCreate();
    store.setField('name', 'test');
    store.setField('provider', 'gpt-gateway');
    // Don't set model
    await store.submit();
    
    let state = store.getSnapshot();
    expect(state.form.errors.model).toBe('成员 provider 和 model 必须同时填写');
    
    store.cancel();
    store.openCreate();
    store.setField('name', 'test');
    store.setField('model', 'gpt-6-luna');
    // Don't set provider
    await store.submit();
    
    state = store.getSnapshot();
    expect(state.form.errors.provider).toBe('成员 provider 和 model 必须同时填写');
  });

  it('submits add successfully', async () => {
    const mockResponse: MutationSuccessResponse = {
      revision: 'rev456',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [
        { name: 'alice' },
        { name: 'bob', role: 'tester', provider: 'gpt-gateway', model: 'gpt-6-luna', reasoning_effort: 'medium' },
      ],
      errors: {},
      notice: '已保存，新建会话后生效',
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue({
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [{ name: 'alice' }],
      errors: {},
    });
    vi.mocked(api.mutateMembers).mockResolvedValue(mockResponse);
    
    const store = createMembersStore(api);
    await store.load('standard-acp');
    
    store.openCreate();
    store.setField('name', 'bob');
    store.setField('role', 'tester');
    store.setField('provider', 'gpt-gateway');
    store.setField('model', 'gpt-6-luna');
    store.setField('reasoning_effort', 'medium');
    await store.submit();
    
    expect(api.mutateMembers).toHaveBeenCalledWith({
      expectedRevision: 'rev123',
      profile: 'standard-acp',
      action: 'add',
      member: {
        name: 'bob',
        role: 'tester',
        provider: 'gpt-gateway',
        model: 'gpt-6-luna',
        reasoning_effort: 'medium',
      },
    });
    
    const state = store.getSnapshot();
    expect(state.form.mode).toBeNull();
    expect(state.notice).toBe('已保存，新建会话后生效');
    expect(state.members).toHaveLength(2);
  });

  it('handles 409 STALE_REVISION with auto-refresh', async () => {
    const mockStateInitial: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [{ name: 'alice' }],
      errors: {},
    };

    const mockStateRefreshed: StateResponse = {
      revision: 'rev999',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [{ name: 'alice' }, { name: 'charlie' }],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValueOnce(mockStateInitial).mockResolvedValueOnce(mockStateRefreshed);
    
    const conflictError = new Error('配置已被其他地方修改，请刷新后重试') as any;
    conflictError.code = 'STALE_REVISION';
    vi.mocked(api.mutateMembers).mockRejectedValue(conflictError);
    
    const store = createMembersStore(api);
    await store.load('standard-acp');
    
    store.openCreate();
    store.setField('name', 'bob');
    await store.submit();
    
    const state = store.getSnapshot();
    expect(state.conflict).toBe('配置已被其他地方修改，请刷新后重试');
    expect(state.revision).toBe('rev999'); // Auto-refreshed
    expect(state.members).toHaveLength(2); // Got updated data
  });

  it('requests delete with confirmation', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [{ name: 'alice' }, { name: 'bob' }],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockState);
    
    const store = createMembersStore(api);
    await store.load('standard-acp');
    
    store.requestDelete('bob');
    
    const state = store.getSnapshot();
    expect(state.confirmDelete.name).toBe('bob');
    expect(api.mutateMembers).not.toHaveBeenCalled(); // Not deleted yet
  });

  it('confirms and executes delete', async () => {
    const mockStateInitial: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [{ name: 'alice' }, { name: 'bob' }],
      errors: {},
    };

    const mockResponse: MutationSuccessResponse = {
      revision: 'rev456',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [{ name: 'alice' }],
      errors: {},
      notice: '已保存，新建会话后生效',
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockStateInitial);
    vi.mocked(api.mutateMembers).mockResolvedValue(mockResponse);
    
    const store = createMembersStore(api);
    await store.load('standard-acp');
    
    store.requestDelete('bob');
    await store.confirmDelete();
    
    expect(api.mutateMembers).toHaveBeenCalledWith({
      expectedRevision: 'rev123',
      profile: 'standard-acp',
      action: 'remove',
      name: 'bob',
    });
    
    const state = store.getSnapshot();
    expect(state.confirmDelete.name).toBeNull();
    expect(state.members).toHaveLength(1);
  });

  it('blocks deleting the last member client-side', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [{ name: 'alice' }],
      errors: {},
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockState);
    
    const store = createMembersStore(api);
    await store.load('standard-acp');
    
    store.requestDelete('alice');
    
    const state = store.getSnapshot();
    expect(state.error).toBe('团队至少需要保留一个成员');
    expect(state.confirmDelete.name).toBeNull();
    expect(api.mutateMembers).not.toHaveBeenCalled();
  });

  it('submits update successfully', async () => {
    const mockStateInitial: StateResponse = {
      revision: 'rev123',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [{ name: 'alice', role: 'worker' }],
      errors: {},
    };

    const mockResponse: MutationSuccessResponse = {
      revision: 'rev456',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [{ name: 'alice-renamed', role: 'maintainer' }],
      errors: {},
      notice: '已保存，新建会话后生效',
    };

    const api = createMockApi();
    vi.mocked(api.getState).mockResolvedValue(mockStateInitial);
    vi.mocked(api.mutateMembers).mockResolvedValue(mockResponse);
    
    const store = createMembersStore(api);
    await store.load('standard-acp');
    
    store.openEdit('alice');
    store.setField('name', 'alice-renamed');
    store.setField('role', 'maintainer');
    await store.submit();
    
    expect(api.mutateMembers).toHaveBeenCalledWith({
      expectedRevision: 'rev123',
      profile: 'standard-acp',
      action: 'update',
      name: 'alice',
      patch: {
        name: 'alice-renamed',
        role: 'maintainer',
      },
    });
    
    const state = store.getSnapshot();
    expect(state.members[0].name).toBe('alice-renamed');
  });

  describe('team profile selection', () => {
    function stateFor(profile: string, teamProfiles: string[], extra: Partial<StateResponse> = {}): StateResponse {
      return {
        revision: `rev-${profile}`,
        catalog: { providers: [] },
        subagents: [],
        teamProfiles,
        profile,
        members: teamProfiles.includes(profile) ? [{ name: `${profile}-lead` }, { name: `${profile}-worker` }] : [],
        errors: teamProfiles.includes(profile) ? {} : { members: `未找到团队 profile '${profile}'` },
        ...extra,
      };
    }

    it('starts with standard-acp when load() has no argument', async () => {
      const api = createMockApi();
      vi.mocked(api.getState).mockImplementation(async (p) => stateFor(p, ['review', 'standard-acp']));
      const store = createMembersStore(api);
      await store.load();

      expect(api.getState).toHaveBeenCalledTimes(1);
      expect(api.getState).toHaveBeenCalledWith('standard-acp');
      const state = store.getSnapshot();
      expect(state.profile).toBe('standard-acp');
      expect(state.teamProfiles).toEqual(['review', 'standard-acp']);
      expect(state.error).toBeNull();
    });

    it('falls back to the first team profile when standard-acp is absent', async () => {
      const api = createMockApi();
      vi.mocked(api.getState).mockImplementation(async (p) => stateFor(p, ['alpha', 'beta']));
      const store = createMembersStore(api);
      await store.load();

      expect(vi.mocked(api.getState).mock.calls.map((c) => c[0])).toEqual(['standard-acp', 'alpha']);
      const state = store.getSnapshot();
      expect(state.profile).toBe('alpha');
      expect(state.members.map((m) => m.name)).toEqual(['alpha-lead', 'alpha-worker']);
      expect(state.error).toBeNull();
    });

    it('surfaces errors.members when there are no team profiles', async () => {
      const api = createMockApi();
      vi.mocked(api.getState).mockResolvedValue(
        stateFor('standard-acp', [], { errors: { members: '未找到 agent-teams 配置，请确认已安装 @nanmicoder/dsh-agent-teams' } }),
      );
      const store = createMembersStore(api);
      await store.load();

      expect(api.getState).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().error).toBe('未找到 agent-teams 配置，请确认已安装 @nanmicoder/dsh-agent-teams');
      expect(store.getSnapshot().members).toEqual([]);
    });

    it('setProfile reloads members and later writes carry the new profile', async () => {
      const api = createMockApi();
      vi.mocked(api.getState).mockImplementation(async (p) => stateFor(p, ['review', 'standard-acp']));
      vi.mocked(api.mutateMembers).mockImplementation(async (body) => ({
        ...stateFor(body.profile, ['review', 'standard-acp']),
        notice: '已保存，新建会话后生效',
      }));
      const store = createMembersStore(api);
      await store.load();
      store.openCreate();
      await store.setProfile('review');

      const state = store.getSnapshot();
      expect(state.profile).toBe('review');
      expect(state.revision).toBe('rev-review');
      expect(state.members.map((m) => m.name)).toEqual(['review-lead', 'review-worker']);
      expect(state.form.mode).toBeNull(); // the open form belonged to the old profile

      store.requestDelete('review-worker');
      await store.confirmDelete();
      expect(api.mutateMembers).toHaveBeenCalledWith({
        expectedRevision: 'rev-review',
        profile: 'review',
        action: 'remove',
        name: 'review-worker',
      });

      await store.load(); // refresh keeps the selection
      expect(api.getState).toHaveBeenLastCalledWith('review');
    });

    it('stores diagnostics and blocks writes when atomic-write is not loaded', async () => {
      const api = createMockApi();
      vi.mocked(api.getState).mockResolvedValue(
        stateFor('standard-acp', ['standard-acp'], {
          diagnostics: { atomicWrite: { loaded: false, tried: ['file:///a'] }, catalogSource: 'patch' },
        }),
      );
      const store = createMembersStore(api);
      await store.load();
      expect(store.getSnapshot().diagnostics?.atomicWrite.loaded).toBe(false);

      store.requestDelete('standard-acp-worker');
      await store.confirmDelete();
      store.openCreate();
      store.setField('name', 'helper');
      await store.submit();

      expect(api.mutateMembers).not.toHaveBeenCalled();
      expect(store.getSnapshot().error).toBe('写入依赖 @deepseek-ai/dsh-atomic-write 未加载，暂时只能查看配置');
    });

    it('shows the Host message for 413 PAYLOAD_TOO_LARGE and 503 DEPENDENCY_UNAVAILABLE', async () => {
      for (const [code, message] of [
        ['PAYLOAD_TOO_LARGE', '请求体超过 1MB 限制'],
        ['DEPENDENCY_UNAVAILABLE', '缺少 @deepseek-ai/dsh-atomic-write，无法安全写入配置'],
      ]) {
        const api = createMockApi();
        vi.mocked(api.getState).mockResolvedValue(stateFor('standard-acp', ['standard-acp']));
        vi.mocked(api.mutateMembers).mockRejectedValue(Object.assign(new Error(message), { code }));
        const store = createMembersStore(api);
        await store.load();
        store.openCreate();
        store.setField('name', 'helper');
        await store.submit();
        expect(store.getSnapshot().error, code).toBe(message);
        expect(store.getSnapshot().form.mode, code).toBe('add'); // form stays open for retry
      }
    });
  });
});
