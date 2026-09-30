/**
 * R1 红灯用例：W4 审查发现的 7 个缺陷。
 *
 * 约定：这一批用例在修复前必须失败，而且失败信息要指向缺陷本身
 * （TypeError / conflict 为 shown / secretError 返回值 / effort 为 '' /
 *  thSel 为空 / reasoningEfforts 为 undefined / path 被点号切开）。
 * 修复落地后它们应当全绿；其余用例始终不变。
 *
 * 依据：
 * - llm-pi-ai 的 `headers` 是 `z.dict(z.string())`，即 `{ 'X-Org': 'acme' }`（字典）。
 * - dsh-settings 的 `write()` 在返回前调用 `describe()`，后者同步 emit
 *   `settings/document-updated`，所以事件流先于 mutate 的结果到达。
 * - spec 第 75 行：密钥预检只有三条规则（ASCII 非空白 / 拒绝 ENV 赋值写法 /
 *   拒绝首尾同一种引号）。
 * - agent-default-model 的字段是 `provider`、`model`、`reasoningEffort`。
 * - 批量层 rail 的 key `bulk`、新建模型写 `reasoningEfforts: false`、
 *   route id 允许含点号（path 不能按 `.` 拆）。
 */
import { describe, expect, it } from 'vitest';
import { computeOps, draftFromNamespaces } from './ops';
import { createModelCapabilitiesStore } from './store';
import { secretError } from './validate';
import type { NamespaceSlice, OpsResult } from './types';
import { defaultCreds, deepClone, createFakePort, piSlice } from './test-fixtures';

/* ---------------- 局部工具 ---------------- */

/** 往 pi slice 的 value/user 两层同时加一个提供方（模拟已有配置）。 */
function piSliceWithProvider(id: string, raw: Record<string, unknown>, revision = 7): NamespaceSlice {
  const slice = piSlice(revision);
  const value = deepClone(slice.value);
  const user = deepClone(slice.user ?? {});
  const valueProviders = (value.providers ?? {}) as Record<string, unknown>;
  const userProviders = (user.providers ?? {}) as Record<string, unknown>;
  valueProviders[id] = deepClone(raw);
  userProviders[id] = deepClone(raw);
  value.providers = valueProviders;
  user.providers = userProviders;
  return { ...slice, value, user };
}

function opPaths(ops: readonly { path: string[] }[]): string[] {
  return ops.map((op) => op.path.join('.'));
}

async function loadedStore(over: Parameters<typeof createFakePort>[0] = {}) {
  const fake = createFakePort({ pi: piSlice(7), ds: null, creds: defaultCreds(), ...over });
  const store = createModelCapabilitiesStore(fake.port);
  await store.load();
  return { fake, store };
}

/* ================= R1-1 headers 是字典 ================= */

