# 无忧Agent 插件需求与接口契约

版本：2.13（v2.2–v2.13 的变更见文末 K 节；v2.13 新增 K17 模型可用性测试、K18 流空闲超时）
插件包名：`@luckygoals/dsh-wuyou-agent`  
中文名：无忧Agent  
目标环境：DSH 0.1.7-rc.2  

本文是本轮实现、测试和验收的唯一依据。所有测试 fixture 必须来自真实 `cordis.patch.yml` 的脱敏副本，不能重新发明另一套配置模型。本文不要求修改生产 profile；验收期间仅使用隔离的 `wuyou-test` profile。

## 术语与边界

- **Panel A**：Subagent 工具实例管理面板，读取和维护 `@deepseek-ai/dsh-tool-subagent` 行。
- **Panel B**：Agent-Teams 成员配置面板，读取和维护 `@nanmicoder/dsh-agent-teams` 的成员。
- **profile**：DSH 配置档案；每个 profile 对应自己的 `cordis.patch.yml`。Agent-Teams 的 `config.profiles` 是该插件内部的 profile map，两者名称必须明确区分。
- **revision**：当前 YAML 文本的 SHA-256 十六进制摘要，用于并发写入保护。
- **目标范围**：只修改 Panel A 指定的 delegation 配置序列或 Panel B 指定的成员序列；其余字节必须保持不变。
- **非目标**：不创建或删除 DSH profile，不修改 DSH 或 Agent-Teams 插件源码，不运行时加载/卸载插件，不主动调用 reconcile，不提供 subagent 运行监控。除 K17 中用户在「模型能力」页手动发起的模型测试外，不验证 API key 是否可用。

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
- 一行的 `editable` 为 true，当且仅当 `config.provider` 出现在本次 state 的 `subagentProviders` 中，与 `disabled` 无关。已知的 ACP 行可以编辑和删除。
- provider 未注册的行保持只读，包括 `tool-subagent-codex`（`codex`）和 `tool-subagent-claude-code`（`claude-code`）；不允许把 provider 改成已注册名字，也不允许删除。它们是 `disabled: true` 的未知能力占位行。
- `config` 中可能有 `toolName`、`backgroundMode`、`maxDepth`、`modelSelectionSettings`、`persona`、`agentOptions` 等键；未被契约要求更新的键必须原样保留。`editable === true` 时不返回 `readOnlyReason`；`editable === false` 时必须返回 `readOnlyReason`，文案见 B2。

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
interface SubagentProviderCapabilities {
  agentOptions: boolean
  depthLimit: boolean
  continuable: boolean
  persona: boolean
  toolFilter: boolean
}
interface SubagentProviderInfo {
  name: string
  /** 展示和诊断用途；表单和写入均由 capabilities 及 fork 例外决定。 */
  kind: 'in-process' | 'acp' | 'unknown'
  capabilities: SubagentProviderCapabilities
  source: 'runtime' | 'patch'
}
// runtime 为 { names, providers }，null 时按真实 patch 推断；运行时列表为空也不走 patch 兜底。
resolveSubagentProviders(yamlText: string, runtime: {
  names: string[]
  providers: Record<string, { capabilities: SubagentProviderCapabilities; prepareContinuable: boolean }>
} | null): SubagentProviderInfo[]
interface SubagentRow {
  id: string
  disabled: boolean
  editable: boolean
  config: Record<string, unknown>
  readOnlyReason?: string
}
interface SubagentInput {
  toolName: string
  provider: string
  backgroundMode?: 'continuable'|'one-shot'
  agentOptions?: { provider: string; model: string; reasoningEffort?: string }
}
listSubagents(yamlText, subagentProviders?): SubagentRow[] // editable 按 provider 是否在本次 subagentProviders 中判断
createSubagent(yamlText, input, catalog, subagentProviders?): Result // id = 'tool-subagent-' + toolName 去掉 'subagent_' 前缀、下划线改连字符；追加到 delegation config 序列末尾
updateSubagent(yamlText, id, patch: Partial<SubagentInput>, catalog, subagentProviders?): Result
removeSubagent(yamlText, id, subagentProviders?): Result

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

### B0. Subagent provider 目录与来源

`resolveSubagentProviders(yamlText, runtime)` 是不依赖 Cordis 的纯函数。`kind` 判定为：名字是 `spawn` 或 `fork` 时为 `in-process`；五项 capabilities 全为 false 且 `prepareContinuable === false` 时为 `acp`；其余为 `unknown`。只要 provider 出现在列表里，`unknown` 也按能力位编辑。`outputSchema` 不进入结构，本插件不写该字段。

运行时优先规则：Host 不把 `subagents` 写进插件的 `inject`。服务存在且 `list`、`getProvider` 均可用时，按 `list()` 注册顺序排列，每个名字调用 `getProvider`；`continuable` 取 `typeof prepareContinuable === 'function'`，其余能力从 `provider.capabilities` 读取，缺失按 false。`getProvider` 返回空则丢弃该名字，并记录 `subagent provider '<name>' 已列出但无法读取能力`。服务存在时即使 `list()` 为空，也采用空运行时列表，不合并 patch；每次请求重新调用，不缓存。

仅当 `ctx.get('subagents')` 为 `undefined`、`list`/`getProvider` 非函数或调用抛错时，才从 patch 兜底：固定先加入 `spawn`、`fork`（五项能力 true、continuable true、kind `in-process`、source `patch`），再扫描根序列带 `insert` 的项，读取 `@deepseek-ai/dsh-subagent-acp` 行的 `config.providerName`，空值跳过、重名保留首次，加入能力全 false、continuable false、kind `acp`、source `patch` 的 provider。真实脱敏 fixture 的顺序和结果是 `spawn`、`fork`、`ccacp`、`cursoracp`、`kiroopsuacp`、`kirogptacp`；command、args、env 只用于确认注册行，不放进 state，也不修改。兜底时记录 `subagents 服务尚未绑定，provider 能力来自配置推断`。

### B1. 校验规则

- `toolName` 匹配 `^subagent(_[a-z0-9]+)*$`，在该 delegation 序列所有 subagent 行里唯一，否则 `DUPLICATE`。id 冲突也是 `DUPLICATE`。
- `editable` 为 true 当且仅当当前行 `config.provider` 出现在本次 `subagentProviders`；与 `disabled` 无关。provider 未注册的行，update/remove 在改写前返回 `READ_ONLY`，文件不变。已注册 ACP 行可编辑、可删除。
- 已注册行把 provider 改成未注册名字时返回 `INVALID`（400），文案 `provider '<name>' 未注册`，文件不变。
- 先把 patch 合并到目标行，再按最终 provider 的 capabilities 规范化，最后调用 `assertMountable` 等挂载条件校验。`fork` 是唯一按名字处理的例外：禁止 agentOptions。
- `agentOptions === false` 或 provider 为 fork 时删除 `agentOptions`；目标能力不支持 agentOptions 时删除 `modelSelectionSettings`。`continuable === false` 时将 backgroundMode 规范为 `one-shot`；`depthLimit === false` 时将 maxDepth 规范为 `provider-managed`；`depthLimit === true` 且当前 maxDepth 为 provider-managed 时删除 maxDepth。persona/toolFilter 能力为 false 时删除对应键。目标支持 continuable 时不改写已合法的 backgroundMode。规范化删除不依赖 Client 传 null。
- spawn/fork 继续使用既有校验文案；其他 provider 缺 agentOptions 时返回 `provider '<name>' 必须配置 agentOptions`，不支持 continuable、maxDepth 或 agentOptions 时返回对应中文 INVALID 文案。`assertMountable` 必须检查最终行的 maxDepth、agentOptions、modelSelectionSettings 和 continuable。
- `member.name` 匹配 `^[a-z][a-z0-9-]*$`，同一 profile 内唯一。member 的 provider 和 model 要么都填（并通过 `validateModelRoute`），要么都不填。只剩最后一个成员时 remove 返回 `LAST_MEMBER`。
- **spawn → fork**：patch 设 `provider: 'fork'` 且不带 agentOptions 时删除原有块；显式带 agentOptions 时返回 `INVALID`（fork 不能带 agentOptions）。**fork → spawn** 时 patch 必须补全 agentOptions，按该行 config 缩进写入。
- 纯函数边界不抛异常：字段值无法安全写成 YAML 标量时返回 `INVALID` 并说明字段；只有 B2 结构缺失时 `list*` 才抛 `Error`。
- 用当前值原样重新保存一条可编辑行或一名成员时，结果与原文逐字节相同（no-op）。

### B1.1. Provider 能力与切换规范化

表单按当前 `SubagentProviderInfo.capabilities` 决定字段，不按 ACP 名字分支。唯一名字例外是 `fork`：`suppressAgentOptions = (name === 'fork')`。`agentOptions === true` 且不是 fork 时显示 Agent Provider、Model、Reasoning Effort；`agentOptions === false` 或 fork 时隐藏三级联动且提交不带 agentOptions。`continuable === true` 显示 `continuable`/`one-shot` 下拉，`false` 只显示只读 `one-shot`；`depthLimit === false` 显示只读 `maxDepth：provider-managed`，`true` 不显示 maxDepth。能力为 false 时不保留 persona/toolFilter；`modelSelectionSettings` 不提供表单控件，只在能力仍允许 agentOptions 时原样保留。

从不支持 continuable 的 provider 切到支持者，Background Mode 默认 `continuable`；反向切换规范为 `one-shot`。Host 先按最终 provider 规范化再校验，Client 不传 null 也必须得到同样结果：

| 切换 | Host 自动改写 | Client 必须传 |
|---|---|---|
| spawn → ACP | 删除 `agentOptions`、`modelSelectionSettings`、`persona`、`toolFilter`；`backgroundMode: one-shot`；`maxDepth: provider-managed` | `provider` |
| ACP → spawn | 删除 `maxDepth` | `provider`、完整的 `agentOptions`；`backgroundMode` 只在用户改动时传（表单默认会替用户选 `continuable`） |
| ACP ↔ ACP | 只改 `provider` | `provider` |
| fork → ACP | 与 spawn → ACP 相同 | `provider` |
| ACP → fork | 删除 `maxDepth`；不允许留下 `agentOptions` | `provider`；表单默认 `backgroundMode` 为 `continuable`，并传出 |
| spawn ↔ fork | 沿用 v2.0 | 沿用 v2.0 |

