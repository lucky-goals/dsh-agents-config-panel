/**
 * R2 增量契约的红灯用例：R2-1 ~ R2-20（docs/specs/model-capabilities.r2.md 第 4、5 节）。
 *
 * 每一条都是「先写测试」：凡 W2 还没实现的行为在这里是红的，失败原因必须是断言不通过，
 * 不能是 import 或语法错误。W0 顺带落地的行为直接绿。
 *
 * 文案一律从契约第 4 节逐字取用。
 */
import { describe, expect, it, vi } from 'vitest';
import { bulkPhrase, bulkPlan, bulkResultMsg, bulkSummary, canonicalPersist, newBulk } from './bulk';
import { capBlocks, modelCap } from './capacity';
import { inputSummary, resolvedInput } from './efforts';
import { computeOps, draftFromNamespaces, SKIP, fieldOut } from './ops';
import { createModelCapabilitiesStore } from './store';
import { routeErrors, secretError, allErrors, modelCapBad, modelErrors, wizardErrors } from './validate';
import { CAP_FMT_ERR, type DraftState, type ModelCapabilitiesPort, type ModelDraft, type ProviderDraft, type SettingsOp } from './types';
import { DS_ROUTE_ID, NS_DS, NS_PI } from './types';
import {
  createFakePort,
  defaultCreds,
  deepClone,
  dsSlice,
  draftModel,
  draftProvider,
  piSlice,
  sliceWithModels,
  sliceWithProvider,
} from './test-fixtures';

/* ---------------- 契约第 4 节的逐字文案 ---------------- */

const T4_INPUT = '源没有 input，目标会清除输入。';
const T4_LEGACY = '源没有 input，目标会清除输入；不复制旧字段。';
const T8_SRC = '源模型的容量格式不正确，不能复制。';
const T9_HEADERS = '请求头名称「A」、「B」重复。请改成不同的名称后再保存。';
/**
 * R2F-5：文案里的名称必须来自真实请求头名，不再写死「A」「B」。
 * 只有一个重复名时只列它；多个按首次出现顺序去重列出。
 */
const T9_HEADERS_A = '请求头名称「A」重复。请改成不同的名称后再保存。';
const T9_HEADERS_XORG = '请求头名称「X-Org」重复。请改成不同的名称后再保存。';
const T9_HEADERS_XA_XB = '请求头名称「X-A」、「X-B」重复。请改成不同的名称后再保存。';
const T10_SECRET = '密钥只能包含 ASCII 非空白字符，不能写成环境变量赋值，也不能首尾用同一种引号包住。';
const T12_CONFLICT = '这份配置刚刚被别处改过。llm-pi-ai 已写入。llm-deepseek 这次没写入。你的修改还在。';
const T18_FOREIGN = '配置已写入，但写入期间远端又被改过。你的修改还在。';
const T18_STALE_SUFFIX = '远端配置已经变化。';
const LEGACY_HINT = '旧字段 inputModalities 不会被「清除」清掉，请用「迁移为 input」。';

/** 6 个提供方级默认键（pi 4 个 + DS 2 个）。 */
const PI_DEFAULT_KEYS = ['defaultInput', 'reasoning', 'defaultContextWindow', 'defaultMaxTokens'] as const;
const DS_DEFAULT_KEYS = ['defaultContextWindow', 'maxTokens'] as const;

/* ---------------- 局部工具 ---------------- */

function setup(over: Parameters<typeof createFakePort>[0] = {}) {
  const fake = createFakePort({ pi: piSlice(7), ds: dsSlice(11), creds: defaultCreds(), ...over });
  const store = createModelCapabilitiesStore(fake.port);
  return { fake, store };
}

function paths(ops: SettingsOp[]): string[] {
  return ops.map((op) => op.path.join('.'));
}

function firstSetOp(ops: SettingsOp[]): Record<string, unknown> {
  const op = ops[0];
  if (!op || op.op !== 'set') throw new Error('expected a set op');
  return op.value as Record<string, unknown>;
}

/* ================= R2-1 默认键不产生 op，也不进草稿和 extra ================= */

describe('R2-1 6 个默认键只进 known，不产生 op，也不进草稿字段和 extra', () => {
  it('Given pi 与 DS 的 user 层都带默认键 When 不做任何编辑 Then op 为空、dirty=0 且键不在草稿也不在 extra', () => {
    const base = draftFromNamespaces({ pi: piSlice(7), ds: dsSlice(11), creds: defaultCreds() });

    for (const id of ['gpt-gateway', 'cc-gateway']) {
      const provider = base.providers[id] as unknown as Record<string, unknown>;
      for (const key of PI_DEFAULT_KEYS) {
        expect(provider[key], `${id}.${key}`).toBeUndefined();
        expect(base.providers[id].extra[key], `${id}.extra.${key}`).toBeUndefined();
      }
    }
    const ds = base.providers[DS_ROUTE_ID] as unknown as Record<string, unknown>;
    for (const key of DS_DEFAULT_KEYS) {
      expect(ds[key], `deepseek-official.${key}`).toBeUndefined();
      expect(base.providers[DS_ROUTE_ID].extra[key], `deepseek-official.extra.${key}`).toBeUndefined();
    }

    const ops = computeOps(base, deepClone(base), {});
    expect(ops.pi).toEqual([]);
    expect(ops.ds).toEqual([]);
    expect(ops.cred).toEqual([]);
    expect(ops.dirty).toBe(0);
    expect(ops.dirtySet.size).toBe(0);
  });

  it('Given describe 返回的 user 层带默认键 When load Then 草稿里没有这 6 个键且 dirty=0', async () => {
    const { store } = setup();
    await store.load();
    const snap = store.getSnapshot();
    for (const key of PI_DEFAULT_KEYS) {
      const provider = snap.draft.providers['gpt-gateway'] as unknown as Record<string, unknown>;
      expect(provider[key], `draft.gpt-gateway.${key}`).toBeUndefined();
      expect(snap.draft.providers['gpt-gateway'].extra[key], `extra.${key}`).toBeUndefined();
    }
    expect(snap.ops.dirty).toBe(0);
    expect(snap.ops.pi).toEqual([]);
    expect(snap.ops.ds).toEqual([]);
  });
});

/* ================= R2-2 新建时不写默认键 ================= */

describe('R2-2 新建提供方的对象里没有 6 个默认键', () => {
  it('Given 从零新建一个提供方 When computeOps Then 没有 6 个默认键，模型带 reasoningEfforts:false', () => {
    const base: DraftState = { providers: {} };
    const draft: DraftState = {
      providers: {
        mine: draftProvider({
          id: 'mine',
          api: 'openai-completions',
          baseURL: 'https://mine.invalid',
          apiKeyEnv: 'MINE_API_KEY',
          models: [draftModel({ id: 'gpt-6-nova', reasoningEfforts: false })],
        }),
      },
    };

    const ops = computeOps(base, draft, {});
    expect(paths(ops.pi)).toEqual(['providers.mine']);
    const value = firstSetOp(ops.pi);
    for (const key of [...PI_DEFAULT_KEYS, ...DS_DEFAULT_KEYS]) {
      expect(value, `新建对象不应带 ${key}`).not.toHaveProperty(key);
    }
    expect((value.models as Array<Record<string, unknown>>)[0].reasoningEfforts).toBe(false);
    expect(value.api).toBe('openai-completions');
  });

  it('Given 向导走完 When 看新建的对象 Then 也没有这 6 个键', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.openAddProvider();
    store.wizardPatch({ api: 'openai-completions', id: 'fresh-gateway', ack: true, models: ['fresh-model'] });
    store.wizardFinish();

    const value = firstSetOp(store.getSnapshot().ops.pi);
    for (const key of [...PI_DEFAULT_KEYS, ...DS_DEFAULT_KEYS]) {
      expect(value, `向导新建对象不应带 ${key}`).not.toHaveProperty(key);
    }
    expect(store.getSnapshot().draft.providers['fresh-gateway']).toBeDefined();
  });
});

