/**
 * R4a 模型可用性测试的纯逻辑（docs/specs/r4a-model-test.md §2.4、§2.5）。
 *
 * 只做键、状态、文案与统计；不持有状态、不发请求。文案逐字来自契约与原型
 * docs/design/model-capabilities/model-test-prototype.html。
 */
import {
  DS_ROUTE_ID,
  type ModelTestResult,
  type TestBatch,
  type TestEntry,
  type TestState,
} from './types';

/** 测试并发上限与单个总时限（展示用；Host 侧为准）。 */
export const TEST_CONCURRENCY = 3;
export const TEST_TIMEOUT_TEXT = '20s';

export const BADGE_TITLE = '本次会话内最近一次测试结果；保存或刷新后清空';

export type TestTone = 'success' | 'error' | 'warn' | 'muted';

export interface KindText {
  short: string;
  long: string;
}

export interface BatchStats {
  total: number;
  ok: number;
  fail: number;
  transient: number;
  cancelled: number;
  running: number;
  queued: number;
  /** ok + fail + transient */
  done: number;
  /** fail + transient */
  failed: number;
}

export interface TestBadge {
  tone: TestTone;
  text: string;
  title: string;
}

export interface BlockInput {
  hostUnsupported: boolean;
  saving: boolean;
  isNew: boolean;
  dirty: boolean;
  secretPending: boolean;
}

/* ---------------- 文案表 ---------------- */

const KIND: Record<string, KindText> = {
  AUTH: { short: '鉴权失败', long: '鉴权失败（401/403），检查 API Key' },
  INVALID_CREDENTIAL: { short: '凭证无效', long: 'API Key 无效' },
  MISSING_CREDENTIAL: { short: '未配置 Key', long: '未配置 API Key' },
  QUOTA: { short: '额度不足', long: '余额或额度不足' },
  RATE_LIMIT: { short: '被限流', long: '被限流（429），稍后重试' },
  SERVER: { short: '服务端错误', long: '服务端错误（5xx），稍后重试' },
  TRANSPORT: { short: '网络不可达', long: '网络不可达，稍后重试' },
  TIMEOUT: { short: '超时', long: '超时（20s），稍后重试' },
  INVALID_REQUEST: { short: '请求被拒', long: '请求被拒' },
  HTTP_404: { short: '模型不存在', long: '请求被拒或模型不存在（404）' },
  UNKNOWN_MODEL: { short: '未注册', long: '模型未在配置中注册' },
  INVALID_CONFIG: { short: '配置无效', long: '提供方配置无效' },
  NO_ADAPTER: { short: '尚未生效', long: '提供方尚未生效，刚保存时可能出现，稍后重试' },
  UNSUPPORTED_REASONING_EFFORT: { short: '档位不支持', long: '模型不支持所选推理档' },
  EMPTY_RESPONSE: { short: '空响应', long: '模型没有返回内容，稍后重试' },
  ABORTED: { short: '已中断', long: '请求被中断' },
  PI_AI_ERROR: { short: '未知错误', long: '未分类错误' },
  UNKNOWN: { short: '未知错误', long: '未分类错误' },
  BUSY: { short: '正在测试', long: 'Host 正忙，稍后重试' },
  HOST_UNAVAILABLE: { short: '服务不可用', long: 'Host 暂时不可用，稍后重试' },
  HOST_UNREACHABLE: { short: '连不上 Host', long: '连不上 Host，稍后重试' },
  HOST_ERROR: { short: '测试失败', long: '测试请求失败' },
};

/** 原型 :495-503 的七条，另加 INVALID_CREDENTIAL 同 AUTH、UNSUPPORTED_REASONING_EFFORT 同 INVALID_REQUEST。 */
const ADVICE: Record<string, string> = {
  AUTH: '到「编辑接入」核对 API Key 和 baseURL。',
  MISSING_CREDENTIAL: '这次没有发出请求。到「编辑接入」填写 API Key 并保存后再测。',
  QUOTA: '到提供方后台充值或调整额度，再重测。',
  INVALID_REQUEST: '检查模型的思考档位和输入类型是否被这个模型支持。',
  HTTP_404: '核对模型 ID 是否和提供方文档一致。',
  UNKNOWN_MODEL: '保存配置后再测；仍出现说明这个模型没有写进配置。',
  PI_AI_ERROR: '复制详情排查，或稍后重测。',
};
ADVICE.INVALID_CREDENTIAL = ADVICE.AUTH;
ADVICE.UNSUPPORTED_REASONING_EFFORT = ADVICE.INVALID_REQUEST;

