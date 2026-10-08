/**
 * store.ts 用例清单。
 *
 * R2 增量（docs/specs/model-capabilities.r2.md 第 1.2、4#10、4#11、5 节）：
 * - 无草稿时的外部更新保持在详情页（keepView，只重置 menuIdx）；
 * - pi 成功、ds 冲突时用 #12 的文案；
 * - 保存成功后清 sel/undo；
 * - 空白失焦时删除键。
 *
 * fake port 仿照 DSH 真实行为：describe 返回 {status,writable,namespaces}；
 * mutate 不 throw，返回 {ok:true,value} 或 {ok:false,error:{code,details}}，
 * 成功时把 op 作用到 value 与 user 两层（等价于写入用户覆盖层），并让 revision 自增；
 * on 记录回调并返回 disposer。
 *
 * 约定（store 契约）：保存类失败文案写进 McSnapshot.saveError；
 * 冲突状态同时写进 ui.conflict（'hidden' | 'shown' | 'kept'）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createModelCapabilitiesStore } from './store';
import type { SettingsOp, SettingsOpSet, WizardDraft } from './types';
import { DS_ROUTE_ID, NS_DS, NS_PI } from './types';
import type { FakePort, FakePortOptions, NamespaceSlice } from './test-fixtures';
import {
  createFakePort,
  createFakeTester,
  createNonThenableTester,
  createThrowingTester,
  defaultCreds,
  dsSlice,
  MAIN_MAP,
  piSlice,
  sliceWithExtraProvider,
  sliceWithModels,
  type FakeTester,
} from './test-fixtures';

/** pi 提供方级 4 个默认键（R2 起它们真实存在于用户配置上，但不进草稿、不产生 op）。 */
const DEFAULT_KEYS_PI = ['defaultInput', 'reasoning', 'defaultContextWindow', 'defaultMaxTokens'] as const;

/** ds 的 2 个默认键 + models，改成输入用的模型表。 */
function dsWithModels(models: Array<Record<string, unknown>>, revision = 11): NamespaceSlice {
  const slice = dsSlice(revision);
  return { ...slice, value: { ...slice.value, models } };
}

function setup(over: FakePortOptions = {}) {
  const fake = createFakePort({ pi: piSlice(7), ds: dsSlice(11), creds: defaultCreds(), ...over });
  const store = createModelCapabilitiesStore(fake.port);
  return { fake, store };
}

function paths(ops: SettingsOp[]): string[] {
  return ops.map((op) => op.path.join('.'));
}

async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 造出「pi 与 ds 各有待写入」的草稿：改一个 pi 模型名，改 DS 的一个容量。
 * 保存顺序固定为先 pi 后 ds，所以能让 pi 成功、ds 失败。
 */
async function dirtyBothSides(over: FakePortOptions = {}) {
  const result = setup(over);
  await result.store.load();
  result.store.enter('gpt-gateway');
  result.store.openModel(0);
  result.store.setModelName('Renamed');
  result.store.enter(DS_ROUTE_ID);
  result.store.openModel(0);
  result.store.setCap('cw', '2000000');
  return result;
}

describe('store.load', () => {
  it('Given describe 返回 pi 与 ds When load Then 列表数据来自 value，6 个默认键不进草稿、不产出 op', async () => {
    const fake = createFakePort({ pi: piSlice(7), ds: dsSlice(11), creds: defaultCreds() });
    const store = createModelCapabilitiesStore(fake.port);
    await store.load();

    const snap = store.getSnapshot();
    expect(snap.ui.loading).toBe(false);
    expect(snap.loadError).toBeNull();
    expect(snap.hasPi).toBe(true);
    expect(snap.hasDs).toBe(true);
    expect(snap.ui.readonly).toBe(false);
    expect(snap.defaultModel).toBeNull();

    // 顺序：pi 保持 value 里的原序，DeepSeek 永远最后
    expect(Object.keys(snap.draft.providers)).toEqual(['gpt-gateway', 'cc-gateway', DS_ROUTE_ID]);
    // ds 的 user 只有 2 个默认键 → 模型只能来自 value
    expect(snap.draft.providers[DS_ROUTE_ID].models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(snap.draft.providers[DS_ROUTE_ID].thinking).toBe('enabled');
    // 6 个默认键既不在草稿字段里，也不在 extra 里
    for (const key of DEFAULT_KEYS_PI) {
      const provider = snap.draft.providers['gpt-gateway'] as unknown as Record<string, unknown>;
      expect(provider[key], `gpt-gateway.${key}`).toBeUndefined();
      expect(snap.draft.providers['gpt-gateway'].extra[key], `gpt-gateway.extra.${key}`).toBeUndefined();
    }
    for (const key of ['defaultContextWindow', 'maxTokens'] as const) {
      const provider = snap.draft.providers[DS_ROUTE_ID] as unknown as Record<string, unknown>;
      expect(provider[key], `deepseek.${key}`).toBeUndefined();
      expect(snap.draft.providers[DS_ROUTE_ID].extra[key], `deepseek.extra.${key}`).toBeUndefined();
    }

    expect(snap.revision.pi).toBe(7);
    expect(snap.revision.ds).toBe(11);
    expect(snap.ops.pi).toEqual([]);
    expect(snap.ops.ds).toEqual([]);
    expect(snap.ops.dirty).toBe(0);
    expect(snap.errors).toEqual({});
    expect(fake.describe).toHaveBeenCalled();
  });

  it('Given 已加载 When 触发一次变更 Then getSnapshot 返回新对象（snapshot 不可变）', async () => {
    const { store } = setup();
    await store.load();
    const first = store.getSnapshot();
    store.enter('gpt-gateway');
    expect(store.getSnapshot()).not.toBe(first);
    expect(first.ui.view).toBe('list');
    expect(store.getSnapshot().ui.view).toBe('detail');
    expect(store.getSnapshot().ui.route).toBe('gpt-gateway');
  });
});

describe('store.save', () => {
  it('Given 改了 pi 模型名 When save Then 用加载时的 revision 调 mutate，成功后 revision/dirty/saved 更新', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    const before = store.getSnapshot();
    expect(before.ops.dirty).toBe(1);
    expect(paths(before.ops.pi)).toEqual(['providers.gpt-gateway.models']);

    await store.save();

    expect(fake.mutate).toHaveBeenCalledTimes(1);
    const [ns, ops, rev] = fake.mutate.mock.calls[0];
    expect(ns).toBe(NS_PI);
    expect(rev).toBe(7);
    expect(paths(ops)).toEqual(['providers.gpt-gateway.models']);
    const written = (ops[0].op === 'set' ? ops[0].value : []) as Array<Record<string, unknown>>;
    expect(written).toHaveLength(4);
    expect(written[0].name).toBe('Renamed');

    const after = store.getSnapshot();
    expect(after.revision.pi).toBe(8);
    expect(after.ops.dirty).toBe(0);
    expect(after.ui.saved).toBe(true);
    expect(after.ui.saving).toBe(false);
    expect(after.saveError).toBeNull();
  });

  it('Given pi 成功、ds 返回 settings/conflict When save Then 用 #12 的文案且不写凭证', async () => {
    const { fake, store } = await dirtyBothSides({
      fail: (ns) => (ns === NS_DS ? { code: 'settings/conflict' } : null),
    });

    const before = store.getSnapshot();
    expect(paths(before.ops.pi)).toEqual(['providers.gpt-gateway.models']);
    // DS 只有 models 一张表，容量改动表现为整表 set（契约 1.3：setCap 只写当前模型）
    expect(paths(before.ops.ds)).toEqual(['models']);

    await store.save();

    expect(fake.mutate).toHaveBeenCalledTimes(2);
    expect(fake.mutate.mock.calls[0][0]).toBe(NS_PI);
    expect(fake.mutate.mock.calls[0][2]).toBe(7);
    expect(fake.mutate.mock.calls[1][0]).toBe(NS_DS);
    expect(fake.mutate.mock.calls[1][2]).toBe(11);
    expect(fake.credSet).not.toHaveBeenCalled();

    const snap = store.getSnapshot();
    expect(snap.revision.pi).toBe(8);
    expect(snap.revision.ds).toBe(11);
    expect(snap.ops.pi).toEqual([]);
    expect(paths(snap.ops.ds)).toEqual(['models']);
    expect(snap.draft.providers[DS_ROUTE_ID].models[0].contextWindow).toBe('2000000');
    expect(snap.ui.conflict).toBe('shown');
    // #12 的逐字文案
    expect(snap.saveError).toBe('这份配置刚刚被别处改过。llm-pi-ai 已写入。llm-deepseek 这次没写入。你的修改还在。');
    expect(snap.ui.status).toBe('');
  });

  it('Given pi 成功、ds 返回其它错误 When save Then #12 第二种文案带 remoteErrorText', async () => {
    const { store } = await dirtyBothSides({ fail: (ns) => (ns === NS_DS ? { code: 'settings/rejected' } : null) });
    await store.save();

    const snap = store.getSnapshot();
    expect(snap.saveError).toBe('配置被拒绝。llm-pi-ai 已写入。llm-deepseek 这次没写入。你的修改还在。');
    expect(snap.ui.status).toBe('');
  });

  it('Given pi 成功、ds 冲突，保存后清空 sel 与 undo（#10）', async () => {
    const { store } = await dirtyBothSides({ fail: (ns) => (ns === NS_DS ? { code: 'settings/conflict' } : null) });
    await store.save();

    const ui = store.getSnapshot().ui;
    expect(ui.sel).toEqual({});
    expect(ui.undo).toBeNull();
  });

  it('Given 只改 pi 且保存成功 When 看 ui Then sel 与 undo 都被清空（#10）', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.selectIndex(0, true);
    store.deleteModel(2);
    expect(store.getSnapshot().ui.undo).not.toBeNull();
    expect(store.getSnapshot().ui.sel['gpt-gateway']).toEqual([0]);

    store.openModel(0);
    store.setModelName('Renamed');
    await store.save();

    const ui = store.getSnapshot().ui;
    expect(ui.saved).toBe(true);
    expect(ui.sel).toEqual({});
    expect(ui.undo).toBeNull();
  });

  it('Given settings/rejected 且 details=schema When save Then saveError 含「配置被拒绝」与 schema', async () => {
    const { store } = setup({ ds: null, fail: () => ({ code: 'settings/rejected', details: 'schema' }) });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    await store.save();

    const snap = store.getSnapshot();
    expect(snap.saveError).toContain('配置被拒绝');
    expect(snap.saveError).toContain('schema');
    expect(snap.ops.dirty).toBeGreaterThan(0);
    expect(snap.ui.conflict).toBe('hidden');
  });

  it('Given gateway/bad-request When save Then saveError 含「请求无效」', async () => {
    const { store } = setup({ ds: null, fail: () => ({ code: 'gateway/bad-request' }) });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    await store.save();
    expect(store.getSnapshot().saveError).toContain('请求无效');
  });

  it('Given settings 成功但 credentials.set 被拒 When save Then revision 更新、密钥保留，再次 save 只重试 set', async () => {
    let setCalls = 0;
    const fake = createFakePort({
      pi: piSlice(7),
      ds: null,
      creds: defaultCreds(),
      credSet: () => {
        setCalls += 1;
        return setCalls === 1 ? { ok: false, error: { code: 'credential/rejected' } } : { ok: true };
      },
    });
    const store = createModelCapabilitiesStore(fake.port);
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    store.openAccess();
    store.setSecret('k9-topsecret');

    await store.save();

    expect(fake.mutate).toHaveBeenCalledTimes(1);
    expect(fake.credSet).toHaveBeenCalledTimes(1);
    const after = store.getSnapshot();
    expect(after.revision.pi).toBe(8);
    expect(after.saveError).toContain('凭证被拒绝。环境变量可能已被占用。');
    expect(after.ops.cred).toEqual([{ op: 'set', ref: 'GPT_GATEWAY_API_KEY' }]);
    expect(after.ops.dirty).toBeGreaterThan(0);

    await store.save();

    expect(fake.mutate).toHaveBeenCalledTimes(1);
    expect(fake.credSet).toHaveBeenCalledTimes(2);
    const done = store.getSnapshot();
    expect(done.ops.dirty).toBe(0);
    expect(done.saveError).toBeNull();
    expect(done.ui.saved).toBe(true);
  });

  it('Given 删除提供方 When save Then 先带 revision unset [providers,id]，成功后再 credentials.unset', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('cc-gateway');
    store.askDeleteProvider();
    expect(store.getSnapshot().ui.dialog).toMatchObject({ type: 'delete', route: 'cc-gateway' });
    store.setDeleteConfirm('cc-gateway');
    store.confirmDialog();

    const before = store.getSnapshot();
    expect(before.draft.providers['cc-gateway']).toBeUndefined();
    expect(paths(before.ops.pi)).toEqual(['providers.cc-gateway']);
    expect(before.ops.pi[0].op).toBe('unset');

    await store.save();

    expect(fake.mutate).toHaveBeenCalledTimes(1);
    const [ns, ops, rev] = fake.mutate.mock.calls[0];
    expect(ns).toBe(NS_PI);
    expect(rev).toBe(7);
    expect(ops).toEqual([{ op: 'unset', path: ['providers', 'cc-gateway'] }]);
    expect(fake.credUnset).toHaveBeenCalledWith('CC_GATEWAY_API_KEY');
    expect(fake.mutate.mock.invocationCallOrder[0]).toBeLessThan(fake.credUnset.mock.invocationCallOrder[0]);
    expect(store.getSnapshot().ops.dirty).toBe(0);
  });

  it('Given credentials.unset 失败 When save Then 提示「提供方已删除，凭证未移除。」', async () => {
    const { fake, store } = setup({
      credUnset: () => ({ ok: false, error: { code: 'credential/rejected' } }),
    });
    await store.load();
    store.enter('cc-gateway');
    store.askDeleteProvider();
    store.setDeleteConfirm('cc-gateway');
    store.confirmDialog();
    await store.save();

    expect(fake.mutate).toHaveBeenCalledTimes(1);
    const snap = store.getSnapshot();
    expect(snap.revision.pi).toBe(8);
    expect(snap.saveError).toContain('提供方已删除，凭证未移除。');
  });

  it('Given 已进入冲突 When 再次 save Then 不调用 mutate；keepConflict 后横幅改为「解除冲突前保存会失败」', async () => {
    const fake = createFakePort({ pi: piSlice(7), ds: null, creds: defaultCreds(), fail: () => ({ code: 'settings/conflict' }) });
    const store = createModelCapabilitiesStore(fake.port);
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    await store.save();
    expect(fake.mutate).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().ui.conflict).toBe('shown');

    await store.save();
    expect(fake.mutate).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().ui.conflict).toBe('shown');

    store.keepConflict();
    const kept = store.getSnapshot();
    expect(kept.ui.conflict).toBe('kept');
    expect(kept.saveError).toContain('草稿还在，但解除冲突前保存会失败。');

    await store.save();
    expect(fake.mutate).toHaveBeenCalledTimes(1);
  });
});

