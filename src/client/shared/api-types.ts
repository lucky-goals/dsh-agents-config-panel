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
  teamProfiles: string[];
  profile: string;
  members: TeamMember[];
  errors: {
    subagents?: string;
    members?: string;
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
