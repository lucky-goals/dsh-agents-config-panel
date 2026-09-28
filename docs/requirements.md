# 无忧Agent 插件需求与接口契约

版本：2.0  
插件包名：`@nanmicoder/dsh-wuyou-agent`  
中文名：无忧Agent  
目标环境：DSH 0.1.7-rc.2  

本文是本轮实现、测试和验收的唯一依据。所有测试 fixture 必须来自真实 `cordis.patch.yml` 的脱敏副本，不能重新发明另一套配置模型。本文不要求修改生产 profile；验收期间仅使用隔离的 `wuyou-test` profile。

## 术语与边界

- **Panel A**：Subagent 工具实例管理面板，读取和维护 `@deepseek-ai/dsh-tool-subagent` 行。
- **Panel B**：Agent-Teams 成员配置面板，读取和维护 `@nanmicoder/dsh-agent-teams` 的成员。
- **profile**：DSH 配置档案；每个 profile 对应自己的 `cordis.patch.yml`。Agent-Teams 的 `config.profiles` 是该插件内部的 profile map，两者名称必须明确区分。
- **revision**：当前 YAML 文本的 SHA-256 十六进制摘要，用于并发写入保护。
- **目标范围**：只修改 Panel A 指定的 delegation 配置序列或 Panel B 指定的成员序列；其余字节必须保持不变。
- **非目标**：不创建或删除 DSH profile，不修改 DSH 或 Agent-Teams 插件源码，不运行时加载/卸载插件，不主动调用 reconcile，不提供 subagent 运行监控，也不验证 API key 是否可用。

## A. 真实 `cordis.patch.yml` 结构

### A0. 根序列

文件根是 YAML 序列。每一项要么是 `{id, name, config?, disabled?}`，要么是 `{insert: [...]}`。真实文件含有大量 `#` 注释和中文多行 `|` 字符串；解析和写入必须保留这些内容。脱敏结构片段如下（字段值可因环境脱敏，层级和键名不可改变）：

```yaml
- insert:
    - id: preset-standard-acp
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard-acp
        plugins:
          - id: delegation
            name: cordis:group
            group: true
            isolate:
              workflowEngine: true
            config:
              - id: tool-subagent-coder
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent_coder
                  backgroundMode: continuable
                  agentOptions:
                    provider: gpt-gateway
                    model: gpt-6-luna
                    reasoningEffort: max
- id: agent-teams
  name: '@nanmicoder/dsh-agent-teams'
  config:
    stateDir: .agent-teams
    memberProvider: spawn
    memberMaxDepth: 0
    maxMembers: 8
    profiles:
      standard-acp:
        description: '脱敏后的真实 profile 描述'
        taskPlanning: captain
        protocol: |
          （真实文件中的整段协议，脱敏 fixture 保持原内容和缩进）
        members:
          - name: claude
            provider: gusu-gateway
            model: claude-opus-5-5
            reasoning_effort: high
            role: '脱敏角色'
  value:
  op: add
  path:
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
```

根序列中还有其他插件项和 `insert` 项，不能因为不属于目标范围而被重排、格式化或删除。以下内容必须原样保留，解析时不得报错，写入后必须逐字节不变：

- delegation 项的 `group: true` 和 `isolate:`（包括其映射内容）。
- agent-teams `config` 的 `stateDir`、`memberProvider`、`memberMaxDepth`、`maxMembers`。
- `standard-acp` profile 的 `description`、`taskPlanning`、`protocol`，其中 `protocol` 是中文多行 `|` 字符串。
- 真实文件中的 `!!js` 自定义 tag，例如 `disabled: !!js process.platform === 'win32'`；YAML 解析器必须接受该 tag，局部写入不得把它转成普通字符串或重排整篇文件。

### A1. Panel A 定位路径与行形状

Panel A 的路径为：根序列中带 `insert` 键的项 → 它的 `insert` 序列里 `id: preset-standard-acp` → `config.plugins` 序列 → `id: delegation`（`name: cordis:group`）→ `config` 序列。

- subagent 行的 `name` 必须等于 `@deepseek-ai/dsh-tool-subagent`，形如：

  ```yaml
  - id: tool-subagent-coder
    name: '@deepseek-ai/dsh-tool-subagent'
    disabled: false
    config:
      provider: spawn
      toolName: subagent_coder
      backgroundMode: continuable
      modelSelectionSettings: true
      maxDepth: provider-managed
      agentOptions:
        provider: gpt-gateway
        model: gpt-6-luna
        reasoningEffort: max
  ```

- `disabled` 在行级，与 `id`、`name` 同层；没有该键等同于未禁用。
- 真实 delegation `config` 序列共有 13 条 `name == '@deepseek-ai/dsh-tool-subagent'` 的行：
  - `spawn` 4 条：`tool-subagent`、`tool-subagent-coder`、`tool-subagent-tester`、`tool-subagent-front-designer`。
  - `fork` 1 条：`tool-subagent-fork`。
  - `ccacp` 1 条：`tool-subagent-acp`。
  - `cursoracp` 5 条：`tool-subagent-cursor`、`tool-subagent-explore`、`tool-subagent-architect`、`tool-subagent-reviewer`、`tool-subagent-research`。
  - `codex` 和 `claude-code` 各 1 条：`tool-subagent-codex`、`tool-subagent-claude-code`，两行均带 `disabled: true`。
