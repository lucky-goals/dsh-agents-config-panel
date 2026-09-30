# R3 增量契约：模型能力导入导出 + Subagent 上移下移

## 0. 约束与已定决策
- 本机单用户配置。导入文件上限 1MB，subagent 约十几行。不新增依赖，不新增 HTTP 路由（仍为 9 条）。
- 功能 1：`kind: wuyou-model-capabilities`、`version: 1`。导入只改草稿，不调用 `mutate`。
- 功能 2：沿用 `POST /subagents`，新增 `action: 'move'`，参数 `{id, direction:'up'|'down'}`，每次点击直接写入。
- 导出来源：store 闭包里的 `base`（最近一次 load、保存或 reload 之后的基线）。不导出 `draft`，因为草稿里可能有未通过 `allErrors` 的模型 ID。有未保存修改或冲突时，仍导出 `base`，并提示「只导出已保存的配置」。
- 操作列用两个 24×24 的 `↑` `↓` 按钮，不做「···」菜单。原因：Panel A 的 `Button` 不转发 `aria-label`，内边距是 `5px 12px`，放文字按钮会把操作列撑得太宽；菜单又多一次点击，和「点一下就写入」不协调。
- 成功提示写明「不影响模型看到的工具顺序」（DSH 的 `SystemPrompt.assemble` 会按名字或 `toolOrder` 重新排序），不再附「新建会话后生效」。

## 1. 功能 1：模型能力导入导出
新建 `src/client/model-capabilities/io.ts`。复用 `src/client/shared/import-export.ts` 中的 `stringify`/`parse` 风格、`exportTimestamp`、`downloadYaml`、`readImportFile`、`MAX_IMPORT_BYTES`。不修改该文件，也不修改 `ImportPreviewModal`。

### 1.1 文件名与头注释
文件名：`wuyou-models-<YYYYMMDD-HHmmss>.yaml`，时间用 `exportTimestamp` 的本地时间，不带 profile。
头注释放在 `stringify(..., { lineWidth: 0 })` 生成的内容之前，原文如下（`date` 默认 `new Date()`，时间格式为 `date.toISOString()`）：
```yaml
# 无忧模型能力配置导出
# 导出时间: 2026-09-30T08:00:00.000Z
# 不含密钥，不含请求头。
# baseURL 和 apiKeyEnv 属于接入信息，分享前请检查。
```

### 1.2 导出 schema
- 根对象依次为 `kind`、`version`、`providers`。当 `base.providers` 中存在 `ns === 'llm-deepseek'` 的提供方时，追加第四个键 `deepseek`；否则根上不出现 `deepseek`。任何路径里都不能出现 `deepseek-official`。
```yaml
kind: wuyou-model-capabilities
version: 1
providers:          # 只含 llm-pi-ai，按 base.providers 键顺序
  <id>:
    api: <string>
    displayName: <string>          # 有才写
    baseURL: <string>              # 有才写
    apiKeyEnv: <string>            # 有才写；环境变量名，不是密钥
    <extra 键>: <原值>
    models:
      - id: <string>
        name: <string>             # 有才写
        contextWindow: <number>
        maxTokens: <number>
        input: [<text|image>, ...]
        inputModalities: [...]     # pi 旧字段，原样写，不迁移
        reasoningEfforts: false | { <档位>: <string|null> }
        <模型 extra 键>: <原值>
deepseek:                          # 仅本机存在 DeepSeek
  thinking: enabled | disabled     # 有才写
  reasoningEffort: <string>        # 有才写
  <extra 键>: <原值>
  models: [...]                    # 按 DS 的 modelOut：写 inputModalities 与容量，不写 input 和 reasoningEfforts
```
- 没有自定义提供方时写 `providers: {}`。DeepSeek 存在时总是写 `deepseek:`，`models` 至少为 `[]`。
- 容量：键存在且 `parseCap` 返回 number 时写该数字（例如 `128K` 写成 `128000`）；空白或 `parseCap` 返回 null 时省略这一侧。
- `reasoningEfforts` 写 `orderedEfforts` 之后的结果，`false` 原样写 `false`。
- 不写 `_stash`。DeepSeek 节不写 `apiKeyEnv`，pi 提供方要写。
- 以下键既不导出，也不进入 `extra`：
  - 提供方和模型上的 `headers`，名和值都不写；
  - `secrets`、明文密钥、`secretSet`、`credConfigured`、`credWritable`；
  - 6 个默认键：pi 的 `defaultInput`、`reasoning`、`defaultContextWindow`、`defaultMaxTokens`，DS 的 `defaultContextWindow`、`maxTokens`；
  - 模型上的 `_stash`；
  - 键名 trim 并转小写后等于 `headers`、`apikey`、`secret`、`token`、`authorization`、`password` 的项。
