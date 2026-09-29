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
import {
  downloadYaml,
  exportTeams,
  parseTeamsFile,
  previewTeamsImport,
  readImportFile,
  teamsExportFilename,
  teamsImportRequest,
  type TeamPreview,
} from '../shared/import-export';

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
  /**
   * v2.8: a write (or the refresh after its 409) is in flight. Only this locks
   * the team picker; a plain load / team switch does not, so switching keeps
   * focus on the picker and the last choice wins (stale reads are dropped).
   */
  writing: boolean;
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
  /**
   * v2.6: parsed team file awaiting confirmation. Covers every team in the
   * file; an existing team is replaced only if its name is in `overwrite`.
   */
  teamImport: {
    fileName: string;
    sourceProfile?: string;
    /** Revision the preview was computed against; the import sends it. */
    revision: string;
    teams: TeamPreview[];
    overwrite: ReadonlySet<string>;
  } | null;
  /** v2.6: new / clone team dialog. `from` '' = a new blank team. */
  teamCreate: {
    open: boolean;
    name: string;
    from: string;
    description: string;
    firstMember: string;
    errors: Partial<Record<'name' | 'firstMember', string>>;
  };
  /** v2.7: delete-team dialog; `name` null = closed. */
  teamDelete: { name: string | null; confirm: string; error: string | null };
}

/** The word typed to confirm a team deletion (the Host checks it too). */
export const TEAM_DELETE_CONFIRMATION = 'thinktwice';
export const LAST_TEAM_MESSAGE = '至少需要保留一个团队 profile，不能删除最后一个团队';
const NO_TEAM_DELETE: MembersPanelState['teamDelete'] = { name: null, confirm: '', error: null };

/** agent-teams MAX_TEAM_PROFILES. */
export const MAX_TEAM_PROFILES = 16;
const TEAM_NAME = /^[a-z0-9][a-z0-9._-]*$/;

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

  // v2.6 import / export of ALL team profiles
  exportConfig(): Promise<void>;
  importConfig(file: File): Promise<void>;
  /** Tick / untick overwriting one existing team in the import preview. */
  toggleTeamOverwrite(name: string): void;
  cancelImport(): void;
  confirmImport(): Promise<void>;

  // v2.6 new / clone team
  openCreateTeam(): void;
  setTeamField(field: 'name' | 'from' | 'description' | 'firstMember', value: string): void;
  submitTeam(): Promise<void>;
  closeCreateTeam(): void;

  // v2.7 delete the viewed team, confirmed by typing `thinktwice`
  openDeleteTeam(): void;
  setDeleteConfirm(value: string): void;
  submitDeleteTeam(): Promise<void>;
  closeDeleteTeam(): void;
}

