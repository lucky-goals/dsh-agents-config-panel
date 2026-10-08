/**
 * Cordis adapter for the 模型能力 section (spec A/D). `sub` is the child fiber
 * ctx handed over by `ctx.inject(MODEL_CAP_DEPS, cb)`; every service is used
 * through a structural shape only (no host package imports, spec 硬约束).
 */
import { createElement } from 'react';
import { NS_DS, NS_PI } from './types';
import type { CredResult, DescribeResult, ModelCapabilitiesPort, ModelTester, NamespaceSlice, RemoteResult, SettingsOp } from './types';
import { createModelCapabilitiesStore } from './store';
import { ModelCapabilitiesPanel } from './ModelCapabilitiesPanel';

export const MODEL_CAP_SECTION = {
  name: 'settings.section',
  id: 'wuyou-model-capabilities',
  order: 99,
  label: '模型能力',
} as const;

export const MODEL_CAP_DEPS = ['slots', 'configForms', 'remote', 'remote.settings', 'remote.credentials'] as const;

/** The namespaces this section reads; anything else in the describe view is ignored. */
const NAMESPACES: readonly string[] = [NS_PI, NS_DS, 'agent-default-model'];
const CRED_BATCH = 64;
const noop = () => {};

type Mode = NamespaceSlice['mode'];
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

function modeOf(sub: any, ns: string): Mode {
  try {
    return sub.configForms.get(ns).getSnapshot().mode === 'memory' ? 'memory' : 'host';
  } catch {
    return 'host';
  }
}

/** A remote namespace view as a NamespaceSlice; writable/mode are supplied by the caller. */
function toSlice(view: Rec, writable: boolean, mode: Mode): NamespaceSlice {
  return {
    ns: String(view.ns),
    value: isRec(view.value) ? view.value : {},
    user: isRec(view.user) ? view.user : undefined,
    revision: typeof view.revision === 'number' ? view.revision : 0,
    writable,
    mode,
  };
}

/**
 * A dotted Remote service: `sub['remote.<name>']` (spec A), falling back to
 * `sub.remote.<name>`, which is how the host's own settings pages reach it.
 */
function service(sub: any, name: 'settings' | 'credentials', method: string): any {
  const dotted = sub[`remote.${name}`];
  if (dotted && typeof dotted[method] === 'function') return dotted;
  const nested = sub.remote?.[name];
  if (nested && typeof nested[method] === 'function') return nested;
  return dotted ?? nested;
}

function toDisposer(ret: unknown): () => void {
  if (typeof ret === 'function') return ret as () => void;
  if (isRec(ret) && typeof ret.dispose === 'function') return () => (ret.dispose as () => void)();
  return noop;
}

export function createPort(sub: any): ModelCapabilitiesPort {
  /** writable/mode of each ns at its latest describe, reused for mutate answers. */
  const last = new Map<string, { writable: boolean; mode: Mode }>();

  const describe = async (): Promise<DescribeResult> => {
    const face = sub.configForms.describe();
    await face.ensure();
    const snap = typeof face.getSnapshot === 'function' ? face.getSnapshot() : undefined;
    const status: DescribeResult['status'] = snap?.status ?? 'unavailable';
    const view = isRec(snap?.view) ? snap.view : undefined;
    const writable = view?.writable === true;
    const list: unknown[] = Array.isArray(view?.namespaces) ? (view!.namespaces as unknown[]) : [];
    const namespaces = list
      .filter((v): v is Rec => isRec(v) && NAMESPACES.includes(String(v.ns)))
      .map((v) => {
        const mode = modeOf(sub, String(v.ns));
        const slice = toSlice(v, writable && mode !== 'memory', mode);
        last.set(slice.ns, { writable: slice.writable, mode });
        return slice;
      });
    return { status, writable, namespaces, error: snap?.error ?? undefined };
  };

  const mutate = async (ns: string, ops: SettingsOp[], expectedRevision: number): Promise<RemoteResult> => {
    const res = await service(sub, 'settings', 'mutate').mutate(ns, ops, expectedRevision);
    if (!res || res.ok !== true) return { ok: false, error: res?.error ?? { code: 'unknown' } };
    const meta = last.get(ns) ?? { writable: true, mode: modeOf(sub, ns) };
    const view = isRec(res.value) ? res.value : isRec(res.view) ? res.view : {};
    return { ok: true, value: toSlice({ ns, ...view }, meta.writable, meta.mode) };
  };

  const credDescribe = async (refs: string[]) => {
    const out: Record<string, { configured: boolean; writable: boolean }> = {};
    const unique = [...new Set(refs)];
    for (let i = 0; i < unique.length; i += CRED_BATCH) {
      const chunk = unique.slice(i, i + CRED_BATCH);
      // Answer: { ok: true, value: { [ref]: { configured, writable } } } (same read as the host's own pages).
      const res = await service(sub, 'credentials', 'describe').describe(chunk);
      if (!res?.ok || !isRec(res.value)) continue;
      for (const ref of chunk) {
        const row = res.value[ref];
        if (isRec(row)) out[ref] = { configured: row.configured === true, writable: row.writable !== false };
      }
    }
    // A ref the host did not answer for is treated as not configured, writable.
    for (const ref of unique) out[ref] ??= { configured: false, writable: true };
    return out;
  };

  const on = ((event: string, cb: (...args: any[]) => void): (() => void) => {
    try {
      if (event === 'connection/reset') {
        return typeof sub.on === 'function' ? toDisposer(sub.on('connection/reset', cb)) : noop;
      }
      const remote = sub.remote;
      return remote && typeof remote.$on === 'function' ? toDisposer(remote.$on(event, cb)) : noop;
    } catch {
      return noop;
    }
  }) as ModelCapabilitiesPort['on'];

  return {
    describe,
    hostLoopback: sub.remote?.$host?.isLoopback !== false,
    mutate,
    credentials: {
      describe: credDescribe,
      set: (ref: string, value: string): Promise<CredResult> => service(sub, 'credentials', 'set').set(ref, value),
      unset: (ref: string): Promise<CredResult> => service(sub, 'credentials', 'unset').unset(ref),
    },
    on,
  };
}

/** `deps.testModel`（R4a）：模型测试调用；缺省时 store 不提供测试功能。 */
export function registerModelCapabilities(sub: any, deps: { testModel?: ModelTester } = {}): void {
  const port = createPort(sub);
  const store = createModelCapabilitiesStore(port, { tester: deps.testModel });
  sub.slots.inject('settings.section', () =>
    sub.slots.register(MODEL_CAP_SECTION, (props: { close?: () => void }) =>
      createElement(ModelCapabilitiesPanel, { ...props, store }),
    ),
  );
}