- 同一 delegation `config` 序列另有 5 条其他 name 的行：`tool-subagent-control`、`tool-subagent-list-agents`、`workflow-ptc`、`tool-workflow`、`tool-ralph`；这些行不展示，也不修改。
- `kiroopsuacp` 和 `kirogptacp` 只出现在根级 host `insert` 行，不属于 delegation 的 13 条 Panel A 行。
- 通用只读规则：`config.provider` 不是 `spawn` 或 `fork` 就是只读；只有这两种 provider 的行可编辑。
- `config` 中可能有 `toolName`、`backgroundMode`、`maxDepth`、`modelSelectionSettings`、`persona`、`agentOptions` 等键；未被契约要求更新的键必须原样保留。

### A2. Panel B 定位路径与成员形状

Panel B 的路径为：根序列中 `id: agent-teams` 的项（根的直接子项，不在 `insert` 里）→ `config.profiles`（map）→ `<profileName>.members` 序列。

成员形如 `{name, provider?, model?, reasoning_effort?, role?, ...其他键}`。读取和更新时，成员上的其他键原样保留。真实可用的 Agent-Teams profile 名是 `standard-acp`。`agent-teams` 这一项末尾还有 `value:`、`op: add`、`path:` 三个键，任何 Panel B 写入都必须原样保留。

### A3. 模型目录定位

模型目录分两层：

1. Host 运行时优先从 DSH 的 LLM 注册表取完整的 provider/model/effort 目录，这样也能覆盖 base 层默认 provider（包括不在当前 patch 中的 provider）。t6 负责找到对应服务，可参考 `dsh-tool-subagent` 的 `list_subagent_models` 如何取目录；运行时取得的目录传给 `validateModelRoute` 和成员/subagent 写入函数。
2. 拿不到注册表时，退回 `readCatalog(yamlText)`：只解析根序列中 `id: llm-pi-ai` 的项，再读取 `config.providers.<providerId>.models[]`。每个模型有 `id`，可选 `reasoningEfforts` YAML map；map 的 key（例如 `low`、`medium`）才是对外返回的 effort 字符串。没有这个字段时按 `['low','medium','high','max']` 处理。

无论目录来自注册表还是 fallback，统一返回 B 节的 `ModelCatalog` 形状。

## B. Host 纯函数 API

Host 纯函数不依赖 Cordis，只使用 `yaml` 库。输入输出都是字符串或普通对象。真实 YAML 中 `reasoningEfforts` 是 map（例如 `low: low`），`readCatalog` 取 map 的 key，映射为接口中的 `string[]`；没有该字段时使用 `['low','medium','high','max']`。以下签名、类型和错误码必须保持不变：

```ts
type Ok = { ok: true; yamlText: string }
type Err = { ok: false; code: 'STRUCTURE'|'NOT_FOUND'|'DUPLICATE'|'INVALID'|'READ_ONLY'|'LAST_MEMBER'; message: string }
type Result = Ok | Err

// src/host/catalog.ts
interface ModelCatalog { providers: Array<{ id: string; models: Array<{ id: string; reasoningEfforts: string[] }> }> }
readCatalog(yamlText: string): ModelCatalog
validateModelRoute(catalog, provider: string, model: string, effort?: string): string | null   // null 表示合法；否则返回中文错误
// 模型未声明 reasoningEfforts 时，按 ['low','medium','high','max'] 处理

// src/host/subagent-manager.ts
interface SubagentRow { id: string; disabled: boolean; editable: boolean; config: Record<string, unknown> }  // editable = config.provider 为 spawn 或 fork
interface SubagentInput { toolName: string; provider: 'spawn'|'fork'; backgroundMode?: 'continuable'|'one-shot'; agentOptions?: { provider: string; model: string; reasoningEffort?: string } }
listSubagents(yamlText): SubagentRow[]            // 结构缺失时抛 Error，message 用 STRUCTURE 对应的文案
createSubagent(yamlText, input, catalog): Result  // id = 'tool-subagent-' + toolName 去掉 'subagent_' 前缀、下划线改连字符；追加到 delegation config 序列末尾
updateSubagent(yamlText, id, patch: Partial<SubagentInput>, catalog): Result
removeSubagent(yamlText, id): Result

// src/host/members-editor.ts
interface TeamMember { name: string; role?: string; provider?: string; model?: string; reasoning_effort?: string; [k: string]: unknown }
listTeamProfiles(yamlText): string[]
listMembers(yamlText, profile): TeamMember[]      // 结构缺失时抛 Error
addMember(yamlText, profile, member, catalog): Result
updateMember(yamlText, profile, name, patch, catalog): Result
removeMember(yamlText, profile, name): Result

// src/host/patch-io.ts
computeRevision(yamlText): string                 // 内容的 sha256 hex
```

### B1. 校验规则

