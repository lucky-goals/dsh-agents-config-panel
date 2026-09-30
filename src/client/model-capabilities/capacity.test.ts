/**
 * capacity.ts 用例清单。
 *
 * R2 增量（docs/specs/model-capabilities.r2.md 第 1.3、5 节）：
 * - 删除 routeCap 整组，以及「src=route」「路由回退」用例；
 * - 显式容量不再断言 fallback/src/eff；
 * - capBlocks 改为三种情况：只设窗口不阻止；两侧都未设置不阻止；两侧都是数字且越界时阻止。
 *
 * 唯一的状态模型：容量只有「已设置 / 未设置」两种，没有回退数字。
 */
import { describe, expect, it } from 'vitest';
import {
  abbr,
  canAbbr,
  capBlocks,
  capErrors,
  capFmtBad,
  capOver,
  modelCap,
  parseCap,
} from './capacity';
import { CAP_FMT_ERR } from './types';
import { draftModel } from './test-fixtures';

describe('capacity.parseCap', () => {
  it('Given 带后缀的写法 When parseCap Then 128K 得 128000、1M 得 1000000', () => {
    expect(parseCap('128K')).toBe(128000);
    expect(parseCap('1M')).toBe(1000000);
  });

  it('Given 纯数字 When parseCap Then 272000 得 272000', () => {
    expect(parseCap('272000')).toBe(272000);
  });

  it('Given 空串或纯空白 When parseCap Then 返回 undefined（未设置）', () => {
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

describe('capacity.modelCap（只有已设置 / 未设置）', () => {
  it('Given 模型没写容量键 When modelCap Then 两侧 explicit=false、parsed=undefined、raw 为空', () => {
    const c = modelCap(draftModel({ id: 'gpt-6-astra' }));
    for (const side of [c.cw, c.mt]) {
      expect(side.explicit).toBe(false);
      expect(side.parsed).toBeUndefined();
      expect(side.raw).toBe('');
    }
    expect(c.cw.key).toBe('contextWindow');
    expect(c.mt.key).toBe('maxTokens');
  });

  it('Given 模型显式写了容量 When modelCap Then explicit=true 且 parsed 是数字（不再有任何回退）', () => {
    const c = modelCap(draftModel({ id: 'gpt-6-astra', contextWindow: '500', maxTokens: '400' }));
    expect(c.cw.explicit).toBe(true);
    expect(c.cw.raw).toBe('500');
    expect(c.cw.parsed).toBe(500);
    expect(c.mt.explicit).toBe(true);
    expect(c.mt.raw).toBe('400');
    expect(c.mt.parsed).toBe(400);
  });

  it('Given 容量键存在但为空白 When modelCap Then 空白不算已设置', () => {
    const c = modelCap(draftModel({ id: 'gpt-6-astra', contextWindow: '   ' }));
    expect(c.cw.explicit).toBe(false);
    expect(c.cw.parsed).toBeUndefined();
    expect(c.cw.raw).toBe('   ');
  });

  it('Given 容量键存在但格式非法 When modelCap Then explicit=true 且 parsed 为 null', () => {
    const c = modelCap(draftModel({ id: 'gpt-6-astra', maxTokens: 'nope' }));
    expect(c.mt.explicit).toBe(true);
    expect(c.mt.parsed).toBeNull();
    expect(c.mt.raw).toBe('nope');
    expect(capFmtBad(c.mt)).toBe(true);
    expect(capFmtBad(c.cw)).toBe(false);
  });
});

describe('capacity.capBlocks（只有两侧都是数字且越界才阻止）', () => {
  it('Given 只设窗口、最大输出未设置 When capBlocks Then 不阻止', () => {
    const c = modelCap(draftModel({ id: 'gpt-6-astra', contextWindow: '1000' }));
    expect(c.mt.parsed).toBeUndefined();
    expect(capOver(c)).toBe(false);
    expect(capBlocks(c)).toBe(false);
  });

  it('Given 两侧都未设置 When capBlocks Then 不阻止', () => {
    const c = modelCap(draftModel({ id: 'gpt-6-astra' }));
    expect(capBlocks(c)).toBe(false);
  });

  it('Given 两侧都是数字且最大输出大于窗口 When capBlocks Then 阻止', () => {
    const c = modelCap(draftModel({ id: 'gpt-6-astra', contextWindow: '1000', maxTokens: '40000' }));
    expect(capOver(c)).toBe(true);
    expect(capBlocks(c)).toBe(true);
  });

  it('Given 两侧都是数字但最大输出不大于窗口 When capBlocks Then 不阻止', () => {
    const c = modelCap(draftModel({ id: 'gpt-6-astra', contextWindow: '128000', maxTokens: '128000' }));
    expect(capOver(c)).toBe(false);
    expect(capBlocks(c)).toBe(false);
  });
});

describe('capacity.capErrors', () => {
  it('Given 两侧都是数字且越界 When capErrors Then 只在 mt 上给出越界文案', () => {
    const c = modelCap(draftModel({ id: 'gpt-6-astra', contextWindow: '1000', maxTokens: '40000' }));
    expect(capErrors(c, CAP_FMT_ERR).mt).toBe('最大输出大于上下文窗口（40000 > 1000）。输出不能超过上下文窗口。');
    expect(capErrors(c, CAP_FMT_ERR).cw).toBeUndefined();
  });

  it('Given 容量格式错误 When capErrors Then 格式化错误挂在各自一侧，且 capOver=false', () => {
    const c = modelCap(draftModel({ id: 'gpt-6-astra', contextWindow: 'nope' }));
    expect(capFmtBad(c.cw)).toBe(true);
    expect(capOver(c)).toBe(false);
    expect(capBlocks(c)).toBe(false);
    expect(capErrors(c, CAP_FMT_ERR).cw).toBe(CAP_FMT_ERR);
    expect(capErrors(c, CAP_FMT_ERR).mt).toBeUndefined();
  });

  it('Given 只有一侧是数字 When capErrors Then 不报越界', () => {
    const c = modelCap(draftModel({ id: 'gpt-6-astra', maxTokens: '40000' }));
    expect(capErrors(c, CAP_FMT_ERR)).toEqual({});
  });
});