- 其余 `extra` 保持原插入顺序：提供方的写在已知字段之后、`models` 之前；模型的写在模型已知字段之后。

### 1.3 导出来源与按钮状态
`exportConfig()` 读闭包里的 `base`，调用 `exportModelConfig(base, { date })` 和 `modelExportFilename(date)` 后执行 `downloadYaml`。不读 `draft`、不读 `secrets`，也不调用 `mutate`。

| 状态 | 导出 | 导入 |
|---|---|---|
| 只读 | 可点 | 禁用，title `只读模式，不能导入` |
| `ui.loading` 或 `loadError` | 禁用 | 禁用 |
| `ui.saving` | 禁用 | 禁用 |
| `ops.dirty > 0` 或 `ui.conflict !== 'hidden'` | 可点 | 禁用，title `有未保存的修改或配置冲突，请先保存、放弃或重新加载后再导入` |
| 正常 | 可点 | 可点 |

导出后的 `ui.status`（两种情况都会下载）：
- 干净：`已导出。文件不含密钥和请求头；baseURL 和 apiKeyEnv 属于接入信息，分享前请检查`
- dirty 或冲突：`只导出已保存的配置。文件不含密钥和请求头；baseURL 和 apiKeyEnv 属于接入信息，分享前请检查`

### 1.4 解析与错误文案
- `readImportFile` 原有文案保持不变：`文件超过 1MB 上限`、`YAML 解析失败：…`。store 捕获后写入 `saveError`，格式为 `无法导入 ${file.name}：${message}`。
- `parseModelConfig` 在以下情况抛错，文案如下：

| 条件 | 文案 |
|---|---|
| 根不是映射 | `文件内容不是 YAML 映射，无法识别为导出文件` |
| `kind !== 'wuyou-model-capabilities'` | `不是模型能力导出文件` |
| `version !== 1`（必须是数字 1，字符串 `"1"` 不接受） | `不支持的文件版本：${String(version)}` |
| 有 `providers` 但不是映射 | `providers 必须是映射` |
| 有 `deepseek` 但不是映射 | `deepseek 必须是映射` |

- 根上的未知键忽略。单个提供方的问题不在这里抛错，放到预览项里处理。

### 1.5 `ImportItem`
```ts
export type ImportItemKind = 'new' | 'conflict' | 'invalid' | 'skip';
export interface ImportItem {
  kind: ImportItemKind;
  id: string;               // pi 用提供方 ID；DeepSeek 节固定 'deepseek'
  label: string;            // pi 用 displayName，没有就用 ID；DeepSeek 用 'DeepSeek 官方'
  reason: string;
  checked: boolean;         // 预览初值
  checkable: boolean;       // false 时不渲染勾选框
  provider?: ProviderDraft; // new/conflict 的 pi 项
  deepseek?: { thinking?: 'enabled'|'disabled'; reasoningEffort?: string; models: ModelDraft[]; extra: Record<string, unknown> };
}
```
按文件中的顺序逐项判定。同一 ID 第二次出现记为 invalid，原因 `文件中重复`。每一项只报第一个模型错误，有错误的整个提供方都不进入载荷。

