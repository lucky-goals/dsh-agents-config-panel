/**
 * HTTP route handlers for wuyou-agent API.
 * Handlers take Node req/res and return void; errors are caught and serialized
 * as `{ code, message }` only (never a stack).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PatchIO } from './patch-file.js';
import type { ModelCatalog } from './catalog.js';
import type { CatalogResult, CatalogSource, LLMService } from './runtime-deps.js';
import { computeRevision } from './patch-io.js';
import { listSubagents, createSubagent, updateSubagent, removeSubagent, moveSubagent } from './subagent-manager.js';
import { subagentProviderDirectory, type SubagentProviderDirectory } from './subagent-providers.js';
import { listTeamProfiles, listMembers, addMember, updateMember, removeMember } from './members-editor.js';
import { listAcps, createAcp, updateAcp, removeAcp, importSubagentBundle, ACP_EDITABLE_FIELDS } from './acp-manager.js';
import { probeAcp } from './acp-probe.js';
import { probeModel, maskMessage } from './model-probe.js';
import { createTeamProfile, importTeamProfiles, listTeamProfileConfigs, removeTeamProfile } from './teams-editor.js';
import {
  AGENT_TEAMS_NOT_IN_PATCH,
  AGENT_TEAMS_PACKAGE,
  BASIC_TEAM_SEEDED_NOTICE,
  loadInstalledAgentTeams,
  seedBasicTeamProfile,
  type InstalledAgentTeams,
} from './agent-teams-bootstrap.js';

/** Maximum accepted request body, in bytes. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface AtomicWriteDiagnostics {
  loaded: boolean;
  anchor?: string;
  resolvedPath?: string;
  tried?: string[];
}

/** Host API revision announced in state.diagnostics (contract v2.1 §1, §9). */
export const HOST_API = 2;

export interface StateDiagnostics {
  hostApi: typeof HOST_API;
  atomicWrite: AtomicWriteDiagnostics;
  catalogSource: CatalogSource;
  catalogErrors?: string[];
  subagentProvidersSource: SubagentProviderDirectory['source'];
  subagentProviderErrors?: string[];
}

export interface RouteContext {
  io: PatchIO;
  profileDefault: string;
  /**
   * Model catalog for the given patch text. Production passes an async
   * function (the runtime LLM registry must be awaited); a plain catalog is
   * treated as source 'patch', a {@link CatalogResult} carries its own source.
   */
  getCatalog: (yamlText: string) => ModelCatalog | CatalogResult | Promise<ModelCatalog | CatalogResult>;
  /** Current atomic-write load state, reported in state diagnostics. */
  getAtomicWriteDiagnostics?: () => AtomicWriteDiagnostics;
  /**
   * The live DSH `subagents` service (late-bound, read per request, never
   * cached). Absent or undefined means the provider list falls back to the patch.
   */
  getSubagentsService?: () => unknown;
  /**
   * The DSH profile this plugin instance is bound to (web, desktop, cli, ...)
   * and the patch it edits. Reported in state so the panel and export files
   * name the source profile; each DSH profile runs its own plugin instance.
   */
  dshProfile?: { name: string; patchPath: string };
  /**
   * Profile directory used to detect an installed `@nanmicoder/dsh-agent-teams`.
   * When set, state reports `agentTeams` and the panel can seed a basic profile.
   */
  profileDir?: string;
  /** Test override for {@link loadInstalledAgentTeams}. */
  readInstalledAgentTeams?: () => InstalledAgentTeams | undefined;
  /** ACP test runner (v2.4); tests inject a fake or a short timeout. */
  probeAcp?: typeof probeAcp;
  /**
   * The live DSH `llm` runtime (R4a), read per request and never cached.
   * Absent, undefined, or without `stream` means the model test answers 503.
   */
  getLlm?: () => LLMService | undefined;
  /** Model test runner (R4a); tests inject a fake. */
  probeModel?: typeof probeModel;
  /**
   * Seed `preset-standard-acp` when the user patch has no delegation group.
   * Returns the patch text to serve, plus a notice after this process writes it.
   */
  ensurePreset?: () => Promise<{ yamlText: string; notice: string | null }>;
  logger?: { error(msg: string): void };
}

/** Notice after ACP writes: providers are registered when DSH loads plugins. */
export const ACP_SAVED_NOTICE = '已保存。ACP 变更需重启 DSH 后生效';
const SAVED_NOTICE = '已保存，新建会话后生效';

