# R4b 增量契约：流空闲超时 streamIdleTimeoutMs

本文只列相对 v2.11（`model-capabilities.md`）、R2（`model-capabilities.r2.md`）、R3（`r3-io-and-move.md`）的增量。事实依据见 `docs/llm-call-timeout.md` §1/§3.1/§5/§6 与 `r4-research-notes.md` §3。未点名的签名、保存顺序、导入导出流程一律不变。模型测试（r4a）另行设计，本文只规定两者的边界（第 8 节）。

已锁定的决定：
- 写入落点：profile `cordis.patch.yml` 的条目 `config`，经本 tab 现有 `remote.settings.mutate` 写入，热生效。pi-ai 为 `['providers', route, 'streamIdleTimeoutMs']`，DeepSeek 为 `['streamIdleTimeoutMs']`。path 不带 `config.`，不出现 `deepseek-official`。
- 值必须是 JS number（DSH schema 拒绝字符串）。`unset` 回落 DSH 默认 300000。
- 「默认 30 分钟」只作用于**新建**（向导、导入的新提供方）和**建议值**。已有提供方没有显式值时不静默写入，保持「不编辑 → 无 op、dirty=0」（R2 §2）。
- 单位：界面只收**分钟**（可带小数），写入时换成整数毫秒。不提供秒 / 毫秒输入，避免把 `300` 当成秒。
- 不新增依赖，client 不引 `@deepseek-ai/*`，样式只用 `styles.ts`，无颜色字面量，内容区宽 564px。

## 1. 草稿模型

### 1.1 types.ts
```ts
export const TIMEOUT_KEY = 'streamIdleTimeoutMs' as const;
export const DSH_DEFAULT_TIMEOUT_MS = 300000;      // DSH schema 默认，仅用于展示
export const SUGGESTED_TIMEOUT_MS = 1800000;       // 30 分钟：新建默认 + 建议值
export const TIMEOUT_MIN_MS = 1000;                // 界面与导入下限（1 秒）
export const TIMEOUT_MAX_MS = 2147483647;          // schema 上限
export const TIMEOUT_PRESETS: readonly (readonly [string, number])[] = [['5 分钟', 300000], ['30 分钟', 1800000], ['60 分钟', 3600000]];
export interface ProviderDraft {
  // …原有字段不变
  streamIdleTimeoutMs?: number;   // 显式值；undefined = user 层没有这个键
  timeoutText?: string;           // 仅编辑中：用户正在输入的分钟原文。不写回、不导出、不进 extra
}
export interface FieldErrors { /* …原有 */ streamIdleTimeoutMs?: string }
export interface WizardDraft { /* …原有 */ timeoutText: string }   // defaultWizard() 中为 '30'
// ImportItem.deepseek 增加 streamIdleTimeoutMs?: number
```
- `ModelCapabilitiesStore` 新增 4 个方法（第 6.5 节）。`setAccessField` 的联合类型**不扩**：DeepSeek 没有接入层，超时必须按 route 寻址。

### 1.2 读取（ops.ts `providerDraft`）
- 显式判定沿用 B1：pi 看 `user.providers[route]`，DS 看该 ns 的 `user`。`hasOwnProperty(userRaw, 'streamIdleTimeoutMs')` 且值为有限 number 时，写入 `p.streamIdleTimeoutMs`；否则不设。
- **不读 `value` 层**。`value` 里每个路由都有 300000（schema 默认），读它就会把默认当显式。
- `streamIdleTimeoutMs` 加入 known 集合，任何情况下都不进 `p.extra`（含 user 层是非 number 的异常值：丢弃，不报错）。
- 对称性：base 与草稿由同一次 `draftFromNamespaces` 得到，`timeoutText` 两边都为 undefined。
  - 真实 fixture（value=300000，user 无键）→ 两边都是 undefined → `fieldOut` 都是 undefined → 无 op。
  - user=1800000 → 两边都是 1800000 → 无 op。
- 保存成功后 base 由返回的 `value` 重建；`discard` 用 `clone(base)`，`timeoutText` 自然清空。

## 2. 「默认值 30 分钟」的含义（确认并细化原建议）

