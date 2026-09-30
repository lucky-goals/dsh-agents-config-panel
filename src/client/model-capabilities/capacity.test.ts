/**
 * capacity.ts 用例清单（docs/specs/model-capabilities.tests.md）。
 * W1a：这些用例现在应为红，失败原因是桩抛 `not implemented`。
 */
import { describe, expect, it } from 'vitest';
import {
  abbr,
  canAbbr,
  capBlocks,
  capErrors,
  capFmtBad,
  capOver,
  capWarn,
  modelCap,
  parseCap,
  routeCap,
} from './capacity';
import { CAP_FMT_ERR, CAP_FMT_ERR_ROUTE, DS_RUNTIME_CW, DS_RUNTIME_MT, RUNTIME_CW, RUNTIME_MT } from './types';
import { draftModel, draftProvider } from './test-fixtures';

describe('capacity.parseCap', () => {
  it('Given 带后缀的写法 When parseCap Then 128K 得 128000、1M 得 1000000', () => {
    expect(parseCap('128K')).toBe(128000);
    expect(parseCap('1M')).toBe(1000000);
  });

  it('Given 纯数字 When parseCap Then 272000 得 272000', () => {
    expect(parseCap('272000')).toBe(272000);
  });

  it('Given 空串或纯空白 When parseCap Then 返回 undefined（恢复继承）', () => {
    expect(parseCap('')).toBeUndefined();
    expect(parseCap('  ')).toBeUndefined();
    expect(parseCap(null)).toBeUndefined();
    expect(parseCap(undefined)).toBeUndefined();
  });

  it('Given 0、01、1.5、超出安全整数 When parseCap Then 一律返回 null（格式错误）', () => {
    expect(parseCap('0')).toBeNull();
    expect(parseCap('01')).toBeNull();
    expect(parseCap('1.5')).toBeNull();
    expect(parseCap('9007199254740993')).toBeNull();
  });
});

describe('capacity.abbr', () => {
  it('Given 128000 When abbr Then 128K', () => {
    expect(abbr(128000)).toBe('128K');
  });

  it('Given 1000000 When abbr Then 1M', () => {
    expect(abbr(1000000)).toBe('1M');
  });

  it('Given 272000 When abbr Then 272K（能被 1000 整除就缩写）', () => {
    expect(abbr(272000)).toBe('272K');
  });

  it('Given 262144 When abbr Then 262144（不能被 1000 或 1000000 整除，不缩写）', () => {
    expect(abbr(262144)).toBe('262144');
    expect(canAbbr(262144)).toBe(false);
    expect(canAbbr(272000)).toBe(true);
  });
});

describe('capacity.routeCap', () => {
  it('Given pi 提供方没有写容量键 When routeCap Then 两侧 explicit=false，eff 为运行默认 262144 / 32768', () => {
    const c = routeCap(draftProvider({ id: 'gpt-gateway' }));
    expect(c.cw.explicit).toBe(false);
    expect(c.cw.src).toBe('runtime');
    expect(c.cw.fallback).toBe(RUNTIME_CW);
    expect(c.cw.eff).toBe(RUNTIME_CW);
    expect(c.mt.explicit).toBe(false);
    expect(c.mt.src).toBe('runtime');
    expect(c.mt.fallback).toBe(RUNTIME_MT);
    expect(c.mt.eff).toBe(RUNTIME_MT);
  });

  it('Given DeepSeek 提供方没有写容量键 When routeCap Then eff 为 1000000 / 256000', () => {
    const c = routeCap(draftProvider({ id: 'deepseek-official', ns: 'llm-deepseek' }));
    expect(c.cw.key).toBe('defaultContextWindow');
    expect(c.mt.key).toBe('maxTokens');
    expect(c.cw.eff).toBe(DS_RUNTIME_CW);
    expect(c.mt.eff).toBe(DS_RUNTIME_MT);
  });

  it('Given 路由容量格式非法 When routeCap Then 解析为 null，eff 回退运行默认', () => {
    const c = routeCap(draftProvider({ id: 'gpt-gateway', defaultContextWindow: 'nope' }));
    expect(c.cw.parsed).toBeNull();
    expect(c.cw.eff).toBe(RUNTIME_CW);
    expect(capFmtBad(c.cw)).toBe(true);
    expect(capErrors(c, CAP_FMT_ERR_ROUTE, true).cw).toBe(CAP_FMT_ERR_ROUTE);
  });
});

