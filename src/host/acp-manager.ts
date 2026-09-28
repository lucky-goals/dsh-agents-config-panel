/**
 * ACP provider registrations (v2.3): root `- insert:` entries named
 * `@deepseek-ai/dsh-subagent-acp`. Each one mounts a `subagents` provider
 * (`config.providerName`) backed by a spawned ACP agent process. Config keys
 * follow the package schema: providerName, command, args, cwd, permission, env.
 *
 * Pure text transforms like the other editors: every write is a source edit
 * that leaves all bytes outside the edited entry unchanged.
 */
import { isDeepStrictEqual } from 'node:util';
import { isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import {
  applyFieldEdits,
  findSubagentSequence,
  guardMutation,
  indentationAt,
  lineStart,
  mapKeyColumn,
  nodeJson,
  nodeRange,
  pairFor,
  pairValue,
  parseYaml,
  removePairEdit,
  scalarString,
  setPairEdit,
  yamlValue,
  type FieldTextEdit,
} from './patch-io.js';
import { ACP_REGISTRATION_NAME, type SubagentProviderInfo } from './subagent-providers.js';
import { createSubagent } from './subagent-manager.js';
import type { SubagentInput } from './subagent-manager-types.js';
import type { ModelCatalog } from './catalog.js';
import type { MutationResult } from './types.js';

export type AcpPermission = 'allow' | 'reject';

export interface AcpConfig {
  providerName: string;
  command: string;
  args: string[];
  cwd?: string;
  permission: AcpPermission;
  env: Record<string, string>;
}

export interface AcpRow {
  id: string;
  disabled: boolean;
  config: AcpConfig;
  /** toolNames of the subagent rows whose provider is this ACP. */
  usedBy: string[];
}

/** Update patch; `cwd: null` removes the key. providerName is never renamed. */
export interface AcpPatch {
  command?: string;
  args?: string[];
  cwd?: string | null;
  permission?: AcpPermission;
  env?: Record<string, string>;
}

export const ACP_EDITABLE_FIELDS = ['command', 'args', 'cwd', 'permission', 'env'] as const;

const PROVIDER_NAME = /^[a-z][a-z0-9_-]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PROVIDERS = ['spawn', 'fork'];
/** Package default when `permission` is omitted. */
const DEFAULT_PERMISSION: AcpPermission = 'reject';

function error(code: Exclude<MutationResult, { ok: true }>['code'], message: string): MutationResult & { ok: false } {
  return { ok: false, code, message };
}

interface AcpEntry {
  /** The root `- insert:` item holding the entry. */
  rootItem: YAMLMap;
  insert: YAMLSeq;
  entry: YAMLMap;
}

function rootSequence(document: Document): YAMLSeq | undefined {
  return isSeq(document.contents) ? document.contents : undefined;
}

function acpEntries(document: Document): AcpEntry[] {
  const root = rootSequence(document);
  if (!root) return [];
  const entries: AcpEntry[] = [];
  for (const rootItem of root.items) {
    if (!isMap(rootItem)) continue;
    const insert = pairValue(rootItem, 'insert');
    if (!isSeq(insert)) continue;
    for (const entry of insert.items) {
      if (isMap(entry) && scalarString(pairValue(entry, 'name')) === ACP_REGISTRATION_NAME) {
        entries.push({ rootItem, insert, entry });
      }
    }
  }
  return entries;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
}

function entryConfig(entry: YAMLMap): AcpConfig {
  const raw = nodeJson<Record<string, unknown>>(pairValue(entry, 'config'));
  const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    providerName: typeof config.providerName === 'string' ? config.providerName : 'acp',
    command: typeof config.command === 'string' ? config.command : '',
    args: stringList(config.args),
    ...(typeof config.cwd === 'string' ? { cwd: config.cwd } : {}),
    permission: config.permission === 'allow' ? 'allow' : DEFAULT_PERMISSION,
    env: stringMap(config.env),
  };
}

function subagentUsage(document: Document): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const row of findSubagentSequence(document)?.items ?? []) {
    if (scalarString(pairValue(row, 'name')) !== '@deepseek-ai/dsh-tool-subagent') continue;
    const config = nodeJson<Record<string, unknown>>(pairValue(row, 'config')) ?? {};
    const provider = String(config.provider ?? '');
    usage.set(provider, [...(usage.get(provider) ?? []), String(config.toolName ?? '')]);
  }
  return usage;
}

