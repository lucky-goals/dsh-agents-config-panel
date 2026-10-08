# 模型能力：实现规格（v2.11）

本文只规定实现形态。交互、文案和校验以 `docs/design/model-capabilities/prototype.html`（第 4 轮）为准，下文点名的函数按原型移植。原型把 DeepSeek 写成 `config.providers.deepseek-official.*`，这是错的，实现一律以本文 B 节的 path 为准。

硬约束：不新增依赖，不引入 jsdom / Testing Library，不改 `scripts/build-client.mjs` 的 external，不改 host 路由（R4a 新增只读测试路由 `POST /models/test`，见 `r4a-model-test.md`）。Client 对 Cordis、configForms、remote 只用结构类型，这些类型写在本模块的 `types.ts` 里，不从 `@deepseek-ai/*` 引入（`import type` 也不行）。

## 0. 决策

| 方案 | 结论 |
|---|---|
| Client-only，经 `remote.settings.mutate` 写入 | 采用。host 不用重启，verify 的 9 条路由不变（R4a 后为 10 条） |
| 新增 host 路由，由 client fetch | 不采用。要改路由表，而且和官方 settings 写入通道重复 |
| 把根 `inject` 扩成 slots + remote + configForms | 不采用。settings 服务没挂载时，现有两个 section 也会停 |
| `whileServed(...)` | 不采用。cordis 4.0.4 没有这个 API |
| `configForms.get(ns).mutate` | 不采用。它只返回 boolean，拿不到 `settings/conflict` |
| 注入 `<style>` | 不采用。统一用内联 style，见 E 节 |

## A. 架构与注入

根入口保持 `export const inject = ['slots']`，`apply` 里现有的两次 `ctx.slots.inject('settings.section', …)` 不动。新 section 用子 fiber 注册：

```ts
ctx.inject(
  ['slots', 'configForms', 'remote', 'remote.settings', 'remote.credentials'],
  (sub) => { registerModelCapabilities(sub); },
);
```

- Cordis 4.0.4 的 `ctx.inject(deps, cb)` 等价于 `ctx.plugin({ inject: deps, apply: cb })`：依赖没到齐就不调用 cb，依赖变化时先卸掉再重跑。
- 带点的服务名要用括号访问：`sub['remote.settings']`、`sub['remote.credentials']`。`sub.configForms`、`sub.remote`、`sub.slots` 是普通属性。
- settings 服务消失时，只有「模型能力」被卸掉，另外两个 section 不受影响。
- `llm-pi-ai` 和 `llm-deepseek` 可以只存在一个。缺的那个 namespace 不画卡片，也不发 mutate。
- Section 定义：`{ name: 'settings.section', id: 'wuyou-model-capabilities', order: 99, label: '模型能力' }`。

## B. 数据模型与映射

### B1. 读取

读取来源是 `configForms.describe()` 的 snapshot。

| ns | 用途 |
|---|---|
| `llm-pi-ai` | 自定义提供方，path 从 `providers.<route>` 开始 |
| `llm-deepseek` | 官方提供方，配置平铺，没有 `providers` |
| `agent-default-model` | 只读一行；namespace 缺席或字段不全时不显示 |