目标 provider `agentOptions === false` 或为 fork 时，即使 Client 多传 agentOptions 也直接删除；但 provider 已是 fork 且本次未改 provider、单独给 fork 行加 agentOptions 时，仍返回 `fork provider 不能配置 agentOptions`。目标 `continuable === false` 写 one-shot；目标 `depthLimit === false` 写 provider-managed；目标 `depthLimit === true` 且当前为 provider-managed 时删除 maxDepth。若按能力无需改写，结果必须与原文逐字节相同。

### B1.2. 新建 provider 行

`subagentProviders` 中每一个已知名字都可用于新建，未注册名字拒绝。新建 ACP 行只写以下键并保持顺序：

```yaml
- id: tool-subagent-<由 toolName 派生，规则不变>
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: <选中的 ACP 名字>
    toolName: <toolName>
    backgroundMode: one-shot
    maxDepth: provider-managed
```

不写 `agentOptions`、`modelSelectionSettings`、`persona`、`toolFilter`、`disabled`；id 在整个 delegation 序列唯一。新建 spawn/fork 沿用现有键，不额外写 maxDepth；Client 未传 backgroundMode 时按目标 continuable 能力默认 continuable 或 one-shot。新建 ACP 即使带 agentOptions 或 `backgroundMode: continuable`，Host 也规范化为合法 ACP 行，不返回 INVALID。

### B1.3. 挂载校验

在测试和 Host 校验中使用与 `dsh-tool-subagent@0.1.7-rc.2` 一致的逻辑，不 import DSH 包。测试 provider 能力直接手写：

```ts
function resolvedMaxDepth(configured: unknown): unknown {
  if (configured === 'provider-managed') return undefined
  if (configured !== undefined) return configured
  return 1
}
function assertMountable(config, provider): void {
  if (resolvedMaxDepth(config.maxDepth) !== undefined && !provider.capabilities.depthLimit) throw new Error('maxDepth')
  if (config.agentOptions !== undefined && !provider.capabilities.agentOptions) throw new Error('agentOptions')
  if (config.modelSelectionSettings === true && !provider.capabilities.agentOptions) throw new Error('modelSelectionSettings')
  if ((config.backgroundMode ?? 'one-shot') === 'continuable' && !provider.prepareContinuable) throw new Error('continuable')
}
```

`provider-managed` 的 maxDepth 解析为 undefined，省略时默认 1；若最终 maxDepth、agentOptions、modelSelectionSettings 或 continuable 与 provider capabilities 不相容，返回对应 INVALID 文案（`provider '<name>' 不支持 backgroundMode continuable`、`provider '<name>' 必须将 maxDepth 设为 provider-managed`、`provider '<name>' 不支持 agentOptions`）。

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

### B6. 请求体校验规则（t26、v2.1）

`validateWriteBody`（`src/host/http-routes.ts`）在读文件、加锁之前运行，只检查类型和形状，遇到第一个不合法的字段就返回 400 `INVALID`，文案统一为 `字段 <name> <原因>`。格式规则（toolName、成员名的正则）、provider 是否已注册、模型路由，都由锁内的纯函数校验，不在这一层。

两条写入路由都要检查：
- `expectedRevision` 必须是 64 位小写十六进制字符串。
- `action` 必须属于该路由允许的集合：subagents 是 `create`/`update`/`remove`/`move`，members 是 `add`/`update`/`remove`。
- `update`/`remove` 必须带非空字符串 `id`（subagents）或 `name`（members）。`move` 必须带非空字符串 `id`。
- `move` 的 `direction` 必须是 `up` 或 `down`，且不能带 `input`/`patch`。
- `input`/`member`/`patch` 必须是普通 JSON 对象；`update` 的 `patch` 不能是空对象。

members 路由还要求 `profile` 是非空字符串。成员对象的字段内容由 `addMember`/`updateMember` 校验。

subagents 路由对 `input` 和 `patch` 的额外要求：
- 只接受 `toolName`、`provider`、`backgroundMode`、`agentOptions` 四个键，其他键返回 `字段 <field>.<key> 不支持`。例如带 `disabled` 会被拒绝，本接口不写 disabled。
- `maxDepth`、`modelSelectionSettings`、`persona`、`toolFilter` 出现时返回 `字段 <name> 不能通过此接口修改`。
- `toolName`、`provider`：可以不出现；出现时必须是非空字符串，传 `null` 返回 `不能清空`。v2.1 不再在路由层把 provider 限制为 spawn/fork。
- `backgroundMode`：可以不出现；出现时必须是 `continuable` 或 `one-shot`，传 `null` 返回 `不能清空`。
- `agentOptions` 必须是 JSON 对象，只接受 `provider`、`model`、`reasoningEffort` 三个键；内部字段值的合法性由纯函数判断，`reasoningEffort: null` 表示清空。

create 生成的 id 要和 delegation 序列中的所有行比较，不只是 dsh-tool-subagent 行；冲突返回 `DUPLICATE`。

### B2. 错误文案（逐字）