export interface RouteDescriptor {
  kind: 'exact';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

class RouteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const HTTP_STATUS_MAP: Record<string, number> = {
  INVALID: 400,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  STALE_REVISION: 409,
  PAYLOAD_TOO_LARGE: 413,
  READ_ONLY: 422,
  LAST_MEMBER: 422,
  IN_USE: 409,
  LAST_TEAM: 422,
  BUSY: 409,
  STRUCTURE: 500,
  INTERNAL: 500,
  DEPENDENCY_UNAVAILABLE: 503,
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/** Pure-function missing-team-profile message; a write against it is a 404. */
const MISSING_TEAM_PROFILE_PREFIX = '未找到团队 profile';

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(value));
}

function errorResponse(res: ServerResponse, caught: unknown, logger?: { error(msg: string): void }): void {
  const rawCode = (caught as { code?: unknown } | null)?.code;
  const known = typeof rawCode === 'string' && rawCode in HTTP_STATUS_MAP;
  const code = known ? rawCode : 'INTERNAL';
  // Unknown failures (fs errors, bugs) never leak their details or stack.
  const message = known && caught instanceof Error ? caught.message : '服务端内部错误';

  if (code === 'DEPENDENCY_UNAVAILABLE') {
    logger?.error(`wuyou-agent: ${message}`);
  } else if (!known) {
    logger?.error(`wuyou-agent: unexpected route failure: ${caught instanceof Error ? caught.message : String(caught)}`);
  }

  sendJson(res, HTTP_STATUS_MAP[code], { code, message });
}

/** Read a JSON object body, bounded to {@link MAX_BODY_BYTES}. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume?.();
    throw new RouteError('PAYLOAD_TOO_LARGE', '请求体超过 1MB 上限');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_BODY_BYTES) {
      chunks.length = 0;
      throw new RouteError('PAYLOAD_TOO_LARGE', '请求体超过 1MB 上限');
    }
    chunks.push(part);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RouteError('INVALID', '请求体不是合法 JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RouteError('INVALID', '请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * The single state builder used by GET /state and every successful mutation.
 * Each list is guarded on its own, so a structure gap (no delegation, no
 * agent-teams, unknown profile) lands in `errors` and the response stays 200
 * with the new revision even after a write.
 */
export function buildState(
  yamlText: string,
  profile: string,
  catalogInfo: CatalogResult,
  atomicWrite: AtomicWriteDiagnostics,
  providerDirectory: SubagentProviderDirectory = subagentProviderDirectory(yamlText, undefined),
  dshProfile?: RouteContext['dshProfile'],
) {
  let subagents: unknown[] = [];
  let teamProfiles: string[] = [];
  let members: unknown[] = [];
  let acps: unknown[] = [];
  const errors: { subagents?: string; members?: string; acps?: string } = {};

  try {
    subagents = listSubagents(yamlText, providerDirectory.providers);
  } catch (err) {
    errors.subagents = errorMessage(err);
  }

  try {
    teamProfiles = listTeamProfiles(yamlText);
  } catch (err) {
    errors.members = errorMessage(err);
  }

  if (errors.members === undefined) {
    try {
      members = listMembers(yamlText, profile);
    } catch (err) {
      errors.members = errorMessage(err);
    }
  }

  try {
    acps = listAcps(yamlText);
  } catch (err) {
    errors.acps = errorMessage(err);
  }

  const diagnostics: StateDiagnostics = {
    hostApi: HOST_API,
    atomicWrite,
    catalogSource: catalogInfo.source,
    ...(catalogInfo.errors.length > 0 ? { catalogErrors: catalogInfo.errors } : {}),
    subagentProvidersSource: providerDirectory.source,
    ...(providerDirectory.errors.length > 0 ? { subagentProviderErrors: providerDirectory.errors } : {}),
  };

  return {
    revision: computeRevision(yamlText),
    catalog: catalogInfo.catalog,
    subagents,
    subagentProviders: providerDirectory.providers,
    teamProfiles,
    profile,
    members,
    acps,
    ...(dshProfile ? { dshProfile } : {}),
    errors,
    diagnostics,
  };
}

const REVISION_PATTERN = /^[0-9a-f]{64}$/;

const WRITE_ACTIONS = {
  subagents: ['create', 'update', 'remove', 'move'],
  members: ['add', 'update', 'remove'],
  acps: ['create', 'update', 'remove'],
} as const;

type WriteKind = keyof typeof WRITE_ACTIONS;

