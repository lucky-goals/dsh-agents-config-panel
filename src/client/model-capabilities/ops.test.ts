/**
 * ops.ts 用例清单。
 *
 * R2 增量（docs/specs/model-capabilities.r2.md 第 1.3、2、5 节）：
 * - 6 个默认键既不在草稿里也不在 extra 里；
 * - 新建的对象里没有这 6 个键；
 * - 重复请求头不产生 set（routeErrors 已经阻断，fieldOut 返回 SKIP）；
 * - routeWrite 没有 length。
 */
import { describe, expect, it } from 'vitest';
import { computeOps, draftFromNamespaces, fieldOut, modelOut, modelWrite, previewText, remoteErrorText, SKIP } from './ops';
import type { DraftState, OpsResult, ProviderDraft, SettingsOp, SettingsOpSet } from './types';
import { DS_ROUTE_ID } from './types';
import { deepClone, defaultCreds, draftModel, draftProvider, dsSlice, piSlice } from './test-fixtures';

/** 6 个提供方级默认键：只进 known，不进草稿字段，不进 extra（pi 4 个 + DS 2 个）。 */
const DEFAULT_KEYS_PI = ['defaultInput', 'reasoning', 'defaultContextWindow', 'defaultMaxTokens'] as const;
const DEFAULT_KEYS_DS = ['defaultContextWindow', 'maxTokens'] as const;

function modelOpValue(op: SettingsOp | undefined): Array<Record<string, unknown>> {
  if (!op || op.op !== 'set') throw new Error('expected a set op');
  return op.value as Array<Record<string, unknown>>;
}

function hasLength(value: object): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'length');
}

describe('ops.draftFromNamespaces / computeOps', () => {
  it('Given value 与 user 都带 6 个默认键、不做编辑 When computeOps Then 两侧 op 为空且 dirty=0', () => {
    const base = draftFromNamespaces({ pi: piSlice(), ds: dsSlice(), creds: defaultCreds() });

    // 6 个默认键既不在草稿字段里，也不在 extra 里
    const gpt = base.providers['gpt-gateway'];
    const cc = base.providers['cc-gateway'];
    const ds = base.providers[DS_ROUTE_ID];
    for (const key of DEFAULT_KEYS_PI) {
      expect((gpt as unknown as Record<string, unknown>)[key], `gpt-gateway.${key}`).toBeUndefined();
      expect(gpt.extra[key], `gpt-gateway.extra.${key}`).toBeUndefined();
      expect((cc as unknown as Record<string, unknown>)[key], `cc-gateway.${key}`).toBeUndefined();
      expect(cc.extra[key], `cc-gateway.extra.${key}`).toBeUndefined();
    }
    for (const key of DEFAULT_KEYS_DS) {
      expect((ds as unknown as Record<string, unknown>)[key], `deepseek.${key}`).toBeUndefined();
      expect(ds.extra[key], `deepseek.extra.${key}`).toBeUndefined();
    }
    // DS 的 models 也来自 value，不当成默认键丢弃
    expect(ds.models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);

    const ops = computeOps(base, deepClone(base), {});
    expect(ops.pi).toEqual([]);
    expect(ops.ds).toEqual([]);
    expect(ops.cred).toEqual([]);
    expect(ops.dirty).toBe(0);
    expect(ops.dirtySet.size).toBe(0);
  });

  it('Given ds 的 user 没有 models、value.models 有 2 项 When 改第一项 inputModalities Then 只有一条 set [models]，值为 2 项整表', () => {
    const base = draftFromNamespaces({ pi: null, ds: dsSlice(), creds: defaultCreds() });
    const draft = deepClone(base);
    draft.providers[DS_ROUTE_ID].models[0].inputModalities = ['text'];

    const ops = computeOps(base, draft, {});
    expect(ops.pi).toEqual([]);
    expect(ops.ds).toHaveLength(1);
    expect(ops.ds[0].op).toBe('set');
    expect(ops.ds[0].path).toEqual(['models']);
    expect(modelOpValue(ops.ds[0])).toEqual([
      { id: 'deepseek-flash', name: 'V41-Flash', inputModalities: ['text'] },
      { id: 'deepseek-v4-pro', inputModalities: ['text'] },
    ]);
    expect(ops.dirty).toBe(1);
  });

  it('Given user 层模型有 inputModalities、value 层没有 When draftFromNamespaces Then 草稿保留该数组', () => {
    const slice = piSlice();
    const value = deepClone(slice.value);
    const providers = value.providers as Record<string, Record<string, unknown>>;
    const models = providers['gpt-gateway'].models as Array<Record<string, unknown>>;
    delete models[0].inputModalities;

    const draft = draftFromNamespaces({ pi: { ...slice, value }, ds: null, creds: defaultCreds() });
    expect(draft.providers['gpt-gateway'].models).toHaveLength(4);
    expect(draft.providers['gpt-gateway'].models[0].id).toBe('gpt-6-astra');
    expect(draft.providers['gpt-gateway'].models[0].inputModalities).toEqual(['text', 'image']);
  });

  it('Given 容量填了 nope When computeOps Then 不产出容量 op，但 dirty 记 1', () => {
    const base: DraftState = {
      providers: {
        g: draftProvider({ id: 'g', models: [draftModel({ id: 'm', contextWindow: '272000', maxTokens: '128000' })] }),
      },
    };
    const draft = deepClone(base);
    draft.providers.g.models[0].contextWindow = 'nope';

    const ops = computeOps(base, draft, {});
    expect(ops.pi.every((op) => !op.path.includes('contextWindow'))).toBe(true);
    expect(ops.pi.every((op) => !op.path.includes('maxTokens'))).toBe(true);
    expect(ops.dirty).toBe(1);

    const modelsOp = ops.pi.find((op) => op.path.join('.') === 'providers.g.models');
    expect(modelsOp).toBeDefined();
    expect(modelOpValue(modelsOp)[0]).not.toHaveProperty('contextWindow');
    expect(modelOpValue(modelsOp)[0]).not.toHaveProperty('maxTokens');
  });
});