- `STRUCTURE`：「未找到 preset-standard-acp 的 delegation 组，当前 profile 结构不受支持」／「未找到 agent-teams 配置，请确认已安装 @nanmicoder/dsh-agent-teams」／「未找到团队 profile '<p>'」
- `NOT_FOUND`：「未找到 subagent '<id>'」／「未找到成员 '<name>'」
- `DUPLICATE`：「工具名 '<toolName>' 已存在」／「id '<id>' 已存在」／「成员 '<name>' 已存在」
- `READ_ONLY`：`provider '<name>' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑`
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
  subagentProviders: SubagentProviderInfo[],
  teamProfiles: string[],
  profile: string,
  members: TeamMember[],
  errors: { subagents?: string, members?: string },
  diagnostics: {
    hostApi: 2,
    atomicWrite: { loaded: boolean, anchor?: string, resolvedPath?: string, tried?: string[] },
    catalogSource: 'runtime' | 'patch',
    catalogErrors?: string[],
    subagentProvidersSource: 'runtime' | 'patch',
    subagentProviderErrors?: string[]
  }
}
```

结构缺失时对应字段为 `[]`，`errors` 写 `STRUCTURE` 文案，HTTP 状态仍为 `200`。`profile` 不存在时同样返回 200：`members: []`，`errors.members` 为「未找到团队 profile '<p>'」。

`diagnostics` 字段：

- `atomicWrite.loaded`：`@deepseek-ai/dsh-atomic-write` 是否已加载。为 `true` 时带上成功的 `anchor` 和 `resolvedPath`；为 `false` 时带上按顺序尝试过的 `tried`。锚点顺序依次为：插件自身的 `import.meta.url`、profile 的 `package.json`、`process.argv[1]` 的真实路径（DSH 入口脚本）、从插件解析到的 `@deepseek-ai/cordis`。加载在首次注册路由时惰性执行，结果会被缓存。成功时记一行 info：`wuyou-agent: dsh-atomic-write loaded via <anchor> -> <resolvedPath>`；失败时记 error，并列出全部锚点。
- `catalogSource`：`runtime` 表示目录来自 DSH LLM 注册表；`patch` 表示退回 `readCatalog(yamlText)`。
- `catalogErrors`：运行时查询中已经被 fallback 覆盖的非致命错误，例如某个模型的 `resolveModelInfo` 失败。
- `hostApi` 固定为 `2`，供新 Client 判断 provider 能力和 ACP 编辑契约是否可用。
- `subagentProvidersSource` 为 `runtime` 或 `patch`，分别表示运行时 `ctx.get('subagents')` 能力目录或 patch 兜底；`subagentProviderErrors` 收集 provider 能力读取失败和 patch 兜底提示。
- provider 列表每次构建 state 及每次文件锁内写入前重新解析；路由仍在 `webServer` 与 `profileContext` 就绪后注册，不等待 `subagents`。服务晚绑定时下一次 state 或 mutation 自动切到 runtime，不需重启。
- 每个成功的 mutation 响应也带 `diagnostics`。

### C2. Mutation routes

```http
POST /plugins/dsh-wuyou-agent/api/subagents
```

body：`{ expectedRevision, action: 'create'|'update'|'remove'|'move', id?, input?, patch?, direction? }`。`move` 时 body 为 `{ expectedRevision, action: 'move', id, direction }`，其中 `direction` 为 `up` 或 `down`，且不带 `input`/`patch`。响应 state 中的 `profile` 取 query string 的 `?profile=`，缺省为 `standard-acp`。

```http
POST /plugins/dsh-wuyou-agent/api/members
```

body：`{ expectedRevision, profile, action: 'add'|'update'|'remove', name?, member?, patch? }`

成功：HTTP `200`，返回新的 state，并附 `notice`。普通写入提示为 `已保存，新建会话后生效`；`move` 上移提示为 `已上移。只改变列表顺序，不影响模型看到的工具顺序`，下移提示为 `已下移。只改变列表顺序，不影响模型看到的工具顺序`。这份 state 基于本次实际写入的文本构建，不再二次读盘。如果写入后 `errors` 里仍有另一个面板的结构缺失，例如 patch 里没有 agent-teams，也照常返回 200。

失败返回 `{ code, message }`，不包含堆栈。状态码如下：

| code | HTTP 状态 | 说明 |
|---|---:|---|
| `INVALID` | 400 | 请求字段、模型路由或格式不合法；请求体不是合法 JSON 或不是 JSON 对象；缺少 action 或必要参数 |
| `NOT_FOUND` | 404 | 目标行或成员不存在；**写入时团队 profile 不存在**（纯函数返回「未找到团队 profile '<p>'」的 `STRUCTURE`，路由层改为 404） |
| `DUPLICATE` | 409 | 工具名、id 或成员名重复 |
| `STALE_REVISION` | 409 | 乐观锁版本过期 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超过 1MB（`MAX_BODY_BYTES = 1024*1024`）。如果 `content-length` 已声明超限，路由不读请求体，直接拒绝；如果是流式读取中途超限，也立即拒绝。两种情况都不写文件。文案为「请求体超过 1MB 上限」 |
| `READ_ONLY` | 422 | provider 未注册的行不可写；message 为 `provider '<name>' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑` |
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
  id: '@luckygoals/dsh-wuyou-agent',
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
- 根 `inject` 仍为 `['slots']`。现有两个 section 在 `apply` 中直接注册；「模型能力」通过独立的子 fiber 等待设置服务：

  ```ts
  ctx.inject(
    ['slots', 'configForms', 'remote', 'remote.settings', 'remote.credentials'],
    (sub) => { registerModelCapabilities(sub); },
  );
  ```

  子 fiber 的依赖未齐时不注册「模型能力」；依赖消失时只卸载该 section，不影响前两个 section。带点的服务名通过 `sub['remote.settings']` 与 `sub['remote.credentials']` 访问。

### D2. Settings sections

注册三个 `settings.section`（模型能力由 D1 的子 fiber 注册）：

```ts
{id:'wuyou-model-capabilities', order:99, label:'模型能力'}
{id:'wuyou-subagents', order:100, label:'无忧Subagent'}
{id:'wuyou-members', order:101, label:'无忧Teams'}
```

三个 section 的组件 props 都是 `{ close }`。Panel A 对应 subagent 管理，Panel B 对应团队成员管理，Panel C 对应模型能力；Panel C 依赖设置服务，服务不可用时不显示且不影响前两个 section。

### D3. Store 与请求

- Store 与框架无关，提供 `getSnapshot()`、`subscribe(fn)` 和 action 方法；React 侧使用 `useSyncExternalStore`。
- Panel A、Panel B 的请求走 api-client 的 fetch，同源并设置 `credentials:'same-origin'`；该约束只适用于这两个已有 section。Panel C「模型能力」不走 api-client，使用 D1 子 fiber 注入的 `configForms`、`remote.settings`、`remote.credentials`。
- mutation 自动携带 `expectedRevision`。
- 遇到 `409` 时自动刷新 state，并显示「配置已被其他地方修改，请刷新后重试」对应的冲突文案。
- UI 必须能展示读取错误、保存错误、只读行和最后成员保护，不得因结构缺失而让整个 Settings 宿主崩溃。
- 读取 `diagnostics`：
  - `atomicWrite.loaded === false` 时，显示警告「写入依赖 @deepseek-ai/dsh-atomic-write 未加载，暂时只能查看配置」，附上可展开的「已尝试的解析位置」（即 `tried`），并禁用所有写按钮；
  - `catalogSource === 'patch'` 时，显示提示「模型目录来自配置文件，可能不完整」，并列出 `catalogErrors`；
  - Host 返回的 503、413 等**结构化错误** `{ code, message }`，原样显示 `message`。
  - 服务端返回**非结构化响应**（HTML 错误页、纯文本、空 body、JSON 数组、JSON 字符串、JSON null 等无 `code`/`message` 字段的情况）时，统一回退为中文提示：`401`/`403` 显示「没有访问权限，请刷新页面后重新登录」；`503` 显示「服务暂时不可用，请稍后重试」；其他状态码显示「请求失败（HTTP <status>）」。不暴露原始英文异常或原始 body。
- Panel B 的团队 profile：优先使用请求的 profile，其次 `standard-acp`，否则用 `teamProfiles[0]`。团队 profile 始终显示为下拉框（v2.5，见 K8）。Client 不硬编码 DSH profile 名 `web`。

### D4. Panel A provider 能力表单

Provider 下拉选项就是 `subagentProviders` 中的 name，按数组顺序排列，不写死 spawn/fork。编辑对话框按选中 provider 的 capabilities 显示控件：

| 条件 | 控件与提交 |
|---|---|
| `agentOptions === true` 且不是 fork | Agent Provider、Model、Reasoning Effort；数据来自现有 LLM catalog |
| `agentOptions === false` 或 fork | 隐藏三级联动，提交不带 agentOptions |
| `continuable === true` | Background Mode 可选 continuable/one-shot |
| `continuable === false` | 不显示下拉，只显示只读 one-shot |
| `depthLimit === false` | 显示只读 `maxDepth：provider-managed` |
| `depthLimit === true` | 不显示 maxDepth，本版不开放数值修改 |

spawn 对话框包含工具名、Provider、Agent Provider、Model、Reasoning Effort、Background Mode；fork 包含工具名、Provider、Background Mode；ACP 包含工具名、Provider、只读 one-shot、只读 provider-managed。ACP 或 fork 切到 spawn 时显示三级联动并补完整 agentOptions，默认 Background Mode 为 continuable；spawn 切到 ACP 时 patch 只带 provider（及确实改过的 toolName）。diff 永远不包含 maxDepth、modelSelectionSettings、persona、toolFilter。

`validateForm` 中 provider 必须存在于 `subagentProviders`，否则提示 `provider '<name>' 未注册`；显示三级联动时沿用 agentOptions.provider/model 必填，不显示时不要求且 diff 不带 agentOptions。`continuable === false` 时表单值必须为 one-shot，只有与原行不同才写 patch；从 ACP/fork 切 spawn 时 diff 带完整 agentOptions。`openEdit`/`requestDelete` 对不可编辑行不发请求，展示 `readOnlyReason`。新建时所有已知 provider 可选；ACP 新建写入 provider、toolName、backgroundMode: one-shot、maxDepth: provider-managed，不写 agentOptions、modelSelectionSettings、persona、toolFilter、disabled。
### D5. Panel B 固定两行布局

成员表固定两行，不做响应式一行/两行切换。每个成员一个 `<tbody>`，包含两行 `<tr>`；表头只有成员名、角色、操作三列。第一行放成员名和角色，操作单元格 `rowspan="2"` 且靠上；第二行（v2.3）为 `colSpan={3}` 横跨整个表格，以 `<dl>` 横排 Provider、Model、Reasoning Effort，空值显示 `-`。

列宽固定（v2.9，见 K12）：表格 `table-layout: fixed`、`min-width: 420px`，`<colgroup>` 为成员名 30%、角色自适应、操作 136px。成员名 `white-space: nowrap`，超出列宽时 `overflow: hidden; text-overflow: ellipsis`，`title` 为完整成员名，禁止 `overflow-wrap: anywhere`；角色 `white-space: pre-line`（保留多行角色的换行，v2.2）、`overflow-wrap: break-word`；操作列 nowrap。成员两行之间无分隔线，不同成员以 `var(--dsw-alias-border-l1)` 分隔。第二行字号 12px，dt 使用 `var(--dsw-alias-label-secondary)`、dd 使用 `var(--dsw-alias-label-primary)`；按钮为普通 `<button>`，不设 tabIndex，第二行无可聚焦元素。空列表显示一行 `colSpan={3}`，文案「暂无成员」。表格样式只写在 `MembersPanel.tsx`，不修改共享 `PanelChrome.tsx` 的 tableStyles；Panel A 表格不变（两个面板的根容器共用 `panelRootStyle`，见 K12）。

### D6. 新 Client 配旧 Host

当 `diagnostics.hostApi` 缺失或不为 `2` 时，新 Client 不使用 `subagentProviders`，provider 下拉退回只有 spawn/fork；ACP 行编辑、删除禁用且不发送 ACP 写入请求。Panel A 顶部显示「当前界面已更新，Subagent 的 ACP 编辑需要重启 DSH 后生效」，颜色使用 `var(--dsw-alias-label-secondary)`。旧 Host 仍以 422 `READ_ONLY` 拒绝 ACP 非法写入，不写出非法配置。该提示只挂在 SubagentPanel。

### D7. Panel C 模型能力

Panel C 的 section 为 `{id:'wuyou-model-capabilities', order:99, label:'模型能力'}`，由 D1 子 fiber 注册。它是 Client-only 的设置编辑器，不新增写配置的 Host 路由，配置读写也不使用 D3 的 api-client（K17 的只读模型测试经 api-client 调用 `POST /models/test`，是唯一例外）；通过注入的 `configForms` 读取 namespace snapshot，通过 `remote.settings` 和 `remote.credentials` 写入。

- 支持 `llm-pi-ai` 自定义提供方与 `llm-deepseek` 官方提供方；缺少其中一个 namespace 时只隐藏对应卡片，section 仍显示。DeepSeek 的 UI route id 为 `deepseek-official`，但写入 path 不得包含该 id。
- 模型容量和输入只有已设置/未设置两种状态；提供方级默认键 defaultInput/reasoning/defaultContextWindow/defaultMaxTokens（pi）与 defaultContextWindow/maxTokens（DS）面板不展示、不编辑，原样保留；DeepSeek 的 thinking/reasoningEffort 仍可编辑
- 凭证明文只在 store 私有闭包中保存，snapshot、草稿和预览只暴露是否已配置。凭证按 64 项分批读写；保存顺序为 Pi 设置、DeepSeek 设置、凭证。
- `remote.settings.mutate` 返回 `{ok:true,value}` 或 `{ok:false,error}`，不以抛异常作为业务失败通道。设置事件与凭证事件分别处理；自身写入的 settings 回声静默，外部 settings 变更显示冲突并保留草稿。
- 只读条件包括非本机、配置描述不可用、视图不可写或目标 config form 为 memory 模式。只读时仍可浏览、预览、取消和重新加载，所有写入按钮禁用。
- 输入容量只接受正整数及 `K/k`、`M/m` 缩写；空值表示继承，非法或不安全的值阻止对应写入。批量编辑的 `scope='sel'` 使用进入批量编辑时的 `selSnapshot`，未进入结果的模型才计入 `L`。

Panel C 不改变 Panel A、Panel B 的 store、Host 路由、section 注入边界或共享 UI 组件；设置服务不齐全时只有 Panel C 被卸载。

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
        name: '@luckygoals/dsh-wuyou-agent'
  ```

### E1. 开发验证与热更新

开发期间只运行 Vitest 和不输出文件的类型检查：`npx tsc -p tsconfig.json --noEmit`、`npx tsc -p tsconfig.client.json --noEmit`；只在最终验证时执行一次 `npm run build`。插件以符号链接安装，DSH client-hmr 每 500ms 对 `lib/client.js` 做一次 stat；一次最终 build 后，用户正在使用的界面即可加载新的 Client，Host 端需要重启 DSH 才生效。

最终 build 后、重启 DSH 前允许出现新 Client + 旧 Host：旧 Host state 没有 `subagentProviders` 和 `diagnostics.hostApi`，ACP 行写入仍返回 422 `READ_ONLY`，不能写出非法内容；新 Client 按 D6 检测缺失或非 2 的 hostApi，退回 spawn/fork 下拉、禁用 ACP 编辑删除，并显示重启提示。

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

「E2E」指 `scripts/e2e-isolated-profile.sh` 打印到标准输出的 `E2E_*` 行。
- v2.1 最终证据：`test/e2e/artifacts-v2.1-r2/`，是 t49 修复后由 t51 重跑的结果，以 `E2E_PASS profile=wuyou-test` 结束。这个目录里没有 `run.log`。
- v2.0 证据：`test/e2e/artifacts-release/run.log`。

以上都是本地生成的文件，已被 `.gitignore` 忽略。表中引用的测试名都已在源码中逐字确认。

