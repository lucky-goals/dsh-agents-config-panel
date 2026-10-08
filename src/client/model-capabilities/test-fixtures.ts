/**
 * W1a 测试专用 fixture。只允许被 *.test.ts import，不允许被产品代码 import。
 *
 * 这里的 namespace 形状贴近真实结构：
 * - value 是解析后的值（含 schema 默认），user 只放真实覆盖过的键。
 * - R2：6 个提供方级默认键（pi 的 defaultInput/reasoning/defaultContextWindow/
 *   defaultMaxTokens，DS 的 defaultContextWindow/maxTokens）都真实存在于用户配置上，
 *   用来验证它们「只进 known、不进草稿字段、不进 extra、不产生 op」（见 r2.md 第 2 节）。
 * - DeepSeek 的 user 只放这 2 个默认键，列表数据仍以 value 为准。
 * - R4b：`streamIdleTimeoutMs` 在两个 pi 路由的 value 层是 schema 默认 300000，
 *   user 层是显式值 1800000；DS 只在 value 层有 300000，user 层故意不带这个键，
 *   用来验证「不读 value 层、只认 user 层的显式值」（docs/specs/r4b-stream-idle-timeout.md §9）。
 */
import { vi, type Mock } from 'vitest';
import type {
  CredResult,
  DescribeResult,
  ModelCapabilitiesPort,
  ModelDraft,
  NamespaceSlice,
  ProviderDraft,
  RemoteError,
  RemoteResult,
  SettingsOp,
} from './types';
import { DS_ROUTE_ID, NS_DS, NS_PI } from './types';

/** 原型 mockInitial 里的五档同名映射 */
export const MAIN_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

export const FOUR_LEVEL_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
};

/* ---------------- 草稿对象（纯函数测试用） ---------------- */

export function draftModel(over: Partial<ModelDraft> & { id: string }): ModelDraft {
  return { extra: {}, ...over };
}

export function draftProvider(over: Partial<ProviderDraft> & { id: string }): ProviderDraft {
  return {
    ns: NS_PI,
    models: [],
    extra: {},
    credConfigured: true,
    credWritable: true,
    ...over,
  };
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/* ---------------- 真实结构的 namespace slice ---------------- */

function gptModel(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    contextWindow: 272000,
    maxTokens: 128000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: { ...MAIN_MAP },
  };
}

function ccModel(
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  efforts: Record<string, string> | false,
): Record<string, unknown> {
  return { id, name, contextWindow, maxTokens, reasoningEfforts: efforts };
}

/** llm-pi-ai 的 value 层：含 schema 默认值 defaultContextWindow/defaultMaxTokens/defaultInput */
export function piValue(): Record<string, unknown> {
  return {
    providers: {
      'gpt-gateway': {
        api: 'openai-responses',
        baseURL: 'https://magic-api.up.railway.app/v1',
        apiKeyEnv: 'GPT_GATEWAY_API_KEY',
        defaultContextWindow: 262144,
        defaultMaxTokens: 32768,
        defaultInput: ['text'],
        // R4b：schema 默认值（DSH 的 .default(300000)）。它出现在 value 层，
        // 显式值只能从 user 层判断（契约 r4b 1.2）。
        streamIdleTimeoutMs: 300000,
        models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-terra', 'gpt-6-luna'].map(gptModel),
      },
      'cc-gateway': {
        api: 'anthropic-messages',
        baseURL: 'https://example.invalid',
        apiKeyEnv: 'CC_GATEWAY_API_KEY',
        reasoning: 'high',
        defaultInput: ['text'],
        defaultContextWindow: 262144,
        defaultMaxTokens: 32768,
        streamIdleTimeoutMs: 300000,
        models: [
          { ...ccModel('claude-fable-5-1', 'Fable 5.1', 1000000, 128000, { ...FOUR_LEVEL_MAP }), inputModalities: ['text', 'image'] },
          ccModel('claude-opus-5-5', 'Opus 5.5', 1000000, 128000, { ...FOUR_LEVEL_MAP }),
          ccModel('claude-haiku-4-6', 'Haiku 4.6', 20000, 20000, false),
        ],
      },
    },
  };
}