/* ================= R2-3 DS 只设 cw 时不报错 ================= */

describe('R2-3 DeepSeek 只设 contextWindow 时不报错', () => {
  it('Given DS 模型只设 contextWindow When 校验与保存 Then 不报错且保存发生在 llm-deepseek 上', async () => {
    const dsOnlyCw = dsSlice(11);
    dsOnlyCw.value = {
      ...dsOnlyCw.value,
      models: [{ id: 'deepseek-flash', name: 'V41-Flash', inputModalities: ['text', 'image'], contextWindow: 200000 }],
    };
    const { fake, store } = setup({ ds: dsOnlyCw });

    await store.load();
    const model = store.getSnapshot().draft.providers[DS_ROUTE_ID].models[0];
    expect(model.contextWindow).toBe('200000');
    expect(model.maxTokens).toBeUndefined();
    expect(modelCap(model).mt.parsed).toBeUndefined();
    expect(capBlocks(modelCap(model))).toBe(false);
    expect(store.getSnapshot().errors).toEqual({});
    expect(store.getSnapshot().ops.dirty).toBe(0);

    store.enter(DS_ROUTE_ID);
    store.openModel(0);
    store.setCap('cw', '300000');
    store.blurCap('cw');

    expect(store.getSnapshot().errors).toEqual({});
    expect(paths(store.getSnapshot().ops.ds)).toEqual(['models']);

    await store.save();
    expect(fake.mutate).toHaveBeenCalledTimes(1);
    expect(fake.mutate.mock.calls[0][0]).toBe(NS_DS);
    expect(store.getSnapshot().saveError).toBeNull();
    expect(store.getSnapshot().ops.dirty).toBe(0);
  });
});

/* ================= R2-4 两侧都设置且越界时阻止 ================= */

describe('R2-4 两侧都是数字且最大输出大于窗口时阻止保存', () => {
  it('Given 模型 cw=1000、mt=40000 When 校验 Then 阻止保存并给越界文案', () => {
    const model = draftModel({ id: 'm', contextWindow: '1000', maxTokens: '40000' });
    const provider = draftProvider({ id: 'gpt-gateway', models: [model] });

    expect(capBlocks(modelCap(model))).toBe(true);
    expect(modelCapBad(model)).toBe(true);
    expect(modelErrors(provider, model, 0).maxTokens).toBe('最大输出大于上下文窗口（40000 > 1000）。输出不能超过上下文窗口。');

    const errors = allErrors({ providers: { 'gpt-gateway': provider } });
    expect(errors['gpt-gateway'].models[0].maxTokens).toBeDefined();
  });

  it('Given 越界的模型 When save Then 不调用 mutate 且提示先修正标红字段', async () => {
    const { fake, store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setCap('cw', '1000');
    store.setCap('mt', '40000');
    store.blurCap('cw');
    store.blurCap('mt');

    expect(store.getSnapshot().errors['gpt-gateway'].models[0].maxTokens).toBeDefined();
    await store.save();

    expect(fake.mutate).not.toHaveBeenCalled();
    expect(store.getSnapshot().ui.status).toBe('请先修正标红字段。');
  });
});

/* ================= R2-5 未设置时 input 摘要为「未设置」 ================= */

describe('R2-5 未设置时 input 摘要为「未设置」', () => {
  it('Given pi 模型没有 input When inputSummary Then 「未设置」且 set=false', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    const m = draftModel({ id: 'gpt-6-astra' });
    expect(resolvedInput(p, m)).toEqual({ v: [], set: false });
    expect(inputSummary(p, m)).toBe('未设置');
  });

  it('Given DS 模型没有 inputModalities When inputSummary Then 「未设置」', () => {
    const p = draftProvider({ id: DS_ROUTE_ID, ns: NS_DS });
    expect(inputSummary(p, draftModel({ id: 'deepseek-v4-pro' }))).toBe('未设置');
  });

  it('Given 摘要里的任何输入 When 检查 Then 都不含「继承」', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    expect(inputSummary(p, draftModel({ id: 'm' }))).not.toContain('继承');
    expect(inputSummary(p, draftModel({ id: 'm', input: ['text'] }))).not.toContain('继承');
  });
});

/* ================= R2-6 128K 与 128000 相同，C=0 ================= */

describe('R2-6 128K 与 128000 在 canonicalPersist 下相同', () => {
  it('Given 模型写 128K、批量设为 128000 When bulkPlan Then 视为相同，C=0、S=0', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'm', contextWindow: '128K' })] });
    const b: ReturnType<typeof newBulk> = { ...newBulk('gpt-gateway', []), cw: 'set', cwRaw: '128000' };
    const plan = bulkPlan(p, b);
    expect(plan.C).toBe(0);
    expect(plan.S).toBe(0);
    expect(plan.results).toEqual([]);
    expect(bulkSummary(b, plan).ok).toBe(false);
  });

  it('Given 同一个模型的两种写法 When canonicalPersist Then 字符串完全一致', () => {
    const a = draftModel({ id: 'm', contextWindow: '128K' });
    const b = draftModel({ id: 'm', contextWindow: '128000' });
    expect(canonicalPersist(a)).toBe(canonicalPersist(b));
  });
});

/* ================= R2-7 源非法时阻断复制 ================= */

describe('R2-7 复制时源的任一侧容量非法就整次阻断', () => {
  const provider = (models: Array<Record<string, unknown>>): ProviderDraft =>
    draftProvider({
      id: 'gpt-gateway',
      models: models.map((m) => draftModel({ id: String(m.id), contextWindow: m.contextWindow as string | undefined, maxTokens: m.maxTokens as string | undefined, name: m.name as string | undefined })),
    });

  it('Given 源 contextWindow 是 nope When bulkPlan Then errs.src 用 #8 的文案、C=0', () => {
    const p = provider([
      { id: 'src', name: 'Source', contextWindow: 'nope' },
      { id: 'dst', name: 'Dest', contextWindow: '64000' },
    ]);
    const b = { ...newBulk('gpt-gateway', [0, 1]), scope: 'sel' as const, selSnapshot: [0, 1], copy: 'copy' as const, src: 0 };
    const plan = bulkPlan(p, b);
    expect(plan.errs.src).toBe(T8_SRC);
    expect(plan.C).toBe(0);
    expect(plan.results).toEqual([]);
    expect(bulkSummary(b, plan).t).toBe(T8_SRC);
    expect(bulkSummary(b, plan).ok).toBe(false);
  });

  it('Given 源 maxTokens 是 nope When bulkPlan Then 同样阻断', () => {
    const p = provider([
      { id: 'src', name: 'Source', maxTokens: 'nope' },
      { id: 'dst', name: 'Dest' },
    ]);
    const b = { ...newBulk('gpt-gateway', [0, 1]), scope: 'sel' as const, selSnapshot: [0, 1], copy: 'copy' as const, src: 0 };
    expect(bulkPlan(p, b).errs.src).toBe(T8_SRC);
  });

  it('Given 阻断的复制 When applyBulk Then 目标模型完全不变', async () => {
    // 源上下文窗口非法，整次复制必须阻断、目标保持原样。
    const fake = createFakePort({
      pi: sliceWithProvider(piSlice(7), 'gpt-gateway', {
        api: 'openai-responses',
        apiKeyEnv: 'GPT_GATEWAY_API_KEY',
        models: [
          { id: 'src', name: 'Source', contextWindow: 'nope' },
          { id: 'dst', name: 'Dest', contextWindow: 64000, maxTokens: 1000 },
        ],
      }),
      ds: null,
      creds: defaultCreds(),
    });
    const store = createModelCapabilitiesStore(fake.port);
    await store.load();

    store.enter('gpt-gateway');
    store.selectAll();
    store.openBulk();
    store.patchBulk({ copy: 'copy', src: 0 });

    const plan = bulkPlan(store.getSnapshot().draft.providers['gpt-gateway'], store.getSnapshot().ui.bulk!);
    expect(plan.errs.src).toBe(T8_SRC);
    expect(plan.C).toBe(0);

    const targetBefore = JSON.stringify(store.getSnapshot().draft.providers['gpt-gateway'].models[1]);
    store.applyBulk();
    expect(JSON.stringify(store.getSnapshot().draft.providers['gpt-gateway'].models[1])).toBe(targetBefore);
    expect(store.getSnapshot().ops.dirty).toBe(0);
  });
});

