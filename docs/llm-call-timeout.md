# DSH 模型调用超时（streamIdleTimeoutMs）调研

> 调研时间：2026-10-08
> 结论在两个版本上分别核对过：
>
> - **源码检出**：`/Users/jwyuan/source_code/deepseek-harness`（`@deepseek-ai/dsh-root` 0.1.6-alpha.2，commit `ddefc45`，2026-09-17）
> - **实际运行**：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`（0.1.7-rc.2），桌面端内置的 `app.asar` 同一产物
>
> 本文出现的行号：源码检出按 `src/*.ts`，安装包按 `lib/*.js`（构建产物）。两处结论一致。

## 1. 结论速览

| 问题 | 答案 |
| --- | --- |
| 能配置吗 | 能。键名 `streamIdleTimeoutMs`，单位毫秒 |
| 默认值 | `300000`（5 分钟）——观察到的 300s 就是它 |
| 语义 | **流空闲超时**，不是单次请求的总时长上限；DSH 没有 LLM 调用的总 deadline |
| 作用范围 | `llm-deepseek`：插件级一个值；`llm-pi-ai`：**每个 provider 路由**各一个值 |
| 配置位置 | profile 的 `cordis.patch.yml` 里对应条目的 `config`（0.1.7-rc.2 的规范落点） |
| 旧位置 | `$DSH_HOME/settings.yaml`（0.1.6 时代的热加载文档）在 0.1.7-rc.2 已降级为**一次性导入源** |
| Web 界面 | DSH 自带设置没有（模型页、插件页都没有）；无忧Agent「模型能力」页已支持（v2.13，见 §5） |
| 环境变量 | 没有。`llm-*` 只认 `DEEPSEEK_BASE_URL` 之类，超时不可用 env 覆盖 |
| 取值约束 | 正有限数，上限 `2147483647` ms（约 24.8 天） |

## 2. 它是哪一个超时：流空闲 watchdog

两个适配器都在流读取循环外挂一个 `idleWatchdog`：**只在等待下一次流读取（iterator `next()`）尚未返回时计时**，整个请求共用一个稳定 signal。因此：

- provider 持续吐数据时，请求跑多久都不会被它掐断；
- 连续 `N` 毫秒一个字节都没来，才判定超时；
- 超时被映射成 `LlmError`，`code = "TIMEOUT"`。

超时文案（看到这个就说明命中的是本文这个配置）：

- DeepSeek：`DeepSeek stream idle timeout after {ms}ms`
- pi-ai：`pi-ai stream idle timeout after {ms}ms`

超时是**可重试错误**。默认重试策略为 normal 模式、`maxRetries: 5`、初始退避 500 ms、上限 10 s、抖动 0.1，且 `TIMEOUT` 在默认可重试码列表里。所以看到一次超时失败，前面可能已经重试过若干次。

### 证据

| 位置 | 说明 |
| --- | --- |
| `packages/llm/llm-deepseek/src/common/defaults.ts:4` | `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000` |
| `packages/llm/llm-pi-ai/src/config.ts:46` | 同上常量 |
| `packages/llm/llm-deepseek/src/config.ts:43,89` | `streamIdleTimeoutMs` 字段与 schema 默认 + 上限校验 |
| `packages/llm/llm-pi-ai/src/config.ts:165,340,425-430` | provider 级字段、schema、`?? DEFAULT` 兜底与校验 |
| `packages/llm/llm-deepseek/src/protocols/chat-completions/adapter.ts:203-226` | watchdog 与 `LLM_STREAM_IDLE_TIMEOUT` |
| `packages/llm/llm-pi-ai/src/adapter.ts:354-355,395,414-415` | 同上（pi-ai 侧） |
| `packages/llm/llm/src/retry-policy.ts:14-22` | 默认重试策略、`TIMEOUT` 属可重试码 |
| `packages/util/timeout/src/index.ts:25` | `MAX_TIMER_DELAY_MS = 2_147_483_647` |

安装包 0.1.7-rc.2 的对应位置：`@deepseek-ai/dsh-llm-deepseek/lib/index.js:17,322,396-397`、`@deepseek-ai/dsh-llm-pi-ai/lib/index.js:907,1040,1091-1092,1851-1906`。

## 3. 怎么配

### 3.1 推荐：profile 的 `cordis.patch.yml` 条目 `config`

这是 0.1.7-rc.2 的规范位置——DSH 自己的配置编辑器（`SettingsForms` / `ConfigEditor`）写的也是这个文件，`ConfigEditor.documentPath` 就是 `profileContext.patchPath`。

DeepSeek 官方 provider（插件级，顶层字段）：

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek"
  config:
    streamIdleTimeoutMs: 1800000   # 30 分钟
```

pi-ai 多路由（**每个路由各一份**）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      gpt-gateway:
        streamIdleTimeoutMs: 1800000
      cc-gateway:
        streamIdleTimeoutMs: 1800000
```

本机 web profile 已有这两个路由，位置是 [cordis.patch.yml:474](/Users/jwyuan/.dsh/profiles/web/cordis.patch.yml)（`gpt-gateway` / `cc-gateway`，目前都没写这个字段，走默认 300s）。

注意：pi-ai 的设置命名空间取的是**条目 id**（`ctx.fiber.entry?.options.id ?? 'llm-pi-ai'`），条目 id 叫什么，设置地址就叫什么；如果条目 id 被改掉，要跟着改。

### 3.2 旧版 `$DSH_HOME/settings.yaml`（0.1.6 时代；0.1.7 只剩导入）

0.1.6 里 `@deepseek-ai/dsh-settings-file` 提供 `$DSH_HOME/settings.yaml`，被 chokidar 监听、热加载，`llm-deepseek:` / `llm-pi-ai:` section 与组合配置**深合并**（对象递归合并，数组整体替换），所以只写一个叶子即可：

```yaml
llm-pi-ai:
  providers:
    gpt-gateway:
      streamIdleTimeoutMs: 1800000
```

0.1.7-rc.2 里这个文档已被移除：启动后 `SettingsForms.importLegacyDocument()` 读取它一次，把每个 section 导入 profile 的 patch，然后把文件重命名为 `settings.yaml.imported`（部分导入失败只记日志）。也就是说——**现在再手写这个文件，只会在下次启动时被一次性搬进 `cordis.patch.yml`，然后文件就不见了**。本机 `~/.dsh/settings.yaml` 当前不存在，没有待导入内容。

### 3.3 pi-ai 的相邻旋钮

`llm-pi-ai` 的 provider 配置里还有两个相关字段（都在 0.1.6/0.1.7 的 schema 里）：

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `timeoutMs` | HTTP / provider SDK 层超时 | 未设，交给 pi-ai SDK |
| `websocketConnectTimeoutMs` | WebSocket 连接超时 | 未设 |
| `streamIdleTimeoutMs` | 单次流读取空闲上限 | `300000` |

参考实现里曾把空闲超时设成 `172800000`（48 小时），见源码检出 `packages/bundle/sdk-minimal/cordis.patch.yml:31`。

## 4. 生效时机

- **走 DSH 自己的配置编辑器**（模型页等）：`ConfigEditor.edit()` 在写完 patch 后调用 `reconcileProfilePatches(...)`，走正常 Loader 路径就地生效，不需要重启。
- **外部直接改 `cordis.patch.yml`**：0.1.7-rc.2 的安装包里带文件 watcher 的只有 `credentials-local`、`skill-filesystem`、`fs-local`、`hmr`，**profile patch 不在监听之列**。所以手改文件后要重启承载它的 `dsh web` / 桌面端才会生效。（本项目插件自己写的 `cordis.patch.yml` 行之所以"新建会话后生效"，是因为插件自己重新读 YAML，而不是 Loader 热加载。）

## 5. Web 设置界面现状：没有这个字段

在 0.1.7-rc.2 安装包的模型页客户端里，出现的 LLM 字段只有 `baseURL`（14 处）、`apiKeyEnv`（17 处）以及 api / models / key 相关；`streamIdleTimeoutMs`、`retryPolicy`、`maxRequestImageBytes` 均为 **0 处**。源码检出（0.1.6）同样如此：`packages/client/ui-settings-models/src` 与 `packages/client/ui-settings-plugins/src`（后者只有 agent-loop / bash / subagent / web-search 几个手写卡片）都没有 timeout 控件。

结论：DSH 自带设置界面只能改 YAML；要让面板支持，只是在这个条目上多编辑一个数值叶子。

**无忧Agent 面板已支持（v2.13）**：无忧Agent 设置里的「模型能力」页可以编辑这个字段，入口有三处：pi 提供方详情页接入层的「超时」Section、DeepSeek 详情页的「超时」Section、新增提供方向导第 2 步。界面单位是分钟（可带小数），写入时换成整数毫秒；未设置时使用 DSH 默认 5 分钟，推荐 30 分钟（向导新建和导入的新提供方默认 30 分钟，已有提供方不会被静默改写）。写入位置同 §3.1：pi-ai 为 `config.providers.<route>.streamIdleTimeoutMs`，DeepSeek 为 `config.streamIdleTimeoutMs`，经设置服务写入后热生效。契约见 `docs/specs/r4b-stream-idle-timeout.md`。

## 6. 对本项目（无忧Agent 配置面板）的意义

- 目标文件与现有能力同源：都是 web profile 的 `cordis.patch.yml`，写入时同样先拿 profile `package.json` 的文件锁，再做局部 YAML 拼接。
- 建议的落点是 `llm-pi-ai` 条目的 `config.providers.<route>.streamIdleTimeoutMs`（本机即 `gpt-gateway`、`cc-gateway`），以及（若启用）`llm-deepseek` 条目的顶层同名字段。
- 校验规则可直接照搬 schema：`> 0`、有限、`<= 2147483647`；单位是毫秒（界面上最好同时显示秒/分钟换算，避免误填 `300`）。
- 语义提示建议写进 UI：这是"多久没有任何数据算超时"，不是"单次调用最长多久"；且超时默认会重试 5 次。

## 7. 复核命令

```bash
# 源码检出（0.1.6-alpha.2）
grep -rn "DEFAULT_STREAM_IDLE_TIMEOUT_MS = " \
  /Users/jwyuan/source_code/deepseek-harness/packages/llm/llm-deepseek/src/common/defaults.ts \
  /Users/jwyuan/source_code/deepseek-harness/packages/llm/llm-pi-ai/src/config.ts

# 实际安装的 0.1.7-rc.2 构建产物（已核对：两处均为 3e5 = 300000）
D=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
grep -n "DEFAULT_STREAM_IDLE_TIMEOUT_MS = " \
  $D/dsh-llm-deepseek/lib/index.js $D/dsh-llm-pi-ai/lib/index.js

# 安装版本号
node -e "console.log(require('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json').version)"
```

## 附录：0.1.6 → 0.1.7 的机制变化

| | 0.1.6-alpha.2（源码检出） | 0.1.7-rc.2（本机运行） |
| --- | --- | --- |
| 用户配置落点 | `$DSH_HOME/settings.yaml`，与组合配置分层合并 | profile 的 `cordis.patch.yml` 条目 `config`（`ConfigEditor.documentPath`） |
| 承载服务 | `@deepseek-ai/dsh-settings-file`（chokidar 监听、热加载） | 并入 `@deepseek-ai/dsh-settings` 的 `SettingsForms` + `dsh-config-editor` |
| 旧文档 | 权威来源 | 启动时一次性导入并重命名为 `settings.yaml.imported` |
| LLM 侧注册 | `settings.installSection(ctx, NS, Config, config, ...)` | `settings.configure({ auto: false }, ctx.fiber)`，命名空间取条目 id |
| 超时默认 | `300000` | `300000`（未变） |
| 超时字段与校验 | 一致 | 一致（含 `MAX_TIMER_DELAY_MS` 上限） |
