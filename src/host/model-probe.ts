/**
 * Model availability test (R4a): send one short, real completion through the
 * DSH `llm` runtime and report whether the saved provider/model answers.
 *
 * - One request per call: prompt「只回复 OK」, `maxTokens 32`, `temperature 0`,
 *   the lowest reasoning effort (prefer `off`), no `sessionId` (no session,
 *   no approval, no auto-retry, no session usage).
 * - Fixed total deadline (default 20s), independent of the provider's stream
 *   idle timeout. The iteration races an abort promise so an adapter that
 *   ignores `signal` still returns on time.
 * - Never throws; every failure maps to `errorKind` (contract
 *   docs/specs/r4a-model-test.md §1.2–§1.3). The plugin never sees API keys;
 *   adapter messages are masked before they leave the Host.
 */
import type { LLMService, LlmFailure, LlmFinishReason, LlmStreamChunk, LlmStreamOptions } from './runtime-deps.js';

export const MODEL_PROBE_TIMEOUT_MS = 20_000;
export const MODEL_PROBE_MAX_TOKENS = 32;
export const MODEL_PROBE_PROMPT = '只回复 OK';
export const SAMPLE_MAX = 80;
export const MESSAGE_MAX = 300;
/** Text kept from `text-delta` chunks before sampling; later text is dropped. */
const TEXT_BUFFER_MAX = 4096;

/** Failures that usually pass on retry (decided here; the Client does not recompute). */
export const TRANSIENT_KINDS: ReadonlySet<string> = new Set([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  'NO_ADAPTER',
]);

export type ProbeFinish = 'stop' | 'max-tokens' | 'tool-calls' | 'error' | 'aborted' | 'timeout' | 'none' | null;

export interface ModelProbeResult {
  ok: boolean;
  latencyMs: number;
  firstTokenMs: number | null;
  sample: string;
  finish: ProbeFinish;
  errorKind: string | null;
  status: number | null;
  message: string;
  transient: boolean;
  params: { effort: string | null; maxTokens: number; timeoutMs: number };
  testedAt: string;
}

export interface ModelProbeDeps {
  llm: LLMService;
  /** Caller cancellation (the HTTP request closed). */
  signal?: AbortSignal;
  now?: () => number;
  timeoutMs?: number;
  maxTokens?: number;
  clock?: () => Date;
}

const NO_ADAPTER_MESSAGE = '提供方尚未生效或未注册';
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const OK_KINDS = new Set(['stop', 'max-tokens', 'tool-calls']);
// eslint-disable-next-line no-control-regex
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * ② key-value keywords. The left edge is `(?<![A-Za-z0-9])` instead of `\b`, so `_`-prefixed
 * names (`access_token`, `client_secret`, `x_api_key`) match while `monkey=` / `tokens=` do not.
 */