| 场景 | 行为 |
|---|---|
| (a) 向导新建 | 第 2 步「流空闲超时」输入框初值 `30`，可改可清空。`wizardFinish` 时：合法 → `streamIdleTimeoutMs = 分钟×60000`；清空 → 不设（走 DSH 默认）；非法 → 阻止「下一步」和「完成添加」。经 `routeWrite` 写进新建对象 |
| (b) 导入的新提供方 | 文件里没有该键 → 设为 1800000；文件里有合法值 → 用文件值；非法 → 整项 invalid（第 5 节） |
| (c) 已有提供方无显式值 | 不改。显示「未设置 · 使用 DSH 默认 5 分钟」，预设芯片里「30 分钟（推荐）」即一键设置 |
| (d) 建议 | 输入框 placeholder 固定为 `30`；未设置时 hint 末尾附「建议 30 分钟。」 |
| (e) DeepSeek | 同 (c)(d)。DS 不可新建、导入只有 conflict，故不适用 (a)(b) 的自动 1800000 |

不采用「加载时把缺省提供方补成 1800000」：会让每次打开面板都 dirty，破坏 R2 §2 的不变量，也会在用户不知情时改写 YAML。

## 3. 单位与校验（新文件 `timeout.ts`，纯函数）

```ts
export type TimeoutParse = { kind: 'empty' } | { kind: 'ok'; ms: number } | { kind: 'error'; message: string };
export function parseTimeoutMinutes(text: string): TimeoutParse;
export function timeoutError(text: string): string;            // ok/empty → ''
export function validTimeoutMs(v: unknown): v is number;       // 有限 number 且 TIMEOUT_MIN_MS ≤ v ≤ TIMEOUT_MAX_MS
export function msToMinutesText(ms: number): string;           // String(Number((ms/60000).toFixed(4)))
export function durationLabel(ms: number): string;
export function timeoutHint(ms: number | undefined): string;
export function timeoutSummary(p: ProviderDraft): string;
```
`parseTimeoutMinutes` 规则，按顺序判断：
1. `text.trim() === ''` → `empty`。
2. 不匹配 `/^-?\d+(\.\d+)?$/`（全角数字、`1e3`、`30分钟`、`.5` 都不匹配）→ `请输入分钟数，例如 30 或 0.5`。
3. 数值 ≤ 0 → `请输入大于 0 的分钟数`。
4. `ms = Math.round(min × 60000)`（四舍五入到整数毫秒）。`ms < 1000` → `不能少于 1 秒（0.0167 分钟）`。
5. `ms > 2147483647` → `不能超过 35791 分钟`（35791 分钟 = 2147460000 ms 合法；35792 非法）。
6. 否则 `ok`。

`durationLabel`：`ms % 60000 === 0` → `${ms/60000} 分钟`；否则 `ms % 1000 === 0` → `${ms/1000} 秒`；否则 `${ms} ms`。
`timeoutHint`：有值 → `= ${ms} ms · ${durationLabel(ms)}`；undefined → `未设置 · 使用 DSH 默认 5 分钟。建议 30 分钟。`
`timeoutSummary`：`timeoutText` 有 error → `流空闲超时 格式错误`；`timeoutText` 为 ok → 用解析值；为 empty 或无 `timeoutText` 时看 `streamIdleTimeoutMs`：有 → `流空闲超时 ${durationLabel(ms)}`，无 → `流空闲超时 默认 5 分钟`。

validate.ts：`routeErrors(p)` 对 pi 与 DS 都加一条：`p.timeoutText !== undefined` 且 `timeoutError(p.timeoutText)` 非空时，写 `e.streamIdleTimeoutMs`。只校验用户正在输入的原文；加载来的值（即使 < 1000）不报错，直到被编辑。`wizardErrors` 返回类型增加 `timeout?`，用 `timeoutError(w.timeoutText)`。现有 `errorCount` 已让任一 route 错误阻止保存，无需改 `save`。

## 4. ops

- `PI_FIELDS` 末尾追加 `'streamIdleTimeoutMs'`（变为 6 项）；`DS_FIELDS` 末尾追加（变为 3 项）。`routeWrite`、`piExport`、`deepseekExport`、`PI_KNOWN_KEYS`、`DS_KNOWN_KEYS` 自动覆盖。
- `fieldOut(p, 'streamIdleTimeoutMs')`：
  - `timeoutText !== undefined`：`parseTimeoutMinutes` 为 error → `SKIP`；empty → `undefined`；ok → `ms`。
  - 否则返回 `p.streamIdleTimeoutMs`（number 或 undefined）。
