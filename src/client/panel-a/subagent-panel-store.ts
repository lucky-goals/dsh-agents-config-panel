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
  requestDelete(id: string): void;
  confirmDelete(): Promise<void>;
  cancel(): void;

  /** v2.1: get capabilities for the named provider, or null if not in the list. */
  getProviderCapabilities(name: string): SubagentProviderCapabilities | null;
}

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
    };
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
      state = { ...state, form: closedForm(), confirmDelete: { id: null, toolName: null }, error: null, conflict: null, notice: null };
      notify();
    },
  };
}
