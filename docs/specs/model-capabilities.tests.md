# 模型能力：TDD 用例清单（Given-When-Then）

测试放在 `src/client/model-capabilities/` 下，vitest 运行环境为 node。fixture 用内联对象，不读 `~/.dsh`。

## capacity.test.ts
- parseCap：`'128K'`→128000，`'1M'`→1000000，`'272000'`→272000，`''` 或 `'  '`→undefined；`'0'`、`'01'`、`'1.5'`、`'9007199254740993'`→null。
- abbr：128000→`'128K'`，1000000→`'1M'`，272000→`'272K'`，262144→`'262144'`（abbr 只在能整除时缩写：272000 能被 1000 整除，所以缩写为 272K）。
- routeCap：pi 提供方没有写容量键时，explicit=false，eff 为 262144 / 32768。
- modelCap：模型没写 maxTokens、路由显式写了 `defaultMaxTokens='1000'` 时，mt.src=`'route'`，eff=1000。路由容量解析失败时回退到运行默认值。
- pi，窗口 1000，最大输出为继承值（32768）：capBlocks 返回 false；capWarn 的提示含「继承的最大输出」和「能力上限」。
- pi，最大输出显式写成 `'40000'`：capBlocks 返回 true；capErrors.mt 为「最大输出大于上下文窗口（40000 > 1000）。输出不能超过上下文窗口。」
- DeepSeek，两侧都继承且生效的最大输出大于窗口：capBlocks 返回 true。

## validate.test.ts
- 模型 ID：空→「填写模型 ID」；含空格→「ID 不能包含空格」；重复→「这个提供方里已有同名模型」。
- pi 的 `reasoningEfforts: {}`→「勾选至少一档，或改为不思考。」；某档线上拼写为 `''`→「线上拼写不能为空；与档名相同或写成 null。」
- providerIdError：`''`→「填写提供方 ID」；`Foo` 或 `a.`→字符集提示（含「不能含点号」）；已存在→「已有这个提供方 ID」。
- idWarn(`'A_b'`) 的提示含「小写字母」。
- apiKeyEnv 键存在但为空白→「填写密钥环境变量名。」
- secretError：`''`→`''`；`'A=b'`、`'"x"'`、含空格或非 ASCII→非空错误。

## efforts.test.ts
- effortSummary：false→「不思考」；`{}`→「未选档位」；只有 low→`low`；low+medium+high→`low–high`；low+high→`low、high`。
- inputSummary：pi 模型无 input、路由 `defaultInput=['text','image']`→`继承·文本+图片`；路由也没有→`继承·文本`；DeepSeek 读 inputModalities，不带「继承」前缀。
- deriveEnv：`my-gateway`→`MY_GATEWAY_API_KEY`；`a--b`→`A_B_API_KEY`。
- hasLegacy：只在 pi 模型带 inputModalities 时为 true。

## ops.test.ts
- value 里有 defaultContextWindow=262144、user 没有，不做编辑：computeOps 得到的 pi/ds op 为空，dirty=0。
- ds 的 user 没有 models、value.models 有 2 项，修改第一项的 inputModalities：只生成一条 `set ['models']`，值为 2 项整表。
- pi 模型的 extra 里有 imagePixelBudget，只改 name：modelWrite 结果保留 imagePixelBudget，被清除的容量键不回来。
- user 层模型有 inputModalities、value 层没有：生成的草稿里保留该数组。
- 容量填 `'nope'`：不产出容量 op，dirty=1。
- 新建 route `mine`：生成 `set ['providers','mine']`；删除：生成 `unset ['providers','mine']`。
- DeepSeek 修改 thinking：path 为 `['thinking']`，不出现 deepseek-official 或 providers。
- secrets.mine=`'k'`：cred 为 `{op:'set', ref:'MINE_API_KEY'}`；previewText 含「（值不展示）」，不含 `k` 这个值。
- previewText 的 path 行格式为 `path: [providers, mine, models]`。