- `toolName` 匹配 `^subagent(_[a-z0-9]+)*$`，在该 delegation 序列所有 subagent 行里唯一，否则 `DUPLICATE`。id 冲突也是 `DUPLICATE`。
- `provider` 为 `spawn` 时，`agentOptions.provider` 和 `agentOptions.model` 必填，并且必须通过 `validateModelRoute`。`provider` 为 `fork` 时不能带 `agentOptions`。
- `config.provider` 不是 `spawn` 或 `fork` 的行只能展示，update 或 remove 返回 `READ_ONLY`。
- `member.name` 匹配 `^[a-z][a-z0-9-]*$`，同一 profile 内唯一。member 的 provider 和 model 要么都填（并通过 `validateModelRoute`），要么都不填。只剩最后一个成员时 remove 返回 `LAST_MEMBER`。
- **spawn → fork**：`updateSubagent` 的 patch 设 `provider: 'fork'`，且不带 `agentOptions` 时，删除该行原有的 `agentOptions` 块（只删这一行的块，其余字节不变）并返回 ok。patch 显式带了 `agentOptions` 时仍返回 `INVALID`（fork 不能带 agentOptions）。**fork → spawn** 时必须在 patch 里补全 `agentOptions`，新块按该行 `config` 的键缩进写入。
- 纯函数边界不抛异常：字段值无法安全写成 YAML 标量时，返回 `INVALID` 并说明是哪个字段。只有 B2 所列的结构缺失，`list*` 才会抛 `Error`。
- 用当前值原样重新保存一条可编辑行或一名成员时，结果与原文逐字节相同（no-op）。

### B4. null 清空语义

`updateSubagent` 和 `updateMember` 的 `patch` 参数允许部分字段值为 `null`，表示**删除该键**（从 YAML 中移除该行）：

**可清空字段（仅限以下 5 个）：**

- `TeamMemberPatch` 中的 `role`、`provider`、`model`、`reasoning_effort`（4 个）
- `SubagentPatch` 中的 `agentOptions.reasoningEffort`（1 个，仅限 spawn 行）

**不可清空字段：**除上述 5 个之外，所有字段（包括成员的 `name`，subagent 的 `toolName`、`provider`、`backgroundMode`、`agentOptions.provider`、`agentOptions.model`）为 `null` 时返回 `INVALID`，文案：「字段 <name> 不能清空」。

**成对约束：** 成员的 `provider` 和 `model` 必须同时有或同时无。清空后：只清空 `provider` 返回 `INVALID`「成员 provider 和 model 必须同时填写」；同时清空两者则通过。校验基于清空之后的成员状态。

**fork 行的 agentOptions：** fork 行没有 `agentOptions`，对 fork 行发 `{agentOptions:{reasoningEffort:null}}` 返回 `INVALID`（不是 no-op）。

**key 不存在时的 null（no-op）：** 如果被清空的 key 在当前 YAML 中本来就不存在，返回 ok 且文件不变。

**多行 role 删除：** `removePairEdit` 从 key 所在行的行首删到该值最后一行结束，整块删除，不留空行。如果 key 和序列项的 `- ` 在同一行，删到下一个 key 为止，让下一个 key 接到 `- ` 后面；没有下一个 key 时返回 `INVALID`「字段 x 无法写入」。

### B5. 文件权限规则

- 写入时读取目标文件的现有权限位（`stat.mode & 0o777`）并传给 `writeFileAtomic`，以保留原有权限。
- 文件不存在（ENOENT）时，默认使用 `0o600`。
- 不对文件执行 `chmod`，不提升也不降低原有权限。
- 新建安装时，`cordis.patch.yml` 应以 `0o600` 创建（由 DSH 初始化或首次写入时保证）。

### B6. 请求体校验规则（t26）

在解析 JSON 之后、调用纯函数之前，路由层对请求体做严格校验：

**POST /subagents**（`action: 'create'`）：
- `toolName` 必须是字符串，匹配 `^subagent(_[a-z0-9]+)*$`；
- `provider` 必须是 `'spawn'` 或 `'fork'`；
- `backgroundMode` 如果存在，必须是 `'continuable'` 或 `'one-shot'`；
- `agentOptions`（spawn 时必填）中：`provider`、`model` 必须是非空字符串；`reasoningEffort` 如存在，必须是字符串；
- `disabled` 如果存在，必须是布尔值。

**POST /subagents**（`action: 'update'`）：
- `id` 必须是非空字符串；
- `patch` 中每个字段的值必须是对应类型或 `null`；`toolName`、`provider`、`backgroundMode` 不允许为 `null`；`agentOptions` 本身不允许为 `null`（内部字段可以为 `null`）。

**POST /members**（`action: 'add'`）：
- `member.name` 必须是字符串，匹配 `^[a-z][a-z0-9-]*$`。

不合法时返回 400 `INVALID`，文案描述哪个字段不合法。

**id 唯一性（t26 补充）：** `createSubagent` 在 delegation 序列中比对所有行（不仅 dsh-tool-subagent 行），id 重复时返回 `DUPLICATE`，文案「id '<id>' 已存在」。

### B2. 错误文案（逐字）

- `STRUCTURE`：「未找到 preset-standard-acp 的 delegation 组，当前 profile 结构不受支持」／「未找到 agent-teams 配置，请确认已安装 @nanmicoder/dsh-agent-teams」／「未找到团队 profile '<p>'」
- `NOT_FOUND`：「未找到 subagent '<id>'」／「未找到成员 '<name>'」
- `DUPLICATE`：「工具名 '<toolName>' 已存在」／「id '<id>' 已存在」／「成员 '<name>' 已存在」
- `READ_ONLY`：「ACP 后端的 subagent 工具为只读」
- `LAST_MEMBER`：「团队至少需要保留一个成员」
- `INVALID`：具体说明哪个字段不合法，例如「模型 'x' 不在 provider 'y' 的目录中」「provider 'y' 未配置」「reasoning effort 'z' 不被模型 'x' 支持」