const OK_ADVICE = '这个模型能正常返回。';
const TRANSIENT_ADVICE = '暂时性失败，通常稍后重试即可。';
const FALLBACK_ADVICE = '复制详情排查，或稍后重测。';

/* ---------------- §2.4 门控 ---------------- */

export function blockReason(input: BlockInput): string | null {
  if (input.hostUnsupported) return '当前 Host 不支持模型测试，重启 DSH 后可用';
  if (input.saving) return '正在保存，稍后再测';
  if (input.isNew) return '先保存再测试：这个提供方还没保存';
  if (input.dirty) return '先保存再测试：Host 还不知道这个提供方的未保存改动';
  if (input.secretPending) return '先保存再测试：API Key 还没保存';
  return null;
}

/* ---------------- §2.5 ---------------- */

export function testKey(route: string, modelId: string): string {
  return `${route}|${modelId}`;
}

export function resultState(res: ModelTestResult): 'ok' | 'transient' | 'fail' {
  return res.ok ? 'ok' : res.transient ? 'transient' : 'fail';
}

export function kindText(kind: string | null | undefined): KindText {
  const k = kind ?? 'UNKNOWN';
  const known = KIND[k];
  if (known) return { ...known };
  const http = /^HTTP_(\d+)$/.exec(k);
  if (http) return { short: `HTTP ${http[1]}`, long: `请求失败（HTTP ${http[1]}）` };
  return { short: '未知错误', long: '未分类错误' };
}