describe('ops.modelWrite', () => {
  it('Given pi 模型的 extra 里有 imagePixelBudget、容量键已被清掉 When modelWrite Then 保留 extra 且容量键不回来', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    const m = draftModel({ id: 'gpt-6-astra', name: 'Nova', extra: { imagePixelBudget: 1000, compat: { tone: 'x' } } });

    const out = modelWrite(p, m);
    expect(out.id).toBe('gpt-6-astra');
    expect(out.name).toBe('Nova');
    expect(out.imagePixelBudget).toBe(1000);
    expect(out.compat).toEqual({ tone: 'x' });
    expect(out).not.toHaveProperty('contextWindow');
    expect(out).not.toHaveProperty('maxTokens');

    // extra 只在整表写入时铺上，modelOut 本身不带
    expect(modelOut(p, m)).not.toHaveProperty('imagePixelBudget');
  });
});

describe('ops.computeOps（提供方增删与 DeepSeek path）', () => {
  it('Given 新建提供方 mine When computeOps Then set [providers, mine]，值为完整对象', () => {
    const base: DraftState = { providers: {} };
    const draft: DraftState = {
      providers: {
        mine: draftProvider({
          id: 'mine',
          api: 'openai-completions',
          baseURL: 'https://mine.invalid',
          apiKeyEnv: 'MINE_API_KEY',
          models: [draftModel({ id: 'gpt-6-nova', name: 'Nova', contextWindow: '128000' })],
        }),
      },
    };

    const ops = computeOps(base, draft, {});
    expect(ops.pi).toHaveLength(1);
    expect(ops.pi[0].op).toBe('set');
    expect(ops.pi[0].path).toEqual(['providers', 'mine']);
    expect(modelOpValue(ops.pi[0] as SettingsOpSet).length).toBe(1);
    const value = (ops.pi[0] as SettingsOpSet).value as Record<string, unknown>;
    expect(value.api).toBe('openai-completions');
    expect(value.baseURL).toBe('https://mine.invalid');
    expect(value.apiKeyEnv).toBe('MINE_API_KEY');
    expect(value.models).toEqual([{ id: 'gpt-6-nova', name: 'Nova', contextWindow: 128000 }]);
    // 新建的对象里没有 6 个默认键
    for (const key of [...DEFAULT_KEYS_PI, ...DEFAULT_KEYS_DS]) {
      expect(value).not.toHaveProperty(key);
    }
    expect(ops.dirty).toBe(1);
  });

  it('Given 删除提供方 mine When computeOps Then unset [providers, mine]', () => {
    const base: DraftState = {
      providers: { mine: draftProvider({ id: 'mine', api: 'openai-completions', models: [draftModel({ id: 'm' })] }) },
    };
    const draft: DraftState = { providers: {} };

    const ops = computeOps(base, draft, {});
    expect(ops.pi).toEqual([{ op: 'unset', path: ['providers', 'mine'] }]);
    expect(ops.dirty).toBe(1);
  });

  it('Given 修改 DeepSeek 的 thinking When computeOps Then path 是 [thinking]，不出现 deepseek-official 或 providers', () => {
    const base: DraftState = {
      providers: {
        [DS_ROUTE_ID]: draftProvider({
          id: DS_ROUTE_ID,
          ns: 'llm-deepseek',
          thinking: 'enabled',
          reasoningEffort: 'high',
          models: [draftModel({ id: 'deepseek-flash' })],
        }),
      },
    };
    const draft = deepClone(base);
    draft.providers[DS_ROUTE_ID].thinking = 'disabled';

    const ops = computeOps(base, draft, {});
    expect(ops.pi).toEqual([]);
    expect(ops.ds).toEqual([{ op: 'set', path: ['thinking'], value: 'disabled' }]);
    expect(JSON.stringify(ops)).not.toContain(DS_ROUTE_ID);
    expect(JSON.stringify(ops)).not.toContain('providers');
  });

  it('Given 草稿里请求头名 trim 后重复 When computeOps Then 不产出 headers set，但计入 dirty', () => {
    const models = [draftModel({ id: 'm' })];
    const base: DraftState = {
      providers: {
        'gpt-gateway': draftProvider({
          id: 'gpt-gateway',
          api: 'openai-responses',
          apiKeyEnv: 'GPT_GATEWAY_API_KEY',
          headers: [{ k: 'X-A', v: '1' }],
          models,
        }),
      },
    };

    const keep = computeOps(base, deepClone(base), {});
    expect(keep.pi.every((op) => !op.path.includes('headers'))).toBe(true);
    expect(keep.dirty).toBe(0);

    const draft = deepClone(base);
    draft.providers['gpt-gateway'].headers = [{ k: 'X-A', v: '1' }, { k: ' X-A ', v: '3' }];

    const ops = computeOps(base, draft, {});
    expect(ops.pi.every((op) => !op.path.includes('headers'))).toBe(true);
    expect(ops.dirty).toBe(1);
  });

  it('Given routeWrite 的产物 When 检查 Then 没有不可枚举的 length', () => {
    const base: DraftState = { providers: {} };
    const draft: DraftState = {
      providers: { mine: draftProvider({ id: 'mine', api: 'openai-completions', models: [draftModel({ id: 'm' })] }) },
    };
    const op = computeOps(base, draft, {}).pi[0];
    if (!op || op.op !== 'set') throw new Error('新建提供方没有 set op');
    const value = op.value as Record<string, unknown>;
    expect(hasLength(value)).toBe(false);
    expect(Object.getOwnPropertyNames(value)).not.toContain('length');
  });

  it('Given 请求头名只有大小写不同 When fieldOut Then 返回字典（不被阻断）', () => {
    const p = draftProvider({ id: 'gpt-gateway', headers: [{ k: 'X-A', v: '1' }, { k: 'x-a', v: '2' }] });
    expect(fieldOut(p, 'headers')).toEqual({ 'X-A': '1', 'x-a': '2' });
  });

  it('Given 请求头名 trim 后重复 When fieldOut Then 返回 SKIP', () => {
    const p = draftProvider({ id: 'gpt-gateway', headers: [{ k: 'X-A', v: '1' }, { k: ' X-A ', v: '2' }] });
    expect(fieldOut(p, 'headers')).toBe(SKIP);
  });
});

