import { isMap } from 'yaml';
import {
  applyFieldEdits,
  findAgentTeamsConfig,
  findMembersSequence,
  findProfileNode,
  guardMutation,
  lineStart,
  nodeJson,
  nodeLineIndent,
  nodeRange,
  pairValue,
  parseYaml,
  scalarString,
  removePairEdit,
  setPairEdit,
  yamlKey,
  yamlValue,
  type FieldTextEdit,
} from './patch-io.js';
import { validateModelRoute, type ModelCatalog } from './catalog.js';
import type { MutationResult } from './types.js';
import { CLEARABLE_MEMBER_FIELDS, type TeamMember, type TeamMemberPatch } from './members-editor-types.js';
import { AGENT_TEAMS_NOT_IN_PATCH as NO_AGENT_TEAMS } from './agent-teams-bootstrap.js';
const memberProfileError = (profile: string) => `未找到团队 profile '${profile}'`;

function error(code: Exclude<MutationResult, { ok: true }>['code'], message: string): MutationResult {
  return { ok: false, code, message };
}

function teamConfig(yamlText: string) {
  const document = parseYaml(yamlText);
  const config = findAgentTeamsConfig(document);
  if (!config) throw new Error(NO_AGENT_TEAMS);
  return { document, config };
}

function profileMembers(yamlText: string, profileName: string) {
  const { document, config } = teamConfig(yamlText);
  const profile = findProfileNode(config, profileName);
  if (!profile) throw new Error(memberProfileError(profileName));
  const members = findMembersSequence(config, profileName);
  if (!members) throw new Error(memberProfileError(profileName));
  return { document, config, profile, members };
}

function memberObject(node: unknown): TeamMember {
  const value = nodeJson<Record<string, unknown>>(node);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { name: '' };
  const name = typeof value.name === 'string' ? value.name : '';
  return { ...value, name } as TeamMember;
}

function memberRows(members: NonNullable<ReturnType<typeof findMembersSequence>>) {
  return members.items.filter((member) => isMap(member));
}

function findMemberNode(
  members: NonNullable<ReturnType<typeof findMembersSequence>>,
  name: string,
): unknown | undefined {
  return memberRows(members).find((member) => memberObject(member).name === name);
}

function validateMember(member: Partial<TeamMember>, catalog: ModelCatalog): string | null {
  if (member.name !== undefined &&
      (typeof member.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(member.name))) {
    return `成员名 '${String(member.name)}' 格式不合法`;
  }
  const provider = member.provider;
  const model = member.model;
  if ((provider === undefined) !== (model === undefined)) {
    return '成员 provider 和 model 必须同时填写';
  }
  if (provider !== undefined && model !== undefined) {
    return validateModelRoute(catalog, provider, model, member.reasoning_effort);
  }
  return null;
}

/** Source for one new sequence item; `indent` is the column of its `- `. */
function memberSource(member: TeamMember, indent: string): string {
  const keys = ['name', 'role', 'provider', 'model', 'reasoning_effort'];
  const extraKeys = Object.keys(member).filter((key) => !keys.includes(key));
  const ordered = [...keys, ...extraKeys].filter((key) => member[key] !== undefined);
  if (ordered.length === 0) return '';
  // Keys of the item map sit two columns right of the dash.
  const keyIndent = `${indent}  `;
  return ordered.map((key, index) => {
    const { text, block } = yamlValue(key, member[key], keyIndent);
    const prefix = index === 0 ? `${indent}- ` : keyIndent;
    return `${prefix}${yamlKey(key)}: ${text}${block ? '' : '\n'}`;
  }).join('');
}

function isStructureError(caught: unknown): caught is Error {
  return caught instanceof Error &&
    (caught.message === NO_AGENT_TEAMS || caught.message.startsWith('未找到团队 profile'));
}

/** Locate a profile's members, mapping structure gaps to STRUCTURE results. */
function locate(yamlText: string, profileName: string): ReturnType<typeof profileMembers> | MutationResult {
  try {
    return profileMembers(yamlText, profileName);
  } catch (caught) {
    if (isStructureError(caught)) return error('STRUCTURE', caught.message);
    throw caught;
  }
}

