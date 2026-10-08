# R4a 增量契约：模型可用性测试

## 0. 约束与已定决策
- 事实来源：`docs/specs/r4-research-notes.md`（下称「调研」）；UI 以 `docs/design/model-capabilities/model-test-prototype.html`（下称「原型」）为准，内容区 564px。流空闲超时 `streamIdleTimeoutMs` 归 r4b，本文不设计。
- 用户已批准：① 新增 1 条 Host 路由并发真实请求（会验证 API Key），修订 K14「不新增 Host 路由」与 `docs/requirements.md:17` 全局非目标；② 批量（>1 个模型）先弹费用确认；③ 提供方或其凭证未保存、或提供方是新建的，禁止测试。
- 每次测试 = 1 次真实请求：短提示「只回复 OK」、`maxTokens 32`、最低推理档、总时限 20s（与 `streamIdleTimeoutMs` 无关）、`temperature 0`、不带 `sessionId`。
- 并发：Client 队列并发 3，逐条返回，「停止」取消排队项；Host 全局信号量 3，超出直接 409 BUSY（不排队，避免 HTTP 请求挂起），同一 `provider+model` 在途也 409 BUSY。
- 结果只存在 store 内存，不写配置；保存成功、重新加载、远端刷新后清空；放弃不清空（只测已保存配置，放弃不改变基线）。
- Client 硬约束不变（`model-capabilities.md:5,156`）：不新增依赖、不引入 jsdom/Testing Library、不从 `@deepseek-ai/*` 引入、只用 `styles.ts` 内联样式、无颜色字面量、禁止 `--mc-*` / `--dsw-radius-*` / 动画。原型里的 `--mc-ok-text`、`--mc-*-soft`、spin/pulse 动画一律映射到 `C.success / C.error / C.warn / C.fg2` 加边框，静态圆环代替旋转。
- 向后兼容：store 的 tester 是可选注入；未注入时 `snap.test === undefined`，所有测试 UI 不渲染，现有 909 个测试与 SSR 断言不变。

## 1. Host
### 1.1 路由 `POST /plugins/dsh-wuyou-agent/api/models/test`
追加在 `createRoutes` 返回数组**末尾**（第 10 条）。请求体（`readJsonBody`，1MB 上限）：
```json
{ "provider": "openrouter", "model": "openai/gpt-4.1-mini" }
```
- `provider`、`model`：非空字符串（先 `trim()` 判空，纯空白视为空，报错仍为 `字段 provider 必须是非空字符串` / `字段 model 必须是非空字符串`；传给 probe 的值保持原样不 trim），≤256 字符；其它键一律 400。DeepSeek 官方传 `deepseek-official`（调研 §2：pi-ai 路由 key 即运行时 id）。

200 响应（模型成功或失败都是 200）：
```json
{
  "provider": "openrouter", "model": "openai/gpt-4.1-mini",
  "ok": true, "latencyMs": 812, "firstTokenMs": 341, "sample": "OK",
  "finish": "stop", "errorKind": null, "status": null, "message": "", "transient": false,
  "params": { "effort": "off", "maxTokens": 32, "timeoutMs": 20000 },
  "testedAt": "2026-10-08T02:40:00.000Z"
}
```
| 字段 | 规则 |
|---|---|
| `ok` | finish 为 `stop`/`max-tokens`/`tool-calls` 时 true，其余 false |
| `latencyMs` | 调 `stream` 前到结束（含超时）`now()` 差，整数 |
| `firstTokenMs` | 第一个 `text-delta` 或 `reasoning-delta` 的到达时间差；没有则 `null` |
| `sample` | 只拼 `text-delta`，去控制字符、折叠空白、trim，按码点截到 80（不加省略号）；失败时 `""` |
| `finish` | `stop`/`max-tokens`/`tool-calls`/`error`/`aborted`/`timeout`/`none`（流结束没有 finish chunk）/`null`（未发请求） |
| `errorKind` | ok 时 `null`；否则见 1.3 枚举 |
| `status` | `failure.status` 为整数则取；否则 `errorKind` 形如 `HTTP_<n>` 时取 n；否则 `null` |
| `message` | `maskMessage(failure.message 或 err.message)`；ok 时 `""` |
| `transient` | `errorKind ∈ TRANSIENT_KINDS`（Host 判定，Client 不另算） |
| `params.effort` | 实际传给 `stream` 的 `reasoningEffort`；模型无推理档时 `null` |

HTTP 码：
| 情况 | 码 | body |
|---|---|---|
| 非 POST | 405，`allow: POST`，空体（复用 `requirePost`） | — |
| 非 JSON / 非对象 / 字段缺失或类型错 / 未知键 / 超长 | 400 `INVALID` | `字段 provider 必须是非空字符串`、`字段 model 长度不能超过 256`、`字段 x 不支持` |
| 体积 >1MB | 413 `PAYLOAD_TOO_LARGE` | 原文 |
| `getLlm()` 为空，或 `llm.stream` 不是函数 | 503 `DEPENDENCY_UNAVAILABLE` | `当前 DSH 未提供 LLM 服务，无法测试模型` |
| 同一 provider+model 在途 | 409 `BUSY` | `模型 ${model} 正在测试，请稍候` |
| 全局在途已 3 个 | 409 `BUSY` | `同时最多测试 3 个模型，请稍后重试` |
| probe 意外抛错 | 500 `INTERNAL`（`errorResponse` 不泄露） | `服务端内部错误` |

处理顺序：requirePost → 读体并校验 → 503 检查 → 同键 409 → 全局 409 → 占位（`testing.add(key)`、`active++`）→ 建 `AbortController`，`res.on?.('close', …)` 在 `!res.writableEnded` 时 abort → `await (context.probeModel ?? probeModel)({provider, model}, {llm, signal})` → 未断开才 `sendJson(200, {provider, model, ...result})` → `finally` 释放两个占位。key = `${provider}\u0000${model}`。

