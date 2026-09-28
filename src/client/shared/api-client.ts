/**
 * API Client for communicating with the Host HTTP routes
 * 
 * Based on requirements.md Section C (HTTP Protocol)
 */

import type {
  StateResponse,
  SubagentsMutationRequest,
  MembersMutationRequest,
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
  };
}