describe('capacity.modelCap', () => {
  it('Given 模型没写 maxTokens、路由显式写了 defaultMaxTokens=1000 When modelCap Then mt.src=route、eff=1000', () => {
    const p = draftProvider({ id: 'gpt-gateway', defaultContextWindow: '2000', defaultMaxTokens: '1000' });
    const c = modelCap(p, draftModel({ id: 'gpt-6-astra' }));
    expect(c.mt.explicit).toBe(false);
    expect(c.mt.parsed).toBeUndefined();
    expect(c.mt.src).toBe('route');
    expect(c.mt.fallback).toBe(1000);
    expect(c.mt.eff).toBe(1000);
    expect(c.cw.src).toBe('route');
    expect(c.cw.eff).toBe(2000);
  });

  it('Given 路由容量解析失败 When modelCap Then 回退到运行默认值', () => {
    const p = draftProvider({ id: 'gpt-gateway', defaultContextWindow: 'nope', defaultMaxTokens: 'nope' });
    const c = modelCap(p, draftModel({ id: 'gpt-6-astra' }));
    expect(c.cw.src).toBe('runtime');
    expect(c.cw.fallback).toBe(RUNTIME_CW);
    expect(c.cw.eff).toBe(RUNTIME_CW);
    expect(c.mt.src).toBe('runtime');
    expect(c.mt.fallback).toBe(RUNTIME_MT);
    expect(c.mt.eff).toBe(RUNTIME_MT);
  });

  it('Given 模型显式写了容量 When modelCap Then explicit=true，eff 用模型值', () => {
    const p = draftProvider({ id: 'gpt-gateway', defaultContextWindow: '2000' });
    const c = modelCap(p, draftModel({ id: 'gpt-6-astra', contextWindow: '500', maxTokens: '400' }));
    expect(c.cw.explicit).toBe(true);
    expect(c.cw.raw).toBe('500');
    expect(c.cw.eff).toBe(500);
    expect(c.mt.explicit).toBe(true);
    expect(c.mt.eff).toBe(400);
  });
});

describe('capacity.capBlocks / capWarn / capErrors', () => {
  it('Given pi 窗口 1000、最大输出为继承值 32768 When 判断阻止保存 Then 不阻止，但提示继承的最大输出是能力上限', () => {
    const c = modelCap(draftProvider({ id: 'gpt-gateway' }), draftModel({ id: 'gpt-6-astra', contextWindow: '1000' }));
    expect(capOver(c)).toBe(true);
    expect(capBlocks(c, true)).toBe(false);
    expect(capWarn(c, true)).toContain('继承的最大输出');
    expect(capWarn(c, true)).toContain('能力上限');
    expect(capWarn(c, false)).toBe('');
  });

  it('Given pi 显式最大输出 40000 大于窗口 1000 When 判断阻止保存 Then 阻止，并给出上限错误文案', () => {
    const c = modelCap(
      draftProvider({ id: 'gpt-gateway' }),
      draftModel({ id: 'gpt-6-astra', contextWindow: '1000', maxTokens: '40000' }),
    );
    expect(capBlocks(c, true)).toBe(true);
    expect(capErrors(c, CAP_FMT_ERR, true).mt).toBe('最大输出大于上下文窗口（40000 > 1000）。输出不能超过上下文窗口。');
    expect(capErrors(c, CAP_FMT_ERR, true).cw).toBeUndefined();
  });

  it('Given DeepSeek 模型两侧都继承、生效最大输出大于窗口 When 判断阻止保存 Then 阻止（按生效值比较）', () => {
    const p = draftProvider({ id: 'deepseek-official', ns: 'llm-deepseek', defaultContextWindow: '200000' });
    const c = modelCap(p, draftModel({ id: 'deepseek-flash' }));
    expect(c.cw.eff).toBe(200000);
    expect(c.mt.eff).toBe(DS_RUNTIME_MT);
    expect(capBlocks(c, false)).toBe(true);
    expect(capErrors(c, CAP_FMT_ERR, false).mt).toBe('最大输出大于上下文窗口（256000 > 200000）。输出不能超过上下文窗口。');
  });

  it('Given 容量格式错误 When 判断大小 Then capOver=false，格式化错误挂在各自一侧', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    const c = modelCap(p, draftModel({ id: 'gpt-6-astra', contextWindow: 'nope' }));
    expect(capFmtBad(c.cw)).toBe(true);
    expect(capOver(c)).toBe(false);
    expect(capBlocks(c, true)).toBe(false);
    expect(capErrors(c, CAP_FMT_ERR, true).cw).toBe(CAP_FMT_ERR);
    expect(capErrors(c, CAP_FMT_ERR, true).mt).toBeUndefined();
  });
});
