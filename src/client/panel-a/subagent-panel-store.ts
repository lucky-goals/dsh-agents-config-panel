/**
 * Framework-agnostic store for Panel A (Subagent management)
 *
 * Provides getSnapshot/subscribe pattern for React's useSyncExternalStore.
 * No Vue dependencies.
 *
 * v2.1: subagentProviders list + capability-driven form + registered-only edit.
 */

import type { ApiClient } from '../shared/api-client';
import type {
  AcpRow,
  AcpTestResponse,
  AcpsMutationRequest,
  SubagentRow,
  SubagentProviderInfo,
  SubagentProviderCapabilities,
  ModelCatalog,
  StateDiagnostics,
  StateResponse,
  SubagentsMutationRequest,
} from '../shared/api-types';
import { DEFAULT_TEAM_PROFILE, WRITE_UNAVAILABLE_MESSAGE, isWriteBlocked } from '../ui/host-state';
import { MSG } from '../ui/messages';
import {
  acpConfigFromForm,
  acpFormFromRow,
  diffAcpPatch,
  emptyAcpForm,
  validateAcpForm,
  type AcpFormData,
  type AcpFormErrors,
} from './acp-form';
import {
  downloadYaml,
  exportSubagentBundle,
  importableBundle,
  parseSubagentBundle,
  previewSubagentImport,
  readImportFile,
  subagentExportFilename,
  type SubagentImportPreview,
} from '../shared/import-export';

// ============================================================================
// State Types
// ============================================================================

export interface SubagentFormData {
  toolName: string;
  /** v2.1: any registered provider name, not just spawn|fork. */
  provider: string;
  backgroundMode: 'continuable' | 'one-shot';
  agentOptions: {
    provider: string;
    model: string;
    reasoningEffort: string;
  };
}

export interface SubagentFormErrors {
  toolName?: string;
  provider?: string;
  agentOptions?: {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  };
}

export type FormMode = 'create' | 'edit' | null;

/**
 * Provider list used whenever the Host is not v2.1 (`hostApi !== 2`, contract §9).
 * Capabilities match the real in-process providers (all five true); fork's
 * agentOptions exception is applied by name in {@link suppressAgentOptions}.
 */
const IN_PROCESS_CAPS: SubagentProviderCapabilities = {
  agentOptions: true, depthLimit: true, continuable: true, persona: true, toolFilter: true,
};
export const LEGACY_PROVIDERS: readonly SubagentProviderInfo[] = [
  { name: 'spawn', kind: 'in-process', capabilities: { ...IN_PROCESS_CAPS }, source: 'patch' },
  { name: 'fork', kind: 'in-process', capabilities: { ...IN_PROCESS_CAPS }, source: 'patch' },
];

// ----------------------------------------------------------------------------
// Capability predicates — the single source for both rendering and submit.
// ----------------------------------------------------------------------------

/** Capabilities of `name` in `providers`, or null when it is not listed. */
export function capsOf(
  providers: readonly SubagentProviderInfo[],
  name: string,
): SubagentProviderCapabilities | null {
  return providers.find((p) => p.name === name)?.capabilities ?? null;
}

/**
 * True when the form must hide the Agent Provider / Model / Reasoning Effort
 * cascade and the payload must not carry agentOptions. The only name-based
 * exception in the client (contract §3): fork never takes agentOptions.
 */
export function suppressAgentOptions(name: string, caps: SubagentProviderCapabilities | null | undefined): boolean {
  return name === 'fork' || caps?.agentOptions !== true;
}

/** Background Mode may be continuable. Unknown providers are not continuable. */
export function supportsContinuable(caps: SubagentProviderCapabilities | null | undefined): boolean {
  return caps?.continuable === true;
}