const MASK_KEYS = 'access[-_]?token|refresh[-_]?token|client[-_]?secret|api[-_]?key|apikey|key|token|secret|password|authorization';
const MASK_KV = new RegExp(
  // `(?!(?:Bearer|Basic|Token)\s+\*\*\*)`: values ① already masked (`Authorization: Basic ***`) are left alone.
  // `(?:(?:bearer|basic|token)\s+)?`: a scheme ① skipped (lower-case `basic`) is masked together with its value.
  `(?<![A-Za-z0-9])(${MASK_KEYS})(["']?\\s*[=:]\\s*["']?)(?!(?:Bearer|Basic|Token)\\s+\\*\\*\\*)`
    + `(?:(?:bearer|basic|token)\\s+)?[^\\s"'&,;]+`,
  'gi',
);
/** ① scheme + credential. `Bearer` in any case (normalised to `Bearer`); `Basic` / `Token` only capitalised. */
const MASK_SCHEME = /\b([Bb][Ee][Aa][Rr][Ee][Rr]|Basic|Token)\s+(?!\*\*\*)[^\s"',;]+/g;
/** ③ well-known long-token shapes: JWT, Google API key, GitHub token, AWS access key id. */
const MASK_LONG_TOKENS = [
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/** Mask credentials in an adapter/error message (contract §1.2 step 8, in order). */
export function maskMessage(text: string): string {
  let out = String(text);
  // ① auth scheme values; the scheme word is kept. `Basic` / `Token` only match capitalised so prose
  // like "invalid token provided" is not touched.
  out = out.replace(MASK_SCHEME, (_m, scheme: string) => `${/^bearer$/i.test(scheme) ? 'Bearer' : scheme} ***`);
  // ② key = value / "key": "value" — mask up to the next separator, keep quotes.
  out = out.replace(MASK_KV, '$1$2***');
  // ③ provider key prefixes, then well-known long-token shapes.
  out = out.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{6,}/g, '$1-***');
  for (const pattern of MASK_LONG_TOKENS) out = out.replace(pattern, '***');
  out = out.replace(CONTROL_RUN, ' ').replace(/ {2,}/g, ' ').trim();
  const points = Array.from(out);
  return points.length > MESSAGE_MAX ? `${points.slice(0, MESSAGE_MAX).join('')}…` : out;
}

/** Lowest reasoning effort: `off` when offered, else the first id (DSH lists low → high). */
export function pickEffort(efforts: Array<{ id: string }> | undefined): string | null {
  if (!Array.isArray(efforts) || efforts.length === 0) return null;
  if (efforts.some((effort) => effort?.id === 'off')) return 'off';
  const first = efforts[0]?.id;
  return typeof first === 'string' && first.length > 0 ? first : null;
}

function normCode(code: unknown): string {
  return typeof code === 'string' && CODE_PATTERN.test(code) ? code : 'UNKNOWN';
}

function cleanSample(text: string): string {
  const folded = text.replace(CONTROL_RUN, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(folded).slice(0, SAMPLE_MAX).join('');
}

function errorMessageOf(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  const message = (caught as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(caught);
}

function errorCodeOf(caught: unknown): unknown {
  return (caught as { code?: unknown } | null)?.code;
}

function errorStatusOf(caught: unknown): unknown {
  return (caught as { status?: unknown } | null)?.status;
}

function statusOf(rawStatus: unknown, errorKind: string | null): number | null {
  if (typeof rawStatus === 'number' && Number.isInteger(rawStatus)) return rawStatus;
  const match = errorKind ? /^HTTP_(\d+)$/.exec(errorKind) : null;
  return match ? Number(match[1]) : null;
}

type Outcome = {
  finish: ProbeFinish;
  errorKind: string | null;
  rawStatus?: unknown;
  message: string;
};

/** Thrown when the internal deadline or the caller's signal wins a race. */
const INTERRUPTED = Symbol('interrupted');

export async function probeModel(
  target: { provider: string; model: string },
  deps: ModelProbeDeps,
): Promise<ModelProbeResult> {
  const now = deps.now ?? Date.now;
  const clock = deps.clock ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS;
  const maxTokens = deps.maxTokens ?? MODEL_PROBE_MAX_TOKENS;
  const { provider, model } = target;
  const { llm, signal: external } = deps;

  const t0 = now();
  const ctl = new AbortController();
  let timedOut = false;
  let effort: string | null = null;
  let firstTokenMs: number | null = null;
  let text = '';

  // Resolves once our signal aborts (deadline or caller), for racing awaits.
  let markInterrupted!: () => void;
  const interrupted = new Promise<typeof INTERRUPTED>((resolve) => {
    markInterrupted = () => resolve(INTERRUPTED);
  });
  const onAbort = () => markInterrupted();
  ctl.signal.addEventListener('abort', onAbort, { once: true });

  const onExternalAbort = () => ctl.abort('client');
  if (external?.aborted) ctl.abort('client');
  else external?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort('timeout');
  }, timeoutMs);

  const race = async <T>(promise: Promise<T>): Promise<T> => {
    const value = await Promise.race([promise, interrupted]);
    if (value === INTERRUPTED) throw INTERRUPTED;
    return value as T;
  };

  /** Deadline / caller abort take precedence over whatever else happened. */
  const interruptedOutcome = (): Outcome | null => {
    if (timedOut) {
      return { finish: 'timeout', errorKind: 'TIMEOUT', message: `超过 ${timeoutMs / 1000}s 未完成` };
    }
    if (external?.aborted) return { finish: 'aborted', errorKind: 'CLIENT_ABORTED', message: '请求已取消' };
    return null;
  };

  const thrownOutcome = (caught: unknown, finish: ProbeFinish): Outcome =>
    interruptedOutcome() ?? {
      finish,
      errorKind: normCode(errorCodeOf(caught)),
      rawStatus: errorStatusOf(caught),
      message: errorMessageOf(caught),
    };

  const run = async (): Promise<Outcome> => {
    // 2. Preflight: the provider must be registered in the live runtime.
    let listed = false;
    try {
      listed = llm.listProviders().some((entry) => entry?.id === provider);
    } catch {
      listed = false;
    }
    if (!listed) return { finish: null, errorKind: 'NO_ADAPTER', message: NO_ADAPTER_MESSAGE };

    // 3–4. Resolve the model and its lowest effort; no request on failure.
    let info: Awaited<ReturnType<LLMService['resolveModelInfo']>>;
    try {
      info = await race(Promise.resolve().then(() => llm.resolveModelInfo(provider, model, ctl.signal)));
    } catch (caught) {
      return thrownOutcome(caught, null);
    }
    effort = pickEffort(info?.reasoning?.efforts);

    // 5. One short request; never sessionId/system/purpose/stop.
    const options: LlmStreamOptions = {
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: MODEL_PROBE_PROMPT }] }],
      temperature: 0,
      maxTokens,
      signal: ctl.signal,
      ...(effort ? { reasoningEffort: effort } : {}),
    };

    // 6. Iterate, racing every step against the abort promise.
    let iterator: AsyncIterator<LlmStreamChunk> | undefined;
    let reason: LlmFinishReason | undefined;
    try {
      if (typeof llm.stream !== 'function') {
        throw Object.assign(new Error('当前 DSH 未提供 LLM 服务'), { code: 'NO_ADAPTER' });
      }
      iterator = llm.stream(options)[Symbol.asyncIterator]();
      for (;;) {
        const step = await race(Promise.resolve(iterator.next()));
        if (step.done) break;
        const chunk = step.value as LlmStreamChunk & { text?: unknown; reason?: LlmFinishReason };
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          if (firstTokenMs === null) firstTokenMs = Math.round(now() - t0);
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && text.length < TEXT_BUFFER_MAX) {
            text += chunk.text;
          }
        } else if (chunk.type === 'finish') {
          reason = chunk.reason;
          break;
        }
      }
    } catch (caught) {
      return thrownOutcome(caught, 'error');
    } finally {
      // Release the adapter without waiting on it (it may ignore return()).
      const it = iterator;
      if (it && typeof it.return === 'function') {
        void Promise.resolve()
          .then(() => it.return!())
          .catch(() => {});
      }
    }

    // 7. Map the outcome.
    const interruptedResult = interruptedOutcome();
    if (interruptedResult) return interruptedResult;
    if (!reason) return { finish: 'none', errorKind: 'EMPTY_RESPONSE', message: '模型没有返回内容' };
    if (OK_KINDS.has(reason.kind)) return { finish: reason.kind as ProbeFinish, errorKind: null, message: '' };
    const failure: LlmFailure | undefined = (reason as { failure?: LlmFailure }).failure;
    const kind = reason.kind === 'aborted' ? 'aborted' : 'error';
    const errorKind = kind === 'aborted' && (failure?.code === undefined || failure.code === '')
      ? 'ABORTED'
      : normCode(failure?.code);
    return { finish: kind, errorKind, rawStatus: failure?.status, message: failure?.message ?? '' };
  };

  let outcome: Outcome;
  try {
    outcome = await run();
  } catch (caught) {
    // Defensive: run() maps its own failures; keep the never-throws promise.
    outcome = thrownOutcome(caught, 'error');
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
    ctl.signal.removeEventListener('abort', onAbort);
  }

  const ok = outcome.errorKind === null;
  let testedAt: string;
  try {
    testedAt = clock().toISOString();
  } catch {
    testedAt = new Date().toISOString();
  }
  return {
    ok,
    latencyMs: Math.max(0, Math.round(now() - t0)),
    firstTokenMs,
    sample: ok ? cleanSample(text) : '',
    finish: outcome.finish,
    errorKind: outcome.errorKind,
    status: ok ? null : statusOf(outcome.rawStatus, outcome.errorKind),
    message: ok ? '' : maskMessage(outcome.message),
    transient: outcome.errorKind !== null && TRANSIENT_KINDS.has(outcome.errorKind),
    params: { effort, maxTokens, timeoutMs },
    testedAt,
  };
}
