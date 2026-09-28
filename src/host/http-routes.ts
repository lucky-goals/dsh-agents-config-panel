/**
 * HTTP route handlers for wuyou-agent API.
 * Handlers take Node req/res and return void; errors are caught and serialized
 * as `{ code, message }` only (never a stack).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PatchIO } from './patch-file.js';
import type { ModelCatalog } from './catalog.js';
import type { CatalogResult, CatalogSource } from './runtime-deps.js';
import { computeRevision } from './patch-io.js';
import { listSubagents, createSubagent, updateSubagent, removeSubagent } from './subagent-manager.js';
import { subagentProviderDirectory, type SubagentProviderDirectory } from './subagent-providers.js';
import { listTeamProfiles, listMembers, addMember, updateMember, removeMember } from './members-editor.js';
import { listAcps, createAcp, updateAcp, removeAcp, importSubagentBundle, ACP_EDITABLE_FIELDS } from './acp-manager.js';
import { probeAcp } from './acp-probe.js';

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
  /** ACP test runner (v2.4); tests inject a fake or a short timeout. */
  probeAcp?: typeof probeAcp;
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
  subagents: ['create', 'update', 'remove'],
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

  if (action === 'update' || action === 'remove') {
    result.target = requireNonEmptyString(body, kind === 'members' ? 'name' : 'id');
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
      ...buildState(outcome.yamlText, profile, outcome.catalog, atomicWriteDiagnostics(), outcome.providers, context.dshProfile),
      notice: SAVED_NOTICE,
      ...extra,
    });
  };

  /** ACP ids with a test in flight; one handshake per ACP at a time. */
  const probing = new Set<string>();

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
          const yamlText = await io.readPatch();
          const catalog = await loadCatalog(yamlText);
          sendJson(res, 200, buildState(yamlText, profile, catalog, atomicWriteDiagnostics(), loadProviders(yamlText), context.dshProfile));
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
            const providers = directory.providers;
            if (write.action === 'create') return createSubagent(yamlText, write.payload as any, current, providers);
            if (write.action === 'update') return updateSubagent(yamlText, write.target!, write.payload as any, current, providers);
            return removeSubagent(yamlText, write.target!, providers);
          });

          sendMutationState(res, profile, outcome);
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
  ];
}
