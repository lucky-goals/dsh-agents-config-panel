/**
 * R4a 红灯用例：模型可用性测试的纯逻辑（docs/specs/r4a-model-test.md §2.4、§2.5）。
 *
 * 本文件是新增文件：`./model-test` 现在还不存在，所以整文件 import 失败是红灯阶段的
 * 预期结果。所有文案逐字取契约 §2.5 的表格；ADVICE 的 9 条取自契约指定的出处
 * docs/design/model-capabilities/model-test-prototype.html 的 ADVICE 表（:495-503）。
 *
 * 约定（契约没有写全签名的地方，这里写明本套用例的约定）：
 * - `badge(models, results, batch)` 的 models 是**该提供方的 testKey 列表**（results 是
 *   全局 testKey → TestEntry，badge 拿不到 route，只有这样才不必依赖 batch.route）；
 * - `segStates(b, results)` 返回与 `b.keys` 同序的 state 数组，缺条目回落 'queued'；
 * - `stripLine` 的 running 秒数来自 startedAt（本地时钟），这里只做区间断言。
 */
import { describe, expect, it } from 'vitest';
import {
  adviceText,
  badge,
  batchStats,
  batchSub,
  batchTitle,
  blockReason,
  doneAnnounce,
  effortText,
  fmtClock,
  fmtMs,
  kindText,
  paramsText,
  progressText,
  resultAnnounce,
  resultState,
  segStates,
  stateTone,
  stripAria,
  stripLine,
  testDetailText,
  testKey,
  verdictText,
} from './model-test';
import { DS_ROUTE_ID } from './types';
import { fakeTestResult, type FakeTestResult } from './test-fixtures';

/* ---------------- 本地形状（契约 §2.3） ---------------- */

type TestState = 'queued' | 'running' | 'ok' | 'fail' | 'transient' | 'cancelled';

interface TestEntryLike {
  state: TestState;
  result?: FakeTestResult;
  at?: number;
  startedAt?: number;
  prev?: TestEntryLike;
}

type BatchLabel = '全部模型' | '所选模型' | '重试失败项' | '已取消的模型';

interface TestBatchLike {
  route: string;
  keys: string[];
  label: BatchLabel;
  stopped: boolean;
  done: boolean;
  startedAt: number;
  endedAt?: number;
}

const T0 = new Date(2026, 9, 8, 2, 40, 0).getTime();

const K = (n: number): string => `gpt-gateway|m${n}`;
const KEYS = [1, 2, 3, 4, 5, 6].map(K);

function result(over: Partial<FakeTestResult> = {}): FakeTestResult {
  return fakeTestResult(over);
}

function failResult(over: Partial<FakeTestResult> = {}): FakeTestResult {
  return fakeTestResult({
    ok: false,
    latencyMs: 230,
    firstTokenMs: null,
    sample: '',
    finish: 'error',
    errorKind: 'AUTH',
    status: 401,
    message: 'Incorrect API Key',
    transient: false,
    ...over,
  });
}

function entry(over: Partial<TestEntryLike> = {}): TestEntryLike {
  return { state: 'ok', result: result(), at: T0 + 812, ...over };
}

function batch(over: Partial<TestBatchLike> = {}): TestBatchLike {
  return { route: 'gpt-gateway', keys: KEYS, label: '全部模型', stopped: false, done: false, startedAt: T0, ...over };
}

/** 六条结果的混合：1 ok / 1 fail / 1 transient / 1 queued / 1 running / 1 cancelled。 */
const MIX_RESULTS: Record<string, TestEntryLike> = {
  [K(1)]: entry(),
  [K(2)]: entry({ state: 'fail', result: failResult() }),
  [K(3)]: entry({ state: 'transient', result: failResult({ errorKind: 'RATE_LIMIT', status: 429, transient: true }) }),
  [K(4)]: entry({ state: 'queued', result: undefined }),
  [K(5)]: entry({ state: 'running', result: undefined, startedAt: T0 }),
  [K(6)]: entry({ state: 'cancelled', result: undefined }),
};