### 1.2 `src/host/model-probe.ts`（新模块，按 `acp-probe.ts` 风格）
```ts
export const MODEL_PROBE_TIMEOUT_MS = 20_000;
export const MODEL_PROBE_MAX_TOKENS = 32;
export const MODEL_PROBE_PROMPT = '只回复 OK';
export const SAMPLE_MAX = 80;
export const MESSAGE_MAX = 300;
export const TRANSIENT_KINDS: ReadonlySet<string>; // RATE_LIMIT SERVER TIMEOUT TRANSPORT EMPTY_RESPONSE NO_ADAPTER
export type ProbeFinish = 'stop'|'max-tokens'|'tool-calls'|'error'|'aborted'|'timeout'|'none'|null;
export interface ModelProbeResult { ok; latencyMs; firstTokenMs; sample; finish; errorKind; status; message; transient;
  params: { effort: string|null; maxTokens: number; timeoutMs: number }; testedAt: string }
export interface ModelProbeDeps { llm: LLMService; signal?: AbortSignal; now?: () => number;
  timeoutMs?: number; maxTokens?: number; clock?: () => Date }
export function maskMessage(text: string): string;
export function pickEffort(efforts: Array<{ id: string }> | undefined): string | null;
export async function probeModel(target: { provider: string; model: string }, deps: ModelProbeDeps): Promise<ModelProbeResult>;
```
`probeModel` **从不抛错**。算法：
1. `t0 = now()`；内部 `ctl = new AbortController()`；`deps.signal` abort → `ctl.abort('client')`；`setTimeout(timeoutMs)` → `timedOut = true; ctl.abort('timeout')`；`finally` 清定时器与监听。
2. 预检：`llm.listProviders()` 不含 `provider`（或抛错）→ 返回 `errorKind 'NO_ADAPTER'`、`finish null`、`message '提供方尚未生效或未注册'`、不调 `resolveModelInfo`/`stream`。
3. `info = await llm.resolveModelInfo(provider, model, ctl.signal)`；抛错 → 按第 7 步映射，`finish null`，不调 `stream`。
4. `effort = pickEffort(info.reasoning?.efforts)`：列表含 `off` → `'off'`；否则取第一个 id；空或无 → `null`。
5. 调 `llm.stream({ provider, model, messages:[{role:'user',content:[{type:'text',text:MODEL_PROBE_PROMPT}]}], temperature:0, maxTokens, signal:ctl.signal, ...(effort ? {reasoningEffort:effort} : {}) })`。**不传** `sessionId`、`system`、`purpose`、`stop`。
6. 用 `for await` 迭代，并与「abort promise」竞速（适配器无视 signal 时也能在 `timeoutMs` 结束）：`text-delta`/`reasoning-delta` 首次记 `firstTokenMs`；`text-delta` 累加（累计超 4KB 后不再追加）；`finish` 记 `reason` 后 `break`。
7. 结果映射（优先级从上到下）：
   - `timedOut` → `finish 'timeout'`、`errorKind 'TIMEOUT'`、`message '超过 20s 未完成'`（秒数取 `timeoutMs/1000`）。
   - `deps.signal.aborted` → `finish 'aborted'`、`errorKind 'CLIENT_ABORTED'`（路由不会发送它）。
   - `reason.kind ∈ {stop,max-tokens,tool-calls}` → `ok true`。
   - `reason.kind ∈ {error,aborted}` → `errorKind = normCode(failure.code)`，`aborted` 且无 code 时为 `'ABORTED'`。
   - 迭代正常结束但无 finish → `finish 'none'`、`errorKind 'EMPTY_RESPONSE'`。
   - 抛错（resolve/stream/迭代/中间件）→ `finish 'error'`（resolve 阶段为 `null`），`errorKind = normCode(err.code)`。
   - `normCode(x)`：匹配 `/^[A-Z][A-Z0-9_]{0,63}$/` 则原样，否则 `'UNKNOWN'`。
8. `maskMessage`：依次 ① scheme 值：`/\b([Bb][Ee][Aa][Rr][Ee][Rr]|Basic|Token)\s+(?!\*\*\*)[^\s"',;]+/g → '<Scheme> ***'`（保留 scheme 词；`Bearer` 任意大小写并规范为 `Bearer`，`Basic`/`Token` 只认首字母大写，避免误伤 `invalid token provided` 这类文案）；② 键值：`/(?<![A-Za-z0-9])(access[-_]?token|refresh[-_]?token|client[-_]?secret|api[-_]?key|apikey|key|token|secret|password|authorization)(["']?\s*[=:]\s*["']?)(?!(?:Bearer|Basic|Token)\s+\*\*\*)(?:(?:bearer|basic|token)\s+)?[^\s"'&,;]+/gi → '$1$2***'`（左边界用 `(?<![A-Za-z0-9])` 代替 `\b`，`access_token`/`client_secret`/`x_api_key` 等下划线前缀键也命中，`monkey=`/`tokens=` 不命中；JSON `"access_token": "t-1"` → `"access_token": "***"` 保留引号；① 已遮蔽的 `Authorization: Basic ***` 跳过，① 未处理的小写 scheme 连同值一起遮蔽）；③ `/\b(sk|rk|pk)-[A-Za-z0-9_-]{6,}/g → '$1-***'`，再把长 token 整体替换为 `***`：JWT `/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g`、`/\bAIza[0-9A-Za-z_-]{20,}/g`、`/\bgh[pousr]_[A-Za-z0-9]{20,}/g`、`/\bAKIA[0-9A-Z]{16}\b/g`（不设「≥N 字符通用 token」规则，避免误伤模型 id 与 URL）；④ 控制字符与换行折成单空格、trim；⑤ 超过 `MESSAGE_MAX` 码点截断并追加 `…`。只描述、不带值的错误文案（如 `Incorrect API key provided`、`HTTP 429 Too Many Requests`）原样输出。

### 1.3 errorKind 枚举
透传：`AUTH INVALID_CREDENTIAL MISSING_CREDENTIAL QUOTA RATE_LIMIT SERVER TRANSPORT TIMEOUT INVALID_REQUEST HTTP_<status> UNKNOWN_MODEL INVALID_CONFIG NO_ADAPTER UNSUPPORTED_REASONING_EFFORT EMPTY_RESPONSE PI_AI_ERROR`（调研 §2）。本模块新增：`ABORTED`、`CLIENT_ABORTED`、`UNKNOWN`。Client 合成（不来自 Host 200）：`BUSY`、`HOST_UNAVAILABLE`、`HOST_ERROR`、`HOST_UNREACHABLE`。

