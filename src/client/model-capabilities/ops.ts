import { modelCap } from './capacity';
import { deriveEnv, orderedEfforts } from './efforts';
import { modelCapBad } from './validate';
import { parseTimeoutMinutes } from './timeout';
import {
  DS_ROUTE_ID,
  NS_DS,
  NS_PI,
  TIMEOUT_KEY,
  type DraftState,
  type ModelDraft,
  type NamespaceSlice,
  type OpsResult,
  type ProviderDraft,
  type RemoteError,
  type SettingsOp,
} from './types';

export const SKIP: unique symbol = Symbol('skip');

export const PI_FIELDS = ['api', 'displayName', 'baseURL', 'apiKeyEnv', 'headers', 'streamIdleTimeoutMs'] as const;
export const DS_FIELDS = ['thinking', 'reasoningEffort', 'streamIdleTimeoutMs'] as const;

const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
const isPi = (p: ProviderDraft): boolean => p.ns === NS_PI;
const clone = <T>(value: T): T => structuredClone(value);
const routeValuePrototype = { length: 1 };
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function modelCapOut(out: Record<string, unknown>, m: ModelDraft): void {
  if (modelCapBad(m)) return;
  const c = modelCap(m);
  if (c.cw.explicit && typeof c.cw.parsed === 'number') out[c.cw.key] = c.cw.parsed;
  if (c.mt.explicit && typeof c.mt.parsed === 'number') out[c.mt.key] = c.mt.parsed;
}

export function modelOut(p: ProviderDraft, m: ModelDraft): Record<string, unknown> {
  const out: Record<string, unknown> = { id: m.id };
  if (m.name) out.name = m.name;
  if (isPi(p)) {
    modelCapOut(out, m);
    if (m.input !== undefined) out.input = m.input.slice();
    if (m.inputModalities !== undefined) out.inputModalities = m.inputModalities.slice();
    if (m.reasoningEfforts === false) out.reasoningEfforts = false;
    else if (m.reasoningEfforts && typeof m.reasoningEfforts === 'object') {
      const ordered = orderedEfforts(m.reasoningEfforts);
      const known = Object.keys(ordered).some((key) => key !== 'off' || Object.prototype.hasOwnProperty.call(ordered, key));
      if (known && Object.keys(ordered).length) out.reasoningEfforts = ordered;
    }
  } else {
    if (m.inputModalities !== undefined) out.inputModalities = m.inputModalities.slice();
    modelCapOut(out, m);
  }
  return out;
}

/** Full model-table representation: preserve adapter-specific fields in `extra`. */
export function modelWrite(p: ProviderDraft, m: ModelDraft): Record<string, unknown> {
  return { ...clone(m.extra), ...modelOut(p, m) };
}

export function fieldOut(p: ProviderDraft, key: string): unknown | typeof SKIP {
  if (key === TIMEOUT_KEY) {
    // 正在输入的分钟原文优先；非法原文跳过写入（fieldOps 仍计入 dirty）。
    if (p.timeoutText !== undefined) {
      const parsed = parseTimeoutMinutes(p.timeoutText);
      if (parsed.kind === 'error') return SKIP;
      return parsed.kind === 'empty' ? undefined : parsed.ms;
    }
    return p.streamIdleTimeoutMs;
  }
  const value = (p as unknown as Record<string, unknown>)[key];
  if (key === 'apiKeyEnv' && has(p, key) && !String(value ?? '').trim()) return SKIP;
  if (value == null) return undefined;
  if ((key === 'displayName' || key === 'baseURL') && String(value).trim() === '') return undefined;
  if (key === 'headers') {
    const out: Record<string, string> = {};
    const seen = new Set<string>();
    let duplicate = false;
    const add = (rawName: unknown, rawValue: unknown) => {
      const name = String(rawName ?? '').trim();
      if (!name) return;
      if (seen.has(name)) duplicate = true;
      seen.add(name);
      out[name] = String(rawValue ?? '');
    };
    if (Array.isArray(value)) {
      for (const pair of value) {
        if (!pair || typeof pair !== 'object') continue;
        const item = pair as { k?: unknown; v?: unknown };
        add(item.k, item.v);
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) add(name, headerValue);
    }
    if (duplicate) return SKIP;
    return Object.keys(out).length ? out : undefined;
  }
  if (Array.isArray(value)) return value.slice();
  return value;
}