- `value` 是解析后的值，已含 schema 默认。某个键出现在 `user` 上，才算用户覆盖。`user` 缺省按 `{}` 处理。
- 提供方级「显式」用 `Object.prototype.hasOwnProperty.call(userLayer, key)` 判断。pi-ai 的 userLayer 是 `user.providers[route]`，deepseek 的 userLayer 是该 ns 的 `user`。
- 提供方级容量（pi 的 `defaultContextWindow`/`defaultMaxTokens`，ds 的 `defaultContextWindow`/`maxTokens`）只有在 user 上出现时才放进草稿。否则按继承处理，回退到原型常量，schema 默认值不写回。
- 协议、思考开关、密钥变量名这类总要显示的字段：base 和草稿两边都放生效值。没改时 `fieldOut` 两边相等，不产出 op。
- 模型数组的来源：user 层有 `models` 就用 user 的数组（被 schema 从 value 里剥掉的 `inputModalities` 只能在这里看到）；没有就用 `value.models`。
- 模型对象上的容量、`input`、`reasoningEfforts`、`inputModalities`，只要键出现在所选的那份模型对象上就算显式。
- `extra`：模型对象和提供方对象上不属于编辑器字段的键（`compat`、模型上的 `headers`、`description`、`imagePixelBudget` 以及任何未知键）原样保留。提供方的 `headers` 是编辑字段：读取时把字典转成 `HeaderPair[]`，写回时再转回字典，key 为空的行忽略，没有有效行就 unset。`reasoningEfforts` 里的未知键排在已知档位之后，不能丢。
- 凭证：收集所有 `apiKeyEnv`（ds 缺省时用 `value.apiKeyEnv`，再缺省用 `DEEPSEEK_API_KEY`），按每批 64 个调用 `credentials.describe`。`configured` 决定状态点；`writable === false` 时密钥框禁用。
- 密钥明文只保存在 store 私有的 `secrets` 里，不进草稿、预览和 snapshot。
- DeepSeek 的 UI 路由 id 固定为 `deepseek-official`，只用于排序和 React key，任何 op path 里都不能出现它。
- 列表顺序：pi 的 `Object.keys(value.providers)` 保持原序，DeepSeek 永远排最后。
- 默认模型行：`默认模型（只读）：${provider} / ${model} · ${reasoningEffort}`，三个字段都有才显示。

### B2. 草稿与写回

草稿里的容量是十进制字符串，缩写只在展示时使用。失焦时 `parseCap` 成功就规范成 `String(n)`，失败就保留原文，纯空白则删除该键。写回时写数字。path 是字符串数组，**不带 `config.` 前缀**。

| 动作 | llm-pi-ai | llm-deepseek |
|---|---|---|
| 提供方字段 | set 或 unset `['providers', route, key]` | `['thinking']`、`['reasoningEffort']`、`['defaultContextWindow']`、`['maxTokens']` |
| 模型 | 整表 set `['providers', route, 'models']` | 整表 set `['models']` |
| 新建提供方 | set `['providers', route]`，值为完整对象 | 无 |
| 删除提供方 | unset `['providers', route]` | 无（不可删） |