/** llm-pi-ai 的 user 层：真实覆盖过的键。R2 起 6 个默认键都真实存在于用户配置上。 */
export function piUser(): Record<string, unknown> {
  return {
    providers: {
      'gpt-gateway': {
        api: 'openai-responses',
        baseURL: 'https://magic-api.up.railway.app/v1',
        apiKeyEnv: 'GPT_GATEWAY_API_KEY',
        defaultInput: ['text'],
        defaultContextWindow: 262144,
        defaultMaxTokens: 32768,
        // R4b：用户手写的显式值（30 分钟）；dsUser() 故意不带这个键。
        streamIdleTimeoutMs: 1800000,
        models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-terra', 'gpt-6-luna'].map(gptModel),
      },
      'cc-gateway': {
        api: 'anthropic-messages',
        baseURL: 'https://example.invalid',
        apiKeyEnv: 'CC_GATEWAY_API_KEY',
        reasoning: 'high',
        defaultInput: ['text'],
        streamIdleTimeoutMs: 1800000,
        models: [
          { ...ccModel('claude-fable-5-1', 'Fable 5.1', 1000000, 128000, { ...FOUR_LEVEL_MAP }), inputModalities: ['text', 'image'] },
          ccModel('claude-opus-5-5', 'Opus 5.5', 1000000, 128000, { ...FOUR_LEVEL_MAP }),
          ccModel('claude-haiku-4-6', 'Haiku 4.6', 20000, 20000, false),
        ],
      },
    },
  };
}

/** llm-deepseek：配置平铺，没有 providers */
export function dsValue(): Record<string, unknown> {
  return {
    thinking: 'enabled',
    reasoningEffort: 'high',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultContextWindow: 1000000,
    maxTokens: 256000,
    streamIdleTimeoutMs: 300000,
    models: [
      { id: 'deepseek-flash', name: 'V41-Flash', inputModalities: ['text', 'image'] },
      { id: 'deepseek-v4-pro', inputModalities: ['text'] },
    ],
  };
}

/** llm-deepseek 的 user 层：只放 2 个默认键 */
export function dsUser(): Record<string, unknown> {
  return {
    defaultContextWindow: 1000000,
    maxTokens: 256000,
  };
}

export function piSlice(revision = 7): NamespaceSlice {
  return { ns: NS_PI, value: piValue(), user: piUser(), revision, writable: true, mode: 'host' };
}

export function dsSlice(revision = 11): NamespaceSlice {
  return { ns: NS_DS, value: dsValue(), user: dsUser(), revision, writable: true, mode: 'host' };
}

export function defaultCreds(): Record<string, { configured: boolean; writable: boolean }> {
  return {
    GPT_GATEWAY_API_KEY: { configured: true, writable: true },
    CC_GATEWAY_API_KEY: { configured: false, writable: true },
    DEEPSEEK_API_KEY: { configured: true, writable: true },
  };
}

/** 在 pi slice 上加一个 value/user 都有的新提供方，用于 document-updated 事件 */
export function sliceWithExtraProvider(slice: NamespaceSlice, revision: number): NamespaceSlice {
  const value = deepClone(slice.value);
  const user = deepClone(slice.user ?? {});
  const provider = {
    api: 'openai-responses',
    baseURL: 'https://extra.invalid',
    apiKeyEnv: 'EXTRA_API_KEY',
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    defaultInput: ['text'],
    models: [{ id: 'gpt-6-extra', name: 'Extra', contextWindow: 272000, maxTokens: 128000, reasoningEfforts: { ...MAIN_MAP } }],
  };
  const valueProviders = (value.providers ?? {}) as Record<string, unknown>;
  valueProviders['extra-gateway'] = deepClone(provider);
  value.providers = valueProviders;
  const userProviders = (user.providers ?? {}) as Record<string, unknown>;
  userProviders['extra-gateway'] = deepClone(provider);
  user.providers = userProviders;
  return { ...slice, value, user, revision };
}

/* ---------------- 局部改写 helper（R2-11 ~ R2-13 的 keepView 用例） ---------------- */

/** 覆盖某个现有的顶层字段（如 providers / thinking / models），返回新的 slice。 */
export function sliceWithField(slice: NamespaceSlice, key: string, value: unknown, revision = slice.revision): NamespaceSlice {
  const value_ = deepClone(slice.value);
  value_[key] = deepClone(value);
  return { ...slice, value: value_, revision };
}

/** 覆盖 pi slice 里某个提供方的原始对象（value 与 user 两层同改）。 */
export function sliceWithProvider(
  slice: NamespaceSlice,
  id: string,
  raw: Record<string, unknown>,
  revision = slice.revision,
): NamespaceSlice {
  const value = deepClone(slice.value);
  const user = deepClone(slice.user ?? {});
  const valueProviders = (value.providers ?? {}) as Record<string, unknown>;
  const userProviders = (user.providers ?? {}) as Record<string, unknown>;
  valueProviders[id] = deepClone(raw);
  userProviders[id] = deepClone(raw);
  value.providers = valueProviders;
  user.providers = userProviders;
  return { ...slice, value, user, revision };
}

