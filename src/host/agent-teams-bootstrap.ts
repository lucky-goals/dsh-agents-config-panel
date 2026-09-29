/**
 * Seed a minimal agent-teams team profile into the user patch layer.
 *
 * `@nanmicoder/dsh-agent-teams` mounts itself from its own bundle patch
 * (`- insert:`), which dsh applies before `cordis.patch.yml`. That bundle
 * config has no `profiles` map. This panel only reads the user layer, and a
 * user-layer entry with the same id replaces the plugin `config` object
 * wholesale, so the seeded entry copies the bundle's scalar fields and adds
 * one editable team profile.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isSeq, type Document, type YAMLMap } from 'yaml';
import {
  applyFieldEdits,
  appendPairEdit,
  guardMutation,
  indentationAt,
  mapKeyColumn,
  nodeJson,
  nodeRange,
  pairFor,
  pairValue,
  parseYaml,
  scalarString,
  yamlKey,
  yamlValue,
  type FieldTextEdit,
} from './patch-io.js';
import type { MutationResult } from './types.js';

export const AGENT_TEAMS_PACKAGE = '@nanmicoder/dsh-agent-teams';
export const BASIC_TEAM_PROFILE = 'standard-acp';
export const BASIC_TEAM_MEMBER = 'generalist';
export const AGENT_TEAMS_NOT_IN_PATCH = '未找到 agent-teams 配置，请确认已安装 @nanmicoder/dsh-agent-teams';
export const BASIC_TEAM_SEEDED_NOTICE =
  '已初始化基础团队配置（profile standard-acp，成员 generalist）。新建会话后生效';

const BASIC_DESCRIPTION = '默认协作团队';
const BASIC_ROLE = '通用成员。直接完成未指派给专用角色的工作，不调用子代理。';

export interface InstalledAgentTeams {
  version: string;
  /** Bundle `config` object. Absent when the package is installed but its patch cannot be read. */
  config?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function error(code: Exclude<MutationResult, { ok: true }>['code'], message: string): MutationResult {
  return { ok: false, code, message };
}

function rootSequence(document: Document) {
  const root = document.contents;
  return isSeq(root) && !(root as { flow?: boolean }).flow ? root : undefined;
}

function rootPlugin(document: Document): YAMLMap | undefined {
  const root = rootSequence(document);
  if (!root) return undefined;
  const found = root.items.find((entry) => scalarString(pairValue(entry, 'id')) === 'agent-teams');
  return isMap(found) ? found : undefined;
}

function usableProfiles(config: unknown): boolean {
  const profiles = pairValue(config, 'profiles');
  return isMap(profiles) && !(profiles as { flow?: boolean }).flow && profiles.items.length > 0;
}

/** Read `config` from a bundle patch, including an `- insert:` row. */
export function readBundleAgentTeamsConfig(bundleYaml: string): Record<string, unknown> | undefined {
  const document = parseYaml(bundleYaml);
  const root = document.contents;
  if (!isSeq(root)) return undefined;
  const configs: unknown[] = [];
  const take = (node: unknown) => {
    if (scalarString(pairValue(node, 'id')) !== 'agent-teams') return;
    const config = pairValue(node, 'config');
    if (isMap(config)) configs.push(nodeJson(config));
  };
  for (const item of root.items) {
    take(item);
    const insert = pairValue(item, 'insert');
    if (!isSeq(insert)) continue;
    for (const entry of insert.items) take(entry);
  }
  const config = configs.find(isRecord);
  return config;
}

/** Installed package under a DSH profile, or undefined when it is not there. */
export function loadInstalledAgentTeams(profileDir: string): InstalledAgentTeams | undefined {
  const dir = join(profileDir, 'node_modules', '@nanmicoder', 'dsh-agent-teams');
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown };
  } catch {
    return undefined;
  }
  if (manifest.name !== AGENT_TEAMS_PACKAGE) return undefined;
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  const patchPath = join(dir, 'cordis.patch.yml');
  if (!existsSync(patchPath)) return { version };
  try {
    const config = readBundleAgentTeamsConfig(readFileSync(patchPath, 'utf8'));
    return config ? { version, config } : { version };
  } catch {
    return { version };
  }
}

function scalarEntries(config: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(config).filter(([key, value]) => key !== 'profiles' && (value === null || typeof value !== 'object'));
}

function scalarLine(indent: string, key: string, value: unknown): string {
  const { text, block } = yamlValue(key, value, indent);
  return `${indent}${yamlKey(key)}: ${text}${block ? '' : '\n'}`;
}

/** Block body under a `profiles:` key. `keyIndent` is the column of that key. */
function basicProfilesBody(keyIndent: string): string {
  const nested = `${keyIndent}  `;
  const description = yamlValue('description', BASIC_DESCRIPTION, `${nested}  `);
  const role = yamlValue('role', BASIC_ROLE, `${nested}      `);
  return [
    `${nested}standard-acp:`,
    `${nested}  description: ${description.text}`,
    `${nested}  members:`,
    `${nested}    - name: ${BASIC_TEAM_MEMBER}`,
    `${nested}      role: ${role.text}`,
    '',
  ].join('\n');
}

function profilesPair(keyIndent: string): string {
  return `${keyIndent}profiles:\n${basicProfilesBody(keyIndent)}`;
}