describe('ops.previewText', () => {
  it('Given secrets.mine 有值 When computeOps Then cred 用 deriveEnv 得到的 ref', () => {
    const base: DraftState = { providers: {} };
    const draft: DraftState = {
      providers: { mine: draftProvider({ id: 'mine', api: 'openai-completions', models: [draftModel({ id: 'm' })] }) },
    };

    const ops = computeOps(base, draft, { mine: 'k9-topsecret' });
    expect(ops.cred).toEqual([{ op: 'set', ref: 'MINE_API_KEY' }]);

    const text = previewText(ops, { pi: 7, ds: null });
    expect(text).toContain('llm-pi-ai');
    expect(text).toContain('credentials.set');
    expect(text).toContain('（值不展示）');
    expect(text).toContain('MINE_API_KEY');
    expect(text).not.toContain('k9-topsecret');
  });

  it('Given 一条 set models 的 op When previewText Then path 行为 YAML flow 数组 `path: [providers, mine, models]`', () => {
    const ops: OpsResult = {
      pi: [{ op: 'set', path: ['providers', 'mine', 'models'], value: [{ id: 'gpt-6-nova' }] }],
      ds: [],
      cred: [],
      dirty: 1,
      dirtySet: new Set(['mine']),
    };
    const text = previewText(ops, { pi: 3, ds: null });
    expect(text).toContain('path: [providers, mine, models]');
    expect(text).toContain('llm-pi-ai');
  });
});

