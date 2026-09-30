import { ALL_EFFORTS, type InputModality, type ModelDraft, type ProviderDraft, type ReasoningEfforts, type ReasoningMap } from './types';

const isPi = (p: ProviderDraft): boolean => p.ns === 'llm-pi-ai';

export function orderedEfforts(obj: ReasoningMap): ReasoningMap {
  const out: ReasoningMap = {};
  for (const level of ALL_EFFORTS) {
    if (Object.prototype.hasOwnProperty.call(obj, level)) out[level] = obj[level];
  }
  for (const [key, value] of Object.entries(obj)) {
    if (!(ALL_EFFORTS as readonly string[]).includes(key)) (out as Record<string, string | null | undefined>)[key] = value;
  }
  return out;
}

export function effortSummary(eff: ReasoningEfforts | undefined): string {
  if (!eff) return '不思考';
  const levels = ALL_EFFORTS.filter((level) => Object.prototype.hasOwnProperty.call(eff, level));
  if (!levels.length) return '未选档位';
  const runs: string[] = [];
  let start = 0;
  for (let i = 1; i <= levels.length; i += 1) {
    const prev = levels[i - 1];
    const curr = levels[i];
    const contiguous = i < levels.length && ALL_EFFORTS.indexOf(curr) === ALL_EFFORTS.indexOf(prev) + 1;
    if (!contiguous) {
      runs.push(start === i - 1 ? levels[start] : `${levels[start]}–${prev}`);
      start = i;
    }
  }
  return runs.join('、');
}

export function resolvedInput(p: ProviderDraft, m: ModelDraft): { v: InputModality[]; set: boolean } {
  const value = isPi(p) ? m.input : m.inputModalities;
  return value ? { v: value.slice(), set: true } : { v: [], set: false };
}

function inputText(v: readonly InputModality[]): string {
  if (!v.length) return '未设置';
  return v.includes('image') ? (v.includes('text') ? '文本+图片' : '图片') : '文本';
}

export function inputSummary(p: ProviderDraft, m: ModelDraft): string {
  return inputText(resolvedInput(p, m).v);
}

export function hasLegacy(p: ProviderDraft): boolean {
  return isPi(p) && p.models.some((m) => m.inputModalities !== undefined);
}

export function deriveEnv(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}