function fieldOps(list: SettingsOp[], fields: readonly string[], base: ProviderDraft, draft: ProviderDraft, prefix: readonly string[]): number {
  let changed = 0;
  for (const key of fields) {
    const next = fieldOut(draft, key);
    if (next === SKIP) {
      // base 从不带 timeoutText，出现非法超时原文必然是编辑。
      if (key === TIMEOUT_KEY) {
        changed += 1;
        continue;
      }
      if (!equal((base as unknown as Record<string, unknown>)[key], (draft as unknown as Record<string, unknown>)[key])) changed += 1;
      continue;
    }
    const previous = fieldOut(base, key);
    const previousComparable = previous === SKIP ? undefined : previous;
    if (equal(previousComparable, next)) continue;
    changed += 1;
    const path = [...prefix, key];
    list.push(next === undefined ? { op: 'unset', path } : { op: 'set', path, value: next });
  }
  return changed;
}

function routeWrite(p: ProviderDraft): Record<string, unknown> {
  const out = Object.assign(Object.create(routeValuePrototype) as Record<string, unknown>, clone(p.extra));
  for (const key of PI_FIELDS) {
    const value = fieldOut(p, key);
    if (value !== undefined && value !== SKIP) out[key] = clone(value);
  }
  out.models = p.models.map((m) => modelWrite(p, m));
  return out;
}

function modelTable(p: ProviderDraft): Record<string, unknown>[] {
  return p.models.map((m) => modelOut(p, m));
}

function capBadDirty(base: ProviderDraft, draft: ProviderDraft): boolean {
  return draft.models.some((model, index) => {
    if (!modelCapBad(model)) return false;
    const old = base.models[index];
    return !old || !equal(old.contextWindow, model.contextWindow) || !equal(old.maxTokens, model.maxTokens);
  });
}

export function computeOps(base: DraftState, draft: DraftState, secrets: Readonly<Record<string, string>>): OpsResult {
  const pi: SettingsOp[] = [];
  const ds: SettingsOp[] = [];
  const cred: OpsResult['cred'] = [];
  const dirtySet = new Set<string>();
  const ids = [...new Set([...Object.keys(base.providers), ...Object.keys(draft.providers)])];

  for (const id of ids) {
    const before = base.providers[id];
    const after = draft.providers[id];
    const deepseek = before?.ns === NS_DS || after?.ns === NS_DS || id === DS_ROUTE_ID;
    if (deepseek) {
      if (!before || !after) continue;
      const count = fieldOps(ds, DS_FIELDS, before, after, []);
      const oldModels = modelTable(before);
      const newModels = modelTable(after);
      if (!equal(oldModels, newModels)) {
        ds.push({ op: 'set', path: ['models'], value: newModels.map((m, i) => modelWrite(after, after.models[i])) });
        dirtySet.add(id);
      } else if (capBadDirty(before, after)) {
        dirtySet.add(id);
      }
      if (count) dirtySet.add(id);
      continue;
    }

    if (!after) {
      pi.push({ op: 'unset', path: ['providers', id] });
      dirtySet.add(id);
      const ref = before?.apiKeyEnv && String(before.apiKeyEnv).trim() ? String(before.apiKeyEnv).trim() : deriveEnv(id);
      if (ref) cred.push({ op: 'unset', ref });
      continue;
    }
    if (!before) {
      pi.push({ op: 'set', path: ['providers', id], value: routeWrite(after) });
      dirtySet.add(id);
    } else {
      const count = fieldOps(pi, PI_FIELDS, before, after, ['providers', id]);
      const oldModels = modelTable(before);
      const newModels = modelTable(after);
      if (!equal(oldModels, newModels)) {
        pi.push({ op: 'set', path: ['providers', id, 'models'], value: newModels.map((m, i) => modelWrite(after, after.models[i])) });
        dirtySet.add(id);
      } else if (capBadDirty(before, after)) {
        dirtySet.add(id);
      }
      if (count) dirtySet.add(id);
    }
  }

  for (const [id, secret] of Object.entries(secrets)) {
    if (!secret) continue;
    const route = draft.providers[id];
    if (!route) continue;
    const ref = route.apiKeyEnv && String(route.apiKeyEnv).trim() ? String(route.apiKeyEnv).trim() : deriveEnv(id);
    cred.push({ op: 'set', ref });
    dirtySet.add(id);
  }

  return { pi, ds, cred, dirty: dirtySet.size, dirtySet };
}

function rawProviderObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rawModels(provider: Record<string, unknown>, userProvider: Record<string, unknown>): unknown[] {
  const userModels = userProvider.models;
  if (Array.isArray(userModels)) return userModels;
  return Array.isArray(provider.models) ? provider.models : [];
}

function modelDraft(raw: Record<string, unknown>): ModelDraft {
  const known = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'inputModalities', 'reasoningEfforts', '_stash']);
  const out: ModelDraft = {
    id: String(raw.id ?? ''),
    extra: {},
  };
  if (raw.name !== undefined) out.name = String(raw.name);
  if (raw.contextWindow !== undefined) out.contextWindow = String(raw.contextWindow);
  if (raw.maxTokens !== undefined) out.maxTokens = String(raw.maxTokens);
  if (Array.isArray(raw.input)) out.input = raw.input.slice() as ModelDraft['input'];
  if (Array.isArray(raw.inputModalities)) out.inputModalities = raw.inputModalities.slice() as ModelDraft['inputModalities'];
  if (raw.reasoningEfforts === false) out.reasoningEfforts = false;
  else if (raw.reasoningEfforts && typeof raw.reasoningEfforts === 'object') out.reasoningEfforts = clone(raw.reasoningEfforts) as ModelDraft['reasoningEfforts'];
  if (raw._stash && typeof raw._stash === 'object') out._stash = clone(raw._stash) as ModelDraft['_stash'];
  for (const [key, value] of Object.entries(raw)) if (!known.has(key)) out.extra[key] = clone(value);
  return out;
}

function headerPairs(value: unknown): Array<{ k: string; v: string }> | undefined {
  if (Array.isArray(value)) {
    const pairs = value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const pair = item as { k?: unknown; v?: unknown };
      const key = String(pair.k ?? '');
      return [{ k: key, v: String(pair.v ?? '') }];
    });
    return pairs.length ? pairs : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const pairs = Object.entries(value as Record<string, unknown>).map(([k, v]) => ({ k, v: String(v ?? '') }));
  return pairs.length ? pairs : undefined;
}

function providerDraft(
  id: string,
  ns: 'llm-pi-ai' | 'llm-deepseek',
  valueRaw: Record<string, unknown>,
  userRaw: Record<string, unknown>,
  creds: Record<string, { configured: boolean; writable: boolean }>,
): ProviderDraft {
  const effective = { ...valueRaw, ...userRaw };
  const p: ProviderDraft = {
    id,
    ns,
    models: rawModels(valueRaw, userRaw).map((m) => modelDraft(rawProviderObject(m))),
    extra: {},
    credConfigured: false,
    credWritable: true,
  };
  const fieldNames = ns === NS_PI ? ['api', 'displayName', 'baseURL', 'apiKeyEnv', 'headers'] : ['thinking', 'reasoningEffort', 'apiKeyEnv'];
  for (const key of fieldNames) {
    if (effective[key] !== undefined) {
      if (key === 'headers') {
        const headers = headerPairs(effective[key]);
        if (headers) p.headers = headers;
      } else {
        (p as unknown as Record<string, unknown>)[key] = clone(effective[key]);
      }
    }
  }
  // 流空闲超时只看 user 层：value 层每个路由都有 schema 默认 300000，读它会把默认当显式。
  const userTimeout = has(userRaw, TIMEOUT_KEY) ? userRaw[TIMEOUT_KEY] : undefined;
  if (typeof userTimeout === 'number' && Number.isFinite(userTimeout)) p.streamIdleTimeoutMs = userTimeout;
  const known = new Set([...fieldNames, TIMEOUT_KEY, 'defaultInput', 'reasoning', 'defaultContextWindow', 'defaultMaxTokens', 'maxTokens', 'models']);
  for (const [key, value] of Object.entries(effective)) if (!known.has(key)) p.extra[key] = clone(value);
  const ref = p.apiKeyEnv && String(p.apiKeyEnv).trim() ? String(p.apiKeyEnv).trim() : ns === NS_DS ? 'DEEPSEEK_API_KEY' : deriveEnv(id);
  const status = creds[ref] ?? { configured: false, writable: true };
  p.credConfigured = status.configured;
  p.credWritable = status.writable;
  if (ns === NS_DS) {
    // DeepSeek uses a single flat namespace and the UI exposes it under a stable route id.
    p.id = DS_ROUTE_ID;
  }
  return p;
}