### 1.4 类型与接线
- `runtime-deps.ts` 的 `LLMService` 增加可选 `stream?(options: LlmStreamOptions): AsyncIterable<LlmStreamChunk>`，并导出结构类型 `LlmStreamOptions`、`LlmStreamChunk`（`{type:'text-delta',text}|{type:'reasoning-delta'}|{type:'finish',reason:LlmFinishReason}|{type:string}`）、`LlmFinishReason`（`{kind:'stop'|'max-tokens'|'tool-calls'}|{kind:'error'|'aborted',failure?:LlmFailure}`）、`LlmFailure {message;code;status?;requestId?}`。`buildCatalogWithSource` 不变。
- `RouteContext` 增加 `getLlm?: () => LLMService | undefined`（每次请求读取，不缓存）与 `probeModel?: typeof probeModel`。
- `src/index.ts:169` 传 `getLlm: () => ctx.get('llm') as LLMService | undefined`。鉴权包装（`:194-210`）对新路由同样生效。
- `scripts/verify-runtime-deps.mjs:160` 的 `expectedRoutePaths` 末尾追加新路径（10 条）。

## 2. Client
### 2.1 api-types / api-client
`api-types.ts` 增加 `ModelTestRequest {provider;model}`、`ModelTestResult`（= 1.1 的 200 体，`finish`/`errorKind` 用 `string|null`）。`ApiClient` 增加：
```ts
testModel(body: ModelTestRequest, signal?: AbortSignal): Promise<ModelTestResult>; // POST /models/test，init 带 signal
```
`404` 且 body 无 `code` → 抛 `Error('当前 Host 不支持模型测试，重启 DSH 后可用')`，`code = 'HOST_UNSUPPORTED'`、`status 404`；其它错误按现有 `request` 规则抛（带 `code`/`status`）。导出常量 `MODEL_TEST_UNSUPPORTED` 为该文案。

### 2.2 注入
- `types.ts`：`export type ModelTester = (req: ModelTestRequest, signal: AbortSignal) => Promise<ModelTestResult>`（类型从 `../shared/api-types` 以 `import type` 引入并再导出）。`ModelCapabilitiesPort` **不变**。
- `createModelCapabilitiesStore(port, options?: { tester?: ModelTester })`。
- `registerModelCapabilities(sub, deps?: { testModel?: ModelTester })`，把 `deps.testModel` 作为 tester 传给 store。
- `src/client/index.tsx:57`：`registerModelCapabilities(sub, { testModel: (b, signal) => api.testModel(b, signal) })`，复用同一个 `api`。

### 2.3 Store 状态
`McSnapshot` 增加可选 `test?: McTestState`（仅有 tester 时存在）：
```ts
type TestState = 'queued'|'running'|'ok'|'fail'|'transient'|'cancelled';
interface TestEntry { state: TestState; result?: ModelTestResult; at?: number; startedAt?: number; prev?: TestEntry }
interface TestBatch { route: string; keys: string[]; label: '全部模型'|'所选模型'|'重试失败项'|'已取消的模型';
  stopped: boolean; done: boolean; startedAt: number; endedAt?: number }
interface McTestState { hostUnsupported: boolean; results: Record<string, TestEntry>; batches: Record<string, TestBatch>;
  open: string|null; cost: { route: string; modelIds: string[]; label: TestBatch['label'] } | null;
  skipCost: boolean; blocked: Record<string, string|null>; live: string }
```
- 键 `testKey(route, modelId) = route + '|' + modelId`（route id 不含 `|`）。
- `blocked[route]` 由 `publish` 用 `blockReason` 现算（见 2.4）。`live` 为最后一条播报文本（供 `aria-live`）。
- 闭包变量：`queue: Job[]`、`active`、`gen`（作废代号）、`seq`、`controllers: Map<string, AbortController>`；`Job = {key, route, modelId, gen, seq}`。

方法（全部加到 `ModelCapabilitiesStore`）：
| 方法 | 行为 |
|---|---|
| `testModel(route, modelId)` | 被 `blocked` → `ui.status = reason + '。'` 返回；该键 queued/running → 忽略；否则插到队首，不进批量统计 |
| `testProvider(route)` | `requestBatch(route, 全部 modelId, '全部模型')`（卡片「测试全部」） |
| `testAll()` | `testProvider(ui.route)`（选择栏「全部测试」） |
| `testSelected()` | 当前路由 `ui.sel` 下标 → modelId（去空 id、去重），`'所选模型'` |
| `retryFailed(route)` / `retryCancelled(route)` | 批次中 fail+transient / cancelled 的键，标签 `'重试失败项'` / `'已取消的模型'` |
| `stopBatch(route)` | 批次中 queued 的键 → `cancelled`（移出队列、删 `prev`），`stopped = true`；running 的等它返回；播报 `已取消 N 个未开始的测试，M 个已发出的请求会等它返回。`（M=0 时为 `已取消 N 个未开始的测试。`） |
| `dismissBatch(route)` | 仅 `done` 时删除批次 |
| `toggleTestDetail(route, modelId)` | `open` 在该键与 `null` 间切换；只对有 `result` 的键生效 |
| `confirmCost(skip: boolean)` | `skip` 为 true 置 `skipCost`；重新检查 `blocked`/批次在途，通过则 `startBatch`，关闭 `cost` |
| `cancelCost()` | 关闭 `cost`，不入队 |
| `copyTestDetail(route, modelId)` | 返回 `testDetailText(...)` 字符串并设 `ui.status = 已复制 ${id} 的测试详情（不含密钥）。`；剪贴板写入在组件里 |

`requestBatch(route, ids, label)`：blocked → status；该路由批次未 done → `正在批量测试，先等它完成或停止。`；滤掉 queued/running 的 id，空 → `没有可测试的模型。`；`ids.length > 1 && !skipCost && provider.credConfigured` → 设 `cost`；否则 `startBatch`。凭证缺失的提供方不弹确认（结果会是 MISSING_CREDENTIAL，不计费）。