export interface ValidatedWrite {
  expectedRevision: string;
  action: string;
  /** subagents: id; members: name (update/remove only). */
  target?: string;
  /** members only. */
  profile?: string;
  /** move direction. */
  direction?: 'up' | 'down';
  /** create input, add member, or update patch. */
  payload?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalidField(name: string, reason: string): RouteError {
  return new RouteError('INVALID', `字段 ${name} ${reason}`);
}

function requireNonEmptyString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.length === 0) throw invalidField(name, '必须是非空字符串');
  return value;
}

/** Subagent config keys this interface never writes (contract v2.1 §6, §10). */
const IMMUTABLE_SUBAGENT_FIELDS = ['maxDepth', 'modelSelectionSettings', 'persona', 'toolFilter'] as const;
const SUBAGENT_FIELDS = ['toolName', 'provider', 'backgroundMode', 'agentOptions'] as const;
const AGENT_OPTION_FIELDS = ['provider', 'model', 'reasoningEffort'] as const;
const BACKGROUND_MODES = ['continuable', 'one-shot'];

/**
 * Type-only checks for a subagent input/patch; whether `provider` is
 * registered is decided inside the lock (v2.1 drops the spawn|fork enum).
 */
function validateSubagentPayload(field: string, payload: Record<string, unknown>): void {
  for (const key of IMMUTABLE_SUBAGENT_FIELDS) {
    if (key in payload) throw invalidField(key, '不能通过此接口修改');
  }
  for (const key of Object.keys(payload)) {
    if (!(SUBAGENT_FIELDS as readonly string[]).includes(key)) throw invalidField(`${field}.${key}`, '不支持');
  }
  for (const key of ['toolName', 'provider'] as const) {
    const value = payload[key];
    if (value === null) throw invalidField(key, '不能清空');
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw invalidField(key, '必须是非空字符串');
    }
  }
  const mode = payload.backgroundMode;
  if (mode === null) throw invalidField('backgroundMode', '不能清空');
  if (mode !== undefined && (typeof mode !== 'string' || !BACKGROUND_MODES.includes(mode))) {
    throw invalidField('backgroundMode', `必须是 ${BACKGROUND_MODES.join('、')} 之一`);
  }
  const options = payload.agentOptions;
  if (options !== undefined) {
    if (!isPlainObject(options)) throw invalidField(`${field}.agentOptions`, '必须是 JSON 对象');
    for (const key of Object.keys(options)) {
      if (!(AGENT_OPTION_FIELDS as readonly string[]).includes(key)) {
        throw invalidField(`${field}.agentOptions.${key}`, '不支持');
      }
    }
  }
}

/**
 * Validate a write body before any file read or lock. Throws a 400 INVALID
 * RouteError naming the first offending field (F22-INPUT).
 */
export function validateWriteBody(kind: WriteKind, body: Record<string, unknown>): ValidatedWrite {
  const revision = body.expectedRevision;
  if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
    throw invalidField('expectedRevision', '必须是 64 位小写十六进制 revision');
  }

  const allowed: readonly string[] = WRITE_ACTIONS[kind];
  const action = body.action;
  if (typeof action !== 'string' || !allowed.includes(action)) {
    throw invalidField('action', `必须是 ${allowed.join('、')} 之一`);
  }

  const result: ValidatedWrite = { expectedRevision: revision, action };
  if (kind === 'members') result.profile = requireNonEmptyString(body, 'profile');

  if (action === 'update' || action === 'remove' || action === 'move') {
    result.target = requireNonEmptyString(body, kind === 'members' ? 'name' : 'id');
  }

  if (action === 'move') {
    const direction = body.direction;
    if (direction !== 'up' && direction !== 'down') {
      throw invalidField('direction', '必须是 up、down 之一');
    }
    result.direction = direction;
    if ('input' in body) throw invalidField('input', '不支持');
    if ('patch' in body) throw invalidField('patch', '不支持');
  }

  const payloadField = action === 'create' ? 'input' : action === 'add' ? 'member' : action === 'update' ? 'patch' : undefined;
  if (payloadField !== undefined) {
    const payload = body[payloadField];
    if (!isPlainObject(payload)) throw invalidField(payloadField, '必须是 JSON 对象');
    if (action === 'update' && Object.keys(payload).length === 0) throw invalidField(payloadField, '至少需要一个字段');
    if (kind === 'subagents') validateSubagentPayload(payloadField, payload);
    if (kind === 'acps') validateAcpPayload(payloadField, payload, action === 'update');
    result.payload = payload;
  }
  return result;
}