/* ================= R2-8 底栏的旧字段提示句 ================= */

describe('R2-8 复制时源没有 input 的底栏提示句', () => {
  it('Given 源没有 input When 结果句 Then 含 #4 的整句', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [draftModel({ id: 'src', name: 'Source' }), draftModel({ id: 'dst', name: 'Dest' })],
    });
    const b = { ...newBulk('gpt-gateway', [0, 1]), scope: 'sel' as const, selSnapshot: [0, 1], copy: 'copy' as const, src: 0 };
    const plan = bulkPlan(p, b);
    expect(bulkResultMsg(b, plan)).toContain(T4_INPUT);
    expect(bulkPhrase(b, plan)).toBe('从 Source 复制');
  });

  it('Given 源有旧字段、没有 input When 结果句 Then 用 #4 的后半句', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [draftModel({ id: 'src', name: 'Source', inputModalities: ['text', 'image'] }), draftModel({ id: 'dst', name: 'Dest', input: ['text'] })],
    });
    const b = { ...newBulk('gpt-gateway', [0, 1]), scope: 'sel' as const, selSnapshot: [0, 1], copy: 'copy' as const, src: 0 };
    const plan = bulkPlan(p, b);
    expect(bulkResultMsg(b, plan)).toContain(T4_LEGACY);
  });

  it('Given 源没有 input When 结果句 Then 目标不会留下 input', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [draftModel({ id: 'src', name: 'Source' }), draftModel({ id: 'dst', name: 'Dest', input: ['text'] })],
    });
    const b = { ...newBulk('gpt-gateway', [0, 1]), scope: 'sel' as const, selSnapshot: [0, 1], copy: 'copy' as const, src: 0 };
    const next = bulkPlan(p, b).results[0].next;
    expect(next).not.toHaveProperty('input');
  });

  it('Given 只有旧字段的模型、inMode=clear When bulkSummary Then 附旧字段提示句', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'legacy', inputModalities: ['text', 'image'] })] });
    const b = { ...newBulk('gpt-gateway', []), inMode: 'clear' as const };
    const plan = bulkPlan(p, b);
    expect(plan.C).toBe(0);
    expect(plan.L).toBe(1);
    expect(bulkSummary(b, plan).t).toContain(LEGACY_HINT);
  });
});

/* ================= R2-9 请求头重复 ================= */

/**
 * R2F-5 修正：文案里的名称必须来自真实请求头名。原先「两个都是 A」「' A ' 与 'A'」「向导 A、A」三处
 * 断言的是写死的「A」、「B」句，这里改成只列真正重复的「A」；「A、B、A」与「A、B、A、B」两个用例
 * 的重复名恰好是 A 和 B，期望句不变。
 */
describe('R2-9 请求头名按 trim 后的非空值比较，重复时阻断保存', () => {
  it('Given 两个请求头名字不同 When routeErrors Then 无错误', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', headers: [{ k: 'A', v: '1' }, { k: 'B', v: '2' }] }));
    expect(e.headers).toBeUndefined();
  });

  it('Given 两个请求头名都是 A When routeErrors Then 用 #17 的逐字文案（只列重复的 A）', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', headers: [{ k: 'A', v: '1' }, { k: 'A', v: '2' }] }));
    expect(e.headers).toBe(T9_HEADERS_A);
  });

  it('Given 三个请求头 A、B、A When routeErrors Then 只列真正重复的名称（A），不列只出现一次的 B', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', headers: [{ k: 'A', v: '1' }, { k: 'B', v: '2' }, { k: 'A', v: '3' }] }));
    expect(e.headers).toBe(T9_HEADERS_A);
  });

  it('Given 只有大小写不同 When routeErrors Then 不报错（大小写敏感）', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', headers: [{ k: 'A', v: '1' }, { k: 'a', v: '2' }] }));
    expect(e.headers).toBeUndefined();
  });

  it('Given 名字带首尾空白 When routeErrors Then 按 trim 后比较（文案列 trim 后的名称）', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', headers: [{ k: ' A ', v: '1' }, { k: 'A', v: '2' }] }));
    expect(e.headers).toBe(T9_HEADERS_A);
  });

  it('Given 向导里同样的重复 When wizardErrors Then 用同一句文案', () => {
    const wizard = {
      step: 1 as const,
      api: 'openai-completions',
      id: 'fresh',
      tried2: false,
      ack: true,
      displayName: '',
      baseURL: '',
      env: '',
      envTouched: false,
      headersOpen: true,
      headers: [{ k: 'A', v: '1' }, { k: 'A', v: '2' }],
      models: ['m'],
    };
    expect(wizardErrors(wizard, { providers: {} }).headers).toBe(T9_HEADERS_A);
  });

  it('Given 重复的名称有 A、B 两个 When store 校验 Then errors.headers 用同一句文案', async () => {
    const fake = createFakePort({
      pi: sliceWithProvider(piSlice(7), 'hdr-gateway', {
        api: 'openai-responses',
        apiKeyEnv: 'HDR_API_KEY',
        headers: [{ k: 'A', v: '1' }, { k: 'B', v: '2' }, { k: 'A', v: '3' }, { k: 'B', v: '4' }],
        models: [],
      }),
      ds: null,
      creds: {},
    });
    const store = createModelCapabilitiesStore(fake.port);
    await store.load();
    expect(store.getSnapshot().errors['hdr-gateway'].route.headers).toBe(T9_HEADERS);
  });

  it('Given 重复的请求头 When fieldOut Then 返回 SKIP', () => {
    const p = draftProvider({ id: 'gpt-gateway', headers: [{ k: 'A', v: '1' }, { k: 'A', v: '2' }] });
    expect(fieldOut(p, 'headers')).toBe(SKIP);
  });

  it('Given 重复的请求头 When computeOps Then 不产生 headers op 但计入 dirty', () => {
    const base: DraftState = {
      providers: {
        'gpt-gateway': draftProvider({ id: 'gpt-gateway', api: 'openai-responses', apiKeyEnv: 'K', headers: [{ k: 'A', v: '1' }], models: [draftModel({ id: 'm' })] }),
      },
    };
    const draft = deepClone(base);
    draft.providers['gpt-gateway'].headers = [{ k: 'A', v: '1' }, { k: 'A', v: '2' }];
    const ops = computeOps(base, draft, {});
    expect(ops.pi.every((op) => !op.path.includes('headers'))).toBe(true);
    expect(ops.dirty).toBe(1);
  });

  it('Given 重复的请求头 When save Then 被阻断、不调用 mutate', async () => {
    const fake = createFakePort({
      pi: sliceWithProvider(piSlice(7), 'gpt-gateway', {
        api: 'openai-responses',
        apiKeyEnv: 'GPT_GATEWAY_API_KEY',
        headers: [{ k: 'A', v: '1' }],
        models: [{ id: 'm' }],
      }),
      ds: null,
      creds: {},
    });
    const store = createModelCapabilitiesStore(fake.port);
    await store.load();
    store.enter('gpt-gateway');
    store.openAccess();
    store.headerAdd('access');
    store.headerEdit('access', 1, 'k', 'A');
    store.headerEdit('access', 1, 'v', '2');

    expect(store.getSnapshot().errors['gpt-gateway']?.route?.headers).toBe(T9_HEADERS_A);

    await store.save();
    expect(fake.mutate).not.toHaveBeenCalled();
    expect(store.getSnapshot().ui.status).toBe('请先修正标红字段。');
  });
});

