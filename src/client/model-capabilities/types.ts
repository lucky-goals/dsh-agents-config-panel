export const NS_PI = 'llm-pi-ai' as const;
export const NS_DS = 'llm-deepseek' as const;
export const DS_ROUTE_ID = 'deepseek-official' as const;
export const MAIN_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ADV_EFFORTS = ['off', 'minimal'] as const;
export const ALL_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const DS_EFFORTS = ['off', 'low', 'high', 'max'] as const;
export type Effort = typeof ALL_EFFORTS[number];
export type DsEffort = typeof DS_EFFORTS[number];
export type InputModality = 'text' | 'image';
export const API_OPTS = [
  { v: 'openai-completions', t: 'OpenAI Chat Completions' },
  { v: 'openai-responses', t: 'OpenAI Responses' },
  { v: 'anthropic-messages', t: 'Anthropic Messages' },
] as const;
export const CAP_PRESETS: readonly (readonly [string, number])[] = [
  ['128K', 128000],
  ['200K', 200000],
  ['272K', 272000],
  ['1M', 1000000],
];
export const CAP_FMT_ERR = '填正整数，可用 K 或 M 后缀（如 128K、1M）。';
export const LIST_DESC = '补充官方「模型」页：输入类型、思考档位、上下文窗口和最大输出，以及提供方和模型的增删改。';

export interface HeaderPair { k: string; v: string }
export type ReasoningMap = Partial<Record<Effort, string | null>>;
export type ReasoningEfforts = false | ReasoningMap;
export interface ModelDraft {
  id: string;
  name?: string;
  contextWindow?: string;
  maxTokens?: string;
  input?: InputModality[];
  inputModalities?: InputModality[];
  reasoningEfforts?: ReasoningEfforts;
  _stash?: ReasoningMap;
  extra: Record<string, unknown>;
}
export interface ProviderDraft {
  id: string;
  ns: 'llm-pi-ai' | 'llm-deepseek';
  api?: string;
  displayName?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  thinking?: 'enabled' | 'disabled';
  reasoningEffort?: string;
  headers?: HeaderPair[];
  models: ModelDraft[];
  extra: Record<string, unknown>;
  credConfigured: boolean;
  credWritable: boolean;
}
export interface DraftState { providers: Record<string, ProviderDraft> }
export interface CapSide {
  key: 'contextWindow' | 'maxTokens';
  explicit: boolean;
  raw: string;
  parsed: number | null | undefined;
}
export interface CapState { cw: CapSide; mt: CapSide }
export interface SettingsOpSet { op: 'set'; path: string[]; value: unknown }
export interface SettingsOpUnset { op: 'unset'; path: string[] }
export type SettingsOp = SettingsOpSet | SettingsOpUnset;
export interface CredOp { op: 'set' | 'unset'; ref: string }
export interface OpsResult {
  pi: SettingsOp[];
  ds: SettingsOp[];
  cred: CredOp[];
  dirty: number;
  dirtySet: ReadonlySet<string>;
}
export interface FieldErrors {
  id?: string;
  contextWindow?: string;
  maxTokens?: string;
  efforts?: string;
  apiKeyEnv?: string;
  baseURL?: string;
  secret?: string;
  headers?: string;
  [spell: `spell_${string}`]: string | undefined;
}
export interface AllErrors { [routeId: string]: { route: FieldErrors; models: FieldErrors[] } }
export interface NamespaceSlice {
  ns: string;
  value: Record<string, unknown>;
  user?: Record<string, unknown>;
  revision: number;
  writable: boolean;
  mode: 'host' | 'memory';
}
export interface BulkDraft {
  route: string;
  scope: 'sel' | 'all';
  selSnapshot: number[];
  inMode: 'none' | 'set' | 'clear';
  inArr: InputModality[];
  th: 'none' | 'set' | 'off';
  thSel: Effort[];
  cw: 'none' | 'set' | 'clear';
  cwRaw: string;
  mt: 'none' | 'set' | 'clear';
  mtRaw: string;
  copy: 'none' | 'copy';
  src: number | null;
}
export interface BulkPlan {
  pi: boolean;
  copy: boolean;
  touched: boolean;
  errs: { src?: string; th?: string; cw?: string; mt?: string };
  err: string;
  targets: number[];
  results: { i: number; next: ModelDraft }[];
  C: number;
  S: number;
  L: number;
  srcM: ModelDraft | null;
  cw: number | null;
  mt: number | null;
}
export type McView = 'list' | 'detail' | 'wizard' | 'preview';
export interface WizardDraft {
  step: 1 | 2 | 3;
  api: string;
  id: string;
  tried2: boolean;
  ack: boolean;
  displayName: string;
  baseURL: string;
  env: string;
  envTouched: boolean;
  headersOpen: boolean;
  headers: HeaderPair[];
  models: string[];
}
export type DialogState =
  | { type: 'delete'; route: string; text: string }
  | { type: 'discard' }
  | { type: 'reload' }
  | { type: 'wiz-cancel' }
  | { type: 'save-wiz' };
