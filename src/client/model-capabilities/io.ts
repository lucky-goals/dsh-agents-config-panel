import { parse, stringify } from 'yaml';
import { exportTimestamp } from '../shared/import-export';
import { parseCap } from './capacity';
import { orderedEfforts } from './efforts';
import { DS_ROUTE_ID, NS_DS, NS_PI, SUGGESTED_TIMEOUT_MS, TIMEOUT_KEY, type DraftState, type ModelDraft, type ProviderDraft, type ReasoningMap } from './types';
import { DS_FIELDS, fieldOut, modelOut, PI_FIELDS, SKIP } from './ops';
import { durationLabel, validTimeoutMs } from './timeout';

export type ImportItemKind = 'new' | 'conflict' | 'invalid' | 'skip';

export interface ImportItem {
  kind: ImportItemKind;
  id: string;
  label: string;
  reason: string;
  checked: boolean;
  checkable: boolean;
  provider?: ProviderDraft;
  deepseek?: {
    thinking?: 'enabled' | 'disabled';
    reasoningEffort?: string;
    streamIdleTimeoutMs?: number;
    models: ModelDraft[];
    extra: Record<string, unknown>;
  };
}

export interface ParsedModelFile {
  providers: Record<string, unknown>;
  deepseek?: Record<string, unknown>;
}

export interface ModelImportPreview {
  items: ImportItem[];
  warning: string;
}

export interface ImportContext {
  hasDs: boolean;
}

const KIND = 'wuyou-model-capabilities';
const WARNING_TEXT =
  '文件不应包含密钥或请求头。这些字段会被丢弃，不会进入草稿。baseURL 和 apiKeyEnv 会随新提供方写入草稿，分享来的文件请先看过。';
const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DS_RESERVED_IDS = new Set(['deepseek', DS_ROUTE_ID]);
const SENSITIVE_KEYS = new Set(['headers', 'apikey', 'secret', 'token', 'authorization', 'password']);
const SECURITY_KEYS = new Set(['secrets', 'secretSet', 'credConfigured', 'credWritable', '__proto__', 'constructor', 'prototype']);
const PI_DEFAULT_KEYS = new Set(['defaultInput', 'reasoning', 'defaultContextWindow', 'defaultMaxTokens']);
const DS_DEFAULT_KEYS = new Set(['defaultContextWindow', 'maxTokens']);
const PI_KNOWN_KEYS = new Set([...PI_FIELDS, 'models', 'id', 'ns']);
const DS_KNOWN_KEYS = new Set([...DS_FIELDS, 'models', 'id', 'ns', 'apiKeyEnv']);
const MODEL_KNOWN_KEYS = new Set([
  'id',
  'name',
  'contextWindow',
  'maxTokens',
  'input',
  'inputModalities',
  'reasoningEfforts',
  '_stash',
]);
const MODEL_DEFAULT_KEYS = new Set([...PI_DEFAULT_KEYS, ...DS_DEFAULT_KEYS].filter((key) => key !== 'reasoning'));
const clone = <T>(value: T): T => structuredClone(value);
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanExtra(value: unknown, blocked: ReadonlySet<string>): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.trim().toLowerCase();
    if (blocked.has(key) || SECURITY_KEYS.has(key) || SENSITIVE_KEYS.has(normalized)) continue;
    if (Array.isArray(item)) out[key] = item.map((entry) => cleanNested(entry));
    else if (isRecord(item)) out[key] = cleanNested(item);
    else out[key] = clone(item);
  }
  return out;
}

function cleanNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => cleanNested(entry));
  if (isRecord(value)) return cleanExtra(value, SECURITY_KEYS);
  return clone(value);
}

function providerExtra(p: ProviderDraft): Record<string, unknown> {
  const blocked = new Set([...SECURITY_KEYS, ...PI_KNOWN_KEYS, ...PI_DEFAULT_KEYS]);
  return cleanExtra(p.extra, blocked);
}