| 场景 | 覆盖测试 |
|---|---|
| G1 真实结构读取 subagent | `src/host/subagent-manager.test.ts`「lists every dsh-tool-subagent row and excludes other delegation names」；`src/client/panels.test.tsx`「fixture sanity」；`test/integration/contract.test.ts`「loads all real delegation rows…」 |
| G2 读取真实团队成员 | `src/host/members-editor.test.ts`「lists the real standard-acp profile and preserves member order and fields」；`src/client/panels.test.tsx`「lists the real standard-acp members」 |
| G3 模型目录 | `src/host/catalog.test.ts`（全部 3 例）；`src/host/runtime-deps.test.ts`「buildCatalog」组；E2E `E2E_CATALOG` |
| G4 新增并保持范围外原文 | `src/host/subagent-manager.test.ts`「creates a spawn row, reads it back, and preserves every byte outside the insertion」；`src/host/http-routes.test.ts`「F1: spawn create with an async catalog…」；E2E `E2E_CREATE`、`E2E_DIFF only=delegation/tool-subagent-e2e` |
| G5 toolName 重复 | `src/host/subagent-manager.test.ts`「rejects duplicate names, invalid fork options…」；客户端预校验见 `src/client/panel-a/subagent-panel-store.test.ts`「validates duplicate toolName client-side」 |
| G6 provider 注册与只读占位 | `src/host/subagent-manager.test.ts`「keeps unregistered provider rows read-only for both update and remove」「allows removing a known ACP row and changes no neighboring bytes」；`test/integration/routes.test.ts`「allows registered ACP updates and rejects unregistered providers without changing the file」；`src/client/panels.test.tsx`「v2.1: registered ACP rows are editable, unregistered codex/claude-code rows stay read-only」；E2E `E2E_ACP_READONLY status=422 code=READ_ONLY`（codex 占位行，`acp-readonly-response.json`）、`E2E_ACP_EDIT` |
| v2.1 provider 目录（运行时优先 / patch 兜底） | `src/host/subagent-providers.test.ts`「infers spawn, fork, and every ACP registration from the real patch」「uses runtime names and registration order without merging patch-only providers」「treats an empty runtime as authoritative instead of falling back to patch」；`src/host/http-routes.test.ts`「F0: state exposes the real ACP provider directory and host API version」；E2E 在重启后检查 `hostApi === 2`、`subagentProvidersSource === 'runtime'`、列表含 spawn/fork/e2eacp/e2eacp2 |
| v2.1 切换规范化与挂载 | `src/host/subagent-manager.test.ts`「drops modelSelectionSettings when the default spawn row switches to cursoracp」「normalizes fork → ccacp and preserves only target-row bytes」「normalizes ccacp → fork by removing maxDepth and agentOptions」「preserves one-shot when ccacp → fork omits backgroundMode」「normalizes ccacp → spawn with supplied agentOptions and no maxDepth key」「removes persona and toolFilter before switching a spawn row to ACP」「keeps a real ACP row byte-identical when its effective values do not change」「rejects an update to an unknown provider without changing the fixture」「creates a normalized ACP row with the exact v2.1 key set and order」；`src/host/http-routes.test.ts`「rejects immutable subagent field …」；E2E `E2E_ACP_CONVERT`、`E2E_ACP_CREATE … maxDepth=provider-managed`、`E2E_INVALID_PROVIDER`、`E2E_ACP_BACK_TO_SPAWN`，每次重启后跑 `E2E_R6_MOUNT_CHECK`，并用 `E2E_R6_NEGATIVE` 证明检测器能发现挂载错误 |
| v2.1 表单按能力显示 | `src/client/panel-a/subagent-panel-t49.test.tsx`「ACP dialog: no cascade, read-only one-shot and read-only maxDepth：provider-managed」「spawn dialog: …」「fork dialog: …」「provider drop-down lists subagentProviders in array order」「ACP → spawn: Background Mode becomes continuable and is sent」「spawn → ACP: Background Mode becomes one-shot」；`src/client/panel-a/subagent-panel-store-v2.test.ts`「spawn→ACP sends only provider (Host handles the rest)」 |
| v2.1 Panel B 两行布局 | `src/client/panels.test.tsx`「v2.1 §7: one tbody per member, two rows, three header columns」「v2.1 §7: empty values show "-" and an empty list is a single colSpan=3 row」。**E2E 不检查这个布局**：`E2E_BROWSER` 只确认两个面板能打开，布局由 SSR 渲染测试覆盖 |
| v2.1 新 Client + 旧 Host | `src/client/panel-a/subagent-panel-t49.test.tsx`「shown with label-secondary colour when hostApi is missing; drop-down falls back to spawn/fork」「hostApi 1 is treated as old even if the response carries a provider list」「not shown for hostApi 2」；`src/client/panel-a/subagent-panel-store-v2.test.ts`「hostApi !== 2: drop-down is spawn/fork only and no ACP write is sent (contract §9)」。**E2E 没有真正跑旧 Host 场景**，只有单元测试覆盖 |
| G7 最后一个成员 | `src/host/members-editor.test.ts`「removes members until one remains, then returns LAST_MEMBER…」；E2E `E2E_MEMBERS … last=422/LAST_MEMBER` |
| G8 成员局部更新与尾部键 | `src/host/members-editor.test.ts`「updates only coder model while preserving roles, other members, and tail patch keys」；`test/integration/routes.test.ts`「updates one member while preserving the real fixture tail keys」 |
| G9 revision 乐观锁 | `src/host/patch-file.test.ts`「rejects stale revision」；`src/host/http-routes.test.ts`「POST subagents returns 409 on stale revision」；`test/integration/contract.test.ts`「returns 409 for a stale store and auto-refreshes…」；E2E `E2E_STALE status=409 code=STALE_REVISION` |
| G10 浏览器 bundle | E2E `E2E_BROWSER panels=subagents,members moduleLoader=object`；`src/client/panels.test.tsx`「registers both sections with the D2 id/order/label verbatim」。bundle 文件本身的开头、不含 vue、不内联 react 这三项由 `scripts/build-client.mjs` 的包装和 externals 保证，**没有专门的单元测试**，需要人工核对 `lib/client.js` |
| G11 隔离安装与 state 路由 | E2E `E2E_INSTALL`、`E2E_AUTH unauth=401 … authenticated=303`；`test/integration/routes.test.ts`「enforces authentication before serving state」；`src/index.test.ts`「fails closed with 503 while the connection service is unavailable」 |
| G12 生产 profile 哈希不变 | E2E `E2E_CLEANUP … production_hashes_unchanged=1`；`test/e2e/artifacts-v2.1-r2/production-hashes.txt` 记录 web 的 `cordis.patch.yml`、`package.json` 前后哈希和权限位（均为 600） |
| C2 新增错误码 | `src/host/http-routes.test.ts`：F4（413、400 非法 JSON）、F5（写入时缺团队 profile 返回 404、缺 agent-teams 返回 500）、F6（spawn→fork 删除 agentOptions）、F7（diagnostics）、「unexpected failures return {code, message} without a stack」（INTERNAL）；`src/host/patch-file.test.ts`「throws when atomic write utilities are missing」（DEPENDENCY_UNAVAILABLE） |
| t26 请求体严格校验 / id 唯一性 | `src/host/http-routes.test.ts` 中参数化的「… → 400 INVALID before any read or lock」、「rejects immutable subagent field …」；`src/host/subagent-manager.test.ts`「F22-ID: new ids are unique against every delegation row, not only subagent rows」「F22-ID: renaming a subagent onto a non-subagent row id is DUPLICATE」；E2E `E2E_INVALID_INPUT`、`E2E_DUPLICATE_ID`（`invalid-input-response.json`、`duplicate-id-response.json`） |
| t30 文件权限保留 | `src/host/patch-file.test.ts` 的「R28-01: preserves the patch file permission bits」组：参数化的「keeps 600/640 after an update and after an identical re-save」、「uses 0600 when the patch file does not exist」、「reports the existing permission bits only (no type bits)」；E2E `E2E_FILE_MODE`（`file-mode.json`：initial/afterWrite/afterResave 均为 600） |
| t30 null 清空字段（Host） | `src/host/members-editor.test.ts` 的「M2: null clears an optional member field」组：「removes coder's whole multi-line role block and nothing else」「clears provider and model together」「clears reasoning_effort alone」「rejects clearing provider while keeping model」「rejects clearing the required name」「clearing an absent key is a byte-identical no-op」「clears a field written on the sequence item line without breaking the item」；`src/host/subagent-manager.test.ts` 的「M2: null clears agentOptions.reasoningEffort」组；`src/host/http-routes.test.ts`「M2: null values for clearable fields pass validation and clear the keys」「M2: null for a required field is a 400 naming the field, file unchanged」；E2E `E2E_CLEAR_ROLE`、`E2E_CLEAR_EFFORT`（`member-role-null-response.json`、`subagent-effort-null-response.json`、`member-provider-null-response.json`） |
| t31 null 清空字段（Client） | `src/client/t31-fixes.test.tsx`「clearing role sends exactly {role:null}」「clearing provider and model (the cascade the form performs) sends nulls for all three route keys」「clearing reasoningEffort sends agentOptions.reasoningEffort=null and nothing else」，以及「M2 nullable-field set matches the Host (t30)」组 |
| t31 无改动不发请求 | `src/client/t31-fixes.test.tsx`「saving with no changes sends no request, closes the form and says so」；`src/client/panel-a/subagent-panel-t49.test.tsx`「opening an ACP row without backgroundMode and saving unchanged sends nothing」 |
| t31 切换 profile 竞态保护（M1） | `src/client/t31-fixes.test.tsx` 的「M1 members store: stale responses are discarded」组（「A issued first, B answered first, A answered last → the panel shows B」「a failure of the superseded request does not surface as an error」「409 keeps loading=true and the profile picker disabled until the refresh lands」）和「M1 subagent store: same protection」组 |
| t31 输入法 Escape（L1） | `src/client/t31-fixes.test.tsx` 的「L1 composition guard」组：「ignores Escape while isComposing」「ignores Escape with keyCode 229」「ignores keys during composition and exactly one keydown right after compositionend」等 |
| t31 中文提示（L2） | `src/client/t31-fixes.test.tsx`「shared messages equal what the Host returns for the same case (real fixture)」「every client message contains Chinese text」；`src/client/shared/api-client.test.ts`「gives auth rejections ({error} bodies) Chinese fallback text」 |
| t32 v2.0 最终 E2E | `test/e2e/artifacts-release/run.log`（`E2E_PASS`），包含 `E2E_FILE_MODE`、`E2E_CLEAR_ROLE`、`E2E_CLEAR_EFFORT`、`E2E_RESTART`，以及 `production-hashes.txt`。v2.1 重跑了同样的步骤，结果在 `artifacts-v2.1-r2/` |
| t36 非结构化错误回退（Client） | `src/client/shared/api-client.test.ts` 的「malformed error bodies (T34-API-001)」组：「null body → Chinese HTTP fallback」「array body → …」「JSON string body → …」「HTML body (non-JSON) → …」「empty body → …」 |

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
  And provider 出现在 subagentProviders 的行 editable 为 true，与 disabled 无关
  And provider 未注册的 codex 和 claude-code 行 editable 为 false，并带 readOnlyReason
  And disabled 从每一行的行级字段读取
  And五条其他 name 的行不出现在返回值中