describe('store 只读', () => {
  const cases: Array<[string, () => FakePort]> = [
    ['hostLoopback=false', () => createFakePort({ pi: piSlice(7), creds: defaultCreds(), hostLoopback: false })],
    ['describe.status=unavailable', () => createFakePort({ pi: piSlice(7), creds: defaultCreds(), describeStatus: 'unavailable' })],
    ['describe.writable=false', () => createFakePort({ pi: piSlice(7), creds: defaultCreds(), describeWritable: false })],
    ['ns mode=memory', () => createFakePort({ pi: { ...piSlice(7), mode: 'memory' }, creds: defaultCreds() })],
  ];

  it.each(cases)('Given %s When load 后 save Then 只读且不调用 mutate', async (_label, makePort) => {
    const fake = makePort();
    const store = createModelCapabilitiesStore(fake.port);
    await store.load();
    expect(store.getSnapshot().ui.readonly).toBe(true);

    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    await store.save();
    expect(fake.mutate).not.toHaveBeenCalled();
  });
});

describe('store 外部事件', () => {
  it('Given 没有草稿 When document-updated Then 静默重建且不显示横幅', async () => {
    const { fake, store } = setup();
    await store.load();
    fake.setSlice(NS_PI, sliceWithExtraProvider(piSlice(9), 9));
    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(store.getSnapshot().draft.providers['extra-gateway']).toBeDefined();
    });
    const snap = store.getSnapshot();
    expect(snap.ui.conflict).toBe('hidden');
    expect(snap.saveError).toBeNull();
    expect(snap.revision.pi).toBe(9);
  });

  it('Given 停在详情页、没有草稿 When document-updated Then 保持详情页（#11 keepView）', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    expect(store.getSnapshot().ui.view).toBe('detail');

    fake.setSlice(NS_PI, sliceWithExtraProvider(piSlice(9), 9));
    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(store.getSnapshot().revision.pi).toBe(9);
    });
    const snap = store.getSnapshot();
    expect(snap.ui.view).toBe('detail');
    expect(snap.ui.route).toBe('gpt-gateway');
    expect(snap.ui.menuIdx).toBeNull();
    expect(snap.ui.conflict).toBe('hidden');
    expect(snap.saveError).toBeNull();
  });

  it('Given 有草稿 When document-updated Then 显示横幅且草稿不动', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Local');

    fake.setSlice(NS_PI, sliceWithExtraProvider(piSlice(9), 9));
    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(store.getSnapshot().ui.conflict).toBe('shown');
    });
    const snap = store.getSnapshot();
    expect(snap.draft.providers['gpt-gateway'].models[0].name).toBe('Local');
    expect(Object.keys(snap.draft.providers)).toEqual(['gpt-gateway', 'cc-gateway', DS_ROUTE_ID]);
    expect(snap.saveError).toContain('这次没写入。你的修改还在。');
  });

  it('Given 自己的写入回声 When document-updated 带着记下的 revision Then 不显示横幅', async () => {
    const { fake, store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    await store.save();
    expect(store.getSnapshot().revision.pi).toBe(8);

    fake.emit('settings/document-updated', NS_PI, 8);
    await tick();

    const snap = store.getSnapshot();
    expect(snap.ui.conflict).toBe('hidden');
    expect(snap.saveError).toBeNull();
    expect(snap.draft.providers['gpt-gateway'].models[0].name).toBe('Renamed');
  });

  it('Given 有草稿 When llm/adapters-updated Then 显示冲突横幅', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Local');

    fake.emit('llm/adapters-updated');
    await vi.waitFor(() => {
      expect(store.getSnapshot().ui.conflict).toBe('shown');
    });
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[0].name).toBe('Local');
  });

  it('Given cc-gateway 起初未配置凭证 When credentials/reference-updated Then 只刷新状态点，不重建草稿', async () => {
    const { fake, store } = setup();
    await store.load();
    expect(store.getSnapshot().draft.providers['cc-gateway'].credConfigured).toBe(false);

    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Local');

    fake.setCred('CC_GATEWAY_API_KEY', { configured: true, writable: true });
    fake.emit('credentials/reference-updated', 'CC_GATEWAY_API_KEY');

    await vi.waitFor(() => {
      expect(store.getSnapshot().draft.providers['cc-gateway'].credConfigured).toBe(true);
    });
    const snap = store.getSnapshot();
    expect(snap.draft.providers['gpt-gateway'].models[0].name).toBe('Local');
    expect(snap.ui.conflict).toBe('hidden');
    expect(snap.ops.dirty).toBe(1);
  });

  it('Given load 之后 When dispose Then 四类事件的 disposer 全部被调用', async () => {
    const { fake, store } = setup();
    await store.load();

    const events = fake.on.mock.calls.map((call) => call[0]);
    expect(new Set(events)).toEqual(
      new Set(['settings/document-updated', 'credentials/reference-updated', 'llm/adapters-updated', 'connection/reset']),
    );
    expect(fake.disposers.length).toBe(fake.on.mock.calls.length);

    store.dispose();
    for (const disposer of fake.disposers) expect(disposer).toHaveBeenCalled();
  });
});

