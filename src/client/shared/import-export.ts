/**
 * Import/export files for both panels (v2.2 / v2.3).
 *
 * Panel A files carry the ACP registrations and the subagent tools of the
 * current DSH profile, so a profile (web, desktop, cli, ...) can be moved to
 * another machine or another profile in one file. Panel B files carry the
 * members of one agent-teams profile. Files are plain YAML; imports never
 * overwrite: anything that already exists is skipped with a reason.
 */
import { parse, stringify } from 'yaml';
import type {
  AcpConfig,
  AcpRow,
  SubagentBundle,
  SubagentBundleInput,
  SubagentRow,
} from './api-types';

export const MAX_IMPORT_BYTES = 1024 * 1024;
export const EXPORT_FORMAT_VERSION = 3;

export interface PreviewItem<T> {
  item: T;
  /** Absent: will be imported. Present: skipped for this reason. */
  skip?: string;
}

// ----------------------------------------------------------------------------
// File helpers
// ----------------------------------------------------------------------------

/** `YYYYMMDD-HHmmss` in local time. */
export function exportTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Keep profile names safe inside a file name. */
function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'profile';
}

export function subagentExportFilename(dshProfile: string | undefined, date = new Date()): string {
  return `wuyou-subagents-${fileSafe(dshProfile ?? 'profile')}-${exportTimestamp(date)}.yaml`;
}

export function membersExportFilename(teamProfile: string, date = new Date()): string {
  return `wuyou-members-${fileSafe(teamProfile)}-${exportTimestamp(date)}.yaml`;
}

/** Trigger a browser download of `content`. */
export function downloadYaml(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/yaml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Read an import file, rejecting anything over {@link MAX_IMPORT_BYTES}. */
export async function readImportFile(file: File): Promise<string> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('文件超过 1MB 上限');
  return file.text();
}

function parseRoot(yamlText: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = parse(yamlText);
  } catch (err) {
    throw new Error(`YAML 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('文件内容不是 YAML 映射，无法识别为导出文件');
  }
  return data as Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function header(title: string, lines: string[]): string {
  return [`# ${title}`, ...lines.map((line) => `# ${line}`), ''].join('\n');
}

// ----------------------------------------------------------------------------
// Panel A: ACP registrations + subagent tools
// ----------------------------------------------------------------------------

function exportedAcp(row: AcpRow): AcpConfig {
  const { providerName, command, args, cwd, permission, env } = row.config;
  return { providerName, command, args, ...(cwd !== undefined ? { cwd } : {}), permission, env };
}

function exportedSubagent(row: SubagentRow): SubagentBundleInput {
  const config = row.config as Record<string, any>;
  const out: SubagentBundleInput = { toolName: String(config.toolName ?? ''), provider: String(config.provider ?? '') };
  if (config.backgroundMode === 'continuable' || config.backgroundMode === 'one-shot') out.backgroundMode = config.backgroundMode;
  const options = config.agentOptions;
  if (isObject(options) && typeof options.provider === 'string' && typeof options.model === 'string') {
    out.agentOptions = {
      provider: options.provider,
      model: options.model,
      ...(typeof options.reasoningEffort === 'string' ? { reasoningEffort: options.reasoningEffort } : {}),
    };
  }
  return out;
}

export function exportSubagentBundle(
  acps: readonly AcpRow[],
  rows: readonly SubagentRow[],
  dshProfile: string | undefined,
  date = new Date(),
): string {
  const text = header('无忧Subagent 配置导出', [
    `来源 DSH profile: ${dshProfile ?? '未知'}`,
    `导出时间: ${date.toISOString()}`,
    '包含 ACP 注册（command/args/env）和 subagent 工具。env 可能含密钥，分享前请检查；',
    'command 是本机路径，导入到其他电脑后请确认路径存在。',
  ]);
  return text + stringify(
    {
      kind: 'wuyou-subagents',
      version: EXPORT_FORMAT_VERSION,
      dshProfile: dshProfile ?? null,
      acps: acps.map(exportedAcp),
      subagents: rows.map(exportedSubagent),
    },
    { lineWidth: 0 },
  );
}

/**
 * Parse a Panel A export. Accepts v2.3 files (`acps` + `subagents`) and v2.2
 * files (`subagents` only, rows may carry an `id`). Values are copied field by
 * field, so unknown keys never reach the Host.
 */
export function parseSubagentBundle(yamlText: string): SubagentBundle & { dshProfile?: string } {
  const data = parseRoot(yamlText);
  if (data.acps === undefined && data.subagents === undefined) {
    throw new Error('文件中没有 acps 或 subagents，不是无忧Subagent 导出文件');
  }
  for (const key of ['acps', 'subagents'] as const) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`${key} 必须是列表`);
  }
  const acps = ((data.acps as unknown[]) ?? []).map((raw): AcpConfig => {
    const v = isObject(raw) ? raw : {};
    return {
      providerName: v.providerName as string,
      command: v.command as string,
      args: (v.args ?? []) as string[],
      ...(v.cwd !== undefined ? { cwd: v.cwd as string } : {}),
      permission: (v.permission ?? 'reject') as AcpConfig['permission'],
      env: (v.env ?? {}) as Record<string, string>,
    };
  });
  const subagents = ((data.subagents as unknown[]) ?? []).map((raw): SubagentBundleInput => {
    const v = isObject(raw) ? raw : {};
    return {
      toolName: v.toolName as string,
      provider: v.provider as string,
      ...(v.backgroundMode !== undefined ? { backgroundMode: v.backgroundMode as SubagentBundleInput['backgroundMode'] } : {}),
      ...(v.agentOptions !== undefined ? { agentOptions: v.agentOptions as SubagentBundleInput['agentOptions'] } : {}),
    };
  });
  return {
    acps,
    subagents,
    ...(typeof data.dshProfile === 'string' ? { dshProfile: data.dshProfile } : {}),
  };
}

