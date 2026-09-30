/**
 * efforts.ts 用例清单（docs/specs/model-capabilities.tests.md）。
 * W1a：现在应为红，失败原因是桩抛 `not implemented`。
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

describe('efforts.resolvedInput / inputSummary', () => {
  it('Given pi 模型没有 input、路由有 defaultInput=文本+图片 When inputSummary Then 「继承·文本+图片」', () => {
    const p = draftProvider({ id: 'cc-gateway', defaultInput: ['text', 'image'] });
    const m = draftModel({ id: 'claude-haiku-4-6' });
    expect(resolvedInput(p, m)).toEqual({ v: ['text', 'image'], src: 'route' });
    expect(inputSummary(p, m)).toBe('继承·文本+图片');
  });

  it('Given pi 模型和路由都没有输入声明 When inputSummary Then 「继承·文本」', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    const m = draftModel({ id: 'gpt-6-astra' });
    expect(resolvedInput(p, m)).toEqual({ v: ['text'], src: 'runtime' });
    expect(inputSummary(p, m)).toBe('继承·文本');
  });

  it('Given pi 模型自己写了 input When inputSummary Then 直接用模型值，不带继承前缀', () => {
    const p = draftProvider({ id: 'gpt-gateway', defaultInput: ['text'] });
    const m = draftModel({ id: 'gpt-6-astra', input: ['image'] });
    expect(resolvedInput(p, m)).toEqual({ v: ['image'], src: 'model' });
    expect(inputSummary(p, m)).toBe('图片');
  });

  it('Given DeepSeek 模型带 inputModalities When inputSummary Then 读 inputModalities，不带继承前缀', () => {
    const p = draftProvider({ id: 'deepseek-official', ns: 'llm-deepseek' });
    expect(inputSummary(p, draftModel({ id: 'deepseek-flash', inputModalities: ['text', 'image'] }))).toBe('文本+图片');
    expect(inputSummary(p, draftModel({ id: 'deepseek-v4-pro', inputModalities: ['text'] }))).toBe('文本');
    expect(inputSummary(p, draftModel({ id: 'deepseek-v4-pro' }))).toBe('文本');
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