function isResult(value: unknown): value is MutationResult {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

export function listTeamProfiles(yamlText: string): string[] {
  const { config } = teamConfig(yamlText);
  const profiles = pairValue(config, 'profiles');
  if (!isMap(profiles)) return [];
  return profiles.items.map((profile) => scalarString(profile.key));
}

export function listMembers(yamlText: string, profileName: string): TeamMember[] {
  const { members } = profileMembers(yamlText, profileName);
  return memberRows(members)
    .map(memberObject)
    .filter((member) => member.name.length > 0);
}

export function addMember(
  yamlText: string,
  profileName: string,
  member: TeamMember,
  catalog: ModelCatalog,
): MutationResult {
  return guardMutation('member', () => {
    const located = locate(yamlText, profileName);
    if (isResult(located)) return located;
    const { members } = located;
    if (findMemberNode(members, member.name)) return error('DUPLICATE', `成员 '${member.name}' 已存在`);
    const validation = validateMember(member, catalog);
    if (validation) return error('INVALID', validation);
    const range = nodeRange(members);
    if (!range) return error('STRUCTURE', memberProfileError(profileName));
    const existing = memberRows(members);
    // Column of the existing items' `- `, so the new item is a sibling.
    const indent = existing.length > 0
      ? nodeLineIndent(yamlText, existing[existing.length - 1])
      : nodeLineIndent(yamlText, members);
    const lead = range[1] > 0 && yamlText[range[1] - 1] !== '\n' ? '\n' : '';
    const text = `${lead}${memberSource(member, indent)}`;
    return { ok: true, yamlText: applyFieldEdits(yamlText, [{ start: range[1], end: range[1], text, field: 'member' }], 'member') };
  });
}

export function updateMember(
  yamlText: string,
  profileName: string,
  name: string,
  patch: TeamMemberPatch,
  catalog: ModelCatalog,
): MutationResult {
  const patchKeys = Object.keys(patch).filter((key) => patch[key] !== undefined);
  return guardMutation(patchKeys.join(', ') || 'member', () => {
    // null deletes a clearable field; any other field cannot be cleared.
    const cleared = patchKeys.filter((key) => patch[key] === null);
    const notClearable = cleared.find((key) => !(CLEARABLE_MEMBER_FIELDS as readonly string[]).includes(key));
    if (notClearable !== undefined) return error('INVALID', `字段 ${notClearable} 不能清空`);

    const located = locate(yamlText, profileName);
    if (isResult(located)) return located;
    const { members } = located;
    const target = findMemberNode(members, name);
    if (!target) return error('NOT_FOUND', `未找到成员 '${name}'`);
    const current = memberObject(target);
    // Validate the member as it will be after the clears.
    const merged: Record<string, unknown> = { ...current, ...patch };
    for (const key of cleared) delete merged[key];
    const validation = validateMember(merged as TeamMember, catalog);
    if (validation) return error('INVALID', validation);
    if (typeof patch.name === 'string' && patch.name !== name && findMemberNode(members, patch.name)) {
      return error('DUPLICATE', `成员 '${patch.name}' 已存在`);
    }
    // Unchanged fields and clears of absent keys produce no edit, so re-saving
    // a member is a byte-identical no-op.
    const edits: FieldTextEdit[] = [];
    for (const key of patchKeys) {
      const edit = patch[key] === null
        ? removePairEdit(yamlText, target, key)
        : setPairEdit(yamlText, target, key, patch[key]);
      if (edit) edits.push(edit);
    }
    if (edits.length === 0) return { ok: true, yamlText };
    return { ok: true, yamlText: applyFieldEdits(yamlText, edits, patchKeys.join(', ')) };
  });
}

export function removeMember(yamlText: string, profileName: string, name: string): MutationResult {
  return guardMutation('member', () => {
    const located = locate(yamlText, profileName);
    if (isResult(located)) return located;
    const { members } = located;
    const target = findMemberNode(members, name);
    if (!target) return error('NOT_FOUND', `未找到成员 '${name}'`);
    const existing = memberRows(members);
    if (existing.length <= 1) return error('LAST_MEMBER', '团队至少需要保留一个成员');
    const range = nodeRange(target);
    if (!range) return error('STRUCTURE', memberProfileError(profileName));
    const start = lineStart(yamlText, range[0]);
    return { ok: true, yamlText: applyFieldEdits(yamlText, [{ start, end: range[1], text: '', field: 'member' }], 'member') };
  });
}