describe('ops.remoteErrorText', () => {
  it('Given settings/rejected When remoteErrorText Then 「配置被拒绝」，details 接在后面', () => {
    expect(remoteErrorText({ code: 'settings/rejected' })).toBe('配置被拒绝');
    expect(remoteErrorText({ code: 'settings/rejected', details: 'schema' })).toContain('配置被拒绝');
    expect(remoteErrorText({ code: 'settings/rejected', details: 'schema' })).toContain('schema');
    expect(remoteErrorText({ code: 'settings/rejected', details: { message: 'boom' } })).toContain('boom');
  });

  it('Given gateway/bad-request When remoteErrorText Then 「请求无效」', () => {
    expect(remoteErrorText({ code: 'gateway/bad-request' })).toBe('请求无效');
  });

  it('Given 其它错误码 When remoteErrorText Then 「保存失败（<code>）」', () => {
    expect(remoteErrorText({ code: 'settings/teapot' })).toBe('保存失败（settings/teapot）');
  });
});

/* ==========================================================================
 * R4b 流空闲超时（docs/specs/r4b-stream-idle-timeout.md 第 4 节）：O1–O5。
 *
 * 只追加用例，不动 ops.ts。timeoutText / streamIdleTimeoutMs 现在还不是
 * ProviderDraft 的字段，用下面的小工具绕过类型，保证这些用例失败在断言上。
 * ========================================================================== */

const T_KEY = 'streamIdleTimeoutMs';

function timeoutOf(p: ProviderDraft): unknown {
  return (p as unknown as Record<string, unknown>)[T_KEY];
}

function setTimeoutMs(p: ProviderDraft, ms: number | undefined): void {
  const raw = p as unknown as Record<string, unknown>;
  if (ms === undefined) delete raw[T_KEY];
  else raw[T_KEY] = ms;
}

function setTimeoutText(p: ProviderDraft, text: string): void {
  (p as unknown as Record<string, unknown>).timeoutText = text;
}

describe('R4b O1 fixture 对称：显式值进草稿字段、value 层默认不进 extra、不编辑无 op', () => {
  it('O1 新 fixture load → gpt/cc=1800000、DS undefined、extra 无该键、computeOps 空且 dirty=0', () => {
    const base = draftFromNamespaces({ pi: piSlice(), ds: dsSlice(), creds: defaultCreds() });

    expect(timeoutOf(base.providers['gpt-gateway'])).toBe(1800000);
    expect(timeoutOf(base.providers['cc-gateway'])).toBe(1800000);
    // DS 只有 value 层的 schema 默认 300000；user 层没有这个键 → 草稿不设（不读 value 层）
    expect(timeoutOf(base.providers[DS_ROUTE_ID])).toBeUndefined();

    for (const id of ['gpt-gateway', 'cc-gateway', DS_ROUTE_ID]) {
      expect(base.providers[id].extra, `${id}.extra`).not.toHaveProperty(T_KEY);
    }

    const ops = computeOps(base, deepClone(base), {});
    expect(ops.pi).toEqual([]);
    expect(ops.ds).toEqual([]);
    expect(ops.dirty).toBe(0);
    expect(ops.dirtySet.size).toBe(0);
  });
});

describe('R4b O2 set / unset 与 DS 的 path', () => {
  it('O2 pi 改 3600000 → set [providers, gpt-gateway, streamIdleTimeoutMs]，value 是 JS number', () => {
    const base = draftFromNamespaces({ pi: piSlice(), ds: dsSlice(), creds: defaultCreds() });
    const draft = deepClone(base);
    setTimeoutMs(draft.providers['gpt-gateway'], 3600000);

    const ops = computeOps(base, draft, {});
    expect(ops.pi).toEqual([{ op: 'set', path: ['providers', 'gpt-gateway', 'streamIdleTimeoutMs'], value: 3600000 }]);
    expect(typeof (ops.pi[0] as SettingsOpSet).value).toBe('number');
    expect(ops.dirty).toBe(1);
  });

  it('O2 删掉显式值 → unset 同一路径', () => {
    const base = draftFromNamespaces({ pi: piSlice(), ds: dsSlice(), creds: defaultCreds() });
    const draft = deepClone(base);
    setTimeoutMs(draft.providers['gpt-gateway'], undefined);

    expect(computeOps(base, draft, {}).pi).toEqual([
      { op: 'unset', path: ['providers', 'gpt-gateway', 'streamIdleTimeoutMs'] },
    ]);
  });

  it('O2 DS 设 1800000 → ds 里的 path 是 [streamIdleTimeoutMs]，不出现 deepseek-official', () => {
    const base = draftFromNamespaces({ pi: piSlice(), ds: dsSlice(), creds: defaultCreds() });
    const draft = deepClone(base);
    setTimeoutMs(draft.providers[DS_ROUTE_ID], 1800000);

    const ops = computeOps(base, draft, {});
    expect(ops.ds).toEqual([{ op: 'set', path: ['streamIdleTimeoutMs'], value: 1800000 }]);
    expect(JSON.stringify(ops)).not.toContain(DS_ROUTE_ID);
    expect(JSON.stringify(ops)).not.toContain('providers');
  });
});