function closedTeamCreate(): MembersPanelState['teamCreate'] {
  return { open: false, name: '', from: '', description: '', firstMember: '', errors: {} };
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
    writing: false,
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
    teamImport: null,
    teamCreate: closedTeamCreate(),
    teamDelete: NO_TEAM_DELETE,
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
    state = { ...state, ...partial, ...(partial.loading === false ? { writing: false } : {}) };
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
    setState({ loading: true, writing: true, error: null, conflict: null });
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
        teamImport: null, teamCreate: closedTeamCreate(), teamDelete: NO_TEAM_DELETE,
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
        teamImport: null, teamCreate: closedTeamCreate(), teamDelete: NO_TEAM_DELETE,
        error: null,
        conflict: null,
        notice: null,
      };
      notify();
    },

    async exportConfig() {
      try {
        const teams = await api.getTeams();
        const names = Object.keys(teams.profiles);
        const dsh = teams.dshProfile?.name;
        downloadYaml(teamsExportFilename(dsh), exportTeams(teams.profiles, dsh));
        setState({ error: null, notice: `已导出 ${names.length} 个团队：${names.join('、')}` });
      } catch (err: any) {
        setState({ error: `导出失败：${err.message}` });
      }
    },

    async importConfig(file: File) {
      setState({ error: null, conflict: null, notice: null });
      try {
        const parsed = parseTeamsFile(await readImportFile(file));
        // Conflicts are judged against every current team, not just the selected one.
        const current = await api.getTeams();
        const teams = previewTeamsImport(parsed, current.profiles, state.catalog.providers.map((p) => p.id));
        state = {
          ...state,
          form: closedForm(),
          confirmDelete: { name: null },
          teamCreate: closedTeamCreate(),
          teamImport: {
            fileName: file.name,
            ...(parsed.sourceProfile ? { sourceProfile: parsed.sourceProfile } : {}),
            revision: current.revision,
            teams,
            overwrite: new Set(),
          },
        };
        notify();
      } catch (err: any) {
        setState({ error: `无法导入 ${file.name}：${err.message}` });
      }
    },

    toggleTeamOverwrite(name: string) {
      const preview = state.teamImport;
      if (!preview || !preview.teams.some((t) => t.name === name && t.status === 'conflict')) return;
      const overwrite = new Set(preview.overwrite);
      if (overwrite.has(name)) overwrite.delete(name); else overwrite.add(name);
      setState({ teamImport: { ...preview, overwrite } });
    },

    cancelImport() {
      setState({ teamImport: null });
    },

    /** One locked write for all teams; a change made elsewhere since the preview is a 409. */
    async confirmImport() {
      const preview = state.teamImport;
      if (!preview) return;
      const body = teamsImportRequest(preview.teams, preview.overwrite, preview.revision);
      const creates = preview.teams.filter((t) => t.status === 'new').length;
      if (creates + body.overwrite.length === 0) { setState({ teamImport: null }); return; }
      if (writeBlocked()) return;

      requestSeq++;
      setState({ loading: true, writing: true, error: null, conflict: null });
      try {
        const response = await api.importTeams(body, state.profile);
        requestSeq++;
        const { created, overwritten, skipped } = response.importReport;
        const list = (items: string[]) => (items.length > 0 ? `（${items.join('、')}）` : '');
        setState({
          loading: false,
          ...fromResponse(response),
          teamImport: null,
          notice: `新增 ${created.length} 个团队${list(created)}，覆盖 ${overwritten.length} 个${list(overwritten)}，跳过 ${skipped.length} 个。新建会话后生效`,
          error: skipped.length > 0 ? `跳过：${skipped.map((s) => `${s.name}：${s.reason}`).join('；')}` : null,
        });
      } catch (err: any) {
        if (err.code === 'STALE_REVISION') await refreshAfterConflict(err.message, { teamImport: null });
        else setState({ loading: false, error: err.message || '导入失败' });
      }
    },

    openCreateTeam() {
      state = {
        ...state,
        form: closedForm(),
        confirmDelete: { name: null },
        teamImport: null,
        // Default: clone the team being viewed; the drop-down also offers a new blank team.
        teamCreate: { ...closedTeamCreate(), open: true, from: state.teamProfiles.includes(state.profile) ? state.profile : '' },
        error: null,
        conflict: null,
        notice: null,
      };
      notify();
    },

    setTeamField(field, value) {
      const errors = { ...state.teamCreate.errors };
      delete errors[field as 'name' | 'firstMember'];
      setState({ teamCreate: { ...state.teamCreate, [field]: value, errors } });
    },

    openDeleteTeam() {
      if (!state.teamProfiles.includes(state.profile)) return;
      if (state.teamProfiles.length <= 1) { setState({ error: LAST_TEAM_MESSAGE }); return; }
      state = {
        ...state,
        form: closedForm(),
        confirmDelete: { name: null },
        teamImport: null,
        teamCreate: closedTeamCreate(),
        teamDelete: { name: state.profile, confirm: '', error: null },
        error: null,
        conflict: null,
        notice: null,
      };
      notify();
    },

    setDeleteConfirm(value: string) {
      if (state.teamDelete.name === null) return;
      setState({ teamDelete: { ...state.teamDelete, confirm: value, error: null } });
    },

    closeDeleteTeam() {
      setState({ teamDelete: NO_TEAM_DELETE, error: null });
    },

    async submitDeleteTeam() {
      const { name, confirm } = state.teamDelete;
      if (name === null) return;
      // Exact word, no trimming: the point is to make the user stop and type it.
      if (confirm !== TEAM_DELETE_CONFIRMATION) {
        setState({ teamDelete: { ...state.teamDelete, error: `请输入 ${TEAM_DELETE_CONFIRMATION} 以确认删除` } });
        return;
      }
      if (writeBlocked()) return;
      requestSeq++;
      setState({ loading: true, writing: true, error: null, conflict: null });
      try {
        const response = await api.removeTeam(
          { expectedRevision: state.revision, action: 'remove', name, confirm },
          state.profile,
        );
        requestSeq++;
        setState({
          loading: false,
          ...fromResponse(response),
          teamDelete: NO_TEAM_DELETE,
          notice: `已删除团队 '${name}'。新建会话后生效`,
        });
      } catch (err: any) {
        if (err.code === 'STALE_REVISION') await refreshAfterConflict(err.message, { teamDelete: NO_TEAM_DELETE });
        else setState({ loading: false, error: err.message || MSG.deleteFailed });
      }
    },

    closeCreateTeam() {
      setState({ teamCreate: closedTeamCreate(), error: null });
    },

    async submitTeam() {
      const form = state.teamCreate;
      if (!form.open) return;
      const name = form.name.trim();
      const errors: MembersPanelState['teamCreate']['errors'] = {};
      if (!name) errors.name = '请填写团队名';
      else if (!TEAM_NAME.test(name)) errors.name = `团队名 '${name}' 格式不合法：小写字母或数字开头，只能包含小写字母、数字、.、_、-`;
      else if (state.teamProfiles.includes(name)) errors.name = `团队 '${name}' 已存在`;
      else if (state.teamProfiles.length >= MAX_TEAM_PROFILES) errors.name = `agent-teams 最多 16 个团队 profile，当前已有 ${state.teamProfiles.length} 个`;
      const cloning = form.from !== '';
      const member = form.firstMember.trim();
      if (!cloning) {
        if (!member) errors.firstMember = 'agent-teams 要求团队至少有一个成员，请填写第一个成员名';
        else if (member === 'captain') errors.firstMember = "'captain' 是 captain 保留名";
        else if (!/^[a-z][a-z0-9-]*$/.test(member)) errors.firstMember = MSG.memberNameFormat(member);
      }
      if (Object.keys(errors).length > 0) { setState({ teamCreate: { ...form, errors } }); return; }
      if (writeBlocked()) return;

      const description = form.description.trim();
      requestSeq++;
      setState({ loading: true, writing: true, error: null, conflict: null });
      try {
        const response = await api.createTeam({
          expectedRevision: state.revision,
          action: 'create',
          name,
          ...(cloning ? { from: form.from } : { firstMember: member, ...(description ? { description } : {}) }),
        });
        requestSeq++;
        setState({
          loading: false,
          ...fromResponse(response),
          teamCreate: closedTeamCreate(),
          notice: `已创建团队 '${name}'${cloning ? `（克隆自 ${form.from}）` : ''}。新建会话后生效`,
        });
      } catch (err: any) {
        if (err.code === 'STALE_REVISION') await refreshAfterConflict(err.message, { teamCreate: closedTeamCreate() });
        else setState({ loading: false, error: err.message || MSG.saveFailed });
      }
    },
  };
  return store;
}
