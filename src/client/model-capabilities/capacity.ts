import { DS_RUNTIME_CW, DS_RUNTIME_MT, RUNTIME_CW, RUNTIME_MT, type CapSide, type CapState, type ModelDraft, type ProviderDraft } from './types';

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isPi = (p: ProviderDraft): boolean => p.ns === 'llm-pi-ai';

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

function runtime(p: ProviderDraft): { cw: number; mt: number } {
  return isPi(p) ? { cw: RUNTIME_CW, mt: RUNTIME_MT } : { cw: DS_RUNTIME_CW, mt: DS_RUNTIME_MT };
}

function side(p: ProviderDraft, key: string, fallback: number): CapSide {
  const explicitKey = has(p, key);
  const raw = explicitKey ? (p as unknown as Record<string, unknown>)[key] : '';
  const parsed = explicitKey ? parseCap(raw as string | null | undefined) : undefined;
  return {
    key,
    explicit: explicitKey && parsed !== undefined,
    raw: explicitKey ? String(raw ?? '') : '',
    parsed,
    fallback,
    src: 'runtime',
    eff: typeof parsed === 'number' ? parsed : fallback,
  };
}

export function routeCap(p: ProviderDraft): CapState {
  const rt = runtime(p);
  return {
    cw: side(p, 'defaultContextWindow', rt.cw),
    mt: side(p, isPi(p) ? 'defaultMaxTokens' : 'maxTokens', rt.mt),
  };
}

function modelSide(p: ProviderDraft, m: ModelDraft, key: string, route: CapSide): CapSide {
  const explicitKey = has(m, key);
  const raw = explicitKey ? (m as unknown as Record<string, unknown>)[key] : '';
  const parsed = explicitKey ? parseCap(raw as string | null | undefined) : undefined;
  const routeOk = route.explicit && typeof route.parsed === 'number';
  const fallback = typeof route.parsed === 'number' ? route.parsed : route.fallback;
  return {
    key,
    explicit: explicitKey && parsed !== undefined,
    raw: explicitKey ? String(raw ?? '') : '',
    parsed,
    fallback,
    src: routeOk ? 'route' : 'runtime',
    eff: typeof parsed === 'number' ? parsed : fallback,
  };
}

export function modelCap(p: ProviderDraft, m: ModelDraft): CapState {
  const route = routeCap(p);
  return {
    cw: modelSide(p, m, 'contextWindow', route.cw),
    mt: modelSide(p, m, 'maxTokens', route.mt),
  };
}

export function capFmtBad(sideValue: CapSide): boolean {
  return sideValue.parsed === null;
}

export function capOver(c: CapState): boolean {
  return !capFmtBad(c.cw) && !capFmtBad(c.mt) && c.mt.eff > c.cw.eff;
}

export function capBlocks(c: CapState, pi: boolean): boolean {
  return capOver(c) && (!pi || c.mt.explicit);
}

export function capWarn(c: CapState, pi: boolean): string {
  if (pi && capOver(c) && !c.mt.explicit) return '继承的最大输出超过当前上下文窗口；它是能力上限，不会成为请求默认。';
  return '';
}

export function capErrors(c: CapState, fmtMsg: string, pi: boolean): { cw?: string; mt?: string } {
  const out: { cw?: string; mt?: string } = {};
  if (capFmtBad(c.cw)) out.cw = fmtMsg;
  if (capFmtBad(c.mt)) out.mt = fmtMsg;
  if (!capFmtBad(c.cw) && !capFmtBad(c.mt) && capBlocks(c, pi)) {
    out.mt = `最大输出大于上下文窗口（${c.mt.eff} > ${c.cw.eff}）。输出不能超过上下文窗口。`;
  }
  return out;
}