const BADGE_TITLE = '本次会话内最近一次测试结果；保存或刷新后清空';

/* ---------------- §2.5 前四行：键、状态、文案、建议 ---------------- */

describe('MT testKey / resultState', () => {
  it('MT testKey：route|modelId', () => {
    expect(testKey('gpt-gateway', 'gpt-6-luna')).toBe('gpt-gateway|gpt-6-luna');
    expect(testKey(DS_ROUTE_ID, 'deepseek-v4-pro')).toBe('deepseek-official|deepseek-v4-pro');
  });

  it('MT resultState：ok / transient / fail', () => {
    expect(resultState(result())).toBe('ok');
    expect(resultState(failResult({ transient: true, errorKind: 'RATE_LIMIT', status: 429 }))).toBe('transient');
    expect(resultState(failResult())).toBe('fail');
  });
});

/** 契约 §2.5 文案表：short / long / transient（transient 由 Host 判定，Client 只透传）。 */
const KIND_TABLE: Array<[string, string, string, boolean]> = [
  ['AUTH', '鉴权失败', '鉴权失败（401/403），检查 API Key', false],
  ['INVALID_CREDENTIAL', '凭证无效', 'API Key 无效', false],
  ['MISSING_CREDENTIAL', '未配置 Key', '未配置 API Key', false],
  ['QUOTA', '额度不足', '余额或额度不足', false],
  ['RATE_LIMIT', '被限流', '被限流（429），稍后重试', true],
  ['SERVER', '服务端错误', '服务端错误（5xx），稍后重试', true],
  ['TRANSPORT', '网络不可达', '网络不可达，稍后重试', true],
  ['TIMEOUT', '超时', '超时（20s），稍后重试', true],
  ['INVALID_REQUEST', '请求被拒', '请求被拒', false],
  ['HTTP_404', '模型不存在', '请求被拒或模型不存在（404）', false],
  ['UNKNOWN_MODEL', '未注册', '模型未在配置中注册', false],
  ['INVALID_CONFIG', '配置无效', '提供方配置无效', false],
  ['NO_ADAPTER', '尚未生效', '提供方尚未生效，刚保存时可能出现，稍后重试', true],
  ['UNSUPPORTED_REASONING_EFFORT', '档位不支持', '模型不支持所选推理档', false],
  ['EMPTY_RESPONSE', '空响应', '模型没有返回内容，稍后重试', true],
  ['ABORTED', '已中断', '请求被中断', false],
  ['PI_AI_ERROR', '未知错误', '未分类错误', false],
  ['UNKNOWN', '未知错误', '未分类错误', false],
  ['BUSY', '正在测试', 'Host 正忙，稍后重试', true],
  ['HOST_UNAVAILABLE', '服务不可用', 'Host 暂时不可用，稍后重试', true],
  ['HOST_UNREACHABLE', '连不上 Host', '连不上 Host，稍后重试', true],
  ['HOST_ERROR', '测试失败', '测试请求失败', false],
];

describe('MT kindText 文案表（22 个 errorKind 的 short/long/transient）', () => {
  it.each(KIND_TABLE)('MT kindText %s', (kind, short, long, transient) => {
    expect(kindText(kind)).toEqual({ short, long });
    expect(resultState(failResult({ errorKind: kind, transient, status: null }))).toBe(transient ? 'transient' : 'fail');
  });

  it('MT kindText：未知 HTTP_<n> 与其它未知', () => {
    expect(kindText('HTTP_418')).toEqual({ short: 'HTTP 418', long: '请求失败（HTTP 418）' });
    expect(kindText('HTTP_503')).toEqual({ short: 'HTTP 503', long: '请求失败（HTTP 503）' });
    expect(kindText('NOT_A_KIND')).toEqual({ short: '未知错误', long: '未分类错误' });
  });
});