export interface SubagentPanelState {
  loading: boolean;
  error: string | null;
  notice: string | null;
  conflict: string | null;
  rows: SubagentRow[];
  catalog: ModelCatalog;
  revision: string;
  diagnostics: StateDiagnostics | null;
  /** v2.1: ordered list of subagent providers with capabilities (legacy spawn/fork unless hostApi === 2). */
  subagentProviders: readonly SubagentProviderInfo[];
  /**
   * `diagnostics.hostApi === 2`. `null` until the first state has loaded, so
   * the old-Host notice never flashes before the Host has answered.
   */
  hostApiV2: boolean | null;
  form: {
    mode: FormMode;
    editingId: string | null;
    values: SubagentFormData;
    /** Values the edit form opened with; the update patch is diffed against them. */
    original: SubagentFormData | null;
    errors: SubagentFormErrors;
  };
  confirmDelete: {
    id: string | null;
    toolName: string | null;
  };
  /**
   * v2.3: ACP registrations of this DSH profile. They live in the same patch
   * as the subagent rows, so they share this store's revision: an ACP write
   * never leaves the subagent form with a stale revision, and vice versa.
   */
  acps: AcpRow[];
  /** `null` until loaded; `false` when the Host predates v2.3 (no `acps` in state). */
  acpSupported: boolean | null;
  /** The DSH profile the Host edits (web, desktop, cli, ...). */
  dshProfile: { name: string; patchPath: string } | null;
  acpForm: {
    mode: 'create' | 'edit' | null;
    editingId: string | null;
    values: AcpFormData;
    original: AcpFormData | null;
    errors: AcpFormErrors;
  };
  acpConfirmDelete: { id: string | null; providerName: string | null };
  /**
   * v2.4: the ACP test dialog. Tests read the saved row only and never write,
   * so they neither use `loading` nor wait for the write lock.
   */
  acpTest: {
    id: string | null;
    providerName: string | null;
    running: 'static' | 'handshake' | null;
    result: AcpTestResponse | null;
    error: string | null;
  };
  /** v2.3: parsed import file awaiting confirmation. */
  importPreview: (SubagentImportPreview & { fileName: string }) | null;
}

// ============================================================================
// Store Implementation
// ============================================================================

type Listener = () => void;

export interface SubagentPanelStore {
  getSnapshot(): SubagentPanelState;
  subscribe(listener: Listener): () => void;

  // Actions
  load(profile?: string): Promise<void>;
  openCreate(): void;
  openEdit(id: string): void;
  setField<K extends keyof SubagentFormData>(field: K, value: SubagentFormData[K]): void;
  submit(): Promise<void>;
  move(id: string, direction: 'up' | 'down'): Promise<void>;
  requestDelete(id: string): void;
  confirmDelete(): Promise<void>;
  cancel(): void;

  /** v2.1: get capabilities for the named provider, or null if not in the list. */
  getProviderCapabilities(name: string): SubagentProviderCapabilities | null;

  // v2.3 ACP registrations
  openCreateAcp(): void;
  openEditAcp(id: string): void;
  setAcpField<K extends keyof AcpFormData>(field: K, value: AcpFormData[K]): void;
  submitAcp(): Promise<void>;
  requestDeleteAcp(id: string): void;
  confirmDeleteAcp(): Promise<void>;
  /** v2.4: open the test dialog for a saved ACP and run the static checks. */
  testAcp(id: string): Promise<void>;
  /** v2.4: start the ACP process and send `initialize` (then terminate it). */
  runAcpHandshake(): Promise<void>;
  closeAcpTest(): void;

  // v2.3 import / export (ACPs + subagent tools in one file)
  exportConfig(): void;
  importConfig(file: File): Promise<void>;
  cancelImport(): void;
  confirmImport(): Promise<void>;
}

function closedAcpForm(): SubagentPanelState['acpForm'] {
  return { mode: null, editingId: null, values: emptyAcpForm(), original: null, errors: {} };
}

const NO_ACP_DELETE = { id: null, providerName: null };
const NO_ACP_TEST: SubagentPanelState['acpTest'] = { id: null, providerName: null, running: null, result: null, error: null };

/** Old Hosts have no test route: webServer answers 404 without a structured code. */
export const ACP_TEST_UNAVAILABLE = '当前 Host 不支持 ACP 测试，重启 DSH 后可用';