- `fieldOps` 遇到该键的 `SKIP` 一律计入 changed（base 从不带 `timeoutText`，出现非法原文必然是编辑）。其余键的 SKIP 逻辑不变。
- 结果：base=undefined、草稿=1800000 → `set`；base=1800000、草稿 undefined（恢复默认或清空）→ `unset`；两边 number 相等（含用户输入 `30` 而 base 为 1800000）→ 无 op、不 dirty。
- value 永远是 JS number（`typeof === 'number'`），不是字符串。
- DS 的 op 进 `ds` 列表，path `['streamIdleTimeoutMs']`。
- 新建：`routeWrite` 中有值才写 `streamIdleTimeoutMs`，位置在 `apiKeyEnv`/`headers` 之后、`models` 之前；没有值则对象里无此键。
- 预览沿用 `yScalar`：`set  path: [providers, gpt-gateway, streamIdleTimeoutMs]  value: 1800000`。

## 5. io

- **导出**：只写显式值。pi 在 `apiKeyEnv` 后、extra 前；DS 在 `reasoningEffort` 后、extra 前。未设置不写。由于不再进 extra，修复「value 层 300000 泄露进导出」。
- **导入**校验（`validateProvider`：在「缺少 api」之后、模型检查之前；`validateDeepseek`：在 skip 判断之后、模型检查之前）：文件有该键且 `!validTimeoutMs(v)`（含字符串 `"1800000"`、0、负数、> 上限、< 1000）→ **整项 invalid**：
  - pi：`提供方 '${id}' 的 streamIdleTimeoutMs 不合法：应为 1000–2147483647 的毫秒数`
  - DS：`DeepSeek 的 streamIdleTimeoutMs 不合法：应为 1000–2147483647 的毫秒数`
  - 理由：与容量格式规则一致（R3 1.5「有错误的整个提供方都不进入载荷」）；静默丢弃会让用户以为已导入 30 分钟，实际仍是 5 分钟或保留旧值。
- 规范化：`providerPayload`/`deepseekPayload` 合法时写 `Math.round(v)` 到 `streamIdleTimeoutMs`（如 `1500.5` → `1501`），并从 extra 中剔除（known 集合已含）。new 与 conflict 合并共用这份载荷，所以两条路径结果一致。
- `kind === 'new'` 且文件无该键 → 载荷 `streamIdleTimeoutMs = 1800000`；conflict 不补。
- **合并**（`applyModelImport`，修复现有静默丢弃）：
  - pi conflict：载荷有值 → 覆盖本地并 `delete local.timeoutText`；载荷无值 → 保留本地（不 unset，旧导出文件不带这个键）。
  - DS conflict：同上规则写 `local.streamIdleTimeoutMs`。
- conflict 的 `reason`：文件值与本地显式值不同（含本地未设置）时，在原文后追加 `；流空闲超时将改为 ${durationLabel(v)}`。相同或文件无该键时 reason 与 R3 原文逐字相同（现有断言不变）。

## 6. UI（564px 内）

### 6.1 组件 `components/TimeoutField.tsx`（新）
受控展示组件，pi 接入层、DS 详情、向导三处复用。
```ts
interface TimeoutFieldProps {
  scope: 'access' | 'ds' | 'wizard';
  text: string;                 // 显示值：timeoutText ?? (ms 有值 ? msToMinutesText(ms) : '')
  resolvedMs: number | undefined;  // 用于 hint 与芯片 pressed
  explicit: boolean;            // 「恢复 DSH 默认」是否可点
  error?: string;
  disabled?: boolean;
  onText(v: string): void; onBlur(): void; onPreset(ms: number): void; onReset(): void;
}
```
- 第 1 行（`s.capline`）：label「流空闲超时」，输入框（`inputMode="decimal"`、`s.input`+`s.mono`+`s.capInput`，placeholder `30`）、后缀文本「分钟」、链接按钮「恢复 DSH 默认」。
- 第 2 行（`s.chips`）：芯片 `5 分钟`、`30 分钟（推荐）`、`60 分钟`，`aria-pressed` 仅当 `resolvedMs === 预设值`。
- 第 3 行：有错误时 `ErrText`（`aria-invalid`、`aria-describedby` 照抄 CapacityField），否则 `Hint{timeoutHint(resolvedMs)}`。
- 第 4 行固定语义说明（`Hint`）：`连续这么久没有收到任何数据就判定超时；不是单次调用的总时长。超时后 DSH 会话默认会自动重试。`
- data hooks：根 `data-mc="timeout" data-mc-scope={scope}`；输入框 `data-mc="timeout-input"`；芯片 `data-mc="timeout-preset" data-mc-ms={ms}`；重置 `data-mc="timeout-reset"`；hint `data-mc="timeout-hint"`。

