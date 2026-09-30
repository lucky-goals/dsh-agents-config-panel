# 模型能力 R2 增量契约

本文只列相对 v2.11（`model-capabilities.md`）的增量。未点名的签名、保存顺序、DeepSeek「思考」、行菜单方向键，一律保持 v2.11 不变。

已锁定的决定：
- 提供方级默认值从面板中移除。
- 模型的容量和输入只有「已设置 / 未设置」两种状态。
- 容量只在两侧都是合法数字、且最大输出大于窗口时才报错。
- 「···」列采用已实测过的轨道。
- low 第 5 条不改。

## 1. 类型与签名

### 1.1 types.ts
**删除**
- `RUNTIME_CW`、`RUNTIME_MT`、`DS_RUNTIME_CW`、`DS_RUNTIME_MT`
- `CAP_FMT_ERR_ROUTE`、`CapScope`
- `ProviderDraft` 的 `defaultInput`、`reasoning`、`defaultContextWindow`、`defaultMaxTokens`、`maxTokens`（`ModelDraft.maxTokens` 保留）
- `WizardDraft` 的 `defaultInput`、`reasoning`、`cap`
- `CapSide` 的 `fallback`、`src`、`eff`
- `FieldErrors` 的 `defaultContextWindow`、`defaultMaxTokens`
- `BulkDraft` 的 `'inherit'`，改为 `'clear'`

**保留**
- `ProviderDraft` 的 `thinking`、`reasoningEffort`。它们是 DeepSeek 提供方级的思考设置，不属于默认值继承。

**修改**
```ts
export const CAP_FMT_ERR = '填正整数，可用 K 或 M 后缀（如 128K、1M）。';
export interface CapSide {
  key: 'contextWindow' | 'maxTokens';
  explicit: boolean;               // 键在模型上且 parseCap !== undefined；空白不算已设置；非法（null）算已设置
  raw: string;
  parsed: number | null | undefined; // undefined 未设置/空白；null 非法；number 合法
}
// FieldErrors 新增 headers?: string，删除 defaultContextWindow/defaultMaxTokens
// BulkDraft: inMode/cw/mt: 'none' | 'set' | 'clear'
```
轨道注释只保留 `m:<route>:<idx>`、`ds`、`bulk`，删除 `r:` 和 `wiz`。

### 1.2 ModelCapabilitiesStore
- 删除 `setInputOverride`、`capInherit`、`capExplicit`、`railClear`。
- 签名：
  ```ts
  toggleInput(scope: 'model'|'bulk', modality: InputModality): void;
  setCap(side: CapSideKey, raw: string): void;
  blurCap(side: CapSideKey): void;
  capClear(side: CapSideKey): void;   // 新增
  clearInput(): void;                 // 新增
  ```
- `railToggle` 只处理 `bulk`、`ds`、`m:<route>:<idx>` 三种 key，其他 key 直接返回。
- `toggleInput('model')`：pi 读写 `input`，DS 读写 `inputModalities`。
  - 键不存在时，点击某个芯片就写成只含该模态的数组。
  - 键已存在时切换对应模态。只剩最后一种时不修改，并设置 `inputHint={key:'model'|'bulk', text:'至少保留一种输入类型'}`。
- `clearInput()` 只作用于当前模型：pi 删除 `input`，DS 删除 `inputModalities`。pi 上的旧字段 `inputModalities` 不动。
- `setCap`、`blurCap`、`capClear` 只写当前模型。

### 1.3 纯函数
| 导出 | 签名 / 语义 |
|---|---|
| parseCap / abbr / canAbbr | 不变 |
| modelCap | `(m: ModelDraft) => CapState` |
| capFmtBad | `(side) => parsed === null` |
| capOver / capBlocks | `(c: CapState) => boolean`：两侧 parsed 都是 number 且 mt > cw |
| capErrors | `(c, fmtMsg) => {cw?, mt?}`，越界文案 `最大输出大于上下文窗口（${mt} > ${cw}）。输出不能超过上下文窗口。` |
| resolvedInput | `(p, m) => { v: InputModality[]; set: boolean }`。pi 取 input，DS 取 inputModalities；缺键返回 `{v:[], set:false}`，DS 缺键不再当作 text |
| inputSummary | `未设置` / `文本` / `文本+图片` / `图片`，不再有「继承·」 |
| routeErrors | 只处理 pi 的空白 apiKeyEnv 和重复请求头 |
| wizardErrors | `(w, d) => { id?, models?, headers? }` |
| modelCapBad | `(m) => boolean`：格式非法或 capBlocks |
| canonicalPersist（新增） | `(m) => string`：去掉 `_stash`；容量 parseCap 得到 number 时写成 `String(n)`；空白键省略；null 保留原文；最后 `JSON.stringify` |
| rawPersist | 保留，但 bulkPlan 不再用它判断变化 |

