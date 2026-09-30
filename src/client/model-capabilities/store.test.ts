/**
 * store.ts 用例清单（docs/specs/model-capabilities.tests.md 的 store 一节 + 本轮追加的 4 条）。
 *
 * fake port 仿照 DSH 真实行为：describe 返回 {status,writable,namespaces}；
 * mutate 不 throw，返回 {ok:true,value} 或 {ok:false,error:{code,details}}，
 * 成功时把 op 作用到 value 与 user 两层（等价于真实写入用户覆盖层），并让 revision 自增；
 * on 记录回调并返回 disposer。
 *
 * 约定（store 契约）：保存类失败文案写进 McSnapshot.saveError；
 * 冲突状态同时写进 ui.conflict（'hidden' | 'shown' | 'kept'）。
 *
 * W1a：现在应为红，失败原因是桩抛 `not implemented`。
 */
import { describe, expect, it, vi } from 'vitest';
import { createModelCapabilitiesStore } from './store';
import type { SettingsOp } from './types';
import { DS_ROUTE_ID, NS_DS, NS_PI } from './types';
import type { FakePort, FakePortOptions } from './test-fixtures';
import { createFakePort, defaultCreds, dsSlice, piSlice, sliceWithExtraProvider } from './test-fixtures';

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

describe('store.load', () => {
  it('Given describe 返回 pi 与 ds When load Then 列表数据来自 value，value 独有的 schema 默认容量不产出 op', async () => {
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
    // ds 的 user 为空 → 模型只能来自 value
    expect(snap.draft.providers[DS_ROUTE_ID].models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(snap.draft.providers[DS_ROUTE_ID].thinking).toBe('enabled');
    // value 上有 schema 默认、user 上没有 → 草稿里没有这个键（按继承处理）
    expect(snap.draft.providers['gpt-gateway'].defaultContextWindow).toBeUndefined();
    expect(snap.draft.providers['gpt-gateway'].defaultMaxTokens).toBeUndefined();
    // user 上有的覆盖进草稿
    expect(snap.draft.providers['cc-gateway'].defaultInput).toEqual(['text']);

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

  it('Given pi 成功、ds 返回 settings/conflict When save Then pi 的 base 已更新、ds 草稿保留、显示横幅且不写凭证', async () => {
    const fake = createFakePort({
      pi: piSlice(7),
      ds: dsSlice(11),
      creds: defaultCreds(),
      fail: (ns) => (ns === NS_DS ? { code: 'settings/conflict' } : null),
    });
    const store = createModelCapabilitiesStore(fake.port);
    await store.load();

    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    store.closeLayer();
    store.enter('gpt-gateway');
    store.openAccess();
    store.setSecret('k9-topsecret');
    store.closeLayer();
    store.enter(DS_ROUTE_ID);
    store.setCap('r', 'cw', '2000000');

    const before = store.getSnapshot();
    expect(paths(before.ops.pi)).toEqual(['providers.gpt-gateway.models']);
    expect(paths(before.ops.ds)).toEqual(['defaultContextWindow']);
    expect(before.ops.cred).toEqual([{ op: 'set', ref: 'GPT_GATEWAY_API_KEY' }]);

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
    expect(paths(snap.ops.ds)).toEqual(['defaultContextWindow']);
    expect(snap.draft.providers[DS_ROUTE_ID].defaultContextWindow).toBe('2000000');
    expect(snap.ui.conflict).toBe('shown');
    expect(snap.saveError).toContain('这次没写入。你的修改还在。');
    expect(snap.ops.cred).toHaveLength(1);
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

  it('Given openBulk 记下快照 When 之后清空勾选 Then scope 保持 sel，批量应用仍只改快照里的模型', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.selectIndex(0, true);
    store.openBulk();

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
