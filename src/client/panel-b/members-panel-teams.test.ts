/**
 * v2.6 Panel B store: export/import of ALL team profiles (with an explicit
 * overwrite choice for existing teams) and the new / clone team dialog.
 * State comes from the Host readers run on the sanitized real patch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listMembers, listTeamProfiles } from '../../host/members-editor';
import { listTeamProfileConfigs } from '../../host/teams-editor';
import { readCatalog } from '../../host/catalog';
import type { ApiClient } from '../shared/api-client';
import type { StateResponse, TeamMember } from '../shared/api-types';
import { createMembersStore } from './members-panel-store';

vi.mock('../shared/import-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/import-export')>()),
  downloadYaml: vi.fn(),
}));
import { downloadYaml, exportTeams, parseTeamsFile } from '../shared/import-export';

const FIXTURE = readFileSync(resolve(__dirname, '../../../test/fixtures/real-web-cordis.patch.yml'), 'utf8');
const STANDARD = listTeamProfileConfigs(FIXTURE)['standard-acp'];
const REVIEW = { description: '审查小组', members: [{ name: 'reviewer' }, { name: 'second' }] };

function state(profile = 'standard-acp', overrides: Partial<StateResponse> = {}): StateResponse {
  return {
    revision: 'r0',
    catalog: readCatalog(FIXTURE),
    subagents: [],
    teamProfiles: ['standard-acp', 'review'],
    profile,
    members: profile === 'standard-acp' ? (listMembers(FIXTURE, 'standard-acp') as TeamMember[]) : (REVIEW.members as TeamMember[]),
    dshProfile: { name: 'web', patchPath: '/p/web/cordis.patch.yml' },
    errors: {},
    diagnostics: { atomicWrite: { loaded: true }, catalogSource: 'runtime', hostApi: 2 },
    ...overrides,
  };
}

function mockApi(): ApiClient & Record<string, any> {
  return {
    getState: vi.fn(async (profile: string) => state(profile)),
    mutateSubagents: vi.fn(),
    mutateMembers: vi.fn(),
    mutateAcps: vi.fn(),
    importSubagentBundle: vi.fn(),
    testAcp: vi.fn(),
    getTeams: vi.fn(async () => ({ revision: 'r0', profiles: { 'standard-acp': STANDARD, review: REVIEW }, dshProfile: { name: 'web', patchPath: '/p' } })),
    createTeam: vi.fn(async (body: any) => ({ ...state(body.name, { revision: 'r1', teamProfiles: ['standard-acp', 'review', body.name], members: [{ name: 'm' }] }), notice: '已保存，新建会话后生效' })),
    importTeams: vi.fn(),
    removeTeam: vi.fn(async (body: any) => ({ ...state('standard-acp', { revision: 'r3', teamProfiles: ['standard-acp', 'review'].filter((n) => n !== body.name) }), notice: '已保存，新建会话后生效' })),
  };
}

function file(name: string, text: string): File {
  return { name, size: text.length, text: async () => text } as unknown as File;
}

beforeEach(() => vi.mocked(downloadYaml).mockClear());

describe('export: every team profile, not just the selected one', () => {
  it('downloads all teams with full config into one profile-named file', async () => {
    const api = mockApi();
    const store = createMembersStore(api);
    await store.load();
    await store.exportConfig();
    const [name, text] = vi.mocked(downloadYaml).mock.calls[0];
    expect(name).toMatch(/^wuyou-teams-web-\d{8}-\d{6}\.yaml$/);
    expect(parseTeamsFile(text).teams.map((t) => [t.name, t.profile])).toEqual([['standard-acp', STANDARD], ['review', REVIEW]]);
    expect(store.getSnapshot().notice).toBe('已导出 2 个团队：standard-acp、review');
  });
});

describe('import: several teams, overwrite only after an explicit choice', () => {
  const incoming = () => exportTeams({ 'standard-acp': { members: [{ name: 'solo' }] }, review: REVIEW, fresh: { members: [{ name: 'a' }] } }, 'desktop');

  it('previews against all current teams; conflicts are not ticked for overwrite by default', async () => {
    const api = mockApi();
    const store = createMembersStore(api);
    await store.load();
    await store.importConfig(file('teams.yaml', incoming()));
    const preview = store.getSnapshot().teamImport!;
    expect(preview).toMatchObject({ fileName: 'teams.yaml', sourceProfile: 'desktop', revision: 'r0' });
    expect(preview.teams.map((t) => [t.name, t.status, t.fileMembers, t.currentMembers ?? null])).toEqual([
      ['standard-acp', 'conflict', 1, 5], ['review', 'conflict', 2, 2], ['fresh', 'new', 1, null],
    ]);
    expect([...preview.overwrite]).toEqual([]);
  });

  it('without ticking, confirm creates only the new team; ticking a conflict overwrites it', async () => {
    const api = mockApi();
    api.importTeams.mockResolvedValue({
      ...state('standard-acp', { revision: 'r2', teamProfiles: ['standard-acp', 'review', 'fresh'] }),
      notice: '已保存，新建会话后生效',
      importReport: { created: ['fresh'], overwritten: ['review'], skipped: [{ name: 'standard-acp', reason: "团队 'standard-acp' 已存在，未选择覆盖" }] },
    });
    const store = createMembersStore(api);
    await store.load();
    await store.importConfig(file('teams.yaml', incoming()));
    store.toggleTeamOverwrite('review');
    expect([...store.getSnapshot().teamImport!.overwrite]).toEqual(['review']);
    await store.confirmImport();

    const [body, profile] = api.importTeams.mock.calls[0];
    expect(profile).toBe('standard-acp');
    expect(body.expectedRevision).toBe('r0');
    expect(body.teams.map((t: any) => t.name)).toEqual(['standard-acp', 'review', 'fresh']);
    expect(body.overwrite).toEqual(['review']);
    expect(store.getSnapshot()).toMatchObject({ revision: 'r2', teamImport: null, teamProfiles: ['standard-acp', 'review', 'fresh'] });
    expect(store.getSnapshot().notice).toBe('新增 1 个团队（fresh），覆盖 1 个（review），跳过 1 个。新建会话后生效');
    expect(store.getSnapshot().error).toContain("standard-acp：团队 'standard-acp' 已存在，未选择覆盖");
  });

  it('toggling twice un-ticks; invalid or new teams cannot be ticked', async () => {
    const store = createMembersStore(mockApi());
    await store.load();
    await store.importConfig(file('t.yaml', incoming()));
    store.toggleTeamOverwrite('review');
    store.toggleTeamOverwrite('review');
    store.toggleTeamOverwrite('fresh');
    expect([...store.getSnapshot().teamImport!.overwrite]).toEqual([]);
  });

  it('a stale revision refreshes and closes the preview without writing', async () => {
    const api = mockApi();
    api.importTeams.mockRejectedValue(Object.assign(new Error('配置已被其他地方修改，请刷新后重试'), { code: 'STALE_REVISION' }));
    const store = createMembersStore(api);
    await store.load();
    await store.importConfig(file('t.yaml', incoming()));
    await store.confirmImport();
    expect(store.getSnapshot()).toMatchObject({ teamImport: null, conflict: '配置已被其他地方修改，请刷新后重试' });
  });

  it('a v2.5 members file previews as a members-only conflict', async () => {
    const store = createMembersStore(mockApi());
    await store.load();
    await store.importConfig(file('old.yaml', 'kind: wuyou-members\nprofile: review\nmembers:\n  - name: x\n'));
    expect(store.getSnapshot().teamImport!.teams[0]).toMatchObject({ name: 'review', status: 'conflict', scope: 'members' });
  });
});

describe('new / clone team dialog', () => {
  it('opens with the current team as the clone source; submit clones and switches to the new team', async () => {
    const api = mockApi();
    const store = createMembersStore(api);
    await store.load();
    store.openCreateTeam();
    expect(store.getSnapshot().teamCreate).toMatchObject({ open: true, from: 'standard-acp', name: '' });
    store.setTeamField('name', 'standard-acp-2');
    await store.submitTeam();
    expect(api.createTeam).toHaveBeenCalledWith({ expectedRevision: 'r0', action: 'create', name: 'standard-acp-2', from: 'standard-acp' });
    expect(store.getSnapshot()).toMatchObject({ profile: 'standard-acp-2', revision: 'r1', teamCreate: { open: false }, notice: "已创建团队 'standard-acp-2'（克隆自 standard-acp）。新建会话后生效" });
    expect(store.getSnapshot().teamProfiles).toContain('standard-acp-2');
  });

  it('a new (blank) team sends its first member and description, not `from`', async () => {
    const api = mockApi();
    const store = createMembersStore(api);
    await store.load();
    store.openCreateTeam();
    store.setTeamField('from', '');
    store.setTeamField('name', 'solo');
    store.setTeamField('firstMember', 'worker');
    store.setTeamField('description', '  单人团队 ');
    await store.submitTeam();
    expect(api.createTeam).toHaveBeenCalledWith({ expectedRevision: 'r0', action: 'create', name: 'solo', firstMember: 'worker', description: '单人团队' });
  });

  it('validates before sending: name required/format/duplicate, first member, 16-team limit', async () => {
    const api = mockApi();
    const store = createMembersStore(api);
    await store.load();
    store.openCreateTeam();
    await store.submitTeam();
    expect(store.getSnapshot().teamCreate.errors.name).toBe('请填写团队名');
    store.setTeamField('name', 'Bad Name');
    await store.submitTeam();
    expect(store.getSnapshot().teamCreate.errors.name).toContain('格式不合法');
    store.setTeamField('name', 'review');
    await store.submitTeam();
    expect(store.getSnapshot().teamCreate.errors.name).toBe("团队 'review' 已存在");
    store.setTeamField('name', 'ok');
    store.setTeamField('from', '');
    await store.submitTeam();
    expect(store.getSnapshot().teamCreate.errors.firstMember).toContain('至少');
    store.setTeamField('firstMember', 'captain');
    await store.submitTeam();
    expect(store.getSnapshot().teamCreate.errors.firstMember).toContain('保留');
    expect(api.createTeam).not.toHaveBeenCalled();

    const full = mockApi();
    full.getState.mockResolvedValue(state('standard-acp', { teamProfiles: Array.from({ length: 16 }, (_, i) => `t${i}`).concat() }));
    const fullStore = createMembersStore(full);
    await fullStore.load();
    fullStore.openCreateTeam();
    fullStore.setTeamField('name', 'x');
    await fullStore.submitTeam();
    expect(fullStore.getSnapshot().teamCreate.errors.name).toContain('最多 16 个');
  });

  it('a Host error stays in the dialog', async () => {
    const api = mockApi();
    api.createTeam.mockRejectedValue(Object.assign(new Error("团队 'x' 已存在"), { code: 'DUPLICATE' }));
    const store = createMembersStore(api);
    await store.load();
    store.openCreateTeam();
    store.setTeamField('name', 'x');
    await store.submitTeam();
    expect(store.getSnapshot()).toMatchObject({ teamCreate: { open: true }, error: "团队 'x' 已存在", loading: false });
  });
});

describe('delete team dialog (v2.7): type thinktwice to confirm', () => {
  it('opens for the viewed team; confirm stays blocked until the exact word is typed', async () => {
    const api = mockApi();
    api.getState.mockImplementation(async (p: string) => state(p));
    const store = createMembersStore(api);
    await store.setProfile('review');
    store.openDeleteTeam();
    expect(store.getSnapshot().teamDelete).toEqual({ name: 'review', confirm: '', error: null });

    for (const typed of ['', 'think', 'ThinkTwice', 'thinktwice ']) {
      store.setDeleteConfirm(typed);
      await store.submitDeleteTeam();
      expect(api.removeTeam, JSON.stringify(typed)).not.toHaveBeenCalled();
      expect(store.getSnapshot().teamDelete.error).toBe('请输入 thinktwice 以确认删除');
    }

    store.setDeleteConfirm('thinktwice');
    expect(store.getSnapshot().teamDelete.error).toBeNull();
    await store.submitDeleteTeam();
    expect(api.removeTeam).toHaveBeenCalledWith({ expectedRevision: 'r0', action: 'remove', name: 'review', confirm: 'thinktwice' }, 'review');
    expect(store.getSnapshot()).toMatchObject({
      teamDelete: { name: null },
      profile: 'standard-acp',
      teamProfiles: ['standard-acp'],
      revision: 'r3',
      notice: "已删除团队 'review'。新建会话后生效",
    });
  });

  it('the last team cannot be deleted (no dialog opens)', async () => {
    const api = mockApi();
    api.getState.mockResolvedValue(state('standard-acp', { teamProfiles: ['standard-acp'] }));
    const store = createMembersStore(api);
    await store.load();
    store.openDeleteTeam();
    expect(store.getSnapshot().teamDelete.name).toBeNull();
    expect(store.getSnapshot().error).toBe('至少需要保留一个团队 profile，不能删除最后一个团队');
  });

  it('a Host error stays in the dialog; cancel clears it', async () => {
    const api = mockApi();
    api.removeTeam.mockRejectedValue(Object.assign(new Error('至少需要保留一个团队 profile，不能删除最后一个团队'), { code: 'LAST_TEAM' }));
    const store = createMembersStore(api);
    await store.load();
    store.openDeleteTeam();
    store.setDeleteConfirm('thinktwice');
    await store.submitDeleteTeam();
    expect(store.getSnapshot()).toMatchObject({ teamDelete: { name: 'standard-acp' }, error: '至少需要保留一个团队 profile，不能删除最后一个团队', loading: false });
    store.closeDeleteTeam();
    expect(store.getSnapshot()).toMatchObject({ teamDelete: { name: null, confirm: '' }, error: null });
  });

  it('a stale revision refreshes and closes the dialog without deleting', async () => {
    const api = mockApi();
    api.removeTeam.mockRejectedValue(Object.assign(new Error('配置已被其他地方修改，请刷新后重试'), { code: 'STALE_REVISION' }));
    const store = createMembersStore(api);
    await store.load();
    store.openDeleteTeam();
    store.setDeleteConfirm('thinktwice');
    await store.submitDeleteTeam();
    expect(store.getSnapshot()).toMatchObject({ teamDelete: { name: null }, conflict: '配置已被其他地方修改，请刷新后重试' });
  });
});

describe('writing flag (v2.8): the team picker locks only for writes, not for plain switches', () => {
  it('a team switch is loading but not writing; a member write and its 409 refresh are writing', async () => {
    let answer: (v: StateResponse) => void = () => {};
    const api = mockApi();
    const store = createMembersStore(api);
    await store.load();
    api.getState.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const switching = store.setProfile('review');
    expect(store.getSnapshot()).toMatchObject({ loading: true, writing: false });
    answer(state('review'));
    await switching;
    expect(store.getSnapshot()).toMatchObject({ loading: false, writing: false, profile: 'review' });

    let reject: (e: unknown) => void = () => {};
    api.mutateMembers.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    let refreshed: (v: StateResponse) => void = () => {};
    api.getState.mockImplementationOnce(() => new Promise((r) => { refreshed = r; }));
    store.requestDelete('reviewer');
    const deleting = store.confirmDelete();
    expect(store.getSnapshot()).toMatchObject({ loading: true, writing: true });
    reject(Object.assign(new Error('配置已被其他地方修改，请刷新后重试'), { code: 'STALE_REVISION' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getSnapshot()).toMatchObject({ loading: true, writing: true });
    refreshed(state('review', { revision: 'r9' }));
    await deleting;
    expect(store.getSnapshot()).toMatchObject({ loading: false, writing: false, revision: 'r9' });
  });

  it('every write path clears writing when it ends, also on failure', async () => {
    const api = mockApi();
    api.createTeam.mockRejectedValue(new Error('boom'));
    const store = createMembersStore(api);
    await store.load();
    store.openCreateTeam();
    store.setTeamField('name', 'x');
    await store.submitTeam();
    expect(store.getSnapshot()).toMatchObject({ loading: false, writing: false, error: 'boom' });
  });
});