结构缺失时，`listSubagents`、`listMembers` 必须抛出 `Error`，且 `message` 使用对应的 `STRUCTURE` 文案；HTTP state 接口则将对应列表置为空，并把文案放入 `errors`。

### B3. 写入保留规则

- 目标项范围之外的原文必须逐字节不变，包括注释、多行字符串和缩进。
- 实现上只允许局部替换或插入目标节点的文本（用 yaml 的 source range 或 CST 做局部拼接），禁止整篇 `doc.toString()` 重排。
- 写入结果必须能被 yaml 重新解析，并且 list 能读回改动。

## C. HTTP 协议

Host 通过 `webServer` 注册路由，并使用 `connection.requestRejection` 做鉴权。当前 profile 没有 `webServer` 时，只打一行日志，不注册路由，也不报错。

### C1. State

```http
GET /plugins/dsh-wuyou-agent/api/state?profile=standard-acp
```

返回 JSON：

```ts
{
  revision: string,
  catalog: ModelCatalog,
  subagents: SubagentRow[],
  teamProfiles: string[],
  profile: string,
  members: TeamMember[],
  errors: { subagents?: string, members?: string },
  diagnostics: {
    atomicWrite: { loaded: boolean, anchor?: string, resolvedPath?: string, tried?: string[] },
    catalogSource: 'runtime' | 'patch',
    catalogErrors?: string[]
  }
}
```

结构缺失时对应字段为 `[]`，`errors` 写 `STRUCTURE` 文案，HTTP 状态仍为 `200`。`profile` 不存在时同样返回 200：`members: []`，`errors.members` 为「未找到团队 profile '<p>'」。

`diagnostics` 字段：

- `atomicWrite.loaded`：`@deepseek-ai/dsh-atomic-write` 是否已加载。为 `true` 时带上成功的 `anchor` 和 `resolvedPath`；为 `false` 时带上按顺序尝试过的 `tried`。锚点顺序依次为：插件自身的 `import.meta.url`、profile 的 `package.json`、`process.argv[1]` 的真实路径（DSH 入口脚本）、从插件解析到的 `@deepseek-ai/cordis`。加载在首次注册路由时惰性执行，结果会被缓存。成功时记一行 info：`wuyou-agent: dsh-atomic-write loaded via <anchor> -> <resolvedPath>`；失败时记 error，并列出全部锚点。
- `catalogSource`：`runtime` 表示目录来自 DSH LLM 注册表；`patch` 表示退回 `readCatalog(yamlText)`。
- `catalogErrors`：运行时查询中已经被 fallback 覆盖的非致命错误，例如某个模型的 `resolveModelInfo` 失败。
- 每个成功的 mutation 响应也带 `diagnostics`。

### C2. Mutation routes

```http
POST /plugins/dsh-wuyou-agent/api/subagents
```

body：`{ expectedRevision, action: 'create'|'update'|'remove', id?, input?, patch? }`。响应 state 中的 `profile` 取 query string 的 `?profile=`，缺省为 `standard-acp`。

```http
POST /plugins/dsh-wuyou-agent/api/members
```

body：`{ expectedRevision, profile, action: 'add'|'update'|'remove', name?, member?, patch? }`

成功：HTTP `200`，返回新的 state，并附 `notice: '已保存，新建会话后生效'`。这份 state 基于本次实际写入的文本构建，不再二次读盘。如果写入后 `errors` 里仍有另一个面板的结构缺失，例如 patch 里没有 agent-teams，也照常返回 200。

失败返回 `{ code, message }`，不包含堆栈。状态码如下：

| code | HTTP 状态 | 说明 |
|---|---:|---|
| `INVALID` | 400 | 请求字段、模型路由或格式不合法；请求体不是合法 JSON 或不是 JSON 对象；缺少 action 或必要参数 |
| `NOT_FOUND` | 404 | 目标行或成员不存在；**写入时团队 profile 不存在**（纯函数返回「未找到团队 profile '<p>'」的 `STRUCTURE`，路由层改为 404） |
| `DUPLICATE` | 409 | 工具名、id 或成员名重复 |
| `STALE_REVISION` | 409 | 乐观锁版本过期 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超过 1MB（`MAX_BODY_BYTES = 1024*1024`）。如果 `content-length` 已声明超限，路由不读请求体，直接拒绝；如果是流式读取中途超限，也立即拒绝。两种情况都不写文件。文案为「请求体超过 1MB 上限」 |
| `READ_ONLY` | 422 | ACP 后端行不可写 |
| `LAST_MEMBER` | 422 | 不允许删除最后一个成员 |
| `STRUCTURE` | 500 | 配置结构不受支持（缺 delegation 组或缺 agent-teams） |
| `INTERNAL` | 500 | 未识别的异常，例如文件系统错误或程序缺陷。文案固定为「服务端内部错误」，细节只写进 Host error 日志 |
| `DEPENDENCY_UNAVAILABLE` | 503 | `@deepseek-ai/dsh-atomic-write` 未加载，无法安全写入。文案为「缺少 @deepseek-ai/dsh-atomic-write，无法安全写入配置」，同时写一行 Host error 日志 |
| 鉴权失败 | 401/403 | `connection.requestRejection` 拒绝请求，body 为 `{error:'unauthorized'\|'forbidden'}` |
| 鉴权服务不可用 | 503 | `connection` 服务未绑定时拒绝请求（fail closed），body 为 `{error:'authentication unavailable'}` |
| 非 POST | 405 | mutation 路由只接受 POST，响应带 `allow: POST` |