function deepseekExtra(p: ProviderDraft): Record<string, unknown> {
  const blocked = new Set([...SECURITY_KEYS, ...DS_KNOWN_KEYS, ...DS_DEFAULT_KEYS]);
  return cleanExtra(p.extra, blocked);
}

function modelExtra(m: ModelDraft): Record<string, unknown> {
  const blocked = new Set([...SECURITY_KEYS, ...MODEL_KNOWN_KEYS, ...MODEL_DEFAULT_KEYS, 'apiKeyEnv']);
  return cleanExtra(m.extra, blocked);
}

function modelExport(p: ProviderDraft, m: ModelDraft): Record<string, unknown> {
  const raw = modelOut(p, m);
  const out: Record<string, unknown> = {};
  if (p.ns === NS_DS) {
    for (const key of ['id', 'name', 'contextWindow', 'maxTokens', 'inputModalities']) {
      if (has(raw, key)) out[key] = raw[key];
    }
  } else {
    Object.assign(out, raw);
  }
  Object.assign(out, modelExtra(m));
  return out;
}

function piExport(p: ProviderDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PI_FIELDS) {
    if (key === 'headers') continue;
    const value = fieldOut(p, key);
    if (value !== undefined && value !== SKIP) out[key] = clone(value);
  }
  Object.assign(out, providerExtra(p));
  out.models = p.models.map((model) => modelExport(p, model));
  return out;
}

function deepseekExport(p: ProviderDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DS_FIELDS) {
    const value = fieldOut(p, key);
    if (value !== undefined && value !== SKIP) out[key] = clone(value);
  }
  Object.assign(out, deepseekExtra(p));
  out.models = p.models.map((model) => modelExport(p, model));
  for (const model of out.models as Array<Record<string, unknown>>) {
    delete model.input;
    delete model.reasoningEfforts;
  }
  return out;
}

export function modelExportFilename(date?: Date): string {
  return `wuyou-models-${exportTimestamp(date ?? new Date())}.yaml`;
}

export function exportModelConfig(base: DraftState, opts?: { date?: Date }): string {
  const providers: Record<string, unknown> = {};
  let deepseek: ProviderDraft | undefined;
  for (const [id, provider] of Object.entries(base.providers)) {
    if (provider.ns === NS_DS || id === DS_ROUTE_ID || provider.id === DS_ROUTE_ID) {
      if (!deepseek) deepseek = provider;
      continue;
    }
    if (provider.ns !== NS_PI) continue;
    providers[id] = piExport(provider);
  }

  const root: Record<string, unknown> = {
    kind: KIND,
    version: 1,
    providers,
  };
  if (deepseek) root.deepseek = deepseekExport(deepseek);
  const header = [
    '# 无忧模型能力配置导出',
    `# 导出时间: ${(opts?.date ?? new Date()).toISOString()}`,
    '# 不含密钥，不含请求头。',
    '# baseURL 和 apiKeyEnv 属于接入信息，分享前请检查。',
    '',
  ].join('\n');
  return header + stringify(root, { lineWidth: 0 });
}

export function parseModelConfig(text: string): ParsedModelFile {
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    throw error;
  }
  if (!isRecord(value)) throw new Error('文件内容不是 YAML 映射，无法识别为导出文件');
  if (value.kind !== KIND) throw new Error('不是模型能力导出文件');
  if (value.version !== 1) throw new Error(`不支持的文件版本：${String(value.version)}`);
  if (has(value, 'providers') && !isRecord(value.providers)) throw new Error('providers 必须是映射');
  if (has(value, 'deepseek') && !isRecord(value.deepseek)) throw new Error('deepseek 必须是映射');
  return {
    providers: isRecord(value.providers) ? value.providers : {},
    ...(isRecord(value.deepseek) ? { deepseek: value.deepseek } : {}),
  };
}

function asId(raw: Record<string, unknown>): string {
  return raw.id == null ? '' : String(raw.id);
}