```

### G1.1. Provider 列表运行时优先与 patch 兜底

```gherkin
Given fixture 根序列包含 spawn、fork 以及 ccacp、cursoracp、kiroopsuacp、kirogptacp 的真实 ACP 注册行
When resolveSubagentProviders(fixture, null)
Then 列表依次为 spawn、fork、ccacp、cursoracp、kiroopsuacp、kirogptacp
  And source 全部为 patch
When 传入非空 runtime names 与 providers
Then 按 runtime list 顺序返回且不合并 patch 名字
When runtime list 返回空数组
Then 返回空列表且不回退 patch
```

### G1.2. Provider 能力切换与挂载校验

```gherkin
Given 使用真实 fixture 和手写 provider capabilities（ACP 五项能力均 false、prepareContinuable 缺失）
When 依次执行 tool-subagent-coder 的 spawn→ccacp、spawn→cursoracp、spawn→fork
  And执行 tool-subagent→cursoracp、tool-subagent-fork→ccacp、ccacp→fork、ccacp↔cursoracp
  And执行 tool-subagent-acp→spawn，并传入完整 agentOptions
Then 每次读回的目标 config 都通过 assertMountable
  And能力为 false 的最终行不含 persona、toolFilter
  And spawn→ACP 删除 agentOptions/modelSelectionSettings，写 one-shot/provider-managed
  And ACP→spawn 删除 maxDepth 并保留完整 agentOptions
  And ACP↔ACP 只改 provider
  And ACP→fork 删除 maxDepth 且不含 agentOptions
```

### G1.3. 局部保留、未知 provider 和新建 ACP

```gherkin
Given fixture 的真实 ACP 行、真实 spawn 行和带 persona/toolFilter 的 spawn 副本
When no-op 保存真实 ACP 行或只改真实 spawn 行 backgroundMode
Then ACP 行逐字节不变，spawn 行只改变 backgroundMode
When 对 tool-subagent-codex update 或 remove
Then 返回 READ_ONLY，message 为「provider 'codex' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑」，文件字节不变
When 把已注册 spawn 行的 provider 改成 codex
Then 返回 INVALID，message 为「provider 'codex' 未注册」，文件字节不变
When 新建 provider 为 ccacp 的 subagent
Then 只写 id、name、provider、toolName、backgroundMode: one-shot、maxDepth: provider-managed
  And不写 agentOptions、modelSelectionSettings、persona、toolFilter、disabled
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

### G6. 未注册 provider 行只读、已知 ACP 可编辑

```gherkin
Given delegation config 序列包含已注册的 ccacp/cursoracp 行，以及未注册的 codex、claude-code disabled 占位行
When 调用 updateSubagent 或 removeSubagent 处理已注册 ACP 行
Then 不因 ACP provider 而返回 READ_ONLY，并按能力规范化和其他校验规则处理
When 调用 updateSubagent 或 removeSubagent 处理 provider 为 codex 的行
Then 返回 ok 为 false 且 code 为 READ_ONLY
  And message 为「provider 'codex' 未注册，此行只读。安装对应插件并重启 DSH 后再编辑」
  And YAML 文本不变
When 把已注册行 provider 改为 codex
Then 返回 ok 为 false 且 code 为 INVALID
  And message 为「provider 'codex' 未注册」
```

### G6.1. Client store 与组件按能力渲染

```gherkin
Given state 的 subagentProviders 含 spawn（agentOptions/continuable true）、fork（agentOptions false/continuable true）和 ACP（五项能力 false）
When 打开 ACP 编辑项
Then 不显示三级联动，Background Mode 不是 select，并显示只读 one-shot 和 provider-managed
When 打开 spawn 编辑项
Then 显示 Agent Provider、Model、Reasoning Effort 和 Background Mode 下拉
When 打开 fork 编辑项
Then 不显示三级联动，并显示 Background Mode 下拉
When 将 ACP 切到 spawn 并提交
Then Background Mode 默认 continuable，patch 带完整 agentOptions
When 将 spawn 切到 ACP 并提交
Then patch 只有 provider（以及确实改过的 toolName）
When state 缺少 hostApi
Then ACP 编辑按钮禁用、provider 下拉只有 spawn/fork，不发送 ACP 写入请求
```

覆盖层：`src/client/panel-a/subagent-panel-store.test.ts` 覆盖切换和 patch；`src/client/panels.test.tsx` 覆盖组件字段、select/只读文本、禁用操作；`src/client/t31-fixes.test.tsx` 覆盖 nullable patch、竞态和旧 Host 中文提示。

### G6.2. Panel B 固定两行

```gherkin
Given members 含 provider、model、reasoning_effort 和 role 的标准 profile
When 渲染 MembersPanel
Then 每个成员对应一个 tbody 且包含两行 tr
  And表头只有三列
  And第一行包含成员名和角色，操作单元格 rowSpan 为 2
  And第二行包含 Provider、Model、Reasoning Effort 的 dt/dd，空值显示 -
  And成员名 whiteSpace 为 nowrap，第二行无可聚焦元素
Given members 为空
When 渲染 MembersPanel
Then 只显示一行 colSpan 为 3，文案为「暂无成员」
```

覆盖层：`src/client/panels.test.tsx` 的组件断言覆盖 DOM 结构和 CSS token；`src/client/panel-b/members-panel-store.test.ts` 覆盖成员数据状态；浏览器 E2E 检查实际 DOM/CSS token。

### G6.3. 隔离 profile provider E2E

```gherkin
Given 使用 `--from-default-profile` 初始化隔离的 wuyou-test profile
When 执行 `dsh plugin --profile wuyou-test add -w @deepseek-ai/dsh-subagent-acp@0.1.5-rc.2`
  And在 patch 模板里追加两行 provider 注册行，command 均为 `/usr/bin/true`，providerName 分别为 e2eacp、e2eacp2
  And重启 wuyou-test
When GET state
Then diagnostics.hostApi 为 2，subagentProvidersSource 为 runtime
  And provider 列表包含 spawn、fork、e2eacp、e2eacp2，后两者能力全为 false
When 把一个 spawn 行改成 provider=e2eacp 并读取 state
Then config 不含 agentOptions、modelSelectionSettings，backgroundMode 为 one-shot，maxDepth 为 provider-managed
When 再次重启 wuyou-test
Then 启动日志不含 cannot enforce maxDepth、does not support child agentOptions、does not support child model selection 或 does not support backgroundMode: continuable
When 把该行改回 spawn 并带完整 agentOptions，再次重启
Then 启动日志仍不含上述错误
  And测试不真正发起 ACP 委派
```

覆盖层：`scripts/e2e-isolated-profile.sh` / `test/e2e/artifacts-release/run.log` 的 `E2E_PROVIDER_SWITCH`；所有安装、重启、请求只使用 wuyou-test。

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

## H. 非目标

- 不编辑 `persona`、`toolFilter`、`maxDepth` 数值、`enableRunInBackground`、`outputSchema`
- 不修改 `@deepseek-ai/dsh-subagent-acp` 注册行的 command、args、env
- 不启用 codex/claude-code，也不改动这两行
- 不改 Panel A 的表格列。v2.12 起操作列内可以有上移、下移（见 K16），不新增列
- 不改 Panel B 的字段、校验和写入逻辑
- 不把 `subagents` 加进 `inject`

## I. 测试执行要求

- 先用真实结构的脱敏 fixture 驱动 Host 纯函数测试，再接入 HTTP 和安装 E2E；fixture 不得使用另一种根结构或不存在的成员定位方式。
- 纯函数测试必须覆盖结构缺失、目录校验、重复、只读、最后成员、revision 保护和字节保留。
- HTTP 测试必须覆盖鉴权、200 state、mutation 成功和错误状态码映射。
- E2E 仅在 `wuyou-test` 执行，完成后核对 G12；禁止为了测试修改 `~/.dsh/profiles/web`。

## J. v2.1 实际交付与计划的差异

v2.1 契约原文是 `tmp/contract-v2.1.md`。与契约不一致或契约没有写明的地方如下，其余内容均按契约交付。

- **Client 只在确实需要时才发送 `agentOptions`**：只有原 provider 不能带 `agentOptions`、目标 provider 能带时（例如 ACP/fork → spawn），patch 才带完整的 `agentOptions.provider` 和 `agentOptions.model`；其他情况只发送改过的键。这样原样重存和切过去又切回来，都会得到「没有改动」、不发请求。契约 §4 的「Client 必须显式传完整 agentOptions」只适用于前一种情况（t49）。
- **ACP → fork 省略 `backgroundMode` 时沿用原值**：Host 不会把 one-shot 强制改成 continuable。表单会在切到 fork 时把默认值设为 continuable 并随请求发出（t48、t49）。
- **`hostApiV2` 初值为 `null`**：state 加载完成、确认 `hostApi !== 2` 之后才显示升级提示，v2 Host 下不会闪一下（t49 F5）。判断条件是 `=== 2`，不是 `>= 2`。
- **新建时的默认 provider**：新建对话框默认选 `subagentProviders[0]`，列表为空时不能提交（t49 F3）。
- **E2E 覆盖范围小于 §8**：
  - Panel B 两行布局只由 SSR 渲染测试覆盖，浏览器 E2E 的 `E2E_BROWSER` 只确认两个面板能打开；
  - 「新 Client + 旧 Host」只有单元测试，没有在真实旧 Host 上跑过。
- **证据位置**：
  - 脚本默认写到 `test/e2e/artifacts-v2.1/`（t43），可以用 `E2E_ARTIFACTS_DIR` 改目录；
  - 最终证据是 t51 重跑的 `test/e2e/artifacts-v2.1-r2/`；
  - v2.1 的目录里没有 `run.log`，步骤摘要只打印在标准输出。

## K. v2.2–v2.13 变更

### K1. 菜单名（v2.2）

settings.section 的 label 改为「无忧Subagent」「无忧Teams」，id 与 order 不变（见 D2）。