### 6.2 pi：EditAccessLayer
在密钥 `grid2` 之后、`<Section title="请求头">` 之前插入 `<Section title="超时"><TimeoutField scope="access" …/></Section>`，错误取 `re.streamIdleTimeoutMs`。

### 6.3 DeepSeek：ProviderDetail DS 分支
- 「思考」Section 之后新增 `<Section title="超时"><TimeoutField scope="ds" …/></Section>`。
- 描述改为：`官方提供方由「模型」页接入，这里改思考和超时。接入本身不在这里改。`

### 6.4 头部摘要（只读）
pi 头部 `s.small` 行、DS 头部 CredStatus 行末尾各追加 `<span data-mc="timeout-summary">· {timeoutSummary(p)}</span>`。

### 6.5 store 方法（types 与 store.ts）
```ts
setTimeoutText(route: string, text: string): void;   // p.timeoutText = text（mutateDraft）
blurTimeout(route: string): void;                    // ok → ms=解析值、删 timeoutText；empty → 删 ms 与 timeoutText；error → 保留原文
setTimeoutPreset(route: string, ms: number): void;   // ms=preset，删 timeoutText
resetTimeout(route: string): void;                   // 删 ms 与 timeoutText（=「恢复 DSH 默认」，产出 unset 或无 op）
```
- route 不存在、`ui.readonly`、`ui.saving` 时为 no-op（不 publish）。DS 传 `DS_ROUTE_ID`。
- 向导不走以上方法：组件以 `wizardPatch({ timeoutText })` 实现输入/预设（`msToMinutesText(ms)`）/重置（`''`）；blur 不做规范化。`wizardNext` 第 2 步在 `wizardErrors(w).timeout` 时置 `tried2` 并停留；`wizardFinish` 同样阻断；「下一步」按钮 `disabled` 增加 `!!e.timeout`。错误在向导里始终显示（不依赖 tried2）。

### 6.6 向导第 2 步
在「密钥」grid2 之后、「高级：请求头」之前放 `<TimeoutField scope="wizard" …/>`，`explicit = w.timeoutText.trim() !== ''`。

## 7. 只读、不可写与凭证
- 只读（C 节四种条件任一）或保存中：输入框、芯片、「恢复 DSH 默认」全部 disabled，store 方法 no-op；摘要仍显示。
- 某 ns 缺席（只有 pi 或只有 DS）时，缺的那边不渲染、不产 op，与现有规则一致。
- 与凭证无关：`credWritable === false` 只禁用密钥框，超时照常可编辑；超时修改不产生 `cred` op，也不触发凭证写入。

## 8. 与模型测试（r4a）的关系
- 模型测试使用自己固定的 20s deadline（`AbortSignal`），与本设置无关，本设置也不读它。
- 超时改动与其他字段一样使提供方进入 `dirtySet`，直到保存成功；未保存的超时值不影响运行时，也不影响模型测试。

## 9. TDD 测试计划

fixtures（`test-fixtures.ts`）：`piValue()` 的两个路由与 `dsValue()` 加 `streamIdleTimeoutMs: 300000`；`piUser()` 的 `gpt-gateway`、`cc-gateway` 加 `streamIdleTimeoutMs: 1800000`；`dsUser()` 不加。