function capText(value: unknown): string {
  return value == null ? '' : String(value);
}

function modelError(raw: Record<string, unknown>, owner: string, seen: Set<string>): { id: string; reason: string } | null {
  const id = asId(raw);
  if (!id.trim()) return { id, reason: `${owner} 的模型 ID 不合法：模型 ID 不能为空` };
  if (/\s/.test(id)) return { id, reason: `${owner} 的模型 ID 不合法：模型 ID '${id}' 不能包含空格` };
  if (seen.has(id)) return { id, reason: `${owner} 的模型 ID 不合法：模型 ID '${id}' 重复` };
  seen.add(id);
  for (const key of ['contextWindow', 'maxTokens'] as const) {
    if (has(raw, key) && parseCap(capText(raw[key])) === null) {
      return { id, reason: `${owner} 的模型 '${id}' 容量格式不正确` };
    }
  }
  return null;
}

function modelDraftFrom(raw: Record<string, unknown>, pi: boolean): ModelDraft {
  const out: ModelDraft = { id: asId(raw), extra: {} };
  if (raw.name !== undefined && raw.name !== null) out.name = String(raw.name);
  if (raw.contextWindow !== undefined && parseCap(capText(raw.contextWindow)) !== undefined) out.contextWindow = capText(raw.contextWindow);
  if (raw.maxTokens !== undefined && parseCap(capText(raw.maxTokens)) !== undefined) out.maxTokens = capText(raw.maxTokens);
  if (pi && Array.isArray(raw.input)) out.input = clone(raw.input) as ModelDraft['input'];
  if (Array.isArray(raw.inputModalities)) out.inputModalities = clone(raw.inputModalities) as ModelDraft['inputModalities'];
  if (pi) {
    if (raw.reasoningEfforts === false) out.reasoningEfforts = false;
    else if (isRecord(raw.reasoningEfforts)) out.reasoningEfforts = orderedEfforts(clone(raw.reasoningEfforts) as ReasoningMap);
    else out.reasoningEfforts = false;
  }
  const blocked = new Set([
    ...SECURITY_KEYS,
    ...MODEL_KNOWN_KEYS,
    ...MODEL_DEFAULT_KEYS,
    ...(pi ? [] : ['apiKeyEnv']),
  ]);
  out.extra = cleanExtra(raw, blocked);
  return out;
}

function providerPayload(id: string, raw: Record<string, unknown>): ProviderDraft {
  const out: ProviderDraft = {
    id,
    ns: NS_PI,
    models: [],
    extra: {},
    credConfigured: false,
    credWritable: true,
  };
  if (typeof raw.api === 'string') out.api = raw.api;
  if (typeof raw.displayName === 'string' && raw.displayName.trim()) out.displayName = raw.displayName;
  if (typeof raw.baseURL === 'string' && raw.baseURL.trim()) out.baseURL = raw.baseURL;
  if (typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim()) out.apiKeyEnv = raw.apiKeyEnv;
  // 合法值（含小数）导入时取整；new 与 conflict 合并共用这份载荷（r4b §5）。
  if (validTimeoutMs(raw[TIMEOUT_KEY])) out.streamIdleTimeoutMs = Math.round(raw[TIMEOUT_KEY]);
  const models = Array.isArray(raw.models) ? raw.models : [];
  out.models = models.map((value) => modelDraftFrom(isRecord(value) ? value : {}, true));
  const blocked = new Set([...SECURITY_KEYS, ...PI_KNOWN_KEYS, ...PI_DEFAULT_KEYS]);
  out.extra = cleanExtra(raw, blocked);
  return out;
}

