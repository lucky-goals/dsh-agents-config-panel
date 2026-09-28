/**
 * Framework-agnostic store for Panel B (Agent-Teams members management)
 * 
 * Provides getSnapshot/subscribe pattern for React's useSyncExternalStore.
 * No Vue dependencies.
 */

import type { ApiClient } from '../shared/api-client';
import type {
  TeamMember,
  MemberPatch,
  MembersMutationRequest,
  ModelCatalog,
  StateDiagnostics,
  StateResponse,
} from '../shared/api-types';
import {
  DEFAULT_TEAM_PROFILE,
  WRITE_UNAVAILABLE_MESSAGE,
  isWriteBlocked,
  pickTeamProfile,
} from '../ui/host-state';
import { MSG } from '../ui/messages';

// ============================================================================
// State Types
// ============================================================================

export interface MemberFormData {
  name: string;
  role: string;
  provider: string;
  model: string;
  reasoning_effort: string;
}

export interface MemberFormErrors {
  name?: string;
  role?: string;
  provider?: string;
  model?: string;
  reasoning_effort?: string;
}

export type FormMode = 'add' | 'edit' | null;

export interface MembersPanelState {
  loading: boolean;
  error: string | null;
  notice: string | null;
  conflict: string | null;
  members: TeamMember[];
  catalog: ModelCatalog;
  revision: string;
  /** Currently selected agent-teams team profile (not the DSH profile directory). */
  profile: string;
  /** Team profiles declared in the patch, as reported by GET state. */
  teamProfiles: string[];
  diagnostics: StateDiagnostics | null;
  form: {
    mode: FormMode;
    editingName: string | null;
    values: MemberFormData;
    /** Values the edit form opened with; the update patch is diffed against them. */
    original: MemberFormData | null;
    errors: MemberFormErrors;
  };
  confirmDelete: {
    name: string | null;
  };
}

// ============================================================================
// Store Implementation
// ============================================================================

type Listener = () => void;

export interface MembersPanelStore {
  getSnapshot(): MembersPanelState;
  subscribe(listener: Listener): () => void;
  
  // Actions
  /**
   * Load state. Without an argument keeps the current selection (initially
   * standard-acp). If the requested profile is not in teamProfiles, the store
   * falls back to standard-acp or the first listed profile and refetches.
   */
  load(profile?: string): Promise<void>;
  /** Switch the selected team profile and reload its members. */
  setProfile(profile: string): Promise<void>;
  openCreate(): void;
  openEdit(name: string): void;
  setField<K extends keyof MemberFormData>(field: K, value: MemberFormData[K]): void;
  submit(): Promise<void>;
  requestDelete(name: string): void;
  confirmDelete(): Promise<void>;
  cancel(): void;
}

function emptyFormData(): MemberFormData {
  return {
    name: '',
    role: '',
    provider: '',
    model: '',
    reasoning_effort: '',
  };
}

function closedForm(): MembersPanelState['form'] {
  return { mode: null, editingName: null, values: emptyFormData(), original: null, errors: {} };
}

function initialState(profile: string): MembersPanelState {
  return {
    loading: false,
    error: null,
    notice: null,
    conflict: null,
    members: [],
    catalog: { providers: [] },
    revision: '',
    profile,
    teamProfiles: [],
    diagnostics: null,
    form: closedForm(),
    confirmDelete: {
      name: null,
    },
  };
}

/**
 * Validate form data according to requirements.md Section B
 */
function validateForm(
  values: MemberFormData,
  mode: FormMode,
  members: TeamMember[],
  editingName: string | null,
): MemberFormErrors {
  const errors: MemberFormErrors = {};

  // name: match ^[a-z][a-z0-9-]*$ and unique
  if (!values.name) {
    errors.name = MSG.memberNameRequired;
  } else if (!/^[a-z][a-z0-9-]*$/.test(values.name)) {
    errors.name = MSG.memberNameFormat(values.name);
  } else {
    // Check uniqueness
    const duplicate = members.find(
      (member) =>
        member.name === values.name &&
        (mode === 'add' || member.name !== editingName),
    );
    if (duplicate) {
      errors.name = MSG.memberDuplicate(values.name);
    }
  }

  // provider and model: both or neither
  const hasProvider = values.provider.trim() !== '';
  const hasModel = values.model.trim() !== '';
  if (hasProvider && !hasModel) {
    errors.model = MSG.memberRouteBothOrNeither;
  }
  if (!hasProvider && hasModel) {
    errors.provider = MSG.memberRouteBothOrNeither;
  }

  return errors;
}