export function listAcps(yamlText: string): AcpRow[] {
  const document = parseYaml(yamlText);
  const usage = subagentUsage(document);
  return acpEntries(document).map(({ entry }) => {
    const config = entryConfig(entry);
    const disabled = nodeJson<unknown>(pairValue(entry, 'disabled'));
    return {
      id: scalarString(pairValue(entry, 'id')),
      disabled: disabled === true || disabled === 'true',
      config,
      usedBy: usage.get(config.providerName) ?? [],
    };
  });
}

// ----------------------------------------------------------------------------
// Validation
// ----------------------------------------------------------------------------

function validateFields(input: Partial<Record<keyof AcpConfig, unknown>>, partial: boolean): string | null {
  const has = (key: keyof AcpConfig) => input[key] !== undefined;
  if (!partial || has('command')) {
    if (typeof input.command !== 'string' || input.command.trim() === '') return 'command 必须是非空字符串';
  }
  if (has('args') && (!Array.isArray(input.args) || !input.args.every((a) => typeof a === 'string'))) {
    return 'args 必须是字符串数组';
  }
  if (has('cwd') && input.cwd !== null && (typeof input.cwd !== 'string' || input.cwd.trim() === '')) {
    return 'cwd 必须是非空字符串，或不设置';
  }
  if (has('permission') && input.permission !== 'allow' && input.permission !== 'reject') {
    return "permission 只能是 'allow' 或 'reject'";
  }
  if (has('env')) {
    const env = input.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return 'env 必须是键值对象';
    for (const [key, value] of Object.entries(env)) {
      if (!ENV_KEY.test(key)) return `env 变量名 '${key}' 不合法`;
      if (typeof value !== 'string') return `env.${key} 必须是字符串`;
    }
  }
  return null;
}

function validateProviderName(name: unknown, taken: readonly string[]): MutationResult | null {
  if (typeof name !== 'string' || !PROVIDER_NAME.test(name)) {
    return error('INVALID', `ACP 名称 '${String(name)}' 不合法：小写字母开头，只能包含小写字母、数字、- 和 _`);
  }
  if (RESERVED_PROVIDERS.includes(name)) return error('INVALID', `'${name}' 是内置 provider，不能作为 ACP 名称`);
  if (taken.includes(name)) return error('DUPLICATE', `ACP '${name}' 已存在`);
  return null;
}

// ----------------------------------------------------------------------------
// Source generation
// ----------------------------------------------------------------------------

function allIds(document: Document): Set<string> {
  const ids = new Set<string>();
  for (const item of rootSequence(document)?.items ?? []) {
    ids.add(scalarString(pairValue(item, 'id')));
    const insert = pairValue(item, 'insert');
    if (isSeq(insert)) for (const entry of insert.items) ids.add(scalarString(pairValue(entry, 'id')));
  }
  return ids;
}