function deepseekPayload(raw: Record<string, unknown>): NonNullable<ImportItem['deepseek']> {
  const out: NonNullable<ImportItem['deepseek']> = { models: [], extra: {} };
  if (raw.thinking === 'enabled' || raw.thinking === 'disabled') out.thinking = raw.thinking;
  if (typeof raw.reasoningEffort === 'string') out.reasoningEffort = raw.reasoningEffort;
  // 合法值（含小数）导入时取整；new 与 conflict 合并共用这份载荷（r4b §5）。
  if (validTimeoutMs(raw[TIMEOUT_KEY])) out.streamIdleTimeoutMs = Math.round(raw[TIMEOUT_KEY]);
  const models = Array.isArray(raw.models) ? raw.models : [];
  out.models = models.map((value) => modelDraftFrom(isRecord(value) ? value : {}, false));
  const blocked = new Set([...SECURITY_KEYS, ...DS_KNOWN_KEYS, ...DS_DEFAULT_KEYS]);
  out.extra = cleanExtra(raw, blocked);
  return out;
}

const TIMEOUT_RANGE = '应为 1000–2147483647 的毫秒数';

/** 文件里有该键但不是合法毫秒数（含字符串、0、负数、越界）。 */
function badTimeout(raw: Record<string, unknown>): boolean {
  return has(raw, TIMEOUT_KEY) && !validTimeoutMs(raw[TIMEOUT_KEY]);
}

/** conflict 的 reason 后缀：文件值与本地显式值不同（含本地未设置）时才追加。 */
function timeoutSuffix(fileMs: number | undefined, localMs: number | undefined): string {
  if (fileMs === undefined || fileMs === localMs) return '';
  return `；流空闲超时将改为 ${durationLabel(fileMs)}`;
}

function invalidItem(id: string, label: string, reason: string): ImportItem {
  return { kind: 'invalid', id, label, reason, checked: false, checkable: false };
}

function validateProvider(id: string, value: unknown, draft: DraftState): ImportItem {
  const labelFrom = (raw: Record<string, unknown>): string =>
    typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : id;
  if (!PROVIDER_ID.test(id)) return invalidItem(id, id, `提供方 ID '${id}' 不合法`);
  if (DS_RESERVED_IDS.has(id)) return invalidItem(id, id, `提供方 ID '${id}' 保留给 DeepSeek，不能作为自定义提供方`);
  // Names inherited from Object.prototype (e.g. `constructor`) resolve through the prototype chain
  // wherever drafts are read with plain `providers[id]`, so they can never be used as provider IDs.
  if (id in Object.prototype || id === 'prototype') {
    return invalidItem(id, id, `提供方 ID '${id}' 是保留名，不能作为自定义提供方`);
  }
  if (!isRecord(value)) return invalidItem(id, id, `提供方 '${id}' 不是映射`);
  const label = labelFrom(value);
  if (typeof value.api !== 'string' || !value.api.trim()) return invalidItem(id, label, `提供方 '${id}' 缺少 api`);
  if (badTimeout(value)) return invalidItem(id, label, `提供方 '${id}' 的 streamIdleTimeoutMs 不合法：${TIMEOUT_RANGE}`);
  const models = Array.isArray(value.models) ? value.models : [];
  const seen = new Set<string>();
  for (const rawValue of models) {
    const raw = isRecord(rawValue) ? rawValue : {};
    const error = modelError(raw, `提供方 '${id}'`, seen);
    if (error) return invalidItem(id, label, error.reason);
    if (raw.reasoningEfforts !== undefined && raw.reasoningEfforts !== false && !isRecord(raw.reasoningEfforts)) {
      return invalidItem(id, label, `提供方 '${id}' 的模型 '${asId(raw)}' 的 reasoningEfforts 不合法`);
    }
  }
  const provider = providerPayload(id, value);
  const conflict = has(draft.providers, id);
  // 新提供方文件里没有该键 → 用建议值 30 分钟；conflict 不补。
  if (!conflict && !has(value, TIMEOUT_KEY)) provider.streamIdleTimeoutMs = SUGGESTED_TIMEOUT_MS;
  const suffix = conflict ? timeoutSuffix(provider.streamIdleTimeoutMs, draft.providers[id].streamIdleTimeoutMs) : '';
  return {
    kind: conflict ? 'conflict' : 'new',
    id,
    label,
    reason: conflict ? `提供方 '${id}' 已存在${suffix}` : `将新增提供方 '${id}'`,
    checked: !conflict,
    checkable: true,
    provider,
  };
}