### K2. 成员角色多行输入（v2.2）

新建/编辑成员对话框的「角色 (role)」为 `<textarea rows=3>`：初始与最小高度 3 行，`resize: vertical` 可拖高到 6 行，超出后滚动。多行角色经现有 `setPairEdit` 写成 `|-` 块标量，Host 无需改动。成员表的角色单元格 `white-space: pre-line`。

### K3. Members 表第二行（v2.3）

见 D5：第二行 `colSpan={3}`，横跨成员名、角色、操作三列。

### K4. ACP 注册管理（v2.3）

**数据位置**：ACP provider 是根序列中 `- insert:` 下 `name: '@deepseek-ai/dsh-subagent-acp'` 的条目，不在 delegation 组内。config 字段按包 schema：

| 字段 | 类型 | 说明 |
|---|---|---|
| `providerName` | string | subagent 行 `provider` 引用的名字；创建后不可改 |
| `command` | string，必填 | 子 ACP agent 可执行文件 |
| `args` | string[]，默认 `[]` | 空时不写 |
| `cwd` | string，可选 | 省略则继承发起委派的会话 cwd |
| `permission` | `allow` \| `reject`，默认 `reject` | 自动回应子 agent 的权限请求 |
| `env` | 字符串字典，默认 `{}` | 空时不写；明文存储 |

**Host 纯函数**（`src/host/acp-manager.ts`）：`listAcps` 返回 `{ id, disabled, config, usedBy }`，`usedBy` 为 provider 等于该 providerName 的 subagent 工具名。`createAcp` 在最后一个 ACP 根项之后（没有则在根序列末尾）插入一个新的 `- insert:` 根项，id 为 `subagent-acp-<providerName>`（冲突时加 `-2`…），create 后 remove 可逐字节还原。`updateAcp` 只改 patch 中的键；清空的 `args`/`env`/`cwd` 删除该键；块序列 `args` 改写为键行上的 flow 列表。`removeAcp` 在 `usedBy` 非空时返回 `IN_USE`（HTTP 409）。错误码：`INVALID`（名称格式、内置名 spawn/fork、字段类型）、`DUPLICATE`、`NOT_FOUND`、`IN_USE`、`STRUCTURE`。

**HTTP**：
- `GET /state` 增加 `acps: AcpRow[]` 和 `dshProfile: { name, patchPath }`。缺少 `acps` 的旧 Host 由 Client 显示「当前 Host 版本不支持 ACP 管理，重启 DSH 后可用」。
- `POST /acps`，body `{ expectedRevision, action: create|update|remove, input? , id?, patch? }`，patch 不接受 `providerName`。成功 notice：「已保存。ACP 变更需重启 DSH 后生效」。

**Client**：ACP 与 subagent 行在同一个 patch，因此共用 Panel A store 与同一个 revision。ACP 区块位于 subagent 表格下方，列为 ACP 名称、命令（command + args）、权限、使用它的工具、操作；仍被使用的 ACP 删除按钮禁用并说明原因。对话框字段：providerName（编辑时只读）、command、args（每行一个）、cwd、permission、env（每行 `KEY=VALUE`）。

### K5. 导入导出（v2.2 / v2.3）

**端的区分**：每个 DSH profile（web、desktop、cli……）各自运行一个插件实例，只编辑自己的 `cordis.patch.yml`。Host 在 state 中报告 `dshProfile`，面板显示它，导出文件名和文件头带上它。导入总是写入当前面板所属的 profile。

**Panel A 文件**（`wuyou-subagents-<dshProfile>-<YYYYMMDD-HHmmss>.yaml`）：`{ kind: wuyou-subagents, version: 3, dshProfile, acps: AcpConfig[], subagents: [{ toolName, provider, backgroundMode?, agentOptions? }] }`。不导出 maxDepth、modelSelectionSettings 等挂载派生键，导入时 Host 按 provider 能力重新推导。文件头提示 env 可能含密钥、command 是本机路径。也接受 v2.2 只有 `subagents` 的文件。

**Panel A 导入**：Client 解析并预览（ACP 名称或工具名已存在、文件内重复、provider 未注册且文件中无对应 ACP → 跳过并给出原因），确认后一次 `POST /subagents/import { expectedRevision, bundle: { acps, subagents } }`。Host 在同一把锁、同一个 revision 内先建 ACP、再建工具；工具的 provider 可以是本文件新建的 ACP 或 patch 中已有的 ACP（按无能力 provider 处理：one-shot、maxDepth: provider-managed）。已存在或校验失败的条目跳过，不覆盖，结果在 `importReport: { created, skipped }` 中返回。每个列表最多 200 项，请求体上限 1MB。

**Panel B 文件（v2.2–v2.5，v2.6 起改为 K9 的全部团队格式，旧文件仍可导入）**（`wuyou-members-<teamProfile>-<时间>.yaml`）：`{ kind: wuyou-members, version: 3, profile, members }`，只含 name/role/provider/model/reasoning_effort。导入预览跳过已存在、文件内重复、provider 不在模型目录的成员；确认后逐个 `add`，每次带上一次响应的 revision，遇到 409 立即停止并提示已导入数量。

**通用**：导入文件上限 1MB；写入不可用（atomic-write 未加载）时导入按钮禁用，导出仍可用。

### K6. ACP 表格两行与测试（v2.4）

**表格**：每个 ACP 一个 `<tbody>`，两行。第一行是 `<th scope="row">` 名称、权限、使用它的工具，以及操作（测试 / 编辑 / 删除）；第二行 `colSpan={4}`，左缩进 24px，显示 `命令 <code>command args…</code>`。同一 ACP 的两行之间不画线，不同 ACP 之间用 `var(--dsw-alias-border-l1)` 分隔。

**测试**（`src/host/acp-probe.ts`，`POST /acps/test { id, handshake? }`）：只测试已保存的行，请求体不能携带命令。同一个 ACP 同时只能有一个测试，重复请求返回 409 `BUSY`；未知 id 返回 404。测试只读，写入不可用时也能测试。
- 静态检查（不启动进程），规则同 DSH 0.1.7-rc.2（dsh-subprocess-local `resolveExecutable`、dsh-subagent-acp `assertUsableCwd`）：可执行文件、`#!` 解释器（含 `/usr/bin/env name`）、cwd。
- 握手（`handshake: true`，且静态检查没有失败）：以 command、args、env（宿主 env 去掉 KEY/PASSWORD/SECRET/TOKEN 和 `DSH_*`，再叠加 config env）、cwd（未配置时用 home）启动，放在独立进程组；发送 `initialize { protocolVersion: 1, clientCapabilities: {} }`。收到 id=1 的响应即通过；协议版本不是 1 或 stdout 有非协议行时给出注意；进程退出、initialize 返回错误或 20 秒超时判为失败。结束时关闭 stdin，向进程组发 SIGTERM，1 秒后发 SIGKILL。stderr 末尾 2000 字符随结果返回，疑似密钥替换为 `***`。
- 不检查 `session/new` 之后的阶段（登录状态、模型可用性）。

### K9. 全部团队的导入导出、新建与克隆（v2.6）

**Host**（`src/host/teams-editor.ts`）写入规则与 agent-teams 0.1.21 读取 `config.profiles` 时一致。任何一个 profile 不合法都会让**所有会话**的 captain 提示词构建失败，所以这些规则在写入前检查：
- 最多 16 个团队 profile；
- 只允许已知的团队键（description / protocol / executionPrompt / fallback / members / tasks / taskPlanning / reviewPolicy）和成员键（name / role / provider / model / reasoning_effort / executionPrompt / fallback）；
- 成员 1–`maxMembers`（默认 8）个，成员名非空、不是 `captain`、规范化后不重名；provider 需要 model；taskPlanning 只能是 captain / seed。
- 任务 DAG 的细节交给 agent-teams。E2E 会用 agent-teams 自己的 `resolveTeamProfile` 逐个校验写入后的团队。

团队名：`^[a-z0-9][a-z0-9._-]*$`。

- `GET /teams`：`{ revision, profiles: { <名称>: 完整配置 }, dshProfile }`，按文件顺序。
- `POST /teams { expectedRevision, action: 'create', name, from? | firstMember, description? }`：
  - `from`：把源团队的原文（含注释、块标量）复制到 profiles 末尾，只改键名；
  - 否则：写 `description`（可选）和 `members: [{ name: firstMember }]`。
  - 响应 state 的 `profile` 就是新团队。错误码：DUPLICATE、NOT_FOUND（源团队不存在）、INVALID（名称、成员名、超过 16 个）。
- `POST /teams/import { expectedRevision, teams: [{ name, profile, scope? }], overwrite: string[] }`：同一 revision 内逐个处理。
  - 不存在的团队：追加。
  - 存在且在 `overwrite` 中：整体替换该团队（key 行到值末尾），其余字节不变。`scope: 'members'`（旧文件）只替换 `members`。
  - 存在但不在 `overwrite` 中：跳过，原因「团队 'x' 已存在，未选择覆盖」。
  - 校验失败或超过 16 个：跳过并给出原因。
  - 返回 `importReport: { created, overwritten, skipped }`。

**文件**（`wuyou-teams-<dshProfile>-<时间>.yaml`）：`{ kind: wuyou-teams, version: 4, dshProfile, profiles: { <名称>: 配置 } }`。只保留 agent-teams 支持的团队键。

**Client**：
- 导出：调用 `GET /teams`，导出全部团队。
- 导入：先 `GET /teams` 取当前全部团队和 revision 用于预览。每个团队显示新增 / 已存在 / 跳过，已存在的附成员数对比（现有 N → 文件 M）。已存在的团队默认不勾选「覆盖」，并显示覆盖风险和「先导出当前全部团队（备份）」按钮。确认按钮在有覆盖时为 danger 样式，文字写明新增与覆盖数量。确认时发送预览时的 revision。
- 新建团队：对话框里只有一个下拉框，选项为「新建空白团队」和「克隆：<团队>」…，默认克隆当前团队；选空白团队时要求填第一个成员名。创建成功后切到新团队。

不包含删除团队（需要时手动编辑 `cordis.patch.yml`）。

### K10. 删除团队（v2.7）

**Host**：`removeTeamProfile(yamlText, name)` 删除该团队的 key 行到值末尾，其余字节不变；create 后 remove 可逐字节还原。
- 最后一个团队不能删除，返回 `LAST_TEAM`（422）；不存在的团队返回 NOT_FOUND。
- `POST /teams { expectedRevision, action: 'remove', name, confirm: 'thinktwice' }`：`confirm` 必须**完全等于** `thinktwice`，否则返回 400 且不写入。
- 响应 state 的 `profile`：被删的不是当前查看的团队（`?profile=`）时保持不变；否则按 `standard-acp` → 第一个团队的顺序回落。

