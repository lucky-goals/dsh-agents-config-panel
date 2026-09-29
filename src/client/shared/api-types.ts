/**
 * Client-side API types (DTO layer)
 * 
 * These types map to the HTTP protocol defined in requirements.md Section C.
 * Do NOT import from src/host/** because those tasks run in parallel.
 */

// ============================================================================
// Model Catalog (from C1 State response)
// ============================================================================

export interface ModelCatalog {
  providers: Array<{
    id: string;
    models: Array<{
      id: string;
      reasoningEfforts: string[];
    }>;
  }>;
}

// ============================================================================
// Subagent (Panel A)
// ============================================================================

export interface SubagentRow {
  id: string;
  disabled: boolean;
  editable: boolean;
  /** Present when editable is false; explains why in Chinese. */
  readOnlyReason?: string;
  config: Record<string, unknown>;
}

// ============================================================================
// Team Member (Panel B)
// ============================================================================

export interface TeamMember {
  name: string;
  role?: string;
  provider?: string;
  model?: string;
  reasoning_effort?: string;
  [key: string]: unknown;
}

// ============================================================================
// State Response (GET /api/state)
// ============================================================================

export interface StateResponse {
  revision: string;
  catalog: ModelCatalog;
  subagents: SubagentRow[];
  /** v2.1: list of subagent providers with their capabilities. */
  subagentProviders?: SubagentProviderInfo[];
  teamProfiles: string[];
  profile: string;
  members: TeamMember[];
  /** v2.3: list of ACP configurations */
  /** v2.3: ACP provider registrations (root inserts); absent on older Hosts. */
  acps?: AcpRow[];
  /** v2.3: the DSH profile this Host instance edits (web, desktop, cli, ...). */
  dshProfile?: { name: string; patchPath: string };
  errors: {
    subagents?: string;
    members?: string;
    acps?: string;
  };
  /** Host runtime diagnostics (atomic-write loading, catalog source). */
  diagnostics?: StateDiagnostics;
}

export interface StateDiagnostics {
  atomicWrite: {
    loaded: boolean;
    anchor?: string;
    resolvedPath?: string;
    tried?: string[];
  };
  catalogSource: 'runtime' | 'patch';
  catalogErrors?: string[];
  /** Present when Host implements v2.1 provider-capability API. */
  hostApi?: number;
  subagentProvidersSource?: 'runtime' | 'patch';
  subagentProviderErrors?: string[];
}

// ============================================================================
// Subagent Provider (v2.1)
// ============================================================================

export interface SubagentProviderCapabilities {
  agentOptions: boolean;
  depthLimit: boolean;
  continuable: boolean;
  persona: boolean;
  toolFilter: boolean;
}

export interface SubagentProviderInfo {
  name: string;
  kind: 'in-process' | 'acp' | 'unknown';
  capabilities: SubagentProviderCapabilities;
  source: 'runtime' | 'patch';
}

// ============================================================================
// Mutation Request Bodies
// ============================================================================

export interface SubagentsMutationRequest {
  expectedRevision: string;
  action: 'create' | 'update' | 'remove';
  id?: string;
  input?: {
    toolName: string;
    provider: 'spawn' | 'fork';
    backgroundMode?: 'continuable' | 'one-shot';
    agentOptions?: {
      provider: string;
      model: string;
      reasoningEffort?: string;
    };
  };
  patch?: {
    toolName?: string;
    provider?: 'spawn' | 'fork';
    backgroundMode?: 'continuable' | 'one-shot';
    agentOptions?: {
      provider?: string;
      model?: string;
      /** `null` removes the key (the effort was cleared in the form). */
      reasoningEffort?: string | null;
    };
  };
}

/**
 * Member update patch. Only changed fields are sent; `null` on an optional
 * field removes that key from the member (the user cleared it).
 */
export interface MemberPatch {
  name?: string;
  role?: string | null;
  provider?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
}