/** ADVICE：原型 :495-503 七条 + INVALID_CREDENTIAL 同 AUTH、UNSUPPORTED_REASONING_EFFORT 同 INVALID_REQUEST。 */
const ADVICE_TABLE: Array<[string, string]> = [
  ['AUTH', '到「编辑接入」核对 API Key 和 baseURL。'],
  ['INVALID_CREDENTIAL', '到「编辑接入」核对 API Key 和 baseURL。'],
  ['MISSING_CREDENTIAL', '这次没有发出请求。到「编辑接入」填写 API Key 并保存后再测。'],
  ['QUOTA', '到提供方后台充值或调整额度，再重测。'],
  ['INVALID_REQUEST', '检查模型的思考档位和输入类型是否被这个模型支持。'],
  ['UNSUPPORTED_REASONING_EFFORT', '检查模型的思考档位和输入类型是否被这个模型支持。'],
  ['HTTP_404', '核对模型 ID 是否和提供方文档一致。'],
  ['UNKNOWN_MODEL', '保存配置后再测；仍出现说明这个模型没有写进配置。'],
  ['PI_AI_ERROR', '复制详情排查，或稍后重测。'],
  ['UNKNOWN', '复制详情排查，或稍后重测。'],
];

describe('MT adviceText', () => {
  it.each(ADVICE_TABLE)('MT adviceText %s', (kind, advice) => {
    expect(adviceText(failResult({ errorKind: kind, transient: false }))).toBe(advice);
  });

  it('MT adviceText：ok 与 transient 优先于 ADVICE', () => {
    expect(adviceText(result())).toBe('这个模型能正常返回。');
    expect(adviceText(failResult({ errorKind: 'AUTH', transient: true }))).toBe('暂时性失败，通常稍后重试即可。');
  });
});

/* ---------------- §2.5 时间与状态 ---------------- */

describe('MT fmtMs / fmtClock / stateTone', () => {
  it('MT fmtMs：null / <1000 ms / <10000 s（1 位小数）/ 整秒', () => {
    expect(fmtMs(null)).toBe('—');
    expect(fmtMs(812)).toBe('812 ms');
    expect(fmtMs(999)).toBe('999 ms');
    expect(fmtMs(1000)).toBe('1.0 s');
    expect(fmtMs(1200)).toBe('1.2 s');
    expect(fmtMs(9950)).toBe('9.9 s');
    expect(fmtMs(20000)).toBe('20 s');
  });

  it('MT fmtClock：本地 HH:MM:SS，.slice(3) 即状态条的 MM:SS', () => {
    // 用本地时间构造，任何时区下都是同一串（不写死 UTC 偏移）。
    const epoch = new Date(2026, 9, 8, 2, 40, 5).getTime();
    expect(fmtClock(epoch)).toBe('02:40:05');
    expect(fmtClock(epoch).slice(3)).toBe('40:05');
    expect(fmtClock(new Date(2026, 11, 31, 23, 59, 9).getTime())).toBe('23:59:09');
  });

  it('MT stateTone：ok→success、fail→error、transient→warn、其余→muted', () => {
    expect(stateTone('ok')).toBe('success');
    expect(stateTone('fail')).toBe('error');
    expect(stateTone('transient')).toBe('warn');
    for (const state of ['queued', 'running', 'cancelled'] as const) {
      expect(stateTone(state), state).toBe('muted');
    }
  });
});

/* ---------------- §2.5 条带、详情、批量 ---------------- */