| 文件 | 用例名 | 输入 → 期望 |
|---|---|---|
| `timeout.test.ts`（新） | T1 parse ok | `'30'`→1800000；`'0.5'`→30000；`' 60 '`→3600000；`'35791'`→2147460000；`'0.0167'`→1002 |
| | T2 parse empty | `''`、`'  '` → `{kind:'empty'}` |
| | T3 parse error 逐字 | `'0'`、`'-1'`→`请输入大于 0 的分钟数`；`'0.01'`→`不能少于 1 秒（0.0167 分钟）`；`'35792'`→`不能超过 35791 分钟`；`'abc'`、`'1e3'`、`'３０'`、`'30分钟'`→`请输入分钟数，例如 30 或 0.5` |
| | T4 msToMinutesText / durationLabel / hint / summary | 1800000→`'30'`/`30 分钟`/`= 1800000 ms · 30 分钟`；90000→`'1.5'`/`90 秒`；1500→`1500 ms`；undefined→hint 原文；summary 三态原文 |
| | T5 validTimeoutMs | 1000、2147483647 真；999、0、-1、2147483648、NaN、Infinity、`'1800000'` 假 |
| `ops.test.ts` | O1 fixture 对称 | 新 fixture load → gpt/cc=1800000，DS undefined，extra 无该键，`computeOps(base, clone)` pi/ds 空、dirty=0 |
| | O2 set/unset | gpt 改 3600000 → `[{set,['providers','gpt-gateway','streamIdleTimeoutMs'],3600000}]`，`typeof value==='number'`；删 ms → unset；DS 设 1800000 → ds `[{set,['streamIdleTimeoutMs'],1800000}]`，无 deepseek-official |
| | O3 text 规则 | `timeoutText='30'`（base 1800000）→ 无 op、dirty=0；`'abc'` → 无 op、dirty=1；`''` → unset |
| | O4 新建 | 新提供方 ms=1800000 → set 对象含 `streamIdleTimeoutMs:1800000` 且在 `models` 前；无值 → 对象无此键 |
| | O5 user 非 number | user `'1800000'` → 草稿 undefined、extra 无键、无 op |
| `validate.test.ts` | V1 routeErrors | pi/DS `timeoutText='0'` → `e.streamIdleTimeoutMs==='请输入大于 0 的分钟数'`；`'30'`、undefined → 无该键；加载值 500 无 text → 无错误 |
| | V2 wizardErrors | `timeoutText='35792'`→`timeout==='不能超过 35791 分钟'`；`''`→无 |
| `io.test.ts` | I1 导出 | 显式 1800000 → YAML 含 `streamIdleTimeoutMs: 1800000` 且位于 apiKeyEnv 后；未设置 → 不含；extra 里残留 300000 → 不导出；DS 同理 |
| | I2 导入 new | 无键→1800000；`600000`→600000；extra 无该键 |
| | I3 导入 invalid | `0`/`'1800000'`/`2147483648`/`999` → kind invalid、reason 逐字；DS 同理 |
| | I4 conflict 合并 | 文件 600000 → 本地改为 600000、timeoutText 删除、reason 带后缀 `；流空闲超时将改为 10 分钟`；文件无键 → 本地保留、reason 与 R3 逐字相同 |
| | I5 DS 合并 | DS 文件 1800000 → 草稿值 1800000，`computeOps` 产出 ds set |
| | I6 往返 | 新 fixture base 导出→parse→preview→全选 apply→ `computeOps(base, next)` 中无 timeout op |
| `store.test.ts` | S1 load | dirty=0；gpt 草稿 1800000 |
| | S2 输入与 blur | `setTimeoutText('gpt-gateway','60')` → ops.pi 一条 set 3600000；`blurTimeout` → timeoutText undefined、ms 3600000 |
| | S3 错误阻止保存 | `setTimeoutText(..,'abc')` → errors 有该键；`save()` 不调 mutate，status `请先修正标红字段。` |
| | S4 预设与重置 | `setTimeoutPreset(DS_ROUTE_ID,1800000)`+save → mutate(`llm-deepseek`, `[{set,['streamIdleTimeoutMs'],1800000}]`, 11)；`resetTimeout('gpt-gateway')` → unset |
| | S5 只读/保存中 | 四种只读条件下四个方法 no-op，ops 不变 |
| | S6 向导 | 默认 finish → 新建对象 1800000；`timeoutText=''` → 无键；`'0'` → wizardNext 停在 2、wizardFinish 不建 |
| | S7 discard / 凭证 | 改后 discard → 恢复 1800000、dirty=0；`credWritable:false` 仍可改且 cred 为空 |
| `panel.test.tsx` | P1 接入层 | 含 `data-mc="timeout"`、`data-mc-scope="access"`、`超时`、`value="30"`、`= 1800000 ms · 30 分钟`、语义说明原文；`timeout` 出现在 `密钥环境变量名` 之后、`请求头` 之前 |
| | P2 DS 详情 | scope `ds`、`未设置 · 使用 DSH 默认 5 分钟`、`流空闲超时 默认 5 分钟`、新描述原文 |
| | P3 错误/只读 | 错误态 `aria-invalid="true"` 与文案；只读时 input 与芯片 `disabled` |
| | P4 向导第 2 步 | scope `wizard`、`value="30"`、`30 分钟（推荐）` 芯片 `aria-pressed="true"` |
| `regression-r2.test.ts` | R4b-1 | 新 fixture 不编辑 → 无 timeout op；schema 默认 300000 从不被 set/unset |
| | R4b-2 | 向导新建对象含 1800000，仍无 6 个默认键 |