const OPTIONAL_MEMBER_FIELDS = ['role', 'provider', 'model', 'reasoning_effort'] as const;

/**
 * Update patch for an edited member: only fields that differ from the values
 * the form opened with. An optional field that had a value and is now empty
 * becomes `null` so the Host deletes the key. Returns `{}` when nothing
 * changed.
 */
export function diffMemberPatch(original: MemberFormData, values: MemberFormData): MemberPatch {
  const patch: MemberPatch = {};
  const name = values.name.trim();
  if (name !== original.name) patch.name = name;
  for (const field of OPTIONAL_MEMBER_FIELDS) {
    const before = original[field].trim();
    const after = values[field].trim();
    if (after === before) continue;
    patch[field] = after === '' ? null : after;
  }
  return patch;
}

export function createMembersStore(api: ApiClient, defaultProfile = DEFAULT_TEAM_PROFILE): MembersPanelStore {
  let state = initialState(defaultProfile);
  const listeners = new Set<Listener>();
  /**
   * Monotonic request sequence. Every load/refresh records the value it was
   * issued with plus the team profile at that moment; a response is applied
   * only if both are still current, so a slow response for profile A cannot
   * repaint the panel after the user switched to B. Mutations bump it so reads
   * issued before a write cannot overwrite the write's result.
   */
  let requestSeq = 0;

  function notify() {
    listeners.forEach((listener) => listener());
  }

  function setState(partial: Partial<MembersPanelState>) {
    state = { ...state, ...partial };
    notify();
  }

  function setFormValues(partial: Partial<MemberFormData>) {
    state = {
      ...state,
      form: {
        ...state.form,
        values: { ...state.form.values, ...partial },
      },
    };
    notify();
  }

  function setFormErrors(errors: MemberFormErrors) {
    state = {
      ...state,
      form: {
        ...state.form,
        errors,
      },
    };
    notify();
  }

  /** Fields every state/mutation response refreshes. */
  function fromResponse(response: StateResponse): Partial<MembersPanelState> {
    return {
      members: response.members,
      catalog: response.catalog,
      revision: response.revision,
      profile: response.profile ?? state.profile,
      teamProfiles: response.teamProfiles ?? state.teamProfiles,
      diagnostics: response.diagnostics ?? null,
    };
  }

  /**
   * Fetch state for `requested`; when the Host reports team profiles that do
   * not include it, refetch once with pickTeamProfile's choice.
   */
  async function fetchState(requested: string): Promise<StateResponse> {
    const first = await api.getState(requested);
    const picked = pickTeamProfile(first.teamProfiles ?? [], requested);
    if (picked === null || picked === requested) return first;
    return api.getState(picked);
  }

  /**
   * Guarded read for `requested`. Resolves to null when a newer request was
   * issued meanwhile or the selected profile changed away from `requested`.
   */
  async function guardedRead(requested: string): Promise<StateResponse | null> {
    const seq = ++requestSeq;
    const response = await fetchState(requested);
    return seq === requestSeq && state.profile === requested ? response : null;
  }

  /**
   * After a 409: keep `loading` true (the profile picker stays disabled)
   * until the refreshed members land.
   */
  async function refreshAfterConflict(message: string, extra: Partial<MembersPanelState> = {}) {
    setState({ loading: true, conflict: message, ...extra });
    const seq = requestSeq + 1;
    try {
      const refreshed = await guardedRead(state.profile);
      if (refreshed) setState({ ...fromResponse(refreshed), loading: false });
    } catch {
      // Refresh failed; the conflict message is already shown.
      if (seq === requestSeq) setState({ loading: false });
    }
  }

  function writeBlocked(): boolean {
    if (!isWriteBlocked(state.diagnostics)) return false;
    setState({ error: WRITE_UNAVAILABLE_MESSAGE });
    return true;
  }

  async function mutate(request: MembersMutationRequest, onSuccess: Partial<MembersPanelState>, failure: string) {
    // Supersede any in-flight read issued before this write.
    requestSeq++;
    setState({ loading: true, error: null, conflict: null });
    try {
      const response = await api.mutateMembers(request);
      requestSeq++; // the write result is authoritative over older reads
      setState({ loading: false, ...fromResponse(response), notice: response.notice, ...onSuccess });
    } catch (err: any) {
      if (err.code === 'STALE_REVISION') {
        await refreshAfterConflict(err.message, request.action === 'remove' ? { confirmDelete: { name: null } } : {});
      } else {
        setState({ loading: false, error: err.message || failure });
      }
    }
  }

  const store: MembersPanelStore = {
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
      const requested = profile ?? state.profile;
      setState({ loading: true, error: null, conflict: null, notice: null, profile: requested });
      const seq = requestSeq + 1;

      try {
        const response = await guardedRead(requested);
        if (!response) return; // a newer request or profile owns the state now
        setState({
          loading: false,
          ...fromResponse(response),
          error: response.errors.members || null,
        });
      } catch (err: any) {
        if (seq !== requestSeq || state.profile !== requested) return;
        setState({
          loading: false,
          error: err.message || MSG.loadMembersFailed,
        });
      }
    },

    async setProfile(profile: string) {
      // Drop any open form/confirmation: it belonged to the previous profile.
      state = {
        ...state,
        form: closedForm(),
        confirmDelete: { name: null },
      };
      await store.load(profile);
    },

    openCreate() {
      state = {
        ...state,
        form: { ...closedForm(), mode: 'add' },
        error: null,
        conflict: null,
        notice: null,
      };
      notify();
    },

    openEdit(name: string) {
      const member = state.members.find((m) => m.name === name);
      if (!member) {
        setState({ error: MSG.memberNotFound(name) });
        return;
      }

      const values: MemberFormData = {
        name: member.name,
        role: member.role || '',
        provider: member.provider || '',
        model: member.model || '',
        reasoning_effort: member.reasoning_effort || '',
      };
      state = {
        ...state,
        form: {
          mode: 'edit',
          editingName: name,
          values,
          original: { ...values },
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
        delete errors[field as keyof MemberFormErrors];
        setFormErrors(errors);
      }
    },

    async submit() {
      const { mode, values, editingName, original } = state.form;
      if (!mode) return;

      // Client-side validation
      const errors = validateForm(values, mode, state.members, editingName);
      if (Object.keys(errors).length > 0) {
        setFormErrors(errors);
        return;
      }

      let request: MembersMutationRequest;
      if (mode === 'add') {
        // New member: send only filled fields.
        const member: TeamMember = { name: values.name.trim() };
        for (const field of OPTIONAL_MEMBER_FIELDS) {
          const value = values[field].trim();
          if (value) member[field] = value;
        }
        request = { expectedRevision: state.revision, profile: state.profile, action: 'add', member };
      } else {
        const patch = diffMemberPatch(original ?? emptyFormData(), values);
        if (Object.keys(patch).length === 0) {
          // Nothing changed: close without a request instead of a misleading "saved".
          setState({ form: closedForm(), error: null, conflict: null, notice: MSG.noChanges });
          return;
        }
        request = {
          expectedRevision: state.revision,
          profile: state.profile,
          action: 'update',
          name: editingName!,
          patch,
        };
      }

      if (writeBlocked()) return;
      await mutate(request, { form: closedForm() }, MSG.saveFailed);
    },

    requestDelete(name: string) {
      const member = state.members.find((m) => m.name === name);
      if (!member) {
        setState({ error: MSG.memberNotFound(name) });
        return;
      }

      // LAST_MEMBER check
      if (state.members.length <= 1) {
        setState({ error: MSG.lastMember });
        return;
      }

      state = {
        ...state,
        confirmDelete: {
          name,
        },
        error: null,
        conflict: null,
        notice: null,
      };
      notify();
    },

    async confirmDelete() {
      const { name } = state.confirmDelete;
      if (!name) return;

      // Double-check LAST_MEMBER
      if (state.members.length <= 1) {
        setState({
          error: MSG.lastMember,
          confirmDelete: { name: null },
        });
        return;
      }

      if (writeBlocked()) return;
      await mutate(
        { expectedRevision: state.revision, profile: state.profile, action: 'remove', name },
        { confirmDelete: { name: null } },
        MSG.deleteFailed,
      );
    },

    cancel() {
      state = {
        ...state,
        form: closedForm(),
        confirmDelete: { name: null },
        error: null,
        conflict: null,
        notice: null,
      };
      notify();
    },
  };
  return store;
}
