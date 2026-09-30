import type { CapSide, CapState, ModelDraft } from './types';

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function parseCap(s: string | null | undefined): number | null | undefined {
  const text = String(s == null ? '' : s).trim();
  if (!text) return undefined;
  let value: number;
  if (/^[1-9]\d*$/.test(text)) value = Number(text);
  else if (/^[1-9]\d*[Kk]$/.test(text)) value = Number(text.slice(0, -1)) * 1000;
  else if (/^[1-9]\d*[Mm]$/.test(text)) value = Number(text.slice(0, -1)) * 1_000_000;
  else return null;
  return Number.isSafeInteger(value) ? value : null;
}

export function abbr(n: number): string {
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n % 1000 === 0) return `${n / 1000}K`;
  return String(n);
}

export function canAbbr(n: number): boolean {
  return abbr(n) !== String(n);
}

function side(m: ModelDraft, key: 'contextWindow' | 'maxTokens'): CapSide {
  const explicitKey = has(m, key);
  const raw = explicitKey ? (m as unknown as Record<string, unknown>)[key] : '';
  const parsed = explicitKey ? parseCap(raw as string | null | undefined) : undefined;
  return {
    key,
    explicit: explicitKey && parsed !== undefined,
    raw: explicitKey ? String(raw ?? '') : '',
    parsed,
  };
}

export function modelCap(m: ModelDraft): CapState {
  return { cw: side(m, 'contextWindow'), mt: side(m, 'maxTokens') };
}

export function capFmtBad(sideValue: CapSide): boolean {
  return sideValue.parsed === null;
}

export function capOver(c: CapState): boolean {
  return typeof c.cw.parsed === 'number' && typeof c.mt.parsed === 'number' && c.mt.parsed > c.cw.parsed;
}

export function capBlocks(c: CapState): boolean {
  return capOver(c);
}

export function capErrors(c: CapState, fmtMsg: string): { cw?: string; mt?: string } {
  const out: { cw?: string; mt?: string } = {};
  if (capFmtBad(c.cw)) out.cw = fmtMsg;
  if (capFmtBad(c.mt)) out.mt = fmtMsg;
  if (!capFmtBad(c.cw) && !capFmtBad(c.mt) && capBlocks(c)) {
    out.mt = `最大输出大于上下文窗口（${c.mt.parsed} > ${c.cw.parsed}）。输出不能超过上下文窗口。`;
  }
  return out;
}