function uniqueId(document: Document, providerName: string): string {
  const ids = allIds(document);
  const base = `subagent-acp-${providerName}`;
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function pairLine(field: string, key: string, value: unknown, indent: string): string {
  const { text, block } = yamlValue(field, value, indent);
  return `${indent}${key}: ${text}${block ? '' : '\n'}`;
}

/** A root `- insert:` item at `indent` holding one ACP entry. Empty args/env/cwd are omitted. */
function acpRootItemSource(id: string, config: AcpConfig, indent: string): string {
  // Same layout as the real rows: entry dash at +4, entry keys at +6, config keys at +8.
  const entry = `${indent}      `;
  const keys = `${entry}  `;
  let source = `${indent}- insert:\n`;
  source += `${indent}    - id: ${yamlValue('id', id, entry).text}\n`;
  source += `${entry}name: '${ACP_REGISTRATION_NAME}'\n`;
  source += `${entry}config:\n`;
  source += pairLine('providerName', 'providerName', config.providerName, keys);
  source += pairLine('command', 'command', config.command, keys);
  if (config.args.length > 0) source += pairLine('args', 'args', config.args, keys);
  if (config.cwd !== undefined) source += pairLine('cwd', 'cwd', config.cwd, keys);
  source += pairLine('permission', 'permission', config.permission, keys);
  if (Object.keys(config.env).length > 0) source += pairLine('env', 'env', config.env, keys);
  return source;
}

function normalizeInput(input: Partial<AcpConfig>): AcpConfig {
  return {
    providerName: input.providerName!,
    command: input.command!,
    args: input.args ?? [],
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    permission: input.permission ?? DEFAULT_PERMISSION,
    env: input.env ?? {},
  };
}

// ----------------------------------------------------------------------------
// Mutations
// ----------------------------------------------------------------------------

export function createAcp(yamlText: string, input: Partial<AcpConfig>): MutationResult {
  return guardMutation('input', () => {
    const document = parseYaml(yamlText);
    const root = rootSequence(document);
    if (!root) return error('STRUCTURE', 'cordis.patch.yml 的根不是 YAML 序列');
    const entries = acpEntries(document);

    const nameError = validateProviderName(input.providerName, entries.map(({ entry }) => entryConfig(entry).providerName));
    if (nameError) return nameError;
    const fieldError = validateFields(input, false);
    if (fieldError) return error('INVALID', fieldError);

    const config = normalizeInput(input);
    // Right after the last ACP root item, else after the last root item. A
    // block item's range ends after its last content line, before any blank
    // separator, so the new item is written as "\n<item>" and the existing
    // separator stays below it. removeAcp drops exactly that leading blank.
    const anchor = entries.at(-1)?.rootItem ?? root.items.at(-1);
    const anchorRange = nodeRange(anchor);
    const offset = anchorRange?.[1] ?? yamlText.length;
    // Leading whitespace before the anchor's `- ` (block item maps start at their first key).
    const indent = anchorRange ? indentationAt(yamlText, anchorRange[0]) : '';
    const lead = offset > 0 && yamlText[offset - 1] !== '\n' ? '\n' : '';
    const text = `${lead}\n${acpRootItemSource(uniqueId(document, config.providerName), config, indent)}`;
    return { ok: true, yamlText: applyFieldEdits(yamlText, [{ start: offset, end: offset, text, field: 'input' }], 'input') };
  });
}

function findEntry(document: Document, id: string): AcpEntry | undefined {
  return acpEntries(document).find(({ entry }) => scalarString(pairValue(entry, 'id')) === id);
}

/**
 * Replace a block collection value with a flow one on the key's line, so
 * `args:\n  - a\n  - b` becomes `args: [ a, b ]` instead of a flow list
 * dangling on the next line.
 */
function blockCollectionEdit(text: string, map: YAMLMap, key: string, value: unknown): FieldTextEdit | undefined {
  const pair = pairFor(map, key);
  const node = pair?.value as unknown;
  if (!(isSeq(node) || isMap(node)) || (node as { flow?: boolean }).flow) return undefined;
  if (isDeepStrictEqual(nodeJson(node), value)) return undefined;
  const keyEnd = nodeRange(pair!.key)?.[1];
  const valueEnd = nodeRange(node)?.[1];
  if (keyEnd === undefined || valueEnd === undefined) return undefined;
  const { text: serialized } = yamlValue(key, value, mapKeyColumn(text, map));
  const newline = text[valueEnd - 1] === '\n' ? '\n' : '';
  return { start: keyEnd, end: valueEnd, text: `: ${serialized}${newline}`, field: key };
}

export function updateAcp(yamlText: string, id: string, patch: AcpPatch): MutationResult {
  return guardMutation('patch', () => {
    if ('providerName' in (patch as object)) {
      return error('INVALID', 'providerName 不能修改：subagent 工具按名称引用它。请新建 ACP 后迁移工具');
    }
    const unknown = Object.keys(patch).filter((k) => !(ACP_EDITABLE_FIELDS as readonly string[]).includes(k));
    if (unknown.length > 0) return error('INVALID', `不支持的字段：${unknown.join(', ')}`);
    const fieldError = validateFields(patch, true);
    if (fieldError) return error('INVALID', fieldError);

    const document = parseYaml(yamlText);
    const found = findEntry(document, id);
    if (!found) return error('NOT_FOUND', `未找到 ACP '${id}'`);
    const config = pairValue(found.entry, 'config');
    if (!isMap(config)) return error('STRUCTURE', `ACP '${id}' 的 config 不是映射`);

    const edits: FieldTextEdit[] = [];
    const push = (edit: FieldTextEdit | undefined) => { if (edit) edits.push(edit); };
    for (const key of ACP_EDITABLE_FIELDS) {
      const value = patch[key];
      if (value === undefined) continue;
      const empty = value === null || (Array.isArray(value) && value.length === 0) ||
        (key === 'env' && Object.keys(value as object).length === 0);
      if (empty) push(removePairEdit(yamlText, config, key));
      else push(blockCollectionEdit(yamlText, config, key, value) ?? setPairEdit(yamlText, config, key, value));
    }
    // A cleared `permission` is not representable; validateFields already rejects it.
    if (edits.length === 0) return { ok: true, yamlText };
    return { ok: true, yamlText: applyFieldEdits(yamlText, edits, 'patch') };
  });
}

export function removeAcp(yamlText: string, id: string): MutationResult {
  return guardMutation('id', () => {
    const document = parseYaml(yamlText);
    const found = findEntry(document, id);
    if (!found) return error('NOT_FOUND', `未找到 ACP '${id}'`);
    const { providerName } = entryConfig(found.entry);
    const users = subagentUsage(document).get(providerName) ?? [];
    if (users.length > 0) {
      return error('IN_USE', `ACP '${providerName}' 仍被 subagent 工具使用：${users.join('、')}。请先删除或改用其他 provider`);
    }
    // Sole entry: drop the whole root item; otherwise just the entry.
    const target = found.insert.items.length === 1 ? found.rootItem : found.entry;
    const range = nodeRange(target);
    if (!range) return error('STRUCTURE', `ACP '${id}' 缺少源码位置`);
    let start = lineStart(yamlText, range[0]);
    // Take the blank separator line above with it (the inverse of createAcp).
    // Comments directly above the item are left in place.
    if (start >= 2 && yamlText[start - 1] === '\n' && yamlText[start - 2] === '\n') start -= 1;
    return { ok: true, yamlText: applyFieldEdits(yamlText, [{ start, end: range[1], text: '', field: 'id' }], 'id') };
  });
}

// ----------------------------------------------------------------------------
// Bundle import (Panel A export file: ACPs + subagent tools)
// ----------------------------------------------------------------------------

export interface SubagentBundle {
  acps?: unknown[];
  subagents?: unknown[];
}

export interface BundleImportReport {
  created: { acps: string[]; subagents: string[] };
  skipped: Array<{ kind: 'acp' | 'subagent'; name: string; reason: string }>;
}

const NO_CAPABILITIES = { agentOptions: false, depthLimit: false, continuable: false, persona: false, toolFilter: false };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick<T extends string>(value: Record<string, unknown>, keys: readonly T[]): Partial<Record<T, unknown>> {
  return Object.fromEntries(keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]])) as Partial<Record<T, unknown>>;
}

