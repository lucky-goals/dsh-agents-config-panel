/**
 * R4a 模型可用性测试 —— Host 侧 probe 模块。
 * 契约：docs/specs/r4a-model-test.md §1.2（算法与常量）、§4 MP01–MP20 / MK01–MK05。
 *
 * TDD 红灯阶段：src/host/model-probe.ts 尚未落地，本文件会因模块不存在而整体加载失败，
 * 这是预期的红灯结果。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  probeModel,
  maskMessage,
  pickEffort,
  MODEL_PROBE_TIMEOUT_MS,
  MODEL_PROBE_MAX_TOKENS,
  MODEL_PROBE_PROMPT,
  TRANSIENT_KINDS,
} from './model-probe.js';

const TARGET = { provider: 'openrouter', model: 'openai/gpt-4.1-mini' };

type Clock = { value: number };
type Chunk = Record<string, unknown>;

/** 可控 `stream`：依次产出 [时钟值, chunk]，先把注入的 now 计数器拨到该值再 yield。 */
function streamFrom(entries: Array<[number, Chunk]>, clock?: Clock) {
  return async function* fakeStream() {
    for (const [at, chunk] of entries) {
      if (clock) clock.value = at;
      yield chunk;
    }
  };
}

/** fake LLM：三个入口都是 vi.fn，默认模型有 `off` 档并正常以 `stop` 结束。 */
function createLlm(overrides: Record<string, any> = {}) {
  return {
    listProviders: vi.fn(() => [{ id: TARGET.provider }]),
    resolveModelInfo: vi.fn(async () => ({ reasoning: { efforts: [{ id: 'off' }] } })),
    stream: vi.fn(streamFrom([[0, { type: 'finish', reason: { kind: 'stop' } }]])),
    ...overrides,
  };
}

/** probeModel 的 deps；类型随模块落地，这里保持宽松以免测试写死未实现的类型。 */
function deps(llm: any, extra: Record<string, unknown> = {}): any {
  return { llm, ...extra };
}

/** 传给 stream 的 options（第一次调用的）。 */
function streamOptions(llm: any): any {
  return llm.stream.mock.calls[0][0];
}

