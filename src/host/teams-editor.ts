/**
 * Team profiles of agent-teams (v2.6): list all, create (blank or cloned),
 * and import several at once with an explicit overwrite list.
 *
 * Writes mirror the rules agent-teams 0.1.21 enforces when it reads
 * `config.profiles` (lib/profiles.js), because a bad profile there breaks the
 * captain prompt of every session, not just one team:
 * - at most {@link MAX_TEAM_PROFILES} profiles;
 * - only the known profile / member keys;
 * - at least one member, at most `maxMembers` (default 8);
 * - member names non-empty, not `captain`, unique after key sanitizing;
 * - a member `provider` needs a `model`.
 * Task DAG details are left to agent-teams itself.
 */
import { isMap, stringify, type Document, type YAMLMap } from 'yaml';
import {
  applyFieldEdits,
  findAgentTeamsConfig,
  guardMutation,
  lineStart,
  mapKeyColumn,
  nodeJson,
  nodeRange,
  pairFor,
  pairValue,
  parseYaml,
  scalarString,
  yamlKey,
  yamlValue,
} from './patch-io.js';
import type { MutationResult } from './types.js';

/** agent-teams MAX_TEAM_PROFILES. */
export const MAX_TEAM_PROFILES = 16;
const MAX_PROFILE_TASKS = 32;
const DEFAULT_MAX_MEMBERS = 8;
const PROFILE_KEYS = ['description', 'protocol', 'executionPrompt', 'fallback', 'members', 'tasks', 'taskPlanning', 'reviewPolicy'];
const MEMBER_KEYS = ['name', 'role', 'provider', 'model', 'reasoning_effort', 'executionPrompt', 'fallback'];
/** Team profile names this panel writes: safe as `--profile <name>` and as a plain YAML key. */
const TEAM_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MEMBER_NAME = /^[a-z][a-z0-9-]*$/;
const NO_AGENT_TEAMS = '未找到 agent-teams 配置，请确认已安装 @nanmicoder/dsh-agent-teams';
const NO_PROFILES = 'agent-teams 配置里没有块格式的 profiles 映射，无法写入团队';

export type TeamProfile = Record<string, unknown>;

export interface TeamImportEntry {
  name: string;
  profile: TeamProfile;
  /** `members`: a v2.2–v2.5 file that carries only members; overwrite replaces just them. */
  scope?: 'full' | 'members';
}

export interface TeamImportReport {
  created: string[];
  overwritten: string[];
  skipped: Array<{ name: string; reason: string }>;
}