| kind | 条件 | reason 原文 | 默认勾选 | 可勾选 |
|---|---|---|---|---|
| invalid | ID 不匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$` | `提供方 ID '${id}' 不合法` | 否 | 否 |
| invalid | ID 为 `deepseek` 或 `deepseek-official` | `提供方 ID '${id}' 保留给 DeepSeek，不能作为自定义提供方` | 否 | 否 |
| invalid | ID 与 `Object.prototype` 上的名字相同（`id in Object.prototype`），或 ID 为 `prototype`（R3F-N1） | `提供方 ID '${id}' 是保留名，不能作为自定义提供方` | 否 | 否 |
| invalid | 值不是映射 | `提供方 '${id}' 不是映射` | 否 | 否 |
| invalid | 文件内第二个同名 ID | `文件中重复` | 否 | 否 |
| invalid | 缺少非空字符串 `api` | `提供方 '${id}' 缺少 api` | 否 | 否 |
| invalid | 模型 ID 为空白 | `提供方 '${id}' 的模型 ID 不合法：模型 ID 不能为空` | 否 | 否 |
| invalid | 模型 ID 含空白 | `提供方 '${id}' 的模型 ID 不合法：模型 ID '${raw}' 不能包含空格` | 否 | 否 |
| invalid | 同一提供方内模型 ID 重复 | `提供方 '${id}' 的模型 ID 不合法：模型 ID '${mid}' 重复` | 否 | 否 |
| invalid | 容量键存在且 `parseCap === null` | `提供方 '${id}' 的模型 '${mid}' 容量格式不正确` | 否 | 否 |
| invalid | `reasoningEfforts` 既不是 false，也不是普通对象 | `提供方 '${id}' 的模型 '${mid}' 的 reasoningEfforts 不合法` | 否 | 否 |
| new | 草稿中没有该 pi ID | `将新增提供方 '${id}'` | 是 | 是 |
| conflict | 草稿中已有该 pi ID | `提供方 '${id}' 已存在` | 否 | 是 |
| skip | 文件有 `deepseek`，但 `ctx.hasDs !== true` 或草稿里没有 `DS_ROUTE_ID` | `本机没有 DeepSeek，已跳过` | 否 | 否 |
| invalid | DeepSeek 的模型违反上面任一模型规则（id 为 `deepseek`） | `DeepSeek 的模型 ID 不合法：…` / `DeepSeek 的模型 '${mid}' 容量格式不正确` | 否 | 否 |
| conflict | 本机有 DeepSeek，且模型全部合法 | `DeepSeek 已存在` | 否 | 是 |

写入载荷前先做规范化：
- 丢掉 1.2 节列出的省略键。
- pi 模型缺少 `reasoningEfforts` 时补为 `false`。
- `inputModalities` 抄到 `ModelDraft.inputModalities`，不抄进 `input`，也不删除。
- 新提供方：`ns: 'llm-pi-ai'`，`headers` 为 undefined，`credConfigured: false`，`credWritable: true`，`extra` 只保留未知键。
- DeepSeek 模型只保留 `id`、`name`、`contextWindow`、`maxTokens`、`inputModalities` 和合法的 extra；`input`、`reasoningEfforts`、`apiKeyEnv`、`headers` 一律丢掉。

### 1.6 确认后的合并
`applyModelImport` 返回新的 `DraftState`，不修改入参，不调用 `mutate`，不碰 `secrets`。只处理 `selection` 中且 kind 为 new 或 conflict 的项。
- 新 pi 提供方：追加到 `providers` 末尾（`providerOrder` 会让 DeepSeek 始终排在最后）。
- 已存在的 pi 提供方（勾选后）：
  - `models` 整表替换；
  - `api` 替换；
  - `displayName` 以文件为准：文件有就写，文件没有就删掉该键；
  - `extra` 整体换成文件中的 extra，可以是空对象；
  - 保留本地的 `baseURL`、`apiKeyEnv`、`headers`、`id`、`ns`、`credConfigured`、`credWritable`。
- DeepSeek（勾选后）：
  - `models` 整表替换；
  - 文件里有 `thinking` 才替换，有 `reasoningEffort` 才替换；
  - `extra` 按键合并：文件中的键覆盖本地同名键，本地独有的键保留；
  - 不修改 `apiKeyEnv`、`id`、`ns`、凭证标志。
- 确认后关闭对话框，`ui.status` 设为：`已导入到草稿，尚未保存。请预览变更后保存。`。之后仍走现有的 `save()` → `computeOps` → `remote.settings.mutate`。导入的内容不带 headers，所以保存时不会写回文件里的请求头。

### 1.7 函数签名
```ts
export function modelExportFilename(date?: Date): string;
export function exportModelConfig(base: DraftState, opts?: { date?: Date }): string;
export interface ParsedModelFile { providers: Record<string, unknown>; deepseek?: Record<string, unknown> }
export function parseModelConfig(text: string): ParsedModelFile;
export interface ModelImportPreview { items: ImportItem[]; warning: string }
export interface ImportContext { hasDs: boolean }
export function previewModelImport(file: ParsedModelFile, draft: DraftState, ctx: ImportContext): ModelImportPreview;
export function applyModelImport(draft: DraftState, items: readonly ImportItem[], selection: ReadonlySet<string>): DraftState;
```
- `selection` 取确认时仍处于勾选状态的 `id`。`ImportItem.checked` 只是初值。

### 1.8 store 与 `McUi`
- `McUi` 新增字段 `importPreview: { fileName: string; items: ImportItem[]; selected: string[]; warning: string } | null`，`initialUi` 中为 null。它不放进 `ui.dialog`。面板把 `importPreview !== null` 视为有对话框打开，此时主区、层、保存条、顶栏全部 inert。
- store 新增方法：
```ts
exportConfig(): void;
importConfig(file: { name: string; size: number; text: () => Promise<string> }): Promise<void>;
setImportChecked(id: string, on: boolean): void;
confirmImport(): void;
cancelImport(): void;
```
- `importConfig`：只读、保存中、加载中、`ops.dirty > 0`、`conflict !== 'hidden'` 时直接返回，不读文件。否则调用 `readImportFile`；失败时写 `saveError`；成功时只设置 `ui.importPreview`，`selected` 为 `checked === true` 的 id，不改 `draft`。
- `setImportChecked`：只改 `selected`，对 invalid 和 skip 的 id 不做任何处理。
- `confirmImport`：调用 `applyModelImport`，将 `importPreview` 置为 null，并设置 1.6 节的 status。
- `cancelImport`：只把 `importPreview` 置为 null。
- `load`、`discard`、`reload`、保存成功时都清空 `importPreview`。

### 1.9 UI 文案
- `ListHead` 从左到右依次为「导出」「导入」「添加提供方」。「导入」用现有的 `ImportFileButton`，aria-label 仍是「导入配置文件」。加载中时这两个按钮都禁用。详情、向导、预览变更视图里不显示这两个按钮。
- `components/ImportPreviewDialog.tsx` 基于 `ui/Modal`：
  - 标题：`导入模型配置`
  - 摘要：`文件：${fileName}`
  - 警告：`文件不应包含密钥或请求头。这些字段会被丢弃，不会进入草稿。baseURL 和 apiKeyEnv 会随新提供方写入草稿，分享来的文件请先看过。`
  - 说明：`已存在的提供方默认不覆盖。勾选「覆盖」后，自定义提供方只替换模型、显示名和 API，保留本机的 baseURL、密钥环境变量名和请求头。DeepSeek 只合并思考设置和模型表。`
  - 计数：`将新增 ${nNew} 项，覆盖 ${nConflict} 项，跳过 ${nSkip} 项。`。其中「覆盖」指已勾选的 conflict；「跳过」包括 invalid、skip，以及未勾选的 new 和 conflict。
  - 每一行显示 `label`，徽章为 `新增`、`覆盖`、`无效`、`跳过` 之一，下一行是 `reason`。new 项的勾选框文字为 `导入`，conflict 项为 `覆盖`。
  - 按钮：`取消`；`确认导入（${selected.length}）`。有已勾选的 conflict 时用 danger 样式，否则用 primary。`selected.length === 0` 时禁用。确认是同步操作，不显示「导入中…」。

### 1.10 安全
- 导出函数的参数类型是 `DraftState`，从签名上就拿不到 `secrets`。测试要额外准备一条密钥和一条 `Authorization` 请求头，断言导出文本中两者都不出现。
- 导入时先丢掉 1.2 节的敏感键，再写入 `extra`；`previewText` 中也不能出现这些值。
- `apiKeyEnv` 只作为 pi 提供方的环境变量名出现。DeepSeek 的 `apiKeyEnv` 不导出、不导入。
- 导入不调用 `credentials.set`。

## 2. 功能 2：Subagent 上移下移
不新增路由，`src/index.test.ts` 里的 `toHaveBeenCalledTimes(9)` 不变。不改 `patch-io.ts`，只复用已有的 `parseYaml`、`findSubagentSequence`、`lineStart`、`nodeRange`。ACP 表不动。Host 改动必须重启 DSH 才生效；如果只更新了 client，旧 Host 会在加锁前返回 400，文案为 `字段 action 必须是 create、update、remove 之一`。

### 2.1 `moveSubagent`
```ts
export function moveSubagent(yamlText: string, id: string, direction: 'up' | 'down'): MutationResult
```
- 不需要传 providers，也不会返回 `READ_ONLY`。`disabled: true` 的行（如 codex、claude-code）同样可以移动，行内容逐字节保持不变。
- 参与排序的范围与 `listSubagents` 相同：`delegation.config` 中 `name === '@deepseek-ai/dsh-tool-subagent'` 的项，按文件顺序。只交换这个过滤后序列里相邻的两项。两项之间的所有内容（空行、注释、非 subagent 行）留在原位。
- 每一项的字节跨度：`start = lineStart(yamlText, node.range[0])`。`end` 取本行 key 块的末尾，并继续吸收**紧跟其后、缩进比该行 key 列更深**的注释行（中间允许有空行）；遇到缩进更浅的注释、下一个 `- id` 或其他内容就停止。如果下一项的 `lineStart` 比 `end` 更早，就把 `end` 收到下一项的 `lineStart`。
- **R3F 修正（审查实测后定稿，以此为准）**：
  - 第一步：在 `range[1]` 以内找最后一个「非空、非注释」的内容行，把 key 块末尾定在这一行的行尾（含换行）。块内的注释不管缩进多少，都算本行。这样可以避免注释后面属于本行的 key（例如 `disabled: true`）被留在空隙里，交换后错挂到另一行。
  - 第二步：从上一步的末尾往后，只吸收缩进大于 key 列的注释，中间可以夹空行。遇到缩进不超过 key 列的注释时，往后看下一条内容行：如果它仍是本行 map 的 key（不以 `-` 开头，且缩进不小于 key 列），就继续往后扫；否则停下，这条注释留在空隙里。最后如果下一项的行首更早，就收到下一项的行首。
  - 如果被交换的末项在文件末尾且没有结尾换行，先按文件的换行风格临时补一个 `\n` 或 `\r\n`，交换完成后去掉。文件原来有没有结尾换行，交换后保持不变。
- **R3 修正（W1b 实测）**：契约原文写的是「`end = node.range[1]`」，这在 explore↔architect 这一对上做不到逐字节往返。原因是移动之后，yaml 会把紧跟着的、缩进更浅的注释块（explore 的 `# config:`，16 个空格）吞进 config 节点的 range。改用上面的规则后，四对往返全部一致，下面的注释归属结论也不变。
- 在 fixture 中只有两对相邻项需要这样收束，被重叠的都是下一行行首的 14 个空格（`- id:` 前的缩进）：`tool-subagent-architect` 的 `range[1]` 落在 `tool-subagent-reviewer` 那一行的 `-` 上，`tool-subagent-reviewer` 对 `tool-subagent-coder` 也一样。收束后这 14 个空格归后一项。
- 注释归属只由上面的跨度决定，不做额外推断：
  - 落在 `[lineStart, end)` 内的注释随该项移动。例如 architect 的 value-end 内包含下一项的引导注释 `# Reviewer: code review against contract — uses claude-agent-acp.` / `# Same capability constraints as architect above.`，这两行跟 architect 走。
  - 留在空隙里的内容（`range[1]` 到下一项 `lineStart` 之间，包括只有 `range[2]` 才覆盖到的尾注释）不动。例如 explore 的整段 `# config:` / `# persona:`、coder 的 `#  agentOptions:` / `# config:`。
  - `- id` 之前的引导注释不在跨度内。例如 `tool-subagent-fork` 上方的 `# Fork omits model selection`、`tool-subagent-cursor` 后面的 `# ── Specialized subagent tools`，都留在原位。