describe('store keepView（#11）', () => {
  it('Given 开着一层与批量层、没有草稿 When document-updated Then 层与批量层都保留', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.openBulk();

    fake.setSlice(NS_PI, sliceWithExtraProvider(piSlice(9), 9));
    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(store.getSnapshot().revision.pi).toBe(9);
    });
    const snap = store.getSnapshot();
    expect(snap.ui.view).toBe('detail');
    expect(snap.ui.route).toBe('gpt-gateway');
    expect(snap.ui.edit).toEqual({ kind: 'model', route: 'gpt-gateway', idx: 0 });
    expect(snap.ui.bulk).not.toBeNull();
  });

  it('Given 没有草稿 When document-updated 让 route 消失 Then 回到列表并关掉所有层', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('cc-gateway');
    store.openModel(0);
    store.openMenu(1);
    expect(store.getSnapshot().ui.menuIdx).toBe(1);

    const value = { ...piSlice(9).value, providers: { 'gpt-gateway': { api: 'openai-responses', models: [] } } };
    const user = { ...piSlice(9).user, providers: { 'gpt-gateway': { api: 'openai-responses', models: [] } } };
    fake.setSlice(NS_PI, { ...piSlice(9), value, user });
    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(store.getSnapshot().ui.view).toBe('list');
    });
    const snap = store.getSnapshot();
    expect(snap.ui.route).toBeNull();
    expect(snap.ui.edit).toBeNull();
    expect(snap.ui.bulk).toBeNull();
    expect(snap.ui.menuIdx).toBeNull();
    expect(snap.draft.providers['cc-gateway']).toBeUndefined();
  });

  it('Given 编辑层打开的模型 id 被外部改掉 When document-updated Then 关层但留在详情页', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[0].id).toBe('gpt-6-astra');

    const renamed = { id: 'gpt-6-astra-v2', name: 'Renamed', contextWindow: 272000, maxTokens: 128000, reasoningEfforts: { ...MAIN_MAP } };
    const models = [
      renamed,
      { id: 'gpt-6-sol', contextWindow: 272000, maxTokens: 128000 },
      { id: 'gpt-6-terra', contextWindow: 272000, maxTokens: 128000 },
      { id: 'gpt-6-luna', contextWindow: 272000, maxTokens: 128000 },
    ];
    fake.setSlice(NS_PI, sliceWithModels(piSlice(9), 'gpt-gateway', models, 9));
    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(store.getSnapshot().ui.edit).toBeNull();
    });
    const snap = store.getSnapshot();
    expect(snap.ui.view).toBe('detail');
    expect(snap.ui.route).toBe('gpt-gateway');
    expect(snap.draft.providers['gpt-gateway'].models[0].id).toBe('gpt-6-astra-v2');
  });

  it('Given 编辑层的下标越界 When document-updated Then 关层、丢弃越界 sel，undo 也清空', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('cc-gateway');
    store.selectIndex(2, true);
    store.openModel(2);

    fake.setSlice(NS_PI, sliceWithModels(piSlice(9), 'cc-gateway', [{ id: 'only-one', contextWindow: 128000, maxTokens: 64000 }], 9));
    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(store.getSnapshot().ui.edit).toBeNull();
    });
    const snap = store.getSnapshot();
    expect(snap.ui.view).toBe('detail');
    expect(snap.ui.sel['cc-gateway']).toEqual([]);
    expect(snap.ui.undo).toBeNull();
  });

  it('Given 向导与勾选都在 When document-updated Then 向导、sel、showAdv 都保留', async () => {
    const { fake, store } = setup();
    await store.load();
    store.toggleAdv('m:gpt-gateway:0');
    store.enter('gpt-gateway');
    store.selectIndex(1, true);
    store.openAddProvider();
    expect(store.getSnapshot().ui.wizard).not.toBeNull();

    fake.setSlice(NS_PI, sliceWithExtraProvider(piSlice(9), 9));
    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(store.getSnapshot().revision.pi).toBe(9);
    });
    const snap = store.getSnapshot();
    expect(snap.ui.view).toBe('wizard');
    expect(snap.ui.wizard).not.toBeNull();
    expect(snap.ui.showAdv['m:gpt-gateway:0']).toBe(true);
    expect(snap.draft.providers['gpt-gateway']).toBeDefined();
  });
});

describe('store 密钥与批量层', () => {
  it('Given 输入密钥 sk When 读取 snapshot Then 密钥不出现在 JSON.stringify(getSnapshot()) 中', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openAccess();
    store.setSecret('sk');

    const snap = store.getSnapshot();
    expect(snap.ops.cred).toEqual([{ op: 'set', ref: 'GPT_GATEWAY_API_KEY' }]);
    expect(JSON.stringify(snap)).not.toContain('sk');
  });

  it('Given 保存成功 When 批量层还开着 Then 关掉批量层', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openBulk();
    store.patchBulk({ scope: 'all', mt: 'set', mtRaw: '64000' });
    store.applyBulk();
    expect(store.getSnapshot().ops.dirty).toBeGreaterThan(0);

    store.openBulk();
    expect(store.getSnapshot().ui.bulk).not.toBeNull();
    await store.save();
    expect(store.getSnapshot().ui.bulk).toBeNull();
  });

  it('Given openBulk 记下快照 When 之后清空勾选 Then scope 保持 sel，批量应用仍只改快照里的模型，且 menuIdx 归零', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.selectIndex(0, true);
    store.openMenu(2);
    expect(store.getSnapshot().ui.menuIdx).toBe(2);
    store.openBulk();
    expect(store.getSnapshot().ui.menuIdx).toBeNull();

    store.selectClear();

    const b = store.getSnapshot().ui.bulk;
    expect(b?.selSnapshot).toEqual([0]);
    expect(b?.scope).toBe('sel');

    store.patchBulk({ th: 'off' });
    store.applyBulk();

    const models = store.getSnapshot().draft.providers['gpt-gateway'].models;
    expect(models[0].reasoningEfforts).toBe(false);
    expect(models[1].reasoningEfforts).toEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    });
    expect(store.getSnapshot().ops.dirty).toBe(1);
  });
});

describe('store 输入与容量（R2 签名）', () => {
  it('Given 打开模型层、pi 模型没有 input When toggleInput(model,text) Then 写成 [text]', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(1);

    store.toggleInput('model', 'text');
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[1].input).toEqual(['text']);
  });

  it('Given pi 模型只有 input=[text] When 再点 text Then 不修改并给出 inputHint', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.clearInput();
    store.toggleInput('model', 'text');
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[0].input).toEqual(['text']);

    store.toggleInput('model', 'text');
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[0].input).toEqual(['text']);
    expect(store.getSnapshot().ui.inputHint).toEqual({ key: 'model', text: '至少保留一种输入类型' });
  });

  it('Given pi 模型有旧字段 When clearInput Then 只删 input，旧字段不动', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('cc-gateway');
    store.openModel(0);
    expect(store.getSnapshot().draft.providers['cc-gateway'].models[0].inputModalities).toEqual(['text', 'image']);

    store.toggleInput('model', 'text');
    store.clearInput();

    const model = store.getSnapshot().draft.providers['cc-gateway'].models[0];
    expect(model.input).toBeUndefined();
    expect(model.inputModalities).toEqual(['text', 'image']);
  });

  it('Given DeepSeek 模型 When toggleInput/clearInput Then 读写 inputModalities', async () => {
    const { store } = setup({ ds: dsWithModels([{ id: 'deepseek-flash' }]) });
    await store.load();
    store.enter(DS_ROUTE_ID);
    store.openModel(0);

    store.toggleInput('model', 'image');
    expect(store.getSnapshot().draft.providers[DS_ROUTE_ID].models[0].inputModalities).toEqual(['image']);

    store.clearInput();
    expect(store.getSnapshot().draft.providers[DS_ROUTE_ID].models[0].inputModalities).toBeUndefined();
  });

  it('Given 模型层打开 When setCap 填 128K 再 blurCap Then 写成 128000', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setCap('cw', '128K');

    store.blurCap('cw');
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[0].contextWindow).toBe('128000');
  });

  it('Given 容量键刷成空白 When blurCap Then 删除该键', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[0].contextWindow).toBe('272000');

    store.setCap('cw', '');
    store.blurCap('cw');
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[0].contextWindow).toBeUndefined();
  });

  it('Given 容量格式非法 When blurCap Then 保留原文', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setCap('mt', 'nope');
    store.blurCap('mt');
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[0].maxTokens).toBe('nope');
  });

  it('Given capClear(cw) When 看草稿 Then 只有 cw 被删，mt 还在', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.capClear('cw');

    const model = store.getSnapshot().draft.providers['gpt-gateway'].models[0];
    expect(model.contextWindow).toBeUndefined();
    expect(model.maxTokens).toBe('128000');
  });

  it('Given 没有打开的模型层 When toggleInput/capClear Then 什么都不改', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    const before = JSON.stringify(store.getSnapshot().draft);
    store.toggleInput('model', 'image');
    store.clearInput();
    store.capClear('cw');
    store.setCap('cw', '999');
    store.blurCap('cw');
    expect(JSON.stringify(store.getSnapshot().draft)).toBe(before);
  });

  it('Given railToggle 的未知 key When 调用 Then 直接返回', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    const before = JSON.stringify(store.getSnapshot().draft);
    store.railToggle('r:gpt-gateway:detail', 'high');
    store.railToggle('wiz', 'high');
    expect(JSON.stringify(store.getSnapshot().draft)).toBe(before);
  });
});