describe('R4b O3 timeoutText 的三条规则', () => {
  it('O3 text=30 与 base 1800000 相同 → 无 op、dirty=0', () => {
    const base = draftFromNamespaces({ pi: piSlice(), ds: dsSlice(), creds: defaultCreds() });
    const draft = deepClone(base);
    setTimeoutText(draft.providers['gpt-gateway'], '30');

    const ops = computeOps(base, draft, {});
    expect(ops.pi).toEqual([]);
    expect(ops.dirty).toBe(0);
  });

  it('O3 text=abc → 无 op 但 dirty=1（非法原文必然是编辑）', () => {
    const base = draftFromNamespaces({ pi: piSlice(), ds: dsSlice(), creds: defaultCreds() });
    const draft = deepClone(base);
    setTimeoutText(draft.providers['gpt-gateway'], 'abc');

    const ops = computeOps(base, draft, {});
    expect(ops.pi).toEqual([]);
    expect(ops.dirty).toBe(1);
  });

  it('O3 text 清空 → unset', () => {
    const base = draftFromNamespaces({ pi: piSlice(), ds: dsSlice(), creds: defaultCreds() });
    const draft = deepClone(base);
    setTimeoutText(draft.providers['gpt-gateway'], '');

    expect(computeOps(base, draft, {}).pi).toEqual([
      { op: 'unset', path: ['providers', 'gpt-gateway', 'streamIdleTimeoutMs'] },
    ]);
  });
});

describe('R4b O4 新建提供方：有值才写，且写在 models 之前', () => {
  const base: DraftState = { providers: {} };

  it('O4 ms=1800000 → set 对象含 streamIdleTimeoutMs:1800000 且在 models 前', () => {
    const mine = draftProvider({ id: 'mine', api: 'openai-completions', models: [draftModel({ id: 'm' })] });
    setTimeoutMs(mine, 1800000);
    const ops = computeOps(base, { providers: { mine } }, {});

    expect(ops.pi).toHaveLength(1);
    expect(ops.pi[0].op).toBe('set');
    const value = (ops.pi[0] as SettingsOpSet).value as Record<string, unknown>;
    expect(value[T_KEY]).toBe(1800000);
    expect(typeof value[T_KEY]).toBe('number');
    const keys = Object.keys(value);
    expect(keys.indexOf(T_KEY)).toBeLessThan(keys.indexOf('models'));
  });

  it('O4 没有值 → 新建对象里没有这个键', () => {
    const mine = draftProvider({ id: 'mine', api: 'openai-completions', models: [draftModel({ id: 'm' })] });
    const ops = computeOps(base, { providers: { mine } }, {});

    const value = (ops.pi[0] as SettingsOpSet).value as Record<string, unknown>;
    expect(Object.keys(value)).not.toContain(T_KEY);
  });
});

describe('R4b O5 user 层是非 number 的异常值：丢弃，不报错、不进 extra、不产 op', () => {
  it('O5 user 写字符串 "1800000" → 草稿 undefined、extra 无键、无 op', () => {
    const slice = piSlice(7);
    const value = deepClone(slice.value);
    const user = deepClone(slice.user ?? {});
    const userProviders = user.providers as Record<string, Record<string, unknown>>;
    userProviders['gpt-gateway'][T_KEY] = '1800000';

    const base = draftFromNamespaces({ pi: { ...slice, value, user }, ds: null, creds: defaultCreds() });
    expect(timeoutOf(base.providers['gpt-gateway'])).toBeUndefined();
    expect(base.providers['gpt-gateway'].extra).not.toHaveProperty(T_KEY);

    const ops = computeOps(base, deepClone(base), {});
    expect(ops.pi).toEqual([]);
    expect(ops.dirty).toBe(0);
  });
});