- 交换通过一次拼接完成，`earlier` / `later` 按文件顺序取：
```ts
result = text.slice(0, earlier.start) + text.slice(later.start, later.end)
  + text.slice(earlier.end, later.start) + text.slice(earlier.start, earlier.end) + text.slice(later.end);
```
  拼接后调用 `parseYaml`。解析失败时返回 `{ ok:false, code:'INVALID', message:'移动后的配置无法解析' }`，不写文件。

| 情况 | code | message |
|---|---|---|
| 找不到 delegation 组 | `STRUCTURE` | `未找到 preset-standard-acp 的 delegation 组，当前 profile 结构不受支持` |
| id 不在过滤后的序列中（包括 `workflow-ptc`） | `NOT_FOUND` | `未找到 subagent '${id}'` |
| 第一项上移 | `INVALID` | `已经是第一个 subagent，不能上移` |
| 最后一项下移 | `INVALID` | `已经是最后一个 subagent，不能下移` |

- 往返要求：对 fixture 中的下面四对各交换两次，结果必须与原文件逐字节一致——fork↔acp（中间有大段注释）、explore↔architect（尾注释在空隙中）、architect↔reviewer（需要收束 14 个空格）、codex↔claude-code（都是只读行，中间只有一个换行）。

### 2.2 HTTP
- `WRITE_ACTIONS.subagents = ['create','update','remove','move']`。`validateWriteBody` 仍然在读文件、加锁之前执行。
- `move` 的 body 为 `{ expectedRevision, action:'move', id, direction }`，以下情况返回 400：
  - `direction` 缺失，或不是 `up`/`down`：`字段 direction 必须是 up、down 之一`
  - `id` 不是非空字符串：`字段 id 必须是非空字符串`
  - 带了 `input`：`字段 input 不支持`；带了 `patch`：`字段 patch 不支持`
  - 未知 action：`字段 action 必须是 create、update、remove、move 之一`