/* ================= R2-10 secretError ================= */

describe('R2-10 密钥预检的错误文案', () => {
  it('Given 非 ASCII 密钥 When secretError Then 用 #16 的逐字文案', () => {
    expect(secretError('中文密钥')).toBe(T10_SECRET);
  });

  it('Given 合规则的值 When secretError Then 空串', () => {
    expect(secretError('')).toBe('');
    expect(secretError('sk-abc=123')).toBe('');
    expect(secretError("sk'x")).toBe('');
  });
});

/* ================= R2-11 外部更新后保持在详情页 ================= */

describe('R2-11 无草稿时的外部更新保留 view/route/edit/bulk/sel/undo', () => {
  it('Given 停在详情页且开着编辑层 When document-updated Then 详情页与编辑层都保留', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.toggleAdv('m:gpt-gateway:0');
    store.selectIndex(1, true);

    const value = deepClone(piSlice(9).value);
    const providers = value.providers as Record<string, Record<string, unknown>>;
    providers['extra-gateway'] = { api: 'openai-responses', apiKeyEnv: 'EXTRA_API_KEY', models: [] };
    fake.setSlice(NS_PI, { ...piSlice(9), value });

    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(store.getSnapshot().revision.pi).toBe(9);
    });
    const snap = store.getSnapshot();
    expect(snap.ui.view).toBe('detail');
    expect(snap.ui.route).toBe('gpt-gateway');
    expect(snap.ui.edit).toEqual({ kind: 'model', route: 'gpt-gateway', idx: 0 });
    expect(snap.ui.menuIdx).toBeNull();
    expect(snap.ui.showAdv['m:gpt-gateway:0']).toBe(true);
    expect(snap.saveError).toBeNull();
    expect(snap.ui.conflict).toBe('hidden');
  });

  it('Given 批量层开着 When document-updated Then 批量层保留', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openBulk();
    const before = store.getSnapshot().ui.bulk;
    expect(before).not.toBeNull();

    fake.setSlice(NS_PI, piSlice(8));
    fake.emit('settings/document-updated', NS_PI, 8);

    await vi.waitFor(() => {
      expect(store.getSnapshot().revision.pi).toBe(8);
    });
    expect(store.getSnapshot().ui.view).toBe('detail');
    expect(store.getSnapshot().ui.bulk).not.toBeNull();
  });

  it('Given 向导开着 When document-updated Then 向导保留', async () => {
    const { fake, store } = setup();
    await store.load();
    store.openAddProvider();
    store.wizardPatch({ id: 'fresh-gateway' });

    fake.setSlice(NS_PI, piSlice(8));
    fake.emit('settings/document-updated', NS_PI, 8);

    await vi.waitFor(() => {
      expect(store.getSnapshot().revision.pi).toBe(8);
    });
    const snap = store.getSnapshot();
    expect(snap.ui.view).toBe('wizard');
    expect(snap.ui.wizard?.id).toBe('fresh-gateway');
  });

  it('Given 用户点「重新加载」 When resetFromDescribe Then 回到列表', async () => {
    const { store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.askReload();
    store.confirmDialog();

    await vi.waitFor(() => {
      expect(store.getSnapshot().ui.view).toBe('list');
    });
    expect(store.getSnapshot().ui.route).toBeNull();
  });
});

/* ================= R2-12 route 消失后回到列表 ================= */

describe('R2-12 外部更新后 route 不存在时回到列表', () => {
  it('Given 停在 cc-gateway 且开着编辑层 When 更新后该 route 消失 Then 回列表并关掉所有层', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('cc-gateway');
    store.openModel(0);
    store.openMenu(1);

    const value = deepClone(piSlice(9).value);
    const providers = value.providers as Record<string, unknown>;
    delete providers['cc-gateway'];
    fake.setSlice(NS_PI, { ...piSlice(9), value });

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
});

/* ================= R2-13 编辑层的 id 变化后关层 ================= */

describe('R2-13 编辑层按记录的模型 id 校验', () => {
  it('Given 编辑层打开的模型 id 变了 When document-updated Then 关层但留在详情页', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);

    fake.setSlice(NS_PI, sliceWithModels(piSlice(9), 'gpt-gateway', [
      { id: 'gpt-6-astra-v2', contextWindow: 272000, maxTokens: 128000 },
      { id: 'gpt-6-sol', contextWindow: 272000, maxTokens: 128000 },
      { id: 'gpt-6-terra', contextWindow: 272000, maxTokens: 128000 },
      { id: 'gpt-6-luna', contextWindow: 272000, maxTokens: 128000 },
    ], 9));

    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(store.getSnapshot().ui.edit).toBeNull();
    });
    const snap = store.getSnapshot();
    expect(snap.ui.view).toBe('detail');
    expect(snap.ui.route).toBe('gpt-gateway');
  });

  it('Given 编辑层下标越界 When document-updated Then 关层并丢弃越界 sel', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('cc-gateway');
    store.openModel(2);
    store.selectIndex(1, true);

    fake.setSlice(NS_PI, sliceWithModels(piSlice(9), 'cc-gateway', [{ id: 'only-one' }], 9));

    fake.emit('settings/document-updated', NS_PI, 9);

    await vi.waitFor(() => {
      expect(store.getSnapshot().ui.edit).toBeNull();
    });
    const snap = store.getSnapshot();
    expect(snap.ui.view).toBe('detail');
    expect(snap.ui.route).toBe('cc-gateway');
  });
});

/* ================= R2-14 保存后清空 sel/undo ================= */

describe('R2-14 设置和凭证都写入成功时 sel={}、undo=null', () => {
  it('Given 有待写入的改动和 sel/undo When save 成功 Then sel={} 且 undo=null', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.selectIndex(0, true);
    store.deleteModel(2);
    expect(store.getSnapshot().ui.undo).not.toBeNull();

    store.openModel(0);
    store.setModelName('Renamed');
    await store.save();

    const snap = store.getSnapshot();
    expect(snap.ui.saved).toBe(true);
    expect(snap.saveError).toBeNull();
    expect(snap.ui.sel).toEqual({});
    expect(snap.ui.undo).toBeNull();
  });

  it('Given 带密钥保存成功 When save Then sel/undo 同样清空', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.selectIndex(0, true);
    store.openModel(0);
    store.setModelName('Renamed');
    store.openAccess();
    store.setSecret('k9-topsecret');

    await store.save();

    const snap = store.getSnapshot();
    expect(snap.ui.sel).toEqual({});
    expect(snap.ui.undo).toBeNull();
    expect(snap.ops.cred).toEqual([]);
  });
});