`STALE_REVISION` 的文案是「配置已被其他地方修改，请刷新后重试」。

### C3. 写入流程

0. `dsh-atomic-write` 未加载时，直接返回 503 `DEPENDENCY_UNAVAILABLE`，不读也不写文件。
1. 在 profile 目录的 `package.json` 上加文件锁，和 DSH 自己的 `configEditor`、`plugin-manager` 使用同一把锁。
2. 读取 `cordis.patch.yml`，计算 revision，并和 `expectedRevision` 比较；不一致时返回 `STALE_REVISION`，不得修改文件。
3. 在锁内针对这份文本 `await` 模型目录（运行时注册表或 fallback），再调用 B 节的纯函数进行校验和变换。
4. 读取目标文件的当前权限位（`stat.mode & 0o777`）；文件不存在时使用 `0o600`；将该 mode 传给 `writeFileAtomic`，用临时文件加 `rename` 原子写入，保留原有权限。
5. 返回新的 state 和保存 notice。

DSH 的 HMR 会监视 `cordis.patch.yml` 并自动 reconcile，插件不用主动调用 reconcile。

## D. Client 挂载与交互

### D1. 入口形态

产物 `lib/client.js` 必须是以下形态的浏览器 bundle：

```js
window.__ModuleLoader__.load({
  id: '@nanmicoder/dsh-wuyou-agent',
  factory(require) {
    // react 与 react/jsx-runtime 通过宿主 require 获取
    return {
      inject: ['slots'],
      apply(ctx) { /* 注册 settings.section */ }
    }
  }
})
```

- `react` 和 `react/jsx-runtime` 通过 `require` 从宿主获取，不能打包进来。
- 不能 require 任何 `@deepseek-ai/dsh-client-ui-*` 包。
- 控件自己绘制；颜色和间距只使用 `--dsw-alias-*` CSS 变量。

### D2. Settings sections

注册两个 `settings.section`：

```ts
{id:'wuyou-subagents', order:100, label:'无忧Agent · Subagent'}
{id:'wuyou-members', order:101, label:'无忧Agent · 团队成员'}
```

两个 section 的组件 props 都是 `{ close }`。Panel A 对应 subagent 管理，Panel B 对应团队成员管理。

### D3. Store 与请求

- Store 与框架无关，提供 `getSnapshot()`、`subscribe(fn)` 和 action 方法；React 侧使用 `useSyncExternalStore`。
- 所有请求走 api-client 的 fetch，同源并设置 `credentials:'same-origin'`。
- mutation 自动携带 `expectedRevision`。
- 遇到 `409` 时自动刷新 state，并显示「配置已被其他地方修改，请刷新后重试」对应的冲突文案。
- UI 必须能展示读取错误、保存错误、只读行和最后成员保护，不得因结构缺失而让整个 Settings 宿主崩溃。
- 读取 `diagnostics`：
  - `atomicWrite.loaded === false` 时，显示警告「写入依赖 @deepseek-ai/dsh-atomic-write 未加载，暂时只能查看配置」，附上可展开的「已尝试的解析位置」（即 `tried`），并禁用所有写按钮；
  - `catalogSource === 'patch'` 时，显示提示「模型目录来自配置文件，可能不完整」，并列出 `catalogErrors`；
  - Host 返回的 503、413 等**结构化错误** `{ code, message }`，原样显示 `message`。
  - 服务端返回**非结构化响应**（HTML 错误页、纯文本、空 body、JSON 数组、JSON 字符串、JSON null 等无 `code`/`message` 字段的情况）时，统一回退为中文提示：`401`/`403` 显示「没有访问权限，请刷新页面后重新登录」；`503` 显示「服务暂时不可用，请稍后重试」；其他状态码显示「请求失败（HTTP <status>）」。不暴露原始英文异常或原始 body。
- Panel B 的团队 profile：优先使用请求的 profile，其次 `standard-acp`，否则用 `teamProfiles[0]`。只有一个时显示为文字「团队 profile：<p>」，多个时显示为下拉框。Client 不硬编码 DSH profile 名 `web`。

## E. 构建与包

- `package.json` 使用 `type: module`。
- Host 产物为 `lib/index.js`（ESM），Client 产物为 `lib/client.js`。
- `exports` 包含：`.` → `./lib/index.js`，`./client` → `./lib/client.js`，`./package.json` → `./package.json`，`./cordis.patch.yml` → `./cordis.patch.yml`。后两项供 DSH 按包名读取清单和 bundle patch。
- `files` 包含 `lib` 和 `cordis.patch.yml`。
- `dsh.bundle.patch` 为 `./cordis.patch.yml`。
- `dsh.client` 为 `{ platform:'web', inject:['@deepseek-ai/dsh-client-ui-settings-general'] }`。
- `peerDependencies`（均在 `peerDependenciesMeta` 中标 `optional: true`）：
  - `@deepseek-ai/cordis ^4.0.2`
  - `react ^18.2.0`
  - `@deepseek-ai/dsh-atomic-write 0.1.7-rc.2`：运行时由 DSH 提供，按 C1 的锚点加载，缺失时降级为只读
  - `@deepseek-ai/dsh-client-ui-settings-general 0.1.7-rc.2`：`settings.section` 的宿主，Client 只注入它，不 require 它