- 锁内处理：`if (write.action === 'move') return moveSubagent(yamlText, write.target!, write.direction);`。原有的 fallthrough 不能落到 `removeSubagent`；`move` 也不查 provider 目录。
- revision 不一致时返回 409 `STALE_REVISION`，文案 `配置已被其他地方修改，请刷新后重试`，不写文件。
- 成功时 notice 覆盖默认值：up 为 `已上移。只改变列表顺序，不影响模型看到的工具顺序`，down 为 `已下移。只改变列表顺序，不影响模型看到的工具顺序`。

### 2.3 `api-types`
`SubagentsMutationRequest.action` 扩展为 `'create' | 'update' | 'remove' | 'move'`，并新增 `direction?: 'up' | 'down'`。`api-client.ts` 不需要改。

### 2.4 store
新增 `move(id: string, direction: 'up' | 'down'): Promise<void>`，走现有的 `write()`，调用 `api.mutateSubagents({ expectedRevision: state.revision, action:'move', id, direction })`。
- 成功时 notice 使用响应里的文案。
- 遇到 `STALE_REVISION` 时执行 `refreshAfterConflict(err.message)`，不自动重试。
- 以下情况不发请求：
  - `writeBlocked()` 为真：设置 `WRITE_UNAVAILABLE_MESSAGE`；
  - 第一项上移或最后一项下移：直接返回；
  - `hostApiV2 !== true`：`error = 上移和下移需要重启 DSH 后生效`。