const ACP_INPUT_FIELDS = ['providerName', ...ACP_EDITABLE_FIELDS] as const;

/** Type-only checks for an ACP input/patch; value rules live in acp-manager. */
function validateAcpPayload(payloadField: string, payload: Record<string, unknown>, isPatch: boolean): void {
  const allowed: readonly string[] = isPatch ? ACP_EDITABLE_FIELDS : ACP_INPUT_FIELDS;
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) throw invalidField(`${payloadField}.${key}`, isPatch && key === 'providerName' ? '不能修改' : '不受支持');
  }
  const check = (key: string, ok: (v: unknown) => boolean, reason: string) => {
    if (payload[key] !== undefined && !ok(payload[key])) throw invalidField(`${payloadField}.${key}`, reason);
  };
  const isString = (v: unknown) => typeof v === 'string';
  check('providerName', isString, '必须是字符串');
  check('command', isString, '必须是字符串');
  check('permission', isString, '必须是字符串');
  check('cwd', (v) => isString(v) || (isPatch && v === null), '必须是字符串');
  check('args', (v) => Array.isArray(v) && v.every(isString), '必须是字符串数组');
  check('env', (v) => isPlainObject(v) && Object.values(v).every(isString), '必须是字符串键值对象');
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidField(name, '必须是字符串');
  return value;
}

/** Word the user types to confirm deleting a team (v2.7); the Host checks it too. */
export const TEAM_DELETE_CONFIRMATION = 'thinktwice';

/**
 * POST /teams:
 * - `{ expectedRevision, action: 'create', name, from? | firstMember, description? }`
 * - `{ expectedRevision, action: 'remove', name, confirm: 'thinktwice' }`
 */
function validateTeamCreateBody(body: Record<string, unknown>) {
  const revision = body.expectedRevision;
  if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) throw invalidField('expectedRevision', '必须是 64 位小写十六进制 revision');
  if (body.action === 'remove') {
    const name = requireNonEmptyString(body, 'name');
    if (body.confirm !== TEAM_DELETE_CONFIRMATION) throw invalidField('confirm', `必须是 '${TEAM_DELETE_CONFIRMATION}'，删除团队需要二次确认`);
    return { kind: 'remove' as const, expectedRevision: revision, name };
  }
  if (body.action !== 'create') throw invalidField('action', '必须是 create 或 remove');
  const name = requireNonEmptyString(body, 'name');
  const from = optionalString(body, 'from');
  const firstMember = optionalString(body, 'firstMember');
  const description = optionalString(body, 'description');
  if (from !== undefined && firstMember !== undefined) throw invalidField('firstMember', '克隆时不能同时指定');
  return { kind: 'create' as const, expectedRevision: revision, input: { name, from, firstMember, description } };
}

/** POST /teams/import: `{ expectedRevision, teams: [{ name, profile, scope? }], overwrite: string[] }`. */
function validateTeamImportBody(body: Record<string, unknown>) {
  const revision = body.expectedRevision;
  if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) throw invalidField('expectedRevision', '必须是 64 位小写十六进制 revision');
  const teams = body.teams;
  if (!Array.isArray(teams)) throw invalidField('teams', '必须是数组');
  if (teams.length > MAX_BUNDLE_ITEMS) throw invalidField('teams', `最多 ${MAX_BUNDLE_ITEMS} 项`);
  teams.forEach((team, index) => {
    if (!isPlainObject(team)) throw invalidField(`teams[${index}]`, '必须是 JSON 对象');
    if (typeof team.name !== 'string') throw invalidField(`teams[${index}].name`, '必须是字符串');
    if (!isPlainObject(team.profile)) throw invalidField(`teams[${index}].profile`, '必须是 JSON 对象');
    if (team.scope !== undefined && team.scope !== 'full' && team.scope !== 'members') throw invalidField(`teams[${index}].scope`, "只能是 'full' 或 'members'");
  });
  const overwrite = body.overwrite ?? [];
  if (!Array.isArray(overwrite) || !overwrite.every((n) => typeof n === 'string')) throw invalidField('overwrite', '必须是字符串数组');
  return { expectedRevision: revision, teams: teams as any[], overwrite: overwrite as string[] };
}

/** Upper bound per list in an import bundle; the body is already capped at 1MB. */
const MAX_BUNDLE_ITEMS = 200;