/** 把 pi slice 里某个提供方的 models 整表换掉（value 与 user 两层同改）。 */
export function sliceWithModels(
  slice: NamespaceSlice,
  id: string,
  models: Array<Record<string, unknown>>,
  revision = slice.revision,
): NamespaceSlice {
  const value = deepClone(slice.value);
  const user = deepClone(slice.user ?? {});
  const valueProviders = (value.providers ?? {}) as Record<string, Record<string, unknown>>;
  const userProviders = (user.providers ?? {}) as Record<string, Record<string, unknown>>;
  if (valueProviders[id]) valueProviders[id].models = deepClone(models);
  if (userProviders[id]) userProviders[id].models = deepClone(models);
  value.providers = valueProviders;
  user.providers = userProviders;
  return { ...slice, value, user, revision };
}

/* ---------------- fake port ---------------- */

function setAtPath(root: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = cur[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = deepClone(value);
}

function unsetAtPath(root: Record<string, unknown>, path: string[]): void {
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]];
    if (next === null || typeof next !== 'object') return;
    cur = next as Record<string, unknown>;
  }
  delete cur[path[path.length - 1]];
}

/** 把 settings op 作用到一层上：set 写值，unset 删键。DSH 的 mutate 会同时写进 value 与 user 覆盖层。 */
function applyOps(layer: Record<string, unknown>, ops: SettingsOp[]): Record<string, unknown> {
  const out = deepClone(layer);
  for (const op of ops) {
    if (op.op === 'set') setAtPath(out, op.path, op.value);
    else unsetAtPath(out, op.path);
  }
  return out;
}

export interface FakePortOptions {
  pi?: NamespaceSlice | null;
  ds?: NamespaceSlice | null;
  creds?: Record<string, { configured: boolean; writable: boolean }>;
  hostLoopback?: boolean;
  describeStatus?: DescribeResult['status'];
  describeWritable?: boolean;
  /** 返回非空即让这次 mutate 失败（模拟 settings/conflict 等），默认成功并作用到 slice 上 */
  fail?: (ns: string, ops: SettingsOp[], rev: number) => RemoteError | null;
  credSet?: (ref: string, value: string) => CredResult;
  credUnset?: (ref: string) => CredResult;
  /**
   * 真实宿主的 settings.write 会在 mutate 的 RPC 返回之前先发出 settings/document-updated
   * （dsh-settings 的 write() 在返回前调用 describe()，后者同步 emit）。打开这个开关，
   * fake port 就在 resolve 之前同步发出同一个事件，用来复现「回声先到」的时序。
   */
  emitBeforeResolve?: boolean;
  /**
   * R2-16 / R2-17 用：mutate 落地之前同步发出的多个 `settings/document-updated` 事件。
   * 每项是 `[ns, revision]`，按数组顺序发出。真实宿主在 mutate 的 RPC 返回前可能连续
   * emit 多次（写入回声 + 写入期间的外部改动），store 要在 inFlight 期间把它们逐个收进
   * pendingEcho。给 `emitBeforeResolve` 发了事件后仍然会发这里的（两者可同时使用）。
   */
  emitDuringMutate?: Array<[string, number]>;
  /** 额外塞进 describe().namespaces 的命名空间（如 agent-default-model），默认没有 */
  extraNamespaces?: NamespaceSlice[];
  /** 覆盖某个 ns 的 returned slice（如把 DS 的 revision 换成别的值），默认用自增后的 slice */
  mutateResult?: (ns: string, next: NamespaceSlice) => NamespaceSlice;
}

export interface FakePort {
  port: ModelCapabilitiesPort;
  describe: Mock<() => Promise<DescribeResult>>;
  mutate: Mock<(ns: string, ops: SettingsOp[], rev: number) => Promise<RemoteResult>>;
  credDescribe: Mock<(refs: string[]) => Promise<Record<string, { configured: boolean; writable: boolean }>>>;
  credSet: Mock<(ref: string, value: string) => Promise<CredResult>>;
  credUnset: Mock<(ref: string) => Promise<CredResult>>;
  on: Mock<(event: string, cb: (...args: any[]) => void) => () => void>;
  disposers: Array<Mock>;
  emit(event: string, ...args: unknown[]): void;
  setSlice(ns: string, slice: NamespaceSlice | null): void;
  setCred(ref: string, status: { configured: boolean; writable: boolean }): void;
  getSlice(ns: string): NamespaceSlice | null;
}