export interface SubagentImportPreview {
  sourceProfile?: string;
  acps: PreviewItem<AcpConfig>[];
  subagents: PreviewItem<SubagentBundleInput>[];
}

/**
 * Client-side classification for the preview dialog. The Host re-checks
 * everything inside its lock; this only tells the user what to expect.
 */
export function previewSubagentImport(
  bundle: SubagentBundle & { dshProfile?: string },
  current: { acps: readonly AcpRow[]; rows: readonly SubagentRow[]; providers: readonly string[] },
): SubagentImportPreview {
  const acpNames = new Set(current.acps.map((a) => a.config.providerName));
  const incoming = new Set<string>();
  const acps = bundle.acps.map((item): PreviewItem<AcpConfig> => {
    if (typeof item.providerName !== 'string' || item.providerName === '') return { item, skip: '缺少 providerName' };
    if (typeof item.command !== 'string' || item.command === '') return { item, skip: '缺少 command' };
    if (acpNames.has(item.providerName)) return { item, skip: `ACP '${item.providerName}' 已存在` };
    if (incoming.has(item.providerName)) return { item, skip: '文件中重复' };
    incoming.add(item.providerName);
    return { item };
  });

  const known = new Set([...current.providers, ...acpNames, ...incoming]);
  const toolNames = new Set(current.rows.map((r) => String((r.config as Record<string, unknown>).toolName ?? '')));
  const seen = new Set<string>();
  const subagents = bundle.subagents.map((item): PreviewItem<SubagentBundleInput> => {
    if (typeof item.toolName !== 'string' || item.toolName === '') return { item, skip: '缺少 toolName' };
    if (toolNames.has(item.toolName)) return { item, skip: `工具名 '${item.toolName}' 已存在` };
    if (seen.has(item.toolName)) return { item, skip: '文件中重复' };
    if (!known.has(item.provider)) return { item, skip: `provider '${item.provider}' 未注册，且文件中没有对应的 ACP` };
    seen.add(item.toolName);
    return { item };
  });

  return { ...(bundle.dshProfile ? { sourceProfile: bundle.dshProfile } : {}), acps, subagents };
}

/** Only the entries the preview marked importable. */
export function importableBundle(preview: SubagentImportPreview): SubagentBundle {
  return {
    acps: preview.acps.filter((p) => !p.skip).map((p) => p.item),
    subagents: preview.subagents.filter((p) => !p.skip).map((p) => p.item),
  };
}

// ----------------------------------------------------------------------------
// Panel B: all agent-teams team profiles (v2.6)
// ----------------------------------------------------------------------------

/** Keys agent-teams accepts in a team profile; anything else is dropped on export/import. */
const TEAM_PROFILE_KEYS = ['description', 'protocol', 'executionPrompt', 'fallback', 'members', 'tasks', 'taskPlanning', 'reviewPolicy'];
const TEAM_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export type TeamProfile = Record<string, unknown>;

export interface TeamFileEntry {
  name: string;
  profile: TeamProfile;
  /** `members`: from a v2.2–v2.5 file that carried one team's members only. */
  scope: 'full' | 'members';
}

export interface TeamPreview extends TeamFileEntry {
  status: 'new' | 'conflict' | 'invalid';
  fileMembers: number;
  /** Members of the existing team with this name (conflict only). */
  currentMembers?: number;
  /** Why an invalid entry is skipped. */
  reason?: string;
  warnings: string[];
}