describe('MT stripLine / stripAria', () => {
  it('MT stripLine：queued / running / cancelled / ok / fail / transient', () => {
    expect(stripLine(entry({ state: 'queued', result: undefined }))).toBe('排队中 · 并发上限 3');
    expect(stripLine(entry({ state: 'cancelled', result: undefined }))).toBe('已取消 · 未发出请求');
    expect(stripLine(entry())).toBe('可用 · 812 ms · 首 token 341 ms');
    expect(stripLine(entry({ state: 'fail', result: failResult() }))).toBe('鉴权失败 · AUTH · 401');
    expect(stripLine(entry({ state: 'fail', result: failResult({ status: null }) }))).toBe('鉴权失败 · AUTH');
    expect(stripLine(entry({ state: 'transient', result: failResult({ errorKind: 'RATE_LIMIT', status: 429, transient: true }) })))
      .toBe('被限流 · RATE_LIMIT · 429');

    // running 的秒数来自本地时钟：3.4 秒前开始 → `已等 3.4s / 20s`（只做区间断言，避免抖动）。
    const running = stripLine(entry({ state: 'running', result: undefined, startedAt: Date.now() - 3400 }));
    expect(running).toMatch(/^测试中 · 已等 3\.[0-9]s \/ 20s$/);
  });

  it('MT stripAria：ok / fail / transient，open 时末尾为收起详情', () => {
    expect(stripAria('gpt-6-luna', entry(), false)).toBe('gpt-6-luna 可用，总耗时 812 ms，首 token 341 ms。查看详情');
    expect(stripAria('gpt-6-luna', entry(), true)).toBe('gpt-6-luna 可用，总耗时 812 ms，首 token 341 ms。收起详情');
    expect(stripAria('gpt-6-luna', entry({ state: 'fail', result: failResult() }), false))
      .toBe('gpt-6-luna 失败：鉴权失败（401/403），检查 API Key。查看详情');
    expect(stripAria('gpt-6-luna', entry({ state: 'transient', result: failResult({ errorKind: 'RATE_LIMIT', status: 429, transient: true }) }), false))
      .toBe('gpt-6-luna 暂时失败，可重试：被限流（429），稍后重试。查看详情');
  });
});

describe('MT verdictText / effortText / paramsText', () => {
  it('MT verdictText：可用 / max-tokens 截断 / 失败用 long', () => {
    expect(verdictText(result())).toBe('可用');
    expect(verdictText(result({ finish: 'max-tokens' }))).toBe('可用（输出到 maxTokens 截断，仍算可用）');
    expect(verdictText(failResult())).toBe('鉴权失败（401/403），检查 API Key');
  });

  it('MT effortText：null / DS 的 off / 其它 off / 最低档', () => {
    expect(effortText('gpt-gateway', null)).toBe('无推理档');
    expect(effortText(DS_ROUTE_ID, 'off')).toBe('off（临时关闭思考）');
    expect(effortText('gpt-gateway', 'off')).toBe('off');
    expect(effortText('gpt-gateway', 'low')).toBe('low（该模型最低档）');
  });

  it('MT paramsText：逐字打印请求参数', () => {
    expect(paramsText(result(), 'gpt-gateway')).toBe(
      '短提示「只回复 OK」 · maxTokens 32 · 推理档 off · 超时 20s（固定总时限，与提供方流空闲超时无关）',
    );
    expect(paramsText(result(), DS_ROUTE_ID)).toBe(
      '短提示「只回复 OK」 · maxTokens 32 · 推理档 off（临时关闭思考） · 超时 20s（固定总时限，与提供方流空闲超时无关）',
    );
    expect(paramsText(result({ params: { effort: null, maxTokens: 32, timeoutMs: 20000 } }), 'gpt-gateway')).toBe(
      '短提示「只回复 OK」 · maxTokens 32 · 推理档 无推理档 · 超时 20s（固定总时限，与提供方流空闲超时无关）',
    );
  });
});

