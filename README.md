# 无忧Agent（@nanmicoder/dsh-wuyou-agent）

无忧Agent 是一个 DSH（DeepSeek Harness）0.1.7-rc.2 插件，在 DSH Web 的设置对话框里加两个页面，用来直接编辑当前 profile 的 `cordis.patch.yml`，不用手改 YAML：

- **无忧Subagent**：管理 `preset-standard-acp` → `delegation` 组里的 `@deepseek-ai/dsh-tool-subagent` 工具行，可以新增、编辑、删除。provider 下拉的选项来自 DSH 运行时已注册的 subagent provider（spawn、fork，以及 ccacp、cursoracp 等 ACP provider）。表单显示哪些字段由 provider 的能力决定。provider 未注册的行（例如 codex、claude-code 占位行）只读。表格下方的「ACP 管理」维护 `@deepseek-ai/dsh-subagent-acp` 注册（providerName、command、args、cwd、permission、env），重启 DSH 后生效。
- **无忧Teams**：管理 `@nanmicoder/dsh-agent-teams` 中某个团队 profile 的成员，可以新增、编辑、删除，团队至少保留一个成员。每个成员占两行：第一行是成员名和角色，第二行是 Provider / Model / Reasoning Effort。角色支持多行。

两个页面都有「导出 / 导入」：无忧Subagent 的文件同时带 ACP 注册和 subagent 工具，文件名带来源 DSH profile（web、desktop、cli……），用于迁移到其他电脑或其他 profile；无忧Teams 的文件带一个团队 profile 的成员。导入先预览，已存在的配置跳过，不覆盖。

保存后配置立即写入文件，**新建会话后生效**。升级插件后要重启 `dsh web`，新的 Host 才会加载，见 [INSTALL.md 第 5 节](docs/INSTALL.md#5-生效)。

![两个设置页（本地 E2E 生成的截图）](test/e2e/artifacts-v2.1-r2/browser-settings.png)

> 截图由 `bash scripts/e2e-isolated-profile.sh` 在本地生成，存放在 `test/e2e/artifacts-v2.1-r2/`。`test/e2e/` 已被 `.gitignore` 忽略，克隆后要先跑一次 E2E 才能看到这张图。

## 快速开始

```bash
npm install && npm run build && npm run verify
dsh plugin --profile web add -w /Users/jwyuan/source_code/dsh-agents-config-panel
```

安装前请先备份 profile。安装命令必须带 `-w`，并且使用绝对路径。完整步骤、使用说明、排查和卸载见 [docs/INSTALL.md](docs/INSTALL.md)。

## 架构

```text
浏览器（DSH Web 设置对话框）                     DSH Host 进程
┌───────────────────────────────┐   同源 fetch   ┌──────────────────────────────────┐
│ React 面板 SubagentPanel /     │  credentials:  │ HTTP 路由（webServer.register）    │
│ MembersPanel                  │  same-origin   │  GET  /plugins/dsh-wuyou-agent/api/state
│   └ useSyncExternalStore      │ ─────────────▶ │  POST …/api/subagents  …/api/members
│ 框架无关 store                 │                │  鉴权：connection.requestRejection │
│  getSnapshot/subscribe/action │ ◀───────────── │  锁 + revision 比对 + 原子写入      │
│  revision 乐观锁、409 自动刷新   │  state JSON    │        │                          │
│ api-client                    │                │ 纯函数 YAML 局部编辑（只依赖 yaml） │
└───────────────────────────────┘                │  subagent-manager / members-editor │
  lib/client.js：window.__ModuleLoader__ bundle   │  catalog / patch-io                │
  注册两个 settings.section                        └──────────────────────────────────┘
                                                   lib/index.js：Cordis 插件（ESM）
```

- **Host**（`src/index.ts`、`src/host/`）：`webServer` 出现后注册三条路由，并用 `connection.requestRejection` 做鉴权。写入时，先对 profile 的 `package.json` 加文件锁，也就是 DSH 自己用的那把锁；然后比较 revision（文件内容的 SHA-256），调用纯函数完成变换，最后用 `@deepseek-ai/dsh-atomic-write` 原子写入。模型目录优先取 DSH 运行时的 LLM 注册表，取不到时退回读取 patch 中的 `llm-pi-ai`。state 里的 `diagnostics` 会报告写入依赖是否加载成功，以及模型目录来自哪里。
- **纯函数层**：基于 YAML 的 source range 做局部拼接，目标节点之外逐字节不变，保留注释、中文多行字符串和 `!!js` tag。测试用真实 `cordis.patch.yml` 的脱敏副本驱动（`test/fixtures/`）。
- **Client**（`src/client/`）：用 React 编写，`react` 和 `react/jsx-runtime` 从宿主 `require` 获取。控件自己绘制，颜色和间距只使用 `--dsw-alias-*` 变量。store 不依赖任何框架，面板通过 `useSyncExternalStore` 订阅。

接口契约、错误码和验收标准见 [docs/requirements.md](docs/requirements.md)。

## 开发

```bash
npm test                              # 单元 + 集成测试
npm run verify                        # 构建产物运行时检查
bash scripts/e2e-isolated-profile.sh  # 在隔离 profile wuyou-test 中安装 E2E，不碰 web
```

## 许可证

MIT © nanmicoder