现有用例需改动（仅此一处）：`panel.test.tsx` 的 `WIZARD_STEP3` 字面量补 `timeoutText: '30'`（`WizardDraft` 新增必填字段，否则 tsc 失败）。`PI_FIELDS`/`DS_FIELDS` 长度无现有断言。其余现有断言（含 R3 reason 原文、R2-2 新建对象、store 导出 `toContain`）应原样通过；若 tester 发现其他断言因 fixture 变化失败，回报 orchestrator，不得自行改业务断言。

## 10. 分工与验收

| 角色 | 允许路径 | 内容 |
|---|---|---|
| tester（先红） | `src/client/model-capabilities/*.test.ts(x)`、`timeout.test.ts`、`test-fixtures.ts` | 第 9 节全部用例；新增用例应失败，现有 909 个仍通过 |
| coder | `types.ts`、`timeout.ts`（新）、`ops.ts`、`validate.ts`、`io.ts`、`store.ts` | 第 1–5、6.5 节 |
| front-designer | `components/TimeoutField.tsx`（新）、`EditAccessLayer.tsx`、`ProviderDetail.tsx`、`AddProviderWizard.tsx`、`styles.ts`（仅在必要时加样式键） | 第 6 节 |
| docs | `docs/requirements.md`（新增 `### K18. 流空闲超时（v2.13）` 与 K7 验收表一行）、`docs/llm-call-timeout.md` §5 追加「面板已支持」说明 | |

禁止改：`register.ts`、host 路由、`src/client/shared/*`、`scripts/build-client.mjs`、`package.json`。

verify：
- `npm test` → 全部通过，文件数 41（+`timeout.test.ts`），用例数 > 909，0 失败。
- `npx tsc -p tsconfig.client.json --noEmit` → 退出码 0。
- `npm run build` → 退出码 0。
- `grep -rn "@deepseek-ai/" src/client/model-capabilities` → 无输出；颜色扫描用例（现有）通过。

## 11. 非目标与风险
非目标：不编辑 `timeoutMs`、`websocketConnectTimeoutMs`、`retryPolicy`；不做秒/毫秒单位切换；不批量设置所有提供方；不改 DSH 默认值；不读写 `$DSH_HOME/settings.yaml`。

风险：
- 旧导出文件把泄露的 300000 写在提供方上；conflict 导入会把本地 1800000 改回 5 分钟。缓解：reason 后缀明示「将改为 5 分钟」，默认不勾选 conflict，保存前可预览。
- `volatile` 热生效只影响之后的新请求；进行中的流仍按旧值计时（未实测，不在 UI 承诺）。
- 加载到 < 1000 的手写值时界面显示近似分钟（如 `0.0083`），编辑后才校验；不阻止保存未编辑的值。
- 浮点：`Math.round` 统一到整数毫秒；`msToMinutesText` 保留 4 位小数，非整分钟值（如 90000）回显为 `1.5`，再次 blur 得到相同 ms，不产生假 dirty。
- 条目 id 若被改名（非 `llm-pi-ai`/`llm-deepseek`），沿用现有 ns 识别规则，本文不扩展。

## R4 审查返工（v2.13.1）

- L1 导入取整：`providerPayload` / `deepseekPayload` 对合法的 `streamIdleTimeoutMs` 先 `Math.round` 再写入载荷（第 5 节「规范化」）。new 与 conflict 合并都走这份载荷，`1500.5` 两条路径都得到 `1501`。校验规则（`validTimeoutMs`）与 invalid 文案不变。用例：I7。