describe('MT batchStats / progressText / batchTitle / batchSub / segStates', () => {
  const stats = batchStats(batch(), MIX_RESULTS);

  it('MT batchStats：9 个计数（done=ok+fail+transient，failed=fail+transient）', () => {
    expect(stats).toEqual({
      total: 6, ok: 1, fail: 1, transient: 1, cancelled: 1, running: 1, queued: 1, done: 3, failed: 2,
    });
  });

  it('MT progressText：已完成 d/t，失败 f', () => {
    expect(progressText(stats)).toBe('已完成 3/6，失败 2');
  });

  it('MT batchTitle：进行中 / 正在停止 / 已停止 / 测试完成', () => {
    expect(batchTitle(batch(), stats)).toBe('已完成 3/6，失败 2');
    expect(batchTitle(batch({ stopped: true }), stats)).toBe('正在停止 · 已完成 3/6，失败 2');
    expect(batchTitle(batch({ done: true }), stats)).toBe('测试完成');
    expect(batchTitle(batch({ done: true, stopped: true }), stats)).toBe('已停止');
  });

  it('MT batchSub：进行中 / 停止中 / 结束', () => {
    expect(batchSub(batch(), stats, T0 + 1000)).toBe('全部模型 · 并发 3 · 单个超时 20s');
    expect(batchSub(batch({ stopped: true }), stats, T0 + 1000)).toBe('未开始的已取消，等待 1 个已发出的请求返回');
    expect(batchSub(batch({ done: true, endedAt: T0 + 20000 }), stats, T0 + 20000)).toBe('全部模型 · 用时 20 s');
  });

  it('MT segStates：与 keys 同序，缺条目回落 queued', () => {
    expect(segStates(batch(), MIX_RESULTS)).toEqual(['ok', 'fail', 'transient', 'queued', 'running', 'cancelled']);
    expect(segStates(batch({ keys: [K(1), 'gpt-gateway|m9'] }), MIX_RESULTS)).toEqual(['ok', 'queued']);
  });
});

describe('MT badge / doneAnnounce / resultAnnounce', () => {
  const providerKeys = [K(1), K(2), K(3)];

  it('MT badge：未 done → muted 测试中 d/t', () => {
    expect(badge(KEYS, MIX_RESULTS, batch())).toEqual({ tone: 'muted', text: '测试中 3/6', title: BADGE_TITLE });
  });

  it('MT badge：未测（无 result）→ null', () => {
    expect(badge(providerKeys, {}, undefined)).toBeNull();
  });

  it('MT badge：有 fail → error（fail+transient 个失败 · ok/n 可用）', () => {
    const results = { [K(1)]: entry(), [K(2)]: entry({ state: 'fail', result: failResult() }) };
    expect(badge(providerKeys, results, undefined)).toEqual({ tone: 'error', text: '1 个失败 · 1/3 可用', title: BADGE_TITLE });
  });

  it('MT badge：仅 transient → warn 1 个暂时失败 · 1/3 可用', () => {
    const results = {
      [K(1)]: entry(),
      [K(2)]: entry({ state: 'transient', result: failResult({ errorKind: 'RATE_LIMIT', status: 429, transient: true }) }),
    };
    expect(badge(providerKeys, results, undefined)).toEqual({ tone: 'warn', text: '1 个暂时失败 · 1/3 可用', title: BADGE_TITLE });
  });

  it('MT badge：全 ok 且只测了一部分 → success 带（已测 2）；全测过则不带', () => {
    const partial = { [K(1)]: entry(), [K(2)]: entry() };
    expect(badge(providerKeys, partial, undefined)).toEqual({ tone: 'success', text: '✓ 2/3 可用（已测 2）', title: BADGE_TITLE });

    const full = { [K(1)]: entry(), [K(2)]: entry(), [K(3)]: entry() };
    expect(badge(providerKeys, full, undefined)).toEqual({ tone: 'success', text: '✓ 3/3 可用', title: BADGE_TITLE });
  });

  it('MT doneAnnounce：测试完成 / 已停止（无已取消时不带该句）', () => {
    const announceStats = { total: 6, ok: 2, fail: 1, transient: 0, cancelled: 3, running: 0, queued: 0, done: 3, failed: 1 };
    expect(doneAnnounce(batch({ done: true }), announceStats)).toBe('测试完成。可用 2，失败 1。');
    expect(doneAnnounce(batch({ done: true, stopped: true }), announceStats)).toBe('已停止。可用 2，失败 1，已取消 3。');
    expect(doneAnnounce(batch({ done: true, stopped: true }), { ...announceStats, cancelled: 0 })).toBe('已停止。可用 2，失败 1。');
  });

  it('MT resultAnnounce：可用 / 失败 / 暂时失败', () => {
    expect(resultAnnounce('gpt-6-luna', result())).toBe('gpt-6-luna 可用，耗时 812 ms');
    expect(resultAnnounce('gpt-6-luna', failResult())).toBe('gpt-6-luna 失败：鉴权失败');
    expect(resultAnnounce('gpt-6-luna', failResult({ errorKind: 'RATE_LIMIT', transient: true, status: 429 })))
      .toBe('gpt-6-luna 暂时失败：被限流');
  });
});