- `yaml` 是普通 dependency。
- `scripts`：`build` = `build:host`（`tsc`）+ `build:client`（`tsc` 类型检查 + esbuild 包装）；`verify` = `node scripts/verify-runtime-deps.mjs`；`prepack` = `npm run build && npm run verify`，保证打包前产物已构建并通过运行时检查。
- Host 产物中的裸 `require` 必须来自本地 `createRequire()` 绑定，由 `verify` 扫描 `lib/**` 检查。
- 删除全部 Vue 相关依赖和文件。
- 自带 `cordis.patch.yml` 的内容必须是顶层数组，且为：

  ```yaml
  - insert:
      - id: wuyou-agent
        name: '@nanmicoder/dsh-wuyou-agent'
  ```

## F. 安装与隔离验收

安装命令：

```bash
dsh plugin --profile <p> add -w /Users/jwyuan/source_code/dsh-agents-config-panel
```

- 必须带 `-w`（pnpm `--workspace-root`）。profile 目录有 `pnpm-workspace.yaml`（`packages: [.]`），它本身就是 workspace 根，DSH 自带的 pnpm 10.4.1 不带 `-w` 时会拒绝添加依赖（t9 实测）。
- 本地路径必须是绝对路径。
- 安装结果是 `link:` 依赖，并在 profile 的 `node_modules` 下建立指向仓库的符号链接。因此 Node ESM 下，插件的 `import.meta.url` 位于仓库内，`dsh-atomic-write` 要靠 C1 中的 profile 锚点等后续锚点解析。
- plugin-manager 读取 `dsh.bundle` 后，把包加入 `dsh.profile.bundles`；`remove` 时再移除。
- 安装后需要重启 DSH 才会加载。

E2E 只在隔离 profile `wuyou-test` 中进行：使用 `--from-default-profile` 初始化，用空闲端口启动（`dsh --profile wuyou-test --host 127.0.0.1 --port <p> --no-open`），并用启动日志里的 token 链接换取 cookie 后再请求 API。`~/.dsh/profiles/web` 下的文件在验收前后必须完全一致，不得写入、格式化或通过 HMR 间接修改。

## G. Given-When-Then 验收标准

所有场景使用真实结构的脱敏 fixture；涉及安装或浏览器时使用隔离的 `wuyou-test`，不得将生产 profile 作为测试写入目标。

### G0. 覆盖情况

「E2E」指 `scripts/e2e-isolated-profile.sh`，对应 `test/e2e/artifacts-release/run.log` 中的行。最近一次结果为 `E2E_PASS profile=wuyou-test`。