type SubagentPatch = NonNullable<SubagentsMutationRequest['patch']>;

function emptyFormData(): SubagentFormData {
  return {
    toolName: '',
    provider: 'spawn',
    backgroundMode: 'continuable',
    agentOptions: { provider: '', model: '', reasoningEffort: '' },
  };
}

function closedForm(): SubagentPanelState['form'] {
  return { mode: null, editingId: null, values: emptyFormData(), original: null, errors: {} };
}

function initialState(): SubagentPanelState {
  return {
    loading: false,
    error: null,
    notice: null,
    conflict: null,
    rows: [],
    catalog: { providers: [] },
    revision: '',
    diagnostics: null,
    subagentProviders: LEGACY_PROVIDERS,
    hostApiV2: null,
    form: closedForm(),
    confirmDelete: { id: null, toolName: null },
    acps: [],
    acpSupported: null,
    dshProfile: null,
    acpForm: closedAcpForm(),
    acpConfirmDelete: NO_ACP_DELETE,
    acpTest: NO_ACP_TEST,
    importPreview: null,
  };
}

/**
 * A row may be edited/deleted only when the Host marks it editable and, on a
 * pre-v2.1 Host, its provider is spawn or fork (contract §9: ACP rows stay
 * read-only and no ACP write is sent until DSH restarts).
 */
export function isRowEditable(state: Pick<SubagentPanelState, 'hostApiV2'>, row: SubagentRow): boolean {
  if (!row.editable) return false;
  if (state.hostApiV2 === true) return true;
  const provider = String(row.config.provider ?? '');
  return LEGACY_PROVIDERS.some((p) => p.name === provider);
}

/** Reason shown for a read-only row (button title and openEdit/requestDelete error). */
export function rowReadOnlyReason(state: Pick<SubagentPanelState, 'hostApiV2'>, row: SubagentRow): string {
  if (row.readOnlyReason) return row.readOnlyReason;
  const provider = String(row.config.provider ?? '');
  if (state.hostApiV2 === true) return MSG.providerUnregistered(provider);
  // Pre-v2.1 Host: its own READ_ONLY wording, or the restart notice for rows it
  // would still accept but this client will not write.
  return row.editable ? MSG.hostApiUpgradeRequired : MSG.readOnly;
}

/**
 * Validate form data (contract §6 Client validateForm): provider must be in
 * the list; the cascade fields are required exactly when the cascade shows.
 */
function validateForm(
  values: SubagentFormData,
  mode: FormMode,
  rows: SubagentRow[],
  editingId: string | null,
  providers: readonly SubagentProviderInfo[],
): SubagentFormErrors {
  const errors: SubagentFormErrors = {};

  if (!values.toolName) {
    errors.toolName = MSG.toolNameRequired;
  } else if (!/^subagent(_[a-z0-9]+)*$/.test(values.toolName)) {
    errors.toolName = MSG.toolNameFormat(values.toolName);
  } else {
    const duplicate = rows.find(
      (row) => row.config.toolName === values.toolName && (mode === 'create' || row.id !== editingId),
    );
    if (duplicate) errors.toolName = MSG.toolNameDuplicate(values.toolName);
  }

  if (!providers.some((p) => p.name === values.provider)) {
    errors.provider = MSG.providerNotInList(values.provider);
  }

  if (!suppressAgentOptions(values.provider, capsOf(providers, values.provider))) {
    if (!values.agentOptions.provider.trim()) {
      errors.agentOptions = errors.agentOptions ?? {};
      errors.agentOptions.provider = MSG.agentProviderRequired;
    }
    if (!values.agentOptions.model.trim()) {
      errors.agentOptions = errors.agentOptions ?? {};
      errors.agentOptions.model = MSG.agentModelRequired;
    }
  }

  return errors;
}