describe('MT testDetailText', () => {
  it('MT testDetailText：model/provider/testedAt + result，2 空格缩进', () => {
    const e = entry({ state: 'fail', result: failResult({ message: 'Incorrect API Key' }) });
    const text = testDetailText('gpt-gateway', 'gpt-6-luna', e);
    const parsed = JSON.parse(text) as Record<string, unknown>;

    expect(parsed).toEqual({ model: 'gpt-6-luna', provider: 'gpt-gateway', testedAt: e.result!.testedAt, ...e.result });
    expect(parsed).not.toHaveProperty('state');
    expect(parsed).not.toHaveProperty('at');
    expect(text).toContain('\n  "model": "gpt-6-luna"');
  });
});

/* ---------------- §2.4 门控 ---------------- */

interface GateInput {
  hostUnsupported: boolean;
  saving: boolean;
  isNew: boolean;
  dirty: boolean;
  secretPending: boolean;
}

function gate(over: Partial<GateInput> = {}): string | null {
  return blockReason({ hostUnsupported: false, saving: false, isNew: false, dirty: false, secretPending: false, ...over });
}

describe('MT blockReason：五个分支与优先级', () => {
  it('MT blockReason：都不成立 → null', () => {
    expect(gate()).toBeNull();
  });

  it('MT blockReason：hostUnsupported → 不支持文案', () => {
    expect(gate({ hostUnsupported: true })).toBe('当前 Host 不支持模型测试，重启 DSH 后可用');
    expect(gate({ hostUnsupported: true, saving: true, isNew: true, dirty: true, secretPending: true }))
      .toBe('当前 Host 不支持模型测试，重启 DSH 后可用');
  });

  it('MT blockReason：saving → 正在保存，稍后再测', () => {
    expect(gate({ saving: true })).toBe('正在保存，稍后再测');
    expect(gate({ saving: true, isNew: true, dirty: true, secretPending: true })).toBe('正在保存，稍后再测');
  });

  it('MT blockReason：isNew → 先保存再测试：这个提供方还没保存', () => {
    expect(gate({ isNew: true })).toBe('先保存再测试：这个提供方还没保存');
    expect(gate({ isNew: true, dirty: true, secretPending: true })).toBe('先保存再测试：这个提供方还没保存');
  });

  it('MT blockReason：dirty → 先保存再测试：Host 还不知道这个提供方的未保存改动', () => {
    expect(gate({ dirty: true })).toBe('先保存再测试：Host 还不知道这个提供方的未保存改动');
    expect(gate({ dirty: true, secretPending: true })).toBe('先保存再测试：Host 还不知道这个提供方的未保存改动');
  });

  it('MT blockReason：secretPending → 先保存再测试：API Key 还没保存', () => {
    expect(gate({ secretPending: true })).toBe('先保存再测试：API Key 还没保存');
  });
});