`startBatch`：替换该路由旧批次；每个键 `enqueue`（`prev` = 原非忙条目）；播报 `开始测试 N 个模型，并发 3。`；`pump()`。
`pump()`：`while (active < 3 && queue.length)` 取队首；跳过 `gen` 过期或状态非 queued 的；`active++`、state `running`、`startedAt = Date.now()`；`tester({provider: route, model}, ctl.signal)`。
回包：`job.gen !== gen` 或 `results[key]` 已不是同一 `seq` → 丢弃（只 `active--`、`pump`）。成功 → state = `ok`/`transient`/`fail`（`resultState`）、`at = Date.now()`、删 `prev`、播报 `resultAnnounce`（批次中再接 `。` + `progressText`），检查批次完成：无 running/queued → `done = true`、`endedAt`，播报 `doneAnnounce`。
抛错：`code === 'HOST_UNSUPPORTED'` → `hostUnsupported = true`，abort 全部控制器、`gen++`、清队列、queued/running 还原 `prev`（无则删除）、清空 `batches` 与 `cost`、`ui.status = MODEL_TEST_UNSUPPORTED`。其它 → 合成 `ModelTestResult`（`ok false`、`latencyMs null`→ 用 0、`sample ''`、`finish null`、`message err.message`、`params` 取默认）：`status 409 && code 'BUSY'` → `BUSY` transient；`503` → `HOST_UNAVAILABLE` transient；无 `status` 且 `err instanceof TypeError`（fetch 网络失败）→ `HOST_UNREACHABLE` transient；其余（含无 `status` 的普通 Error）→ `HOST_ERROR` 非 transient。tester 是注入依赖，按契约违规兜底：同步抛错 → 按 reject 处理；返回非 thenable → 以 `new Error('tester 返回值不是 Promise')` reject（普通 Error，不会被当成网络失败），两者都落终态 `fail`/`HOST_ERROR`，经 settle 归还并发槽，队列继续推进，异常不抛回调用方。`AbortError` 只在 gen 过期时出现，按丢弃处理。

清空规则：`resetFromDescribe`（load、reload、远端回声、adapters-updated、connection/reset）与 `save` 成功收尾时调用 `clearTests()`：`gen++`、abort 全部、清队列/`active=0`、`results={}`、`batches={}`、`open=null`、`cost=null`、`hostUnsupported=false`；`skipCost` 保留。`save` 期间禁止测试（2.4）。`discard` **不清** 结果。`enter`/`backToList` 只把 `open` 置 null。`dispose` 同 `clearTests` 且不再 publish：守卫放在 `publish` 本身（`if (disposed) return`），`statusPatch`/`publishTest`/`setUi` 等所有入口都经过它，dispose 之后 `stopBatch`/`toggleTestDetail`/`copyTestDetail` 不再通知监听器。保存成功的状态文案保持 `已保存。`（不改现有断言）。

### 2.4 门控 `blockReason`（纯函数，在 model-test.ts）
```ts
blockReason({ hostUnsupported, saving, isNew, dirty, secretPending }): string | null
```
依次：`hostUnsupported` → `当前 Host 不支持模型测试，重启 DSH 后可用`；`saving` → `正在保存，稍后再测`；`isNew`（`!base.providers[route]`）→ `先保存再测试：这个提供方还没保存`；`dirty`（`ops.dirtySet.has(route)`）→ `先保存再测试：Host 还不知道这个提供方的未保存改动`；`secretPending`（`secretSet[route]` 或 pendingCred 涉及该路由）→ `先保存再测试：API Key 还没保存`；否则 `null`。只读模式、冲突状态不禁用测试（只读不写配置）。正在测试的单行禁用由组件按 `state` 判断。

### 2.5 纯逻辑模块 `src/client/model-capabilities/model-test.ts`
| 函数 | 输出 |
|---|---|
| `testKey(r, m)` | `'r|m'` |
| `resultState(res)` | `res.ok ? 'ok' : res.transient ? 'transient' : 'fail'` |
| `kindText(kind)` | `{short,long}`，表见下；未知 `HTTP_<n>` → `{short:'HTTP ' + n, long:'请求失败（HTTP ' + n + '）'}`；其它未知 → `{short:'未知错误', long:'未分类错误'}` |
| `adviceText(res)` | ok → `这个模型能正常返回。`；transient → `暂时性失败，通常稍后重试即可。`；否则 ADVICE[kind] ?? `复制详情排查，或稍后重测。` |
| `fmtMs(ms)` | `null→'—'`；`<1000 → '812 ms'`；`<10000 → '1.2 s'`；否则 `'20 s'` |
| `fmtClock(epoch)` | 本地 `HH:MM:SS`；状态条用 `.slice(3)` 得 `MM:SS` |
| `stateTone(state)` | ok→`'success'`、fail→`'error'`、transient→`'warn'`、其余→`'muted'`（组件映射到 `C.success/C.error/C.warn/C.fg2`） |
| `stripLine(entry)` | queued `排队中 · 并发上限 3`；running `测试中 · 已等 {s}s / 20s`；cancelled `已取消 · 未发出请求`；ok `可用 · 812 ms · 首 token 341 ms`；fail/transient `{short} · {kind}[ · {status}]` |
| `stripAria(id, entry, open)` | ok `${id} 可用，总耗时 812 ms，首 token 341 ms。查看详情`；fail `${id} 失败：${long}。…`；transient `${id} 暂时失败，可重试：${long}。…`（open 时末尾为 `收起详情`） |
| `verdictText(res)` | ok `可用`，`finish==='max-tokens'` 时 `可用（输出到 maxTokens 截断，仍算可用）`；否则 `long` |
| `effortText(route, effort)` | `null → '无推理档'`；DS 且 `off` → `off（临时关闭思考）`；`off` → `off`；其它 → `${e}（该模型最低档）` |
| `paramsText(res, route)` | `短提示「只回复 OK」 · maxTokens 32 · 推理档 ${effortText} · 超时 20s（固定总时限，与提供方流空闲超时无关）` |
| `batchStats(batch, results)` | `{total,ok,fail,transient,cancelled,running,queued,done,failed}`，`done=ok+fail+transient`，`failed=fail+transient` |
| `progressText(s)` | `已完成 ${done}/${total}，失败 ${failed}` |
| `batchTitle(b, s)` | 进行中 `[正在停止 · ]已完成 d/t，失败 f`；结束 `已停止` / `测试完成` |
| `batchSub(b, s, now)` | 进行中 `${label} · 并发 3 · 单个超时 20s`；停止中 `未开始的已取消，等待 ${running} 个已发出的请求返回`；结束 `${label} · 用时 ${fmtMs(endedAt-startedAt)}` |
| `segStates(b, results)` | 每键 `state ?? 'queued'` |
| `badge(models, results, batch)` | 见下 |
| `doneAnnounce(b, s)` | `测试完成。可用 2，失败 1。` / `已停止。可用 2，失败 1，已取消 3。` |
| `resultAnnounce(id, res)` | `${id} 可用，耗时 812 ms` / `${id} 失败：${short}` / `${id} 暂时失败：${short}` |
| `testDetailText(route, id, entry)` | `JSON.stringify({model,provider,testedAt,...result}, null, 2)`（result 已脱敏） |