/**
 * v2.1 update patch for an edited row (contract §4, §6), decided by
 * capabilities, never by provider name except through suppressAgentOptions:
 * - target suppresses agentOptions (fork, or agentOptions === false): no agentOptions;
 * - original could not carry agentOptions but the target can (ACP/fork →
 *   spawn or any agentOptions provider): the complete block;
 * - both can: only the changed keys; a cleared reasoningEffort is `null`;
 * - backgroundMode only when it differs from the opened value.
 * maxDepth / modelSelectionSettings / persona / toolFilter are never sent.
 */
export function diffSubagentPatch(
  original: SubagentFormData,
  values: SubagentFormData,
  providers: readonly SubagentProviderInfo[] = LEGACY_PROVIDERS,
): SubagentPatch {
  const patch: SubagentPatch = {};
  const toolName = values.toolName.trim();
  if (toolName !== original.toolName) patch.toolName = toolName;
  if (values.provider !== original.provider) patch.provider = values.provider as any;
  if (values.backgroundMode !== original.backgroundMode) patch.backgroundMode = values.backgroundMode;

  if (suppressAgentOptions(values.provider, capsOf(providers, values.provider))) return patch;

  const current = {
    provider: values.agentOptions.provider.trim(),
    model: values.agentOptions.model.trim(),
    reasoningEffort: values.agentOptions.reasoningEffort.trim(),
  };

  if (suppressAgentOptions(original.provider, capsOf(providers, original.provider))) {
    // The row has no agentOptions yet: send a complete block.
    patch.agentOptions = { provider: current.provider, model: current.model };
    if (current.reasoningEffort) patch.agentOptions.reasoningEffort = current.reasoningEffort;
    return patch;
  }

  // Both sides take agentOptions: diff only changed keys
  const options: NonNullable<SubagentPatch['agentOptions']> = {};
  if (current.provider !== original.agentOptions.provider) options.provider = current.provider;
  if (current.model !== original.agentOptions.model) options.model = current.model;
  if (current.reasoningEffort !== original.agentOptions.reasoningEffort) {
    options.reasoningEffort = current.reasoningEffort === '' ? null : current.reasoningEffort;
  }
  if (Object.keys(options).length > 0) patch.agentOptions = options;
  return patch;
}