function validateBundleBody(body: Record<string, unknown>): { expectedRevision: string; bundle: { acps: unknown[]; subagents: unknown[] } } {
  const revision = body.expectedRevision;
  if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
    throw invalidField('expectedRevision', '必须是 64 位小写十六进制 revision');
  }
  const bundle = body.bundle;
  if (!isPlainObject(bundle)) throw invalidField('bundle', '必须是 JSON 对象');
  const list = (key: 'acps' | 'subagents'): unknown[] => {
    const value = bundle[key] ?? [];
    if (!Array.isArray(value)) throw invalidField(`bundle.${key}`, '必须是数组');
    if (value.length > MAX_BUNDLE_ITEMS) throw invalidField(`bundle.${key}`, `最多 ${MAX_BUNDLE_ITEMS} 项`);
    return value;
  };
  return { expectedRevision: revision, bundle: { acps: list('acps'), subagents: list('subagents') } };
}

/** Longest provider/model id accepted by POST /models/test. */
const MODEL_TEST_ID_MAX = 256;
const MODEL_TEST_FIELDS = ['provider', 'model'] as const;
/** Host-wide model tests in flight; beyond this the route answers 409 (no queue). */
const MODEL_TEST_MAX_ACTIVE = 3;

/** POST /models/test: `{ provider, model }`, both non-empty and ≤256 chars, nothing else. */
function validateModelTestBody(body: Record<string, unknown>): { provider: string; model: string } {
  const provider = requireNonEmptyString(body, 'provider');
  const model = requireNonEmptyString(body, 'model');
  // 纯空白视为空（同一报错文案）；传给 probe 的值保持原样，不 trim。
  if (provider.trim().length === 0) throw invalidField('provider', '必须是非空字符串');
  if (model.trim().length === 0) throw invalidField('model', '必须是非空字符串');
  for (const key of Object.keys(body)) {
    if (!(MODEL_TEST_FIELDS as readonly string[]).includes(key)) throw invalidField(key, '不支持');
  }
  for (const [name, value] of [['provider', provider], ['model', model]] as const) {
    if (value.length > MODEL_TEST_ID_MAX) throw invalidField(name, `长度不能超过 ${MODEL_TEST_ID_MAX}`);
  }
  return { provider, model };
}

function isCatalogResult(value: ModelCatalog | CatalogResult): value is CatalogResult {
  return 'catalog' in value && 'source' in value;
}

function mutationError(code: string, message: string): RouteError {
  // Writes against a missing team profile are NOT_FOUND; only a missing
  // agent-teams section stays STRUCTURE (see requirements C2 / F5).
  if (code === 'STRUCTURE' && message.startsWith(MISSING_TEAM_PROFILE_PREFIX)) {
    return new RouteError('NOT_FOUND', message);
  }
  return new RouteError(code, message);
}