/**
 * Apply an exported Panel A bundle in one pass: ACP registrations first, then
 * subagent tools. Entries that already exist or fail validation are skipped
 * with a reason; nothing is overwritten. Subagent rows may use ACPs created
 * earlier in the same bundle, or any ACP already registered in this patch
 * (they mount after DSH restarts, like every ACP change).
 */
export function importSubagentBundle(
  yamlText: string,
  bundle: SubagentBundle,
  catalog: ModelCatalog,
  providers: readonly SubagentProviderInfo[],
): { ok: true; yamlText: string; report: BundleImportReport } | (MutationResult & { ok: false }) {
  const report: BundleImportReport = { created: { acps: [], subagents: [] }, skipped: [] };
  let text = yamlText;

  for (const raw of bundle.acps ?? []) {
    const input = isObject(raw) ? pick(raw, ['providerName', 'command', 'args', 'cwd', 'permission', 'env'] as const) : {};
    const name = String(input.providerName ?? '(无名称)');
    const result = createAcp(text, input as Partial<AcpConfig>);
    if (result.ok) {
      text = result.yamlText;
      report.created.acps.push(name);
    } else if (result.code === 'STRUCTURE') {
      return result;
    } else {
      report.skipped.push({ kind: 'acp', name, reason: result.message });
    }
  }

  const known = new Set(providers.map((p) => p.name));
  const directory: SubagentProviderInfo[] = [
    ...providers,
    ...listAcps(text)
      .map((row) => row.config.providerName)
      .filter((name) => !known.has(name))
      .map((name): SubagentProviderInfo => ({ name, kind: 'acp', capabilities: { ...NO_CAPABILITIES }, source: 'patch' })),
  ];

  for (const raw of bundle.subagents ?? []) {
    const input = isObject(raw) ? pick(raw, ['toolName', 'provider', 'backgroundMode', 'agentOptions'] as const) : {};
    const name = String(input.toolName ?? '(无工具名)');
    const result = createSubagent(text, input as unknown as SubagentInput, catalog, directory);
    if (result.ok) {
      text = result.yamlText;
      report.created.subagents.push(name);
    } else if (result.code === 'STRUCTURE') {
      return result;
    } else {
      report.skipped.push({ kind: 'subagent', name, reason: result.message });
    }
  }

  return { ok: true, yamlText: text, report };
}