- 不检查 `row.editable`，只读行也会发出 move 请求。

### 2.5 `SubagentPanel`
- 操作列按钮顺序为 `↑`、`↓`、`编辑`、`删除`。箭头使用原生 `<button>`，不改 `ui/Button.tsx` 和 `tableStyles`，也不新增列。
- 箭头样式：24×24，`padding:0`，字号 14px，`borderRadius:6px`，边框 `var(--dsw-alias-border-l2)`，背景 `var(--dsw-alias-bg-layer-2)`，禁用时 `opacity:0.5`。
- 属性：`aria-label` 为 `上移 ${toolName}` / `下移 ${toolName}`，其中 `toolName = String(config.toolName ?? row.id)`；另加 `data-move="up"|"down"`、`data-move-id={row.id}`。
- 布局：两个箭头之间间距 4px，与后面的编辑、删除间距保持 8px；操作单元格设置 `whiteSpace:'nowrap'`。
- 禁用规则：

| 条件 | 上移 | 下移 | title |
|---|---|---|---|
| 第一项 | 禁用 | 按其他规则 | `已经是第一个 subagent，不能上移` |
| 最后一项 | 按其他规则 | 禁用 | `已经是最后一个 subagent，不能下移` |
| `busy` 或写入被阻止 | 禁用 | 禁用 | 写入被阻止时用现有的 `writeDisabledTitle` |
| `hostApiV2 !== true` | 禁用 | 禁用 | `上移和下移需要重启 DSH 后生效` |
| 只读行 | 不因此禁用 | 不因此禁用 | 编辑、删除仍按原逻辑 |

