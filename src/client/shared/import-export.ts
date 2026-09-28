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
  TeamMember,
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
// Panel B: team members
// ----------------------------------------------------------------------------

const MEMBER_FIELDS = ['name', 'role', 'provider', 'model', 'reasoning_effort'] as const;

function memberFields(member: Record<string, unknown>): TeamMember {
  const out: Record<string, unknown> = {};
  for (const key of MEMBER_FIELDS) {
    if (member[key] !== undefined && member[key] !== null && member[key] !== '') out[key] = member[key];
  }
  return out as TeamMember;
}

export function exportMembers(members: readonly TeamMember[], teamProfile: string, date = new Date()): string {
  const text = header('无忧Teams 配置导出', [`团队 profile: ${teamProfile}`, `导出时间: ${date.toISOString()}`]);
  return text + stringify(
    { kind: 'wuyou-members', version: EXPORT_FORMAT_VERSION, profile: teamProfile, members: members.map((m) => memberFields(m)) },
    { lineWidth: 0 },
  );
}

export function parseMembersFile(yamlText: string): TeamMember[] {
  const data = parseRoot(yamlText);
  if (!Array.isArray(data.members)) throw new Error('文件中没有 members 列表，不是无忧Teams 导出文件');
  return data.members.map((raw) => memberFields(isObject(raw) ? raw : {}));
}

export function previewMembersImport(
  members: readonly TeamMember[],
  existing: readonly TeamMember[],
  catalogProviders: readonly string[],
): PreviewItem<TeamMember>[] {
  const names = new Set(existing.map((m) => m.name));
  const seen = new Set<string>();
  const providers = new Set(catalogProviders);
  return members.map((item) => {
    if (typeof item.name !== 'string' || item.name === '') return { item, skip: '缺少 name' };
    if (names.has(item.name)) return { item, skip: `成员 '${item.name}' 已存在` };
    if (seen.has(item.name)) return { item, skip: '文件中重复' };
    if (item.provider && !providers.has(String(item.provider))) return { item, skip: `provider '${item.provider}' 不在模型目录中` };
    seen.add(item.name);
    return { item };
  });
}