/* ==========================================================================
 * R3 W1a：模型能力导入导出（docs/specs/r3-io-and-move.md 第 1.3、1.4、1.8 节）
 *
 * downloadYaml 是唯一会碰 DOM 的依赖，这里 mock 掉它，其余导出（readImportFile、
 * MAX_IMPORT_BYTES、exportTimestamp）保持真实，好让「超过 1MB」走真逻辑。
 * 导入用 {name,size,text} 形状的对象，不引入 jsdom。
 * ========================================================================== */
vi.mock('../shared/import-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/import-export')>()),
  downloadYaml: vi.fn(),
}));
import { downloadYaml } from '../shared/import-export';

const R3_KIND = 'wuyou-model-capabilities';

/** 合法文件：一个已存在的提供方（conflict）、一个新提供方（new）、一个非法 ID（invalid）。 */
const R3_FILE = [
  `kind: ${R3_KIND}`,
  'version: 1',
  'providers:',
  '  gpt-gateway:',
  '    api: anthropic-messages',
  '    displayName: 文件里的 GPT',
  '    models:',
  '      - id: gpt-6-astra',
  '        name: Astra from file',
  '        reasoningEfforts: false',
  '  brand-new:',
  '    api: openai-completions',
  '    displayName: Brand New',
  '    models:',
  '      - id: gpt-6-nova',
  '        name: Nova',
  '  Bad_Id:',
  '    api: openai-completions',
  '    models:',
  '      - id: bad',
  '',
].join('\n');

function r3File(name: string, content: string = R3_FILE, size: number = content.length) {
  const text = vi.fn(async () => content);
  return { file: { name, size, text }, text };
}

beforeEach(() => vi.mocked(downloadYaml).mockClear());

describe('store.exportConfig（1.3）', () => {
  it('Given 草稿改了模型名 When exportConfig Then 下载的内容来自 base，status 以「只导出已保存的配置」开头', async () => {
    const { store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    expect(store.getSnapshot().ops.dirty).toBeGreaterThan(0);

    store.exportConfig();

    expect(vi.mocked(downloadYaml)).toHaveBeenCalledTimes(1);
    const [name, text] = vi.mocked(downloadYaml).mock.calls[0];
    expect(name).toMatch(/^wuyou-models-\d{8}-\d{6}\.yaml$/);
    expect(text).toContain(`kind: ${R3_KIND}`);
    expect(text).toContain('id: gpt-6-astra');
    expect(text).not.toContain('Renamed');
    expect(text).not.toContain('deepseek-official');
    expect(text.split('\n')[1]).toContain('导出时间');

    const status = store.getSnapshot().ui.status;
    expect(status.startsWith('只导出已保存的配置')).toBe(true);
    expect(status).toContain('文件不含密钥和请求头；baseURL 和 apiKeyEnv 属于接入信息，分享前请检查');
  });

  it('Given 干净状态 When exportConfig Then status 是契约原文', async () => {
    const { store } = setup();
    await store.load();

    store.exportConfig();

    expect(vi.mocked(downloadYaml)).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().ui.status).toBe(
      '已导出。文件不含密钥和请求头；baseURL 和 apiKeyEnv 属于接入信息，分享前请检查',
    );
  });

  it('Given 只读 When exportConfig Then 仍然下载；importConfig 不读文件', async () => {
    const { store } = setup({ describeWritable: false });
    await store.load();
    expect(store.getSnapshot().ui.readonly).toBe(true);

    store.exportConfig();
    expect(vi.mocked(downloadYaml)).toHaveBeenCalledTimes(1);

    const { file, text } = r3File('a.yaml');
    await store.importConfig(file);
    expect(text).not.toHaveBeenCalled();
    expect(store.getSnapshot().ui.importPreview).toBeNull();
  });
});

describe('store.importConfig（1.4、1.8）', () => {
  it('Given 草稿是 dirty When importConfig Then 不读文件；放弃草稿之后才读', async () => {
    const { store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    const blocked = r3File('a.yaml');
    await store.importConfig(blocked.file);
    expect(blocked.text).not.toHaveBeenCalled();
    expect(store.getSnapshot().ui.importPreview).toBeNull();

    // 对照组：同一个文件在干净状态下会被读（否则上面的断言可能只是别的原因挡住了 importConfig）
    store.discard();
    const allowed = r3File('a.yaml');
    await store.importConfig(allowed.file);
    expect(allowed.text).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().ui.importPreview).not.toBeNull();
  });

  it('Given conflict 为 shown When importConfig Then 不读文件；reload 之后才读', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    fake.emit('settings/document-updated', NS_PI, 99);
    expect(store.getSnapshot().ui.conflict).toBe('shown');

    const blocked = r3File('a.yaml');
    await store.importConfig(blocked.file);
    expect(blocked.text).not.toHaveBeenCalled();
    expect(store.getSnapshot().ui.importPreview).toBeNull();

    await store.reload();
    expect(store.getSnapshot().ui.conflict).toBe('hidden');
    const allowed = r3File('a.yaml');
    await store.importConfig(allowed.file);
    expect(allowed.text).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().ui.importPreview).not.toBeNull();
  });

  it('Given 文件超过 1MB When importConfig Then saveError 是「无法导入 <名>：文件超过 1MB 上限」', async () => {
    const { store } = setup();
    await store.load();

    const { file, text } = r3File('a.yaml', R3_FILE, 2 * 1024 * 1024);
    await store.importConfig(file);

    expect(store.getSnapshot().saveError).toBe('无法导入 a.yaml：文件超过 1MB 上限');
    expect(store.getSnapshot().ui.importPreview).toBeNull();
    expect(text, '超过上限就不读内容').not.toHaveBeenCalled();
  });

  it('Given 合法文件 When importConfig Then 只填 importPreview，selected 是 checked 的 id，草稿不变', async () => {
    const { store } = setup();
    await store.load();
    const before = JSON.stringify(store.getSnapshot().draft);

    const { file, text } = r3File('models.yaml');
    await store.importConfig(file);

    expect(text).toHaveBeenCalledTimes(1);
    const preview = store.getSnapshot().ui.importPreview;
    expect(preview).not.toBeNull();
    expect(preview!.fileName).toBe('models.yaml');
    expect(preview!.items.map((item) => item.kind)).toEqual(['conflict', 'new', 'invalid']);
    expect(preview!.selected).toEqual(['brand-new']);
    expect(preview!.warning).toContain('文件不应包含密钥或请求头');
    expect(JSON.stringify(store.getSnapshot().draft)).toBe(before);
  });

  it('Given 预览打开 When setImportChecked / confirmImport Then 草稿按勾选合并，dirty>0，status 正确且不调用 mutate', async () => {
    const { fake, store } = setup();
    await store.load();
    const { file } = r3File('models.yaml');
    await store.importConfig(file);

    store.setImportChecked('gpt-gateway', true);
    expect([...store.getSnapshot().ui.importPreview!.selected].sort()).toEqual(['brand-new', 'gpt-gateway']);
    // invalid 的 id 不处理
    store.setImportChecked('Bad_Id', true);
    expect([...store.getSnapshot().ui.importPreview!.selected].sort()).toEqual(['brand-new', 'gpt-gateway']);
    store.setImportChecked('brand-new', false);
    expect(store.getSnapshot().ui.importPreview!.selected).toEqual(['gpt-gateway']);
    store.setImportChecked('brand-new', true);

    store.confirmImport();

    const snap = store.getSnapshot();
    expect(snap.ui.importPreview).toBeNull();
    expect(snap.ui.status).toBe('已导入到草稿，尚未保存。请预览变更后保存。');
    expect(snap.ops.dirty).toBeGreaterThan(0);
    expect(snap.draft.providers['brand-new']).toBeDefined();
    expect(snap.draft.providers['brand-new'].models.map((m) => m.id)).toEqual(['gpt-6-nova']);
    expect(snap.draft.providers['gpt-gateway'].api).toBe('anthropic-messages');
    expect(snap.draft.providers['gpt-gateway'].displayName).toBe('文件里的 GPT');
    expect(snap.draft.providers['gpt-gateway'].models.map((m) => m.id)).toEqual(['gpt-6-astra']);
    expect(snap.draft.providers['gpt-gateway'].models[0].name).toBe('Astra from file');
    expect(snap.draft.providers['gpt-gateway'].baseURL).toBe('https://magic-api.up.railway.app/v1');
    expect(snap.draft.providers['gpt-gateway'].apiKeyEnv).toBe('GPT_GATEWAY_API_KEY');
    expect(fake.mutate, '导入只改草稿').not.toHaveBeenCalled();
  });

  it('Given 预览打开 When cancelImport Then 只关对话框，草稿不变', async () => {
    const { store } = setup();
    await store.load();
    const before = JSON.stringify(store.getSnapshot().draft);
    const { file } = r3File('models.yaml');
    await store.importConfig(file);
    expect(store.getSnapshot().ui.importPreview).not.toBeNull();

    store.cancelImport();

    expect(store.getSnapshot().ui.importPreview).toBeNull();
    expect(JSON.stringify(store.getSnapshot().draft)).toBe(before);
  });

  it('Given 预览打开 When discard 或 reload Then importPreview 被清空', async () => {
    const discarded = setup();
    await discarded.store.load();
    await discarded.store.importConfig(r3File('models.yaml').file);
    expect(discarded.store.getSnapshot().ui.importPreview).not.toBeNull();
    discarded.store.discard();
    expect(discarded.store.getSnapshot().ui.importPreview).toBeNull();

    const reloaded = setup();
    await reloaded.store.load();
    await reloaded.store.importConfig(r3File('models.yaml').file);
    expect(reloaded.store.getSnapshot().ui.importPreview).not.toBeNull();
    await reloaded.store.reload();
    expect(reloaded.store.getSnapshot().ui.importPreview).toBeNull();
  });
});

