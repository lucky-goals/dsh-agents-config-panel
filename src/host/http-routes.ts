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
import { listTeamProfiles, listMembers, addMember, updateMember, removeMember } from './members-editor.js';

/** Maximum accepted request body, in bytes. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface AtomicWriteDiagnostics {
  loaded: boolean;
  anchor?: string;
  resolvedPath?: string;
  tried?: string[];
}

export interface StateDiagnostics {
  atomicWrite: AtomicWriteDiagnostics;
  catalogSource: CatalogSource;
  catalogErrors?: string[];
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
  logger?: { error(msg: string): void };
}

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
) {
  let subagents: unknown[] = [];
  let teamProfiles: string[] = [];
  let members: unknown[] = [];
  const errors: { subagents?: string; members?: string } = {};

  try {
    subagents = listSubagents(yamlText);
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

  const diagnostics: StateDiagnostics = {
    atomicWrite,
    catalogSource: catalogInfo.source,
    ...(catalogInfo.errors.length > 0 ? { catalogErrors: catalogInfo.errors } : {}),
  };

  return {
    revision: computeRevision(yamlText),
    catalog: catalogInfo.catalog,
    subagents,
    teamProfiles,
    profile,
    members,
    errors,
    diagnostics,
  };
}

const REVISION_PATTERN = /^[0-9a-f]{64}$/;

const WRITE_ACTIONS = {
  subagents: ['create', 'update', 'remove'],
  members: ['add', 'update', 'remove'],
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
    result.target = requireNonEmptyString(body, kind === 'subagents' ? 'id' : 'name');
  }

  const payloadField = action === 'create' ? 'input' : action === 'add' ? 'member' : action === 'update' ? 'patch' : undefined;
  if (payloadField !== undefined) {
    const payload = body[payloadField];
    if (!isPlainObject(payload)) throw invalidField(payloadField, '必须是 JSON 对象');
    if (action === 'update' && Object.keys(payload).length === 0) throw invalidField(payloadField, '至少需要一个字段');
    if (kind === 'subagents' && payload.agentOptions !== undefined && !isPlainObject(payload.agentOptions)) {
      throw invalidField(`${payloadField}.agentOptions`, '必须是 JSON 对象');
    }
    result.payload = payload;
  }
  return result;
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

  /** Profile for the state returned by a request: query string, else the default. */
  const queryProfile = (req: IncomingMessage): string =>
    new URL(req.url ?? '/', 'http://x').searchParams.get('profile') ?? profileDefault;

  /**
   * Run one locked mutation. The catalog is awaited inside the lock against
   * the exact text being transformed, so validation never sees a Promise or a
   * stale llm-pi-ai fallback.
   */
  const mutate = async (
    expectedRevision: string,
    apply: (yamlText: string, catalog: ModelCatalog) => { ok: true; yamlText: string } | { ok: false; code: string; message: string },
  ): Promise<{ catalog: CatalogResult; yamlText: string }> => {
    let used: CatalogResult | undefined;
    let written: string | undefined;
    await io.writePatchLocked(expectedRevision, async (yamlText) => {
      used = await loadCatalog(yamlText);
      const result = apply(yamlText, used.catalog);
      if (!result.ok) throw mutationError(result.code, result.message);
      written = result.yamlText;
      return result.yamlText;
    });
    // State describes exactly what this request committed (no second read that
    // could fail or race after the write already succeeded).
    return { catalog: used!, yamlText: written! };
  };

  const sendMutationState = (res: ServerResponse, profile: string, outcome: { catalog: CatalogResult; yamlText: string }) => {
    sendJson(res, 200, {
      ...buildState(outcome.yamlText, profile, outcome.catalog, atomicWriteDiagnostics()),
      notice: '已保存，新建会话后生效',
    });
  };

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
          sendJson(res, 200, buildState(yamlText, profile, catalog, atomicWriteDiagnostics()));
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

          const outcome = await mutate(write.expectedRevision, (yamlText, current) => {
            if (write.action === 'create') return createSubagent(yamlText, write.payload as any, current);
            if (write.action === 'update') return updateSubagent(yamlText, write.target!, write.payload as any, current);
            return removeSubagent(yamlText, write.target!);
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
  ];
}