export function createRoutes(context: RouteContext): RouteDescriptor[] {
  const { io, profileDefault, logger } = context;

  const loadCatalog = async (yamlText: string): Promise<CatalogResult> => {
    const value = await context.getCatalog(yamlText);
    return isCatalogResult(value) ? value : { catalog: value, source: 'patch', errors: [] };
  };

  const atomicWriteDiagnostics = (): AtomicWriteDiagnostics =>
    context.getAtomicWriteDiagnostics?.() ?? { loaded: false };

  /** Provider directory for this text, read from the live service every call (no cache). */
  const loadProviders = (yamlText: string): SubagentProviderDirectory => {
    let service: unknown;
    try {
      service = context.getSubagentsService?.();
    } catch {
      service = undefined;
    }
    return subagentProviderDirectory(yamlText, service);
  };

  /** Profile for the state returned by a request: query string, else the default. */
  const queryProfile = (req: IncomingMessage): string =>
    new URL(req.url ?? '/', 'http://x').searchParams.get('profile') ?? profileDefault;

  const installedAgentTeams = (): InstalledAgentTeams | undefined => {
    if (context.readInstalledAgentTeams) return context.readInstalledAgentTeams();
    if (context.profileDir) return loadInstalledAgentTeams(context.profileDir);
    return undefined;
  };

  const presentState = <T extends { errors: { members?: string } }>(state: T) => {
    const found = installedAgentTeams();
    if (!found) return state;
    const members = state.errors.members === AGENT_TEAMS_NOT_IN_PATCH
      ? (found.config
        ? `已安装 ${AGENT_TEAMS_PACKAGE}${found.version ? `@${found.version}` : ''}，但 cordis.patch.yml 里还没有团队 profile`
        : `已安装 ${AGENT_TEAMS_PACKAGE}，但读不到插件自带的配置，无法初始化团队 profile`)
      : state.errors.members;
    return {
      ...state,
      agentTeams: {
        installed: true,
        seedable: found.config !== undefined,
        ...(found.version ? { version: found.version } : {}),
      },
      errors: members === state.errors.members ? state.errors : { ...state.errors, members },
    };
  };

  /**
   * Run one locked mutation. The catalog is awaited inside the lock against
   * the exact text being transformed, so validation never sees a Promise or a
   * stale llm-pi-ai fallback.
   */
  type MutationOutcome = { catalog: CatalogResult; yamlText: string; providers: SubagentProviderDirectory };

  const mutate = async (
    expectedRevision: string,
    apply: (
      yamlText: string,
      catalog: ModelCatalog,
      providers: SubagentProviderDirectory,
    ) => { ok: true; yamlText: string } | { ok: false; code: string; message: string },
  ): Promise<MutationOutcome> => {
    let used: CatalogResult | undefined;
    let directory: SubagentProviderDirectory | undefined;
    let written: string | undefined;
    await io.writePatchLocked(expectedRevision, async (yamlText) => {
      used = await loadCatalog(yamlText);
      // Provider list read under the lock, against the exact text being replaced.
      directory = loadProviders(yamlText);
      const result = apply(yamlText, used.catalog, directory);
      if (!result.ok) throw mutationError(result.code, result.message);
      written = result.yamlText;
      return result.yamlText;
    });
    // State describes exactly what this request committed (no second read that
    // could fail or race after the write already succeeded). The directory is
    // re-derived for the written text so patch-inferred ACP names stay current.
    return { catalog: used!, yamlText: written!, providers: directory!.source === 'runtime' ? directory! : loadProviders(written!) };
  };

  const sendMutationState = (
    res: ServerResponse,
    profile: string,
    outcome: MutationOutcome,
    extra: Record<string, unknown> = {},
  ) => {
    sendJson(res, 200, {
      ...presentState(buildState(outcome.yamlText, profile, outcome.catalog, atomicWriteDiagnostics(), outcome.providers, context.dshProfile)),
      notice: SAVED_NOTICE,
      ...extra,
    });
  };

  /** ACP ids with a test in flight; one handshake per ACP at a time. */
  const probing = new Set<string>();
  /** `provider\u0000model` keys with a model test in flight (R4a). */
  const modelTesting = new Set<string>();

  const requirePost = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method === 'POST') return true;
    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
    res.end();
    return false;
  };

  return [
    {
      kind: 'exact',
      path: '/plugins/dsh-wuyou-agent/api/state',
      async handler(req, res) {
        try {
          const profile = queryProfile(req);
          const prepared = context.ensurePreset
            ? await context.ensurePreset()
            : { yamlText: await io.readPatch(), notice: null as string | null };
          const catalog = await loadCatalog(prepared.yamlText);
          const state = presentState(buildState(
            prepared.yamlText,
            profile,
            catalog,
            atomicWriteDiagnostics(),
            loadProviders(prepared.yamlText),
            context.dshProfile,
          ));
          sendJson(res, 200, prepared.notice ? { ...state, notice: prepared.notice } : state);
        } catch (err) {
          errorResponse(res, err, logger);
        }
      },
    },

    {
      kind: 'exact',
      path: '/plugins/dsh-wuyou-agent/api/subagents',
      async handler(req, res) {
        try {
          if (!requirePost(req, res)) return;

          const body = await readJsonBody(req);
          const write = validateWriteBody('subagents', body);
          const profile = queryProfile(req);

          const outcome = await mutate(write.expectedRevision, (yamlText, current, directory) => {
            if (write.action === 'move') return moveSubagent(yamlText, write.target!, write.direction!);
            const providers = directory.providers;
            if (write.action === 'create') return createSubagent(yamlText, write.payload as any, current, providers);
            if (write.action === 'update') return updateSubagent(yamlText, write.target!, write.payload as any, current, providers);
            return removeSubagent(yamlText, write.target!, providers);
          });

          sendMutationState(res, profile, outcome, write.action === 'move'
            ? {
              notice: write.direction === 'up'
                ? '已上移。只改变列表顺序，不影响模型看到的工具顺序'
                : '已下移。只改变列表顺序，不影响模型看到的工具顺序',
            }
            : {});
        } catch (err) {
          errorResponse(res, err, logger);
        }
      },
    },

    {
      kind: 'exact',
      path: '/plugins/dsh-wuyou-agent/api/members',
      async handler(req, res) {
        try {
          if (!requirePost(req, res)) return;

          const body = await readJsonBody(req);
          const write = validateWriteBody('members', body);
          const profile = write.profile!;

          const outcome = await mutate(write.expectedRevision, (yamlText, current) => {
            if (write.action === 'add') return addMember(yamlText, profile, write.payload as any, current);
            if (write.action === 'update') return updateMember(yamlText, profile, write.target!, write.payload as any, current);
            return removeMember(yamlText, profile, write.target!);
          });

          sendMutationState(res, profile, outcome);
        } catch (err) {
          errorResponse(res, err, logger);
        }
      },
    },

    {
      kind: 'exact',
      path: '/plugins/dsh-wuyou-agent/api/acps',
      async handler(req, res) {
        try {
          if (!requirePost(req, res)) return;

          const body = await readJsonBody(req);
          const write = validateWriteBody('acps', body);

          const outcome = await mutate(write.expectedRevision, (yamlText) => {
            if (write.action === 'create') return createAcp(yamlText, write.payload as any);
            if (write.action === 'update') return updateAcp(yamlText, write.target!, write.payload as any);
            return removeAcp(yamlText, write.target!);
          });

          sendMutationState(res, queryProfile(req), outcome, { notice: ACP_SAVED_NOTICE });
        } catch (err) {
          errorResponse(res, err, logger);
        }
      },
    },

    {
      kind: 'exact',
      path: '/plugins/dsh-wuyou-agent/api/acps/test',
      async handler(req, res) {
        let id: string | undefined;
        try {
          if (!requirePost(req, res)) return;
          const body = await readJsonBody(req);
          id = requireNonEmptyString(body, 'id');
          if (body.handshake !== undefined && typeof body.handshake !== 'boolean') throw invalidField('handshake', '必须是布尔值');
          // Only a saved row is tested: the request names it, never a command.
          const row = listAcps(await io.readPatch()).find((acp) => acp.id === id);
          if (!row) throw new RouteError('NOT_FOUND', `未找到 ACP '${id}'`);
          if (probing.has(id)) throw new RouteError('BUSY', `ACP '${row.config.providerName}' 正在测试，请稍候`);
          probing.add(id);
          try {
            const result = await (context.probeAcp ?? probeAcp)(row.config, { handshake: body.handshake === true });
            sendJson(res, 200, { id, providerName: row.config.providerName, ...result });
          } finally {
            probing.delete(id);
          }
        } catch (err) {
          errorResponse(res, err, logger);
        }
      },
    },

    {
      kind: 'exact',
      path: '/plugins/dsh-wuyou-agent/api/teams',
      async handler(req, res) {
        try {
          if (req.method === 'GET') {
            // v2.6: every team profile with its full config, for export and import preview.
            const yamlText = await io.readPatch();
            sendJson(res, 200, {
              revision: computeRevision(yamlText),
              profiles: listTeamProfileConfigs(yamlText),
              ...(context.dshProfile ? { dshProfile: context.dshProfile } : {}),
            });
            return;
          }
          if (!requirePost(req, res)) return;
          const write = validateTeamCreateBody(await readJsonBody(req));
          if (write.kind === 'remove') {
            const removed = write.name;
            const outcome = await mutate(write.expectedRevision, (yamlText) => removeTeamProfile(yamlText, removed));
            // Keep the viewed team unless it was the one removed; then fall
            // back like the panel does (standard-acp, else the first team).
            const viewed = queryProfile(req);
            const left = listTeamProfiles(outcome.yamlText);
            const profile = viewed !== removed && left.includes(viewed)
              ? viewed
              : left.includes(profileDefault) ? profileDefault : left[0];
            sendMutationState(res, profile, outcome);
            return;
          }
          const { expectedRevision, input } = write;
          const outcome = await mutate(expectedRevision, (yamlText) => createTeamProfile(yamlText, input));
          // The response state is for the new team, so the panel can switch to it.
          sendMutationState(res, input.name, outcome);
        } catch (err) {
          errorResponse(res, err, logger);
        }
      },
    },

    {
      kind: 'exact',
      path: '/plugins/dsh-wuyou-agent/api/teams/bootstrap',
      async handler(req, res) {
        try {
          if (!requirePost(req, res)) return;
          const body = await readJsonBody(req);
          const revision = body.expectedRevision;
          if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
            throw invalidField('expectedRevision', '必须是 64 位小写十六进制 revision');
          }
          const found = installedAgentTeams();
          if (!found?.config) {
            throw new RouteError(
              'STRUCTURE',
              found
                ? `已安装 ${AGENT_TEAMS_PACKAGE}，但读不到插件自带的配置，无法初始化团队 profile`
                : AGENT_TEAMS_NOT_IN_PATCH,
            );
          }
          const bundleConfig = found.config;
          let changed = false;
          const outcome = await mutate(revision, (yamlText) => {
            const seeded = seedBasicTeamProfile(yamlText, bundleConfig);
            if (seeded.ok && seeded.yamlText !== yamlText) changed = true;
            return seeded;
          });
          sendMutationState(res, queryProfile(req), outcome, {
            notice: changed ? BASIC_TEAM_SEEDED_NOTICE : '团队 profile 已存在，无需初始化',
          });
        } catch (err) {
          errorResponse(res, err, logger);
        }
      },
    },

    {
      kind: 'exact',
      path: '/plugins/dsh-wuyou-agent/api/teams/import',
      async handler(req, res) {
        try {
          if (!requirePost(req, res)) return;
          const { expectedRevision, teams, overwrite } = validateTeamImportBody(await readJsonBody(req));
          let report: unknown;
          const outcome = await mutate(expectedRevision, (yamlText) => {
            const result = importTeamProfiles(yamlText, teams, overwrite);
            if (result.ok) report = result.report;
            return result;
          });
          sendMutationState(res, queryProfile(req), outcome, { importReport: report });
        } catch (err) {
          errorResponse(res, err, logger);
        }
      },
    },

    {
      kind: 'exact',
      path: '/plugins/dsh-wuyou-agent/api/subagents/import',
      async handler(req, res) {
        try {
          if (!requirePost(req, res)) return;

          const body = await readJsonBody(req);
          const { expectedRevision, bundle } = validateBundleBody(body);

          let report: unknown;
          const outcome = await mutate(expectedRevision, (yamlText, catalog, providers) => {
            const result = importSubagentBundle(yamlText, bundle, catalog, providers.providers);
            if (result.ok) report = result.report;
            return result;
          });

          const created = (report as { created: { acps: string[] } }).created;
          sendMutationState(res, queryProfile(req), outcome, {
            notice: created.acps.length > 0 ? ACP_SAVED_NOTICE : SAVED_NOTICE,
            importReport: report,
          });
        } catch (err) {
          errorResponse(res, err, logger);
        }
      },
    },

    {
      kind: 'exact',
      path: '/plugins/dsh-wuyou-agent/api/models/test',
      async handler(req, res) {
        try {
          if (!requirePost(req, res)) return;
          const { provider, model } = validateModelTestBody(await readJsonBody(req));

          let llm: LLMService | undefined;
          try {
            llm = context.getLlm?.();
          } catch {
            llm = undefined;
          }
          if (!llm || typeof llm.stream !== 'function') {
            throw new RouteError('DEPENDENCY_UNAVAILABLE', '当前 DSH 未提供 LLM 服务，无法测试模型');
          }

          const key = `${provider}\u0000${model}`;
          if (modelTesting.has(key)) throw new RouteError('BUSY', `模型 ${model} 正在测试，请稍候`);
          if (modelTesting.size >= MODEL_TEST_MAX_ACTIVE) {
            throw new RouteError('BUSY', `同时最多测试 ${MODEL_TEST_MAX_ACTIVE} 个模型，请稍后重试`);
          }
          // Claimed before the probe starts, released in finally.
          modelTesting.add(key);

          const controller = new AbortController();
          // The client went away before we answered: cancel the request, write nothing.
          const onClose = () => {
            if (!res.writableEnded) controller.abort('client');
          };
          if (typeof res.on === 'function') res.on('close', onClose);
          try {
            const result = await (context.probeModel ?? probeModel)({ provider, model }, { llm, signal: controller.signal });
            if (!controller.signal.aborted) sendJson(res, 200, { provider, model, ...result });
          } catch (err) {
            if (controller.signal.aborted) return;
            // Never leak the probe failure text; log it masked.
            logger?.error(`wuyou-agent: model test failed unexpectedly: ${maskMessage(errorMessage(err))}`);
            sendJson(res, 500, { code: 'INTERNAL', message: '服务端内部错误' });
          } finally {
            modelTesting.delete(key);
            if (typeof res.off === 'function') res.off('close', onClose);
          }
        } catch (err) {
          errorResponse(res, err, logger);
        }
      },
    },
  ];
}