export interface McUi {
  view: McView;
  route: string | null;
  edit: { kind: 'model'; route: string; idx: number } | { kind: 'access'; route: string } | null;
  bulk: BulkDraft | null;
  wizard: WizardDraft | null;
  dialog: DialogState | null;
  menuIdx: number | null;
  sel: Record<string, number[]>;
  showAdv: Record<string, boolean>;
  inputHint: { key: string; text: string } | null;
  undo: { route: string; model: ModelDraft; idx: number } | null;
  saving: boolean;
  saved: boolean;
  conflict: 'hidden' | 'shown' | 'kept';
  readonly: boolean;
  loading: boolean;
  status: string;
  previewReturn: { view: McView; route: string | null } | null;
  dsPrev: string;
}
export interface McSnapshot {
  draft: DraftState;
  revision: { pi: number | null; ds: number | null };
  ops: OpsResult;
  errors: AllErrors;
  ui: McUi;
  loadError: string | null;
  saveError: string | null;
  defaultModel: { provider: string; model: string; effort: string } | null;
  hasPi: boolean;
  hasDs: boolean;
  secretSet: Record<string, boolean>;
}
export interface RemoteError { code: string; details?: unknown }
export type RemoteResult = { ok: true; value: NamespaceSlice } | { ok: false; error: RemoteError };
export type CredResult = { ok: true } | { ok: false; error: RemoteError };
export interface DescribeResult {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  writable: boolean;
  namespaces: NamespaceSlice[];
  error?: unknown;
}
export interface ModelCapabilitiesPort {
  describe(): Promise<DescribeResult>;
  hostLoopback: boolean;
  mutate(ns: string, ops: SettingsOp[], expectedRevision: number): Promise<RemoteResult>;
  credentials: {
    describe(refs: string[]): Promise<Record<string, { configured: boolean; writable: boolean }>>;
    set(ref: string, value: string): Promise<CredResult>;
    unset(ref: string): Promise<CredResult>;
  };
  on(event: 'settings/document-updated', cb: (ns: string, revision: number) => void): () => void;
  on(event: 'credentials/reference-updated', cb: (ref: string) => void): () => void;
  on(event: 'llm/adapters-updated' | 'connection/reset', cb: () => void): () => void;
}
export type CapSideKey = 'cw' | 'mt';
/** Rail keys: r:<route>:detail, r:<route>:access, wiz, m:<route>:<idx>, ds, bulk. */
export interface ModelCapabilitiesStore {
  getSnapshot(): McSnapshot;
  subscribe(fn: () => void): () => void;
  load(): Promise<void>;
  dispose(): void;
  save(): Promise<void>;
  discard(): void;
  reload(): Promise<void>;
  keepConflict(): void;
  enter(routeId: string): void;
  backToList(): void;
  openPreview(): void;
  closePreview(): void;
  openAddProvider(): void;
  wizardPatch(patch: Partial<WizardDraft>): void;
  wizardNext(): void;
  wizardPrev(): void;
  wizardFinish(): void;
  wizardCancel(): void;
  openModel(idx: number): void;
  addModel(): void;
  closeLayer(): void;
  openAccess(): void;
  askDeleteProvider(): void;
  askDiscard(): void;
  askReload(): void;
  confirmDialog(): void;
  cancelDialog(): void;
  setDeleteConfirm(text: string): void;
  setModelId(value: string): void;
  setModelName(value: string): void;
  toggleInput(scope: 'model' | 'bulk', modality: InputModality): void;
  clearInput(): void;
  toggleNoThink(): void;
  toggleDsThinking(): void;
  railToggle(key: string, level: string): void;
  setSpell(level: string, value: string | null): void;
  setCap(side: CapSideKey, raw: string): void;
  blurCap(side: CapSideKey): void;
  capClear(side: CapSideKey): void;
  setAccessField(field: 'displayName' | 'api' | 'baseURL' | 'apiKeyEnv', value: string): void;
  setSecret(value: string): void;
  setWizardSecret(value: string): void;
  headerAdd(scope: 'access' | 'wizard'): void;
  headerDelete(scope: 'access' | 'wizard', idx: number): void;
  headerEdit(scope: 'access' | 'wizard', idx: number, part: 'k' | 'v', value: string): void;
  migrate(): void;
  selectAll(): void;
  selectClear(): void;
  selectIndex(idx: number, on: boolean): void;
  openBulk(): void;
  closeBulk(): void;
  patchBulk(patch: Partial<BulkDraft>): void;
  applyBulk(): void;
  openMenu(idx: number): void;
  closeMenu(): void;
  copyModel(idx: number): void;
  moveModel(idx: number, dir: -1 | 1): void;
  deleteModel(idx: number): void;
  undoDelete(): void;
  toggleAdv(railKey: string): void;
  dismissStatus(): void;
}
export interface DOMRectLike { left: number; right: number; top: number; bottom: number }