/* ================= R2-15 #12 的冲突句 ================= */

describe('R2-15 本轮 pi 已写成功、ds 写失败时用 #12 的文案', () => {
  async function bothSidesDirty() {
    const result = setup({ fail: (ns) => (ns === NS_DS ? { code: 'settings/conflict' } : null) });
    await result.store.load();
    result.store.enter('gpt-gateway');
    result.store.openModel(0);
    result.store.setModelName('Renamed');
    result.store.enter(DS_ROUTE_ID);
    result.store.openModel(0);
    result.store.setCap('cw', '2000000');
    return result;
  }

  it('Given pi 成功、DS 冲突 When save Then saveError 逐字是 #12 的冲突句且清空 ui.status', async () => {
    const { store } = await bothSidesDirty();
    await store.save();

    const snap = store.getSnapshot();
    expect(snap.saveError).toBe(T12_CONFLICT);
    expect(snap.ui.status).toBe('');
    expect(snap.ui.conflict).toBe('shown');
  });

  it('Given pi 成功、DS 其它错误 When save Then 用 remoteErrorText 开头的 #12 第二种文案', async () => {
    const fake = createFakePort({
      pi: piSlice(7),
      ds: dsSlice(11),
      creds: defaultCreds(),
      fail: (ns) => (ns === NS_DS ? { code: 'gateway/bad-request' } : null),
    });
    const store = createModelCapabilitiesStore(fake.port);
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    store.enter(DS_ROUTE_ID);
    store.openModel(0);
    store.setCap('cw', '2000000');

    await store.save();
    expect(store.getSnapshot().saveError).toBe('请求无效。llm-pi-ai 已写入。llm-deepseek 这次没写入。你的修改还在。');
  });

  it('Given 本轮 pi 没写成功 When 冲突 Then 仍是「这次没写入」的冲突句', async () => {
    const fake = createFakePort({ pi: piSlice(7), ds: null, creds: defaultCreds(), fail: () => ({ code: 'settings/conflict' }) });
    const store = createModelCapabilitiesStore(fake.port);
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    await store.save();
    expect(store.getSnapshot().saveError).toBe('这份配置刚刚被别处改过，这次没写入。你的修改还在。');
  });
});

/* ================= R2-16 inFlight 期间先收到自己的回声、再收到外部 revision ================= */

describe('R2-16 inFlight 期间每收到一个回声都追加，落地后取出清空', () => {
  it('Given mutate 期间收到自己与外部两个 revision When save Then 用 #18 的文案且不 updateNamespace', async () => {
    const { fake, store } = setup({
      ds: null,
      emitDuringMutate: [[NS_PI, 8], [NS_PI, 99]],
      mutateResult: (ns, next) => ({ ...next, revision: 99 }),
    });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    await store.save();

    const snap = store.getSnapshot();
    expect(fake.mutate).toHaveBeenCalledTimes(1);
    expect(snap.ui.conflict).toBe('shown');
    // pi 是本轮第一个 ns 且结果未被采纳：没有「已写入」前缀。
    expect(snap.saveError).toBe(T18_FOREIGN);
    // foreign 非空：不 updateNamespace，所以 revision 与草稿都没被远端覆盖
    expect(snap.revision.pi).toBe(7);
    expect(snap.draft.providers['gpt-gateway'].models[0].name).toBe('Renamed');
    expect(snap.ops.dirty).toBeGreaterThan(0);
  });

  it('Given mutate 期间只收到自己的回声 When save Then 不显示冲突且 dirty=0', async () => {
    const { fake, store } = setup({ ds: null, emitDuringMutate: [[NS_PI, 8]] });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    await store.save();

    const snap = store.getSnapshot();
    expect(fake.mutate).toHaveBeenCalledTimes(1);
    expect(snap.ui.conflict).toBe('hidden');
    expect(snap.saveError).toBeNull();
    expect(snap.revision.pi).toBe(8);
    expect(snap.ops.dirty).toBe(0);
  });

  it('Given 写完之后再收到自己 revision 的重复回声 When 检查 Then 不误报冲突', async () => {
    const { fake, store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    await store.save();
    expect(store.getSnapshot().revision.pi).toBe(8);

    fake.emit('settings/document-updated', NS_PI, 8);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snap = store.getSnapshot();
    expect(snap.ui.conflict).toBe('hidden');
    expect(snap.saveError).toBeNull();
  });
});

/* ================= R2-17 inFlight 期间收到外部 revision 且返回非冲突错误 ================= */

describe('R2-17 非冲突错误且期间见过外部 revision', () => {
  it('Given mutate 期间收到外部 revision 且返回非冲突错误 When save Then 用 #18 的变体文案', async () => {
    const { fake, store } = setup({
      ds: null,
      emitDuringMutate: [[NS_PI, 98]],
      fail: () => ({ code: 'gateway/bad-request' }),
    });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    await store.save();

    const snap = store.getSnapshot();
    expect(fake.mutate).toHaveBeenCalledTimes(1);
    expect(snap.ui.conflict).toBe('shown');
    expect(snap.saveError).toBe(`请求无效。这次没写入。你的修改还在。${T18_STALE_SUFFIX}`);
    expect(snap.draft.providers['gpt-gateway'].models[0].name).toBe('Renamed');
  });

  it('Given 没收到任何回声且返回非冲突错误 When save Then 不用「远端配置已经变化」', async () => {
    const { store } = setup({ ds: null, fail: () => ({ code: 'gateway/bad-request' }) });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    await store.save();

    const snap = store.getSnapshot();
    expect(snap.saveError).not.toContain(T18_STALE_SUFFIX);
    expect(snap.saveError).toContain('请求无效');
  });
});

/* ================= R2-18 空白失焦时删除键 ================= */

describe('R2-18 blurCap 的四种情况', () => {
  it('Given 键不存在 When blurCap Then 直接返回，不新建键', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(1);
    // Every fixture model sets contextWindow, so clear it first to reach the "key absent" state.
    store.capClear('cw');
    expect(Object.prototype.hasOwnProperty.call(store.getSnapshot().draft.providers['gpt-gateway'].models[1], 'contextWindow')).toBe(false);

    store.blurCap('cw');
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[1].contextWindow).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(store.getSnapshot().draft.providers['gpt-gateway'].models[1], 'contextWindow')).toBe(false);
  });

  it('Given 值是空白 When blurCap Then 删除该键', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setCap('cw', '   ');
    store.blurCap('cw');

    const model = store.getSnapshot().draft.providers['gpt-gateway'].models[0];
    expect(Object.prototype.hasOwnProperty.call(model, 'contextWindow')).toBe(false);
    expect(model.contextWindow).toBeUndefined();
  });

  it('Given 值是 128K When blurCap Then 写成 128000', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setCap('cw', '128K');
    store.blurCap('cw');
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[0].contextWindow).toBe('128000');
  });

  it('Given 值是 nope When blurCap Then 保留原文', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setCap('cw', 'nope');
    store.blurCap('cw');
    expect(store.getSnapshot().draft.providers['gpt-gateway'].models[0].contextWindow).toBe('nope');
  });
});

/* ================= R2-19 menuIdx 置 null ================= */