/* ==========================================================================
 * R4b 流空闲超时（docs/specs/r4b-stream-idle-timeout.md 第 6.5、7 节）：S1–S7。
 *
 * 只追加用例，不动 store.ts。4 个新方法还不存在，用 timeoutApi() 包一层：
 * 缺失时抛出可读的错误，保证失败只落在这些新增用例里。
 * ========================================================================== */

const T_KEY = 'streamIdleTimeoutMs';

interface TimeoutApi {
  setTimeoutText(route: string, text: string): void;
  blurTimeout(route: string): void;
  setTimeoutPreset(route: string, ms: number): void;
  resetTimeout(route: string): void;
}

function timeoutApi(store: ReturnType<typeof createModelCapabilitiesStore>): TimeoutApi {
  const raw = store as unknown as Record<string, unknown>;
  for (const name of ['setTimeoutText', 'blurTimeout', 'setTimeoutPreset', 'resetTimeout']) {
    if (typeof raw[name] !== 'function') throw new Error(`store.${name} 还没有实现（R4b 红灯）`);
  }
  return raw as unknown as TimeoutApi;
}

function timeoutOf(p: ProviderDraft): unknown {
  return (p as unknown as Record<string, unknown>)[T_KEY];
}

function timeoutTextOf(p: ProviderDraft): unknown {
  return (p as unknown as Record<string, unknown>).timeoutText;
}

function routeFieldErrors(route: string, errors: Record<string, { route: Record<string, unknown> }>): unknown {
  return errors[route]?.route?.[T_KEY];
}

describe('R4b S1 load', () => {
  it('S1 新 fixture load → gpt/cc 草稿 1800000、DS undefined、extra 无键、dirty=0', async () => {
    const { store } = setup();
    await store.load();
    const snap = store.getSnapshot();

    expect(timeoutOf(snap.draft.providers['gpt-gateway'])).toBe(1800000);
    expect(timeoutOf(snap.draft.providers['cc-gateway'])).toBe(1800000);
    expect(timeoutOf(snap.draft.providers[DS_ROUTE_ID])).toBeUndefined();
    for (const id of ['gpt-gateway', 'cc-gateway', DS_ROUTE_ID]) {
      expect(snap.draft.providers[id].extra, `${id}.extra`).not.toHaveProperty(T_KEY);
    }
    expect(snap.ops.pi).toEqual([]);
    expect(snap.ops.ds).toEqual([]);
    expect(snap.ops.dirty).toBe(0);
  });
});

describe('R4b S2 输入与 blur', () => {
  it('S2 setTimeoutText(gpt,60) → 一条 set 3600000；blurTimeout → 删原文、留 3600000', async () => {
    const { store } = setup();
    await store.load();
    const api = timeoutApi(store);

    api.setTimeoutText('gpt-gateway', '60');
    const typed = store.getSnapshot();
    expect(typed.ops.pi).toEqual([
      { op: 'set', path: ['providers', 'gpt-gateway', 'streamIdleTimeoutMs'], value: 3600000 },
    ]);
    expect(timeoutTextOf(typed.draft.providers['gpt-gateway'])).toBe('60');
    expect(typed.ops.dirty).toBe(1);

    api.blurTimeout('gpt-gateway');
    const blurred = store.getSnapshot();
    expect(timeoutTextOf(blurred.draft.providers['gpt-gateway'])).toBeUndefined();
    expect(timeoutOf(blurred.draft.providers['gpt-gateway'])).toBe(3600000);
  });
});

describe('R4b S3 错误阻止保存', () => {
  it('S3 timeoutText=abc → errors 有该键；save 不调 mutate，status 是「请先修正标红字段。」', async () => {
    const { fake, store } = setup();
    await store.load();
    timeoutApi(store).setTimeoutText('gpt-gateway', 'abc');

    const snap = store.getSnapshot();
    expect(routeFieldErrors('gpt-gateway', snap.errors)).toBe('请输入分钟数，例如 30 或 0.5');
    expect(timeoutTextOf(snap.draft.providers['gpt-gateway'])).toBe('abc');

    await store.save();
    expect(fake.mutate).not.toHaveBeenCalled();
    expect(store.getSnapshot().ui.status).toBe('请先修正标红字段。');
  });
});

describe('R4b S4 预设与重置', () => {
  it('S4 预设 DS 1800000 + save → mutate(llm-deepseek, [set 1800000], 11)；resetTimeout(gpt) → unset', async () => {
    const { fake, store } = setup();
    await store.load();
    const api = timeoutApi(store);

    api.setTimeoutText(DS_ROUTE_ID, '15');
    api.setTimeoutPreset(DS_ROUTE_ID, 1800000);
    expect(timeoutTextOf(store.getSnapshot().draft.providers[DS_ROUTE_ID])).toBeUndefined();
    expect(timeoutOf(store.getSnapshot().draft.providers[DS_ROUTE_ID])).toBe(1800000);

    await store.save();
    expect(fake.mutate).toHaveBeenCalledTimes(1);
    const [ns, ops, rev] = fake.mutate.mock.calls[0];
    expect(ns).toBe(NS_DS);
    expect(rev).toBe(11);
    expect(ops).toEqual([{ op: 'set', path: ['streamIdleTimeoutMs'], value: 1800000 }]);
    expect(store.getSnapshot().ops.dirty).toBe(0);

    api.resetTimeout('gpt-gateway');
    expect(store.getSnapshot().ops.pi).toEqual([
      { op: 'unset', path: ['providers', 'gpt-gateway', 'streamIdleTimeoutMs'] },
    ]);
  });
});

describe('R4b S5 只读 / 保存中：4 个方法都是 no-op', () => {
  const readonlyCases: Array<[string, FakePortOptions]> = [
    ['hostLoopback=false', { hostLoopback: false }],
    ['describe.status=unavailable', { describeStatus: 'unavailable' }],
    ['describe.writable=false', { describeWritable: false }],
    ['ns mode=memory', { pi: { ...piSlice(7), mode: 'memory' } }],
  ];

  it.each(readonlyCases)('S5 %s → 四个方法不改草稿、不产 op', async (_label, over) => {
    const { store } = setup(over);
    await store.load();
    expect(store.getSnapshot().ui.readonly).toBe(true);

    const before = JSON.stringify(store.getSnapshot());
    const api = timeoutApi(store);
    api.setTimeoutText('gpt-gateway', '60');
    api.blurTimeout('gpt-gateway');
    api.setTimeoutPreset('gpt-gateway', 3600000);
    api.resetTimeout('gpt-gateway');
    api.setTimeoutText(DS_ROUTE_ID, '15');
    expect(JSON.stringify(store.getSnapshot())).toBe(before);
  });

  it('S5 ui.saving=true → 四个方法同样 no-op', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    const original = fake.mutate.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fake.mutate.mockImplementation(async (ns, ops, rev) => {
      await gate;
      return original(ns, ops, rev);
    });

    const saving = store.save();
    expect(store.getSnapshot().ui.saving).toBe(true);
    const before = JSON.stringify(store.getSnapshot());

    const api = timeoutApi(store);
    api.setTimeoutText('gpt-gateway', '60');
    api.blurTimeout('gpt-gateway');
    api.setTimeoutPreset('gpt-gateway', 3600000);
    api.resetTimeout('gpt-gateway');
    expect(JSON.stringify(store.getSnapshot())).toBe(before);

    release();
    await saving;
  });
});

describe('R4b S6 向导第 2 步', () => {
  async function openWizard() {
    const { fake, store } = setup({ ds: null });
    await store.load();
    store.openAddProvider();
    store.wizardPatch({ api: 'openai-completions', id: 'fresh-gateway', ack: true, models: ['fresh-model'] });
    const patch = (p: Record<string, unknown>) => store.wizardPatch(p as unknown as Partial<WizardDraft>);
    return { fake, store, patch };
  }

  it('S6 默认 finish → 新建对象里是 1800000', async () => {
    const { store } = await openWizard();
    store.wizardFinish();

    const op = store.getSnapshot().ops.pi[0];
    expect(op.op).toBe('set');
    expect(((op as SettingsOpSet).value as Record<string, unknown>)[T_KEY]).toBe(1800000);
  });

  it('S6 timeoutText 清空 → 新建对象里没有这个键', async () => {
    const { store, patch } = await openWizard();
    patch({ timeoutText: '' });
    store.wizardFinish();

    const op = store.getSnapshot().ops.pi[0];
    expect(op.op).toBe('set');
    expect(Object.keys((op as SettingsOpSet).value as Record<string, unknown>)).not.toContain(T_KEY);
  });

  it('S6 timeoutText=0 → wizardNext 停在 2，wizardFinish 不建提供方', async () => {
    const { store, patch } = await openWizard();
    store.wizardNext();
    expect(store.getSnapshot().ui.wizard?.step).toBe(2);

    patch({ timeoutText: '0' });
    store.wizardNext();
    expect(store.getSnapshot().ui.wizard?.step).toBe(2);
    expect(store.getSnapshot().ui.wizard?.tried2).toBe(true);

    store.wizardFinish();
    expect(store.getSnapshot().draft.providers['fresh-gateway']).toBeUndefined();
    expect(store.getSnapshot().ops.pi).toEqual([]);
  });
});