export interface MembersMutationRequest {
  expectedRevision: string;
  profile: string;
  action: 'add' | 'update' | 'remove';
  name?: string;
  member?: TeamMember;
  patch?: MemberPatch;
}

// ============================================================================
// ACP Mutation (POST /api/acps)
// ============================================================================

/** `@deepseek-ai/dsh-subagent-acp` config (package schema). */
export interface AcpConfig {
  providerName: string;
  command: string;
  args: string[];
  cwd?: string;
  permission: 'allow' | 'reject';
  env: Record<string, string>;
}

export interface AcpRow {
  id: string;
  disabled: boolean;
  config: AcpConfig;
  /** toolNames of subagent rows using this provider. */
  usedBy: string[];
}

/** providerName is fixed after creation; `cwd: null` removes it. */
export interface AcpPatch {
  command?: string;
  args?: string[];
  cwd?: string | null;
  permission?: 'allow' | 'reject';
  env?: Record<string, string>;
}

export interface AcpsMutationRequest {
  expectedRevision: string;
  action: 'create' | 'update' | 'remove';
  input?: AcpConfig;
  id?: string;
  patch?: AcpPatch;
}

// ============================================================================
// Panel A bundle import (POST /api/subagents/import)
// ============================================================================

export interface SubagentBundleInput {
  toolName: string;
  provider: string;
  backgroundMode?: 'continuable' | 'one-shot';
  agentOptions?: { provider: string; model: string; reasoningEffort?: string };
}

export interface SubagentBundle {
  acps: AcpConfig[];
  subagents: SubagentBundleInput[];
}

export interface SubagentImportRequest {
  expectedRevision: string;
  bundle: SubagentBundle;
}

export interface BundleImportReport {
  created: { acps: string[]; subagents: string[] };
  skipped: Array<{ kind: 'acp' | 'subagent'; name: string; reason: string }>;
}

export interface SubagentImportResponse extends MutationSuccessResponse {
  importReport: BundleImportReport;
}

// ============================================================================
// Team profiles (v2.6): GET/POST /api/teams, POST /api/teams/import
// ============================================================================

export interface TeamsResponse {
  revision: string;
  /** Every agent-teams team profile, full config, in file order. */
  profiles: Record<string, Record<string, unknown>>;
  dshProfile?: { name: string; patchPath: string };
}

export interface TeamCreateRequest {
  expectedRevision: string;
  action: 'create';
  name: string;
  /** Clone this team; absent = a new team with `firstMember`. */
  from?: string;
  firstMember?: string;
  description?: string;
}

/** v2.7: `confirm` must be the word the user typed, `thinktwice`. */
export interface TeamRemoveRequest {
  expectedRevision: string;
  action: 'remove';
  name: string;
  confirm: string;
}

export interface TeamsImportRequest {
  expectedRevision: string;
  teams: Array<{ name: string; profile: Record<string, unknown>; scope?: 'full' | 'members' }>;
  overwrite: string[];
}

export interface TeamsImportResponse extends MutationSuccessResponse {
  importReport: { created: string[]; overwritten: string[]; skipped: Array<{ name: string; reason: string }> };
}

// ============================================================================
// ACP test (POST /api/acps/test, v2.4)
// ============================================================================

export type AcpProbeStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface AcpProbeCheck {
  key: 'command' | 'interpreter' | 'cwd' | 'handshake';
  label: string;
  status: AcpProbeStatus;
  detail: string;
}

export interface AcpTestResponse {
  id: string;
  providerName: string;
  ok: boolean;
  handshake: boolean;
  checks: AcpProbeCheck[];
  resolvedCommand?: string;
  agent?: { protocolVersion?: number; name?: string; title?: string; version?: string; authMethods?: string[] };
  stderrTail?: string;
  durationMs: number;
}

// ============================================================================
// Mutation Success Response
// ============================================================================

export interface MutationSuccessResponse extends StateResponse {
  notice: string;
}

// ============================================================================
// Error Response
// ============================================================================

export interface ErrorResponse {
  code: string;
  message: string;
}