`badge`：批次未 done → `{tone:'muted', text:'测试中 d/t'}`；未测（无 result）→ `null`；有 fail → `{tone:'error', text:'${fail+transient} 个失败 · ${ok}/${n} 可用'}`；仅 transient → `{tone:'warn', text:'${transient} 个暂时失败 · ${ok}/${n} 可用'}`；否则 `{tone:'success', text:'✓ ${ok}/${n} 可用' + (tested<n ? '（已测 ${tested}）' : '')}`；title 恒为 `本次会话内最近一次测试结果；保存或刷新后清空`。

文案表（short / long / transient）：AUTH 鉴权失败 / 鉴权失败（401/403），检查 API Key / 否；INVALID_CREDENTIAL 凭证无效 / API Key 无效 / 否；MISSING_CREDENTIAL 未配置 Key / 未配置 API Key / 否；QUOTA 额度不足 / 余额或额度不足 / 否；RATE_LIMIT 被限流 / 被限流（429），稍后重试 / 是；SERVER 服务端错误 / 服务端错误（5xx），稍后重试 / 是；TRANSPORT 网络不可达 / 网络不可达，稍后重试 / 是；TIMEOUT 超时 / 超时（20s），稍后重试 / 是；INVALID_REQUEST 请求被拒 / 请求被拒 / 否；HTTP_404 模型不存在 / 请求被拒或模型不存在（404） / 否；UNKNOWN_MODEL 未注册 / 模型未在配置中注册 / 否；INVALID_CONFIG 配置无效 / 提供方配置无效 / 否；NO_ADAPTER 尚未生效 / 提供方尚未生效，刚保存时可能出现，稍后重试 / 是；UNSUPPORTED_REASONING_EFFORT 档位不支持 / 模型不支持所选推理档 / 否；EMPTY_RESPONSE 空响应 / 模型没有返回内容，稍后重试 / 是；ABORTED 已中断 / 请求被中断 / 否；PI_AI_ERROR、UNKNOWN 未知错误 / 未分类错误 / 否；BUSY 正在测试 / Host 正忙，稍后重试 / 是；HOST_UNAVAILABLE 服务不可用 / Host 暂时不可用，稍后重试 / 是；HOST_UNREACHABLE 连不上 Host / 连不上 Host，稍后重试 / 是；HOST_ERROR 测试失败 / 测试请求失败 / 否。ADVICE 沿用原型 `:495-503` 七条，另加 INVALID_CREDENTIAL 同 AUTH、UNSUPPORTED_REASONING_EFFORT 同 INVALID_REQUEST。

### 2.6 组件（文案逐字来自原型；按钮被门控时用 `aria-disabled="true"` + `title`，**不用 `disabled`**，点击仍调 store 由 store 给出原因）
所有新组件在 `snap.test === undefined` 时返回 `null`。

**ModelTable.tsx**（`:54-60`、`:115-131`）
- 选择栏：`已选 N 个 · 全选 · 清除`，右侧依次 `全部测试`（`data-mc="test-all"`，`aria-label="全部测试（${nm} 个模型）"`）、`测试所选（${nsel}）`（`data-mc="test-selected"`，未选时 title `先勾选要测试的模型`）、`批量设置`。批次在途时前两者 title `正在批量测试，先等它完成或停止`。
- 选择栏下方渲染 `<BatchProgress>`，再是表格。
- 操作列首位：28px 图标按钮 `data-mc-test={modelId}`，内容 `▷`（transient 为 `↻`，`aria-hidden` span），`aria-label` 为 `测试/重测/重试 ${id}`，title 可测时 `${verb}：发 1 次真实请求（maxTokens 32，最低推理档）`，忙时 `排队中`/`测试中`，被门控时为 `blocked` 文本且 `aria-describedby="mc-test-why-${rid}"`。DeepSeek 行在「编辑」后补 28px 占位 `<span aria-hidden="true">`，列宽恒定。
- 每个模型行之后：有条目时 `<TestStatusRow>`；`test.open === key` 且有 result 时 `<TestDetail>`；空 id 的模型不渲染测试按钮。
- 表下 `foot-note`：`测试结果只保留在本次设置会话内，保存或刷新后清空，不写入配置。每次测试是一次真实请求：短提示、maxTokens 32、最低推理档、超时 20 秒，会产生少量费用。`