describe('R1-1 llm-pi-ai 的 headers 在 schema 里是字典', () => {
  const headersSlice = (headers: unknown): NamespaceSlice =>
    piSliceWithProvider('hdr-gateway', {
      api: 'openai-responses',
      baseURL: 'https://hdr.invalid',
      apiKeyEnv: 'HDR_API_KEY',
      headers,
      models: [],
    });

  it('R1-1a Given describe 的 headers 是字典 When draftFromNamespaces Then 草稿是 [{k,v}]', () => {
    const draft = draftFromNamespaces({ pi: headersSlice({ 'X-Org': 'acme' }), ds: null, creds: {} });
    expect(draft.providers['hdr-gateway'].headers).toEqual([{ k: 'X-Org', v: 'acme' }]);
  });

  it('R1-1b Given 字典有两个键 When draftFromNamespaces Then 每个键都成一个 {k,v}', () => {
    const draft = draftFromNamespaces({
      pi: headersSlice({ 'X-Org': 'acme', 'X-Tier': 'gold' }),
      ds: null,
      creds: {},
    });
    expect(draft.providers['hdr-gateway'].headers).toEqual([
      { k: 'X-Org', v: 'acme' },
      { k: 'X-Tier', v: 'gold' },
    ]);
  });

  it('R1-1c Given 字典 headers 且未改动 When computeOps Then 不抛错，pi 为空且 dirty=0', () => {
    const base = draftFromNamespaces({ pi: headersSlice({ 'X-Org': 'acme' }), ds: null, creds: {} });
    let ops: OpsResult | undefined = undefined;
    let thrown: unknown = null;
    try {
      ops = computeOps(base, deepClone(base), {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    expect(ops?.pi ?? []).toEqual([]);
    expect(ops?.dirty ?? -1).toBe(0);
  });

  it('R1-1d Given 改了一个 header 值 When computeOps Then set [providers,id,headers]，value 仍是字典', () => {
    const base = draftFromNamespaces({ pi: headersSlice({ 'X-Org': 'acme' }), ds: null, creds: {} });
    const draft = deepClone(base);
    draft.providers['hdr-gateway'].headers = [{ k: 'X-Org', v: 'new' }];

    const ops = computeOps(base, draft, {});
    expect(ops.pi).toEqual([
      { op: 'set', path: ['providers', 'hdr-gateway', 'headers'], value: { 'X-Org': 'new' } },
    ]);
  });

  it('R1-1e Given headers 是空字典 When draftFromNamespaces Then 草稿里没有 headers', () => {
    const draft = draftFromNamespaces({ pi: headersSlice({}), ds: null, creds: {} });
    expect(draft.providers['hdr-gateway'].headers).toBeUndefined();
  });

  it('R1-1f Given describe 带字典 headers When store.load Then loading=false 且 loadError 为 null', async () => {
    const fake = createFakePort({ pi: headersSlice({ 'X-Org': 'acme' }), ds: null, creds: {} });
    const store = createModelCapabilitiesStore(fake.port);
    let thrown: unknown = null;
    try {
      await store.load();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    const snap = store.getSnapshot();
    expect(snap.ui.loading).toBe(false);
    expect(snap.loadError).toBeNull();
  });
});

/* ================= R1-2 写入回声先于 mutate 结果 ================= */

describe('R1-2 settings.write 的事件流先于 mutate 结果到达', () => {
  it('R1-2a Given mutate 先 emit 自己的 revision 再 resolve When save Then 不显示冲突、dirty=0、saved=true', async () => {
    const { fake, store } = await loadedStore({ emitBeforeResolve: true });
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    await store.save();

    expect(fake.mutate).toHaveBeenCalledTimes(1);
    const snap = store.getSnapshot();
    expect(snap.ui.conflict).toBe('hidden');
    expect(snap.ui.saved).toBe(true);
    expect(snap.ops.dirty).toBe(0);
    expect(snap.saveError).toBeNull();
  });

  it('R1-2b Given 第一次 save 收到过回声 When 再改一处并 save Then mutate 再次被调用', async () => {
    const { fake, store } = await loadedStore({ emitBeforeResolve: true });
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    await store.save();
    expect(fake.mutate).toHaveBeenCalledTimes(1);

    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Second');
    expect(store.getSnapshot().ops.dirty).toBeGreaterThan(0);
    await store.save();

    expect(fake.mutate).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().ui.conflict).toBe('hidden');
  });

  it('R1-2c Given 模型改动加密钥且回声先到 When save Then credentials.set 调用一次且不显示冲突', async () => {
    const { fake, store } = await loadedStore({ emitBeforeResolve: true });
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    store.openAccess();
    store.setSecret('k9-topsecret');

    await store.save();

    expect(fake.credSet).toHaveBeenCalledTimes(1);
    expect(fake.credSet).toHaveBeenCalledWith('GPT_GATEWAY_API_KEY', 'k9-topsecret');
    const snap = store.getSnapshot();
    expect(snap.ui.conflict).toBe('hidden');
    expect(snap.ops.dirty).toBe(0);
  });
});

/* ================= R1-3 secretError 只按 spec 三条规则 ================= */

/**
 * spec（docs/specs/model-capabilities.md 第 75 行）的三条规则，独立于 validate.ts：
 * 空串放行；非空必须匹配 /^[\x21-\x7E]+$/；拒绝 /^[A-Z][A-Z0-9_]*=[^=]/；拒绝首尾同一种引号。
 */
function specSecretError(value: string): string {
  if (!value) return '';
  const first = value[0];
  const last = value[value.length - 1];
  const asciiPrintable = /^[\x21-\x7e]+$/.test(value);
  const envAssignment = /^[A-Z][A-Z0-9_]*=[^=]/.test(value);
  const sameQuotes = value.length >= 2 && (first === '"' || first === "'") && last === first;
  return asciiPrintable && !envAssignment && !sameQuotes ? '' : '密钥只能包含 ASCII 非空白字符，不能包含引号或等号。';
}

/** [输入, spec 判定]：'pass' = 通过预检，'err' = 拒绝。 */
type SecretVerdict = 'pass' | 'err';

/** validate.test.ts 106-122 的既有期望，逐条按 spec 的三条规则复核。 */
const SECRET_CASES_OLD: ReadonlyArray<readonly [string, SecretVerdict]> = [
  ['', 'pass'],
  ['sk-abc123', 'pass'],
  ['A.b_c-1', 'pass'],
  ['A=b', 'err'], // 匹配 ^[A-Z][A-Z0-9_]*=[^=] → 拒绝
  ['"x"', 'err'], // 首尾同一种引号 → 拒绝
  ["'x'", 'err'], // 首尾同一种引号 → 拒绝
  ['has space', 'err'], // 空格不满足 \x21-\x7E → 拒绝
  ['中文密钥', 'err'], // 非 ASCII → 拒绝
];

/** 本轮新增：合法字符不再被误拒。 */
const SECRET_CASES_ALLOWED: ReadonlyArray<string> = ['sk-abc=', 'abc==', 'a=b', "sk'x"];

/** 本轮新增：仍然要拒绝。 */
const SECRET_CASES_REJECTED: ReadonlyArray<string> = ['FOO=bar', 'a b', '密钥'];

describe('R1-3 secretError 只按 spec 的三条规则拒绝', () => {
  it('R1-3a Given 合法的 = 或单个引号 When secretError Then 空串（不再误拒）', () => {
    for (const value of SECRET_CASES_ALLOWED) {
      expect(secretError(value), `secretError(${JSON.stringify(value)})`).toBe('');
    }
  });

  it('R1-3b Given ENV 赋值写法、首尾同引号、空格或非 ASCII When secretError Then 非空', () => {
    for (const value of SECRET_CASES_REJECTED) {
      expect(secretError(value), `secretError(${JSON.stringify(value)})`).not.toBe('');
    }
  });

  it('R1-3c 既有用例逐条核对：期望与 spec 三条规则一致（核对结论：旧期望全部保留，无改动）', () => {
    for (const [value, verdict] of SECRET_CASES_OLD) {
      const label = `${JSON.stringify(value)} 应为 ${verdict}`;
      expect(secretError(value) === '', `secretError: ${label}`).toBe(verdict === 'pass');
      expect(specSecretError(value) === '', `specSecretError(spec): ${label}`).toBe(verdict === 'pass');
    }
  });
});

/* ================= R1-4 agent-default-model 的字段名 ================= */

describe('R1-4 agent-default-model 读 reasoningEffort 而不是 effort', () => {
  const defaultNs = (value: Record<string, unknown>): NamespaceSlice => ({
    ns: 'agent-default-model',
    value,
    user: {},
    revision: 3,
    writable: true,
    mode: 'host',
  });

  it('R1-4a Given describe 里有 reasoningEffort=max When load Then defaultModel.effort 为 max', async () => {
    const { store } = await loadedStore({
      extraNamespaces: [defaultNs({ provider: 'gpt-gateway', model: 'gpt-6-luna', reasoningEffort: 'max' })],
    });
    const dm = store.getSnapshot().defaultModel;
    expect(dm?.provider).toBe('gpt-gateway');
    expect(dm?.model).toBe('gpt-6-luna');
    expect(dm?.effort).toBe('max');
    expect(dm).toEqual({ provider: 'gpt-gateway', model: 'gpt-6-luna', effort: 'max' });
  });

  it('R1-4b Given describe 里没有 reasoningEffort When load Then effort 为空串', async () => {
    const { store } = await loadedStore({
      extraNamespaces: [defaultNs({ provider: 'gpt-gateway', model: 'gpt-6-luna' })],
    });
    expect(store.getSnapshot().defaultModel).toEqual({ provider: 'gpt-gateway', model: 'gpt-6-luna', effort: '' });
  });
});

/* ================= R1-5 railToggle 的 bulk key ================= */

describe('R1-5 railToggle 认识 bulk', () => {
  it('R1-5a Given 批量层 th=set When railToggle(bulk,high) 两次 Then thSel 加入再移除', async () => {
    const { store } = await loadedStore();
    store.enter('gpt-gateway');
    store.openBulk();
    store.patchBulk({ th: 'set' });

    store.railToggle('bulk', 'high');
    const opened = store.getSnapshot().ui.bulk;
    if (!opened) throw new Error('批量层没有打开');
    expect(opened.thSel).toContain('high');

    store.railToggle('bulk', 'high');
    const closed = store.getSnapshot().ui.bulk;
    if (!closed) throw new Error('批量层没有打开');
    expect(closed.thSel).not.toContain('high');
  });

  it('R1-5b Given 批量层里已有 high When 再点 low Then 两档都在 thSel 里', async () => {
    const { store } = await loadedStore();
    store.enter('gpt-gateway');
    store.openBulk();
    store.patchBulk({ th: 'set', thSel: ['high'] });

    store.railToggle('bulk', 'low');

    const bulk = store.getSnapshot().ui.bulk;
    if (!bulk) throw new Error('批量层没有打开');
    expect(bulk.thSel).toContain('high');
    expect(bulk.thSel).toContain('low');
  });
});

/* ================= R1-6 新建模型写 reasoningEfforts: false ================= */

describe('R1-6 新建模型写入 reasoningEfforts: false', () => {
  it('R1-6a Given addModel When 看草稿 Then 新模型的 reasoningEfforts 为 false', async () => {
    const { store } = await loadedStore();
    store.enter('gpt-gateway');
    store.addModel();

    const models = store.getSnapshot().draft.providers['gpt-gateway'].models;
    expect(models).toHaveLength(5);
    expect(models[4].reasoningEfforts).toBe(false);
  });

  it('R1-6b Given 向导走完 When 看草稿 Then 新提供方的模型 reasoningEfforts 为 false', async () => {
    const { store } = await loadedStore();
    store.openAddProvider();
    store.wizardPatch({ api: 'openai-completions', id: 'fresh-gateway', ack: true, models: ['fresh-model'] });
    store.wizardFinish();

    const provider = store.getSnapshot().draft.providers['fresh-gateway'];
    if (!provider) throw new Error('向导没有写入新提供方');
    expect(provider.models.map((model) => model.reasoningEfforts)).toEqual([false]);
  });

  it('R1-6c Given 向导走完 When 看 computeOps 的新建 op Then 模型对象带 reasoningEfforts: false', async () => {
    const { store } = await loadedStore();
    store.openAddProvider();
    store.wizardPatch({ api: 'openai-completions', id: 'fresh-gateway', ack: true, models: ['fresh-model'] });
    store.wizardFinish();

    const ops = store.getSnapshot().ops.pi;
    expect(opPaths(ops)).toEqual(['providers.fresh-gateway']);
    const op = ops[0];
    if (!op || op.op !== 'set') throw new Error('新建提供方没有 set op');
    const value = op.value as Record<string, unknown>;
    const models = value.models as Array<Record<string, unknown>>;
    expect(models[0].reasoningEfforts).toBe(false);
  });
});

/* ================= R1-7 route 里的点号 ================= */

describe('R1-7 带点号的 route 不能按 . 拆 path', () => {
  const dotted = (): NamespaceSlice =>
    piSliceWithProvider('my.gateway', {
      api: 'openai-responses',
      baseURL: 'https://dotted.invalid',
      apiKeyEnv: 'MY_GATEWAY_API_KEY',
      models: [{ id: 'm1', name: 'M1', contextWindow: 272000, maxTokens: 128000 }],
    });

  it('R1-7a Given route 是 my.gateway When 改 api Then path 是 [providers, my.gateway, api]', () => {
    const base = draftFromNamespaces({ pi: dotted(), ds: null, creds: {} });
    const draft = deepClone(base);
    draft.providers['my.gateway'].api = 'anthropic-messages';

    const ops = computeOps(base, draft, {});
    expect(ops.pi).toHaveLength(1);
    expect(ops.pi[0].path).toEqual(['providers', 'my.gateway', 'api']);
  });

  it('R1-7b Given route 是 my.gateway When 改 models Then path 是 [providers, my.gateway, models]', () => {
    const base = draftFromNamespaces({ pi: dotted(), ds: null, creds: {} });
    const draft = deepClone(base);
    draft.providers['my.gateway'].models[0].name = 'Renamed';

    const ops = computeOps(base, draft, {});
    expect(ops.pi).toHaveLength(1);
    expect(ops.pi[0].path).toEqual(['providers', 'my.gateway', 'models']);
  });
});