describe('R2-19 openBulk 与 resetFromDescribe 都把 menuIdx 置 null', () => {
  it('Given 菜单开着 When openBulk Then menuIdx 置 null', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openMenu(2);
    expect(store.getSnapshot().ui.menuIdx).toBe(2);

    store.openBulk();
    expect(store.getSnapshot().ui.menuIdx).toBeNull();
  });

  it('Given 菜单开着 When resetFromDescribe（外部更新） Then menuIdx 置 null', async () => {
    const { fake, store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openMenu(1);

    fake.setSlice(NS_PI, piSlice(8));
    fake.emit('settings/document-updated', NS_PI, 8);

    await vi.waitFor(() => {
      expect(store.getSnapshot().revision.pi).toBe(8);
    });
    expect(store.getSnapshot().ui.menuIdx).toBeNull();
  });

  it('Given 菜单开着 When reload Then menuIdx 置 null', async () => {
    const { store } = setup();
    await store.load();
    store.enter('gpt-gateway');
    store.openMenu(3);

    await store.reload();
    expect(store.getSnapshot().ui.menuIdx).toBeNull();
  });
});

/* ================= R2-20 摘要为「图片」 ================= */

describe('R2-20 只勾图片时摘要为「图片」', () => {
  it('Given pi 模型 input=[image] When inputSummary Then 「图片」', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    expect(inputSummary(p, draftModel({ id: 'm', input: ['image'] }))).toBe('图片');
  });

  it('Given DS 模型 inputModalities=[image] When inputSummary Then 「图片」', () => {
    const p = draftProvider({ id: DS_ROUTE_ID, ns: NS_DS });
    expect(inputSummary(p, draftModel({ id: 'm', inputModalities: ['image'] }))).toBe('图片');
  });

  it('Given 只有图片的模型 When toggleInput/clearInput 之后 Then 摘要跟着变', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(1);
    store.toggleInput('model', 'image');
    expect(inputSummary(store.getSnapshot().draft.providers['gpt-gateway'], store.getSnapshot().draft.providers['gpt-gateway'].models[1])).toBe('图片');

    store.clearInput();
    expect(inputSummary(store.getSnapshot().draft.providers['gpt-gateway'], store.getSnapshot().draft.providers['gpt-gateway'].models[1])).toBe('未设置');
  });
});

/* ================= 契约第 1 节里两条容易漏的签名 ================= */

describe('R2 签名：capErrors 的越界文案与 CAP_FMT_ERR 的区别', () => {
  it('Given 格式非法 When 看文案 Then 用 CAP_FMT_ERR 而不是越界句', () => {
    const model = draftModel({ id: 'm', maxTokens: 'nope' });
    expect(modelErrors(draftProvider({ id: 'g', models: [model] }), model, 0).maxTokens).toBe(CAP_FMT_ERR);
  });
});

describe('R2 签名：pi 的旧字段 inputModalities 不被清除', () => {
  it('Given pi 模型同时有 input 与 inputModalities When clearInput Then 只删 input', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.enter('cc-gateway');
    store.openModel(0);
    store.toggleInput('model', 'text');
    store.clearInput();

    const model = store.getSnapshot().draft.providers['cc-gateway'].models[0];
    expect(model.input).toBeUndefined();
    expect(model.inputModalities).toEqual(['text', 'image']);
  });
});

/* ============================================================
 * R2F：R2 修复轮的 5 条 medium。每条都是红灯用例：下列断言在
 * 修复前的实现上必须失败，失败信息就是缺陷本身（见 docs/specs/model-capabilities.r2.md #11 / #17 / #18）。
 * ============================================================ */

/** 向导用例共用：一份填到能通过 wizardFinish 的 WizardDraft。 */
function wizardWithHeaders(headers: Array<{ k: string; v: string }>) {
  return {
    step: 1 as const,
    api: 'openai-completions',
    id: 'fresh',
    tried2: false,
    ack: true,
    displayName: '',
    baseURL: '',
    env: '',
    envTouched: false,
    headersOpen: true,
    headers,
    models: ['m1'],
  };
}

/* ================= R2F-1 三个事件都保持 keepView ================= */

/**
 * R2F-1（store.ts:366/370）：无草稿时 `llm/adapters-updated` 与 `connection/reset` 也必须走
 * `resetFromDescribe(undefined, { keepView: true })`，和 `settings/document-updated` 一致（#11）。
 * 现在是裸调 `resetFromDescribe()`，用户会被踢回列表。
 */
describe('R2F-1 无草稿时 llm/adapters-updated 与 connection/reset 也保持 keepView（#11）', () => {
  /**
   * handler 里的 `void resetFromDescribe()` 是纯微任务链（describe / credentials.describe 都是
   * 立即 resolve 的 mock），等一个宏任务就能确定它已经跑完，断言不会和它抢跑。
   */
  async function emitAndSettle(fake: ReturnType<typeof createFakePort>, event: string): Promise<void> {
    fake.emit(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.describe).toHaveBeenCalledTimes(2);
  }

  for (const event of ['llm/adapters-updated', 'connection/reset'] as const) {
    it(`Given 停在详情页且开着编辑层与勾选 When ${event} Then 详情页、route、编辑层与勾选都保留`, async () => {
      const { fake, store } = setup();
      await store.load();
      store.enter('gpt-gateway');
      store.openModel(0);
      store.toggleAdv('m:gpt-gateway:0');
      store.selectIndex(1, true);

      await emitAndSettle(fake, event);

      const snap = store.getSnapshot();
      expect(snap.ui.view).toBe('detail');
      expect(snap.ui.route).toBe('gpt-gateway');
      expect(snap.ui.edit).toEqual({ kind: 'model', route: 'gpt-gateway', idx: 0 });
      expect(snap.ui.sel['gpt-gateway']).toEqual([1]);
      expect(snap.ui.showAdv['m:gpt-gateway:0']).toBe(true);
      expect(snap.ui.menuIdx).toBeNull();
      expect(snap.saveError).toBeNull();
      expect(snap.ui.conflict).toBe('hidden');
    });

    it(`Given 向导开着 When ${event} Then 向导仍保持打开`, async () => {
      const { fake, store } = setup();
      await store.load();
      store.openAddProvider();
      store.wizardPatch({ id: 'fresh-gateway' });

      await emitAndSettle(fake, event);

      const snap = store.getSnapshot();
      expect(snap.ui.view).toBe('wizard');
      expect(snap.ui.wizard?.id).toBe('fresh-gateway');
    });
  }
});

/* ================= R2F-2 keepView 不丢 wizardSecret ================= */

/**
 * R2F-2（store.ts:243）：resetFromDescribe 在 keepView 分支之前无条件 `wizardSecret = ''`。
 * 结果是向导里已经输入的密钥被一次「无草稿的外部更新」清掉，wizardFinish 不再写凭证（#11 的
 * keepView 列表里明确含 wizardSecret）。
 */
describe('R2F-2 keepView 的外部更新不丢向导里已输入的密钥（#11）', () => {
  /** 打开向导 → 填到能完成 → 输入密钥 → 一次「无草稿的外部更新」 → 完成添加。 */
  async function finishWizardAfterUpdate() {
    const { fake, store } = setup({ ds: null });
    await store.load();
    store.openAddProvider();
    store.wizardPatch({ id: 'fresh-gateway', api: 'openai-completions', ack: true, models: ['m1'] });
    store.setWizardSecret('sk-live-1');

    fake.setSlice(NS_PI, piSlice(8));
    fake.emit('settings/document-updated', NS_PI, 8);
    await vi.waitFor(() => {
      expect(store.getSnapshot().revision.pi).toBe(8);
    });

    store.wizardFinish();
    return { fake, store };
  }

  it('Given 向导里已输入密钥 When settings/document-updated（无草稿）后完成向导 Then 凭证 op 仍在', async () => {
    const { store } = await finishWizardAfterUpdate();
    expect(store.getSnapshot().draft.providers['fresh-gateway']).toBeDefined();
    expect(store.getSnapshot().ops.cred).toEqual([{ op: 'set', ref: 'FRESH_GATEWAY_API_KEY' }]);
  });

  it('Given 向导里已输入密钥 When settings/document-updated（无草稿）后完成向导并保存 Then credentials.set 拿到的正是这条密钥', async () => {
    const { fake, store } = await finishWizardAfterUpdate();
    // R2F-6 之后「完成添加」会直接离开向导，这里可以直接保存。
    await store.save();

    expect(fake.credSet).toHaveBeenCalledTimes(1);
    expect(fake.credSet).toHaveBeenCalledWith('FRESH_GATEWAY_API_KEY', 'sk-live-1');
  });
});

