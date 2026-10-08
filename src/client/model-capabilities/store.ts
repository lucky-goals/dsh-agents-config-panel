import {
  MAX_IMPORT_BYTES,
  downloadYaml,
  readImportFile,
} from '../shared/import-export';
import {
  applyModelImport,
  exportModelConfig,
  modelExportFilename,
  parseModelConfig,
  previewModelImport,
} from './io';
import { MODEL_TEST_UNSUPPORTED } from '../shared/api-client';
import { bulkPlan, newBulk, bulkResultMsg } from './bulk';
import { parseCap } from './capacity';
import { deriveEnv } from './efforts';
import { parseTimeoutMinutes } from './timeout';
import {
  TEST_CONCURRENCY,
  batchStats,
  blockReason,
  doneAnnounce,
  progressText,
  resultAnnounce,
  resultState,
  testDetailText,
  testKey,
} from './model-test';
import { allErrors, providerIdError, secretError, wizardErrors } from './validate';
import {
  computeOps,
  draftFromNamespaces,
  previewText,
  remoteErrorText,
  type SettingsOp,
} from './ops';
import {
  DS_ROUTE_ID,
  NS_DS,
  NS_PI,
  type AllErrors,
  type BulkDraft,
  type CapSideKey,
  type CredOp,
  type DescribeResult,
  type DialogState,
  type DraftState,
  type Effort,
  type HeaderPair,
  type InputModality,
  type McSnapshot,
  type McTestState,
  type McUi,
  type ModelCapabilitiesPort,
  type ModelCapabilitiesStore,
  type ModelDraft,
  type ModelTester,
  type ModelTestResult,
  type NamespaceSlice,
  type ProviderDraft,
  type ReasoningMap,
  type RemoteError,
  type TestBatchLabel,
  type TestEntry,
  type WizardDraft,
  ALL_EFFORTS,
} from './types';

const clone = <T>(value: T): T => structuredClone(value);
const has = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const refsForProvider = (p: ProviderDraft): string => {
  if (p.apiKeyEnv && p.apiKeyEnv.trim()) return p.apiKeyEnv.trim();
  return p.ns === NS_DS ? 'DEEPSEEK_API_KEY' : deriveEnv(p.id);
};
const isPi = (p: ProviderDraft): boolean => p.ns === NS_PI;

function initialUi(): McUi {
  return {
    view: 'list',
    route: null,
    edit: null,
    bulk: null,
    wizard: null,
    dialog: null,
    menuIdx: null,
    sel: {},
    showAdv: {},
    inputHint: null,
    undo: null,
    saving: false,
    saved: false,
    conflict: 'hidden',
    readonly: true,
    loading: true,
    status: '',
    previewReturn: null,
    importPreview: null,
    dsPrev: 'high',
  };
}

function initialSnapshot(): McSnapshot {
  return {
    draft: { providers: {} },
    revision: { pi: null, ds: null },
    ops: { pi: [], ds: [], cred: [], dirty: 0, dirtySet: new Set() },
    errors: {},
    ui: initialUi(),
    loadError: null,
    saveError: null,
    defaultModel: null,
    hasPi: false,
    hasDs: false,
    secretSet: {},
  };
}

function namespaceProviders(draft: DraftState, ns: string): Record<string, ProviderDraft> {
  return Object.fromEntries(Object.entries(draft.providers).filter(([, p]) => p.ns === ns));
}

function defaultWizard(): WizardDraft {
  return {
    step: 1,
    api: '',
    id: '',
    tried2: false,
    ack: false,
    displayName: '',
    baseURL: '',
    env: '',
    envTouched: false,
    headersOpen: false,
    headers: [],
    models: [''],
    timeoutText: '30',
  };
}

/* ---------------- R4a 模型测试（docs/specs/r4a-model-test.md §2.3） ---------------- */
interface TestJob { key: string; route: string; modelId: string; gen: number; seq: number }
type TestOutcome = { ok: true; res: ModelTestResult } | { ok: false; error: unknown };

function initialTestState(): McTestState {
  return { hostUnsupported: false, results: {}, batches: {}, open: null, cost: null, skipCost: false, blocked: {}, live: '' };
}

const isBusy = (entry: TestEntry | undefined): boolean => entry?.state === 'queued' || entry?.state === 'running';

const withoutPrev = (entry: TestEntry): TestEntry => {
  const copy = { ...entry };
  delete copy.prev;
  return copy;
};