function configBody(keyIndent: string, bundleConfig: Record<string, unknown>): string {
  const nested = `${keyIndent}  `;
  const scalars = scalarEntries(bundleConfig).map(([key, value]) => scalarLine(nested, key, value)).join('');
  return `${scalars}${profilesPair(nested)}`;
}

function insertAt(yamlText: string, offset: number, block: string, field: string): string {
  const lead = offset > 0 && yamlText[offset - 1] !== '\n' ? '\n' : '';
  const text = `${lead}\n${block.endsWith('\n') ? block : `${block}\n`}`;
  const edit: FieldTextEdit = { start: offset, end: offset, text, field };
  return applyFieldEdits(yamlText, [edit], field);
}

function appendRootEntry(yamlText: string, bundleConfig: Record<string, unknown>): string {
  const document = parseYaml(yamlText);
  const root = rootSequence(document);
  if (!root) return yamlText;
  const anchor = root.items.at(-1);
  const anchorRange = anchor ? nodeRange(anchor) : undefined;
  const offset = anchorRange?.[1] ?? yamlText.length;
  const indent = anchorRange ? indentationAt(yamlText, anchorRange[0]) : '';
  const comment = [
    `${indent}# 无忧Teams 初始化的基础团队。用户层按 id 覆盖会整段替换 agent-teams 的 config，`,
    `${indent}# 因此这里保留插件 bundle 里的原有字段，并补上一个可编辑的团队 profile。`,
  ].join('\n');
  const header = [
    `${indent}- id: agent-teams`,
    `${indent}  name: '${AGENT_TEAMS_PACKAGE}'`,
    `${indent}  config:`,
    '',
  ].join('\n');
  return insertAt(yamlText, offset, `${comment}\n${header}${configBody(`${indent}  `, bundleConfig)}`, 'agent-teams');
}

function appendProfiles(yamlText: string, config: YAMLMap): string {
  const range = nodeRange(config);
  if (!range) throw new Error('agent-teams config 缺少源码位置');
  const indent = mapKeyColumn(yamlText, config);
  return insertAt(yamlText, range[1], profilesPair(indent), 'profiles');
}

function ensureScalarKeys(yamlText: string, bundleConfig: Record<string, unknown>): string {
  let text = yamlText;
  for (const [key, value] of scalarEntries(bundleConfig)) {
    const document = parseYaml(text);
    const plugin = rootPlugin(document);
    const config = pairValue(plugin, 'config');
    if (!isMap(config) || pairFor(config, key)) continue;
    text = applyFieldEdits(text, [appendPairEdit(text, config, key, value, key)], key);
  }
  return text;
}

/**
 * Write the basic team profile into the user patch when it is missing.
 * Returns the original text when a block `profiles` map is already present.
 */
export function seedBasicTeamProfile(yamlText: string, bundleConfig: Record<string, unknown>): MutationResult {
  return guardMutation('agent-teams', () => {
    const bundledProfiles = bundleConfig.profiles;
    if (isRecord(bundledProfiles) && Object.keys(bundledProfiles).length > 0) {
      return error('STRUCTURE', '插件自带的配置里已经有团队 profile，不会再用基础配置覆盖');
    }
    const nested = Object.entries(bundleConfig)
      .filter(([key, value]) => key !== 'profiles' && value !== null && typeof value === 'object')
      .map(([key]) => key);
    if (nested.length > 0) {
      return error('STRUCTURE', `插件 bundle 的 config.${nested.join(', ')} 不是标量，无法安全写入用户层`);
    }
    const document = parseYaml(yamlText);
    if (!rootSequence(document)) return error('STRUCTURE', 'cordis.patch.yml 的根不是 YAML 序列');
    const plugin = rootPlugin(document);
    const pluginName = scalarString(pairValue(plugin, 'name'));
    if (!plugin || (pluginName !== '' && pluginName !== AGENT_TEAMS_PACKAGE)) {
      return { ok: true, yamlText: appendRootEntry(yamlText, bundleConfig) };
    }
    const config = pairValue(plugin, 'config');
    if (!isMap(config)) {
      const range = nodeRange(plugin);
      if (!range) return error('STRUCTURE', 'agent-teams 配置缺少源码位置');
      const indent = mapKeyColumn(yamlText, plugin);
      const block = `${indent}config:\n${configBody(indent, bundleConfig)}`;
      return { ok: true, yamlText: insertAt(yamlText, range[1], block, 'config') };
    }
    if ((config as { flow?: boolean }).flow) {
      return error('STRUCTURE', 'agent-teams 的 config 是行内格式，无法写入团队 profile');
    }
    if (usableProfiles(config)) return { ok: true, yamlText };
    const withScalars = ensureScalarKeys(yamlText, bundleConfig);
    const refreshed = rootPlugin(parseYaml(withScalars));
    const refreshedConfig = pairValue(refreshed, 'config');
    if (!isMap(refreshedConfig)) return error('STRUCTURE', AGENT_TEAMS_NOT_IN_PATCH);
    if (usableProfiles(refreshedConfig)) return { ok: true, yamlText: withScalars };
    return { ok: true, yamlText: appendProfiles(withScalars, refreshedConfig) };
  });
}
