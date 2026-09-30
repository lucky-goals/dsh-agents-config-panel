# 模型能力：遗留问题记录

低级别问题先不处理，记录在这里，后续跟进。

## 原型（第 4 轮 review 列出的 low 级问题）
- 批量层格式错误沿用了 `CAP_FMT_ERR` 里的「或留空以恢复继承」。批量场景下留空会阻止应用，这句提示不准确。
- 选择「从模型复制」后其他组会被锁定，但锁定说明只写在复制组里。
- 「先选择源模型。」在组内按普通提示显示，在底栏却是错误色，两处样式不一致。
- 底栏摘要只显示 C/S/L 计数，「源没有 input，目标改为继承」这句只在应用后的结果句里出现。
- 行菜单只处理上下方向键，左右方向键不起作用。
- `.bsub` 样式定义了但没有被引用。
- 批量层或编辑层打开时，对话框取消后 findKey 会先匹配到主区里已被 inert 的按钮，焦点回不到层里。
- 批量把 `128K` 写成 `"128000"` 时，试算把它计入 C，但保存条仍显示「没有未保存的更改」。
- 源模型容量格式非法时执行复制，会删除目标模型的容量键。
- 菜单关闭后，触发按钮上仍保留 `aria-controls`，而它指向的节点已经不存在。
- 批量层和编辑层打开时，侧栏和标题栏的关闭按钮仍能用 Tab 聚焦到。

## 已接受的偏差
- DeepSeek 模型的名称只读。
- 新建模型写入 `reasoningEfforts: false`。
- 原型调试条保留「清空自定义提供方」按钮（只在原型里有）。
- 预设只有 128K/200K/272K/1M 四档，20000 没有对应芯片。

## 第 4 轮 medium 问题：实现里修，原型不回改
- 旧字段计数 L 把已经写入的模型算成「未改动」。
- 保存成功后，批量范围从「已勾选」扩大成全部模型。
修正方式见 spec B4，原型仍是修正前的行为。

## 实现审查（v2.11 / W4）遗留的 low 级问题
- 保存成功后没有清空 `sel` 和 `undo`。规格 C 要求两者和草稿一起对齐。
- 没有草稿时，`settings/document-updated` 会调用 `resetFromDescribe`，界面被重置回列表。规格要求的是静默重建，停留在原详情页。
- pi 已写入、ds 冲突时，状态行少了一句「llm-pi-ai 已写入。」。
- `styles.ts` 多处用了颜色关键字 `transparent`。扫描只检查 rgb/hex，所以没拦下来，但它违反规格 E。
- 容量字段失焦时，纯空白值没有删除对应键。写回时仍会变成 unset，但草稿里的键还在。
- `routeWrite` 上挂了一个不可枚举的 `length`，可以删掉。
- 实机冒烟没有做：GUI 需要 `dsh web` 启动时打印的带 token URL，tester 按规定没有绕过认证。需要人工在浏览器里打开设置 → 模型能力，只读检查。

## R1 修复后 captain 自查（low）
- `secretError` 的报错文案仍是「不能包含引号或等号」，但规则已经放宽，`=` 和单个引号现在都允许。文案要改成和规则一致。
- 极少见的竞态：mutate 进行中，回声之后又来了一次真实的外部写入。这时返回的 revision 与第一次回声不一致，会被判成冲突。实际上我方已经写入，只是界面提示「这次没写入」，而且 base 没有更新。数据不会损坏，点「重新加载」就能恢复。
- `headers` 里有重复的 key 时，写回后以最后一个为准，界面上没有给出提示。
- mutate 返回的错误不是冲突时，finally 会丢掉 pendingEcho。如果请求进行期间恰好收到过一次真实的外部写入，base 的 revision 就过期了，要等到下一次保存才会以冲突的形式暴露出来。
- 审查备注：R1 复审时 subagent_reviewer（claude-agent-acp）连续 3 次返回 resource_exhausted，改用通用 subagent 按只读审查员的口径完成复审，结论为 pass。