export function draftFromNamespaces(input: {
  pi?: NamespaceSlice | null;
  ds?: NamespaceSlice | null;
  creds: Record<string, { configured: boolean; writable: boolean }>;
}): DraftState {
  const providers: Record<string, ProviderDraft> = {};
  const piValue = rawProviderObject(input.pi?.value).providers;
  const piUser = rawProviderObject(input.pi?.user).providers;
  const valueProviders = rawProviderObject(piValue);
  const userProviders = rawProviderObject(piUser);
  for (const id of Object.keys(valueProviders)) {
    providers[id] = providerDraft(id, NS_PI, rawProviderObject(valueProviders[id]), rawProviderObject(userProviders[id]), input.creds);
  }
  if (input.ds) {
    providers[DS_ROUTE_ID] = providerDraft(DS_ROUTE_ID, NS_DS, input.ds.value, input.ds.user ?? {}, input.creds);
  }
  return { providers };
}

function yamlScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  return /^[A-Za-z0-9._\-/:]+$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text) ? text : JSON.stringify(text);
}

export function yScalar(value: unknown): string {
  return yamlScalar(value);
}

function yaml(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== 'object')) return ` [${value.map(yamlScalar).join(', ')}]`;
    return `\n${value.map((item) => `${pad}- ${yaml(item, indent + 2).replace(/^\n/, '').slice(indent + 2)}`).join('\n')}`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return ' {}';
    return `\n${entries.map(([key, item]) => `${pad}${yamlScalar(key)}:${yaml(item, indent + 2)}`).join('\n')}`;
  }
  return ` ${yamlScalar(value)}`;
}

function opText(op: SettingsOp): string {
  let text = `- op: ${op.op}\n  path: [${op.path.map(yamlScalar).join(', ')}]`;
  if (op.op === 'set') text += `\n  value:${yaml(op.value, 4)}`;
  return text;
}

export function previewText(ops: OpsResult, revision: { pi: number | null; ds: number | null }): string {
  const sections: string[] = [];
  if (ops.pi.length) sections.push(`namespace: ${NS_PI}\nrevision: ${revision.pi ?? 'null'}\n${ops.pi.map(opText).join('\n')}`);
  if (ops.ds.length) sections.push(`namespace: ${NS_DS}\nrevision: ${revision.ds ?? 'null'}\n${ops.ds.map(opText).join('\n')}`);
  if (ops.cred.length) {
    sections.push(`credentials\n${ops.cred.map((op) => `credentials.${op.op}  ${op.ref}  （值不展示）`).join('\n')}`);
  }
  return sections.length ? sections.join('\n\n') : '没有待写入的变更。';
}

export function remoteErrorText(error: RemoteError): string {
  let message: string;
  if (error.code === 'settings/rejected') message = '配置被拒绝';
  else if (error.code === 'gateway/bad-request') message = '请求无效';
  else message = `保存失败（${error.code}）`;
  const details = typeof error.details === 'string' ? error.details : error.details && typeof error.details === 'object' && 'message' in error.details ? String((error.details as { message: unknown }).message) : '';
  return details ? `${message}：${details}` : message;
}

export type { SettingsOp };
