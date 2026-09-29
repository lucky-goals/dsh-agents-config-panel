/**
 * API Client for communicating with the Host HTTP routes
 * 
 * Based on requirements.md Section C (HTTP Protocol)
 */

import type {
  StateResponse,
  SubagentsMutationRequest,
  MembersMutationRequest,
  AcpsMutationRequest,
  SubagentImportRequest,
  SubagentImportResponse,
  AcpTestResponse,
  TeamsResponse,
  TeamCreateRequest,
  TeamRemoveRequest,
  TeamsImportRequest,
  TeamsImportResponse,
  MutationSuccessResponse,
  ErrorResponse,
} from './api-types';

export interface ApiClientOptions {
  fetch?: typeof fetch;
  base?: string;
}

export interface ApiClient {
  getState(profile: string): Promise<StateResponse>;
  mutateSubagents(body: SubagentsMutationRequest): Promise<MutationSuccessResponse>;
  mutateMembers(body: MembersMutationRequest): Promise<MutationSuccessResponse>;
  /** v2.3: ACP registration CRUD. */
  mutateAcps(body: AcpsMutationRequest, profile?: string): Promise<MutationSuccessResponse>;
  /** v2.3: one-revision import of an exported Panel A bundle (ACPs + subagent tools). */
  importSubagentBundle(body: SubagentImportRequest, profile?: string): Promise<SubagentImportResponse>;
  /** v2.4: test a saved ACP row (static checks; `handshake` also starts it). Read-only. */
  testAcp(body: { id: string; handshake?: boolean }): Promise<AcpTestResponse>;
  /** v2.6: every team profile with its full config. */
  getTeams(): Promise<TeamsResponse>;
  /** v2.6: create a blank team or clone one; the returned state is for the new team. */
  createTeam(body: TeamCreateRequest): Promise<MutationSuccessResponse>;
  /** v2.6: import several team profiles in one revision. */
  importTeams(body: TeamsImportRequest, profile?: string): Promise<TeamsImportResponse>;
  /** v2.7: delete a team profile; `profile` is the team being viewed (kept unless removed). */
  removeTeam(body: TeamRemoveRequest, profile?: string): Promise<MutationSuccessResponse>;
  /** Write a basic agent-teams profile when the package is installed but the user patch has none. */
  bootstrapTeams(body: { expectedRevision: string }, profile?: string): Promise<MutationSuccessResponse>;
}

/**
 * Create an API client that talks to the Host HTTP routes
 * 
 * @param options - Configuration options
 * @param options.fetch - Custom fetch implementation (defaults to global fetch)
 * @param options.base - Base URL for API routes (defaults to '/plugins/dsh-wuyou-agent/api')
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseFetch = options.fetch ?? fetch;
  const baseUrl = options.base ?? '/plugins/dsh-wuyou-agent/api';

  async function request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const response = await baseFetch(url, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });

    const text = await response.text();

    if (!response.ok) {
      // Generic HTTP fallback — shown when the body is not a well-formed error object.
      const httpFallback = `请求失败（HTTP ${response.status}）`;

      let message = httpFallback;
      let code: string | undefined;
      try {
        const parsed: unknown = JSON.parse(text);
        // Only use structured fields when the body is a plain object — rejects
        // null, arrays, strings, and numbers.
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj.message === 'string' && obj.message) {
            // Structured error from the Host — use as-is.
            message = obj.message;
          } else if (!obj.message) {
            // Body is an object but without a message field (e.g. {error:'unauthorized'}).
            // Apply status-specific Chinese text for auth failures.
            if (response.status === 401 || response.status === 403) {
              message = '没有访问权限，请刷新页面后重新登录';
            } else if (response.status === 503) {
              message = '服务暂时不可用，请稍后重试';
            }
          }
          if (typeof obj.code === 'string') code = obj.code;
        }
      } catch {
        // Non-JSON body (HTML, plain text, empty): keep httpFallback.
      }

      const error = new Error(message) as Error & {
        code?: string;
        status: number;
      };
      error.code = code;
      error.status = response.status;
      throw error;
    }

    return JSON.parse(text) as T;
  }

  return {
    async getState(profile: string): Promise<StateResponse> {
      return request<StateResponse>(`/state?profile=${encodeURIComponent(profile)}`);
    },

    async mutateSubagents(body: SubagentsMutationRequest): Promise<MutationSuccessResponse> {
      return request<MutationSuccessResponse>('/subagents', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    async mutateMembers(body: MembersMutationRequest): Promise<MutationSuccessResponse> {
      return request<MutationSuccessResponse>('/members', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    async mutateAcps(body: AcpsMutationRequest, profile?: string): Promise<MutationSuccessResponse> {
      return request<MutationSuccessResponse>(`/acps${profileQuery(profile)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    async getTeams(): Promise<TeamsResponse> {
      return request<TeamsResponse>('/teams');
    },

    async createTeam(body: TeamCreateRequest): Promise<MutationSuccessResponse> {
      return request<MutationSuccessResponse>('/teams', { method: 'POST', body: JSON.stringify(body) });
    },

    async removeTeam(body: TeamRemoveRequest, profile?: string): Promise<MutationSuccessResponse> {
      return request<MutationSuccessResponse>(`/teams${profileQuery(profile)}`, { method: 'POST', body: JSON.stringify(body) });
    },

    async bootstrapTeams(body: { expectedRevision: string }, profile?: string): Promise<MutationSuccessResponse> {
      return request<MutationSuccessResponse>(`/teams/bootstrap${profileQuery(profile)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    async importTeams(body: TeamsImportRequest, profile?: string): Promise<TeamsImportResponse> {
      return request<TeamsImportResponse>(`/teams/import${profileQuery(profile)}`, { method: 'POST', body: JSON.stringify(body) });
    },

    async testAcp(body: { id: string; handshake?: boolean }): Promise<AcpTestResponse> {
      return request<AcpTestResponse>('/acps/test', { method: 'POST', body: JSON.stringify(body) });
    },

    async importSubagentBundle(body: SubagentImportRequest, profile?: string): Promise<SubagentImportResponse> {
      return request<SubagentImportResponse>(`/subagents/import${profileQuery(profile)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  };
}

/** Team profile for the state a write returns (Host default when absent). */
function profileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : '';
}