function validateDeepseek(value: Record<string, unknown>, draft: DraftState, ctx: ImportContext): ImportItem {
  const label = 'DeepSeek 官方';
  if (!ctx.hasDs || !has(draft.providers, DS_ROUTE_ID)) {
    return { kind: 'skip', id: 'deepseek', label, reason: '本机没有 DeepSeek，已跳过', checked: false, checkable: false };
  }
  if (badTimeout(value)) return invalidItem('deepseek', label, `DeepSeek 的 streamIdleTimeoutMs 不合法：${TIMEOUT_RANGE}`);
  const models = Array.isArray(value.models) ? value.models : [];
  const seen = new Set<string>();
  for (const rawValue of models) {
    const raw = isRecord(rawValue) ? rawValue : {};
    const error = modelError(raw, 'DeepSeek', seen);
    if (error) return invalidItem('deepseek', label, error.reason);
  }
  const payload = deepseekPayload(value);
  return {
    kind: 'conflict',
    id: 'deepseek',
    label,
    reason: `DeepSeek 已存在${timeoutSuffix(payload.streamIdleTimeoutMs, draft.providers[DS_ROUTE_ID].streamIdleTimeoutMs)}`,
    checked: false,
    checkable: true,
    deepseek: payload,
  };
}

export function previewModelImport(file: ParsedModelFile, draft: DraftState, ctx: ImportContext): ModelImportPreview {
  const items: ImportItem[] = [];
  for (const [id, value] of Object.entries(file.providers ?? {})) items.push(validateProvider(id, value, draft));
  if (file.deepseek !== undefined) items.push(validateDeepseek(file.deepseek, draft, ctx));
  return { items, warning: WARNING_TEXT };
}

export function applyModelImport(
  draft: DraftState,
  items: readonly ImportItem[],
  selection: ReadonlySet<string>,
): DraftState {
  const next = clone(draft);
  for (const item of items) {
    if (!selection.has(item.id) || (item.kind !== 'new' && item.kind !== 'conflict')) continue;
    if (item.provider) {
      const payload = clone(item.provider);
      if (item.kind === 'new') {
        next.providers[item.id] = payload;
        continue;
      }
      if (!has(next.providers, item.id)) continue;
      const local = next.providers[item.id];
      if (!local) continue;
      local.api = payload.api;
      local.models = payload.models;
      local.extra = payload.extra;
      if (has(payload, 'displayName')) local.displayName = payload.displayName;
      else delete local.displayName;
      // 载荷有值 → 覆盖本地并丢弃正在输入的原文；无值 → 保留本地（旧导出文件不带这个键）。
      if (payload.streamIdleTimeoutMs !== undefined) {
        local.streamIdleTimeoutMs = payload.streamIdleTimeoutMs;
        delete local.timeoutText;
      }
      continue;
    }
    if (!item.deepseek) continue;
    if (!has(next.providers, DS_ROUTE_ID)) continue;
    const local = next.providers[DS_ROUTE_ID];
    if (!local) continue;
    const payload = clone(item.deepseek);
    local.models = payload.models;
    if (has(payload, 'thinking')) local.thinking = payload.thinking;
    if (has(payload, 'reasoningEffort')) local.reasoningEffort = payload.reasoningEffort;
    if (payload.streamIdleTimeoutMs !== undefined) {
      local.streamIdleTimeoutMs = payload.streamIdleTimeoutMs;
      delete local.timeoutText;
    }
    local.extra = { ...local.extra, ...payload.extra };
  }
  return next;
}