**TestStatusRow.tsx**（新）：`role="row"`、`data-mc-strip={id}`、`data-mc-state={state}`，`gridColumn: '2 / -1'`；`role="cell"` 内：结果态为 `<button data-mc-detail={id} aria-expanded aria-controls="mc-tdet-${i}" aria-label={stripAria}>`（首行全名 id 等宽小字，二行 `stripLine` + `MM:SS` + 箭头）；queued/running/cancelled 为纯文本。右侧 `xbtn` `data-mc-retest={id}`：`重测` / `↻ 重试`（transient，`C.warn` 边框）/ `测试`（cancelled），`aria-label` `重测/重试/测试 ${id}`，title `再发 1 次真实请求`。running 的「已等」秒数由组件内 `useEffect` 每 100ms 刷新本地 state（SSR 输出 `0.0`）。
**TestDetail.tsx**（新）：`role="row" id="mc-tdet-${i}" data-mc-tdetail={id}`，`<dl>` 依次 `模型 / 结果 / 错误码 / HTTP 状态 / 耗时 / 测试时间 / 样例回复 / message / 请求参数`；HTTP 状态 null 显示 `—（未收到响应）`；样例为空显示 `—`，长度 = 80 时附 `前 80 字符`；message 非空附 `（已脱敏）`；请求参数用 `paramsText`。底部 `adviceText` + `复制详情`（`data-mc="copy-detail"`，组件调 `navigator.clipboard?.writeText(store.copyTestDetail(...))`）+ `收起`。
**BatchProgress.tsx**（新）：`role="region" aria-label="批量测试" data-mc="batch"`；标题 `batchTitle`、副标题 `batchSub`；进行中按钮 `停止`（`data-mc="batch-stop"`，停止中为 `停止中…` 且 aria-disabled）；结束后 `仅重试失败项（N）`（`data-mc="batch-retry-failed"`）、`测试已取消的 N 个`（`data-mc="batch-retry-cancelled"`）、✕（`aria-label="收起测试汇总"`，`data-mc="batch-dismiss"`）。分段条 `role="progressbar" aria-label="批量测试进度" aria-valuemin=0 aria-valuemax={total} aria-valuenow={done+cancelled} aria-valuetext={progressText…}`，每段 `data-seg={state}`、flex 等分、`minWidth 4px`、cancelled 用虚线边框。图例 `可用 / 失败 / 暂时失败 / 已取消 / 进行中 · 排队`；结束且有 transient 时附 `暂时失败（被限流、超时、服务端错误等）通常稍后重试即可。`
**CostConfirmDialog.tsx**（新，用现有 `Modal`）：`test.cost` 非空时渲染。标题 `测试 ${n} 个模型？`；正文 `将对 ${n} 个模型各发送 1 次真实请求，会产生少量费用。`；事实列表 `提供方 ${route}` / `每次请求 短提示，maxTokens 32，最低推理档（能关就关）` / `超时 单个 20 秒` / `并发 最多 3 个，逐条返回，可随时停止`；复选框 `本次会话不再提示`（`data-mc="cost-skip"`，本地 state）；按钮 `取消`（`data-mc="cost-cancel"`，初始焦点）、`开始测试`（`data-mc="cost-ok"`，primary-sm）。Escape = 取消。
**ProviderList.tsx**：meta 行末追加徽标 `<span data-mc-badge={id} title=…>`（`badge()`，tone 色作文字与 0.5px 边框色）；`进入 →` 前加 ghost 按钮 `测试全部`（`data-mc-test-all={id}`，`aria-label="测试 ${name} 的全部 ${n} 个模型"`；批次在途显示 `测试中` 且 aria-disabled，title `正在测试，进入详情可停止`；被门控时 aria-disabled + `aria-describedby="mc-card-why-${id}"`）；被门控时卡片底部一行 `id="mc-card-why-${id}"`：hostUnsupported 为原文，其它为 `先保存再测试`。无模型时不渲染按钮。
**ProviderDetail.tsx**：meta 行加同一徽标。门控因 isNew/dirty/secretPending 时，在头部之后渲染 warn 横幅 `id="mc-test-why-${rid}" data-mc="test-gate"`：`先保存再测试` + 副文 `这个提供方还没保存，Host 不认识它。保存后测试入口自动恢复。`（isNew）或 `这个提供方有未保存的改动，Host 只认已保存的配置。保存后测试入口自动恢复。`，右侧 `保存` 调 `store.save()`。凭证未配置且未门控时 info 横幅：`还没有配置 API Key` + `仍然可以测试，但不会发出请求，结果会是「未配置 Key」。`
**ModelCapabilitiesPanel.tsx**：`Banners` 之后、`hostUnsupported` 时 error 横幅 `data-mc="test-unsupported"`：`当前 Host 不支持模型测试，重启 DSH 后可用。` + 副文 `这个 Host 版本没有测试接口（返回 404）。配置的查看、编辑和保存不受影响。`；根部常驻 `<span role="status" aria-live="polite" style={s.srOnly} data-mc="test-live">{test.live}</span>`；`dialog` 判定加入 `!!snap.test?.cost`；渲染 `<CostConfirmDialog>`；Escape 链在 `ui.bulk` 之后加 `test.open` → `toggleTestDetail` 关闭。
**shared.tsx**：`Banner` 增加 `tone="warn"`（`C.warn` 边框，mark `!`）。**styles.ts**：新增 `testIcon, strip, stripToggle, stripLbl{Ok,Fail,Warn,Muted}, xbtn, xbtnRetry, tdetail, tdl, batch, segs, seg{Queued,Running,Ok,Fail,Transient,Cancelled}, tbadge{Ok,Bad,Warn,Run}, costFacts, footNote, opsSlot`，只用 `C.*`。

## 3. 文档修订（docs agent）
- `docs/requirements.md:17` 末句改为：`…不提供 subagent 运行监控。除 K17 中用户在「模型能力」页手动发起的模型测试外，不验证 API key 是否可用。`
- K14（`:1050`）「它只使用设置与凭证服务，不新增 Host 路由」改为「配置读写只使用设置与凭证服务，不新增写配置的 Host 路由（K17 的只读测试路由除外）」。
- `:1062` 之后新增 `### K17. 模型可用性测试（v2.13）`：一段写 1 条路由 `POST /models/test`、单模型单请求、20s、maxTokens 32、最低推理档、不带 sessionId、计费、Host 并发 3 + 409、Client 并发 3 可停止、批量费用确认、未保存门控、结果不落盘、旧 Host 404 提示；指向本文。
- K7 表（`:1089` 后）：K16 行「`index.test` 仍为 9 条」改为「`index.test` 现为 10 条（K17 新增 1 条）」；新增 `| K17 模型测试 | model-probe.test.ts、http-routes.test.ts「r4a POST /models/test」、index.test.ts（10 条、鉴权）、api-client.test.ts、model-test.test.ts、store.test.ts「r4a model test」、panel.test.tsx「r4a」；npm run verify 输出 10 条 |`。
- `docs/specs/model-capabilities.md:5`「不改 host 路由」改为「不改 host 路由（R4a 新增只读测试路由 `POST /models/test`，见 `r4a-model-test.md`）」。
- `docs/specs/r3-io-and-move.md:4`「仍为 9 条」与 `:197`「`toHaveBeenCalledTimes(9)` 不变」各追加 `（R4a 后为 10 条）`。