**Client**：「删除团队」（danger 样式）排在「新建团队」之后，针对当前选中的团队；只剩一个团队或写入不可用时禁用。

对话框标题为「删除团队：<名称>」，警告区写明：
- 删除的内容（描述、协议、任务规划、全部 N 个成员）以及面板里无法撤销；
- 之后 `/agent-teams --profile <名称>` 会失败；
- 协议里写到该名称的地方需要自己改；
- 已创建的团队不受影响（agent-teams 在创建时保存了当时的 profile 配置，见 tools.js `initializeProfileTeam`）；
- 提供「先导出全部团队（备份）」按钮。

输入框的 label 为「请输入 thinktwice 以确认删除」，`autocomplete="off"`。输入内容不做 trim：必须与 `thinktwice` 完全一致，「确认删除」才可点。提交时 store 也会再检查一次。

### K11. 切换团队不抖动（v2.8）

**原因**（`scripts/diagnose-team-switch.sh` 在真实浏览器里逐帧测量得出）：每次加载时会在工具栏和表格之间插入一行「加载中...」，导致：
- 表格下移 29px，加载完再弹回；
- 内容高度越过滚动区域，滚动条反复出现和消失（宽度变化 5px）；
- 团队下拉框被 `disabled`，焦点掉到 body，所有按钮闪一下半透明。

修复前，每次往返切换的 CLS 为 0.0208（接口延迟 300ms 时为 0.0416）。

**规则**：
- 加载时不在表格之外插入任何可见元素。可见的「加载中...」只出现在表格的空行里，也就是原来显示「暂无成员 / 暂无 subagent 工具」的那一行（首次加载时）。
- 已有数据时，保留旧行，表格加 `aria-busy="true"`；超过 150ms 才变淡到 0.6，恢复时立即恢复。
- 读屏由常驻的 `role="status" aria-live="polite"` 区域播报。它是绝对定位、1px 大小，不占布局。
- 按钮禁用时同样延迟 150ms 再变淡，所以快速加载不会闪。
- 团队下拉框只在写入期间禁用：store 新增 `writing` 标志，由写操作设置，409 后的刷新期间保持；`loading: false` 时一并清除。普通切换不禁用，所以焦点保留，连续切换时以最后一次选择为准（过期的读取会被丢弃）。行内编辑、删除等写操作按钮在加载期间仍然禁用，避免对旧团队的成员做操作。
- 无忧Subagent 的刷新同样适用。

修复后同一测量：工具栏和表格的位置、滚动条、焦点、下拉框状态在切换过程中都不变，CLS 0.0006。剩余的变化只是新团队的文字长度不同，引起列宽微调（v2.9 用固定列宽和预留滚动条消除，见 K12）。

### K12. 固定列宽与预留滚动条（v2.9）

**原因**（真实数据，1440×840，`default-team` ↔ `default-team21`）：
- 滚动区域是宿主设置页的 `.options`（`overflow-y: auto`，没有 `scrollbar-gutter`）；DSH 主题滚动条宽 5px（`--dsh-scrollbar-width`）。
- 成员表是自动列宽：成员名长度不同，列宽就不同，角色列的折行和表格高度随之变化。
- 一个团队的内容放得下，另一个超出，切换时滚动条出现又消失。出现时内容宽度 564→559px，列宽跟着重新分配（表头 [140,265,128] ↔ [156,243,128]），整个面板被挤向左侧。

**规则**：
- 两个面板的根容器（`data-panel="subagents" | "members"`）使用 `panelRootStyle`：`height: 100%; box-sizing: border-box; overflow-y: auto; scrollbar-gutter: stable`。面板自己滚动，并且始终预留滚动条宽度，有没有滚动条宽度都不变；宿主的 `.options` 不再溢出。
- 成员表固定列宽，规则见 D5：成员名 30%、角色自适应、操作 136px，长成员名以省略号截断并用 `title` 显示全名。
- 表格最小宽度 420px：窄屏（390px）下列宽不会被压到 0，改为横向滚动。

修复后同一测量（1440×840 与 1440×900）：面板宽 564、工具栏 527、表头 [158,233,136] 在切换中都不变，`.options` 从不溢出，面板滚动条槽位 5px 始终保留，CLS 0。390×844 下表头 [126,158,136]、表格 420px。

### K13. Background Mode 说明（v2.10）

**位置**：原生 `<option>` 里放不了图标，所以「?」按钮放在「Background Mode」标签右侧同一行，位于 `<label>` 之外（`FormField` 新增 `labelAddon`）。新建和编辑 Subagent 工具的对话框都有；ACP 这类只读 `one-shot` 的行也有。下拉框本身不变：仍是 `continuable` / `one-shot` 两个值，默认值和写入规则不变。

**内容**：依据 `@deepseek-ai/dsh-tool-subagent` 0.1.7-rc.2（`resolveDelegationRun`、`startContinuable`、`jobs.start`），以及各 provider 是否实现 `prepareContinuable`：
- `one-shot`：默认在前台等子代理完成，结果直接交回主代理，完成后不能再给它发消息。主代理传 `run_in_background: true` 时改为后台任务，用 `job_output` 取结果、`job_kill` 停止。
- `continuable`：默认在后台运行，立即返回子代理 id，完成时通知主代理。之后可以用 `send_message` 在同一会话里追问、用 `interrupt_agent` 打断（这两个工具来自 `dsh-tool-subagent-control`，需要同一预设加载）。传 `run_in_background: false` 时改为前台等待，这次调用不能再追问。需要 provider 支持：spawn、fork 支持，ACP（`dsh-subagent-acp`）不支持。
- 下拉框当前选中的值带「当前」标记，并随下拉框变化。当前 provider 不支持 continuable 时，标记固定在 one-shot，并提示「当前 Provider 不支持 continuable，只能使用 one-shot」。
- 行上设置了 `enableRunInBackground: false` 时，两种模式都只在前台运行。面板不编辑这个键，说明里也不写。

**交互**（`ui/HelpTip.tsx`，toggletip 模式）：
- 按钮 `aria-label="Background Mode 说明"`，带 `aria-expanded` 和 `aria-controls`。说明放在始终存在的 `role="status"` 区域里，打开时读屏会朗读；焦点留在按钮上。
- 气泡 `position: fixed`，不会被对话框的 `overflow: auto` 裁掉，对话框尺寸和滚动位置也不变。左边缘与按钮对齐，默认在按钮下方 6px；下方放不下时翻到上方；水平方向离视口边缘至少 8px；两侧都放不下时取空间大的一侧，限制高度，内容可滚动。
- 关闭方式：再点一次「?」、Escape、在气泡外按下指针、焦点离开、对话框滚动。Escape 只关闭气泡，焦点回到「?」，对话框保持打开。实现上在 window 捕获阶段处理 Escape 并 `preventDefault`，对话框（`Modal.tsx`）和宿主设置对话框都会跳过已处理的事件。输入法组合中的按键不处理（同 `composition-guard.ts`）。
- 点击区域 24×24，可见的圆圈 16px，不增加标签行的高度。颜色只用主题 token。主题没有阴影 token，阴影用 `--dsw-alias-bg-mask-2`。

### K14. 模型能力（v2.11）

新增「模型能力」settings.section，order 为 99，位于无忧Subagent 和无忧Teams 之前；通过依赖 `slots`、`configForms`、`remote`、`remote.settings`、`remote.credentials` 的子 fiber 注册，服务不齐时不影响既有两个 section。Panel C 使用框架无关 store 和 `useSyncExternalStore`，支持 Pi/DeepSeek namespace 的模型能力读取与编辑（已设置/未设置）、容量和思考档位校验、批量编辑、凭证引用、预览、冲突处理及保存。配置读写只使用设置与凭证服务，不新增写配置的 Host 路由（K17 的只读测试路由除外），也不把明文密钥放进 snapshot。完整映射、路径和函数契约见 `docs/specs/model-capabilities.md`，R2 增量见 `docs/specs/model-capabilities.r2.md`。R2：移除提供方默认值与继承；模型容量/输入只有已设置/未设置。

「团队 profile」下拉框从标题栏移到「新建成员」同一行，行容器 `display:flex; justify-content:space-between`：「新建成员」在左，`<label for="wuyou-team-profile">团队 profile</label>` + `<select id="wuyou-team-profile">` 在右，位于刷新、关闭按钮下方且右边缘与它们对齐。只要 `teamProfiles` 非空就显示下拉框（只有一个 profile 时也是），选项为 `teamProfiles` 全部，默认规则不变（请求值 → `standard-acp` → 第一个）。写入进行中（含 409 后的刷新）禁用，普通加载与切换时保持可用（v2.8，见 K11）；写入不可用时仍可切换（只读查看）；没有团队 profile 时不显示。

语义：选择只决定面板查看和编辑哪个团队 profile 的成员，不写配置。agent-teams 的配置 schema（`profiles` 字典）没有「当前生效 profile」字段，团队在 `agent_teams_create({ profile })` 或 `/agent-teams --profile <name>` 时选用 profile，因此插件无法、也不去设置一个全局默认。新增或删除团队 profile 不在本版范围。

### K15. 模型能力导入导出（v2.12）

模型能力 Panel C 支持 `wuyou-model-capabilities` v1 YAML 的已保存配置导出与草稿导入。导出只读取已保存基线，过滤密钥、请求头和敏感字段；导入先解析并预览，确认后只写入草稿，不调用 Host `mutate` 或凭证写入。导入受 1MB 上限、未保存修改和配置冲突保护；保存、放弃或重新加载会清理预览。具体 schema、校验、冲突合并和文案见 `docs/specs/r3-io-and-move.md` 第 1 节。

### K16. Subagent 排序（v2.12）

Panel A 操作列新增上移、下移两个 24×24 原生按钮；按钮一次点击调用现有 subagents 写入路由的 `move` action，支持 `direction: 'up'|'down'`，首项上移和末项下移禁用。Host 在锁内局部交换 delegation 序列并保留原文，成功提示说明只改变列表顺序、不影响模型看到的工具顺序。`hostApi` 不是 2 或写入被阻止时按钮禁用；Host 同为 hostApi 2 但尚未重启时，Host 返回 400，界面提示「上移和下移需要重启 DSH 后生效」。具体请求校验、字节保留和交互规则见 `docs/specs/r3-io-and-move.md` 第 2 节。

### K17. 模型可用性测试（v2.13）