## bulk.test.ts
- 没有改动任何项：「还没有要修改的项目。」，ok=false。
- 设为文本+图片，影响 2 个模型：「将修改 2 个模型。」
- 显式最大输出大于窗口：该模型计入 S，文案含「最大输出会大于上下文窗口。」
- inMode=inherit，目标模型只有 inputModalities 且没被写入：L 加 1，结果句含「只有旧字段」。**修正**：该模型如果同时改了容量或思考并进入 results，则不计入 L。
- 复制时源模型没有 input：结果句含「源没有 input，目标改为继承」；源有旧字段时另加「未复制旧字段」。复制不改 ID、名称、inputModalities；源为继承时，目标删掉对应键。
- th=set 且 thSel 为空：「勾选至少一档，或改为不思考。」
- 容量「设置为」但值为空白：「填写数值，或改为「不修改」「恢复继承」。」
- **修正**：scope=sel 时以 selSnapshot 为准，即使当前勾选已清空，targets 仍等于快照。

## place-menu.test.ts
- 下方放得下；下方不够、上方够；两边都不够且上方 ≥96 时，maxHeight=上方空间；上方 <96 时，maxHeight=安全区高度；水平越界时贴边。

## store.test.ts（fake port，返回 {ok}，不 throw）
- load 后列表数据来自 value；只在 value 里、不在 user 里的容量不产出 op。
- 改动后 save：pi mutate 收到的 revision 等于加载时的值，path 正确；成功后 revision 更新为返回值，dirty=0，saved=true。
- pi 成功、ds 返回 settings/conflict：pi 的 base 已更新，ds 的草稿保留；显示横幅「这次没写入。你的修改还在。」；不调用 credentials.set。
- settings/rejected 且 details=`'schema'`：saveError 含「配置被拒绝」和 `schema`。
- isLoopback=false，或 mode=memory，或 writable=false，或 status=unavailable：进入只读，save 不调用 mutate。
- settings 成功但 credentials.set 返回 credential/rejected：revision 已更新，密钥保留；再次 save 只重试 set。
- 删除提供方：先 `unset ['providers',id]`（带 revision），成功后再 credentials.unset。
- document-updated 事件：无草稿时重建、不显示横幅；有草稿时显示横幅、草稿保持不变；自身写入回声的 revision 不显示横幅。
- credentials/reference-updated：只更新状态点。
- 输入密钥 `'sk'`：`JSON.stringify(getSnapshot())` 不含 `sk`。
- 保存成功时，已打开的批量层被关闭。

## panel.test.tsx（SSR，固定 snapshot 的 fake store）
- 列表：模型能力、LIST_DESC、提供方名、进入、已配置/凭证缺失、「还没有自定义提供方。」、默认模型行。
- pi 详情：「提供方默认值」「批量设置」、表头 模型/输入/思考/容量；有旧字段时显示「迁移为 input」和「旧」。
- DeepSeek 详情：「官方提供方由「模型」页接入」，没有「删除提供方」；思考关闭时显示「关闭思考时只能是 off。」
- 编辑层：线上拼写、恢复继承。批量层：「只改你动过的项。未动的项保持每个模型现在的值。」
- 预览：含 `llm-pi-ai`、`path: [providers`，不含密钥。
- 冲突横幅文案；只读文案「只能在本机上修改设置。」；保存条「处无法保存」、「只读模式，不能保存。」
- 传入 close 时有「关闭」按钮，不传时没有。加载中显示「正在加载配置」。

## panels.test.tsx（注册）
- fakeCtx 增加 `inject(deps, cb)`：3 个 section 的 id/order/label 按 subagents、members、model-capabilities 的顺序排列。
- 子 fiber 的 deps 包含 slots、configForms、remote、remote.settings、remote.credentials；根 inject 仍为 `['slots']`。
- 颜色字面量扫描覆盖 `client/model-capabilities`；关闭按钮转发覆盖新面板。