- 删除导出：`routeCap`、`capWarn`、`routeCapBad`。
- 删除未导出的 `capOut`，以及 `routeWrite` 上的不可枚举 `length`。
- `modelOut` 在 `modelCapBad` 为 false 时，只写 parsed 为 number 的那一侧。

## 2. 数据映射与写回
- known 集合
  - pi：`api, displayName, baseURL, apiKeyEnv, headers, models, defaultInput, reasoning, defaultContextWindow, defaultMaxTokens`
  - DS：`thinking, reasoningEffort, apiKeyEnv, models, defaultContextWindow, maxTokens`
- 这 6 个默认键（pi 4 个 + DS 2 个）只放在 known 里：不进草稿字段，不进 extra。
- `PI_FIELDS = api, displayName, baseURL, apiKeyEnv, headers`；`DS_FIELDS = thinking, reasoningEffort`。`fieldOut` 删除提供方级容量分支。
- 新建提供方只写 `api`、可选的 `displayName` 和 `baseURL`、`apiKeyEnv`、可选的 `headers`、`models`，再铺 extra；模型带 `reasoningEfforts:false`，不能出现 6 个默认键。
- 兼容：草稿未改时 op 为空、dirty=0。远端已有的 6 个键不 unset，也不因 schema 默认值被 set。

## 3. UI
颜色只用 `C.*`（`--dsw-alias-*`）；未设置的说明文字用 `C.fg2`；删除 `chipInherit`。

- **容量**
  - 输入框始终可编辑（只读或保存中除外），placeholder 为 `未设置`。
  - 未设置时 hint 显示 `未设置`。已设置时显示 `已设置。留空或点「清除」会删掉这个字段。`；pi 的最大输出额外显示 `显式写入后，这个值会成为该模型每次请求的默认输出上限。`
  - 预设芯片始终显示，`aria-pressed` 仅当 parsed 等于该预设时为 true。
  - 链接 `清除`：未设置或锁定时禁用，点击调用 `capClear`。
- **输入**
  - 芯片为 `文本`、`图片`，按数组状态显示 pressed。未设置时两者都不按下，旁边显示 `未设置`。
  - 已设置时在标题旁显示 `清除`，点击调用 `clearInput`。
- **删除的文案和控件**：提供方默认值、默认输入、路由默认档、继承中、单独设置、恢复继承、清除默认档、「默认」标记、「这是继承的值…」、所有回退数字和「缺省顺序 / 目录优先」说明。

| 组件 | 改动 |
|---|---|
| ProviderDetail | 删除 pi/DS 整节「提供方默认值」，以及 RouteCapFields、RouteDefaultInput、RouteDefaultRail。DS「思考」节原样保留。pi 的 apiKeyEnv 错误移到头部 baseURL 下，文案 `填写密钥环境变量名。（在「编辑接入」里修改）`。旧字段横幅保留 |
| ModelEditLayer | 删除继承相关内容和 defaultLevel。旧字段 hint 改为：`配置里还有旧字段 inputModalities: [${列表}]，自定义提供方会忽略它。可在模型列表上方「迁移为 input」。`。容量节只保留 `上下文窗口是请求与响应合计的 token 上限。` |
| CapacityField | props 为 `side, cap, pi, disabled?, store, error?`，失焦时调用 blurCap |
| InputChips | 删除 `inherited` |
| EffortRail | 只保留 `multi` 和 `ds`；删除 single、defaultLevel、onClear、SingleRailHint、「默认」 |
| AddProviderWizard | 第 3 步只保留模型列表；删除 wizardRoute；「完成添加」只受模型 ID 错误和锁定影响 |
| EditAccessLayer | 删除「默认值」节；请求头节显示 `errors.headers` |
| ProviderList | pi 摘要去掉「默认档 X / 未设默认档」，有旧字段时显示 `有旧字段`；DS 显示 `思考 X`/`不思考` 和 `不可删除` |
| ModelTable | 输入列用 inputSummary；容量列：合法值显示缩写，未设置显示 `未设置`，非法值用截断原文加 capBad 标记；aria 为 `上下文未设置` / `上下文 ${n}` / `上下文格式错误：${raw}`，输出同理 |
| BulkLayer | 输入和两侧容量都提供 `不修改`/`设置为`/`清除`。复制锁定时，三组各显示 `正在从模型复制，这一组已锁定。`。复制组显示 `复制输入、思考和容量。源未设置的项会在目标上清除；不复制 ID 和名称。` 和 `复制会一起覆盖输入、思考和容量。取消复制后才能分别设置。` |