模型能力 Panel C 支持对已保存的模型做可用性测试。Host 新增 1 条只读路由 `POST /plugins/dsh-wuyou-agent/api/models/test`（第 10 条），请求体只有 `provider`、`model`；每次测试只测一个模型、只发一次真实请求：短提示「只回复 OK」、`maxTokens 32`、最低推理档、`temperature 0`、不带 `sessionId`，总时限 20s（与 K18 的流空闲超时无关）。测试会验证 API Key 并产生少量费用。Host 全局最多 3 个并发，超出或同一 `provider+model` 已在测试时直接返回 409 `BUSY`，不排队；Client 队列并发 3、逐条返回，「停止」取消排队项；批量测试（多于 1 个模型且凭证已配置）先弹费用确认，可勾选「本次会话不再提示」。提供方是新建的、有未保存改动或 API Key 未保存时禁止测试，提示先保存（不把草稿 baseURL/Key 发给 Host）。结果只保存在 store 内存，不写配置、不落盘，保存成功、重新加载或远端刷新后清空。只更新 Client 而 Host 未重启时，路由返回 404，界面提示「当前 Host 不支持模型测试，重启 DSH 后可用。」，配置的查看、编辑和保存不受影响。完整路由、错误分类、store 与 UI 契约见 `docs/specs/r4a-model-test.md`。

### K18. 流空闲超时（v2.13）

模型能力 Panel C 支持编辑流空闲超时 `streamIdleTimeoutMs`：pi 写入 `llm-pi-ai` 条目的 `providers.<route>.streamIdleTimeoutMs`，DeepSeek 写入 `llm-deepseek` 条目顶层的同名字段，经现有 `remote.settings.mutate` 写进 profile `cordis.patch.yml`，热生效，值为整数毫秒的 JS number。界面只收分钟（可带小数），换算后范围为 1000–2147483647 ms；清空或恢复默认即 unset，回落 DSH 默认 5 分钟（300000）。「默认 30 分钟」只用于向导新建和导入的新提供方，已有提供方没有显式值时不会被静默改写，只显示「未设置 · 使用 DSH 默认 5 分钟」并建议 30 分钟。读取只看 user 层，不把 value 层的 schema 默认当显式值；导出只写显式值。导入时该值不合法（字符串、小于 1000、超过上限等），整个提供方标为 invalid，不进入载荷。完整草稿模型、校验、ops、io 与 UI 契约见 `docs/specs/r4b-stream-idle-timeout.md`。

### K7. 验收映射

| 需求 | 自动化证据 |
|---|---|
| K1 菜单名 | `panels.test.tsx`「registers both sections … v2.2 short labels」；E2E 浏览器按新名称打开两个面板 |
| K2 角色多行 | `panels.test.tsx`「role field is a 3-line textarea…」「multi-line roles keep their line breaks」；E2E 检查 textarea rows=3 |
| K3 colSpan | `panels.test.tsx`「v2.1 §7: one tbody per member…」断言 `colSpan="3"` |
| K4 ACP | `acp-manager.test.ts`（真实 fixture，逐字节）、`http-routes.test.ts`「v2.3 ACP routes」、`subagent-panel-acp.test.ts`、`panels.test.tsx`「v2.3 Panel A ACP section」；E2E `E2E_V23_ACP`、`E2E_V23_RESTART`（重启后 DSH 运行时注册了插件写入的 ACP） |
| K5 导入导出 | `import-export.test.ts`、`subagent-panel-acp.test.ts`、`panels.test.tsx`（成员导入的 revision 链与冲突停止）；E2E `E2E_V23_IMPORT` |

| K6 两行与测试 | `acp-probe.test.ts`（真实子进程：通过、退出、拒绝、超时、噪声、版本不符、进程已结束、env 清理）、`http-routes.test.ts`「v2.4 POST /acps/test」、`panels.test.tsx`「v2.4: two rows per ACP」「test dialog」、`subagent-panel-acp.test.ts`「v2.4 ACP test」；E2E `E2E_V24_ACP_TEST`、浏览器 `acp_test_dialog=1` |

| K8 团队 profile 下拉框 | `panels.test.tsx`「v2.5 Panel B team profile picker」（单个 profile 也是下拉框、位于新建成员右侧且不在标题栏、多 profile 切换、写入不可用时可切换）、`t31-fixes.test.tsx`（409 刷新期间禁用）；E2E `E2E_BROWSER_V25`（真实浏览器按坐标断言：与新建成员同行、在其右侧、在刷新下方、右边缘与关闭按钮对齐） |

| K9 全部团队 | `teams-editor.test.ts`（真实 fixture：克隆逐字节复制、空白新建、16 个上限、覆盖只动目标团队、旧文件只替换成员、无效团队跳过）、`http-routes.test.ts`「v2.6 team routes」、`import-export.test.ts`「Panel B teams file」、`members-panel-teams.test.ts`、`panels.test.tsx`「v2.6 Panel B teams」；E2E `E2E_V26_TEAMS`（含 agent-teams `resolveTeamProfile` 校验）、`E2E_BROWSER_V26` |

| K10 删除团队 | `teams-editor.test.ts`「removeTeamProfile」（逐字节还原、只删目标块、最后一个团队 LAST_TEAM）、`http-routes.test.ts`「v2.7 POST /teams remove」（confirm 必须完全等于 thinktwice、删除后回落、422/404/409 不写入）、`members-panel-teams.test.ts`「delete team dialog」、`panels.test.tsx`「v2.7 Panel B delete team」；E2E `E2E_V27_TEAM_REMOVE`（错误确认词 400，删除后 agent-teams `resolveTeamProfile` 校验剩余团队）、`E2E_BROWSER_V27`（单团队时禁用、界面克隆后删除、输入 thinktwice 前确认按钮不可点） |

| K11 切换不抖动 | `panels.test.tsx`「v2.8 no layout shift while loading」：切换中表格之上的 HTML 与空闲时逐字节相同、旧行保留且 `aria-busy`、下拉框可用、首次加载的「加载中」在表格空行、写入时锁定下拉框、Subagent 刷新同样不插入、按钮延迟变淡；`members-panel-teams.test.ts`「writing flag」；E2E `E2E_BROWSER_V28`：真实浏览器切换 4 次，逐帧记录，工具栏与表格位置不变、下拉框从未禁用、焦点保留、CLS≤0.002（开始记录前先关闭克隆产生的成功提示：它在工具栏上方占 54px，第一次切换会清除它，不关闭时第一帧能否看到它取决于约 8ms 的时序） |

| K12 固定列宽与预留滚动条 | `panels.test.tsx`「v2.9 fixed columns and a reserved scrollbar gutter (real fixture)」（两个面板根容器的 `scrollbar-gutter: stable`、colgroup 30%/自适应/136px、`table-layout: fixed` 与 420px 下限、长成员名省略号与 title）；E2E `E2E_BROWSER_V29`：把克隆团队扩到 8 个成员（含一个超长成员名）使其超出面板高度，与 3 个成员的 standard-acp 来回切换 6 次，逐帧记录：面板有滚动和无滚动两种状态都出现，面板内宽、工具栏、表格、表头宽度始终不变，面板与对话框之间的滚动容器从不溢出，CLS≤0.002，长成员名被截断且 title 为全名。浏览器以真实滚动条运行（去掉 headless 默认的 `--hide-scrollbars`） |

| K13 Background Mode 说明 | `help-tip.test.tsx`（`placeHelpBubble`：下方、翻到上方、两侧都不够时限高、1440 与 390 视口的水平夹取；关闭时的标记：`aria-expanded="false"`、`aria-controls` 指向空的 `role="status"`、24×24 点击区域）、`background-mode-help.test.tsx`（两种模式的说明、「当前」标记、不支持 continuable 的提示）、`panels.test.tsx`「v2.10 Background Mode help button」（「?」紧跟标签且在 `<label>` 之外、下拉框选项与选中值不变、只有这一个字段有、新建对话框与只读 ACP 行也有）；E2E `E2E_BROWSER_V210`：真实浏览器里对 fork 行和 ACP 行点「?」，气泡与按钮相距 6px、完整在视口内、各点 `elementFromPoint` 都落在气泡上、对话框 scrollHeight/scrollTop 不变；Escape 只关气泡且焦点回到按钮、点气泡外关闭且对话框不关、改下拉框后「当前」跟着变、ACP 行显示不支持提示、不保存直接关闭；`E2E_BROWSER_V210_MOBILE`：390×844 下气泡宽 340、在视口内 |
| K14 模型能力 | `capacity.test.ts`、`validate.test.ts`、`efforts.test.ts`、`ops.test.ts`、`bulk.test.ts`、`place-menu.test.ts`、`store.test.ts` 共 110 个模型能力纯逻辑测试；`panel.test.tsx` 与 `panels.test.tsx` 的三 section、子 fiber 依赖、根 `inject` 和颜色扫描断言；`npx tsc -p tsconfig.client.json --noEmit`；完整 `npx vitest run` |
| K15 模型能力导入导出 | `src/client/model-capabilities/io.test.ts`、`src/client/model-capabilities/store.test.ts`、`src/client/model-capabilities/panel.test.tsx`；`npx tsc -p tsconfig.client.json --noEmit` |
| K16 Subagent 排序 | `subagent-manager.test.ts`、`http-routes.test.ts`、`subagent-panel-store.test.ts`、`panels.test.tsx`、`test/integration` routes/contract；`index.test` 现为 10 条（K17 新增 1 条） |
| K17 模型测试 | model-probe.test.ts、http-routes.test.ts「r4a POST /models/test」、index.test.ts（10 条、鉴权）、api-client.test.ts、model-test.test.ts、store.test.ts「r4a model test」、panel.test.tsx「r4a」；npm run verify 输出 10 条 |
| K18 流空闲超时 | timeout.test.ts、ops.test.ts「O1–O5」、validate.test.ts「V1–V2」、io.test.ts「I1–I6」、store.test.ts「S1–S7」、panel.test.tsx「R4b P1–P4」、regression-r2.test.ts「R4b-1/2」 |

E2E 证据目录：`test/e2e/artifacts-v2.10/`（`E2E_ARTIFACTS_DIR=test/e2e/artifacts-v2.10 bash scripts/e2e-isolated-profile.sh`），截图 `browser-background-mode-help.png`、`browser-members.png`、`browser-members-scroll.png`、`browser-delete-team.png`。脚本默认使用 0.1.7-rc.2 的 DSH，版本不符时直接失败（可用 `DSH_BIN` / `DSH_EXPECTED_VERSION` 覆盖）。

**文档结束**
