import { bulkPlan, newBulk, bulkResultMsg } from './bulk';
import { parseCap } from './capacity';
import { deriveEnv } from './efforts';
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
  type McUi,
  type ModelCapabilitiesPort,
  type ModelCapabilitiesStore,
  type ModelDraft,
  type NamespaceSlice,
  type ProviderDraft,
  type ReasoningMap,
  type RemoteError,
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
  };
}

function errorCount(errors: AllErrors): boolean {
  return Object.values(errors).some((entry) => Object.keys(entry.route).length || entry.models.some((m) => Object.keys(m).length));
}

export function createModelCapabilitiesStore(port: ModelCapabilitiesPort): ModelCapabilitiesStore {
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
      nextUi = { ...previousUi, loading: false, readonly, saving: false, saved: false, conflict: 'hidden', status: '', menuIdx: null };
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
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      publish({ ui: { ...snapshot.ui, loading: true } });
      subscribeEvents();
      try {
        await resetFromDescribe();
      } catch (error) {
        publish({ loadError: String(error), ui: { ...snapshot.ui, loading: false } });
      } finally {
        loadingPromise = null;
      }
    })();
    return loadingPromise;
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
      publish({ ui: { ...snapshot.ui, saved: true, status: '没有待写入的变更。' } });
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
      const ui = { ...snapshot.ui, saving: false, saved: true, status: addedProvider ? `${NS_PI} 已写入。` : '已保存。', sel: {}, undo: null };
      publish({ saveError: null, ui: { ...ui, previewReturn: null } });
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
    publish({ saveError: null, ui: { ...snapshot.ui, saved: false, conflict: 'hidden', status: '', edit: null, bulk: null, dialog: null } });
  };

  const enter = (routeId: string) => setUi((ui) => { ui.view = 'detail'; ui.route = routeId; ui.edit = null; ui.bulk = null; ui.dialog = null; });
  const backToList = () => setUi((ui) => { ui.view = 'list'; ui.route = null; ui.edit = null; ui.bulk = null; ui.menuIdx = null; });
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
      if (e.id || !w.ack || secretError(wizardSecret)) return wizardPatch({ tried2: true });
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
    if (e.id || e.models || e.headers || !w.api || !w.ack || secretError(wizardSecret)) return;
    const id = w.id.trim();
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
    }, { ui: { ...snapshot.ui, menuIdx: null, undo: { route, model: clone(p.models[idx]), idx } } });
  };
  const undoDelete = () => {
    const undo = snapshot.ui.undo;
    if (!undo || !draft.providers[undo.route]) return;
    mutateDraft((next) => { next.providers[undo.route].models.splice(undo.idx, 0, clone(undo.model)); }, { ui: { ...snapshot.ui, undo: null } });
  };
  const toggleAdv = (railKey: string) => setUi((ui) => { ui.showAdv = { ...ui.showAdv, [railKey]: !ui.showAdv[railKey] }; });
  const dismissStatus = () => publish({ saveError: null, ui: { ...snapshot.ui, status: '' } });
  const keepConflict = () => publish({ saveError: '草稿还在，但解除冲突前保存会失败。', ui: { ...snapshot.ui, conflict: 'kept' } });

  const dispose = () => {
    for (const disposer of disposers.splice(0)) disposer();
  };

  const store: ModelCapabilitiesStore = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    load,
    dispose,
    save,
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
  };
  return store;
}