/* ================= R2F-3 #18 的回声判定 ================= */

/**
 * R2F-3（store.ts:454）：外来回声必须用 `r !== result.value.revision` 判定，而不是乐观的
 * `revision + 1`；foreign 分支 break 之前仍要 `ownWrites.set(ns, result.value.revision)`；
 * 文案前缀用「本轮已写入的 namespace」。
 */
describe('R2F-3 #18 回声按 mutate 返回的 revision 判定，外来后仍记 ownWrites', () => {
  it('Given 回声 50 恰好等于 base+1、mutate 返回的却是 3 When save Then 判为外来：conflict=shown 且不 updateNamespace', async () => {
    const { fake, store } = setup({
      ds: null,
      pi: piSlice(49),
      emitDuringMutate: [[NS_PI, 50]],
      mutateResult: (ns, next) => ({ ...next, revision: 3 }),
    });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    await store.save();

    const snap = store.getSnapshot();
    expect(fake.mutate).toHaveBeenCalledTimes(1);
    // 打桩前提：写入用的 revision 是 49（revision+1 = 50 = 回声），返回的却是 3。
    expect(fake.mutate.mock.calls[0][2]).toBe(49);
    expect(snap.ui.conflict).toBe('shown');
    // pi 是本轮第一个 ns 且结果未被采纳：没有「已写入」前缀。
    expect(snap.saveError).toBe(T18_FOREIGN);
    // 外来：不 updateNamespace，revision 与草稿都不被远端覆盖。
    expect(snap.revision.pi).toBe(49);
    expect(snap.draft.providers['gpt-gateway'].models[0].name).toBe('Renamed');
    expect(snap.ops.dirty).toBeGreaterThan(0);
  });

  it('Given 外来 revision 是 50、返回 revision 是 3 When 之后收到自己的回声 3 Then 横幅文案不变', async () => {
    const { fake, store } = setup({
      ds: null,
      emitDuringMutate: [[NS_PI, 50]],
      mutateResult: (ns, next) => ({ ...next, revision: 3 }),
    });
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');

    await store.save();
    // 前置状态：这次写入被判为「写入期间远端又被改过」。
    expect(store.getSnapshot().ui.conflict).toBe('shown');
    expect(store.getSnapshot().saveError).toBe(T18_FOREIGN);

    fake.emit('settings/document-updated', NS_PI, 3);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snap = store.getSnapshot();
    // foreign 分支在 break 之前也要 ownWrites.set，否则这个自己的回声会被当成外部改动。
    expect(snap.saveError).not.toContain(T18_STALE_SUFFIX);
    expect(snap.saveError).toBe(T18_FOREIGN);
    expect(snap.ui.conflict).toBe('shown');
  });

  it('Given 只有 ds 有改动且它自己期间收到外来 revision When save Then 没有「已写入」前缀', async () => {
    const { store } = setup({
      pi: piSlice(7),
      emitDuringMutate: [[NS_DS, 99]],
      mutateResult: (ns, next) => ({ ...next, revision: 11 }),
    });
    await store.load();
    store.enter(DS_ROUTE_ID);
    store.openModel(0);
    store.setCap('cw', '2000000');

    await store.save();

    expect(store.getSnapshot().ui.conflict).toBe('shown');
    expect(store.getSnapshot().saveError).toBe(T18_FOREIGN);
  });

  it('Given pi 已写入、ds 期间收到外来 revision When save Then 前缀是已写入的 llm-pi-ai', async () => {
    const fake = createFakePort({ pi: piSlice(7), ds: dsSlice(10), creds: defaultCreds() });
    // 只在 llm-deepseek 的 mutate 进行中发一个外来回声（pi 的写入阶段不受影响）。
    const port: ModelCapabilitiesPort = {
      ...fake.port,
      mutate: async (ns, ops, rev) => {
        if (ns === NS_DS) fake.emit('settings/document-updated', NS_DS, 99);
        return fake.port.mutate(ns, ops, rev);
      },
    };
    const store = createModelCapabilitiesStore(port);
    await store.load();
    store.enter('gpt-gateway');
    store.openModel(0);
    store.setModelName('Renamed');
    store.enter(DS_ROUTE_ID);
    store.openModel(0);
    store.setCap('cw', '2000000');

    await store.save();

    const snap = store.getSnapshot();
    expect(snap.saveError).toBe(`llm-pi-ai 已写入。${T18_FOREIGN}`);
    expect(snap.ui.conflict).toBe('shown');
    expect(snap.revision.pi).toBe(8);
    expect(snap.revision.ds).toBe(10);
  });
});

/* ================= R2F-4 复制不搬旧字段 ================= */

/**
 * R2F-4（bulk.ts:120）：复制只按源的 `input` 去设置/删除目标的 `input`，目标的
 * `inputModalities` 原样保留（#4 后半句「不复制旧字段」）。
 */
describe('R2F-4 「从模型复制」不搬旧字段 inputModalities（#4）', () => {
  function copyPlan(src: ModelDraft, dst: ModelDraft) {
    const p = draftProvider({ id: 'gpt-gateway', models: [src, dst] });
    const b = { ...newBulk('gpt-gateway', [0, 1]), scope: 'sel' as const, selSnapshot: [0, 1], copy: 'copy' as const, src: 0 };
    return bulkPlan(p, b);
  }

  it('Given 源有旧字段、没有 input，目标没有旧字段 When 复制 Then 目标不会凭空多出 inputModalities，也没有 input', () => {
    const plan = copyPlan(
      draftModel({ id: 'src', name: 'Source', contextWindow: '128000', inputModalities: ['text', 'image'] }),
      draftModel({ id: 'dst', name: 'Dest', contextWindow: '64000' }),
    );

    expect(plan.C).toBe(1);
    const next = plan.results[0].next;
    expect(next).not.toHaveProperty('inputModalities');
    expect(next).not.toHaveProperty('input');
    expect(next.contextWindow).toBe('128000');
  });

  it('Given 源没有旧字段与 input，目标有自己的旧字段 When 复制 Then 目标的 inputModalities 原样保留', () => {
    const plan = copyPlan(
      draftModel({ id: 'src', name: 'Source', contextWindow: '128000' }),
      draftModel({ id: 'dst', name: 'Dest', contextWindow: '64000', inputModalities: ['text'] }),
    );

    expect(plan.C).toBe(1);
    expect(plan.results[0].next.inputModalities).toEqual(['text']);
  });

  it('Given 源有 input When 复制 Then 目标的 input 换成源的 input，旧字段仍按目标自己的值保留', () => {
    const plan = copyPlan(
      draftModel({ id: 'src', name: 'Source', contextWindow: '128000', input: ['image'] }),
      draftModel({ id: 'dst', name: 'Dest', contextWindow: '64000', input: ['text'], inputModalities: ['text'] }),
    );

    expect(plan.C).toBe(1);
    const next = plan.results[0].next;
    expect(next.input).toEqual(['image']);
    expect(next.inputModalities).toEqual(['text']);
  });
});

