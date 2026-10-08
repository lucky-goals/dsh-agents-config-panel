/**
 * 流空闲超时 streamIdleTimeoutMs 的纯函数（docs/specs/r4b-stream-idle-timeout.md 第 3 节）。
 * 界面只收分钟（可带小数），写入时换成整数毫秒。
 */
import { TIMEOUT_MAX_MS, TIMEOUT_MIN_MS, type ProviderDraft } from './types';

export type TimeoutParse = { kind: 'empty' } | { kind: 'ok'; ms: number } | { kind: 'error'; message: string };

const MINUTES = /^-?\d+(\.\d+)?$/;

/** 按契约顺序判断：empty → 格式 → ≤0 → 下限 → 上限 → ok。 */
export function parseTimeoutMinutes(text: string): TimeoutParse {
  const value = text.trim();
  if (value === '') return { kind: 'empty' };
  if (!MINUTES.test(value)) return { kind: 'error', message: '请输入分钟数，例如 30 或 0.5' };
  const minutes = Number(value);
  if (minutes <= 0) return { kind: 'error', message: '请输入大于 0 的分钟数' };
  const ms = Math.round(minutes * 60000);
  if (ms < TIMEOUT_MIN_MS) return { kind: 'error', message: '不能少于 1 秒（0.0167 分钟）' };
  if (ms > TIMEOUT_MAX_MS) return { kind: 'error', message: '不能超过 35791 分钟' };
  return { kind: 'ok', ms };
}

/** ok / empty → ''。 */
export function timeoutError(text: string): string {
  const parsed = parseTimeoutMinutes(text);
  return parsed.kind === 'error' ? parsed.message : '';
}

/** 有限 number 且 TIMEOUT_MIN_MS ≤ v ≤ TIMEOUT_MAX_MS。 */
export function validTimeoutMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= TIMEOUT_MIN_MS && v <= TIMEOUT_MAX_MS;
}

/** 毫秒 → 分钟原文，最多 4 位小数。 */
export function msToMinutesText(ms: number): string {
  return String(Number((ms / 60000).toFixed(4)));
}

export function durationLabel(ms: number): string {
  if (ms % 60000 === 0) return `${ms / 60000} 分钟`;
  if (ms % 1000 === 0) return `${ms / 1000} 秒`;
  return `${ms} ms`;
}

export function timeoutHint(ms: number | undefined): string {
  if (ms === undefined) return '未设置 · 使用 DSH 默认 5 分钟。建议 30 分钟。';
  return `= ${ms} ms · ${durationLabel(ms)}`;
}

/** 头部摘要：正在输入的原文优先，其次显式值，最后 DSH 默认。 */
export function timeoutSummary(p: ProviderDraft): string {
  if (p.timeoutText !== undefined) {
    const parsed = parseTimeoutMinutes(p.timeoutText);
    if (parsed.kind === 'error') return '流空闲超时 格式错误';
    if (parsed.kind === 'ok') return `流空闲超时 ${durationLabel(parsed.ms)}`;
  }
  if (p.streamIdleTimeoutMs !== undefined) return `流空闲超时 ${durationLabel(p.streamIdleTimeoutMs)}`;
  return '流空闲超时 默认 5 分钟';
}