## 3. requirements.md 增量（只由功能 1 的逻辑 coder 落盘）
- **B6**（约 303 行）改为：subagents 的 action 为 `create`/`update`/`remove`/`move`，members 为 `add`/`update`/`remove`；`move` 必须提供非空的 `id`，`direction` 为 `up` 或 `down`，且不能带 `input`/`patch`。
- **C2**（约 386 行）的 body 改为：`{ expectedRevision, action: 'create'|'update'|'remove'|'move', id?, input?, patch?, direction? }`；补充说明 `move` 的 body 和成功 notice 的两句文案。
- **H**：「不改 Panel A 的表格列」改为「不改 Panel A 的表格列。v2.12 起操作列内可以有上移、下移（见 K16），不新增列」。
- 在 K14 之后插入 **K15 模型能力导入导出（v2.12）**、**K16 Subagent 排序（v2.12）**，内容摘要见本契约第 1、2 节。
- **K7** 表中新增两行测试映射（K15：io、store、panel 测试以及 tsc；K16：subagent-manager、http-routes、subagent-panel-store、panels、integration 测试，以及 index.test 仍为 9 条）。

## 4. 测试计划（先红后绿；用 `vi.mock` 替换 `downloadYaml`；导入用 `{name,size,text}` 形状的对象；不引入 jsdom）
### 4.1 功能 1
- **io.test.ts**
  - 导出结构：根键依次为 kind/version/providers/deepseek，且不含 `deepseek-official`；输出中不含密钥、`Authorization`、`headers`、6 个默认键、`_stash`；pi 模型保留 `inputModalities`；容量为 number；头注释 4 行；文件名匹配正则 `wuyou-models-\d{8}-\d{6}\.yaml`。
  - 本机无 DS 时，根上没有 `deepseek`。
  - 覆盖 `parseModelConfig` 的 4 种错误：kind 不对、version 为 `"1"`、根是数组、providers 是数组。
  - `previewModelImport` 逐一覆盖 1.5 节表格中的每种情况，并确认载荷里没有 headers。
  - `applyModelImport`：new 追加到末尾；conflict 按规则替换并保留本地字段；未勾选的项保持不变；DS 替换 models 并保留 thinking。
  - 往返：导出后再导入，在 id/api/displayName 上与原数据一致，且 `computeOps` 不写 headers。
- **store.test.ts**
  - 导出内容来自 base 而不是 draft；dirty 时 status 以「只导出已保存的配置」开头；只读时仍可导出。
  - dirty 或 conflict 时 `importConfig` 不读文件。
  - 超过 1MB 时报 `无法导入 a.yaml：文件超过 1MB 上限`。
  - confirm 后 draft 改变、`dirty>0`、status 正确，且未调用 mutate；cancel 后 draft 不变。
- **panel.test.tsx**
  - 列表头按钮顺序为导出、导入、添加提供方。
  - 只读时导入禁用、导出可用。
  - 对话框标题、「覆盖」勾选框和警告文案正确，且页面不含「已存在的配置不会被覆盖」。

### 4.2 功能 2
- **subagent-manager.test.ts**
  - 第 2.1 节的四对往返均逐字节一致。
  - 注释归属：fork、explore、architect、reviewer 相关的四处都按 2.1 节的规则落位。
  - 首项上移、末项下移返回 INVALID，且不返回新文本。
  - `workflow-ptc`、`missing` 返回 NOT_FOUND。
  - codex 下移后，`disabled: true` 和 provider 仍留在各自的块内，并且 `editable` 仍为 false。