export function createSubagentStore(api: ApiClient): SubagentPanelStore {
  let state = initialState();
  const listeners = new Set<Listener>();
  let currentProfile = DEFAULT_TEAM_PROFILE;
  let requestSeq = 0;

  function notify() { listeners.forEach((l) => l()); }

  function setState(partial: Partial<SubagentPanelState>) {
    state = { ...state, ...partial };
    notify();
  }

  function setFormValues(partial: Partial<SubagentFormData>) {
    state = { ...state, form: { ...state.form, values: { ...state.form.values, ...partial } } };
    notify();
  }

  function setFormErrors(errors: SubagentFormErrors) {
    state = { ...state, form: { ...state.form, errors } };
    notify();
  }

  function writeBlocked(): boolean {
    if (!isWriteBlocked(state.diagnostics)) return false;
    setState({ error: WRITE_UNAVAILABLE_MESSAGE });
    return true;
  }

  function fromResponse(response: StateResponse): Partial<SubagentPanelState> {
    // Contract §9: only a v2.1 Host (hostApi === 2) supplies the provider list;
    // anything else keeps the spawn/fork drop-down and ACP rows read-only.
    const hostApiV2 = response.diagnostics?.hostApi === 2;
    const subagentProviders = hostApiV2 ? (response.subagentProviders ?? LEGACY_PROVIDERS) : LEGACY_PROVIDERS;
    return {
      rows: response.subagents,
      catalog: response.catalog,
      revision: response.revision,
      diagnostics: response.diagnostics ?? state.diagnostics,
      subagentProviders,
      hostApiV2,
      acps: response.acps ?? [],
      acpSupported: Array.isArray(response.acps),
      dshProfile: response.dshProfile ?? null,
    };
  }

  /** Close every dialog (a write or conflict refresh makes them stale). */
  const CLOSED_DIALOGS = () => ({
    form: closedForm(),
    confirmDelete: { id: null, toolName: null },
    acpForm: closedAcpForm(),
    acpConfirmDelete: NO_ACP_DELETE,
    acpTest: NO_ACP_TEST,
  });

  /** Bumped on every test start/close so a late answer never lands on another dialog. */
  let testSeq = 0;

  async function runTest(id: string, handshake: boolean) {
    const seq = ++testSeq;
    const providerName = state.acps.find((a) => a.id === id)?.config.providerName ?? id;
    state = { ...state, acpTest: { id, providerName, running: handshake ? 'handshake' : 'static', result: handshake ? state.acpTest.result : null, error: null } };
    notify();
    try {
      const result = await api.testAcp({ id, handshake });
      if (seq !== testSeq) return;
      setState({ acpTest: { id, providerName, running: null, result, error: null } });
    } catch (err: any) {
      if (seq !== testSeq) return;
      const error = err.status === 404 && !err.code ? ACP_TEST_UNAVAILABLE : err.message || '测试失败';
      setState({ acpTest: { ...state.acpTest, running: null, error } });
    }
  }

  function setAcpErrors(errors: AcpFormErrors) {
    state = { ...state, acpForm: { ...state.acpForm, errors } };
    notify();
  }

  /** One locked write through `send`; STALE_REVISION refreshes and closes dialogs. */
  async function write(send: () => Promise<StateResponse & { notice?: string }>, onDone: Partial<SubagentPanelState>, failure: string) {
    if (writeBlocked()) return null;
    requestSeq++;
    setState({ loading: true, error: null, conflict: null });
    try {
      const response = await send();
      requestSeq++;
      setState({ loading: false, ...fromResponse(response), notice: response.notice ?? null, ...onDone });
      return response;
    } catch (err: any) {
      if (err.code === 'STALE_REVISION') await refreshAfterConflict(err.message, { ...CLOSED_DIALOGS(), importPreview: null });
      else setState({ loading: false, error: err.message || failure });
      return null;
    }
  }

  async function guardedRead(): Promise<StateResponse | null> {
    const seq = ++requestSeq;
    const profile = currentProfile;
    const response = await api.getState(profile);
    return seq === requestSeq && profile === currentProfile ? response : null;
  }

  async function refreshAfterConflict(message: string, extra: Partial<SubagentPanelState> = {}) {
    setState({ loading: true, conflict: message, ...extra });
    const seq = requestSeq + 1;
    try {
      const refreshed = await guardedRead();
      if (refreshed) setState({ ...fromResponse(refreshed), loading: false });
    } catch {
      if (seq === requestSeq) setState({ loading: false });
    }
  }

  return {
    getSnapshot() { return state; },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    getProviderCapabilities(name: string): SubagentProviderCapabilities | null {
      return capsOf(state.subagentProviders, name);
    },

    async load(profile?: string) {
      if (profile !== undefined) currentProfile = profile;
      setState({ loading: true, error: null, conflict: null, notice: null });
      const seq = requestSeq + 1;
      try {
        const response = await guardedRead();
        if (!response) return;
        setState({
          loading: false,
          ...fromResponse(response),
          diagnostics: response.diagnostics ?? null,
          error: response.errors.subagents || null,
          notice: response.notice ?? null,
        });
      } catch (err: any) {
        if (seq !== requestSeq) return;
        setState({ loading: false, error: err.message || MSG.loadSubagentsFailed });
      }
    },

    openCreate() {
      // Contract §3: no hard-coded spawn; the first listed provider is the default.
      const provider = state.subagentProviders[0]?.name ?? '';
      const values: SubagentFormData = {
        ...emptyFormData(),
        provider,
        backgroundMode: supportsContinuable(capsOf(state.subagentProviders, provider)) ? 'continuable' : 'one-shot',
      };
      state = { ...state, form: { ...closedForm(), mode: 'create', values }, error: null, conflict: null, notice: null };
      notify();
    },

    openEdit(id: string) {
      const row = state.rows.find((r) => r.id === id);
      if (!row) { setState({ error: MSG.subagentNotFound(id) }); return; }
      if (!isRowEditable(state, row)) {
        setState({ error: rowReadOnlyReason(state, row) });
        return;
      }
      const config = row.config as any;
      const values: SubagentFormData = {
        toolName: config.toolName || '',
        provider: config.provider || 'spawn',
        // Missing key mounts as one-shot (dsh-tool-subagent: backgroundMode ?? 'one-shot').
        backgroundMode: config.backgroundMode || 'one-shot',
        agentOptions: {
          provider: config.agentOptions?.provider || '',
          model: config.agentOptions?.model || '',
          reasoningEffort: config.agentOptions?.reasoningEffort || '',
        },
      };
      state = {
        ...state,
        form: { mode: 'edit', editingId: id, values, original: { ...values, agentOptions: { ...values.agentOptions } }, errors: {} },
        error: null, conflict: null, notice: null,
      };
      notify();
    },

    setField(field, value) {
      if (field === 'provider') {
        // Contract §3: switching into a continuable provider defaults Background
        // Mode to continuable; switching into a non-continuable one forces one-shot.
        const list = state.subagentProviders;
        const wasContinuable = supportsContinuable(capsOf(list, state.form.values.provider));
        const isContinuable = supportsContinuable(capsOf(list, value as string));
        let backgroundMode = state.form.values.backgroundMode;
        if (!isContinuable) backgroundMode = 'one-shot';
        else if (!wasContinuable) backgroundMode = 'continuable';
        setFormValues({ provider: value as string, backgroundMode });
      } else {
        setFormValues({ [field]: value });
      }
      const errors = { ...state.form.errors };
      if (field in errors) { delete errors[field as keyof SubagentFormErrors]; setFormErrors(errors); }
    },

    async submit() {
      const { mode, values, editingId, original } = state.form;
      if (!mode) return;

      const caps = capsOf(state.subagentProviders, values.provider);
      const noAgentOpts = suppressAgentOptions(values.provider, caps);
      // Same predicate the panel renders with: not continuable → one-shot.
      const effectiveBgMode: 'continuable' | 'one-shot' = supportsContinuable(caps) ? values.backgroundMode : 'one-shot';

      const errors = validateForm(values, mode, state.rows, editingId, state.subagentProviders);
      if (Object.keys(errors).length > 0) { setFormErrors(errors); return; }

      let request: SubagentsMutationRequest;
      if (mode === 'create') {
        request = {
          expectedRevision: state.revision,
          action: 'create',
          input: {
            toolName: values.toolName,
            provider: values.provider as any,
            backgroundMode: effectiveBgMode,
            agentOptions: noAgentOpts ? undefined : {
              provider: values.agentOptions.provider,
              model: values.agentOptions.model,
              reasoningEffort: values.agentOptions.reasoningEffort || undefined,
            },
          },
        };
      } else {
        const effectiveValues = effectiveBgMode !== values.backgroundMode
          ? { ...values, backgroundMode: effectiveBgMode }
          : values;
        const patch = diffSubagentPatch(original ?? emptyFormData(), effectiveValues, state.subagentProviders);
        if (Object.keys(patch).length === 0) {
          setState({ form: closedForm(), error: null, conflict: null, notice: MSG.noChanges });
          return;
        }
        request = { expectedRevision: state.revision, action: 'update', id: editingId!, patch };
      }

      if (writeBlocked()) return;
      requestSeq++;
      setState({ loading: true, error: null, conflict: null });

      try {
        const response = await api.mutateSubagents(request);
        requestSeq++;
        setState({ loading: false, ...fromResponse(response), notice: response.notice, form: closedForm() });
      } catch (err: any) {
        if (err.code === 'STALE_REVISION') await refreshAfterConflict(err.message);
        else setState({ loading: false, error: err.message || MSG.saveFailed });
      }
    },

    async move(id: string, direction: 'up' | 'down'): Promise<void> {
      if (writeBlocked()) return;
      if (state.hostApiV2 !== true) {
        setState({ error: '上移和下移需要重启 DSH 后生效' });
        return;
      }

      const index = state.rows.findIndex((row) => row.id === id);
      if (index < 0) {
        setState({ error: MSG.subagentNotFound(id) });
        return;
      }
      if ((direction === 'up' && index === 0) || (direction === 'down' && index === state.rows.length - 1)) return;

      requestSeq++;
      setState({ loading: true, error: null, conflict: null });
      try {
        const response = await api.mutateSubagents({ expectedRevision: state.revision, action: 'move', id, direction });
        requestSeq++;
        setState({ loading: false, ...fromResponse(response), notice: response.notice, form: closedForm() });
      } catch (err: any) {
        if (err.code === 'STALE_REVISION') await refreshAfterConflict(err.message);
        else {
          const oldHostMoveError = err.status === 400
            && typeof err.message === 'string'
            && err.message.includes('字段 action 必须是');
          setState({
            loading: false,
            error: oldHostMoveError ? '上移和下移需要重启 DSH 后生效' : (err.message || '移动失败'),
          });
        }
      }
    },

    requestDelete(id: string) {
      const row = state.rows.find((r) => r.id === id);
      if (!row) { setState({ error: MSG.subagentNotFound(id) }); return; }
      if (!isRowEditable(state, row)) { setState({ error: rowReadOnlyReason(state, row) }); return; }
      state = { ...state, confirmDelete: { id, toolName: (row.config as any).toolName || id }, error: null, conflict: null, notice: null };
      notify();
    },

    async confirmDelete() {
      const { id } = state.confirmDelete;
      if (!id) return;
      if (writeBlocked()) return;
      requestSeq++;
      setState({ loading: true, error: null, conflict: null });
      try {
        const response = await api.mutateSubagents({ expectedRevision: state.revision, action: 'remove', id });
        requestSeq++;
        setState({ loading: false, ...fromResponse(response), notice: response.notice, confirmDelete: { id: null, toolName: null } });
      } catch (err: any) {
        if (err.code === 'STALE_REVISION') await refreshAfterConflict(err.message, { confirmDelete: { id: null, toolName: null } });
        else setState({ loading: false, error: err.message || MSG.deleteFailed });
      }
    },

    cancel() {
      testSeq++;
      state = { ...state, ...CLOSED_DIALOGS(), importPreview: null, error: null, conflict: null, notice: null };
      notify();
    },

    // ------------------------------------------------------------------------
    // v2.3 ACP registrations
    // ------------------------------------------------------------------------

    openCreateAcp() {
      state = { ...state, ...CLOSED_DIALOGS(), acpForm: { ...closedAcpForm(), mode: 'create' }, error: null, conflict: null, notice: null };
      notify();
    },

    openEditAcp(id: string) {
      const row = state.acps.find((a) => a.id === id);
      if (!row) { setState({ error: `未找到 ACP '${id}'` }); return; }
      const values = acpFormFromRow(row);
      state = {
        ...state,
        ...CLOSED_DIALOGS(),
        acpForm: { mode: 'edit', editingId: id, values, original: { ...values }, errors: {} },
        error: null, conflict: null, notice: null,
      };
      notify();
    },

    setAcpField(field, value) {
      const errors = { ...state.acpForm.errors };
      delete errors[field];
      state = { ...state, acpForm: { ...state.acpForm, values: { ...state.acpForm.values, [field]: value }, errors } };
      notify();
    },

    async submitAcp() {
      const { mode, values, original, editingId } = state.acpForm;
      if (!mode) return;
      const errors = validateAcpForm(values, mode, state.acps);
      if (Object.keys(errors).length > 0) { setAcpErrors(errors); return; }

      let request: AcpsMutationRequest;
      if (mode === 'create') {
        request = { expectedRevision: state.revision, action: 'create', input: acpConfigFromForm(values) };
      } else {
        const patch = diffAcpPatch(original ?? values, values);
        if (Object.keys(patch).length === 0) {
          setState({ acpForm: closedAcpForm(), error: null, conflict: null, notice: MSG.noChanges });
          return;
        }
        request = { expectedRevision: state.revision, action: 'update', id: editingId!, patch };
      }
      await write(() => api.mutateAcps(request), { acpForm: closedAcpForm() }, MSG.saveFailed);
    },

    requestDeleteAcp(id: string) {
      const row = state.acps.find((a) => a.id === id);
      if (!row) { setState({ error: `未找到 ACP '${id}'` }); return; }
      if (row.usedBy.length > 0) {
        // Same rule the Host enforces with 409 IN_USE.
        setState({ error: `ACP '${row.config.providerName}' 仍被 subagent 工具使用：${row.usedBy.join('、')}。请先删除或改用其他 provider` });
        return;
      }
      state = { ...state, ...CLOSED_DIALOGS(), acpConfirmDelete: { id, providerName: row.config.providerName }, error: null, conflict: null, notice: null };
      notify();
    },

    async confirmDeleteAcp() {
      const { id } = state.acpConfirmDelete;
      if (!id) return;
      await write(
        () => api.mutateAcps({ expectedRevision: state.revision, action: 'remove', id }),
        { acpConfirmDelete: NO_ACP_DELETE },
        MSG.deleteFailed,
      );
    },

    async testAcp(id: string) {
      if (!state.acps.some((a) => a.id === id)) { setState({ error: `未找到 ACP '${id}'` }); return; }
      state = { ...state, ...CLOSED_DIALOGS(), error: null, conflict: null, notice: null };
      await runTest(id, false);
    },

    async runAcpHandshake() {
      const { id, running } = state.acpTest;
      if (!id || running) return;
      await runTest(id, true);
    },

    closeAcpTest() {
      testSeq++;
      setState({ acpTest: NO_ACP_TEST });
    },

    // ------------------------------------------------------------------------
    // v2.3 import / export
    // ------------------------------------------------------------------------

    exportConfig() {
      try {
        const profile = state.dshProfile?.name;
        downloadYaml(subagentExportFilename(profile), exportSubagentBundle(state.acps, state.rows, profile));
        setState({ error: null, notice: '已导出。文件含 ACP 的 env 与本机路径，分享前请检查' });
      } catch (err: any) {
        setState({ error: `导出失败：${err.message}` });
      }
    },

    async importConfig(file: File) {
      setState({ error: null, conflict: null, notice: null });
      try {
        const bundle = parseSubagentBundle(await readImportFile(file));
        const preview = previewSubagentImport(bundle, {
          acps: state.acps,
          rows: state.rows,
          providers: state.subagentProviders.map((p) => p.name),
        });
        state = { ...state, ...CLOSED_DIALOGS(), importPreview: { ...preview, fileName: file.name } };
        notify();
      } catch (err: any) {
        setState({ error: `无法导入 ${file.name}：${err.message}` });
      }
    },

    cancelImport() {
      setState({ importPreview: null });
    },

    async confirmImport() {
      const preview = state.importPreview;
      if (!preview) return;
      const bundle = importableBundle(preview);
      if (bundle.acps.length === 0 && bundle.subagents.length === 0) { setState({ importPreview: null }); return; }
      const response = await write(
        () => api.importSubagentBundle({ expectedRevision: state.revision, bundle }),
        { importPreview: null },
        '导入失败',
      );
      const report = (response as { importReport?: { created: { acps: string[]; subagents: string[] }; skipped: Array<{ name: string; reason: string }> } } | null)?.importReport;
      if (!report) return;
      const summary = `已导入 ${report.created.acps.length} 个 ACP、${report.created.subagents.length} 个 subagent 工具`;
      const skipped = report.skipped.map((s) => `${s.name}：${s.reason}`);
      setState({
        notice: `${summary}。${response!.notice ?? ''}`,
        error: skipped.length > 0 ? `服务端跳过 ${skipped.length} 项：${skipped.join('；')}` : null,
      });
    },
  };
}
