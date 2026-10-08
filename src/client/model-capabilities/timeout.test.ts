/**
 * R4b 红灯用例：流空闲超时的纯函数（docs/specs/r4b-stream-idle-timeout.md 第 3 节）。
 *
 * T1 parse ok / T2 parse empty / T3 parse error 逐字 / T4 展示函数 / T5 validTimeoutMs。
 *
 * 本文件是新增文件：timeout.ts 现在还不存在，所以整文件 import 失败是红灯阶段
 * 的预期结果。文案一律从契约第 3 节逐字取用。
 */
import { describe, expect, it } from 'vitest';
import {
  durationLabel,
  msToMinutesText,
  parseTimeoutMinutes,
  timeoutError,
  timeoutHint,
  timeoutSummary,
  validTimeoutMs,
} from './timeout';
import {
  DSH_DEFAULT_TIMEOUT_MS,
  SUGGESTED_TIMEOUT_MS,
  TIMEOUT_KEY,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  TIMEOUT_PRESETS,
  type ProviderDraft,
} from './types';
import { draftProvider } from './test-fixtures';

/* ---------------- 契约第 3 节的逐字文案 ---------------- */

const ERR_FORMAT = '请输入分钟数，例如 30 或 0.5';
const ERR_POSITIVE = '请输入大于 0 的分钟数';
const ERR_TOO_SMALL = '不能少于 1 秒（0.0167 分钟）';
const ERR_TOO_LARGE = '不能超过 35791 分钟';
const HINT_UNSET = '未设置 · 使用 DSH 默认 5 分钟。建议 30 分钟。';

/** 草稿：timeoutText / streamIdleTimeoutMs 都还不是 ProviderDraft 的字段，用展开绕过类型。 */
function draft(over: Record<string, unknown> = {}): ProviderDraft {
  return { ...draftProvider({ id: 'gpt-gateway' }), ...over } as ProviderDraft;
}

describe('T1 parse ok：分钟 → 整数毫秒，常量与契约一致', () => {
  it('T1 常量：TIMEOUT_KEY / DSH_DEFAULT_TIMEOUT_MS / SUGGESTED_TIMEOUT_MS / 上下限 / 预设', () => {
    expect(TIMEOUT_KEY).toBe('streamIdleTimeoutMs');
    expect(DSH_DEFAULT_TIMEOUT_MS).toBe(300000);
    expect(SUGGESTED_TIMEOUT_MS).toBe(1800000);
    expect(TIMEOUT_MIN_MS).toBe(1000);
    expect(TIMEOUT_MAX_MS).toBe(2147483647);
    expect(TIMEOUT_PRESETS).toEqual([
      ['5 分钟', 300000],
      ['30 分钟', 1800000],
      ['60 分钟', 3600000],
    ]);
  });

  it('T1 parse ok：30 → 1800000、0.5 → 30000、带空白的 60 → 3600000、边界 35791 → 2147460000', () => {
    expect(parseTimeoutMinutes('30')).toEqual({ kind: 'ok', ms: 1800000 });
    expect(parseTimeoutMinutes('0.5')).toEqual({ kind: 'ok', ms: 30000 });
    expect(parseTimeoutMinutes(' 60 ')).toEqual({ kind: 'ok', ms: 3600000 });
    expect(parseTimeoutMinutes('35791')).toEqual({ kind: 'ok', ms: 2147460000 });
    expect(parseTimeoutMinutes('0.0167')).toEqual({ kind: 'ok', ms: 1002 });
  });
});

describe('T2 parse empty：空串与纯空白', () => {
  it('T2 empty：空串与纯空白都返回 {kind:empty}', () => {
    expect(parseTimeoutMinutes('')).toEqual({ kind: 'empty' });
    expect(parseTimeoutMinutes('  ')).toEqual({ kind: 'empty' });
  });
});