function knownProfileKeys(profile: unknown): TeamProfile {
  const source = isObject(profile) ? profile : {};
  return Object.fromEntries(TEAM_PROFILE_KEYS.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));
}

export function teamsExportFilename(dshProfile: string | undefined, date = new Date()): string {
  return `wuyou-teams-${fileSafe(dshProfile ?? 'profile')}-${exportTimestamp(date)}.yaml`;
}

/** Every team profile with its full config (description, protocol, members, ...). */
export function exportTeams(profiles: Record<string, TeamProfile>, dshProfile: string | undefined, date = new Date()): string {
  const names = Object.keys(profiles);
  const text = header('无忧Teams 配置导出', [
    `来源 DSH profile: ${dshProfile ?? '未知'}`,
    `团队 profile: ${names.join(', ')}`,
    `导出时间: ${date.toISOString()}`,
  ]);
  return text + stringify(
    {
      kind: 'wuyou-teams',
      version: 4,
      dshProfile: dshProfile ?? null,
      profiles: Object.fromEntries(names.map((name) => [name, knownProfileKeys(profiles[name])])),
    },
    { lineWidth: 0 },
  );
}

/** v2.6 files (`profiles` map) and v2.2–v2.5 files (`members` of one team). */
export function parseTeamsFile(yamlText: string): { sourceProfile?: string; teams: TeamFileEntry[] } {
  const data = parseRoot(yamlText);
  const sourceProfile = typeof data.dshProfile === 'string' ? data.dshProfile : undefined;
  if (data.profiles !== undefined) {
    if (!isObject(data.profiles)) throw new Error('profiles 必须是映射（团队名 → 配置）');
    const teams = Object.entries(data.profiles).map(([name, profile]): TeamFileEntry => ({ name, profile: knownProfileKeys(profile), scope: 'full' }));
    return { ...(sourceProfile ? { sourceProfile } : {}), teams };
  }
  if (Array.isArray(data.members)) {
    const name = typeof data.profile === 'string' && data.profile !== '' ? data.profile : 'imported';
    return { teams: [{ name, profile: { members: data.members }, scope: 'members' }] };
  }
  throw new Error('文件中没有 profiles 或 members，不是无忧Teams 导出文件');
}

/** Client-side classification for the preview; the Host re-validates inside its lock. */
export function previewTeamsImport(
  file: { teams: TeamFileEntry[] },
  existing: Record<string, TeamProfile>,
  catalogProviders: readonly string[],
): TeamPreview[] {
  const providers = new Set(catalogProviders);
  const seen = new Set<string>();
  return file.teams.map((team) => {
    const members = Array.isArray(team.profile.members) ? team.profile.members : [];
    const base = { ...team, fileMembers: members.length, warnings: [] as string[] };
    const invalid = (reason: string): TeamPreview => ({ ...base, status: 'invalid', reason });
    if (!TEAM_NAME.test(team.name)) return invalid(`团队名 '${team.name}' 格式不合法`);
    if (seen.has(team.name)) return invalid('文件中重复');
    seen.add(team.name);
    if (members.length === 0) return invalid('团队至少需要一个成员');
    if (!members.every((m) => isObject(m) && typeof m.name === 'string' && m.name !== '')) return invalid('有成员缺少 name');
    for (const member of members as Array<Record<string, unknown>>) {
      if (typeof member.provider === 'string' && providers.size > 0 && !providers.has(member.provider)) {
        base.warnings.push(`成员 ${member.name} 的 provider '${member.provider}' 不在本机模型目录中`);
      }
    }
    if (team.scope === 'members') base.warnings.push('旧版文件只含成员：覆盖时只替换成员，保留描述与协议');
    const current = existing[team.name];
    if (current === undefined) return { ...base, status: 'new' };
    const currentMembers = Array.isArray(current.members) ? current.members.length : 0;
    return { ...base, status: 'conflict', currentMembers };
  });
}

export interface TeamsImportRequestBody {
  expectedRevision: string;
  teams: TeamFileEntry[];
  overwrite: string[];
}

/** New teams and conflicts are sent; the Host only replaces names in `overwrite`. */
export function teamsImportRequest(preview: readonly TeamPreview[], overwrite: ReadonlySet<string>, revision: string): TeamsImportRequestBody {
  const sent = preview.filter((p) => p.status !== 'invalid');
  return {
    expectedRevision: revision,
    teams: sent.map(({ name, profile, scope }) => ({ name, profile, scope })),
    overwrite: sent.filter((p) => p.status === 'conflict' && overwrite.has(p.name)).map((p) => p.name),
  };
}