表格：
- `mtable` 设 `minWidth:0`，`gridTemplateColumns: 24px minmax(96px,1.6fr) minmax(64px,1fr) minmax(56px,1.2fr) minmax(84px,max-content) max-content`。
- `s.scroll` 加 `minWidth:0`。
- `ops` 设 `gap:'2px'`、`flexWrap:'nowrap'`，「···」保持 28px。

## 4. low（#5 保持现状）
1. 模型格式错误只用新的 CAP_FMT_ERR。批量「设置为」的值为空白时提示 `填写数值，或改为「不修改」或「清除」。`；格式非法时用 CAP_FMT_ERR。
2. 复制锁定说明出现在三组中（见第 3 节）。
3. `先选择源模型。` 在组内用 `s.hint`，底栏用 `s.bsum`，都不用错误色；bulkSummary 对它返回 `{t, ok:false}`，不设 err。源档位不完整、容量非法、数值为空白时仍用错误色。
4. 复制时如果源没有 input，底栏摘要和结果句都追加：`源没有 input，目标会清除输入。`；源有旧字段时改为 `源没有 input，目标会清除输入；不复制旧字段。`
6. 不改 Modal.tsx。
   - 对话框打开时，如果焦点在层内，记下该元素。对话框关闭后，在 useInert 之后的 layout effect 里恢复焦点：优先恢复到记下的元素，否则聚焦 `[data-mc="close-layer"], [data-mc="bulk-close"]`。
   - 层或对话框打开时，topbar 设为 inert。
   - 只有层、没有对话框时，在 document 捕获阶段拦截 Tab，让焦点只在层和保存条之间循环；焦点如果在宿主侧栏，第一次 Tab 把它拉回层内。有对话框时沿用 Modal 的处理。
7. bulkPlan 用 canonicalPersist 判断变化：`128K` 与 `128000` 视为相同，C 不增加。
8. 复制时源的任一侧 parseCap 为 null：设置 `errs.src = 源模型的容量格式不正确，不能复制。`，C=0，整次复制阻断，目标保持不变。源某侧未设置时删除目标对应键；源合法时写入 `String(parsed)`。
9. openBulk 和 resetFromDescribe 都把 menuIdx 设为 null。
10. 设置和凭证都写入成功时：`sel={}`、`undo=null`。
11. resetFromDescribe 增加内部参数 `{keepView?}`。
   - load 和用户点「重新加载」时为 false，回到列表。
   - 无草稿时收到 `settings/document-updated`、`llm/adapters-updated`、`connection/reset`，参数为 true：保留 view、route、edit、bulk、wizard、dialog、sel、undo、showAdv、previewReturn、dsPrev、wizardSecret，menuIdx 设为 null。
   - route 已不存在：回到列表，关掉所有层。
   - 编辑层按记录的模型 id 校验：id 变了或下标越界就关层，但保持在详情页。sel 丢弃越界下标；undo.idx 越界则清空 undo。
12. 只在本轮 pi 已写成功、ds 写失败时使用下列文案，写进横幅正文，并清空 ui.status：
   - DS 冲突：`这份配置刚刚被别处改过。llm-pi-ai 已写入。llm-deepseek 这次没写入。你的修改还在。`
   - DS 其他错误：`{remoteErrorText}。llm-pi-ai 已写入。llm-deepseek 这次没写入。你的修改还在。`
   - 本轮 pi 没写成功时，冲突文案仍为 `这份配置刚刚被别处改过，这次没写入。你的修改还在。`
13. 移除 transparent：btnBase、chipBase、railNode、menuItem 的 background 改为 `'none'`；chipOn、stepNOn 的 border 改为 `` `0.5px solid ${C.fill}` ``；railNodeOn.borderColor 改为 `C.fill`。
14. blurCap：键不存在直接返回；parseCap 为 undefined 时删除键；为 number 时写成 `String(n)`；为 null 时保留原文。
15. 删除 routeWrite 上的 length。
16. secretError 的错误文案：`密钥只能包含 ASCII 非空白字符，不能写成环境变量赋值，也不能首尾用同一种引号包住。`（规则不变）
17. 请求头名按 trim 后的非空值比较，大小写敏感。有重复时提示：`请求头名称「A」、「B」重复。请改成不同的名称后再保存。`，名称按首次出现顺序、去重列出。routeErrors 和 wizardErrors 都写 headers 错误并阻断保存；fieldOut 返回 SKIP；这种情况计入 dirty。
18. pendingEcho 改为 `Map<string, number[]>`。
   - inFlight 期间每收到一个回声就把 revision 追加进去。
   - mutate 落地后同步取出并清空该数组，再 `inFlight.delete`。finally 里不再删 pendingEcho。
   - 成功时：`foreign = seen.filter(r => r !== result.value.revision)`。
     - foreign 为空：`ownWrites.set`，然后 updateNamespace。
     - foreign 非空：仍然 `ownWrites.set`，但不 updateNamespace，停止写入，conflict 设为 shown，文案 `配置已写入，但写入期间远端又被改过。你的修改还在。`；如果本轮 pi 已写入，前面加 `llm-pi-ai 已写入。`
   - 非冲突错误且 seen 不为空：conflict 设为 shown。本轮 pi 未写入时文案为 `{remoteErrorText}。这次没写入。你的修改还在。远端配置已经变化。`；pi 已写入时用 #12 的文案，末尾加 `远端配置已经变化。`
   - 冲突错误：走 #12，然后清空数组。
   - resetFromDescribe 仍然 clear。

