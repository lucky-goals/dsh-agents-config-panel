# R4 调研事实（模型测试 + 流空闲超时）

供 r4 契约、测试与实现引用。全部为只读调研结论，未发真实请求。版本：web 用 DSH 0.1.7-rc.2（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`），desktop 用 0.2.0-rc.2（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`）；两版 `dsh-llm` JS 逐字节一致。下文 `B=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`。

## 1. 设置对话框尺寸

`dsh-client-ui-settings-general`：panel `width:800px`，nav `188px`，options `padding:0 24px 24px` → 插件内容区 564px（含滚动条预留）。已批准原型：`docs/design/model-capabilities/model-test-prototype.html`。

## 2. LLM 调用（功能 A）

- `ctx.get('llm')` 为 LlmRuntime；唯一补全入口 `stream(options): AsyncIterable<StreamChunk>`（`B/dsh-llm/lib/types/index.d.ts:412`，实现 `index.js:2367-2371`）。
- GenerateOptions（`types/types.d.ts:489-531`）：`provider, model, reasoningEffort?, messages, system?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose?`；无 timeout 参数，用 `signal`。
- 消息：`{role:'user', content:[{type:'text', text}]}`（RequestUserInput，`types.d.ts:467-475`；同 `B/dsh-experimental-auto-review/lib/index.js:400-415`）。
- StreamChunk（`types.d.ts:417-447`）：`block-start | text-delta{text} | reasoning-delta | tool-call-delta | block-end | usage{usage} | finish{reason}`；FinishReason.kind（`:131-151`）：`stop | tool-calls | max-tokens | aborted{failure} | error{failure}`；LlmFailure `{message, code, status?, requestId?}`。
- 适配器错误转为最后的 finish chunk，不抛；waterfall 中间件异常仍会抛（`dsh-llm/lib/index.js:2283-2387`）。参考写法：`B/dsh-session-title-llm/lib/index.js:186-240`。
- `resolveModelInfo(provider, model, signal)` → `reasoning?.efforts[{id}]`；pi-ai 未配置模型抛 `UNKNOWN_MODEL`。DeepSeek 默认 effort 为 high，测试须显式传最低档（优先 `off`）。
- 错误码：公共 `NO_ADAPTER, UNSUPPORTED_REASONING_EFFORT, INVALID_CREDENTIAL, QUOTA, EMPTY_RESPONSE`；DeepSeek `AUTH(401/403) QUOTA(402) RATE_LIMIT(429) INVALID_REQUEST(400/413) SERVER(≥500) HTTP_<status> TRANSPORT TIMEOUT`；pi-ai `AUTH QUOTA RATE_LIMIT INVALID_REQUEST SERVER TIMEOUT TRANSPORT PI_AI_ERROR UNKNOWN_MODEL INVALID_CONFIG MISSING_CREDENTIAL`。暂时性：`RATE_LIMIT SERVER TIMEOUT TRANSPORT EMPTY_RESPONSE NO_ADAPTER`。
- 不传 `sessionId`：不进会话、不审批、不自动重试（`dsh-llm-retry` 只监听 `agent/request-error`）、不计入会话用量。真实请求会计费；LlmRuntime 无并发限制。
- provider id：pi-ai 路由 key == 运行时 provider id（`B/dsh-llm-pi-ai/lib/index.js:1940`）；DeepSeek 为 `deepseek-official`。凭据由 adapter 每次解析，插件拿不到 key。保存设置后到 volatile-update 之间可能短暂出现 `NO_ADAPTER`/`UNKNOWN_MODEL`。
- client 侧 `remote.llm` 只有 `listProviders / listConfigurableProviders / discoverModels`，没有补全；因此测试必须走插件 host 路由。

## 3. 流空闲超时 streamIdleTimeoutMs（功能 B）

详见 `docs/llm-call-timeout.md`。要点：

- 位置：`llm-pi-ai` 为 `providers.<route>.streamIdleTimeoutMs`（每路由）；`llm-deepseek` 为顶层 `streamIdleTimeoutMs`。经本 tab 已在用的 `remote.settings` mutate 写入 profile `cordis.patch.yml`，热生效。
- schema（两版一致）：`z.number().min(Number.MIN_VALUE).max(2147483647).default(300000)`，pi-ai `B/dsh-llm-pi-ai/lib/index.js:1040`（providers 字典 `.volatile()` :1047，运行时校验 :1091-1092）；DeepSeek `B/dsh-llm-deepseek/lib/index.js:322 .volatile()`，校验 :396-397。无整数约束；字符串被拒（须发 JS number）；`unset` 回落 300000。
- `describe().value` 已填充 schema 默认值，因此每个路由都会出现 300000；显式值只能从 `user` 层判断（spec `model-capabilities.md` B1）。
- 现状：该键落入 draft 的 `extra`；`computeOps` 不 diff extra；导出会带出泄露的默认值；导入冲突覆盖 / DeepSeek 导入会静默丢弃。
- 用户已在 `~/.dsh/profiles/desktop/cordis.patch.yml:483,539` 为 `gpt-gateway`、`cc-gateway` 手写 `1800000`。用户要求界面默认值 30 分钟（1800000）。
- 语义：流空闲超时（多久没有任何数据算超时），不是单次调用总时长；agent 会话中 TIMEOUT 默认重试最多 5 次。