function error(code: Exclude<MutationResult, { ok: true }>['code'], message: string): MutationResult & { ok: false } {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** agent-teams sanitizeKey, minus the length cap (only used to detect collisions). */
function memberKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

interface Located {
  document: Document;
  config: YAMLMap;
  profiles: YAMLMap;
}

function locate(yamlText: string): Located | (MutationResult & { ok: false }) {
  const document = parseYaml(yamlText);
  const config = findAgentTeamsConfig(document);
  if (!config) return error('STRUCTURE', NO_AGENT_TEAMS);
  const profiles = pairValue(config, 'profiles');
  if (!isMap(profiles) || (profiles as { flow?: boolean }).flow || profiles.items.length === 0) {
    return error('STRUCTURE', NO_PROFILES);
  }
  return { document, config, profiles };
}

function isFailure(value: unknown): value is MutationResult & { ok: false } {
  return isRecord(value) && value.ok === false;
}

function names(profiles: YAMLMap): string[] {
  return profiles.items.map((pair) => scalarString(pair.key));
}

function maxMembers(config: YAMLMap): number {
  const value = nodeJson<unknown>(pairValue(config, 'maxMembers'));
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_MAX_MEMBERS;
}

export function listTeamProfileConfigs(yamlText: string): Record<string, TeamProfile> {
  const located = locate(yamlText);
  if (isFailure(located)) throw new Error(located.message);
  const out: Record<string, TeamProfile> = {};
  for (const pair of located.profiles.items) {
    const value = nodeJson<unknown>(pair.value);
    out[scalarString(pair.key)] = isRecord(value) ? value : {};
  }
  return out;
}

// ----------------------------------------------------------------------------
// Validation (same rules agent-teams applies when it reads the profile)
// ----------------------------------------------------------------------------

function validateMembers(members: unknown, limit: number): string | null {
  if (!Array.isArray(members) || members.length === 0) return '团队至少需要一个成员（members 不能为空）';
  if (members.length > limit) return `成员数 ${members.length} 超过 agent-teams 的 maxMembers（${limit}）`;
  const seen = new Map<string, string>();
  for (const [index, member] of members.entries()) {
    if (!isRecord(member)) return `members[${index}] 必须是映射`;
    const unknown = Object.keys(member).find((key) => !MEMBER_KEYS.includes(key));
    if (unknown) return `成员字段 ${unknown} 不被 agent-teams 支持`;
    const name = member.name;
    if (typeof name !== 'string' || name.trim() === '') return `members[${index}] 缺少 name`;
    if (memberKey(name) === 'captain') return `成员名 '${name}' 是 captain 保留名`;
    const key = memberKey(name);
    if (seen.has(key)) return `成员 '${seen.get(key)}' 与 '${name}' 重名`;
    seen.set(key, name);
    if (member.provider !== undefined && member.model === undefined) return `成员 '${name}' 设置了 provider 但没有 model`;
  }
  return null;
}

function validateProfile(profile: unknown, limit: number): string | null {
  if (!isRecord(profile)) return '团队配置必须是映射';
  const unknown = Object.keys(profile).find((key) => !PROFILE_KEYS.includes(key));
  if (unknown) return `团队字段 ${unknown} 不被 agent-teams 支持`;
  for (const key of ['description', 'protocol', 'executionPrompt']) {
    if (profile[key] !== undefined && (typeof profile[key] !== 'string' || profile[key] === '')) return `${key} 必须是非空字符串`;
  }
  if (profile.taskPlanning !== undefined && profile.taskPlanning !== 'captain' && profile.taskPlanning !== 'seed') {
    return "taskPlanning 只能是 'captain' 或 'seed'";
  }
  if (profile.tasks !== undefined && (!Array.isArray(profile.tasks) || profile.tasks.length > MAX_PROFILE_TASKS)) {
    return `tasks 必须是最多 ${MAX_PROFILE_TASKS} 项的列表`;
  }
  for (const key of ['reviewPolicy', 'fallback']) {
    if (profile[key] !== undefined && !isRecord(profile[key])) return `${key} 必须是映射`;
  }
  return validateMembers(profile.members, limit);
}

function validateName(name: unknown): string | null {
  if (typeof name !== 'string' || !TEAM_NAME.test(name)) {
    return `团队名 '${String(name)}' 格式不合法：小写字母或数字开头，只能包含小写字母、数字、.、_、-`;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Source generation
// ----------------------------------------------------------------------------

/** `key: value` at `indent`; collections in block style, nested under the key. */
function blockPair(key: string, value: unknown, indent: string): string {
  const empty = (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);
  if (value === null || typeof value !== 'object' || empty) {
    const { text, block } = yamlValue(key, value, indent);
    return `${indent}${yamlKey(key)}: ${text}${block ? '' : '\n'}`;
  }
  const child = `${indent}  `;
  const body = stringify(value, { lineWidth: 0 }).replace(/\n$/, '').split('\n')
    .map((line) => (line === '' ? '' : `${child}${line}`)).join('\n');
  return `${indent}${yamlKey(key)}:\n${body}\n`;
}

function profileSource(name: string, profile: TeamProfile, keyIndent: string): string {
  const inner = `${keyIndent}  `;
  return `${keyIndent}${yamlKey(name)}:\n${Object.entries(profile).map(([k, v]) => blockPair(k, v, inner)).join('')}`;
}

/** Offset after the last profile, with a leading newline if the map does not end in one. */
function appendOffset(yamlText: string, profiles: YAMLMap): { offset: number; lead: string } {
  const end = nodeRange(profiles)![1];
  return { offset: end, lead: end > 0 && yamlText[end - 1] !== '\n' ? '\n' : '' };
}

/** Source range of a whole `name: {...}` pair: key line start through the value's last line. */
function pairRange(yamlText: string, map: YAMLMap, key: string): [number, number] | undefined {
  const pair = pairFor(map, key);
  const keyRange = nodeRange(pair?.key);
  const valueRange = nodeRange(pair?.value);
  if (!keyRange || !valueRange) return undefined;
  let end = valueRange[1];
  if (yamlText[end - 1] !== '\n') {
    const newline = yamlText.indexOf('\n', end);
    end = newline < 0 ? yamlText.length : newline + 1;
  }
  return [lineStart(yamlText, keyRange[0]), end];
}

// ----------------------------------------------------------------------------
// Mutations
// ----------------------------------------------------------------------------

export interface CreateTeamInput {
  name: string;
  /** Existing team to copy; absent = a new team. */
  from?: string;
  description?: string;
  /** New team only: agent-teams needs at least one member. */
  firstMember?: string;
}

export function createTeamProfile(yamlText: string, input: CreateTeamInput): MutationResult {
  return guardMutation('name', () => {
    const located = locate(yamlText);
    if (isFailure(located)) return located;
    const { profiles } = located;
    const nameError = validateName(input.name);
    if (nameError) return error('INVALID', nameError);
    const existing = names(profiles);
    if (existing.includes(input.name)) return error('DUPLICATE', `团队 '${input.name}' 已存在`);
    if (existing.length >= MAX_TEAM_PROFILES) {
      return error('INVALID', `agent-teams 最多支持 ${MAX_TEAM_PROFILES} 个团队 profile，当前已有 ${existing.length} 个`);
    }
    const { offset, lead } = appendOffset(yamlText, profiles);
    const keyIndent = mapKeyColumn(yamlText, profiles);

    let text: string;
    if (input.from !== undefined) {
      const range = pairRange(yamlText, profiles, input.from);
      if (!range) return error('NOT_FOUND', `未找到团队 '${input.from}'`);
      // Byte copy of the source (comments, block scalars, key order), renamed.
      const source = yamlText.slice(range[0], range[1]);
      const keyNode = pairFor(profiles, input.from)!.key;
      const keyStart = nodeRange(keyNode)![0] - range[0];
      const keyEnd = nodeRange(keyNode)![1] - range[0];
      text = `${source.slice(0, keyStart)}${yamlKey(input.name)}${source.slice(keyEnd)}`;
    } else {
      const member = input.firstMember;
      if (typeof member !== 'string' || member === '') return error('INVALID', '新建团队需要填写第一个成员名（agent-teams 要求至少一个成员）');
      if (!MEMBER_NAME.test(member)) return error('INVALID', `成员名 '${member}' 格式不合法`);
      if (member === 'captain') return error('INVALID', "成员名 'captain' 是 captain 保留名");
      const profile: TeamProfile = {};
      const description = input.description?.trim();
      if (description) profile.description = description;
      profile.members = [{ name: member }];
      text = profileSource(input.name, profile, keyIndent);
    }
    return { ok: true, yamlText: applyFieldEdits(yamlText, [{ start: offset, end: offset, text: `${lead}${text}`, field: 'name' }], 'name') };
  });
}

/**
 * Import team profiles in one pass. A team that already exists is replaced
 * only when its name is in `overwrite`; otherwise it is skipped. Invalid
 * entries are skipped with a reason; nothing else in the file changes.
 */
export function importTeamProfiles(
  yamlText: string,
  entries: TeamImportEntry[],
  overwrite: readonly string[],
): { ok: true; yamlText: string; report: TeamImportReport } | (MutationResult & { ok: false }) {
  const report: TeamImportReport = { created: [], overwritten: [], skipped: [] };
  let text = yamlText;
  const handled = new Set<string>();

  for (const entry of entries) {
    const name = typeof entry?.name === 'string' ? entry.name : String(entry?.name);
    const skip = (reason: string) => report.skipped.push({ name, reason });
    const nameError = validateName(entry?.name);
    if (nameError) { skip(nameError); continue; }
    if (handled.has(name)) { skip('文件中重复'); continue; }
    handled.add(name);

    const located = locate(text);
    if (isFailure(located)) return located;
    const { profiles, config } = located;
    const limit = maxMembers(config);
    const exists = names(profiles).includes(name);
    const membersOnly = entry.scope === 'members';
    const problem = membersOnly ? validateMembers(entry.profile?.members, limit) : validateProfile(entry.profile, limit);
    if (problem) { skip(problem); continue; }
    if (exists && !overwrite.includes(name)) { skip(`团队 '${name}' 已存在，未选择覆盖`); continue; }
    if (!exists && names(profiles).length >= MAX_TEAM_PROFILES) {
      skip(`agent-teams 最多支持 ${MAX_TEAM_PROFILES} 个团队 profile`);
      continue;
    }

    const keyIndent = mapKeyColumn(text, profiles);
    let edit: { start: number; end: number; text: string };
    if (!exists) {
      const profile = membersOnly ? { members: entry.profile.members } : entry.profile;
      const { offset, lead } = appendOffset(text, profiles);
      edit = { start: offset, end: offset, text: `${lead}${profileSource(name, profile, keyIndent)}` };
    } else if (membersOnly) {
      const profile = pairValue(profiles, name) as YAMLMap;
      const source = blockPair('members', entry.profile.members, mapKeyColumn(text, profile));
      // Replace the existing members pair; a profile without one gets it appended.
      const range = pairRange(text, profile, 'members');
      if (range) {
        edit = { start: range[0], end: range[1], text: source };
      } else {
        const { offset, lead } = appendOffset(text, profile);
        edit = { start: offset, end: offset, text: `${lead}${source}` };
      }
    } else {
      const range = pairRange(text, profiles, name)!;
      edit = { start: range[0], end: range[1], text: profileSource(name, entry.profile, keyIndent) };
    }
    text = applyFieldEdits(text, [{ ...edit, field: name }], name);
    (exists ? report.overwritten : report.created).push(name);
  }
  return { ok: true, yamlText: text, report };
}

/**
 * Delete one team profile: its key line through the end of its value. Teams
 * already created from it keep working (agent-teams snapshots the profile at
 * create time); only new `--profile <name>` calls fail. The last team is kept
 * because the panel and agent-teams expect a non-empty profiles map.
 */
export function removeTeamProfile(yamlText: string, name: string): MutationResult {
  return guardMutation('name', () => {
    const located = locate(yamlText);
    if (isFailure(located)) return located;
    const { profiles } = located;
    const existing = names(profiles);
    if (!existing.includes(name)) return error('NOT_FOUND', `未找到团队 '${name}'`);
    if (existing.length <= 1) return error('LAST_TEAM', '至少需要保留一个团队 profile，不能删除最后一个团队');
    const range = pairRange(yamlText, profiles, name)!;
    return { ok: true, yamlText: applyFieldEdits(yamlText, [{ start: range[0], end: range[1], text: '', field: 'name' }], 'name') };
  });
}

export const TEAM_PROFILE_KEYS: readonly string[] = PROFILE_KEYS;
