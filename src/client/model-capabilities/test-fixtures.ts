/**
 * W1a 测试专用 fixture。只允许被 *.test.ts import，不允许被产品代码 import。
 *
 * 这里的 namespace 形状贴近真实结构：
 * - value 是解析后的值（含 schema 默认），user 只放真实覆盖过的键。
 * - pi 的提供方级容量默认值只出现在 value 上，用来验证「value 有默认值但 user 没有时不显式」。
 * - DeepSeek 的 user 为空，列表数据只能来自 value。
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
        models: [
          { ...ccModel('claude-fable-5-1', 'Fable 5.1', 1000000, 128000, { ...FOUR_LEVEL_MAP }), inputModalities: ['text', 'image'] },
          ccModel('claude-opus-5-5', 'Opus 5.5', 1000000, 128000, { ...FOUR_LEVEL_MAP }),
          ccModel('claude-haiku-4-6', 'Haiku 4.6', 20000, 20000, false),
        ],
      },
    },
  };
}

/** llm-pi-ai 的 user 层：只放真实覆盖的字段，不放 schema 默认（defaultContextWindow/defaultMaxTokens/defaultInput） */
export function piUser(): Record<string, unknown> {
  return {
    providers: {
      'gpt-gateway': {
        api: 'openai-responses',
        baseURL: 'https://magic-api.up.railway.app/v1',
        apiKeyEnv: 'GPT_GATEWAY_API_KEY',
        models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-terra', 'gpt-6-luna'].map(gptModel),
      },
      'cc-gateway': {
        api: 'anthropic-messages',
        baseURL: 'https://example.invalid',
        apiKeyEnv: 'CC_GATEWAY_API_KEY',
        reasoning: 'high',
        defaultInput: ['text'],
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
    models: [
      { id: 'deepseek-flash', name: 'V41-Flash', inputModalities: ['text', 'image'] },
      { id: 'deepseek-v4-pro', inputModalities: ['text'] },
    ],
  };
}

export function dsUser(): Record<string, unknown> {
  return {};
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
  /** 额外塞进 describe().namespaces 的命名空间（如 agent-default-model），默认没有 */
  extraNamespaces?: NamespaceSlice[];
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
    if (failure) return { ok: false, error: failure };
    const cur = ns === NS_PI ? state.pi : ns === NS_DS ? state.ds : null;
    if (!cur) return { ok: false, error: { code: 'gateway/bad-request', details: `unknown ns ${ns}` } };
    const next: NamespaceSlice = {
      ...cur,
      value: applyOps(cur.value, ops),
      user: applyOps(cur.user ?? {}, ops),
      revision: cur.revision + 1,
    };
    if (ns === NS_PI) state.pi = next;
    else state.ds = next;
    if (options.emitBeforeResolve) emitNow('settings/document-updated', ns, next.revision);
    return { ok: true, value: next };
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

export { DS_ROUTE_ID, NS_DS, NS_PI };
