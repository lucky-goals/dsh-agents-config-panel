import { describe, it, expect, vi } from 'vitest';
import { createApiClient } from './api-client';
import type { StateResponse, MutationSuccessResponse } from './api-types';

/** Build a minimal mock Response that returns `value` from both `.text()` and `.json()`. */
function mockResponse(ok: boolean, status: number, value: unknown) {
  const text = JSON.stringify(value);
  return { ok, status, text: async () => text, json: async () => value };
}

/** Mock Response that returns raw text (which is NOT parseable JSON). */
function mockRawTextResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    text: async () => text,
    // json() would throw in a real browser; replicate that here.
    json: async () => { throw new SyntaxError('Unexpected token'); },
  };
}

describe('createApiClient', () => {
  const MINIMAL_STATE: StateResponse = {
    revision: 'abc123',
    catalog: { providers: [] },
    subagents: [],
    teamProfiles: [],
    profile: 'web',
    members: [],
    errors: {},
  };

  it('uses default base URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(true, 200, MINIMAL_STATE));
    const client = createApiClient({ fetch: mockFetch });
    await client.getState('web');
    expect(mockFetch).toHaveBeenCalledWith(
      '/plugins/dsh-wuyou-agent/api/state?profile=web',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('uses custom base URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(true, 200, MINIMAL_STATE));
    const client = createApiClient({ fetch: mockFetch, base: '/custom/api' });
    await client.getState('web');
    expect(mockFetch).toHaveBeenCalledWith('/custom/api/state?profile=web', expect.anything());
  });

  it('includes credentials:same-origin in all requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(true, 200, MINIMAL_STATE));
    const client = createApiClient({ fetch: mockFetch });
    await client.getState('web');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('returns state response on successful GET', async () => {
    const mockState: StateResponse = {
      revision: 'rev123',
      catalog: {
        providers: [
          { id: 'gpt-gateway', models: [{ id: 'gpt-6-luna', reasoningEfforts: ['low', 'medium', 'high', 'max'] }] },
        ],
      },
      subagents: [],
      teamProfiles: ['standard-acp'],
      profile: 'standard-acp',
      members: [{ name: 'claude' }],
      errors: {},
    };
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(true, 200, mockState));
    const client = createApiClient({ fetch: mockFetch });
    expect(await client.getState('standard-acp')).toEqual(mockState);
  });

  it('sends expectedRevision in mutation requests', async () => {
    const mockResp: MutationSuccessResponse = {
      revision: 'rev456',
      catalog: { providers: [] },
      subagents: [],
      teamProfiles: [],
      profile: 'web',
      members: [],
      errors: {},
      notice: '已保存，新建会话后生效',
    };
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(true, 200, mockResp));
    const client = createApiClient({ fetch: mockFetch });
    await client.mutateSubagents({
      expectedRevision: 'rev123',
      action: 'create',
      input: { toolName: 'subagent_test', provider: 'spawn', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/plugins/dsh-wuyou-agent/api/subagents',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"expectedRevision":"rev123"') }),
    );
  });

  it('throws error with code and message on 409 STALE_REVISION', async () => {
    const body = { code: 'STALE_REVISION', message: '配置已被其他地方修改，请刷新后重试' };
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, 409, body));
    const client = createApiClient({ fetch: mockFetch });

    await expect(
      client.mutateSubagents({
        expectedRevision: 'old-rev',
        action: 'create',
        input: { toolName: 'subagent_test', provider: 'spawn', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
      }),
    ).rejects.toThrow('配置已被其他地方修改，请刷新后重试');

    // Also confirm code and status are attached.
    try {
      await client.mutateSubagents({
        expectedRevision: 'old-rev',
        action: 'create',
        input: { toolName: 'subagent_test', provider: 'spawn', agentOptions: { provider: 'gpt-gateway', model: 'gpt-6-luna' } },
      });
    } catch (error: any) {
      expect(error.code).toBe('STALE_REVISION');
      expect(error.status).toBe(409);
    }
  });

  it('throws error on 400 INVALID', async () => {
    const message = "模型 'unknown-model' 不在 provider 'gpt-gateway' 的目录中";
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, 400, { code: 'INVALID', message }));
    const client = createApiClient({ fetch: mockFetch });
    await expect(
      client.mutateSubagents({
        expectedRevision: 'rev123',
        action: 'create',
        input: { toolName: 'subagent_test', provider: 'spawn', agentOptions: { provider: 'gpt-gateway', model: 'unknown-model' } },
      }),
    ).rejects.toThrow(message);
  });

  it('throws error on 422 LAST_MEMBER', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, 422, { code: 'LAST_MEMBER', message: '团队至少需要保留一个成员' }));
    const client = createApiClient({ fetch: mockFetch });
    await expect(
      client.mutateMembers({ expectedRevision: 'rev123', profile: 'standard-acp', action: 'remove', name: 'claude' }),
    ).rejects.toThrow('团队至少需要保留一个成员');
  });

  it('throws error on 422 READ_ONLY', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, 422, { code: 'READ_ONLY', message: 'ACP 后端的 subagent 工具为只读' }));
    const client = createApiClient({ fetch: mockFetch });
    await expect(
      client.mutateSubagents({
        expectedRevision: 'rev123',
        action: 'update',
        id: 'tool-subagent-cursor',
        patch: { backgroundMode: 'one-shot' },
      }),
    ).rejects.toThrow('ACP 后端的 subagent 工具为只读');
  });

  it('gives auth rejections ({error} bodies) Chinese fallback text', async () => {
    for (const [status, text] of [
      [401, '没有访问权限，请刷新页面后重新登录'],
      [403, '没有访问权限，请刷新页面后重新登录'],
      [503, '服务暂时不可用，请稍后重试'],
    ] as const) {
      const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, status, { error: 'unauthorized' }));
      const client = createApiClient({ fetch: mockFetch });
      await expect(client.getState('standard-acp'), String(status)).rejects.toThrow(text);
    }
  });

  // T34-API-001: non-JSON or structurally-unexpected error bodies must not
  // surface raw SyntaxError / TypeError. They should resolve to the Chinese
  // HTTP fallback "请求失败（HTTP <status>）".
  //
  // These tests were RED before the fix (the old code called response.json()
  // directly and propagated its exceptions, or tried to read .message on a
  // non-object value).
  describe('malformed error bodies (T34-API-001)', () => {
    it('null body → Chinese HTTP fallback', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, 500, null));
      const client = createApiClient({ fetch: mockFetch });
      await expect(client.getState('standard-acp')).rejects.toThrow('请求失败（HTTP 500）');
    });

    it('array body → Chinese HTTP fallback', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, 500, [1, 2, 3]));
      const client = createApiClient({ fetch: mockFetch });
      await expect(client.getState('standard-acp')).rejects.toThrow('请求失败（HTTP 500）');
    });

    it('JSON string body → Chinese HTTP fallback', async () => {
      // Serialise "just a string" so json() returns a string, not an object.
      const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, 500, 'just a string'));
      const client = createApiClient({ fetch: mockFetch });
      await expect(client.getState('standard-acp')).rejects.toThrow('请求失败（HTTP 500）');
    });

    it('HTML body (non-JSON) → Chinese HTTP fallback', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockRawTextResponse(502, '<!DOCTYPE html><h1>Bad Gateway</h1>'));
      const client = createApiClient({ fetch: mockFetch });
      await expect(client.getState('standard-acp')).rejects.toThrow('请求失败（HTTP 502）');
    });

    it('empty body → Chinese HTTP fallback', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockRawTextResponse(503, ''));
      const client = createApiClient({ fetch: mockFetch });
      // 503 without a structured body falls back to the generic HTTP text (no
      // message field found), NOT the auth-style Chinese 503 message; the
      // auth/503 mapping only applies when the body parses to an object.
      await expect(client.getState('standard-acp')).rejects.toThrow('请求失败（HTTP 503）');
    });
  });
});

