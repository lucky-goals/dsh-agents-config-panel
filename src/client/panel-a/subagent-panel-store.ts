/**
 * Framework-agnostic store for Panel A (Subagent management)
 * 
 * Provides getSnapshot/subscribe pattern for React's useSyncExternalStore.
 * No Vue dependencies.
 */

import type { ApiClient } from '../shared/api-client';
import type {
  SubagentRow,
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
  provider: 'spawn' | 'fork';
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

export interface SubagentPanelState {
  loading: boolean;
  error: string | null;
  notice: string | null;
  conflict: string | null;
  rows: SubagentRow[];
  catalog: ModelCatalog;
  revision: string;
  diagnostics: StateDiagnostics | null;
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
  /**
   * Load state. Subagent rows do not depend on the team profile; the argument
   * only fills the state route's query and defaults to standard-acp.
   */
  load(profile?: string): Promise<void>;
  openCreate(): void;
  openEdit(id: string): void;
  setField<K extends keyof SubagentFormData>(field: K, value: SubagentFormData[K]): void;
  submit(): Promise<void>;
  requestDelete(id: string): void;
  confirmDelete(): Promise<void>;
  cancel(): void;
}

type SubagentPatch = NonNullable<SubagentsMutationRequest['patch']>;

function emptyFormData(): SubagentFormData {
  return {
    toolName: '',
    provider: 'spawn',
    backgroundMode: 'continuable',
    agentOptions: {
      provider: '',
      model: '',
      reasoningEffort: '',
    },
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
    form: closedForm(),
    confirmDelete: {
      id: null,
      toolName: null,
    },
  };
}

/**
 * Validate form data according to requirements.md Section B
 */
function validateForm(
  values: SubagentFormData,
  mode: FormMode,
  rows: SubagentRow[],
  editingId: string | null,
): SubagentFormErrors {
  const errors: SubagentFormErrors = {};

  // toolName: match ^subagent(_[a-z0-9]+)*$ and unique
  if (!values.toolName) {
    errors.toolName = MSG.toolNameRequired;
  } else if (!/^subagent(_[a-z0-9]+)*$/.test(values.toolName)) {
    errors.toolName = MSG.toolNameFormat(values.toolName);
  } else {
    // Check uniqueness
    const duplicate = rows.find(
      (row) =>
        row.config.toolName === values.toolName &&
        (mode === 'create' || row.id !== editingId),
    );
    if (duplicate) {
      errors.toolName = MSG.toolNameDuplicate(values.toolName);
    }
  }

  // spawn requires agentOptions.provider and .model; they cannot be cleared.
  if (values.provider === 'spawn') {
    if (!values.agentOptions.provider.trim()) {
      errors.agentOptions = errors.agentOptions || {};
      errors.agentOptions.provider = MSG.agentProviderRequired;
    }
    if (!values.agentOptions.model.trim()) {
      errors.agentOptions = errors.agentOptions || {};
      errors.agentOptions.model = MSG.agentModelRequired;
    }
  }

  return errors;
}

/**
 * Update patch for an edited row: only fields that differ from the values the
 * form opened with. A cleared reasoningEffort becomes `null` so the Host
 * deletes the key; spawn provider/model are required and never cleared here
 * (validateForm rejects that first). Returns `{}` when nothing changed.
 */
export function diffSubagentPatch(original: SubagentFormData, values: SubagentFormData): SubagentPatch {
  const patch: SubagentPatch = {};
  const toolName = values.toolName.trim();
  if (toolName !== original.toolName) patch.toolName = toolName;
  if (values.provider !== original.provider) patch.provider = values.provider;
  if (values.backgroundMode !== original.backgroundMode) patch.backgroundMode = values.backgroundMode;

  // spawn → fork: omit agentOptions; the Host drops the row's block.
  if (values.provider !== 'spawn') return patch;

  const current = {
    provider: values.agentOptions.provider.trim(),
    model: values.agentOptions.model.trim(),
    reasoningEffort: values.agentOptions.reasoningEffort.trim(),
  };

  if (original.provider !== 'spawn') {
    // fork → spawn: the row has no agentOptions yet, send a complete block.
    patch.agentOptions = { provider: current.provider, model: current.model };
    if (current.reasoningEffort) patch.agentOptions.reasoningEffort = current.reasoningEffort;
    return patch;
  }

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
  /**
   * Monotonic request sequence. Every load/refresh records the value it was
   * issued with plus the profile at that moment; a response is applied only
   * if both are still current. Mutations bump it so in-flight reads issued
   * before the write cannot overwrite the write's result.
   */
  let requestSeq = 0;

  function notify() {
    listeners.forEach((listener) => listener());
  }

  function setState(partial: Partial<SubagentPanelState>) {
    state = { ...state, ...partial };
    notify();
  }

  function setFormValues(partial: Partial<SubagentFormData>) {
    state = {
      ...state,
      form: {
        ...state.form,
        values: { ...state.form.values, ...partial },
      },
    };
    notify();
  }

  function setFormErrors(errors: SubagentFormErrors) {
    state = {
      ...state,
      form: {
        ...state.form,
        errors,
      },
    };
    notify();
  }

  function writeBlocked(): boolean {
    if (!isWriteBlocked(state.diagnostics)) return false;
    setState({ error: WRITE_UNAVAILABLE_MESSAGE });
    return true;
  }

  function fromResponse(response: StateResponse): Partial<SubagentPanelState> {
    return {
      rows: response.subagents,
      catalog: response.catalog,
      revision: response.revision,
      diagnostics: response.diagnostics ?? state.diagnostics,
    };
  }

  /** Issue a guarded state read; resolves to null when superseded. */
  async function guardedRead(): Promise<StateResponse | null> {
    const seq = ++requestSeq;
    const profile = currentProfile;
    const response = await api.getState(profile);
    return seq === requestSeq && profile === currentProfile ? response : null;
  }

  /**
   * After a 409: keep `loading` true until the refreshed rows land, so the UI
   * cannot act on the stale revision in between.
   */
  async function refreshAfterConflict(message: string, extra: Partial<SubagentPanelState> = {}) {
    setState({ loading: true, conflict: message, ...extra });
    const seq = requestSeq + 1;
    try {
      const refreshed = await guardedRead();
      if (refreshed) setState({ ...fromResponse(refreshed), loading: false });
    } catch {
      // Refresh failed; the conflict message is already shown.
      if (seq === requestSeq) setState({ loading: false });
    }
  }

  return {
    getSnapshot() {
      return state;
    },

    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async load(profile?: string) {
      if (profile !== undefined) currentProfile = profile;
      setState({ loading: true, error: null, conflict: null, notice: null });
      const seq = requestSeq + 1;

      try {
        const response = await guardedRead();
        if (!response) return; // a newer request owns the state now
        setState({
          loading: false,
          ...fromResponse(response),
          diagnostics: response.diagnostics ?? null,
          error: response.errors.subagents || null,
        });
      } catch (err: any) {
        if (seq !== requestSeq) return;
        setState({
          loading: false,
          error: err.message || MSG.loadSubagentsFailed,
        });
      }
    },

    openCreate() {
      state = {
        ...state,
        form: { ...closedForm(), mode: 'create' },
        error: null,
        conflict: null,
        notice: null,
      };
      notify();
    },

    openEdit(id: string) {
      const row = state.rows.find((r) => r.id === id);
      if (!row || !row.editable) {
        setState({ error: row ? MSG.readOnly : MSG.subagentNotFound(id) });
        return;
      }

      const config = row.config as any;
      const values: SubagentFormData = {
        toolName: config.toolName || '',
        provider: config.provider || 'spawn',
        backgroundMode: config.backgroundMode || 'continuable',
        agentOptions: {
          provider: config.agentOptions?.provider || '',
          model: config.agentOptions?.model || '',
          reasoningEffort: config.agentOptions?.reasoningEffort || '',
        },
      };
      state = {
        ...state,
        form: {
          mode: 'edit',
          editingId: id,
          values,
          original: { ...values, agentOptions: { ...values.agentOptions } },
          errors: {},
        },
        error: null,
        conflict: null,
        notice: null,
      };
      notify();
    },

    setField(field, value) {
      setFormValues({ [field]: value });
      // Clear field errors
      const errors = { ...state.form.errors };
      if (field in errors) {
        delete errors[field as keyof SubagentFormErrors];
        setFormErrors(errors);
      }
    },

    async submit() {
      const { mode, values, editingId, original } = state.form;
      if (!mode) return;

      // Client-side validation
      const errors = validateForm(values, mode, state.rows, editingId);
      if (Object.keys(errors).length > 0) {
        setFormErrors(errors);
        return;
      }

      let request: SubagentsMutationRequest;
      if (mode === 'create') {
        request = {
          expectedRevision: state.revision,
          action: 'create',
          input: {
            toolName: values.toolName,
            provider: values.provider,
            backgroundMode: values.backgroundMode,
            agentOptions:
              values.provider === 'spawn'
                ? {
                    provider: values.agentOptions.provider,
                    model: values.agentOptions.model,
                    reasoningEffort: values.agentOptions.reasoningEffort || undefined,
                  }
                : undefined,
          },
        };
      } else {
        const patch = diffSubagentPatch(original ?? emptyFormData(), values);
        if (Object.keys(patch).length === 0) {
          // Nothing changed: close without a request instead of a misleading "saved".
          setState({ form: closedForm(), error: null, conflict: null, notice: MSG.noChanges });
          return;
        }
        request = { expectedRevision: state.revision, action: 'update', id: editingId!, patch };
      }

      if (writeBlocked()) return;

      // Supersede any in-flight read issued before this write.
      requestSeq++;
      setState({ loading: true, error: null, conflict: null });

      try {
        const response = await api.mutateSubagents(request);
        requestSeq++; // the write result is authoritative over older reads
        setState({
          loading: false,
          ...fromResponse(response),
          notice: response.notice,
          form: closedForm(),
        });
      } catch (err: any) {
        if (err.code === 'STALE_REVISION') {
          await refreshAfterConflict(err.message);
        } else {
          setState({ loading: false, error: err.message || MSG.saveFailed });
        }
      }
    },

    requestDelete(id: string) {
      const row = state.rows.find((r) => r.id === id);
      if (!row) {
        setState({ error: MSG.subagentNotFound(id) });
        return;
      }
      if (!row.editable) {
        setState({ error: MSG.readOnly });
        return;
      }

      state = {
        ...state,
        confirmDelete: {
          id,
          toolName: (row.config as any).toolName || id,
        },
        error: null,
        conflict: null,
        notice: null,
      };
      notify();
    },

    async confirmDelete() {
      const { id } = state.confirmDelete;
      if (!id) return;
      if (writeBlocked()) return;

      requestSeq++;
      setState({ loading: true, error: null, conflict: null });

      try {
        const response = await api.mutateSubagents({
          expectedRevision: state.revision,
          action: 'remove',
          id,
        });
        requestSeq++;
        setState({
          loading: false,
          ...fromResponse(response),
          notice: response.notice,
          confirmDelete: { id: null, toolName: null },
        });
      } catch (err: any) {
        if (err.code === 'STALE_REVISION') {
          await refreshAfterConflict(err.message, { confirmDelete: { id: null, toolName: null } });
        } else {
          setState({ loading: false, error: err.message || MSG.deleteFailed });
        }
      }
    },

    cancel() {
      state = {
        ...state,
        form: closedForm(),
        confirmDelete: { id: null, toolName: null },
        error: null,
        conflict: null,
        notice: null,
      };
      notify();
    },
  };
}