## R2 审查遗留（low）
- `bulk.ts:5`：批量时空白容量的提示文案写成「改为「不修改」「清除」」，契约里是「改为「不修改」或「清除」」。测试按现在的文案冻结了，所以两处要一起改。
- `store.ts` keepView：只有编辑下标越界时才清 `undo`。`undo.idx` 本身越界时不会清，撤销会插到错位的位置。另外 route 消失时 `dialog` 没有关掉。
- `styles.ts` 表格轨道在 560px 实测不会溢出。但容器宽度小于各列 minmax 下限之和（约 452px + 操作列）时，`scroll` 没有横向滚动，操作列仍然可能溢出。
- `efforts.ts`：`input` 为 `[]` 时 `set` 仍然是 true。结果表格摘要显示「未设置」，编辑层却显示「清除」。
- 死代码：`bulk.ts` 的 `rawPersist` 现在只剩测试在用；`ops.ts` 的 `yScalar`、`types.ts` 的 `DsEffort` 全仓库没有引用。
- `store.ts` 的 save 循环里，`inFlight.delete(ns)` 在分支前和 finally 各执行一次。行为没有影响，可以删掉一处。
- 以下 R2 之前记录的 low 已在 R2 修复，这里不再列出：原型阶段的 #1–#4、#6–#9；W4 的 sel/undo、keepView、「llm-pi-ai 已写入」、transparent、空白失焦、length；R1 自查的 secretError 文案、回声竞态、headers 重复。

## R3 遗留（low，导入导出与 Subagent 排序）
- 列表头的「导入」使用共享的 `ImportFileButton`（内部是 `ui/Button`），和同一行的「导出」「添加提供方」（本目录的 `Btn`）尺寸、圆角略有差别。要统一，就得改 `ui/` 或给 `ImportFileButton` 加样式参数，R3 的范围不允许这样做。
- 功能 2 改动了 Host，必须重启 DSH 才会生效。只 build client 不重启时，箭头按钮可以点，但旧 Host 会返回 400。
- 审查备注：R3 的两路审查首次派给 `subagent_reviewer`（ACP）时都因 Connection stalled 中断，改由通用 subagent 按只读审查员口径重新审查。
- R3F 复审遗留（low）：
  - `subagent-manager.ts` 对 flow 写法的整行 `- { id: a, … }` 处理不完整：行尾换行和行尾注释会留在空隙里。没有注释时，往返后结尾换行丢失，行间多出一个空行；带行尾注释时会被拒绝为 INVALID（拒绝正确，不会写坏文件）。UI 和 fixture 都只用块写法。修法：第一步结束后，如果 end 落在行中，并且本行剩下的只有空白或注释，就把 end 延伸到这一行的换行之后。
  - `subagent-manager.ts` 里前瞻延续的分支在所有样例和 fixture 中都没有触发过，里面还有一个潜在的 off-by-one：跳过了 continuationEnd 之后的那一行，那一行没有检查。可以删掉这个分支，或者修正后补一个能触发它的用例。
  - `subagent-manager.ts` 判断换行风格用的是 `includes('\r\n')`，LF 和 CRLF 混用的文件可能补错换行类型。补上的换行最后会被去掉，影响很小。
  - `io.ts` 里 `parseModelConfig` 的 `try { parse } catch (e) { throw e }` 多余；YAML 语法错误的提示也缺少契约 1.4 要求的前缀「YAML 解析失败：」。
  - `io.ts` 只过滤模型上的 `_stash`，提供方和 DS 顶层 extra 里的 `_stash` 会被导出。这符合契约原文，但通常不需要，可以一起过滤掉。
  - 已知限制：`computeOps` 本身不比较提供方的 extra。导入时覆盖提供方 extra，或者合并 DS 的 extra，这部分改动既不会被保存，也不算 dirty。
  - 同一个文件里同时有 `providers.deepseek`（invalid）和 `deepseek` 节时，两个预览项的 id 都是 `'deepseek'`，DS 项勾选不上。自家导出的文件不会出现这种情况。

## 实现阶段
- 不做「获取模型」（原型里用的是本地假数据）。
- 官方「模型」页的 section order 未知。本 section 用 99，排在无忧 Subagent（100）前面。
- DSH 是 0.1.7-rc.2 版本。`whileServed` 目前不可用，等 cordis 升级后再评估。