export function createFakePort(options: FakePortOptions = {}): FakePort {
  const state: { pi: NamespaceSlice | null; ds: NamespaceSlice | null } = {
    pi: options.pi ?? null,
    ds: options.ds ?? null,
  };
  const creds: Record<string, { configured: boolean; writable: boolean }> = { ...(options.creds ?? {}) };
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const disposers: Array<Mock> = [];

  const describeFn = vi.fn(async (): Promise<DescribeResult> => {
    const namespaces: NamespaceSlice[] = [];
    if (state.pi) namespaces.push(state.pi);
    if (state.ds) namespaces.push(state.ds);
    for (const extra of options.extraNamespaces ?? []) namespaces.push(extra);
    return {
      status: options.describeStatus ?? 'ready',
      writable: options.describeWritable ?? true,
      namespaces,
    };
  });

  const emitNow = (event: string, ...args: unknown[]): void => {
    for (const cb of listeners.get(event) ?? []) cb(...args);
  };

  const mutateFn = vi.fn(async (ns: string, ops: SettingsOp[], rev: number): Promise<RemoteResult> => {
    const failure = options.fail ? options.fail(ns, ops, rev) : null;
    if (failure) {
      for (const [eventNs, eventRev] of options.emitDuringMutate ?? []) emitNow('settings/document-updated', eventNs, eventRev);
      return { ok: false, error: failure };
    }
    const cur = ns === NS_PI ? state.pi : ns === NS_DS ? state.ds : null;
    if (!cur) return { ok: false, error: { code: 'gateway/bad-request', details: `unknown ns ${ns}` } };
    const stored: NamespaceSlice = {
      ...cur,
      value: applyOps(cur.value, ops),
      user: applyOps(cur.user ?? {}, ops),
      revision: cur.revision + 1,
    };
    if (ns === NS_PI) state.pi = stored;
    else state.ds = stored;
    if (options.emitBeforeResolve) emitNow('settings/document-updated', ns, stored.revision);
    for (const [eventNs, eventRev] of options.emitDuringMutate ?? []) emitNow('settings/document-updated', eventNs, eventRev);
    return { ok: true, value: options.mutateResult ? options.mutateResult(ns, stored) : stored };
  });

  const credDescribeFn = vi.fn(async (refs: string[]) => {
    const out: Record<string, { configured: boolean; writable: boolean }> = {};
    for (const ref of refs) out[ref] = creds[ref] ?? { configured: false, writable: true };
    return out;
  });

  const credSetFn = vi.fn(async (ref: string, value: string): Promise<CredResult> => {
    if (options.credSet) return options.credSet(ref, value);
    creds[ref] = { configured: true, writable: creds[ref]?.writable ?? true };
    return { ok: true };
  });

  const credUnsetFn = vi.fn(async (ref: string): Promise<CredResult> => {
    if (options.credUnset) return options.credUnset(ref);
    delete creds[ref];
    return { ok: true };
  });

  const onFn = vi.fn((event: string, cb: (...args: any[]) => void) => {
    const list = listeners.get(event) ?? [];
    list.push(cb);
    listeners.set(event, list);
    const disposer = vi.fn(() => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    });
    disposers.push(disposer);
    return disposer;
  });

  const port = {
    describe: describeFn,
    hostLoopback: options.hostLoopback ?? true,
    mutate: mutateFn,
    credentials: { describe: credDescribeFn, set: credSetFn, unset: credUnsetFn },
    on: onFn,
  } as unknown as ModelCapabilitiesPort;

  return {
    port,
    describe: describeFn,
    mutate: mutateFn,
    credDescribe: credDescribeFn,
    credSet: credSetFn,
    credUnset: credUnsetFn,
    on: onFn,
    disposers,
    emit(event: string, ...args: unknown[]) {
      emitNow(event, ...args);
    },
    setSlice(ns: string, slice: NamespaceSlice | null) {
      if (ns === NS_PI) state.pi = slice;
      else if (ns === NS_DS) state.ds = slice;
    },
    setCred(ref: string, status: { configured: boolean; writable: boolean }) {
      creds[ref] = status;
    },
    getSlice(ns: string) {
      return ns === NS_PI ? state.pi : ns === NS_DS ? state.ds : null;
    },
  };
}

/* ---------------- R4a 模型测试：可手动 resolve/reject 的 fake tester ---------------- */