/** 30ms 超时用例的护栏：probeModel 不返回时给出可读失败，而不是等 vitest 5s 超时。 */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 未在 ${ms}ms 内返回`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function failure(code: string, status?: number, message = 'boom'): Chunk {
  return { type: 'finish', reason: { kind: 'error', failure: { code, status, message } } };
}

describe('r4a model-probe', () => {
  it('契约常量：20s 总时限、maxTokens 32、短提示「只回复 OK」与暂时性错误码集合', () => {
    expect(MODEL_PROBE_TIMEOUT_MS).toBe(20_000);
    expect(MODEL_PROBE_MAX_TOKENS).toBe(32);
    expect(MODEL_PROBE_PROMPT).toBe('只回复 OK');
    expect([...TRANSIENT_KINDS].sort()).toEqual([
      'EMPTY_RESPONSE',
      'NO_ADAPTER',
      'RATE_LIMIT',
      'SERVER',
      'TIMEOUT',
      'TRANSPORT',
    ]);
  });

  it('MP01 finish stop：样例 OK、首 token 100ms、总耗时 300ms、errorKind 空', async () => {
    const clock: Clock = { value: 0 };
    const llm = createLlm({
      stream: vi.fn(streamFrom([
        [100, { type: 'text-delta', text: 'O' }],
        [100, { type: 'text-delta', text: 'K' }],
        [300, { type: 'finish', reason: { kind: 'stop' } }],
      ], clock)),
    });

    const result = await probeModel(TARGET, deps(llm, {
      now: () => clock.value,
      clock: () => new Date('2026-10-08T02:40:00.000Z'),
    }));

    expect(result).toMatchObject({
      ok: true,
      sample: 'OK',
      firstTokenMs: 100,
      latencyMs: 300,
      finish: 'stop',
      errorKind: null,
      status: null,
      message: '',
      transient: false,
      params: {
        effort: 'off',
        maxTokens: MODEL_PROBE_MAX_TOKENS,
        timeoutMs: MODEL_PROBE_TIMEOUT_MS,
      },
    });
    expect(result.testedAt).toBe('2026-10-08T02:40:00.000Z');
  });

  it.each([
    ['MP02', 'max-tokens'],
    ['MP03', 'tool-calls'],
  ])('%s finish %s 仍然算可用', async (_id, kind) => {
    const llm = createLlm({ stream: vi.fn(streamFrom([[0, { type: 'finish', reason: { kind } }]])) });

    const result = await probeModel(TARGET, deps(llm));

    expect(result).toMatchObject({ ok: true, finish: kind, errorKind: null, status: null, transient: false });
  });

  it('MP04 error AUTH：errorKind/status 透传、message 脱敏、非暂时性', async () => {
    const llm = createLlm({
      stream: vi.fn(streamFrom([[
        0,
        { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', status: 401, message: 'Incorrect API key sk-or-v1-abcdef123456' } } },
      ]])),
    });

    const result = await probeModel(TARGET, deps(llm));

    expect(result).toMatchObject({
      ok: false,
      finish: 'error',
      errorKind: 'AUTH',
      status: 401,
      transient: false,
      message: 'Incorrect API key sk-***',
    });
  });

  it.each([
    ['MP05', failure('RATE_LIMIT', 429, 'rate limited'), 'RATE_LIMIT', 429, true],
    ['MP06', failure('HTTP_404', undefined, 'not found'), 'HTTP_404', 404, false],
    ['MP07', failure('weird code', undefined, 'nope'), 'UNKNOWN', null, false],
  ])('%s failure.code %s → errorKind/status/transient 映射', async (_id, chunk, errorKind, status, transient) => {
    const llm = createLlm({ stream: vi.fn(streamFrom([[0, chunk as Chunk]])) });

    const result = await probeModel(TARGET, deps(llm));

    expect(result).toMatchObject({ ok: false, finish: 'error', errorKind, status, transient });
  });

  it('MP08 finish aborted 且没有 code：errorKind ABORTED、finish aborted', async () => {
    const llm = createLlm({ stream: vi.fn(streamFrom([[0, { type: 'finish', reason: { kind: 'aborted' } }]])) });

    const result = await probeModel(TARGET, deps(llm));

    expect(result).toMatchObject({ ok: false, finish: 'aborted', errorKind: 'ABORTED', status: null });
  });

  it('MP09 timeoutMs 30 且 adapter 无视 signal：约 30ms 返回 TIMEOUT，signal 已 aborted', async () => {
    // 永不 yield、也从不理会 signal 的流。
    const never: AsyncIterable<never> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    };
    const llm = createLlm({ stream: vi.fn(() => never) });

    const started = Date.now();
    const result = await withDeadline(
      probeModel(TARGET, deps(llm, { timeoutMs: 30 })),
      1000,
      'MP09 probeModel(timeoutMs 30)',
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(result).toMatchObject({
      ok: false,
      finish: 'timeout',
      errorKind: 'TIMEOUT',
      status: null,
      transient: true,
      firstTokenMs: null,
      params: expect.objectContaining({ timeoutMs: 30 }),
    });
    expect(streamOptions(llm).signal.aborted).toBe(true);
  });

  it('MP10 stream 抛 NO_ADAPTER：finish error、暂时性，且不向外抛', async () => {
    const noAdapter = Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' });
    const llm = createLlm({ stream: vi.fn(() => { throw noAdapter; }) });

    const result = await probeModel(TARGET, deps(llm));

    expect(result).toMatchObject({ ok: false, finish: 'error', errorKind: 'NO_ADAPTER', transient: true });
  });

  it('MP11 迭代中抛普通 Error：errorKind UNKNOWN，probeModel 不抛错', async () => {
    const llm = createLlm({
      stream: vi.fn(() => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('middleware exploded')) }),
      })),
    });

    const result = await probeModel(TARGET, deps(llm));

    expect(result).toMatchObject({ ok: false, finish: 'error', errorKind: 'UNKNOWN', transient: false });
  });

  it('MP12 listProviders 不含该 provider（或抛错）：NO_ADAPTER、finish null、不发请求', async () => {
    const missing = createLlm({ listProviders: vi.fn(() => [{ id: 'other' }]) });

    const notListed = await probeModel(TARGET, deps(missing));

    expect(notListed).toMatchObject({
      ok: false,
      finish: null,
      errorKind: 'NO_ADAPTER',
      status: null,
      transient: true,
      message: '提供方尚未生效或未注册',
    });
    expect(missing.resolveModelInfo).not.toHaveBeenCalled();
    expect(missing.stream).not.toHaveBeenCalled();

    const broken = createLlm({ listProviders: vi.fn(() => { throw new Error('llm registry down'); }) });

    const threw = await probeModel(TARGET, deps(broken));

    expect(threw).toMatchObject({ ok: false, finish: null, errorKind: 'NO_ADAPTER', transient: true });
    expect(broken.stream).not.toHaveBeenCalled();
  });

  it('MP13 resolveModelInfo 抛 UNKNOWN_MODEL：finish null、不调 stream', async () => {
    const llm = createLlm({
      resolveModelInfo: vi.fn(async () => {
        throw Object.assign(new Error('模型未在配置中注册'), { code: 'UNKNOWN_MODEL' });
      }),
    });

    const result = await probeModel(TARGET, deps(llm));

    expect(result).toMatchObject({ ok: false, finish: null, errorKind: 'UNKNOWN_MODEL', status: null, transient: false });
    expect(llm.stream).not.toHaveBeenCalled();
  });

  it('MP14 有 off 档：传 reasoningEffort off，params.effort 为 off', async () => {
    const llm = createLlm({
      resolveModelInfo: vi.fn(async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'off' }, { id: 'high' }] } })),
    });

    const result = await probeModel(TARGET, deps(llm));

    expect(streamOptions(llm).reasoningEffort).toBe('off');
    expect(result.params.effort).toBe('off');
  });

  it('MP15 没有 off 档：取列表首项（DSH 按低→高排序）', async () => {
    const llm = createLlm({
      resolveModelInfo: vi.fn(async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })),
    });

    const result = await probeModel(TARGET, deps(llm));

    expect(streamOptions(llm).reasoningEffort).toBe('low');
    expect(result.params.effort).toBe('low');
    expect(pickEffort([{ id: 'low' }, { id: 'high' }])).toBe('low');
  });

  it('MP16 无推理档：options 不含 reasoningEffort、params.effort 为 null', async () => {
    const llm = createLlm({ resolveModelInfo: vi.fn(async () => ({})) });

    const result = await probeModel(TARGET, deps(llm));

    const options = streamOptions(llm);
    expect('reasoningEffort' in options).toBe(false);
    expect(result.params.effort).toBeNull();
    expect(pickEffort(undefined)).toBeNull();
    expect(pickEffort([])).toBeNull();
  });

  it('MP17 options 形状固定：短提示、temperature 0、maxTokens 32、带 signal，且不带 sessionId', async () => {
    const llm = createLlm({
      resolveModelInfo: vi.fn(async () => ({})),
      stream: vi.fn(streamFrom([[0, { type: 'finish', reason: { kind: 'stop' } }]])),
    });

    await probeModel(TARGET, deps(llm));

    const options = streamOptions(llm);
    expect(options).toEqual({
      provider: TARGET.provider,
      model: TARGET.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回复 OK' }] }],
      temperature: 0,
      maxTokens: 32,
      signal: expect.any(AbortSignal),
    });
    expect('sessionId' in options).toBe(false);
  });

  it('MP18 sample：200 字符截到 80 码点、控制字符与换行折叠为单空格', async () => {
    const long = createLlm({
      stream: vi.fn(streamFrom([
        [0, { type: 'text-delta', text: 'a'.repeat(200) }],
        [0, { type: 'finish', reason: { kind: 'stop' } }],
      ])),
    });
    expect((await probeModel(TARGET, deps(long))).sample).toBe('a'.repeat(80));

    // 契约 §1.1：按码点截断（不是 UTF-16 码元）。
    const emoji = createLlm({
      stream: vi.fn(streamFrom([
        [0, { type: 'text-delta', text: '😀'.repeat(100) }],
        [0, { type: 'finish', reason: { kind: 'stop' } }],
      ])),
    });
    expect((await probeModel(TARGET, deps(emoji))).sample).toBe('😀'.repeat(80));

    const wrapped = createLlm({
      stream: vi.fn(streamFrom([
        [0, { type: 'text-delta', text: 'ok\n\tdone' }],
        [0, { type: 'finish', reason: { kind: 'stop' } }],
      ])),
    });
    expect((await probeModel(TARGET, deps(wrapped))).sample).toBe('ok done');
  });

  it('MP19 流结束但没有 finish chunk：EMPTY_RESPONSE、finish none', async () => {
    const llm = createLlm({ stream: vi.fn(streamFrom([[0, { type: 'text-delta', text: 'x' }]])) });

    const result = await probeModel(TARGET, deps(llm));

    expect(result).toMatchObject({ ok: false, finish: 'none', errorKind: 'EMPTY_RESPONSE', status: null, transient: true });
  });

  it('MP20 外部 signal 被 abort：CLIENT_ABORTED、finish aborted', async () => {
    const ctl = new AbortController();
    const llm = createLlm({
      stream: vi.fn(async function* abortedMidStream() {
        yield { type: 'text-delta', text: 'x' };
        ctl.abort();
      }),
    });

    const result = await probeModel(TARGET, deps(llm, { signal: ctl.signal }));

    expect(result).toMatchObject({ ok: false, finish: 'aborted', errorKind: 'CLIENT_ABORTED' });
  });
});

describe('r4a maskMessage', () => {
  it('MK01 Authorization 头：Bearer 值被遮蔽，②不重复处理 Bearer', () => {
    expect(maskMessage('Authorization: Bearer abc.def')).toBe('Authorization: Bearer ***');
    expect(maskMessage('authorization=Basic%20xyz')).toBe('authorization=***');
  });

  it('MK02 裸 Bearer token', () => {
    expect(maskMessage('Bearer xyz123')).toBe('Bearer ***');
  });

  it('MK03 查询串里的 api_key 只遮蔽到分隔符', () => {
    expect(maskMessage('url?api_key=SECRET1&x=1')).toBe('url?api_key=***&x=1');
  });

  it('MK04 JSON 里的 token 保留引号结构', () => {
    expect(maskMessage('"token": "t-1"')).toBe('"token": "***"');
  });

  it('MK05 超过 300 码点截断为 300 并追加省略号', () => {
    const masked = maskMessage('x'.repeat(401));

    expect(masked.length).toBe(301);
    expect(masked.endsWith('…')).toBe(true);
  });

  /* ---------------- 返工轮（F1）：下划线键名、scheme 值、长 token 都要遮蔽 ---------------- */

  it('MK06 下划线命名的键：access_token 的值也要遮蔽，分隔符后的参数保留', () => {
    expect(maskMessage('access_token=abc123xyz&x=1')).toBe('access_token=***&x=1');
  });

  it('MK07 JSON 里的下划线键：值与引号结构都保留', () => {
    expect(maskMessage('{"access_token": "t-1", "refresh_token":"r-2"}')).toBe(
      '{"access_token": "***", "refresh_token":"***"}',
    );
  });

  it('MK08 client_secret / x_api_key：等号与冒号两种写法都遮蔽到分隔符', () => {
    expect(maskMessage('client_secret=s3cr3t x_api_key: k9')).toBe('client_secret=*** x_api_key: ***');
  });

  it('MK09 Authorization 的 scheme 值被遮蔽（Basic），裸 Token 方案同理', () => {
    expect(maskMessage('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic ***');
    expect(maskMessage('Token abcdef123456')).toBe('Token ***');
  });

  it('MK10 JWT 三段式 token 整体遮蔽', () => {
    expect(maskMessage('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part-1 end')).toBe('jwt *** end');
  });

  it('MK11 云厂商长 token 前缀（AIza / ghp_ / AKIA）整体遮蔽', () => {
    expect(
      maskMessage('key AIzaSyA1234567890abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz0123 AKIAABCDEFGHIJKLMNOP'),
    ).toBe('key *** *** ***');
  });

  it('MK12 回归：MK01–MK05 保持不变，只有描述没有值的错误文案不被误伤', () => {
    // MK01–MK05 的既有期望（在同段重复一遍，防止新规则打破旧行为）
    expect(maskMessage('Authorization: Bearer abc.def')).toBe('Authorization: Bearer ***');
    expect(maskMessage('authorization=Basic%20xyz')).toBe('authorization=***');
    expect(maskMessage('Bearer xyz123')).toBe('Bearer ***');
    expect(maskMessage('url?api_key=SECRET1&x=1')).toBe('url?api_key=***&x=1');
    expect(maskMessage('"token": "t-1"')).toBe('"token": "***"');
    const truncated = maskMessage('x'.repeat(401));
    expect(truncated.length).toBe(301);
    expect(truncated.endsWith('…')).toBe(true);

    // 普通错误文案：没有值，必须一个字符都不改
    expect(maskMessage('No endpoints found for this model id.')).toBe('No endpoints found for this model id.');
    expect(maskMessage('Incorrect API key provided')).toBe('Incorrect API key provided');
    expect(maskMessage('HTTP 429 Too Many Requests')).toBe('HTTP 429 Too Many Requests');
  });
});
