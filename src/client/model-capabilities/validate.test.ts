/**
 * validate.ts 用例清单（docs/specs/model-capabilities.tests.md）。
 * W1a：现在应为红，失败原因是桩抛 `not implemented`。
 */
import { describe, expect, it } from 'vitest';
import {
  allErrors,
  idWarn,
  modelCapBad,
  modelErrors,
  providerIdError,
  routeCapBad,
  routeErrors,
  secretError,
} from './validate';
import { CAP_FMT_ERR, type DraftState } from './types';
import { draftModel, draftProvider } from './test-fixtures';

describe('validate.modelErrors（模型 ID）', () => {
  it('Given 模型 ID 为空或纯空白 When modelErrors Then 「填写模型 ID」', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: '' })] });
    expect(modelErrors(p, draftModel({ id: '' }), 0).id).toBe('填写模型 ID');
    expect(modelErrors(p, draftModel({ id: '   ' }), 0).id).toBe('填写模型 ID');
  });

  it('Given 模型 ID 含空格 When modelErrors Then 「ID 不能包含空格」', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    expect(modelErrors(p, draftModel({ id: 'gpt 6' }), 0).id).toBe('ID 不能包含空格');
  });

  it('Given 同一提供方里已有同名模型 When modelErrors Then 「这个提供方里已有同名模型」', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'dup' }), draftModel({ id: 'dup' })] });
    expect(modelErrors(p, p.models[1], 1).id).toBe('这个提供方里已有同名模型');
    expect(modelErrors(p, p.models[0], 0).id).toBeUndefined();
  });
});

describe('validate.modelErrors（思考档位）', () => {
  it('Given pi 模型的 reasoningEfforts 为空对象 When modelErrors Then 「勾选至少一档，或改为不思考。」', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    expect(modelErrors(p, draftModel({ id: 'm', reasoningEfforts: {} }), 0).efforts).toBe('勾选至少一档，或改为不思考。');
  });

  it('Given 某档的线上拼写为空串 When modelErrors Then spell_<档位> 出错', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    const m = draftModel({ id: 'm', reasoningEfforts: { low: '', high: 'high' } });
    const e = modelErrors(p, m, 0);
    expect(e.spell_low).toBe('线上拼写不能为空；与档名相同或写成 null。');
    expect(e.spell_high).toBeUndefined();
    expect(e.efforts).toBeUndefined();
  });

  it('Given reasoningEfforts 写成 false（不思考）When modelErrors Then 不报档位错误', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    expect(modelErrors(p, draftModel({ id: 'm', reasoningEfforts: false }), 0).efforts).toBeUndefined();
  });
});

describe('validate.providerIdError / idWarn', () => {
  const d: DraftState = { providers: { mine: draftProvider({ id: 'mine', api: 'openai-completions' }) } };

  it('Given 提供方 ID 为空 When providerIdError Then 「填写提供方 ID」', () => {
    expect(providerIdError('', d)).toBe('填写提供方 ID');
    expect(providerIdError('   ', d)).toBe('填写提供方 ID');
  });

  it('Given 提供方 ID 含大写或点号 When providerIdError Then 字符集提示且提到点号', () => {
    expect(providerIdError('Foo', d)).toContain('不能含点号');
    expect(providerIdError('a.', d)).toContain('不能含点号');
    expect(providerIdError('-a', d)).toContain('不能含点号');
  });

  it('Given 提供方 ID 已存在 When providerIdError Then 「已有这个提供方 ID」', () => {
    expect(providerIdError('mine', d)).toBe('已有这个提供方 ID');
  });

  it('Given 合法且不重复的 ID When providerIdError Then 空串', () => {
    expect(providerIdError('my-gateway', d)).toBe('');
  });

  it('Given idWarn 收到 A_b When 提示 Then 含「小写字母」', () => {
    expect(idWarn('A_b')).toContain('小写字母');
    expect(idWarn('a-b')).toBe('');
  });
});

describe('validate.routeErrors', () => {
  it('Given pi 路由 apiKeyEnv 键存在但为空白 When routeErrors Then 「填写密钥环境变量名。」', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', apiKeyEnv: '' }));
    expect(e.apiKeyEnv).toBe('填写密钥环境变量名。');
  });

  it('Given pi 路由 defaultContextWindow 格式非法 When routeErrors Then 挂在 defaultContextWindow 上', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', defaultContextWindow: 'nope' }));
    expect(e.defaultContextWindow).toBe('填正整数，可用 K 或 M 后缀（如 128K、1M），或留空以使用运行默认。');
    expect(e.maxTokens).toBeUndefined();
  });

  it('Given DeepSeek 路由的提供方容量非法 When routeErrors Then 错误挂在 maxTokens 上', () => {
    const e = routeErrors(draftProvider({ id: 'deepseek-official', ns: 'llm-deepseek', maxTokens: 'nope' }));
    expect(e.maxTokens).toBeDefined();
    expect(e.defaultContextWindow).toBeUndefined();
  });
});

describe('validate.secretError', () => {
  it('Given 空串 When secretError Then 空串（表示不改）', () => {
    expect(secretError('')).toBe('');
  });

  it('Given 正常密钥 When secretError Then 空串', () => {
    expect(secretError('sk-abc123')).toBe('');
    expect(secretError('A.b_c-1')).toBe('');
  });

  it('Given 环境变量赋值写法、首尾引号、空格或非 ASCII When secretError Then 非空', () => {
    expect(secretError('A=b')).not.toBe('');
    expect(secretError('"x"')).not.toBe('');
    expect(secretError("'x'")).not.toBe('');
    expect(secretError('has space')).not.toBe('');
    expect(secretError('中文密钥')).not.toBe('');
  });
});

describe('validate.allErrors / modelCapBad / routeCapBad', () => {
  it('Given 只有部分提供方出错 When allErrors Then 只收录出错的路由', () => {
    const bad = draftProvider({ id: 'bad', models: [draftModel({ id: 'm', contextWindow: 'nope' })] });
    const ok = draftProvider({ id: 'ok', models: [draftModel({ id: 'm' })] });
    const all = allErrors({ providers: { bad, ok } });
    expect(Object.keys(all)).toEqual(['bad']);
    expect(all.bad.route).toEqual({});
    expect(all.bad.models[0].contextWindow).toBe(CAP_FMT_ERR);
  });

  it('Given 容量非法 When modelCapBad / routeCapBad Then 为 true', () => {
    const p = draftProvider({ id: 'gpt-gateway', defaultContextWindow: 'nope' });
    expect(modelCapBad(p, draftModel({ id: 'm', maxTokens: 'nope' }))).toBe(true);
    expect(routeCapBad(p)).toBe(true);
    expect(routeCapBad(draftProvider({ id: 'ok' }))).toBe(false);
  });
});