describe('T3 parse error：逐字文案与判定顺序', () => {
  const CASES: Array<[string, string]> = [
    ['0', ERR_POSITIVE],
    ['-1', ERR_POSITIVE],
    ['0.01', ERR_TOO_SMALL],
    ['35792', ERR_TOO_LARGE],
    ['abc', ERR_FORMAT],
    ['1e3', ERR_FORMAT],
    ['３０', ERR_FORMAT],
    ['30分钟', ERR_FORMAT],
  ];

  it.each(CASES)('T3 %s → %s', (text, message) => {
    expect(parseTimeoutMinutes(text)).toEqual({ kind: 'error', message });
    expect(timeoutError(text)).toBe(message);
  });

  it('T3 timeoutError：ok 与 empty 返回空串', () => {
    expect(timeoutError('30')).toBe('');
    expect(timeoutError(' 60 ')).toBe('');
    expect(timeoutError('')).toBe('');
    expect(timeoutError('   ')).toBe('');
  });
});

describe('T4 展示函数：msToMinutesText / durationLabel / timeoutHint / timeoutSummary', () => {
  it('T4 msToMinutesText：1800000 → 30、90000 → 1.5，最多 4 位小数', () => {
    expect(msToMinutesText(1800000)).toBe('30');
    expect(msToMinutesText(90000)).toBe('1.5');
    expect(msToMinutesText(300000)).toBe('5');
  });

  it('T4 durationLabel：整分钟 → 分钟、整秒 → 秒、否则 ms', () => {
    expect(durationLabel(1800000)).toBe('30 分钟');
    expect(durationLabel(90000)).toBe('90 秒');
    expect(durationLabel(1500)).toBe('1500 ms');
  });

  it('T4 timeoutHint：有值 → = <ms> ms · <label>；undefined → 未设置的原文', () => {
    expect(timeoutHint(1800000)).toBe('= 1800000 ms · 30 分钟');
    expect(timeoutHint(DSH_DEFAULT_TIMEOUT_MS)).toBe('= 300000 ms · 5 分钟');
    expect(timeoutHint(undefined)).toBe(HINT_UNSET);
  });

  it('T4 timeoutSummary 三态：格式错误 / 用正在输入的解析值 / 回落显式值或 DSH 默认', () => {
    // 有 error → 格式错误
    expect(timeoutSummary(draft({ timeoutText: 'abc' }))).toBe('流空闲超时 格式错误');
    expect(timeoutSummary(draft({ timeoutText: '0' }))).toBe('流空闲超时 格式错误');
    // ok → 用解析值
    expect(timeoutSummary(draft({ timeoutText: '30' }))).toBe('流空闲超时 30 分钟');
    expect(timeoutSummary(draft({ timeoutText: '0.5' }))).toBe('流空闲超时 30 秒');
    // empty / 没有 timeoutText → 看 streamIdleTimeoutMs
    expect(timeoutSummary(draft({ timeoutText: '  ', streamIdleTimeoutMs: 1800000 }))).toBe('流空闲超时 30 分钟');
    expect(timeoutSummary(draft({ streamIdleTimeoutMs: 1500 }))).toBe('流空闲超时 1500 ms');
    // 都没有 → DSH 默认
    expect(timeoutSummary(draft())).toBe('流空闲超时 默认 5 分钟');
    expect(timeoutSummary(draft({ timeoutText: '' }))).toBe('流空闲超时 默认 5 分钟');
  });
});

describe('T5 validTimeoutMs：闭区间 1000–2147483647 的有限 number', () => {
  it('T5 边界内为真', () => {
    expect(validTimeoutMs(TIMEOUT_MIN_MS)).toBe(true);
    expect(validTimeoutMs(TIMEOUT_MAX_MS)).toBe(true);
    expect(validTimeoutMs(300000)).toBe(true);
    expect(validTimeoutMs(1002)).toBe(true);
  });

  it('T5 越界、非 number、非有限值为假', () => {
    expect(validTimeoutMs(999)).toBe(false);
    expect(validTimeoutMs(0)).toBe(false);
    expect(validTimeoutMs(-1)).toBe(false);
    expect(validTimeoutMs(2147483648)).toBe(false);
    expect(validTimeoutMs(NaN)).toBe(false);
    expect(validTimeoutMs(Infinity)).toBe(false);
    expect(validTimeoutMs('1800000')).toBe(false);
    expect(validTimeoutMs(undefined)).toBe(false);
    expect(validTimeoutMs(null)).toBe(false);
  });
});