describe('R4b S7 discard 与凭证无关', () => {
  it('S7 改后 discard → 恢复 1800000、dirty=0', async () => {
    const { store } = setup();
    await store.load();
    const api = timeoutApi(store);

    api.setTimeoutText('gpt-gateway', '60');
    api.blurTimeout('gpt-gateway');
    expect(store.getSnapshot().ops.dirty).toBe(1);

    store.discard();
    const snap = store.getSnapshot();
    expect(timeoutOf(snap.draft.providers['gpt-gateway'])).toBe(1800000);
    expect(timeoutTextOf(snap.draft.providers['gpt-gateway'])).toBeUndefined();
    expect(snap.ops.dirty).toBe(0);
  });

  it('S7 credWritable=false 仍可改，且不产生 cred op', async () => {
    const { store } = setup({ creds: { ...defaultCreds(), GPT_GATEWAY_API_KEY: { configured: true, writable: false } } });
    await store.load();
    expect(store.getSnapshot().draft.providers['gpt-gateway'].credWritable).toBe(false);

    const api = timeoutApi(store);
    api.setTimeoutText('gpt-gateway', '60');
    api.blurTimeout('gpt-gateway');

    const snap = store.getSnapshot();
    expect(timeoutOf(snap.draft.providers['gpt-gateway'])).toBe(3600000);
    expect(snap.ops.cred).toEqual([]);
  });
});

/* ==========================================================================
 * R4a 模型可用性测试（docs/specs/r4a-model-test.md §2.2、§2.3、§4 节）：S01–S16。
 *
 * 只追加用例，不动 store.ts 与 r4b 的段落。方法还不存在，所以用 testApi() 包一层：
 * 缺失时抛出可读的错误，保证失败只落在本段的新增用例里；`snap.test` 由 testState() 取。
 * tester 由 test-fixtures 的 createFakeTester() 提供：每次调用返回可手动 resolve/reject
 * 的 deferred，并记录 req 与 signal。
 * ========================================================================== */

interface TestEntryLike {
  state: string;
  result?: Record<string, unknown>;
  at?: number;
  startedAt?: number;
  prev?: TestEntryLike;
}

interface TestBatchLike {
  route: string;
  keys: string[];
  label: string;
  stopped: boolean;
  done: boolean;
  startedAt: number;
  endedAt?: number;
}

interface McTestStateLike {
  hostUnsupported: boolean;
  results: Record<string, TestEntryLike>;
  batches: Record<string, TestBatchLike>;
  open: string | null;
  cost: { route: string; modelIds: string[]; label: string } | null;
  skipCost: boolean;
  blocked: Record<string, string | null>;
  live: string;
}

type TestableStore = ReturnType<typeof createModelCapabilitiesStore>;

/** 契约 §2.2：createModelCapabilitiesStore(port, { tester })。第二个参数现在还不被接受。 */
const createTestStore = createModelCapabilitiesStore as unknown as (
  port: unknown,
  options?: { tester?: unknown },
) => TestableStore;

interface TestApi {
  testModel(route: string, modelId: string): void;
  testProvider(route: string): void;
  retryFailed(route: string): void;
  retryCancelled(route: string): void;
  stopBatch(route: string): void;
  dismissBatch(route: string): void;
  toggleTestDetail(route: string, modelId: string): void;
  confirmCost(skip: boolean): void;
  cancelCost(): void;
  copyTestDetail(route: string, modelId: string): string;
}

const TEST_API_NAMES = [
  'testModel',
  'testProvider',
  'retryFailed',
  'retryCancelled',
  'stopBatch',
  'dismissBatch',
  'toggleTestDetail',
  'confirmCost',
  'cancelCost',
  'copyTestDetail',
] as const;

function testApi(store: TestableStore): TestApi {
  const raw = store as unknown as Record<string, unknown>;
  for (const name of TEST_API_NAMES) {
    if (typeof raw[name] !== 'function') throw new Error(`store.${name} 还没有实现（R4a 红灯）`);
  }
  return raw as unknown as TestApi;
}

function testState(store: TestableStore): McTestStateLike {
  const snap = store.getSnapshot() as unknown as { test?: McTestStateLike };
  if (!snap.test) throw new Error('snapshot.test 还没有实现（R4a 红灯）');
  return snap.test;
}

function testerSetup(over: FakePortOptions = {}, tester: FakeTester = createFakeTester()) {
  const fake = createFakePort({ pi: piSlice(7), ds: dsSlice(11), creds: defaultCreds(), ...over });
  const store = createTestStore(fake.port, { tester: tester.fn });
  return { fake, store, tester };
}

function modelEntry(id: string): Record<string, unknown> {
  return { id, name: id, contextWindow: 272000, maxTokens: 128000, inputModalities: ['text'], reasoningEfforts: { ...MAIN_MAP } };
}

/** pi 的 gpt-gateway 换成一串 m1…mN（S02/S04 用的 5 个模型等）。 */
function piWithModels(ids: string[]): NamespaceSlice {
  return sliceWithModels(piSlice(7), 'gpt-gateway', ids.map(modelEntry));
}

const M5 = ['m1', 'm2', 'm3', 'm4', 'm5'];
const key = (id: string): string => `gpt-gateway|${id}`;

/**
 * 5 个模型的批量：testProvider → 确认费用 → 3 running + 2 queued。
 * `skipCost` 传 true 时顺带勾上「本次会话不再提示」，后面的重试就不会再弹确认（S04/S05）。
 */
async function startBatch5(skipCost = false) {
  const setup = testerSetup({ pi: piWithModels(M5) });
  await setup.store.load();
  const api = testApi(setup.store);
  api.testProvider('gpt-gateway');
  api.confirmCost(skipCost);
  return { ...setup, api };
}

describe('R4a S01 无 tester', () => {
  it('S01 不注入 tester → snap.test 不存在，旧行为不变', async () => {
    const { store } = setup();
    await store.load();

    const snap = store.getSnapshot() as unknown as { test?: unknown };
    expect(snap.test).toBeUndefined();
    expect(store.getSnapshot().ui.loading).toBe(false);
    expect(store.getSnapshot().loadError).toBeNull();
  });
});

describe('R4a S02 批量与费用确认', () => {
  it('S02 testProvider 5 个模型且凭证已配 → cost 打开、tester 0 次；confirmCost(false) → 3 次、2 个 queued', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(M5) });
    await store.load();
    const api = testApi(store);

    api.testProvider('gpt-gateway');
    const opened = testState(store);
    expect(opened.cost).toEqual({ route: 'gpt-gateway', modelIds: M5, label: '全部模型' });
    expect(opened.blocked['gpt-gateway']).toBeNull();
    expect(tester.count()).toBe(0);

    api.confirmCost(false);
    const snap = testState(store);
    expect(snap.cost).toBeNull();
    expect(tester.count()).toBe(3);
    expect(tester.calls.map((c) => c.req)).toEqual([
      { provider: 'gpt-gateway', model: 'm1' },
      { provider: 'gpt-gateway', model: 'm2' },
      { provider: 'gpt-gateway', model: 'm3' },
    ]);
    expect(snap.results[key('m1')].state).toBe('running');
    expect(snap.results[key('m2')].state).toBe('running');
    expect(snap.results[key('m3')].state).toBe('running');
    expect(snap.results[key('m4')].state).toBe('queued');
    expect(snap.results[key('m5')].state).toBe('queued');
    expect(snap.batches['gpt-gateway']).toMatchObject({
      route: 'gpt-gateway',
      keys: M5.map(key),
      label: '全部模型',
      stopped: false,
      done: false,
    });
  });
});

describe('R4a S03 逐条返回', () => {
  it('S03 resolve 第 1 个 → 第 4 个开始，结果 ok，live 含「可用，耗时」', async () => {
    const { store, tester } = await startBatch5();

    tester.call(0).resolve();
    await tick();

    expect(tester.count()).toBe(4);
    expect(tester.call(3).req).toEqual({ provider: 'gpt-gateway', model: 'm4' });

    const snap = testState(store);
    expect(snap.results[key('m1')].state).toBe('ok');
    expect(snap.results[key('m1')].result).toMatchObject({ ok: true, latencyMs: 812, firstTokenMs: 341 });
    expect(snap.results[key('m4')].state).toBe('running');
    expect(snap.live).toContain('可用，耗时');
  });
});

describe('R4a S04 停止与重试已取消', () => {
  it('S04 stopBatch → 2 个 queued 变 cancelled、running 仍回写；done 后 retryCancelled 只入 2 个', async () => {
    const { store, tester } = await startBatch5(true);
    const api = testApi(store);

    api.stopBatch('gpt-gateway');
    let snap = testState(store);
    expect(snap.results[key('m4')].state).toBe('cancelled');
    expect(snap.results[key('m5')].state).toBe('cancelled');
    expect(snap.batches['gpt-gateway'].stopped).toBe(true);
    expect(snap.batches['gpt-gateway'].done).toBe(false);
    expect(snap.results[key('m1')].state).toBe('running');
    expect(snap.live).toBe('已取消 2 个未开始的测试，3 个已发出的请求会等它返回。');

    for (const call of tester.calls.slice(0, 3)) call.resolve();
    await tick();

    snap = testState(store);
    expect(snap.batches['gpt-gateway'].done).toBe(true);
    expect(snap.results[key('m1')].state).toBe('ok');
    expect(snap.results[key('m2')].state).toBe('ok');
    expect(snap.results[key('m3')].state).toBe('ok');

    const before = tester.count();
    api.retryCancelled('gpt-gateway');
    expect(tester.count()).toBe(before + 2);
    expect(tester.calls.slice(before).map((c) => c.req.model)).toEqual(['m4', 'm5']);
    expect(testState(store).batches['gpt-gateway'].label).toBe('已取消的模型');
  });
});