/* ==========================================================================
 * R4a 模型可用性测试的客户端调用（docs/specs/r4a-model-test.md §2.1、§4）：AC01–AC05。
 *
 * `testModel` 还不存在，所以这一组现在是红的；文案逐字取契约 §2.1。
 * ========================================================================== */

/** 契约 §2.1 的逐字文案；MODEL_TEST_UNSUPPORTED 常量缺失时也不会拖挂本文件其它用例。 */
const UNSUPPORTED_TEXT = '当前 Host 不支持模型测试，重启 DSH 后可用';

/** 契约 §1.1 / §2.1 的 200 响应体。 */
const MODEL_TEST_RESULT: Record<string, unknown> = {
  provider: 'openrouter',
  model: 'openai/gpt-4.1-mini',
  ok: true,
  latencyMs: 812,
  firstTokenMs: 341,
  sample: 'OK',
  finish: 'stop',
  errorKind: null,
  status: null,
  message: '',
  transient: false,
  params: { effort: 'off', maxTokens: 32, timeoutMs: 20000 },
  testedAt: '2026-10-08T02:40:00.000Z',
};

interface ModelTestClient {
  testModel(body: { provider: string; model: string }, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

function modelTestClient(mockFetch: unknown): ModelTestClient {
  return createApiClient({ fetch: mockFetch as typeof fetch }) as unknown as ModelTestClient;
}

/** 捕获 reject 的 Error（带契约要求的 code / status）。 */
async function captureError(promise: Promise<unknown>): Promise<{ message: string; code?: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    return error as { message: string; code?: string; status?: number };
  }
  throw new Error('expected the promise to reject');
}

describe('api-client testModel（R4a AC01–AC05）', () => {
  it('AC01 POST /models/test，body 与 init.signal 原样传递', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(true, 200, MODEL_TEST_RESULT));
    const client = modelTestClient(mockFetch);
    const controller = new AbortController();

    await client.testModel({ provider: 'openrouter', model: 'openai/gpt-4.1-mini' }, controller.signal);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/plugins/dsh-wuyou-agent/api/models/test');
    expect(init).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ provider: 'openrouter', model: 'openai/gpt-4.1-mini' }),
      credentials: 'same-origin',
    }));
    expect(init.signal).toBe(controller.signal);
  });

  it('AC02 200 → 解析响应体', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(true, 200, MODEL_TEST_RESULT));
    const client = modelTestClient(mockFetch);

    const result = await client.testModel({ provider: 'openrouter', model: 'openai/gpt-4.1-mini' }, new AbortController().signal);
    expect(result).toEqual(MODEL_TEST_RESULT);
  });

  it('AC03 404 且 body 无 code → code HOST_UNSUPPORTED、message 为逐字文案、status 404', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, 404, { error: 'not found' }));
    const client = modelTestClient(mockFetch);

    const error = await captureError(client.testModel({ provider: 'openrouter', model: 'x' }, new AbortController().signal));
    expect(error.message).toBe(UNSUPPORTED_TEXT);
    expect(error.code).toBe('HOST_UNSUPPORTED');
    expect(error.status).toBe(404);

    // 常量 MODEL_TEST_UNSUPPORTED：导出时必须是同一句文案（动态 import，缺失也不影响其它用例）。
    const apiClientModule = (await import('./api-client')) as unknown as Record<string, unknown>;
    const apiTypesModule = (await import('./api-types')) as unknown as Record<string, unknown>;
    const exported = apiClientModule.MODEL_TEST_UNSUPPORTED ?? apiTypesModule.MODEL_TEST_UNSUPPORTED;
    if (exported !== undefined) expect(exported).toBe(UNSUPPORTED_TEXT);
  });

  it('AC04 404 且 body 有 code → 保留原 code / message / status', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, 404, { code: 'NOT_FOUND', message: '找不到这个模型' }));
    const client = modelTestClient(mockFetch);

    const error = await captureError(client.testModel({ provider: 'openrouter', model: 'x' }, new AbortController().signal));
    expect(error.message).toBe('找不到这个模型');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
  });

  it('AC05 409 BUSY → code BUSY、status 409', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, 409, { code: 'BUSY', message: '模型 b 正在测试，请稍候' }));
    const client = modelTestClient(mockFetch);

    const error = await captureError(client.testModel({ provider: 'openrouter', model: 'b' }, new AbortController().signal));
    expect(error.message).toBe('模型 b 正在测试，请稍候');
    expect(error.code).toBe('BUSY');
    expect(error.status).toBe(409);
  });
});