/* ================= R2F-5 重复请求头用真实名称 ================= */

/**
 * R2F-5（validate.ts:7）：#17 的文案把名称写死成「A」「B」，没用真实名称。
 */
describe('R2F-5 重复请求头文案用真实名称（#17）', () => {
  it('Given 两行请求头名是 X-Org 与「 X-Org 」 When routeErrors Then 文案里只有「X-Org」', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', headers: [{ k: 'X-Org', v: '1' }, { k: ' X-Org ', v: '2' }] }));
    expect(e.headers).toBe(T9_HEADERS_XORG);
  });

  it('Given 四个请求头 X-A、X-B、X-A、X-B When routeErrors Then 按首次出现顺序列出两个名字', () => {
    const e = routeErrors(draftProvider({
      id: 'gpt-gateway',
      headers: [{ k: 'X-A', v: '1' }, { k: 'X-B', v: '2' }, { k: 'X-A', v: '3' }, { k: 'X-B', v: '4' }],
    }));
    expect(e.headers).toBe(T9_HEADERS_XA_XB);
  });

  it('Given 向导里 X-Org 与「 X-Org 」重复 When wizardErrors Then 用同一句真实名称文案', () => {
    const e = wizardErrors(wizardWithHeaders([{ k: 'X-Org', v: '1' }, { k: ' X-Org ', v: '2' }]), { providers: {} });
    expect(e.headers).toBe(T9_HEADERS_XORG);
  });

  it('Given A、B、B、A When routeErrors Then 按首次出现顺序列出「A」、「B」', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', headers: [{ k: 'A', v: '1' }, { k: 'B', v: '2' }, { k: 'B', v: '3' }, { k: 'A', v: '4' }] }));
    expect(e.headers).toBe(T9_HEADERS);
  });

  it('Given 向导里 X-A、X-B 各重复一次 When wizardErrors Then 列出两个名字', () => {
    const e = wizardErrors(
      wizardWithHeaders([{ k: 'X-A', v: '1' }, { k: 'X-B', v: '2' }, { k: 'X-A', v: '3' }, { k: 'X-B', v: '4' }]),
      { providers: {} },
    );
    expect(e.headers).toBe(T9_HEADERS_XA_XB);
  });
});

/* ================= R2F-6 完成添加后离开向导 ================= */

/**
 * R2F-6（store.ts mutateDraft）：`publish({ ...patch, ui: { ...snapshot.ui, saved: false } })`
 * 把 patch.ui 覆盖掉了，所以 wizardFinish 设的 view/route/wizard 从未生效：点「完成添加」后仍停在向导，
 * 随后的 save 只会弹「还没添加完」而不写入。
 */
describe('R2F-6 「完成添加」后离开向导，保存能直接写入', () => {
  it('Given 向导已填好 When wizardFinish Then 进入新提供方的详情页，wizard 为 null', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.openAddProvider();
    store.wizardPatch({ id: 'fresh-gateway', api: 'openai-completions', ack: true, models: ['m1'] });
    store.wizardFinish();

    const ui = store.getSnapshot().ui;
    expect(ui.wizard).toBeNull();
    expect(ui.view).toBe('detail');
    expect(ui.route).toBe('fresh-gateway');
    expect(ui.saved).toBe(false);
  });

  it('Given 刚完成添加 When save Then 不弹「还没添加完」，直接 set [providers, fresh-gateway]', async () => {
    const { fake, store } = setup({ ds: null });
    await store.load();
    store.openAddProvider();
    store.wizardPatch({ id: 'fresh-gateway', api: 'openai-completions', ack: true, models: ['m1'] });
    store.wizardFinish();

    await store.save();

    expect(store.getSnapshot().ui.dialog).toBeNull();
    expect(fake.mutate).toHaveBeenCalledTimes(1);
    const ops = fake.mutate.mock.calls[0][1] as SettingsOp[];
    expect(ops.some((op) => op.op === 'set' && op.path.join('/') === 'providers/fresh-gateway')).toBe(true);
  });
});

/* ==========================================================================
 * R4b 流空闲超时（docs/specs/r4b-stream-idle-timeout.md 第 9 节）：R4b-1、R4b-2。
 *
 * 只追加用例，不动实现文件。
 * ========================================================================== */

const R4B_KEY = 'streamIdleTimeoutMs';

function r4bTimeoutOf(p: ProviderDraft): unknown {
  return (p as unknown as Record<string, unknown>)[R4B_KEY];
}

describe('R4b-1 新 fixture 不编辑 → 无 timeout op，schema 默认 300000 从不被 set/unset', () => {
  it('R4b-1 不做任何编辑：两侧 op 为空、dirty=0，DS 不把 value 层的 300000 当显式值', () => {
    const base = draftFromNamespaces({ pi: piSlice(7), ds: dsSlice(11), creds: defaultCreds() });

    // 显式值只来自 user 层：两个 pi 路由是 1800000，DS 没有显式值
    expect(r4bTimeoutOf(base.providers['gpt-gateway'])).toBe(1800000);
    expect(r4bTimeoutOf(base.providers['cc-gateway'])).toBe(1800000);
    expect(r4bTimeoutOf(base.providers[DS_ROUTE_ID])).toBeUndefined();
    for (const id of ['gpt-gateway', 'cc-gateway', DS_ROUTE_ID]) {
      expect(base.providers[id].extra, `${id}.extra`).not.toHaveProperty(R4B_KEY);
    }

    const ops = computeOps(base, deepClone(base), {});
    expect(ops.pi.filter((op) => op.path.includes(R4B_KEY))).toEqual([]);
    expect(ops.ds.filter((op) => op.path.includes(R4B_KEY))).toEqual([]);
    expect(ops.dirty).toBe(0);
    expect(ops.dirtySet.size).toBe(0);

    // schema 默认 300000 从不被写：既没有 set 也没有 unset 带着这个值
    expect(JSON.stringify(ops)).not.toContain('300000');
  });

  it('R4b-1 load 之后同样：dirty=0，DS 的 300000 不产生任何 op', async () => {
    const { fake, store } = setup();
    await store.load();

    const snap = store.getSnapshot();
    expect(snap.ops.dirty).toBe(0);
    expect(r4bTimeoutOf(snap.draft.providers[DS_ROUTE_ID])).toBeUndefined();
    expect(snap.ops.ds).toEqual([]);
    expect(fake.mutate).not.toHaveBeenCalled();
  });
});

describe('R4b-2 向导新建对象带 1800000，仍无 6 个默认键', () => {
  it('R4b-2 默认向导 finish → 新建对象 streamIdleTimeoutMs=1800000，且没有 6 个默认键', async () => {
    const { store } = setup({ ds: null });
    await store.load();
    store.openAddProvider();
    store.wizardPatch({ api: 'openai-completions', id: 'fresh-gateway', ack: true, models: ['fresh-model'] });
    store.wizardFinish();

    const op = store.getSnapshot().ops.pi[0];
    expect(op.op).toBe('set');
    const value = (op as Extract<SettingsOp, { op: 'set' }>).value as Record<string, unknown>;
    expect(value[R4B_KEY]).toBe(1800000);
    expect(typeof value[R4B_KEY]).toBe('number');
    const keys = Object.keys(value);
    expect(keys.indexOf(R4B_KEY)).toBeLessThan(keys.indexOf('models'));
    for (const key of [...PI_DEFAULT_KEYS, ...DS_DEFAULT_KEYS]) {
      expect(value, `新建对象不应带 ${key}`).not.toHaveProperty(key);
    }
  });
});