describe('R4a S05 重试失败项', () => {
  it('S05 transient/fail 混合 → retryFailed 只含这两个，标签「重试失败项」', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(['m1', 'm2', 'm3']) });
    await store.load();
    const api = testApi(store);
    api.testProvider('gpt-gateway');
    api.confirmCost(true); // 不再提示费用，retryFailed 直接入队（S05 只关心键与标签）

    tester.call(0).resolve();
    tester.call(1).reject(Object.assign(new Error('bad request'), { status: 400, code: 'INVALID_REQUEST' }));
    tester.call(2).reject(Object.assign(new Error('busy'), { status: 409, code: 'BUSY' }));
    await tick();

    const snap = testState(store);
    expect(snap.results[key('m1')].state).toBe('ok');
    expect(snap.results[key('m2')].state).toBe('fail');
    expect(snap.results[key('m3')].state).toBe('transient');
    expect(snap.batches['gpt-gateway'].done).toBe(true);

    const before = tester.count();
    api.retryFailed('gpt-gateway');
    expect(tester.calls.slice(before).map((c) => c.req.model)).toEqual(['m2', 'm3']);
    const retried = testState(store);
    expect(retried.batches['gpt-gateway'].label).toBe('重试失败项');
    expect(retried.batches['gpt-gateway'].keys).toEqual([key('m2'), key('m3')]);
  });
});

describe('R4a S06 单个测试插队首', () => {
  it('S06 active 满 3 时新键插队首，且不进批量统计', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(M5) });
    await store.load();
    const api = testApi(store);

    api.testModel('gpt-gateway', 'm1');
    api.testModel('gpt-gateway', 'm2');
    api.testModel('gpt-gateway', 'm3');
    api.testModel('gpt-gateway', 'm4');
    api.testModel('gpt-gateway', 'm5');

    expect(tester.count()).toBe(3);
    expect(testState(store).batches).toEqual({});
    expect(testState(store).results[key('m4')].state).toBe('queued');
    expect(testState(store).results[key('m5')].state).toBe('queued');

    tester.call(0).resolve();
    await tick();

    expect(tester.count()).toBe(4);
    expect(tester.call(3).req.model).toBe('m5');
    expect(testState(store).batches).toEqual({});
  });
});

describe('R4a S07 门控', () => {
  it('S07 新建未保存的提供方 → 不调 tester，status 为「先保存再测试：这个提供方还没保存。」', async () => {
    const { store, tester } = testerSetup();
    await store.load();
    store.openAddProvider();
    store.wizardPatch({ api: 'openai-completions', id: 'fresh-gateway', ack: true, models: ['fresh-model'] });
    store.wizardFinish();

    testApi(store).testModel('fresh-gateway', 'fresh-model');
    expect(tester.count()).toBe(0);
    expect(store.getSnapshot().ui.status).toBe('先保存再测试：这个提供方还没保存。');
    expect(testState(store).blocked['fresh-gateway']).toBe('先保存再测试：这个提供方还没保存');
  });

  it('S07 dirtySet 含路由 → 不调 tester，status 为「先保存再测试：Host 还不知道这个提供方的未保存改动。」', async () => {
    const { store, tester } = testerSetup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    testApi(store).testModel('gpt-gateway', 'gpt-6-luna');
    expect(tester.count()).toBe(0);
    expect(store.getSnapshot().ui.status).toBe('先保存再测试：Host 还不知道这个提供方的未保存改动。');
  });

  it('S07 setSecret 后 pendingCred → 不调 tester，status 为「先保存再测试：API Key 还没保存。」', async () => {
    const { store, tester } = testerSetup();
    await store.load();
    store.enter('gpt-gateway');
    store.openAccess();
    store.setSecret('sk-new-secret');

    testApi(store).testModel('gpt-gateway', 'gpt-6-luna');
    expect(tester.count()).toBe(0);
    expect(store.getSnapshot().ui.status).toBe('先保存再测试：API Key 还没保存。');
  });

  it('S07 保存中 → 不调 tester，status 为「正在保存，稍后再测。」', async () => {
    const { fake, store, tester } = testerSetup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    const original = fake.mutate.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fake.mutate.mockImplementation(async (ns, ops, rev) => {
      await gate;
      return original(ns, ops, rev);
    });

    const saving = store.save();
    expect(store.getSnapshot().ui.saving).toBe(true);
    testApi(store).testModel('gpt-gateway', 'gpt-6-luna');
    expect(tester.count()).toBe(0);
    expect(store.getSnapshot().ui.status).toBe('正在保存，稍后再测。');

    release();
    await saving;
  });
});

describe('R4a S08 旧 Host（HOST_UNSUPPORTED）', () => {
  it('S08 404 HOST_UNSUPPORTED → hostUnsupported true、其余 signal aborted、queued 还原、批次清空、再测被拒', async () => {
    const { store, tester } = await startBatch5();
    const api = testApi(store);

    tester.call(0).reject(Object.assign(new Error('当前 Host 不支持模型测试，重启 DSH 后可用'), {
      code: 'HOST_UNSUPPORTED',
      status: 404,
    }));
    await tick();

    const snap = testState(store);
    expect(snap.hostUnsupported).toBe(true);
    expect(snap.batches).toEqual({});
    expect(snap.cost).toBeNull();
    expect(Object.keys(snap.results)).toEqual([]);
    // 其余在途请求被 abort（发出去的那个已经 reject，不再要求）。
    expect(tester.call(1).signal.aborted).toBe(true);
    expect(tester.call(2).signal.aborted).toBe(true);
    expect(store.getSnapshot().ui.status).toBe('当前 Host 不支持模型测试，重启 DSH 后可用');

    const before = tester.count();
    api.testModel('gpt-gateway', 'm1');
    expect(tester.count()).toBe(before);
    expect(store.getSnapshot().ui.status).toBe('当前 Host 不支持模型测试，重启 DSH 后可用。');
  });
});

describe('R4a S09–S11 清空规则', () => {
  it('S09 迟到回包：入队后 reload，再 resolve 旧 deferred → results 为空', async () => {
    const { store, tester } = await startBatch5();
    const stale = tester.call(0);

    await store.reload();
    expect(Object.keys(testState(store).results)).toEqual([]);

    stale.resolve();
    await tick();
    expect(Object.keys(testState(store).results)).toEqual([]);
  });

  it('S10 save 成功后清空、skipCost 保留，状态文案仍是「已保存。」', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(M5) });
    await store.load();
    const api = testApi(store);
    api.testProvider('gpt-gateway');
    api.confirmCost(true);
    expect(tester.count()).toBe(3);
    expect(testState(store).skipCost).toBe(true);

    tester.call(0).resolve();
    await tick();
    expect(Object.keys(testState(store).results).length).toBeGreaterThan(0);

    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    await store.save();

    const snap = testState(store);
    expect(snap.results).toEqual({});
    expect(snap.batches).toEqual({});
    expect(snap.hostUnsupported).toBe(false);
    expect(snap.skipCost).toBe(true);
    expect(store.getSnapshot().ui.status).toBe('已保存。');
  });

  it('S11 discard 不清空结果', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(M5) });
    await store.load();
    testApi(store).testModel('gpt-gateway', 'm1');
    tester.call(0).resolve();
    await tick();
    expect(testState(store).results[key('m1')].state).toBe('ok');

    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    store.discard();

    expect(testState(store).results[key('m1')].state).toBe('ok');
  });
});

describe('R4a S12–S14 何时弹费用确认', () => {
  it('S12 confirmCost(true) 后再次批量不弹确认', async () => {
    const { store, tester } = await startBatch5(true);
    const api = testApi(store);

    tester.calls.slice(0, 3).forEach((call) => call.resolve());
    await tick();
    tester.calls.slice(3, 5).forEach((call) => call.resolve());
    await tick();
    expect(testState(store).batches['gpt-gateway'].done).toBe(true);

    const before = tester.count();
    api.testProvider('gpt-gateway');
    expect(testState(store).skipCost).toBe(true);
    expect(testState(store).cost).toBeNull();
    expect(tester.count()).toBe(before + 3);
  });

  it('S13 所有目标 credConfigured false → 不弹确认直接入队', async () => {
    const { store, tester } = testerSetup();
    await store.load();
    expect(store.getSnapshot().draft.providers['cc-gateway'].credConfigured).toBe(false);

    testApi(store).testProvider('cc-gateway');
    expect(testState(store).cost).toBeNull();
    expect(tester.count()).toBe(3);
    expect(tester.calls.map((c) => c.req.provider)).toEqual(['cc-gateway', 'cc-gateway', 'cc-gateway']);
  });

  it('S14 单个模型批量不弹确认', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(['m1']) });
    await store.load();

    testApi(store).testProvider('gpt-gateway');
    expect(testState(store).cost).toBeNull();
    expect(tester.count()).toBe(1);
  });
});

describe('R4a S15 错误映射', () => {
  it('S15 409 BUSY → transient、errorKind BUSY', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(['m1']) });
    await store.load();
    testApi(store).testModel('gpt-gateway', 'm1');

    tester.call(0).reject(Object.assign(new Error('模型 m1 正在测试，请稍候'), { status: 409, code: 'BUSY' }));
    await tick();

    const entry = testState(store).results[key('m1')];
    expect(entry.state).toBe('transient');
    expect(entry.result).toMatchObject({ ok: false, transient: true, errorKind: 'BUSY', status: 409, finish: null });
  });

  it('S15 无 status 的 TypeError → HOST_UNREACHABLE transient', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(['m1']) });
    await store.load();
    testApi(store).testModel('gpt-gateway', 'm1');

    tester.call(0).reject(new TypeError('Failed to fetch'));
    await tick();

    const entry = testState(store).results[key('m1')];
    expect(entry.state).toBe('transient');
    expect(entry.result).toMatchObject({ ok: false, transient: true, errorKind: 'HOST_UNREACHABLE' });
  });
});