- **http-routes.test.ts**
  - 合法请求返回 200，带上移 notice，相邻两项交换，revision 更新为新的 sha256。
  - 首项上移返回 400，文件不变。
  - 非法 direction、缺少 direction、带 input、带 patch、空 id 都在加锁前返回 400，文件不变。
  - 过期 revision 返回 409。
  - 未知 id 返回 404。
  - codex 下移返回 200。
- **subagent-panel-store.test.ts**
  - 请求体正确，notice 正确。
  - 首项上移不调 API；写入被阻止时不调 API。
  - `hostApi !== 2` 时报错且不调 API。
  - 只读行会调用 API。
  - 409 时刷新数据，不带旧 revision 重试。
- **panels.test.tsx**
  - 13 行顺序不变；首行上移禁用、末行下移禁用。
  - codex 的箭头可用，编辑禁用。
  - `aria-label` 含工具名。
  - `hostApi` 缺失时箭头禁用，title 含「重启 DSH」；写入被阻止时箭头禁用。
- **integration**
  - routes：move 一次再 move 回去，文件还原。
  - contract：通过 store move 后顺序改变，notice 含「不影响模型看到的工具顺序」。
  - index.test 不改。

## 5. 并行任务
- **W0**（1 名 coder，先做）：新建 io.ts 的桩（抛出 not implemented）；在 types.ts 加 `McUi.importPreview` 和 store 方法签名，store 里的新方法先返回空并设置 `importPreview:null`；api-types 放宽 union 并加 `direction?`；subagent-manager 导出一个桩 `moveSubagent`；subagent-panel-store 加一个空的 `move`。**不改 http-routes.ts**，避免 move 落进 fallthrough 被当成删除。验收：两个 tsconfig 的 tsc 都通过，vitest 保持全绿。
- **W1**（2 名 tester 并行）：
  - W1a：io.test.ts（新建）、store.test.ts、panel.test.tsx。
  - W1b：subagent-manager.test.ts、http-routes.test.ts、subagent-panel-store.test.ts、panels.test.tsx，以及 test/integration 下的 routes/contract。
- **W2**（4 人并行，改动文件互不重叠）：
  - W2a 功能 1 逻辑：io.ts、types.ts、store.ts，以及 docs/requirements.md（唯一允许改 requirements 的人）。
  - W2b 功能 1 UI：ProviderList.tsx、ImportPreviewDialog.tsx（新建）、ModelCapabilitiesPanel.tsx、styles.ts。
  - W2c 功能 2 Host 与 store：subagent-manager.ts、http-routes.ts、api-types.ts、subagent-panel-store.ts。
  - W2d 功能 2 UI：SubagentPanel.tsx。
- **收尾**：全量 vitest，两个 tsconfig 的 tsc，然后 `npm run build && npm run verify`。

## 6. 风险
- 注释不会按语义跟着对应行移动（`# Reviewer:` 跟 architect 走，explore 被注释掉的旧 config 留在空隙中）。这是为了和删除逻辑保持一致，由测试把这四处的字节位置固定下来。
- 14 空格收束只覆盖 fixture 中的两对。如果 `range[1]` 越过了下一项的 `- id`，拼接后 YAML 会损坏；`parseYaml` 失败时直接拒绝写入。不要用 `range[2]` 代替 `range[1]`。
- 新 client 搭配旧 Host：hostApi 版本号不升，未重启时按钮禁用；绕过前端直接调用会得到 400，不会被误当成删除。
- 导出的是已保存的基线，不是用户屏幕上看到的草稿。
- 勾选覆盖时会整体替换 `extra`，只存在于本地 extra 的键会丢失；`baseURL`、`apiKeyEnv`、`headers` 明确保留。
- 导入后容量是十进制字符串（例如 `128000`），可能与草稿中未规范化的写法（如 `128K`）不同，导致页面显示为有改动。
- 请求头在 schema 上没有标记 secret，它们的安全只靠导入、导出时主动丢弃。
- 功能 2 必须重启 DSH 才能生效。功能 1 只需要 build，client 端会通过 HMR 更新。