- 模型整表里的每个元素：先去掉编辑器字段，再铺上 `extra`，最后铺上 `modelOut`。
- dirty 的计算单位是提供方。以下情况都计入：校验失败导致没产出 op 但确实改过、待写入的密钥、新建、删除。`capBadDirty` 只在 `modelOut` 整表相等时，按下标比较原始的 `contextWindow`/`maxTokens`。
- 预览按 namespace 列出真实 op，path 用 YAML flow 数组，例如 `path: [providers, gpt-gateway, models]`。标量和键的引号规则沿用原型的 `yScalar`/`yaml`。凭证行写作 `credentials.set  <REF>  （值不展示）`。
- 密钥变量名用官方的折叠写法：`route.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'`。ref 必须匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`。
- 密钥预检：空字符串表示不改。非空时必须匹配 `/^[\x21-\x7E]+$/`；拒绝匹配 `/^[A-Z][A-Z0-9_]*=[^=]/` 的写法，拒绝首尾是同一种引号。预检失败算字段错误，保存禁用。

### B3. 原型函数对照（照搬规则，不重新设计）

| 模块 | 原型函数 |
|---|---|
| `capacity.ts` | parseCap、abbr、canAbbr、routeCap、modelCap、capBlocks、capWarn、capErrors、capFmtBad、capOver |
| `validate.ts` | modelErrors、routeErrors、allErrors、idWarn、providerIdError、wizardErrors、modelCapBad、routeCapBad、secretError（新增） |
| `efforts.ts` | orderLevels、orderedEfforts、effortSummary、resolvedInput、inputSummary、hasLegacy、deriveEnv（改用官方折叠写法） |
| `ops.ts` | capOut、modelOut、modelWrite、fieldOut、fieldOps、capBadDirty、computeOps、yScalar、yaml、previewText、draftFromNamespaces、remoteErrorText |
| `bulk.ts` | newBulk、bulkTargets、bulkPlan、bulkSummary、bulkPhrase、bulkResultMsg、rawPersist |
| `place-menu.ts` | placeMenu 的几何：安全区内收 8px；水平方向右缘对齐按钮并夹在安全区内；垂直方向优先放下方（+4），其次上方（−4），都放不下就贴顶并限高（上方空间 ≥96 时用上方空间，否则用整段安全区高度） |

常量与原型一致：MAIN/ADV/ALL/DS 档位、三种 API、`RUNTIME_CW=262144`、`RUNTIME_MT=32768`、`DS_RUNTIME_CW=1000000`、`DS_RUNTIME_MT=256000`、四档预设、`CAP_FMT_ERR`、`CAP_FMT_ERR_ROUTE`、`SKIP`、`PI_FIELDS`、`DS_FIELDS`。pi-ai 只在最大输出为显式值时，才以「最大输出 > 窗口」阻止保存；DeepSeek 按生效值判断。

向导第 3 步不做「获取模型」。其余规则照原型：ID 正则、确认勾选、允许空模型列表、完成时写 `reasoningEfforts: false`。

### B4. 相对原型的两处修正（第 4 轮 review 的 medium 问题）

1. **旧字段计数**：只有 `rawPersist` 前后相同、且模型没有进入 `results` 时才 `L++`。被容量整份跳过的模型只计入 S。
2. **批量范围快照**：`openBulk` 时把当前已选下标存进 `BulkDraft.selSnapshot`。`bulkTargets` 在 `scope === 'sel'` 时用这份快照。已选集合变空时，不自动把 scope 改成 `all`。保存成功时如果批量层还开着，就关掉它，不应用。

## C. 保存流程

- 每个有 op 的 ns 调用一次 `mutate(ns, ops, revision)`，顺序是先 `llm-pi-ai` 后 `llm-deepseek`。revision 用该 ns 加载时拿到的值，删除操作也要带上。
- 返回值不会 throw，只有两种形态：`{ok:true, value}` 或 `{ok:false, error:{code, details}}`。
- 成功：用返回的 `value` 重建该 ns 的 base，并记下 `value.revision`。之后收到该 ns 的 `settings/document-updated` 时，如果 revision 等于记下的值，就当作自身写入的回声，忽略。
- 部分失败：已成功的 ns 保留新 base；失败的 ns 保留草稿。
- `settings/conflict`：显示横幅，文字用原型的两句。未点「保留草稿」时显示「这份配置刚刚被别处改过，这次没写入。你的修改还在。」，带「重新加载」和「保留草稿」两个按钮。点过之后改为「这份配置刚刚被别处改过。草稿还在，但解除冲突前保存会失败。」，只留「重新加载」。如果前一个 ns 已经写成功，状态行补一句「llm-pi-ai 已写入。」。冲突期间点保存直接失败，不发 mutate。
- 其他错误：`settings/rejected` 显示「配置被拒绝」，`gateway/bad-request` 显示「请求无效」。details 是字符串或 `{message}` 时，把它接在后面。其余错误码显示「保存失败（<code>）」。
- 凭证：在该 ns 的 settings 写入成功之后才处理。`set` 失败时，配置照样保留，密钥留在内存里，dirty 不清，并提示「凭证被拒绝。环境变量可能已被占用。」；再次保存时只重试凭证。删除提供方时，settings unset 成功之后再 `credentials.unset`；unset 失败提示「提供方已删除，凭证未移除。」。

外部事件：`load` 时订阅，`dispose` 时退订。

| 事件 | 无草稿 | 有草稿 |
|---|---|---|
| `settings/document-updated`（不是自身回声） | 调用 `ensure` 后静默重建，停留在原详情 | 显示冲突横幅，草稿不动 |
| `credentials/reference-updated` | 只刷新状态点 | 只刷新状态点 |
| `llm/adapters-updated`、`connection/reset` | 静默全量重载 | 显示冲突横幅 |

- 满足以下任一条件即为只读：`remote.$host.isLoopback === false`、describe 的 `status === 'unavailable'`、`view.writable === false`、目标 ns 的 `configForms.get(ns)` 处于 `mode === 'memory'`。只读时显示「只能在本机上修改设置。」，导航、预览、取消类按钮仍可用。
- 保存成功：保存条显示「已保存」，草稿与 base 对齐，清空选择和撤销记录。

## D. 模块与签名（契约，W2 不得改动）

目录：`src/client/model-capabilities/`。W0 由 coder 落地 `types.ts`（写完整）和其余所有桩：函数抛 `new Error('not implemented')`，组件返回 `null`。

完整的类型与签名以 `types.ts` 为准，由 W0 按下面的清单写入。

- **types.ts**
  - 常量：`NS_PI='llm-pi-ai'`、`NS_DS='llm-deepseek'`、`DS_ROUTE_ID='deepseek-official'`、`MAIN_EFFORTS`、`ADV_EFFORTS`、`ALL_EFFORTS`、`DS_EFFORTS`、`API_OPTS`、`RUNTIME_*`、`DS_RUNTIME_*`、`CAP_PRESETS`、`CAP_FMT_ERR`、`CAP_FMT_ERR_ROUTE`、`LIST_DESC`。
  - 类型：`Effort`、`DsEffort`、`InputModality`、`HeaderPair`、`ReasoningMap`、`ReasoningEfforts`。
  - `ModelDraft{id,name?,contextWindow?,maxTokens?,input?,inputModalities?,reasoningEfforts?,_stash?,extra}`。
  - `ProviderDraft{id,ns,api?,displayName?,baseURL?,apiKeyEnv?,defaultInput?,reasoning?,thinking?,reasoningEffort?,defaultContextWindow?,defaultMaxTokens?,maxTokens?,headers?,models,extra,credConfigured,credWritable}`。
  - `DraftState{providers}`。
  - `CapSide{key,explicit,raw,parsed,fallback,src,eff}`、`CapState{cw,mt}`。
  - `SettingsOp`（set：`{op,path,value}`，unset：`{op,path}`）、`CredOp{op,ref}`、`OpsResult{pi,ds,cred,dirty,dirtySet}`。
  - `FieldErrors`（id/contextWindow/maxTokens/efforts/apiKeyEnv/defaultContextWindow/defaultMaxTokens/`spell_${level}`）、`AllErrors`。
  - `NamespaceSlice{ns,value,user?,revision,writable,mode}`。
  - `BulkDraft{route,scope,selSnapshot:number[],inMode,inArr,th,thSel,cw,cwRaw,mt,mtRaw,copy,src}`。
  - `BulkPlan{pi,copy,touched,errs,err,targets,results,C,S,L,srcM,cw,mt}`。
  - `McView`、`WizardDraft`、`DialogState`（delete/discard/reload/wiz-cancel/save-wiz）。
  - `McUi`（view、route、edit、bulk、wizard、dialog、menuIdx、sel、showAdv、inputHint、undo、saving、saved、conflict:'hidden'|'shown'|'kept'、readonly、loading、status、previewReturn、dsPrev）。
  - `McSnapshot{draft,revision:{pi,ds},ops,errors,ui,loadError,saveError,defaultModel}`。
  - `RemoteError{code,details?}`、`RemoteResult`。
  - `ModelCapabilitiesPort`：`describe()`、`hostLoopback`、`mutate(ns,ops,rev)`、`credentials.{describe,set,unset}`、`on(event,cb)`，其中 event 为 `settings/document-updated`、`credentials/reference-updated`、`llm/adapters-updated`、`connection/reset`。
  - `ModelCapabilitiesStore`：`getSnapshot/subscribe/load/dispose/save/discard/reload/keepConflict`，以及导航、向导、模型、输入、档位、容量、接入、表头、迁移、选择、批量、行菜单、复制、移动、删除、撤销、高级档位等动作方法。方法全集见 `types.ts`。
- **纯函数**：签名见 B3 表中各函数。以下签名固定：
  - `computeOps(base, draft, secrets): OpsResult`
  - `draftFromNamespaces({pi, ds, creds}): DraftState`
  - `previewText(ops, revision): string`
  - `remoteErrorText(error): string`
  - `bulkPlan(p, b): BulkPlan`（scope=sel 时目标取 `b.selSnapshot`）
  - `placeMenu(modal, button, menu): {left, top, maxHeight?}`
  - `secretError(value): string`
- **store**：`createModelCapabilitiesStore(port): ModelCapabilitiesStore`。snapshot 不可变，每次变更返回新对象。
- **register.ts**：`registerModelCapabilities(sub)` 把 Cordis 服务包装成 port（describe 内部先 `configForms.describe().ensure()`，mode 取自 `configForms.get(ns).getSnapshot().mode`），创建 store，并注册 section。
- **组件**：`ModelCapabilitiesPanel({store, close?})`。另有 `components/` 下的 ProviderList、ProviderDetail、ModelTable、ModelEditLayer、EditAccessLayer、AddProviderWizard、BulkLayer、EffortRail（mode：multi / single / ds）、InputChips、CapacityField、PreviewPanel、SaveBar、DeleteDialog（五个对话框共用，内部使用现有 `Modal`）、RowMenu（fixed 定位，几何计算调用 placeMenu），以及 `styles.ts`（样式对象，不含颜色字面量）。组件全部受控，只调用 store 的方法。

## E. 样式

- 只用内联 style 和 `styles.ts` 里的样式对象，不注入 `<style>`，不写颜色字面量，不做滑入动画，焦点样式用浏览器默认轮廓。
- 允许的变量（都已在仓库中出现过）：`--dsw-alias-` 前缀的 label-primary、label-secondary、label-primary-foreground、bg-layer-1、bg-layer-2、border-l1、border-l2、button-primary-fill、state-error-primary、state-success-primary、state-warn-primary、brand-primary、bg-mask-1、markdown-inline-code。三级文字用 label-secondary，链接用 brand-primary。圆角直接写 px 数字。
- 禁止使用 `--dsw-radius-*`、`--dsw-focus-ring`、`--mc-*`。
- 开关的圆点用子元素实现。模型表用 `display:grid`，行用 `gridTemplateColumns:'subgrid'`。层用 `position:absolute`，底部留出 48px。对话框打开时，主区和保存条设为 `inert`。

## F. 测试计划（先红后绿）

- 纯函数测试：`capacity`、`validate`、`efforts`、`ops`、`bulk`、`place-menu` 各一个 `.test.ts`。用例与 Given-When-Then 以架构师清单为准，归档在 `docs/specs/model-capabilities.tests.md`，由 W1 tester 写成测试时逐条落地。
- store 测试：`store.test.ts`，fake port 写在测试文件内，mutate/set/unset 返回 `{ok}`，不 throw。
- SSR 测试：`panel.test.tsx`，对一个固定 snapshot 的 fake store 做 `renderToString`。
- 注册测试：修改 `src/client/panels.test.tsx`，内容包括：三个 section；子 fiber 的 deps；根 `inject` 仍为 `['slots']`；颜色字面量扫描覆盖 `client/model-capabilities`。
- 可选：`test/model-capabilities-view.test.ts`，基于真实结构的 fixture。
- 不写 profile，也不启动 DSH。

## G. 波次

| 波 | 角色 | 允许修改 | 验收 |
|---|---|---|---|
| W0 | coder | `model-capabilities/**` 的非测试文件（types 完整，其余为桩） | `npx tsc -p tsconfig.client.json --noEmit`；现有 `panels.test.tsx` 仍通过 |
| W1a | tester | 纯函数与 store 的 `*.test.ts` | 新测试为红 |
| W1b | tester | `panel.test.tsx`、`src/client/panels.test.tsx`（只改注册 describe 和颜色扫描） | 新断言为红 |
| W2a | coder | capacity/validate/efforts/ops/bulk/place-menu/store `.ts`、`docs/requirements.md` | W1a 转绿，tsc 通过 |
| W2b | front_designer | `components/**`、`ModelCapabilitiesPanel.tsx`、`styles.ts`、`register.ts`、`src/client/index.tsx` | W1b 转绿，tsc 通过 |
| W3 | tester | 只运行 | `npx vitest run`、tsc、`npm run build && npm run verify` 全部通过 |
| W4 | reviewer | 只读 | 对照本规格和原型 |

## H. 实机验收

仓库已 link 到当前 GUI 使用的 profile。`npm run build` 之后，HMR 会加载新的 `lib/client.js`，host 未改动，无需重启。实机验收只读：可以查看列表、详情、编辑层和预览，**不要点「保存」「完成添加」「删除提供方」**。需要测试写入时，使用隔离 profile。禁止为测试修改 `~/.dsh/profiles/web`。

## I. 风险与遗留

- 不做「获取模型」。
- `deriveEnv` 按官方写法折叠：`a--b` 得到 `A_B_API_KEY`。
- 删除时带 revision，且先删配置、后删凭证，与官方页的顺序相反，这是有意的。
- 继承容量的展示值使用运行时常量。
- `inputModalities` 从 user 层读取。
- 两个 llm namespace 只装了一个时，section 仍然出现。
- 子 fiber 拿不到 slots 时，新菜单不会出现，旧菜单不受影响。
- 原型遗留的 low 级问题见 `docs/specs/model-capabilities.followups.md`。