| 场景 | 覆盖测试 |
|---|---|
| G1 真实结构读取 subagent | `src/host/subagent-manager.test.ts`「lists every dsh-tool-subagent row and excludes other delegation names」；`src/client/panels.test.tsx`「fixture sanity」；`test/integration/contract.test.ts`「loads all real delegation rows…」 |
| G2 读取真实团队成员 | `src/host/members-editor.test.ts`「lists the real standard-acp profile and preserves member order and fields」；`src/client/panels.test.tsx`「lists the real standard-acp members」 |
| G3 模型目录 | `src/host/catalog.test.ts`（全部 3 例）；`src/host/runtime-deps.test.ts`「buildCatalog」组；E2E `E2E_CATALOG` |
| G4 新增并保持范围外原文 | `src/host/subagent-manager.test.ts`「creates a spawn row, reads it back, and preserves every byte outside the insertion」；`src/host/http-routes.test.ts`「F1: spawn create with an async catalog…」；E2E `E2E_CREATE`、`E2E_DIFF only=delegation/tool-subagent-e2e` |
| G5 toolName 重复 | `src/host/subagent-manager.test.ts`「rejects duplicate names, invalid fork options…」；客户端预校验见 `src/client/panel-a/subagent-panel-store.test.ts`「validates duplicate toolName client-side」 |
| G6 非 spawn/fork 只读 | `src/host/subagent-manager.test.ts`「keeps ACP rows read-only for both update and remove」；`test/integration/routes.test.ts`「maps read-only ACP mutation…」；`src/client/panels.test.tsx`「marks real ACP rows read-only…」；E2E `E2E_ACP status=422 code=READ_ONLY` |
| G7 最后一个成员 | `src/host/members-editor.test.ts`「removes members until one remains, then returns LAST_MEMBER…」；E2E `E2E_MEMBERS … last=422/LAST_MEMBER` |
| G8 成员局部更新与尾部键 | `src/host/members-editor.test.ts`「updates only coder model while preserving roles, other members, and tail patch keys」；`test/integration/routes.test.ts`「updates one member while preserving the real fixture tail keys」 |
| G9 revision 乐观锁 | `src/host/patch-file.test.ts`「rejects stale revision」；`src/host/http-routes.test.ts`「POST subagents returns 409 on stale revision」；`test/integration/contract.test.ts`「returns 409 for a stale store and auto-refreshes…」；E2E `E2E_STALE status=409 code=STALE_REVISION` |
| G10 浏览器 bundle | E2E `E2E_BROWSER panels=subagents,members moduleLoader=object`；`src/client/panels.test.tsx`「registers both sections with the D2 id/order/label verbatim」。bundle 文件本身的开头、不含 vue、不内联 react 这三项由 `scripts/build-client.mjs` 的包装和 externals 保证，**没有专门的单元测试**，需要人工核对 `lib/client.js` |
| G11 隔离安装与 state 路由 | E2E `E2E_INSTALL`、`E2E_AUTH unauth=401 … authenticated=303`；`test/integration/routes.test.ts`「enforces authentication before serving state」；`src/index.test.ts`「fails closed with 503 while the connection service is unavailable」 |
| G12 生产 profile 哈希不变 | E2E `E2E_CLEANUP … production_hashes_unchanged=1`，`test/e2e/artifacts-release/production-hashes.txt` |
| C2 新增错误码 | `src/host/http-routes.test.ts`：F4（413、400 非法 JSON）、F5（写入时缺团队 profile 返回 404、缺 agent-teams 返回 500）、F6（spawn→fork 删除 agentOptions）、F7（diagnostics）、「unexpected failures return {code, message} without a stack」（INTERNAL）；`src/host/patch-file.test.ts`「throws when atomic write utilities are missing」（DEPENDENCY_UNAVAILABLE） |
| t26 请求体严格校验 / id 唯一性 | `src/host/http-routes.test.ts`「F4: a body over 1MB…」和 invalid-input 相关用例；`src/host/subagent-manager.test.ts`「rejects duplicate names」中 id 冲突部分；E2E `E2E_DUPLICATE` （`test/e2e/artifacts-release/duplicate-id-response.json`、`test/e2e/artifacts-release/invalid-input-response.json`） |
| t30 文件权限保留 | `src/host/patch-file.test.ts` 中「0600 write」、「0640 write」、「patchFileMode ENOENT returns 600」、「patchFileMode only returns permission bits」四条；E2E `E2E_FILE_MODE` （`test/e2e/artifacts-release/file-mode.json`） |
| t30 null 清空字段（Host） | `src/host/members-editor.test.ts`「removes coder multi-line role」、「clears provider and model together」、「clears reasoning_effort」、「provider-only null returns INVALID」等；`src/host/subagent-manager.test.ts`「removes coder's reasoningEffort line」、「spawn reasoningEffort null」等；`src/host/http-routes.test.ts`「带 null 的 patch 返回 200 并删掉对应键」、「必填字段 null 返回 400」 |
| t31 null 清空字段（Client） | `src/client/t31-fixes.test.tsx`「null-clearable fields emit null for {model,provider,reasoning_effort,role}」、「fork row never emits agentOptions」等；`src/client/panel-a/subagent-panel-store.test.ts`、`src/client/panel-b/members-panel-store.test.ts` 中更新后的用例 |
| t31 无改动不发请求 | `src/client/t31-fixes.test.tsx`「no-op submit closes form with notice」；`src/client/panel-a/subagent-panel-store.test.ts`「no-op」；`src/client/panel-b/members-panel-store.test.ts`「no-op」 |
| t31 切换 profile 竞态保护（M1） | `src/client/t31-fixes.test.tsx`「stale profile response is discarded」、「seq guard drops stale load」 |
| t31 输入法 Escape（L1） | `src/client/t31-fixes.test.tsx`「composing: Escape does not close modal」、「after compositionend: Escape closes modal」 |
| t31 中文提示（L2） | `src/client/t31-fixes.test.tsx`「401/403 → zh message」、「503 non-struct → zh message」；`src/client/shared/api-client.test.ts` 对应用例 |
| t32 最终 E2E | `test/e2e/artifacts-release/run.log`（`E2E_PASS`）；`file-mode.json`（0600 保持）；清空响应（`member-role-clear-response.json`、`subagent-effort-clear-response.json`）；重启验证（`E2E_RESTART`）；`production-hashes.txt`（web profile 不变） |
| t36 非结构化错误回退（Client） | `src/client/shared/api-client.test.ts` 中「null body」、「array body」、「string body」、「HTML body」、「empty body」五条用例；`src/client/t31-fixes.test.tsx` 相关断言 |

### G1. 真实结构读取 subagent

```gherkin
Given 一份根为 YAML 序列、包含 insert/preset-standard-acp/delegation/config 序列的真实结构 fixture
  And delegation config 序列包含 13 条 dsh-tool-subagent 行：
    spawn 的 tool-subagent、tool-subagent-coder、tool-subagent-tester、tool-subagent-front-designer
    fork 的 tool-subagent-fork
    ccacp 的 tool-subagent-acp
    cursoracp 的 tool-subagent-cursor、tool-subagent-explore、tool-subagent-architect、tool-subagent-reviewer、tool-subagent-research
    codex 的 tool-subagent-codex 和 claude-code 的 tool-subagent-claude-code，且两行 disabled: true
  And delegation config 序列还包含 tool-subagent-control、tool-subagent-list-agents、workflow-ptc、tool-workflow、tool-ralph 五条其他 name 的行
When 调用 listSubagents(yamlText)
Then 返回上述 13 条 dsh-tool-subagent 行
  And provider 为 spawn 或 fork 的行 editable 为 true
  And provider 不是 spawn 或 fork 的行 editable 为 false
  And disabled 从每一行的行级字段读取
  And五条其他 name 的行不出现在返回值中
```

### G2. 读取真实团队成员

```gherkin
Given agent-teams 是根序列直接项，且 config.profiles.standard-acp.members 含 claude、coder、tester、front-designer、generalist
When 调用 listMembers(yamlText, 'standard-acp')
Then 返回这五个成员
  And 每个成员的其他键原样保留
```

### G3. 读取并校验模型目录

