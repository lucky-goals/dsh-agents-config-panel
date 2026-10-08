import { capErrors, modelCap, capFmtBad, capBlocks } from './capacity';
import { deriveEnv } from './efforts';
import { timeoutError } from './timeout';
import { CAP_FMT_ERR, type DraftState, type FieldErrors, type HeaderPair, type ModelDraft, type ProviderDraft, type WizardDraft, type AllErrors, ALL_EFFORTS } from './types';

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isPi = (p: ProviderDraft): boolean => p.ns === 'llm-pi-ai';
const duplicateHeaderNames = (headers: HeaderPair[]): string[] => {
  const counts = new Map<string, number>();
  for (const header of headers) {
    const name = header.k.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const duplicates: string[] = [];
  for (const header of headers) {
    const name = header.k.trim();
    if (!name || (counts.get(name) ?? 0) < 2 || duplicates.includes(name)) continue;
    duplicates.push(name);
  }
  return duplicates;
};

const duplicateHeadersError = (headers: HeaderPair[]): string => {
  const names = duplicateHeaderNames(headers);
  return `请求头名称「${names.join('」、「')}」重复。请改成不同的名称后再保存。`;
};

export function modelErrors(p: ProviderDraft, m: ModelDraft, idx: number): FieldErrors {
  const e: FieldErrors = {};
  const id = m.id.trim();
  if (!id) e.id = '填写模型 ID';
  else if (/\s/.test(m.id)) e.id = 'ID 不能包含空格';
  else if (p.models.some((other, i) => i < idx && other.id === m.id)) e.id = '这个提供方里已有同名模型';
  const caps = capErrors(modelCap(m), CAP_FMT_ERR);
  if (caps.cw) e.contextWindow = caps.cw;
  if (caps.mt) e.maxTokens = caps.mt;
  if (isPi(p) && m.reasoningEfforts && typeof m.reasoningEfforts === 'object') {
    const known = ALL_EFFORTS.some((level) => has(m.reasoningEfforts as object, level));
    if (!known) e.efforts = '勾选至少一档，或改为不思考。';
    for (const level of ALL_EFFORTS) {
      if (m.reasoningEfforts[level] === '') e[`spell_${level}`] = '线上拼写不能为空；与档名相同或写成 null。';
    }
  }
  return e;
}

export function routeErrors(p: ProviderDraft): FieldErrors {
  const e: FieldErrors = {};
  if (isPi(p) && has(p, 'apiKeyEnv') && !String(p.apiKeyEnv ?? '').trim()) e.apiKeyEnv = '填写密钥环境变量名。';
  if (p.headers && duplicateHeaderNames(p.headers).length) e.headers = duplicateHeadersError(p.headers);
  // 只校验用户正在输入的原文；加载来的值不报错，直到被编辑。
  if (p.timeoutText !== undefined) {
    const timeout = timeoutError(p.timeoutText);
    if (timeout) e.streamIdleTimeoutMs = timeout;
  }
  return e;
}

export function allErrors(d: DraftState): AllErrors {
  const result: AllErrors = {};
  for (const [id, p] of Object.entries(d.providers)) {
    const route = routeErrors(p);
    const models = p.models.map((m, i) => modelErrors(p, m, i));
    if (Object.keys(route).length || models.some((m) => Object.keys(m).length)) result[id] = { route, models };
  }
  return result;
}

export function idWarn(id: string): string {
  if (!id.trim()) return '';
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? '' : '建议使用小写字母、数字和连字符。';
}

export function providerIdError(id: string, d: DraftState): string {
  const value = id.trim();
  if (!value) return '填写提供方 ID';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return 'ID 只能含小写字母、数字和连字符，不能含点号。';
  if (has(d.providers, value)) return '已有这个提供方 ID';
  return '';
}

export function wizardErrors(w: WizardDraft, d: DraftState): { id?: string; models?: string; headers?: string; timeout?: string } {
  const e: { id?: string; models?: string; headers?: string; timeout?: string } = {};
  const idError = providerIdError(w.id, d);
  if (idError) e.id = idError;
  const trimmed = w.models.map((model) => model.trim());
  const duplicate = trimmed.find((id, i) => id && trimmed.indexOf(id) !== i);
  if (duplicate) e.models = `这个提供方里已有同名模型：${duplicate}`;
  else if (w.models.some((model) => /\s/.test(model.trim()))) e.models = 'ID 不能包含空格';
  if (duplicateHeaderNames(w.headers).length) e.headers = duplicateHeadersError(w.headers);
  const timeout = timeoutError(w.timeoutText ?? '');
  if (timeout) e.timeout = timeout;
  return e;
}

export function secretError(value: string): string {
  if (!value) return '';
  const error = '密钥只能包含 ASCII 非空白字符，不能写成环境变量赋值，也不能首尾用同一种引号包住。';
  if (!/^[\x21-\x7E]+$/.test(value)) return error;
  if (/^[A-Z][A-Z0-9_]*=[^=]/.test(value)) return error;
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length >= 2 && (first === '"' || first === "'") && last === first) return error;
  return '';
}

export function modelCapBad(m: ModelDraft): boolean {
  const c = modelCap(m);
  return capFmtBad(c.cw) || capFmtBad(c.mt) || capBlocks(c);
}

export { deriveEnv };