## 4. TDD 测试计划（先红后绿；名称即用例标题）
**src/host/model-probe.test.ts**（fake llm：`listProviders/resolveModelInfo/stream` 用 `vi.fn`，`stream` 返回 async generator；`now` 为可控计数器）
- MP01 stop：chunks `text-delta 'O'`(t=100)、`'K'`、`finish stop`(t=300) → `ok true, sample 'OK', firstTokenMs 100, latencyMs 300, errorKind null, finish 'stop', message ''`。
- MP02 max-tokens → ok true、`finish 'max-tokens'`；MP03 tool-calls → ok true。
- MP04 error AUTH：`failure {code:'AUTH',status:401,message:'Incorrect API key sk-or-v1-abcdef123456'}` → `ok false, errorKind 'AUTH', status 401, transient false, message 'Incorrect API key sk-***'`。
- MP05 error RATE_LIMIT 429 → `transient true`；MP06 `code 'HTTP_404'` 无 status → `status 404`；MP07 `code 'weird code'` → `'UNKNOWN'`。
- MP08 aborted 无 code → `errorKind 'ABORTED', finish 'aborted'`。
- MP09 timeout：`timeoutMs 30`、stream 永不 yield 且无视 signal → 在 ~30ms 内返回 `TIMEOUT, finish 'timeout', transient true`，`stream` 收到的 signal 已 aborted。
- MP10 stream 抛 `{code:'NO_ADAPTER'}` → `errorKind 'NO_ADAPTER', transient true, finish 'error'`；MP11 抛普通 Error → `UNKNOWN`，不抛出。
- MP12 listProviders 不含 → `NO_ADAPTER, finish null`，`stream` 未调用；MP13 resolveModelInfo 抛 `UNKNOWN_MODEL` → 同理不调 stream。
- MP14 efforts `[low,off,high]` → 传 `reasoningEffort 'off'`、`params.effort 'off'`；MP15 `[low,high]` → `'low'`；MP16 无 reasoning → options 不含 `reasoningEffort`、`params.effort null`。
- MP17 options 形状：`toEqual({provider,model,messages:[{role:'user',content:[{type:'text',text:'只回复 OK'}]}],temperature:0,maxTokens:32,signal:expect.any(AbortSignal)})`，且 `'sessionId' in options === false`。
- MP18 sample 截断：200 个字符 → 长度 80；含 `\n\t` 折叠为空格。MP19 无 finish 结束 → `EMPTY_RESPONSE, finish 'none'`。MP20 外部 signal abort → `CLIENT_ABORTED`。
- MK01–MK05 maskMessage：`'Authorization: Bearer abc.def'` → `'Authorization: Bearer ***'`（②跳过 Bearer）、`'authorization=Basic%20xyz'` → `'authorization=***'`；`'Bearer xyz123'` → `'Bearer ***'`；`'url?api_key=SECRET1&x=1'` → `'url?api_key=***&x=1'`；`'"token": "t-1"'` → `'"token": "***"'`；401 字符 → 长度 301 且以 `…` 结尾。
**src/host/http-routes.test.ts**「r4a POST /models/test」（`createRoutes({..., getLlm, probeModel: vi.fn()})`）
- HR01 GET → 405、`allow: POST`；HR02 `{}` → 400 `字段 provider 必须是非空字符串`；HR03 `{provider:'a',model:'b',x:1}` → 400 `字段 x 不支持`；HR04 model 257 字符 → 400。
- HR05 无 getLlm → 503 `DEPENDENCY_UNAVAILABLE`，probe 未调用；HR06 llm 无 stream → 503。
- HR07 probe 返回结果 → 200 `{provider, model, ...result}`；HR08 同键第二个请求在第一个未完成时 → 409 `BUSY` `模型 b 正在测试，请稍候`；HR09 3 个不同键挂起时第 4 个 → 409 `同时最多测试 3 个模型，请稍后重试`；HR10 完成后与 probe 抛错后均释放占位（再发 200/500）；HR11 probe 抛错 → 500 `服务端内部错误`；HR12 res 发 `close` → 传给 probe 的 signal aborted 且不写 200。
**src/index.test.ts**：标题改为 `registers ten routes…`，路径数组末尾加 `/plugins/dsh-wuyou-agent/api/models/test`，`effect` 次数 10；新增「models/test 被拒绝时不调 llm.stream」：`requestRejection → 401`，响应 `unauthorized`，fake llm.stream 调用 0 次。
**src/client/shared/api-client.test.ts**：AC01 POST `/plugins/dsh-wuyou-agent/api/models/test`、body、`init.signal` 同一对象；AC02 200 解析；AC03 404 无 code → `code 'HOST_UNSUPPORTED'`、message 为 MODEL_TEST_UNSUPPORTED；AC04 404 `{code:'NOT_FOUND'}` → 保持 `NOT_FOUND`；AC05 409 → `code 'BUSY', status 409`。
**src/client/model-capabilities/model-test.test.ts**：2.5 表每个函数至少 1 例，逐字断言表内示例输出；`kindText('HTTP_418')`；`badge` 四种 tone 与 `（已测 2）`；`blockReason` 五个分支的优先级；`fmtMs(999/1000/9950/20000)` → `'999 ms'/'1.0 s'/'9.9 s'/'20 s'`。
**src/client/model-capabilities/store.test.ts**「r4a model test」（`createFakePort` + `createFakeTester()`：每次调用返回可手动 resolve/reject 的 deferred，记录 signal）
- S01 无 tester → `snap.test === undefined`，旧行为不变；S02 `testProvider` 5 个模型且凭证已配 → `cost` 打开、tester 0 次；`confirmCost(false)` → tester 恰好 3 次，2 个 queued。
- S03 resolve 第 1 个 → 第 4 个开始，结果 `ok`，`live` 含 `可用，耗时`；S04 `stopBatch` → 2 个 queued 变 cancelled，running 仍回写，`done` 后 `retryCancelled` 只入 2 个。
- S05 transient/fail 混合 → `retryFailed` 只含这两个，标签 `重试失败项`；S06 单个 `testModel` 插队首、不进批次。
- S07 门控：新路由、`dirtySet` 含路由、`setSecret` 后 → `testModel` 不调 tester，`ui.status` 为对应文案；保存中同理。
- S08 404 HOST_UNSUPPORTED → `hostUnsupported true`、其余 signal aborted、queued 回到 prev、批次清空，再调 `testModel` 被拒。
- S09 迟到回包：入队后 `reload()`，再 resolve 旧 deferred → results 为空；S10 `save` 成功后清空、`skipCost` 保留；S11 `discard` 不清空。
- S12 `confirmCost(true)` 后再次批量不弹确认；S13 所有目标 `credConfigured false` → 不弹确认直接入队；S14 单模型批量不弹。
- S15 409 BUSY → `transient`、`errorKind 'BUSY'`；无 status 的 TypeError → `HOST_UNREACHABLE`；S16 `toggleTestDetail` 两次回 null，`backToList` 置 null；`dispose` abort 全部。
**src/client/model-capabilities/panel.test.tsx**「r4a」（SSR 字符串断言）
- P01 无 `test` 字段 → 不含 `data-mc-test`、`测试全部`；P02 详情页含 `全部测试`、`测试所选（0）`、每个模型 `data-mc-test=`、`aria-label="测试 m1"`；P03 ok 条目 → `data-mc-strip="m1"`、`data-mc-state="ok"`、`可用`、`重测`、`aria-expanded="false"`。
- P04 transient → `↻ 重试`；P05 `open` → `data-mc-tdetail`、`请求参数`、`与提供方流空闲超时无关`、`（已脱敏）`；P06 批次进行中 → `role="progressbar"`、`aria-valuemax="5"`、`停止`；结束 → `测试完成`、`仅重试失败项（1）`。
- P07 `cost` → `测试 5 个模型？`、`开始测试`、`本次会话不再提示`；P08 `hostUnsupported` → `当前 Host 不支持模型测试，重启 DSH 后可用。`、按钮 `aria-disabled="true"`；P09 dirty 路由 → `先保存再测试`、`data-mc="test-gate"`；P10 列表卡片徽标 `✓ 2/2 可用`、`data-mc-test-all`；P11 颜色扫描：新组件 HTML 无 `#xxx`/`rgb(`/`--mc-`。