```gherkin
Given fixture 含 llm-pi-ai/config.providers.gpt-gateway.models 中的 gpt-6-luna
  And fixture 含 llm-pi-ai/config.providers.gusu-gateway.models 中的 claude-opus-5-5
  And模型的 reasoningEfforts 使用 YAML map，readCatalog 取 map 的 key
When 调用 readCatalog(yamlText)
Then 目录包含 gpt-gateway 的 gpt-6-luna 和 gusu-gateway 的 claude-opus-5-5
When 调用 validateModelRoute(catalog, 'gpt-gateway', 'gpt-5.6-luna')
Then 返回非 null 的 INVALID 中文错误
When 调用 validateModelRoute(catalog, 'gusu-gateway', 'claude-opus-5-5', 'xhigh')
Then 返回非 null 的 INVALID 中文错误
```

### G4. 新增 subagent 并保持范围外原文

```gherkin
Given fixture 可读写，且 delegation config 序列中没有 subagent_new
  And 输入 provider 为 spawn，agentOptions.provider/model 通过目录校验
When 调用 createSubagent(yamlText, input, catalog)
Then 返回 ok 为 true
  And id 为 tool-subagent-new
  And 新行追加到 delegation config 序列末尾
  And 目标区域之外的原文逐字节不变
  And 再次 listSubagents 能读到新行
```

### G5. toolName 重复

```gherkin
Given delegation 序列已有 toolName 为 subagent_coder 的 subagent 行
When 用同一 toolName 调用 createSubagent
Then 返回 ok 为 false 且 code 为 DUPLICATE
  And message 为「工具名 'subagent_coder' 已存在」
  And YAML 文本不变
```

### G6. 非 spawn/fork 行只读

```gherkin
Given delegation config 序列包含 G1 所列的 13 条 dsh-tool-subagent 行
  And其中 tool-subagent-acp、tool-subagent-cursor、tool-subagent-explore、tool-subagent-architect、tool-subagent-reviewer、tool-subagent-research、tool-subagent-codex、tool-subagent-claude-code 的 provider 不是 spawn 或 fork
When 调用 updateSubagent 或 removeSubagent 处理上述任一 id
Then 返回 ok 为 false 且 code 为 READ_ONLY
  And message 为「ACP 后端的 subagent 工具为只读」
  And YAML 文本不变
When 调用 updateSubagent 或 removeSubagent 处理 provider 为 spawn 或 fork 的行
Then 不因 provider 而返回 READ_ONLY，并按其他校验规则处理
```

### G7. 最后一个成员保护

```gherkin
Given profile standard-acp 只有一个成员
When 调用 removeMember(yamlText, 'standard-acp', name)
Then 返回 ok 为 false 且 code 为 LAST_MEMBER
  And message 为「团队至少需要保留一个成员」
  And YAML 文本不变
```

### G8. 成员局部更新与尾部键保留

```gherkin
Given agent-teams 的 standard-acp 成员包含 coder 及其他成员
  And agent-teams 项末尾存在 value、op: add、path 三个键
When 调用 updateMember(yamlText, 'standard-acp', 'coder', { role: 'updated' }, catalog)
Then 只改 coder 目标成员
  And coder 的其他键、其他成员和注释保持不变
  And value、op、path 三个键仍原样存在
  And listMembers 能读回 updated
```

### G9. revision 乐观锁

```gherkin
Given state 返回 revision 为 r1
  And文件内容在请求前已变为 r2
When POST 任一 mutation route，body.expectedRevision 为 r1
Then HTTP 状态为 409
  And返回 code 为 STALE_REVISION
  And返回 message 为「配置已被其他地方修改，请刷新后重试」
  And文件内容完全不变
```

### G10. 浏览器 bundle

```gherkin
Given 已执行生产构建
When 读取 lib/client.js
Then 文件以 window.__ModuleLoader__.load( 开头
  And文件不包含 vue
  And文件不内联 react 或 react/jsx-runtime
  And包含 wuyou-subagents 与 wuyou-members 两个 settings.section
```

### G11. 隔离 profile 安装与 state 路由

```gherkin
Given wuyou-test 使用 --from-default-profile 初始化，并使用不同端口
When 执行 dsh plugin --profile wuyou-test add /Users/jwyuan/source_code/dsh-agents-config-panel
  And启动该 profile 的 DSH
Then安装成功
  And启动日志没有 "did not activate"
When GET /plugins/dsh-wuyou-agent/api/state?profile=standard-acp
Then HTTP 状态为 200
  And响应为合法 JSON
```

### G12. 生产 profile 哈希不变

```gherkin
Given 已记录 ~/.dsh/profiles/web 下所有验收相关文件的 SHA-256 哈希
When 完成全部 wuyou-test 安装、启动、读取和 mutation 验收
Then ~/.dsh/profiles/web 下文件集合与验收前相同
  And每个文件的哈希与验收前完全一致
```

## H. 测试执行要求

- 先用真实结构的脱敏 fixture 驱动 Host 纯函数测试，再接入 HTTP 和安装 E2E；fixture 不得使用另一种根结构或不存在的成员定位方式。
- 纯函数测试必须覆盖结构缺失、目录校验、重复、只读、最后成员、revision 保护和字节保留。
- HTTP 测试必须覆盖鉴权、200 state、mutation 成功和错误状态码映射。
- E2E 仅在 `wuyou-test` 执行，完成后核对 G12；禁止为了测试修改 `~/.dsh/profiles/web`。

**文档结束**