describe('R4a S16 详情开关与 dispose', () => {
  it('S16 toggleTestDetail 两次回 null、backToList 置 null、无 result 的键不生效', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(M5) });
    await store.load();
    const api = testApi(store);
    api.testModel('gpt-gateway', 'm1');
    tester.call(0).resolve();
    await tick();

    expect(testState(store).open).toBeNull();
    api.toggleTestDetail('gpt-gateway', 'm2');
    expect(testState(store).open).toBeNull();

    api.toggleTestDetail('gpt-gateway', 'm1');
    expect(testState(store).open).toBe(key('m1'));
    api.toggleTestDetail('gpt-gateway', 'm1');
    expect(testState(store).open).toBeNull();

    api.toggleTestDetail('gpt-gateway', 'm1');
    store.backToList();
    expect(testState(store).open).toBeNull();
  });

  it('S16 copyTestDetail 返回详情文本并写 status', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(M5) });
    await store.load();
    const api = testApi(store);
    api.testModel('gpt-gateway', 'm1');
    tester.call(0).resolve();
    await tick();

    const detail = api.copyTestDetail('gpt-gateway', 'm1');
    expect(JSON.parse(detail)).toMatchObject({ model: 'm1', provider: 'gpt-gateway', ok: true, latencyMs: 812 });
    expect(store.getSnapshot().ui.status).toBe('已复制 m1 的测试详情（不含密钥）。');
  });

  it('S16 dispose → abort 全部在途信号', async () => {
    const { store, tester } = await startBatch5();
    const inFlight = tester.calls.slice(0, 3).map((call) => call.signal);

    store.dispose();

    for (const signal of inFlight) expect(signal.aborted).toBe(true);
  });
});

/* ==========================================================================
 * R4a 返工轮（F2、F3）：异常 tester 的兜底与 dispose 之后的 publish。
 *
 * 期望行为（orchestrator 决定，见审查 F2/F3）：
 * - tester 同步抛错、或返回非 thenable 时，active 不许泄漏：条目落到终态 fail、
 *   errorKind HOST_ERROR、非 transient，后续 job 照常开始（并发槽归还）；
 * - 只有 fetch 网络失败（TypeError 且无 status）才映射 HOST_UNREACHABLE，由既有 S15 守住；
 * - dispose 之后 stopBatch / toggleTestDetail / copyTestDetail 不得再通知 subscribe 监听器。
 * ========================================================================== */

describe('R4a S17–S20 返工轮：异常 tester 与 dispose 之后不再 publish', () => {
  it('S17 tester 同步抛错 → 终态 fail、HOST_ERROR 非 transient，队列继续推进', async () => {
    const tester = createThrowingTester(new Error('boom'));
    const { store } = testerSetup({ pi: piWithModels(M5) }, tester);
    await store.load();
    const api = testApi(store);

    for (const id of M5) api.testModel('gpt-gateway', id);
    await tick();

    for (const id of M5) {
      const entry = testState(store).results[key(id)];
      expect(entry?.state, `${id} 应落到终态 fail（不是 running/transient）`).toBe('fail');
      expect(entry?.result).toMatchObject({ ok: false, transient: false, errorKind: 'HOST_ERROR' });
    }
    expect(tester.count(), '5 个 job 都要真正开始：并发槽没有泄漏').toBe(5);
  });

  it('S18 tester 返回非 thenable（undefined）→ 与 S17 相同：不抛给调用方，条目终态 fail', async () => {
    const tester = createNonThenableTester();
    const { store } = testerSetup({ pi: piWithModels(M5) }, tester);
    await store.load();
    const api = testApi(store);

    const thrown: unknown[] = [];
    for (const id of M5) {
      try {
        api.testModel('gpt-gateway', id);
      } catch (error) {
        thrown.push(error);
      }
    }
    await tick();

    expect(thrown, 'testModel 不应把注入 tester 的异常抛回给调用方').toEqual([]);
    for (const id of M5) {
      const entry = testState(store).results[key(id)];
      expect(entry?.state, `${id} 应落到终态 fail（不是 running）`).toBe('fail');
      expect(entry?.result).toMatchObject({ ok: false, transient: false, errorKind: 'HOST_ERROR' });
    }
    expect(tester.count(), '5 个 job 都要真正开始：并发槽没有泄漏').toBe(5);
  });

  it('S19 dispose 之后 stopBatch / toggleTestDetail / copyTestDetail 不再通知监听器', async () => {
    const { store } = await startBatch5();
    const api = testApi(store);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    store.dispose();
    notified = 0;
    api.stopBatch('gpt-gateway');
    api.toggleTestDetail('gpt-gateway', 'm1');
    api.copyTestDetail('gpt-gateway', 'm1');

    expect(notified).toBe(0);
  });

  it('S20 无 status 的普通 Error → HOST_ERROR 非 transient（TypeError 才是 HOST_UNREACHABLE）', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(['m1']) });
    await store.load();
    testApi(store).testModel('gpt-gateway', 'm1');

    tester.call(0).reject(new Error('boom'));
    await tick();

    const entry = testState(store).results[key('m1')];
    expect(entry.state).toBe('fail');
    expect(entry.result).toMatchObject({ ok: false, transient: false, errorKind: 'HOST_ERROR', status: null, message: 'boom' });
  });
});

/* ==========================================================================
 * R4 回归（线上 bug）：设置面板关闭后再次打开，提供方详情页的所有按钮失效。
 *
 * 现象：第一次打开设置时「进入 →」「返回」都正常；关闭设置（或切到别的 tab）
 * 再打开之后，点「进入 →」没有任何反应，console 也没有报错。
 *
 * 期望语义（orchestrator 已定）：
 * - dispose 只结束本次挂载周期：取消事件订阅、清掉测试队列，并且「dispose 之后、
 *   下一次 load 之前」不再 publish（S19 的语义保持不变，由 RM5 守住）；
 * - 下一次 load() 重新启用 store：事件订阅、进入/返回、事件回调、模型测试全部恢复。
 *
 * RM1–RM4 在修复前应当是红的（publish 被 `if (disposed) return` 永久吞掉），
 * RM5 是守卫用例，修复前后都应当是绿的。
 * ========================================================================== */

describe('R4 回归：dispose 后再次 load 重新启用（面板重新挂载）', () => {
  /** 面板第一次挂载（load）→ 关闭设置（dispose）→ 再次打开（load）。 */
  async function remount(store: TestableStore): Promise<void> {
    await store.load();
    store.dispose();
    await store.load();
  }

  it('RM1 重新挂载后 enter / backToList 恢复，并且通知 subscribe 监听器', async () => {
    const { store } = setup();
    await remount(store);

    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    store.enter('gpt-gateway');
    const detail = store.getSnapshot();
    expect(detail.ui.view, '「进入 →」必须切到详情页（线上点了没反应的就是这一步）').toBe('detail');
    expect(detail.ui.route).toBe('gpt-gateway');
    expect(notified, '重新挂载后的 publish 必须通知监听器').toBeGreaterThan(0);

    const entered = notified;
    store.backToList();
    const list = store.getSnapshot();
    expect(list.ui.view).toBe('list');
    expect(list.ui.route).toBeNull();
    expect(notified, '「返回」同样要通知监听器').toBeGreaterThan(entered);
  });

  it('RM2 StrictMode 的 load → dispose → load 序列后加载完成，且能进入 / 返回', async () => {
    const { store } = setup();

    void store.load(); // 首次挂载：effect 里的 load 还没结束……
    store.dispose(); // ……StrictMode 立刻 cleanup
    await store.load(); // 第二次挂载：重新 load

    const loaded = store.getSnapshot();
    expect(loaded.ui.loading, '重新挂载后加载必须结束（loading=false）').toBe(false);
    expect(Object.keys(loaded.draft.providers), 'draft 必须真的加载出来').toContain('gpt-gateway');

    store.enter('gpt-gateway');
    expect(store.getSnapshot().ui.view).toBe('detail');
    expect(store.getSnapshot().ui.route).toBe('gpt-gateway');

    store.backToList();
    expect(store.getSnapshot().ui.view).toBe('list');
  });

  it('RM3 重新挂载后事件订阅恢复，document-updated 的效果不再被吞掉', async () => {
    const { fake, store } = setup();
    await store.load();
    const subscriptionsAfterFirstMount = fake.on.mock.calls.length;
    expect(subscriptionsAfterFirstMount, '首次挂载要订阅事件').toBeGreaterThan(0);

    store.dispose();
    for (const disposer of fake.disposers) expect(disposer).toHaveBeenCalled();

    await store.load();
    expect(fake.on.mock.calls.length, '重新挂载要重新订阅事件').toBeGreaterThan(subscriptionsAfterFirstMount);

    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    // 外部把 gpt-gateway 的模型表换成 m1，并广播新 revision。
    fake.setSlice(NS_PI, sliceWithModels(piSlice(9), 'gpt-gateway', [modelEntry('m1')]));
    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(
        store.getSnapshot().draft.providers['gpt-gateway']?.models.map((model) => model.id),
        '重新挂载后的事件回调不能吞掉 publish',
      ).toEqual(['m1']);
    });
    expect(notified, '事件处理后的 publish 必须通知监听器').toBeGreaterThan(0);
  });

  it('RM4 带 tester 时重新挂载后 testModel 仍能启动，条目进入 running', async () => {
    const { store, tester } = testerSetup({ pi: piWithModels(M5) });
    await remount(store);

    const firstModelId = M5[0]; // gpt-gateway 的第一个模型
    testApi(store).testModel('gpt-gateway', firstModelId);

    expect(tester.count(), '重新挂载后 testModel 必须真的调用 tester').toBe(1);
    expect(tester.call(0).req).toEqual({ provider: 'gpt-gateway', model: firstModelId });
    expect(testState(store).results[key(firstModelId)].state).toBe('running');
  });

  it('RM5 守卫：dispose 之后、没有再次 load 时不通知监听器（S19 语义不变）', async () => {
    const { store } = setup();
    await store.load();
    store.dispose();

    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    store.enter('gpt-gateway');
    store.backToList();

    expect(notified, 'dispose 之后、下一次 load 之前不许 publish').toBe(0);
    expect(store.getSnapshot().ui.view).toBe('list');
    expect(store.getSnapshot().ui.route).toBeNull();
  });
});

