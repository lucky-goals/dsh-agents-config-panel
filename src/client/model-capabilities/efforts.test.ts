/**
 * efforts.ts 用例清单。
 *
 * R2 增量（docs/specs/model-capabilities.r2.md 第 1.3、5 节）：
 * - resolvedInput 是 `(p, m) => { v, set }`，不再有 src，也不再有「继承·」前缀；
 * - pi 取 input，DS 取 inputModalities；缺键返回 `{v:[], set:false}`，
 *   DS 缺键不再当作 text。
 *
 * R2-5 / R2-20 的逐字文案断言在 regression-r2.test.ts 里。
 */
import { describe, expect, it } from 'vitest';
import { deriveEnv, effortSummary, hasLegacy, inputSummary, orderedEfforts, resolvedInput } from './efforts';
import type { ReasoningMap } from './types';
import { draftModel, draftProvider } from './test-fixtures';

describe('efforts.effortSummary', () => {
  it('Given reasoningEfforts 为 false When effortSummary Then 「不思考」', () => {
    expect(effortSummary(false)).toBe('不思考');
    expect(effortSummary(undefined)).toBe('不思考');
  });

  it('Given reasoningEfforts 为空对象 When effortSummary Then 「未选档位」', () => {
    expect(effortSummary({})).toBe('未选档位');
  });

  it('Given 只勾了 low When effortSummary Then low', () => {
    expect(effortSummary({ low: 'low' })).toBe('low');
  });

  it('Given 勾了连续的 low+medium+high When effortSummary Then low–high', () => {
    expect(effortSummary({ low: 'low', medium: 'medium', high: 'high' })).toBe('low–high');
  });

  it('Given 勾了不连续的 low+high When effortSummary Then low、high', () => {
    expect(effortSummary({ low: 'low', high: 'high' })).toBe('low、high');
  });

  it('Given 档位里混进未知键 When orderedEfforts Then 已知档位在前，未知键排在最后', () => {
    const input = { custom: 'x', max: 'max', off: 'off' } as unknown as ReasoningMap;
    const ordered = orderedEfforts(input);
    expect(Object.keys(ordered)).toEqual(['off', 'max', 'custom']);
  });
});

describe('efforts.resolvedInput / inputSummary（只是「已设置 / 未设置」）', () => {
  it('Given pi 模型没有 input When inputSummary Then 「未设置」且 set=false', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    const m = draftModel({ id: 'gpt-6-astra' });
    expect(resolvedInput(p, m)).toEqual({ v: [], set: false });
    expect(inputSummary(p, m)).toBe('未设置');
  });

  it('Given pi 模型写了 input When inputSummary Then 直接用模型值', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    const m = draftModel({ id: 'gpt-6-astra', input: ['image'] });
    expect(resolvedInput(p, m)).toEqual({ v: ['image'], set: true });
    expect(inputSummary(p, m)).toBe('图片');
  });

  it('Given pi 模型没有 input、路由有 defaultInput When inputSummary Then 只看模型（不再有「继承·」）', () => {
    const p = draftProvider({ id: 'cc-gateway' });
    const m = draftModel({ id: 'claude-haiku-4-6' });
    expect(resolvedInput(p, m)).toEqual({ v: [], set: false });
    expect(inputSummary(p, m)).toBe('未设置');
    expect(inputSummary(p, m)).not.toContain('继承');
  });

  it('Given pi 模型的 input 是空数组 When inputSummary Then 「未设置」（空数组的 set 仍为 true）', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    const m = draftModel({ id: 'gpt-6-astra', input: [] });
    expect(resolvedInput(p, m)).toEqual({ v: [], set: true });
    expect(inputSummary(p, m)).toBe('未设置');
  });

  it('Given DeepSeek 模型写 inputModalities When inputSummary Then 读 inputModalities', () => {
    const p = draftProvider({ id: 'deepseek-official', ns: 'llm-deepseek' });
    expect(inputSummary(p, draftModel({ id: 'deepseek-flash', inputModalities: ['text', 'image'] }))).toBe('文本+图片');
    expect(inputSummary(p, draftModel({ id: 'deepseek-v4-pro', inputModalities: ['text'] }))).toBe('文本');
    expect(inputSummary(p, draftModel({ id: 'deepseek-v4-pro', inputModalities: ['image'] }))).toBe('图片');
  });

  it('Given DeepSeek 模型没有 inputModalities When inputSummary Then 「未设置」（不再当作 text）', () => {
    const p = draftProvider({ id: 'deepseek-official', ns: 'llm-deepseek' });
    const m = draftModel({ id: 'deepseek-v4-pro' });
    expect(resolvedInput(p, m)).toEqual({ v: [], set: false });
    expect(inputSummary(p, m)).toBe('未设置');
  });

  it('Given pi 模型只有旧字段 inputModalities When inputSummary Then 「未设置」（pi 只读 input）', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    const m = draftModel({ id: 'gpt-6-astra', inputModalities: ['text', 'image'] });
    expect(inputSummary(p, m)).toBe('未设置');
  });
});

describe('efforts.deriveEnv', () => {
  it('Given my-gateway When deriveEnv Then MY_GATEWAY_API_KEY', () => {
    expect(deriveEnv('my-gateway')).toBe('MY_GATEWAY_API_KEY');
  });

  it('Given a--b When deriveEnv Then A_B_API_KEY（官方折叠写法，连续非法字符折成一个下划线）', () => {
    expect(deriveEnv('a--b')).toBe('A_B_API_KEY');
  });
});

describe('efforts.hasLegacy', () => {
  it('Given pi 模型带 inputModalities When hasLegacy Then true', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'a', inputModalities: ['text', 'image'] })] });
    expect(hasLegacy(p)).toBe(true);
  });

  it('Given pi 模型都没有 inputModalities When hasLegacy Then false', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'a', input: ['text'] })] });
    expect(hasLegacy(p)).toBe(false);
  });

  it('Given DeepSeek 模型带 inputModalities When hasLegacy Then false（只看 pi）', () => {
    const p = draftProvider({ id: 'deepseek-official', ns: 'llm-deepseek', models: [draftModel({ id: 'a', inputModalities: ['text'] })] });
    expect(hasLegacy(p)).toBe(false);
  });
});