export function adviceText(res: ModelTestResult): string {
  if (res.ok) return OK_ADVICE;
  if (res.transient) return TRANSIENT_ADVICE;
  return (res.errorKind && ADVICE[res.errorKind]) || FALLBACK_ADVICE;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

export function fmtClock(epoch: number): string {
  const d = new Date(epoch);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function stateTone(state: TestState): TestTone {
  if (state === 'ok') return 'success';
  if (state === 'fail') return 'error';
  if (state === 'transient') return 'warn';
  return 'muted';
}

/** running 的已等秒数；没有 startedAt（含 SSR 初始渲染）时为 `0.0`。 */
function waitedSeconds(entry: TestEntry, now: number): string {
  if (entry.startedAt === undefined) return '0.0';
  return (Math.max(0, now - entry.startedAt) / 1000).toFixed(1);
}

function failCode(res: ModelTestResult): string {
  const kind = res.errorKind ?? 'UNKNOWN';
  return res.status ? `${kind} · ${res.status}` : kind;
}

/** 状态条第二行。`now` 仅用于 running 的计时（组件每 100ms 传入）。 */
export function stripLine(entry: TestEntry, now: number = Date.now()): string {
  switch (entry.state) {
    case 'queued':
      return `排队中 · 并发上限 ${TEST_CONCURRENCY}`;
    case 'running':
      return `测试中 · 已等 ${waitedSeconds(entry, now)}s / ${TEST_TIMEOUT_TEXT}`;
    case 'cancelled':
      return '已取消 · 未发出请求';
    default: {
      const res = entry.result;
      if (!res) return '';
      if (entry.state === 'ok') return `可用 · ${fmtMs(res.latencyMs)} · 首 token ${fmtMs(res.firstTokenMs)}`;
      return `${kindText(res.errorKind).short} · ${failCode(res)}`;
    }
  }
}

export function stripAria(id: string, entry: TestEntry, open: boolean): string {
  const tail = open ? '收起详情' : '查看详情';
  const res = entry.result;
  if (!res || (entry.state !== 'ok' && entry.state !== 'fail' && entry.state !== 'transient')) {
    return `${id} ${stripLine(entry)}`;
  }
  if (entry.state === 'ok') return `${id} 可用，总耗时 ${fmtMs(res.latencyMs)}，首 token ${fmtMs(res.firstTokenMs)}。${tail}`;
  const long = kindText(res.errorKind).long;
  if (entry.state === 'transient') return `${id} 暂时失败，可重试：${long}。${tail}`;
  return `${id} 失败：${long}。${tail}`;
}

export function verdictText(res: ModelTestResult): string {
  if (res.ok) return res.finish === 'max-tokens' ? '可用（输出到 maxTokens 截断，仍算可用）' : '可用';
  return kindText(res.errorKind).long;
}

export function effortText(route: string, effort: string | null | undefined): string {
  if (effort == null) return '无推理档';
  if (effort === 'off') return route === DS_ROUTE_ID ? 'off（临时关闭思考）' : 'off';
  return `${effort}（该模型最低档）`;
}

export function paramsText(res: ModelTestResult, route: string): string {
  return `短提示「只回复 OK」 · maxTokens ${res.params.maxTokens} · 推理档 ${effortText(route, res.params.effort)} · 超时 ${TEST_TIMEOUT_TEXT}（固定总时限，与提供方流空闲超时无关）`;
}

export function batchStats(batch: TestBatch, results: Record<string, TestEntry>): BatchStats {
  const s: BatchStats = { total: batch.keys.length, ok: 0, fail: 0, transient: 0, cancelled: 0, running: 0, queued: 0, done: 0, failed: 0 };
  for (const state of segStates(batch, results)) s[state] += 1;
  s.done = s.ok + s.fail + s.transient;
  s.failed = s.fail + s.transient;
  return s;
}

export function progressText(s: BatchStats): string {
  return `已完成 ${s.done}/${s.total}，失败 ${s.failed}`;
}

export function batchTitle(batch: TestBatch, s: BatchStats): string {
  if (batch.done) return batch.stopped ? '已停止' : '测试完成';
  return `${batch.stopped ? '正在停止 · ' : ''}${progressText(s)}`;
}

export function batchSub(batch: TestBatch, s: BatchStats, now: number): string {
  if (batch.done) return `${batch.label} · 用时 ${fmtMs((batch.endedAt ?? now) - batch.startedAt)}`;
  if (batch.stopped) return `未开始的已取消，等待 ${s.running} 个已发出的请求返回`;
  return `${batch.label} · 并发 ${TEST_CONCURRENCY} · 单个超时 ${TEST_TIMEOUT_TEXT}`;
}

/** 与 `batch.keys` 同序；缺条目回落 'queued'。 */
export function segStates(batch: TestBatch, results: Record<string, TestEntry>): TestState[] {
  return batch.keys.map((key) => results[key]?.state ?? 'queued');
}

/** 提供方徽标；`models` 是该提供方的 testKey 列表。 */
export function badge(models: string[], results: Record<string, TestEntry>, batch: TestBatch | undefined): TestBadge | null {
  if (batch && !batch.done) {
    const s = batchStats(batch, results);
    return { tone: 'muted', text: `测试中 ${s.done}/${s.total}`, title: BADGE_TITLE };
  }
  let tested = 0;
  let ok = 0;
  let fail = 0;
  let transient = 0;
  for (const key of models) {
    const entry = results[key];
    if (!entry?.result) continue;
    tested += 1;
    if (entry.state === 'ok') ok += 1;
    else if (entry.state === 'transient') transient += 1;
    else if (entry.state === 'fail') fail += 1;
  }
  if (!tested) return null;
  const n = models.length;
  if (fail) return { tone: 'error', text: `${fail + transient} 个失败 · ${ok}/${n} 可用`, title: BADGE_TITLE };
  if (transient) return { tone: 'warn', text: `${transient} 个暂时失败 · ${ok}/${n} 可用`, title: BADGE_TITLE };
  return { tone: 'success', text: `✓ ${ok}/${n} 可用${tested < n ? `（已测 ${tested}）` : ''}`, title: BADGE_TITLE };
}

export function doneAnnounce(batch: TestBatch, s: BatchStats): string {
  if (!batch.stopped) return `测试完成。可用 ${s.ok}，失败 ${s.failed}。`;
  return `已停止。可用 ${s.ok}，失败 ${s.failed}${s.cancelled ? `，已取消 ${s.cancelled}` : ''}。`;
}

export function resultAnnounce(id: string, res: ModelTestResult): string {
  if (res.ok) return `${id} 可用，耗时 ${fmtMs(res.latencyMs)}`;
  const short = kindText(res.errorKind).short;
  return res.transient ? `${id} 暂时失败：${short}` : `${id} 失败：${short}`;
}

/** 复制用的详情 JSON；result 来自 Host，message 已脱敏。 */
export function testDetailText(route: string, id: string, entry: TestEntry | undefined): string {
  const res = entry?.result;
  if (!res) return JSON.stringify({ model: id, provider: route }, null, 2);
  // 契约：{model, provider, testedAt, ...result}，结果里的同名字段以 Host 返回为准，只决定键序。
  const { model, provider, testedAt, ...rest } = res;
  return JSON.stringify({ model, provider, testedAt, ...rest }, null, 2);
}
