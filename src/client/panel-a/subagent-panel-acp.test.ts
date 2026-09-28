/**
 * v2.3 Panel A store: ACP registrations and ACP + tool import/export, fed
 * with state built by the real Host readers from the sanitized real patch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listSubagents } from '../../host/subagent-manager';
import { resolveSubagentProviders } from '../../host/subagent-providers';
import { listAcps } from '../../host/acp-manager';
import { readCatalog } from '../../host/catalog';
import type { ApiClient } from '../shared/api-client';
import type { AcpRow, StateResponse } from '../shared/api-types';
import { createSubagentStore } from './subagent-panel-store';
import { acpFormFromRow, diffAcpPatch, parseEnv, validateAcpForm, emptyAcpForm } from './acp-form';

vi.mock('../shared/import-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/import-export')>()),
  downloadYaml: vi.fn(),
}));
import { downloadYaml, exportSubagentBundle } from '../shared/import-export';

const FIXTURE = readFileSync(resolve(__dirname, '../../../test/fixtures/real-web-cordis.patch.yml'), 'utf8');
const ACPS = listAcps(FIXTURE) as AcpRow[];

function state(overrides: Partial<StateResponse> = {}): StateResponse {
  return {
    revision: 'r0',
    catalog: readCatalog(FIXTURE),
    subagents: listSubagents(FIXTURE),
    subagentProviders: resolveSubagentProviders(FIXTURE, null),
    teamProfiles: ['standard-acp'],
    profile: 'standard-acp',
    members: [],
    acps: ACPS,
    dshProfile: { name: 'desktop', patchPath: '/p/desktop/cordis.patch.yml' },
    errors: {},
    diagnostics: { atomicWrite: { loaded: true }, catalogSource: 'runtime', hostApi: 2 },
    ...overrides,
  };
}

function mockApi(): ApiClient & Record<string, any> {
  return {
    getState: vi.fn(async () => state()),
    mutateSubagents: vi.fn(async () => ({ ...state({ revision: 'r1' }), notice: '已保存，新建会话后生效' })),
    mutateMembers: vi.fn(),
    mutateAcps: vi.fn(async () => ({ ...state({ revision: 'r1' }), notice: '已保存。ACP 变更需重启 DSH 后生效' })),
    importSubagentBundle: vi.fn(),
  };
}

function file(name: string, text: string): File {
  return { name, size: new TextEncoder().encode(text).length, text: async () => text } as unknown as File;
}

beforeEach(() => vi.mocked(downloadYaml).mockClear());

describe('acp-form helpers', () => {
  it('round-trips a real row through the form', () => {
    const kiro = ACPS.find((a) => a.id === 'subagent-acp-kiro')!;
    const form = acpFormFromRow(kiro);
    expect(form.args.split('\n')).toEqual(kiro.config.args);
    expect(diffAcpPatch(form, form)).toEqual({});
    expect(diffAcpPatch(form, { ...form, permission: 'reject', cwd: '/w' })).toEqual({ permission: 'reject', cwd: '/w' });
    expect(diffAcpPatch({ ...form, cwd: '/w' }, form)).toEqual({ cwd: null });
    const cc = acpFormFromRow(ACPS[0]);
    expect(cc.env).toBe('ANTHROPIC_MODEL=claude-opus-5\nCLAUDE_CODE_EFFORT_LEVEL=xhigh');
    expect(diffAcpPatch(cc, { ...cc, env: '' })).toEqual({ env: {} });
  });

  it('parses env lines and validates the form', () => {
    expect(parseEnv('A=1\n\n B = x=y ')).toEqual({ A: '1', B: ' x=y' });
    expect(parseEnv('novalue')).toContain('KEY=VALUE');
    expect(parseEnv('A=1\nA=2')).toContain('重复');
    const errors = validateAcpForm({ ...emptyAcpForm(), providerName: 'ccacp', env: '1BAD=x' }, 'create', ACPS);
    expect(errors).toEqual({ providerName: "ACP 'ccacp' 已存在", command: '请填写可执行文件路径', env: "变量名 '1BAD' 不合法" });
    expect(validateAcpForm({ ...emptyAcpForm(), providerName: 'fork', command: '/x' }, 'create', ACPS).providerName).toContain('内置');
  });
});

describe('SubagentPanelStore v2.3 ACP', () => {
  it('load exposes the ACP rows and the bound DSH profile; an old Host reports acpSupported=false', async () => {
    const store = createSubagentStore(mockApi());
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ acpSupported: true, dshProfile: { name: 'desktop' } });
    expect(store.getSnapshot().acps.map((a) => a.config.providerName)).toEqual(['ccacp', 'cursoracp', 'kiroopsuacp', 'kirogptacp']);

    const old = mockApi();
    old.getState.mockResolvedValue(state({ acps: undefined, dshProfile: undefined }));
    const oldStore = createSubagentStore(old);
    await oldStore.load();
    expect(oldStore.getSnapshot()).toMatchObject({ acpSupported: false, acps: [], dshProfile: null });
  });

  it('create sends the package config and adopts the new revision for the next subagent write', async () => {
    const api = mockApi();
    const store = createSubagentStore(api);
    await store.load();
    store.openCreateAcp();
    store.setAcpField('providerName', 'geminiacp');
    store.setAcpField('command', ' /opt/gemini ');
    store.setAcpField('args', '--experimental-acp\n');
    store.setAcpField('env', 'GEMINI_MODEL=g3');
    await store.submitAcp();
    expect(api.mutateAcps).toHaveBeenCalledWith({
      expectedRevision: 'r0',
      action: 'create',
      input: { providerName: 'geminiacp', command: '/opt/gemini', args: ['--experimental-acp'], permission: 'reject', env: { GEMINI_MODEL: 'g3' } },
    });
    expect(store.getSnapshot()).toMatchObject({ revision: 'r1', notice: '已保存。ACP 变更需重启 DSH 后生效', acpForm: { mode: null } });

    store.requestDelete('tool-subagent-tester');
    await store.confirmDelete();
    expect(api.mutateSubagents).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 'r1', action: 'remove' }));
  });

  it('edit sends only changed fields; an unchanged save sends nothing', async () => {
    const api = mockApi();
    const store = createSubagentStore(api);
    await store.load();
    store.openEditAcp('subagent-acp-cursor');
    await store.submitAcp();
    expect(api.mutateAcps).not.toHaveBeenCalled();
    expect(store.getSnapshot().notice).toBe('没有改动');

    store.openEditAcp('subagent-acp-cursor');
    store.setAcpField('permission', 'reject');
    await store.submitAcp();
    expect(api.mutateAcps).toHaveBeenCalledWith({ expectedRevision: 'r0', action: 'update', id: 'subagent-acp-cursor', patch: { permission: 'reject' } });
  });

  it('an ACP used by subagent tools cannot be deleted; an unused one can', async () => {
    const api = mockApi();
    const unused: AcpRow = { ...ACPS[0], id: 'subagent-acp-spare', config: { ...ACPS[0].config, providerName: 'spare' }, usedBy: [] };
    api.getState.mockResolvedValue(state({ acps: [...ACPS, unused] }));
    const store = createSubagentStore(api);
    await store.load();

    store.requestDeleteAcp('subagent-acp');
    expect(store.getSnapshot().acpConfirmDelete.id).toBeNull();
    expect(store.getSnapshot().error).toContain('仍被 subagent 工具使用');

    store.requestDeleteAcp('subagent-acp-spare');
    await store.confirmDeleteAcp();
    expect(api.mutateAcps).toHaveBeenCalledWith({ expectedRevision: 'r0', action: 'remove', id: 'subagent-acp-spare' });
  });

  it('STALE_REVISION on an ACP write refreshes state and closes the dialog', async () => {
    const api = mockApi();
    api.mutateAcps.mockRejectedValue(Object.assign(new Error('配置已被其他地方修改，请刷新后重试'), { code: 'STALE_REVISION' }));
    api.getState.mockResolvedValueOnce(state()).mockResolvedValueOnce(state({ revision: 'r9' }));
    const store = createSubagentStore(api);
    await store.load();
    store.openEditAcp('subagent-acp-cursor');
    store.setAcpField('command', '/new');
    await store.submitAcp();
    expect(store.getSnapshot()).toMatchObject({ revision: 'r9', conflict: '配置已被其他地方修改，请刷新后重试', acpForm: { mode: null } });
  });
});

describe('SubagentPanelStore v2.3 import / export', () => {
  it('exports ACPs and tools with a profile-named file', async () => {
    const store = createSubagentStore(mockApi());
    await store.load();
    store.exportConfig();
    const [name, text] = vi.mocked(downloadYaml).mock.calls[0];
    expect(name).toMatch(/^wuyou-subagents-desktop-\d{8}-\d{6}\.yaml$/);
    expect(text).toContain('providerName: kiroopsuacp');
    expect(text).toContain('toolName: subagent_coder');
    expect(store.getSnapshot().notice).toContain('分享前请检查');
  });

  it('import previews the file, sends only importable entries in one request, and reports the result', async () => {
    const api = mockApi();
    api.getState.mockResolvedValue(state({ acps: ACPS.slice(1), subagents: [] }));
    api.importSubagentBundle.mockResolvedValue({
      ...state({ revision: 'r2' }),
      notice: '已保存。ACP 变更需重启 DSH 后生效',
      importReport: { created: { acps: ['ccacp'], subagents: ['subagent_coder'] }, skipped: [] },
    });
    const store = createSubagentStore(api);
    await store.load();

    const exported = exportSubagentBundle(ACPS, listSubagents(FIXTURE).filter((r) => ['subagent_coder', 'subagent_acp'].includes(String(r.config.toolName))), 'web');
    await store.importConfig(file('web.yaml', exported));
    const preview = store.getSnapshot().importPreview!;
    expect(preview.sourceProfile).toBe('web');
    expect(preview.acps.map((p) => [p.item.providerName, p.skip ?? 'ok'])).toEqual([
      ['ccacp', 'ok'], ['cursoracp', "ACP 'cursoracp' 已存在"], ['kiroopsuacp', "ACP 'kiroopsuacp' 已存在"], ['kirogptacp', "ACP 'kirogptacp' 已存在"],
    ]);

    await store.confirmImport();
    const body = api.importSubagentBundle.mock.calls[0][0];
    expect(body.expectedRevision).toBe('r0');
    expect(body.bundle.acps.map((a: any) => a.providerName)).toEqual(['ccacp']);
    expect(body.bundle.subagents.map((s: any) => s.toolName).sort()).toEqual(['subagent_acp', 'subagent_coder']);
    expect(store.getSnapshot()).toMatchObject({ revision: 'r2', importPreview: null, error: null });
    expect(store.getSnapshot().notice).toContain('已导入 1 个 ACP、1 个 subagent 工具');
  });

  it('a broken or oversized file shows an error and opens no preview', async () => {
    const store = createSubagentStore(mockApi());
    await store.load();
    await store.importConfig(file('bad.yaml', 'not: [valid'));
    expect(store.getSnapshot()).toMatchObject({ importPreview: null });
    expect(store.getSnapshot().error).toContain('无法导入 bad.yaml：YAML 解析失败');

    await store.importConfig({ name: 'big.yaml', size: 2 * 1024 * 1024, text: async () => '' } as unknown as File);
    expect(store.getSnapshot().error).toContain('超过 1MB');
  });
});

describe('SubagentPanelStore v2.4 ACP test', () => {
  it('runs static checks first, handshake on request; never touches revision or loading', async () => {
    const api = mockApi();
    api.testAcp = vi.fn(async ({ id, handshake }: { id: string; handshake?: boolean }) => ({ id, providerName: 'cursoracp', ok: true, handshake: !!handshake, checks: [], durationMs: 1 }));
    const store = createSubagentStore(api);
    await store.load();
    await store.testAcp('subagent-acp-cursor');
    expect(store.getSnapshot().acpTest).toMatchObject({ id: 'subagent-acp-cursor', providerName: 'cursoracp', running: null, result: { handshake: false } });
    await store.runAcpHandshake();
    expect(api.testAcp).toHaveBeenLastCalledWith({ id: 'subagent-acp-cursor', handshake: true });
    expect(store.getSnapshot()).toMatchObject({ revision: 'r0', loading: false, acpTest: { result: { handshake: true } } });
    expect(api.mutateAcps).not.toHaveBeenCalled();
  });

  it('works while writes are unavailable (read-only test)', async () => {
    const api = mockApi();
    api.getState.mockResolvedValue(state({ diagnostics: { atomicWrite: { loaded: false }, catalogSource: 'runtime', hostApi: 2 } }));
    api.testAcp = vi.fn(async () => ({ id: 'subagent-acp', providerName: 'ccacp', ok: true, handshake: false, checks: [], durationMs: 1 }));
    const store = createSubagentStore(api);
    await store.load();
    await store.testAcp('subagent-acp');
    expect(store.getSnapshot().acpTest.result?.ok).toBe(true);
  });

  it('a result that arrives after the dialog closed is dropped', async () => {
    const api = mockApi();
    let answer: (v: unknown) => void = () => {};
    api.testAcp = vi.fn(() => new Promise((r) => { answer = r; }));
    const store = createSubagentStore(api);
    await store.load();
    const pending = store.testAcp('subagent-acp');
    expect(store.getSnapshot().acpTest.running).toBe('static');
    store.closeAcpTest();
    answer({ id: 'subagent-acp', providerName: 'ccacp', ok: true, handshake: false, checks: [], durationMs: 1 });
    await pending;
    expect(store.getSnapshot().acpTest).toMatchObject({ id: null, result: null });
  });
});