function isThenable(value: unknown): boolean {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

function errorField(error: unknown, field: 'code' | 'status' | 'message'): unknown {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[field] : undefined;
}

/**
 * Client 侧失败（tester 抛错）合成的结果：BUSY / HOST_UNAVAILABLE / HOST_UNREACHABLE / HOST_ERROR。
 * HOST_UNREACHABLE 只给「TypeError 且无 status」（fetch 网络失败）；其余无 status 的错误
 * （含 tester 同步抛错、返回非 thenable）都是 HOST_ERROR、非 transient。
 */
function synthTestResult(route: string, modelId: string, error: unknown): ModelTestResult {
  const rawStatus = errorField(error, 'status');
  const status = typeof rawStatus === 'number' ? rawStatus : null;
  const code = errorField(error, 'code');
  const rawMessage = errorField(error, 'message');
  let errorKind = 'HOST_ERROR';
  let transient = false;
  if (status === 409 && code === 'BUSY') { errorKind = 'BUSY'; transient = true; }
  else if (status === 503) { errorKind = 'HOST_UNAVAILABLE'; transient = true; }
  else if (status === null && error instanceof TypeError) { errorKind = 'HOST_UNREACHABLE'; transient = true; }
  return {
    provider: route,
    model: modelId,
    ok: false,
    latencyMs: 0,
    firstTokenMs: null,
    sample: '',
    finish: null,
    errorKind,
    status,
    message: typeof rawMessage === 'string' ? rawMessage : String(error),
    transient,
    params: { effort: null, maxTokens: 32, timeoutMs: 20000 },
    testedAt: new Date().toISOString(),
  };
}

function errorCount(errors: AllErrors): boolean {
  return Object.values(errors).some((entry) => Object.keys(entry.route).length || entry.models.some((m) => Object.keys(m).length));
}

export function createModelCapabilitiesStore(
  port: ModelCapabilitiesPort,
  options: { tester?: ModelTester } = {},
): ModelCapabilitiesStore {
  const tester = options.tester;
  let snapshot = initialSnapshot();
  let draft: DraftState = { providers: {} };
  let base: DraftState = { providers: {} };
  let slices: { pi: NamespaceSlice | null; ds: NamespaceSlice | null } = { pi: null, ds: null };
  let revisions: { pi: number | null; ds: number | null } = { pi: null, ds: null };
  let credentials: Record<string, { configured: boolean; writable: boolean }> = {};
  let secrets: Record<string, string> = {};
  let wizardSecret = '';
  let pendingCred: CredOp[] = [];
  let ownWrites = new Map<string, number>();
  let inFlight = new Set<string>();
  let pendingEcho = new Map<string, number[]>();
  let listeners = new Set<() => void>();
  let disposers: Array<() => void> = [];
  let loaded = false;
  let loadingPromise: Promise<void> | null = null;
  // 每轮 load 的序号；dispose 自增以作废在途轮次（见 load / dispose）。
  let loadSeq = 0;
  // R4a：仅注入 tester 时存在。`gen` 作废迟到回包，`jobSeq` 记每个键最后一次入队的 seq。
  let test: McTestState | undefined = tester ? initialTestState() : undefined;
  let queue: TestJob[] = [];
  let active = 0;
  let gen = 0;
  let seq = 0;
  const jobSeq = new Map<string, number>();
  const controllers = new Map<string, AbortController>();
  let disposed = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const refsToRoutes = (ref: string): string[] => Object.values(draft.providers)
    .filter((p) => refsForProvider(p) === ref)
    .map((p) => p.id);

  const mergedCredOps = (computed: CredOp[]): CredOp[] => {
    const byRef = new Map<string, CredOp>();
    for (const op of pendingCred) byRef.set(op.ref, op);
    for (const op of computed) byRef.set(op.ref, op);
    return [...byRef.values()];
  };

  const publish = (patch?: Partial<McSnapshot>) => {
    // dispose 之后一律不再通知监听器（§2.3）；所有 publish 入口（statusPatch / publishTest / setUi…）都经过这里。
    if (disposed) return;
    const computed = computeOps(base, draft, secrets);
    const cred = mergedCredOps(computed.cred);
    const dirtySet = new Set(computed.dirtySet);
    for (const op of pendingCred) {
      for (const route of refsToRoutes(op.ref)) dirtySet.add(route);
      if (!refsToRoutes(op.ref).length) dirtySet.add(`credential:${op.ref}`);
    }
    const errors = allErrors(draft);
    for (const [route, secret] of Object.entries(secrets)) {
      const err = secretError(secret);
      if (err && draft.providers[route]) {
        errors[route] ??= { route: {}, models: [] };
        errors[route].route.secret = err;
      }
    }
    const secretSet: Record<string, boolean> = {};
    for (const p of Object.values(draft.providers)) secretSet[p.id] = Boolean(secrets[p.id]);
    const next: McSnapshot = {
      ...snapshot,
      draft: clone(draft),
      revision: { ...revisions },
      ops: { pi: computed.pi, ds: computed.ds, cred, dirty: dirtySet.size, dirtySet },
      errors,
      secretSet,
      ...patch,
    };
    if (test) {
      // 门控按「已保存」判断：密钥单独算 secretPending，所以 dirty 只看设置改动。
      const settingsDirty = Object.keys(secrets).length ? computeOps(base, draft, {}).dirtySet : computed.dirtySet;
      const credRoutes = new Set(pendingCred.flatMap((op) => refsToRoutes(op.ref)));
      const blocked: Record<string, string | null> = {};
      for (const route of Object.keys(draft.providers)) {
        blocked[route] = blockReason({
          hostUnsupported: test.hostUnsupported,
          saving: next.ui.saving,
          isNew: !base.providers[route],
          dirty: settingsDirty.has(route),
          secretPending: Boolean(secretSet[route]) || credRoutes.has(route),
        });
      }
      next.test = { ...test, blocked };
    }
    snapshot = next;
    notify();
  };

  const mutateDraft = (fn: (next: DraftState) => void, patch?: Partial<McSnapshot>) => {
    const next = clone(draft);
    fn(next);
    draft = next;
    publish({ ...patch, ui: { ...snapshot.ui, ...(patch?.ui ?? {}), saved: false } });
  };

  const setUi = (fn: (ui: McUi) => void, patch?: Partial<McSnapshot>) => {
    const ui = clone(snapshot.ui);
    fn(ui);
    publish({ ...patch, ui });
  };

  const statusPatch = (status: string, saveError: string | null = snapshot.saveError) => {
    publish({ saveError, ui: { ...snapshot.ui, status } });
  };

  const updateNamespace = (ns: string, nextSlice: NamespaceSlice) => {
    const key = ns === NS_PI ? 'pi' : 'ds';
    slices[key] = clone(nextSlice);
    revisions[key] = nextSlice.revision;
    const remote = draftFromNamespaces({ pi: slices.pi, ds: slices.ds, creds: credentials });
    const remoteProviders = namespaceProviders(remote, ns);
    const nextDraft = clone(draft);
    for (const id of Object.keys(nextDraft.providers)) {
      if (nextDraft.providers[id].ns === ns) delete nextDraft.providers[id];
    }
    Object.assign(nextDraft.providers, clone(remoteProviders));
    draft = nextDraft;
    const nextBase = clone(base);
    for (const id of Object.keys(nextBase.providers)) {
      if (nextBase.providers[id].ns === ns) delete nextBase.providers[id];
    }
    Object.assign(nextBase.providers, clone(remoteProviders));
    base = nextBase;
  };

  const describeCredentials = async (refs: string[]) => {
    const unique = [...new Set(refs.filter(Boolean))];
    const next: Record<string, { configured: boolean; writable: boolean }> = {};
    for (let i = 0; i < unique.length; i += 64) {
      const part = unique.slice(i, i + 64);
      Object.assign(next, await port.credentials.describe(part));
    }
    credentials = { ...credentials, ...next };
  };

  const resetFromDescribe = async (result?: DescribeResult, options: { keepView?: boolean } = {}) => {
    const keepView = options.keepView === true;
    const previousUi = clone(snapshot.ui);
    const previousEdit = previousUi.edit;
    const previousEditModelId = previousEdit?.kind === 'model'
      ? draft.providers[previousEdit.route]?.models[previousEdit.idx]?.id ?? null
      : null;
    const described = result ?? await port.describe();
    const pi = described.namespaces.find((slice) => slice.ns === NS_PI) ?? null;
    const ds = described.namespaces.find((slice) => slice.ns === NS_DS) ?? null;
    slices = { pi: clone(pi), ds: clone(ds) };
    revisions = { pi: pi?.revision ?? null, ds: ds?.revision ?? null };
    const rawDraft = draftFromNamespaces({ pi, ds, creds: credentials });
    const refs = Object.values(rawDraft.providers).map(refsForProvider);
    await describeCredentials(refs);
    draft = draftFromNamespaces({ pi, ds, creds: credentials });
    base = clone(draft);
    pendingCred = [];
    secrets = {};
    if (!keepView) wizardSecret = '';
    ownWrites.clear();
    inFlight.clear();
    pendingEcho.clear();
    const readonly = !port.hostLoopback
      || described.status === 'unavailable'
      || !described.writable
      || [pi, ds].filter(Boolean).some((slice) => !slice!.writable || slice!.mode === 'memory');
    const defaultNs = described.namespaces.find((slice) => slice.ns === 'agent-default-model');
    let defaultModel: McSnapshot['defaultModel'] = null;
    const def = defaultNs?.value;
    if (def && typeof def === 'object') {
      const value = def as Record<string, unknown>;
      if (typeof value.provider === 'string' && typeof value.model === 'string') {
        defaultModel = { provider: value.provider, model: value.model, effort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '' };
      }
    }
    let nextUi: McUi = {
      ...previousUi,
      loading: false,
       importPreview: null,
      readonly,
      saving: false,
      saved: false,
      conflict: 'hidden',
      status: '',
      view: 'list',
      route: null,
      edit: null,
      bulk: null,
      dialog: null,
      menuIdx: null,
    };
    if (keepView) {
      nextUi = { ...previousUi, loading: false,
       importPreview: null, readonly, saving: false, saved: false, conflict: 'hidden', status: '', menuIdx: null };
      const route = nextUi.route ? draft.providers[nextUi.route] : undefined;
      if (nextUi.route && !route) {
        nextUi = { ...nextUi, view: 'list', route: null, edit: null, bulk: null, menuIdx: null };
      } else {
        if (nextUi.route && route) {
          const selected = nextUi.sel[nextUi.route] ?? [];
          const validSelected = selected.filter((idx) => idx >= 0 && idx < route.models.length);
          if (validSelected.length !== selected.length) nextUi.sel = { ...nextUi.sel, [nextUi.route]: validSelected };
        }
        if (nextUi.edit?.kind === 'model') {
          const editProvider = draft.providers[nextUi.edit.route];
          const editModel = editProvider?.models[nextUi.edit.idx];
          if (!editModel || (previousEditModelId !== null && editModel.id !== previousEditModelId)) {
            nextUi = { ...nextUi, edit: null };
            if (!editModel) nextUi.undo = null;
          }
        } else if (nextUi.edit && !draft.providers[nextUi.edit.route]) {
          nextUi = { ...nextUi, edit: null };
        }
        if (nextUi.bulk && !draft.providers[nextUi.bulk.route]) nextUi = { ...nextUi, bulk: null };
      }
    }
    clearTests();
    publish({
      loadError: null,
      saveError: null,
      defaultModel,
      hasPi: !!pi,
      hasDs: !!ds,
      ui: nextUi,
    });
    loaded = true;
  };

  const subscribeEvents = () => {
    if (disposers.length) return;
    disposers = [
      port.on('settings/document-updated', (ns, revision) => {
        if (inFlight.has(ns)) {
          const echoes = pendingEcho.get(ns) ?? [];
          echoes.push(revision);
          pendingEcho.set(ns, echoes);
          return;
        }
        const own = ownWrites.get(ns);
        if (own !== undefined && own === revision) {
          ownWrites.delete(ns);
          return;
        }
        if (!loaded) return;
        if (snapshot.ops.dirty) {
          publish({ saveError: '这次没写入。你的修改还在。远端配置已经变化。', ui: { ...snapshot.ui, conflict: 'shown' } });
          return;
        }
        void (async () => {
          try {
            await resetFromDescribe(undefined, { keepView: true });
          } catch (error) {
            publish({ loadError: String(error), ui: { ...snapshot.ui, loading: false } });
          }
        })();
      }),
      port.on('credentials/reference-updated', (ref) => {
        if (!loaded) return;
        void (async () => {
          try {
            const status = await port.credentials.describe([ref]);
            credentials = { ...credentials, ...status };
            const next = clone(draft);
            for (const p of Object.values(next.providers)) {
              if (refsForProvider(p) === ref) {
                p.credConfigured = !!status[ref]?.configured;
                p.credWritable = status[ref]?.writable ?? p.credWritable;
              }
            }
            draft = next;
            const nextBase = clone(base);
            for (const p of Object.values(nextBase.providers)) {
              if (refsForProvider(p) === ref) {
                p.credConfigured = !!status[ref]?.configured;
                p.credWritable = status[ref]?.writable ?? p.credWritable;
              }
            }
            base = nextBase;
            publish();
          } catch (error) {
            publish({ saveError: String(error) });
          }
        })();
      }),
      port.on('llm/adapters-updated', () => {
        if (snapshot.ops.dirty) publish({ saveError: '这次没写入。你的修改还在。远端配置已经变化。', ui: { ...snapshot.ui, conflict: 'shown' } });
        else void resetFromDescribe(undefined, { keepView: true }).catch((error) => publish({ loadError: String(error) }));
      }),
      port.on('connection/reset', () => {
        if (snapshot.ops.dirty) publish({ saveError: '连接已重置。你的修改还在。', ui: { ...snapshot.ui, conflict: 'shown' } });
        else void resetFromDescribe(undefined, { keepView: true }).catch((error) => publish({ loadError: String(error) }));
      }),
    ];
  };

  const load = async (): Promise<void> => {
    // dispose 只结束一次挂载周期；下一次 load 重新启用 store（面板重新挂载 / StrictMode）。
    // 复位必须在复用 loadingPromise 的早退之前：dispose 期间结束的旧轮次，其 publish 已被吞掉，
    // 不能复用（拿不到 loading:false），所以 dispose 时丢弃旧 promise，这里发起新的一轮。
    disposed = false;
    if (loadingPromise) return loadingPromise;
    const token = ++loadSeq;
    const run = (async () => {
      publish({ ui: { ...snapshot.ui, loading: true } });
      subscribeEvents();
      try {
        await resetFromDescribe();
      } catch (error) {
        publish({ loadError: String(error), ui: { ...snapshot.ui, loading: false } });
      } finally {
        // 只清自己这一轮：被 dispose 作废的旧轮次迟到结束时，不能清掉新一轮的 promise。
        if (token === loadSeq) loadingPromise = null;
      }
    })();
    loadingPromise = run;
    return run;
  };

  const reload = async (): Promise<void> => {
    if (snapshot.ui.saving) return;
    publish({ ui: { ...snapshot.ui, loading: true, dialog: null } });
    try {
      await resetFromDescribe();
    } catch (error) {
      publish({ loadError: String(error), ui: { ...snapshot.ui, loading: false } });
    }
  };

  const save = async (): Promise<void> => {
    if (snapshot.ui.readonly || snapshot.ui.saving || snapshot.ui.conflict !== 'hidden') return;
    if (snapshot.ui.wizard) {
      setUi((ui) => { ui.dialog = { type: 'save-wiz' }; });
      return;
    }
    if (errorCount(snapshot.errors)) {
      statusPatch('请先修正标红字段。', '请先修正标红字段。');
      return;
    }
    const before = computeOps(base, draft, secrets);
    const credOps = mergedCredOps(before.cred);
    if (!before.pi.length && !before.ds.length && !credOps.length) {
      publish({ ui: { ...snapshot.ui, saved: true, status: '没有待写入的变更。', importPreview: null } });
      return;
    }
    const addedProvider = Object.keys(base.providers).every((id) => !draft.providers[id])
      ? false
      : Object.keys(draft.providers).some((id) => !base.providers[id] && draft.providers[id].ns === NS_PI);
    publish({ saveError: null, ui: { ...snapshot.ui, saving: true, saved: false, status: '' } });
    let settingsFailed = false;
    const writtenNamespaces: string[] = [];
    try {
      const settings: Array<[string, SettingsOp[], number | null]> = [
        [NS_PI, before.pi, revisions.pi],
        [NS_DS, before.ds, revisions.ds],
      ];
      for (const [ns, ops, revision] of settings) {
        if (!ops.length || revision == null || (ns === NS_PI && !slices.pi) || (ns === NS_DS && !slices.ds)) continue;
        inFlight.add(ns);
        try {
          const result = await port.mutate(ns, ops, revision);
          const echoes = pendingEcho.get(ns) ?? [];
          pendingEcho.set(ns, []);
          inFlight.delete(ns);
          if (!result.ok) {
            settingsFailed = true;
            const conflict = result.error.code === 'settings/conflict' || result.error.code === 'revision/conflict';
            const msg = conflict ? '这份配置刚刚被别处改过' : remoteErrorText(result.error);
            const stale = !conflict && echoes.length > 0;
            let saveError: string;
            if (writtenNamespaces.length) {
              saveError = `${msg}。${writtenNamespaces.join('、')} 已写入。${ns} 这次没写入。你的修改还在。`;
              if (stale) saveError += '远端配置已经变化。';
            } else if (conflict) {
              saveError = `${msg}，这次没写入。你的修改还在。`;
            } else {
              saveError = `${msg}。这次没写入。你的修改还在。${stale ? '远端配置已经变化。' : ''}`;
            }
            publish({ saveError, ui: { ...snapshot.ui, saving: false, status: '', conflict: conflict || stale ? 'shown' : snapshot.ui.conflict } });
            break;
          }
          const foreignEcho = echoes.filter((echo) => echo !== result.value.revision);
          if (foreignEcho.length) {
            settingsFailed = true;
            ownWrites.set(ns, result.value.revision);
            const written = writtenNamespaces.length ? `${writtenNamespaces.join('、')} 已写入。` : '';
            publish({
              saveError: `${written}配置已写入，但写入期间远端又被改过。你的修改还在。`,
              ui: { ...snapshot.ui, saving: false, status: '', conflict: 'shown' },
            });
            break;
          }
          ownWrites.set(ns, result.value.revision);
          updateNamespace(ns, result.value);
          writtenNamespaces.push(ns);
          publish({});
        } finally {
          inFlight.delete(ns);
        }
      }
      if (settingsFailed) return;

      pendingCred = mergedCredOps(before.cred);
      for (const op of [...pendingCred]) {
        const result = op.op === 'set'
          ? await port.credentials.set(op.ref, Object.entries(secrets).find(([route]) => refsForProvider(draft.providers[route]) === op.ref)?.[1] ?? '')
          : await port.credentials.unset(op.ref);
        if (!result.ok) {
          const message = op.op === 'set' && result.error.code.startsWith('credential/')
            ? '凭证被拒绝。环境变量可能已被占用。'
            : op.op === 'unset' && result.error.code.startsWith('credential/')
              ? '提供方已删除，凭证未移除。'
              : remoteErrorText(result.error);
          publish({ saveError: message, ui: { ...snapshot.ui, saving: false } });
          return;
        }
        pendingCred = pendingCred.filter((item) => item.ref !== op.ref);
        for (const route of refsToRoutes(op.ref)) {
          if (op.op === 'set') delete secrets[route];
          const next = clone(draft);
          const p = next.providers[route];
          if (p) p.credConfigured = op.op === 'set';
          draft = next;
          const nextBase = clone(base);
          const bp = nextBase.providers[route];
          if (bp) bp.credConfigured = op.op === 'set';
          base = nextBase;
        }
        publish({});
      }
      pendingCred = [];
      clearTests();
      const ui = { ...snapshot.ui, saving: false, saved: true, status: addedProvider ? `${NS_PI} 已写入。` : '已保存。', sel: {}, undo: null };
      publish({ saveError: null, ui: { ...ui, previewReturn: null, importPreview: null } });
      if (snapshot.ui.bulk) publish({ ui: { ...ui, bulk: null } });
    } catch (error) {
      publish({ saveError: String(error), ui: { ...snapshot.ui, saving: false } });
    }
  };

  const discard = () => {
    draft = clone(base);
    secrets = {};
    wizardSecret = '';
    pendingCred = [];
    publish({ saveError: null, ui: { ...snapshot.ui, saved: false, conflict: 'hidden', status: '', edit: null, bulk: null, dialog: null, importPreview: null } });
  };

  const closeTestDetail = () => { if (test) test = { ...test, open: null }; };
  const enter = (routeId: string) => setUi((ui) => { closeTestDetail(); ui.view = 'detail'; ui.route = routeId; ui.edit = null; ui.bulk = null; ui.dialog = null; });
  const backToList = () => setUi((ui) => { closeTestDetail(); ui.view = 'list'; ui.route = null; ui.edit = null; ui.bulk = null; ui.menuIdx = null; });
  const openPreview = () => setUi((ui) => { ui.previewReturn = { view: ui.view, route: ui.route }; ui.view = 'preview'; ui.edit = null; ui.bulk = null; });
  const closePreview = () => setUi((ui) => { const back = ui.previewReturn; ui.view = back?.view ?? 'list'; ui.route = back?.route ?? null; ui.previewReturn = null; });
  const openAddProvider = () => {
    wizardSecret = '';
    setUi((ui) => { ui.view = 'wizard'; ui.wizard = defaultWizard(); ui.route = null; ui.edit = null; ui.bulk = null; });
  };
  const wizardPatch = (patch: Partial<WizardDraft>) => {
    setUi((ui) => { if (ui.wizard) ui.wizard = { ...ui.wizard, ...clone(patch) }; });
  };
  const wizardNext = () => {
    const w = snapshot.ui.wizard;
    if (!w) return;
    if (w.step === 1) return wizardPatch({ step: 2 });
    if (w.step === 2) {
      const e = wizardErrors(w, draft);
      if (e.id || e.timeout || !w.ack || secretError(wizardSecret)) return wizardPatch({ tried2: true });
      return wizardPatch({ step: 3 });
    }
  };
  const wizardPrev = () => {
    const w = snapshot.ui.wizard;
    if (w && w.step > 1) wizardPatch({ step: (w.step - 1) as WizardDraft['step'] });
  };
  const wizardFinish = () => {
    const w = snapshot.ui.wizard;
    if (!w) return;
    const e = wizardErrors(w, draft);
    if (e.id || e.models || e.headers || e.timeout || !w.api || !w.ack || secretError(wizardSecret)) return;
    const id = w.id.trim();
    const timeout = parseTimeoutMinutes(w.timeoutText);
    const provider: ProviderDraft = {
      id,
      ns: NS_PI,
      api: w.api,
      displayName: w.displayName.trim() || undefined,
      baseURL: w.baseURL.trim() || undefined,
      apiKeyEnv: w.env.trim() || deriveEnv(id),
      headers: w.headers.filter((h) => h.k.trim()).map((h) => ({ k: h.k.trim(), v: h.v })),
      models: w.models.filter((idValue) => idValue.trim()).map((modelId) => ({ id: modelId.trim(), reasoningEfforts: false, extra: {} })),
      extra: {},
      credConfigured: false,
      credWritable: true,
    };
    // 合法分钟 → 整数毫秒；清空 → 不设（走 DSH 默认）。
    if (timeout.kind === 'ok') provider.streamIdleTimeoutMs = timeout.ms;
    mutateDraft((next) => { next.providers[id] = provider; }, { ui: { ...snapshot.ui, view: 'detail', route: id, wizard: null, saved: false } });
    if (wizardSecret) secrets[id] = wizardSecret;
    wizardSecret = '';
    publish();
  };
  const wizardCancel = () => setUi((ui) => { ui.dialog = ui.wizard ? { type: 'wiz-cancel' } : null; });

  const openModel = (idx: number) => setUi((ui) => { if (ui.route) ui.edit = { kind: 'model', route: ui.route, idx }; ui.menuIdx = null; });
  const addModel = () => {
    const route = snapshot.ui.route;
    const p = route ? draft.providers[route] : undefined;
    if (route === null || !p) return;
    const routeId = route;
    mutateDraft((next) => { next.providers[routeId].models.push({ id: '', reasoningEfforts: false, extra: {} }); }, { ui: { ...snapshot.ui, edit: { kind: 'model', route: routeId, idx: p.models.length } } });
  };
  const closeLayer = () => setUi((ui) => { ui.edit = null; });
  const openAccess = () => setUi((ui) => { if (ui.route) ui.edit = { kind: 'access', route: ui.route }; });
  const askDeleteProvider = () => setUi((ui) => { if (ui.route) ui.dialog = { type: 'delete', route: ui.route, text: '' }; });
  const askDiscard = () => setUi((ui) => { ui.dialog = { type: 'discard' }; });
  const askReload = () => setUi((ui) => { ui.dialog = { type: 'reload' }; });
  const setDeleteConfirm = (text: string) => setUi((ui) => { if (ui.dialog?.type === 'delete') ui.dialog = { ...ui.dialog, text }; });
  const cancelDialog = () => setUi((ui) => { ui.dialog = null; });
  const confirmDialog = () => {
    const dialog = snapshot.ui.dialog;
    if (!dialog) return;
    if (dialog.type === 'delete') {
      if (dialog.text !== dialog.route) return;
      mutateDraft((next) => { delete next.providers[dialog.route]; }, { ui: { ...snapshot.ui, dialog: null, edit: null, bulk: null, view: 'list', route: null } });
      return;
    }
    if (dialog.type === 'discard') return discard();
    if (dialog.type === 'reload') return void reload();
    if (dialog.type === 'wiz-cancel') return setUi((ui) => { ui.dialog = null; ui.wizard = null; ui.view = 'list'; });
    setUi((ui) => { ui.dialog = null; });
  };

  const activeModel = (): { route: string; provider: ProviderDraft; model: ModelDraft; idx: number } | null => {
    const edit = snapshot.ui.edit;
    if (!edit || edit.kind !== 'model') return null;
    const provider = draft.providers[edit.route];
    const model = provider?.models[edit.idx];
    return provider && model ? { route: edit.route, provider, model, idx: edit.idx } : null;
  };
  const setModelField = (field: 'id' | 'name', value: string) => {
    const active = activeModel();
    if (!active) return;
    mutateDraft((next) => {
      const model = next.providers[active.route].models[active.idx];
      if (field === 'id') model.id = value;
      else if (value) model.name = value;
      else delete model.name;
    });
  };
  const setModelId = (value: string) => setModelField('id', value);
  const setModelName = (value: string) => setModelField('name', value);

  const inputHintText = '至少保留一种输入类型';
  const showInputHint = (key: 'model' | 'bulk') => setUi((ui) => { ui.inputHint = { key, text: inputHintText }; });

  const toggleInput = (scope: 'model' | 'bulk', modality: InputModality) => {
    if (scope === 'bulk') {
      const b = snapshot.ui.bulk;
      if (!b) return;
      const current = b.inArr;
      if (current.length === 1 && current[0] === modality) return showInputHint('bulk');
      const next = current.includes(modality) ? current.filter((item) => item !== modality) : [...current, modality];
      setUi((ui) => { if (ui.bulk) ui.bulk = { ...ui.bulk, inArr: next }; ui.inputHint = null; });
      return;
    }
    const active = activeModel();
    if (!active) return;
    const current = isPi(active.provider) ? active.model.input : active.model.inputModalities;
    if (current?.length === 1 && current[0] === modality) return showInputHint('model');
    const next = current ? (current.includes(modality) ? current.filter((item) => item !== modality) : [...current, modality]) : [modality];
    mutateDraft((draftNext) => {
      const p = draftNext.providers[active.route];
      const m = p.models[active.idx];
      if (isPi(p)) m.input = next;
      else m.inputModalities = next;
    }, { ui: { ...snapshot.ui, inputHint: null } });
  };

  const clearInput = () => {
    const active = activeModel();
    if (!active) return;
    mutateDraft((next) => {
      const m = next.providers[active.route].models[active.idx];
      if (isPi(active.provider)) delete m.input;
      else delete m.inputModalities;
    }, { ui: { ...snapshot.ui, inputHint: null } });
  };


  const toggleNoThink = () => {
    const active = activeModel();
    if (!active || !isPi(active.provider)) return;
    mutateDraft((next) => {
      const m = next.providers[active.route].models[active.idx];
      if (m.reasoningEfforts && typeof m.reasoningEfforts === 'object') {
        m._stash = clone(m.reasoningEfforts);
        m.reasoningEfforts = false;
      } else if (m.reasoningEfforts === false) {
        m.reasoningEfforts = clone(m._stash ?? { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
        delete m._stash;
      } else {
        m.reasoningEfforts = false;
      }
    });
  };
  const toggleDsThinking = () => {
    const route = snapshot.ui.route;
    if (!route || draft.providers[route]?.ns !== NS_DS) return;
    mutateDraft((next) => {
      const p = next.providers[route];
      p.thinking = p.thinking === 'disabled' ? 'enabled' : 'disabled';
      if (p.thinking === 'disabled') p.reasoningEffort = 'off';
      else if (p.reasoningEffort === 'off') p.reasoningEffort = snapshot.ui.dsPrev || 'high';
    });
  };

  const railToggle = (key: string, level: string) => {
    if (key === 'bulk') {
      if (!(ALL_EFFORTS as readonly string[]).includes(level) || !snapshot.ui.bulk) return;
      const selected = new Set(snapshot.ui.bulk.thSel);
      if (selected.has(level as Effort)) selected.delete(level as Effort);
      else selected.add(level as Effort);
      patchBulk({ thSel: ALL_EFFORTS.filter((effort) => selected.has(effort)) });
      return;
    }
    if (key === 'ds') {
      const route = snapshot.ui.route;
      if (!route) return;
      mutateDraft((next) => {
        const p = next.providers[route];
        if (p?.ns === NS_DS) {
          p.reasoningEffort = level;
          if (level !== 'off') p.thinking = 'enabled';
        }
      });
      return;
    }
    if (key.startsWith('m:')) {
      const [, route, indexText] = key.split(':');
      const idx = Number(indexText);
      mutateDraft((next) => {
        const m = next.providers[route]?.models[idx];
        if (!m) return;
        const current = m.reasoningEfforts;
        const map: ReasoningMap = current && typeof current === 'object' ? clone(current) : {};
        const effort = level as Effort;
        if (has(map, effort)) delete map[effort];
        else map[effort] = level;
        m.reasoningEfforts = Object.keys(map).length ? map : false;
      });
    }
  };
  const setSpell = (level: string, value: string | null) => {
    const active = activeModel();
    if (!active || !isPi(active.provider)) return;
    mutateDraft((next) => {
      const m = next.providers[active.route].models[active.idx];
      const map = m.reasoningEfforts && typeof m.reasoningEfforts === 'object' ? clone(m.reasoningEfforts) : {};
      map[level as Effort] = value;
      m.reasoningEfforts = map;
    });
  };

  const capFieldName = (side: CapSideKey): 'contextWindow' | 'maxTokens' => side === 'cw' ? 'contextWindow' : 'maxTokens';
  const setCap = (side: CapSideKey, raw: string) => {
    const active = activeModel();
    if (!active) return;
    mutateDraft((next) => {
      next.providers[active.route].models[active.idx][capFieldName(side)] = raw;
    });
  };
  const capClear = (side: CapSideKey) => {
    const active = activeModel();
    if (!active) return;
    mutateDraft((next) => { delete next.providers[active.route].models[active.idx][capFieldName(side)]; });
  };
  const blurCap = (side: CapSideKey) => {
    const active = activeModel();
    if (!active) return;
    const key = capFieldName(side);
    const raw = active.model[key];
    if (raw === undefined) return;
    if (!raw.trim()) return capClear(side);
    const parsed = parseCap(raw);
    if (typeof parsed === 'number') setCap(side, String(parsed));
  };


  const setAccessField = (field: 'displayName' | 'api' | 'baseURL' | 'apiKeyEnv', value: string) => {
    const edit = snapshot.ui.edit;
    if (!edit || edit.kind !== 'access') return;
    mutateDraft((next) => {
      const p = next.providers[edit.route];
      if (!p) return;
      if ((field === 'displayName' || field === 'baseURL') && !value) delete p[field];
      else p[field] = value;
    });
  };
  const setSecret = (value: string) => {
    const edit = snapshot.ui.edit;
    if (!edit || edit.kind !== 'access') return;
    if (value) secrets[edit.route] = value;
    else delete secrets[edit.route];
    publish({ ui: { ...snapshot.ui, saved: false } });
  };
  const setWizardSecret = (value: string) => { wizardSecret = value; };
  const headerAdd = (scope: 'access' | 'wizard') => {
    if (scope === 'wizard') return wizardPatch({ headers: [...(snapshot.ui.wizard?.headers ?? []), { k: '', v: '' }] });
    const edit = snapshot.ui.edit;
    if (!edit || edit.kind !== 'access') return;
    mutateDraft((next) => { next.providers[edit.route].headers = [...(next.providers[edit.route].headers ?? []), { k: '', v: '' }]; });
  };
  const headerDelete = (scope: 'access' | 'wizard', idx: number) => {
    if (scope === 'wizard') return wizardPatch({ headers: (snapshot.ui.wizard?.headers ?? []).filter((_, i) => i !== idx) });
    const edit = snapshot.ui.edit;
    if (!edit || edit.kind !== 'access') return;
    mutateDraft((next) => { next.providers[edit.route].headers = (next.providers[edit.route].headers ?? []).filter((_, i) => i !== idx); });
  };
  const headerEdit = (scope: 'access' | 'wizard', idx: number, part: 'k' | 'v', value: string) => {
    if (scope === 'wizard') {
      const headers = clone(snapshot.ui.wizard?.headers ?? []);
      if (headers[idx]) headers[idx][part] = value;
      return wizardPatch({ headers });
    }
    const edit = snapshot.ui.edit;
    if (!edit || edit.kind !== 'access') return;
    mutateDraft((next) => {
      const headers = next.providers[edit.route].headers ?? [];
      if (headers[idx]) headers[idx][part] = value;
    });
  };
  const migrate = () => {
    const route = snapshot.ui.route;
    const p = route ? draft.providers[route] : undefined;
    if (route === null || !p || !isPi(p)) return;
    const routeId = route;
    mutateDraft((next) => {
      for (const model of next.providers[routeId].models) {
        if (!model.input && model.inputModalities) {
          model.input = [...model.inputModalities];
          delete model.inputModalities;
        }
      }
    }, { ui: { ...snapshot.ui, status: '已迁移旧字段。' } });
  };

  const selectAll = () => {
    const route = snapshot.ui.route;
    const p = route ? draft.providers[route] : undefined;
    if (!route || !p) return;
    setUi((ui) => { ui.sel = { ...ui.sel, [route]: p.models.map((_, i) => i) }; });
  };
  const selectClear = () => {
    const route = snapshot.ui.route;
    if (!route) return;
    setUi((ui) => { ui.sel = { ...ui.sel, [route]: [] }; });
  };
  const selectIndex = (idx: number, on: boolean) => {
    const route = snapshot.ui.route;
    if (!route) return;
    setUi((ui) => {
      const current = new Set(ui.sel[route] ?? []);
      if (on) current.add(idx); else current.delete(idx);
      ui.sel = { ...ui.sel, [route]: [...current].sort((a, b) => a - b) };
    });
  };
  const openBulk = () => {
    const route = snapshot.ui.route;
    const p = route ? draft.providers[route] : undefined;
    if (!route || !p) return;
    setUi((ui) => { ui.bulk = newBulk(route, ui.sel[route] ?? []); ui.menuIdx = null; });
  };
  const closeBulk = () => setUi((ui) => { ui.bulk = null; });
  const patchBulk = (patch: Partial<BulkDraft>) => setUi((ui) => { if (ui.bulk) ui.bulk = { ...ui.bulk, ...clone(patch) }; });
  const applyBulk = () => {
    const b = snapshot.ui.bulk;
    const p = b ? draft.providers[b.route] : undefined;
    if (!b || !p) return;
    const plan = bulkPlan(p, b);
    if (!plan.C) return;
    mutateDraft((next) => {
      const models = next.providers[b.route].models;
      for (const result of plan.results) models[result.i] = clone(result.next);
    }, { ui: { ...snapshot.ui, bulk: null, status: bulkResultMsg(b, plan) } });
  };
  const openMenu = (idx: number) => setUi((ui) => { ui.menuIdx = idx; });
  const closeMenu = () => setUi((ui) => { ui.menuIdx = null; });
  const copyModel = (idx: number) => {
    const route = snapshot.ui.route;
    const p = route ? draft.providers[route] : undefined;
    if (!route || !p || !p.models[idx]) return;
    mutateDraft((next) => {
      const source = clone(next.providers[route].models[idx]);
      source.id = '';
      source.name = undefined;
      next.providers[route].models.splice(idx + 1, 0, source);
    }, { ui: { ...snapshot.ui, menuIdx: null } });
  };
  const moveModel = (idx: number, dir: -1 | 1) => {
    const route = snapshot.ui.route;
    const p = route ? draft.providers[route] : undefined;
    const target = idx + dir;
    if (!route || !p || target < 0 || target >= p.models.length) return;
    mutateDraft((next) => {
      const list = next.providers[route].models;
      [list[idx], list[target]] = [list[target], list[idx]];
    }, { ui: { ...snapshot.ui, menuIdx: null } });
  };
  const deleteModel = (idx: number) => {
    const route = snapshot.ui.route;
    const p = route ? draft.providers[route] : undefined;
    if (!route || !p || !p.models[idx]) return;
    mutateDraft((next) => {
      const model = next.providers[route].models.splice(idx, 1)[0];
      next.providers[route].models = next.providers[route].models;
      const ui = snapshot.ui;
      ui.undo = { route, model: clone(model), idx };
    }, { ui: { ...snapshot.ui, menuIdx: null,
     undo: { route, model: clone(p.models[idx]), idx } } });
  };
  const undoDelete = () => {
    const undo = snapshot.ui.undo;
    if (!undo || !draft.providers[undo.route]) return;
    mutateDraft((next) => { next.providers[undo.route].models.splice(undo.idx, 0, clone(undo.model)); }, { ui: { ...snapshot.ui, undo: null } });
  };
  /** 流空闲超时：按 route 寻址（DS 传 DS_ROUTE_ID）。route 不存在、只读或保存中时 no-op，不 publish。 */
  const mutateTimeout = (route: string, fn: (p: ProviderDraft) => void) => {
    if (snapshot.ui.readonly || snapshot.ui.saving || !has(draft.providers, route)) return;
    mutateDraft((next) => fn(next.providers[route]));
  };
  const setTimeoutText = (route: string, text: string) => mutateTimeout(route, (p) => { p.timeoutText = text; });
  const blurTimeout = (route: string) => {
    const text = has(draft.providers, route) ? draft.providers[route].timeoutText : undefined;
    if (text === undefined) return;
    const parsed = parseTimeoutMinutes(text);
    if (parsed.kind === 'error') return; // 保留原文，继续标红
    mutateTimeout(route, (p) => {
      if (parsed.kind === 'ok') p.streamIdleTimeoutMs = parsed.ms;
      else delete p.streamIdleTimeoutMs;
      delete p.timeoutText;
    });
  };
  const setTimeoutPreset = (route: string, ms: number) => mutateTimeout(route, (p) => {
    p.streamIdleTimeoutMs = ms;
    delete p.timeoutText;
  });
  const resetTimeout = (route: string) => mutateTimeout(route, (p) => {
    delete p.streamIdleTimeoutMs;
    delete p.timeoutText;
  });
  const toggleAdv = (railKey: string) => setUi((ui) => { ui.showAdv = { ...ui.showAdv, [railKey]: !ui.showAdv[railKey] }; });
  const dismissStatus = () => publish({ saveError: null, ui: { ...snapshot.ui, status: '' } });
  const keepConflict = () => publish({ saveError: '草稿还在，但解除冲突前保存会失败。', ui: { ...snapshot.ui, conflict: 'kept' } });
  const exportConfig = (): void => {
    if (snapshot.ui.loading || snapshot.ui.saving || snapshot.loadError) return;
    const dirty = snapshot.ops.dirty > 0 || snapshot.ui.conflict !== 'hidden';
    const text = exportModelConfig(base);
    downloadYaml(modelExportFilename(), text);
    const prefix = dirty ? '只导出已保存的配置。' : '已导出。';
    publish({ ui: { ...snapshot.ui, status: `${prefix}文件不含密钥和请求头；baseURL 和 apiKeyEnv 属于接入信息，分享前请检查` } });
  };
  const importConfig = async (file: { name: string; size: number; text: () => Promise<string> }): Promise<void> => {
    if (
      snapshot.ui.readonly
      || snapshot.ui.loading
      || snapshot.ui.saving
      || snapshot.loadError
      || snapshot.ops.dirty > 0
      || snapshot.ui.conflict !== 'hidden'
    ) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('文件超过 1MB 上限');
      const text = await readImportFile(file as unknown as File);
      const parsed = parseModelConfig(text);
      const preview = previewModelImport(parsed, draft, { hasDs: snapshot.hasDs });
      publish({ saveError: null, ui: {
        ...snapshot.ui,
        importPreview: {
          fileName: file.name,
          items: preview.items,
          selected: preview.items.filter((item) => item.checkable && item.checked).map((item) => item.id),
          warning: preview.warning,
        },
      } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      publish({ saveError: `无法导入 ${file.name}：${message}`, ui: { ...snapshot.ui, importPreview: null } });
    }
  };
  const setImportChecked = (id: string, on: boolean): void => {
    const current = snapshot.ui.importPreview;
    if (!current) return;
    const item = current.items.find((candidate) => candidate.id === id);
    if (!item?.checkable) return;
    const selected = new Set(current.selected);
    if (on) selected.add(id); else selected.delete(id);
    publish({ ui: { ...snapshot.ui, importPreview: { ...current, selected: [...selected] } } });
  };
  const confirmImport = (): void => {
    const current = snapshot.ui.importPreview;
    if (!current) return;
    const next = applyModelImport(draft, current.items, new Set(current.selected));
    draft = next;
    publish({ ui: { ...snapshot.ui, importPreview: null, status: '已导入到草稿，尚未保存。请预览变更后保存。', saved: false } });
  };
  const cancelImport = (): void => {
    if (!snapshot.ui.importPreview) return;
    publish({ ui: { ...snapshot.ui, importPreview: null } });
  };

  /* ---------------- R4a 模型测试：队列、批量、门控（§2.3） ---------------- */
  const publishTest = (next: Partial<McTestState>, ui?: Partial<McUi>) => {
    if (!test || disposed) return;
    test = { ...test, ...next };
    publish(ui ? { ui: { ...snapshot.ui, ...ui } } : undefined);
  };

  const abortAll = () => {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  };

  /** 作废所有在途与排队的测试（resetFromDescribe、save 成功、dispose）；skipCost 保留。 */
  const clearTests = () => {
    if (!test) return;
    gen += 1;
    active = 0;
    queue = [];
    jobSeq.clear();
    abortAll();
    test = { ...initialTestState(), skipCost: test.skipCost };
  };

  /** 门控原因：取 publish 现算的 blocked；路由不在草稿里时按「新建」处理。 */
  const gateReason = (route: string): string | null => {
    const blocked = snapshot.test?.blocked;
    if (blocked && has(blocked, route)) return blocked[route];
    return blockReason({ hostUnsupported: !!test?.hostUnsupported, saving: snapshot.ui.saving, isNew: true, dirty: false, secretPending: false });
  };

  const enqueue = (results: Record<string, TestEntry>, route: string, modelId: string, front: boolean) => {
    const key = testKey(route, modelId);
    const current = results[key];
    seq += 1;
    jobSeq.set(key, seq);
    const prev = current && !isBusy(current) ? withoutPrev(current) : current?.prev;
    results[key] = prev ? { state: 'queued', prev } : { state: 'queued' };
    const job: TestJob = { key, route, modelId, gen, seq };
    if (front) queue.unshift(job); else queue.push(job);
  };

  const batchOf = (key: string): string | null => {
    if (!test) return null;
    for (const [route, b] of Object.entries(test.batches)) {
      if (!b.done && b.keys.includes(key)) return route;
    }
    return null;
  };

  const finishJob = (job: TestJob, res: ModelTestResult) => {
    if (!test) return;
    const results = { ...test.results, [job.key]: { state: resultState(res), result: res, at: Date.now() } };
    let live = resultAnnounce(job.modelId, res);
    let batches = test.batches;
    const route = batchOf(job.key);
    if (route) {
      const b = batches[route];
      const stats = batchStats(b, results);
      live += `。${progressText(stats)}`;
      if (!stats.running && !stats.queued) {
        const done = { ...b, done: true, endedAt: Date.now() };
        batches = { ...batches, [route]: done };
        live = doneAnnounce(done, stats);
      }
    }
    test = { ...test, results, batches, live };
  };

  const markHostUnsupported = () => {
    if (!test) return;
    gen += 1;
    active = 0;
    queue = [];
    jobSeq.clear();
    abortAll();
    const results: Record<string, TestEntry> = {};
    for (const [key, entry] of Object.entries(test.results)) {
      if (!isBusy(entry)) results[key] = entry;
      else if (entry.prev) results[key] = entry.prev;
    }
    const open = test.open && results[test.open]?.result ? test.open : null;
    test = { ...test, hostUnsupported: true, results, batches: {}, cost: null, open };
    publish({ ui: { ...snapshot.ui, status: MODEL_TEST_UNSUPPORTED } });
  };

  const settle = (job: TestJob, controller: AbortController, outcome: TestOutcome) => {
    if (controllers.get(job.key) === controller) controllers.delete(job.key);
    // gen 过期（含 AbortError）：clearTests / HOST_UNSUPPORTED 已把 active 归零，直接丢弃。
    if (disposed || !test || job.gen !== gen) return;
    active = Math.max(0, active - 1);
    const entry = test.results[job.key];
    if (jobSeq.get(job.key) !== job.seq || entry?.state !== 'running') {
      pump();
      publish();
      return;
    }
    if (!outcome.ok && errorField(outcome.error, 'code') === 'HOST_UNSUPPORTED') {
      markHostUnsupported();
      return;
    }
    finishJob(job, outcome.ok ? outcome.res : synthTestResult(job.route, job.modelId, outcome.error));
    pump();
    publish();
  };

  /** 并发 3：取队首，跳过作废或已不是 queued 的作业。只改 test，由调用方 publish。 */
  function pump(): void {
    if (!tester || !test) return;
    while (active < TEST_CONCURRENCY && queue.length) {
      const job = queue.shift();
      if (!job) break;
      const entry: TestEntry | undefined = test.results[job.key];
      if (job.gen !== gen || jobSeq.get(job.key) !== job.seq || entry?.state !== 'queued') continue;
      active += 1;
      test = { ...test, results: { ...test.results, [job.key]: { ...entry, state: 'running', startedAt: Date.now() } } };
      const controller = new AbortController();
      controllers.set(job.key, controller);
      // tester 是注入依赖：同步抛错或返回非 thenable 都按契约违规落 reject（HOST_ERROR），
      // 保证条目进终态、并发槽经 settle 归还。非 thenable 用普通 Error，避免被当成 fetch 的 TypeError。
      let pending: Promise<ModelTestResult>;
      try {
        const ret: unknown = tester({ provider: job.route, model: job.modelId }, controller.signal);
        pending = isThenable(ret)
          ? Promise.resolve(ret as PromiseLike<ModelTestResult>)
          : Promise.reject(new Error('tester 返回值不是 Promise'));
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending.then(
        (res) => settle(job, controller, { ok: true, res }),
        (error: unknown) => settle(job, controller, { ok: false, error }),
      );
    }
  }

  const testModel = (route: string, modelId: string) => {
    if (!test || disposed || !modelId) return;
    const reason = gateReason(route);
    if (reason) return statusPatch(`${reason}。`);
    const key = testKey(route, modelId);
    if (isBusy(test.results[key])) return;
    const results = { ...test.results };
    enqueue(results, route, modelId, true);
    test = { ...test, results };
    pump();
    publish();
  };

  const startBatch = (route: string, ids: string[], label: TestBatchLabel) => {
    if (!test) return;
    const results = { ...test.results };
    for (const id of ids) enqueue(results, route, id, false);
    const batch = { route, keys: ids.map((id) => testKey(route, id)), label, stopped: false, done: false, startedAt: Date.now() };
    test = { ...test, results, batches: { ...test.batches, [route]: batch }, live: `开始测试 ${ids.length} 个模型，并发 ${TEST_CONCURRENCY}。` };
    pump();
    publish();
  };

  /** 门控 → 批次在途 → 去掉忙的 id；空则提示。返回可入队的 id，或 null（已给出 status）。 */
  const batchTargets = (route: string, ids: string[]): string[] | null => {
    if (!test) return null;
    const reason = gateReason(route);
    if (reason) { statusPatch(`${reason}。`); return null; }
    const running = test.batches[route];
    if (running && !running.done) { statusPatch('正在批量测试，先等它完成或停止。'); return null; }
    const results = test.results;
    const targets = [...new Set(ids.filter(Boolean))].filter((id) => !isBusy(results[testKey(route, id)]));
    if (!targets.length) { statusPatch('没有可测试的模型。'); return null; }
    return targets;
  };

  const requestBatch = (route: string, ids: string[], label: TestBatchLabel) => {
    if (!test || disposed) return;
    const targets = batchTargets(route, ids);
    if (!targets) return;
    if (targets.length > 1 && !test.skipCost && draft.providers[route]?.credConfigured) {
      publishTest({ cost: { route, modelIds: targets, label } });
      return;
    }
    startBatch(route, targets, label);
  };

  const modelIds = (route: string): string[] => (draft.providers[route]?.models ?? []).map((m) => m.id);
  const testProvider = (route: string) => requestBatch(route, modelIds(route), '全部模型');
  const testAll = () => { if (snapshot.ui.route) testProvider(snapshot.ui.route); };
  const testSelected = () => {
    const route = snapshot.ui.route;
    if (!route) return;
    const models = draft.providers[route]?.models ?? [];
    const ids = (snapshot.ui.sel[route] ?? []).map((idx) => models[idx]?.id ?? '');
    requestBatch(route, ids, '所选模型');
  };
  const batchKeysIn = (route: string, states: readonly string[]): string[] => {
    const b = test?.batches[route];
    if (!test || !b) return [];
    const results = test.results;
    return b.keys
      .filter((key) => states.includes(results[key]?.state ?? 'queued'))
      .map((key) => key.slice(route.length + 1));
  };
  const retryFailed = (route: string) => requestBatch(route, batchKeysIn(route, ['fail', 'transient']), '重试失败项');
  const retryCancelled = (route: string) => requestBatch(route, batchKeysIn(route, ['cancelled']), '已取消的模型');

  const stopBatch = (route: string) => {
    const b = test?.batches[route];
    if (!test || !b || b.done) return;
    const keys = new Set(b.keys);
    const results = { ...test.results };
    let cancelled = 0;
    let running = 0;
    for (const key of b.keys) {
      const entry = results[key];
      if (entry?.state === 'queued') {
        results[key] = { state: 'cancelled' };
        cancelled += 1;
      } else if (entry?.state === 'running') {
        running += 1;
      }
    }
    queue = queue.filter((job) => !keys.has(job.key));
    const stopped = { ...b, stopped: true, ...(running ? {} : { done: true, endedAt: Date.now() }) };
    const live = running
      ? `已取消 ${cancelled} 个未开始的测试，${running} 个已发出的请求会等它返回。`
      : `已取消 ${cancelled} 个未开始的测试。`;
    publishTest({ results, batches: { ...test.batches, [route]: stopped }, live });
  };

  const dismissBatch = (route: string) => {
    const b = test?.batches[route];
    if (!test || !b?.done) return;
    const batches = { ...test.batches };
    delete batches[route];
    publishTest({ batches });
  };

  const toggleTestDetail = (route: string, modelId: string) => {
    if (!test) return;
    const key = testKey(route, modelId);
    if (test.open === key) return publishTest({ open: null });
    if (!test.results[key]?.result) return;
    publishTest({ open: key });
  };

  const confirmCost = (skip: boolean) => {
    if (!test || disposed || !test.cost) return;
    const cost = test.cost;
    test = { ...test, cost: null, skipCost: skip ? true : test.skipCost };
    const targets = batchTargets(cost.route, cost.modelIds);
    if (!targets) return;
    startBatch(cost.route, targets, cost.label);
  };

  const cancelCost = () => {
    if (!test?.cost) return;
    publishTest({ cost: null });
  };

  const copyTestDetail = (route: string, modelId: string): string => {
    if (!test) return '';
    const text = testDetailText(route, modelId, test.results[testKey(route, modelId)]);
    statusPatch(`已复制 ${modelId} 的测试详情（不含密钥）。`);
    return text;
  };

  /** 只结束本次挂载周期：取消订阅、作废测试；到下一次 load 之前不 publish（§2.3）。 */
  const dispose = () => {
    for (const disposer of disposers.splice(0)) disposer();
    clearTests();
    disposed = true;
    // 作废在途的 load：下一次 load 必须发起新的一轮，而不是复用 publish 已被吞掉的旧 promise。
    loadSeq += 1;
    loadingPromise = null;
  };

  const store: ModelCapabilitiesStore = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    load,
    dispose,
    save,
    exportConfig,
    importConfig,
    setImportChecked,
    confirmImport,
    cancelImport,
    discard,
    reload,
    keepConflict,
    enter,
    backToList,
    openPreview,
    closePreview,
    openAddProvider,
    wizardPatch,
    wizardNext,
    wizardPrev,
    wizardFinish,
    wizardCancel,
    openModel,
    addModel,
    closeLayer,
    openAccess,
    askDeleteProvider,
    askDiscard,
    askReload,
    confirmDialog,
    cancelDialog,
    setDeleteConfirm,
    setModelId,
    setModelName,
    toggleInput,
    clearInput,
    toggleNoThink,
    toggleDsThinking,
    railToggle,
    setSpell,
    setCap,
    blurCap,
    capClear,
    setAccessField,
    setSecret,
    setWizardSecret,
    headerAdd,
    headerDelete,
    headerEdit,
    migrate,
    selectAll,
    selectClear,
    selectIndex,
    openBulk,
    closeBulk,
    patchBulk,
    applyBulk,
    openMenu,
    closeMenu,
    copyModel,
    moveModel,
    deleteModel,
    undoDelete,
    toggleAdv,
    dismissStatus,
    setTimeoutText,
    blurTimeout,
    setTimeoutPreset,
    resetTimeout,
    testModel,
    testProvider,
    testAll,
    testSelected,
    retryFailed,
    retryCancelled,
    stopBatch,
    dismissBatch,
    toggleTestDetail,
    confirmCost,
    cancelCost,
    copyTestDetail,
  };
  return store;
}