## 5. 工作切分（串行，路径互不重叠）
| 步骤 | 角色 | 允许改的路径 |
|---|---|---|
| 1 | tester-host（红） | `src/host/model-probe.test.ts`（新）、`src/host/http-routes.test.ts`、`src/index.test.ts` |
| 2 | tester-client（红） | `src/client/shared/api-client.test.ts`、`src/client/model-capabilities/{model-test.test.ts,store.test.ts,panel.test.tsx,test-fixtures.ts}` |
| 3 | coder | `src/host/{model-probe.ts,runtime-deps.ts,http-routes.ts}`、`src/index.ts`、`scripts/verify-runtime-deps.mjs`、`src/client/shared/{api-client.ts,api-types.ts}`、`src/client/index.tsx`、`src/client/model-capabilities/{types.ts,model-test.ts,store.ts,register.ts}` |
| 4 | front-designer | `src/client/model-capabilities/components/{ModelTable,ProviderList,ProviderDetail,shared,TestStatusRow,TestDetail,BatchProgress,CostConfirmDialog}.tsx`、`ModelCapabilitiesPanel.tsx`、`styles.ts` |
| 5 | docs | `docs/requirements.md`、`docs/specs/model-capabilities.md`、`docs/specs/r3-io-and-move.md` |
测试作者不改业务代码；第 3、4 步不改测试（发现测试与契约冲突时报告 orchestrator）。

## 6. 验收命令
| 时点 | 命令 | 期望 |
|---|---|---|
| 步骤 1/2 后 | `npm test` | 新增用例失败（缺模块/缺方法），原有 909 个仍通过 |
| 步骤 3 后 | `npx vitest run src/host src/index.test.ts src/client/shared src/client/model-capabilities/model-test.test.ts src/client/model-capabilities/store.test.ts` | 全部通过 |
| 步骤 4 后 | `npm test` | 42 个文件全部通过，用例数 = 909 + 新增数，0 失败 |
| 每步 | `npx tsc -p tsconfig.client.json --noEmit`、`npx tsc -p tsconfig.json --noEmit` | 退出码 0，无输出 |
| 最后 | `npm run build` | 退出码 0 |
| 最后 | `npm run verify` | 含 `registered 10 lifecycle-owned API routes` |

## 7. 非目标
- 不设计 `streamIdleTimeoutMs`（r4b）；不做后台自动测试、定时巡检、跨会话保存结果、写入配置。
- 不测试未保存草稿（不把草稿 baseURL/Key 发给 Host）；不做「全部提供方一键测试」入口；不做流式逐 token 展示。
- 不改 `ModelCapabilitiesPort`、`computeOps`、导入导出；不新增依赖、不注入 `<style>`、不加动画。

## 8. 风险
- 真实计费：费用确认 + 默认最低档缓解；`skipCost` 仅本会话。
- effort 顺序：`pickEffort` 无 `off` 时取列表首项，假定 DSH 按低→高排序；若某适配器逆序会用到高档（MP15 固定行为，偏差时再议）。
- 刚保存后到 volatile-update 之间可能 `NO_ADAPTER`/`UNKNOWN_MODEL`（调研 §2）；前者标为暂时性，后者文案提示「保存配置后再测」。
- 适配器无视 signal：Host 用竞速返回 TIMEOUT，但底层请求可能仍在跑并计费，且占用不了信号量（已释放）。
- 旧 Host 只更新 client：404 → 横幅；Host 需重启 DSH 才有新路由。
- 无动画：running 只显示静态圆环 + 计时文字，与原型的旋转/脉冲不同，属样式约束下的有意偏差。
- 多窗口同时测试：Host 全局 3 + 409，Client 映射为暂时性 BUSY，可重试。

## R4 审查返工（v2.13.1）

- F1 `maskMessage`（1.2 第 8 步）：② 左边界改为 `(?<![A-Za-z0-9])`，关键词补 `access[-_]?token|refresh[-_]?token|client[-_]?secret`，支持 JSON 引号写法；① 扩展为 `Bearer|Basic|Token`，输出 `<Scheme> ***`，② 跳过 ① 已遮蔽的三种 scheme；新增 JWT / `AIza` / `gh[pousr]_` / `AKIA` 长 token 规则。MK01–MK05 结果逐字不变。用例：MK06–MK12。
- F5 `/models/test` 校验（1.1）：`provider`/`model` 先 `trim()` 判空，文案不变，传给 probe 的值不 trim。用例：HR13。
- F2 / F4 错误映射（2.3）：tester 同步抛错、返回非 thenable 都落 `fail`/`HOST_ERROR` 并归还并发槽；`HOST_UNREACHABLE` 只限「TypeError 且无 status」，其余无 status 为 `HOST_ERROR` 非 transient。用例：S15、S17、S18、S20。
- F3 dispose（2.3）：`publish` 内 `if (disposed) return`，dispose 之后任何入口都不再通知监听器。用例：S19。
- F3 回归修复：dispose 只结束本次挂载周期（`disposers.splice(0)` 取消订阅、clearTests、作废在途 load 与 `loadingPromise`），从 dispose 到下一次 `load()` 之间不 publish；下一次 `load()` 先复位 `disposed = false`（在复用 `loadingPromise` 的早退之前），再发起新一轮加载并重新订阅事件。修复面板关闭后重新打开（含 StrictMode 的 mount→cleanup→mount）所有按钮失效的问题。用例：RM1–RM4，守卫 RM5 / S19。