## 5. 测试
不引入 jsdom。#6 的焦点时序不写 SSR 断言。

- capacity：删除 routeCap 整组，以及「src=route」「路由回退」用例；显式容量不再断言 fallback/src/eff。capBlocks 改为三种情况：只设窗口不阻止；两侧都未设置不阻止；两侧都是数字且越界时阻止。
- efforts：「继承·」改为 `未设置` 并断言 set=false；DS 没有 inputModalities 时显示 `未设置`。
- validate：删除路由容量相关用例和 routeCapBad；modelCapBad 只看模型；secretError 补 #16 的全文。
- ops：6 个默认键既不在草稿里也不在 extra 里；新建的对象里没有这 6 个键；重复请求头不产生 set；routeWrite 没有 length。
- bulk：inherit 改为 clear，并附旧字段提示 `旧字段 inputModalities 不会被「清除」清掉，请用「迁移为 input」。`；#4 两句；#1 文案；短语 `容量清除` / `上下文窗口清除`；覆盖 #7、#8。
- store：无草稿时的外部更新保持在详情页；pi 成功、ds 冲突时用 #12 文案；保存成功后清 sel/undo；空白失焦时删除键。
- 新增 regression-r2.test.ts，覆盖 R2-1 到 R2-20：
  - R2-1 默认键不产生 op，也不进草稿和 extra。
  - R2-2 新建时不写默认键。
  - R2-3 DS 只设 cw 时不报错。
  - R2-4 两侧都设置且越界时阻止。
  - R2-5 未设置时 input 摘要为 `未设置`。
  - R2-6 128K 与 128000 相同，C=0。
  - R2-7 源非法时阻断复制。
  - R2-8 底栏的旧字段提示句。
  - R2-9 请求头重复。
  - R2-10 secretError。
  - R2-11 外部更新后保持在详情页。
  - R2-12 route 消失后回到列表。
  - R2-13 编辑层的 id 变化后关层。
  - R2-14 保存后清空 sel/undo。
  - R2-15 #12 的冲突句。
  - R2-16 inFlight 期间先收到自己的回声、再收到外部 revision。
  - R2-17 inFlight 期间收到外部 revision 且返回非冲突错误。
  - R2-18 空白失焦时删除键。
  - R2-19 menuIdx 置 null。
  - R2-20 摘要为 `图片`。
- panel.test.tsx：
  - pi 详情不含 `提供方默认值`、`默认档`、`未设默认档`。
  - DS 详情保留思考相关文案，不含 `提供方默认值`。
  - 编辑层含 `清除`，不含 `恢复继承`、`单独设置`；使用新的旧字段 hint。
  - 未设置的输入显示 `未设置`，不含 `继承`。
  - 批量层含 `清除`，不含 `恢复继承`、`留空以恢复继承`。
  - 样式里使用新的 gridTemplateColumns。
- panels.test.tsx：颜色扫描加入 `\btransparent\b`。

## 6. 并行
- W0 coder：先落地 types.ts 和 5 个纯函数、store 的签名，保证 tsc 通过（函数体可以暂时不对），这样 W1 的红灯只来自断言。
- W1a tester：负责 capacity、efforts、validate、ops、bulk、store 的测试和 regression-r2.test.ts。
- W1b tester：负责 panel.test.tsx 和 panels.test.tsx（只加 transparent）。
- W2a coder：types、capacity、efforts、validate、ops、bulk、store，以及 requirements.md 的 D7。
- W2b front_designer：components/**、styles.ts、ModelCapabilitiesPanel.tsx。
- 收尾：`npm run build && npm run verify`。

## 7. 风险
- 远端的默认键仍会被 DSH 使用，而面板显示「未设置」，这是已接受的结果。
- DS 只设 cw 时不再被拦截，运行时会自行补 mt。
- 已有的重复请求头会阻断该提供方的所有保存。
- keepView 只按 id 判断编辑层是否仍然有效。
- Tab 陷阱依赖宿主遵守 defaultPrevented。
- W2b 必须等签名落地后再跑 tsc。
