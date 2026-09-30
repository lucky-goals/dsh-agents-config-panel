/**
 * ops.ts 用例清单（docs/specs/model-capabilities.tests.md）。
 * W1a：现在应为红，失败原因是桩抛 `not implemented`。
 */
import { describe, expect, it } from 'vitest';
import { computeOps, draftFromNamespaces, modelOut, modelWrite, previewText, remoteErrorText } from './ops';
import type { DraftState, OpsResult, SettingsOp, SettingsOpSet } from './types';
import { DS_ROUTE_ID } from './types';
import { deepClone, defaultCreds, draftModel, draftProvider, dsSlice, piSlice } from './test-fixtures';

function modelOpValue(op: SettingsOp | undefined): Array<Record<string, unknown>> {
  if (!op || op.op !== 'set') throw new Error('expected a set op');
  return op.value as Array<Record<string, unknown>>;
}

describe('ops.draftFromNamespaces / computeOps', () => {
  it('Given value 里有 defaultContextWindow=262144、user 没有、不做编辑 When computeOps Then 两侧 op 为空且 dirty=0', () => {
    const base = draftFromNamespaces({ pi: piSlice(), ds: dsSlice(), creds: defaultCreds() });
    // value 上的 schema 默认不等于用户覆盖：不放进草稿
    expect(base.providers['gpt-gateway'].defaultContextWindow).toBeUndefined();
    expect(base.providers['gpt-gateway'].defaultMaxTokens).toBeUndefined();
    // user 上有 defaultInput，是真实覆盖
    expect(base.providers['cc-gateway'].defaultInput).toEqual(['text']);

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