/**
 * R4a 测试结果的本地形状（契约 r4a §1.1 的 200 体）。
 *
 * api-types 的 `ModelTestResult` 现在是 r4a coder 的活，测试先自带一份结构类型，
 * 免得 store / model-test 用例依赖还未实现的模块。
 */
export interface FakeTestResult {
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number | null;
  firstTokenMs: number | null;
  sample: string;
  finish: string | null;
  errorKind: string | null;
  status: number | null;
  message: string;
  transient: boolean;
  params: { effort: string | null; maxTokens: number; timeoutMs: number };
  testedAt: string;
}

export interface FakeTestCall {
  req: { provider: string; model: string };
  signal: AbortSignal;
  settled: boolean;
  /** resolve 时用契约默认值补齐（成功、812 ms、首 token 341 ms、sample 'OK'、effort off）。 */
  resolve(over?: Partial<FakeTestResult>): void;
  reject(error: unknown): void;
}

export interface FakeTester {
  fn(req: { provider: string; model: string }, signal: AbortSignal): Promise<FakeTestResult>;
  calls: FakeTestCall[];
  call(i?: number): FakeTestCall;
  count(): number;
}

/** 契约默认的成功结果；provider/model 默认 gpt-gateway / gpt-6-luna。 */
export function fakeTestResult(over: Partial<FakeTestResult> = {}): FakeTestResult {
  return {
    provider: 'gpt-gateway',
    model: 'gpt-6-luna',
    ok: true,
    latencyMs: 812,
    firstTokenMs: 341,
    sample: 'OK',
    finish: 'stop',
    errorKind: null,
    status: null,
    message: '',
    transient: false,
    params: { effort: 'off', maxTokens: 32, timeoutMs: 20000 },
    testedAt: '2026-10-08T02:40:00.000Z',
    ...over,
  };
}

/**
 * R4a store 用例的 fake tester（契约 §2.2 的 ModelTester）：每次调用返回一个可以手动
 * resolve/reject 的 deferred，并把 req 与 signal 记进 `calls`（信号是否被 abort 就看它）。
 */
export function createFakeTester(): FakeTester {
  const calls: FakeTestCall[] = [];
  const fn = (req: { provider: string; model: string }, signal: AbortSignal): Promise<FakeTestResult> => {
    let resolvePromise!: (result: FakeTestResult) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<FakeTestResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const call: FakeTestCall = {
      req,
      signal,
      settled: false,
      resolve(over = {}) {
        call.settled = true;
        resolvePromise(fakeTestResult({ provider: req.provider, model: req.model, ...over }));
      },
      reject(error) {
        call.settled = true;
        rejectPromise(error);
      },
    };
    calls.push(call);
    return promise;
  };
  return {
    fn,
    calls,
    call(i = calls.length - 1) {
      return calls[i];
    },
    count: () => calls.length,
  };
}

/* ---------------- R4a 返工轮（F2）：异常的注入 tester 变体（只追加） ---------------- */

/**
 * 记录调用、但返回值完全由 handler 决定的 tester 骨架。
 * 同步抛错与返回非 thenable 都不能手动 resolve/reject，所以 calls 里的两个回调只用来报错。
 */
function scriptedTester(
  handler: (req: { provider: string; model: string }, signal: AbortSignal) => unknown,
): FakeTester {
  const calls: FakeTestCall[] = [];
  const fn = ((req: { provider: string; model: string }, signal: AbortSignal) => {
    calls.push({
      req,
      signal,
      settled: false,
      resolve() { throw new Error('scripted tester 不支持手动 resolve'); },
      reject() { throw new Error('scripted tester 不支持手动 reject'); },
    });
    return handler(req, signal);
  }) as unknown as FakeTester['fn'];
  return {
    fn,
    calls,
    call(i = calls.length - 1) {
      return calls[i];
    },
    count: () => calls.length,
  };
}

/** S17 用：每次调用都同步抛错（模拟注入的 tester 直接 throw，例如参数校验失败）。 */
export function createThrowingTester(error: unknown = new Error('boom')): FakeTester {
  return scriptedTester(() => {
    throw error;
  });
}

/** S18 用：每次调用返回非 thenable（默认 undefined），模拟注入的 tester 违反 Promise 契约。 */
export function createNonThenableTester(value: unknown = undefined): FakeTester {
  return scriptedTester(() => value);
}

export { DS_ROUTE_ID, NS_DS, NS_PI };
export type { NamespaceSlice };
