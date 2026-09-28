# 无忧Agent 安装与使用指南

本文的命令都来自已跑通的隔离 E2E（`scripts/e2e-isolated-profile.sh`，`test/e2e/artifacts-release/run.log` 结尾为 `E2E_PASS profile=wuyou-test`），以及 `dsh --help`、`dsh plugin --profile <p> --help` 的实际输出。下文用 `DSH` 代指 dsh 可执行文件：

```bash
DSH=/Users/jwyuan/.npm/_npx/c8633a242642d858/node_modules/.bin/dsh   # 或 PATH 中的 dsh
```

## 1. 前提

| 项 | 要求 |
|---|---|
| DSH | `0.1.7-rc.2`（`$DSH --version`）。插件的 optional peer 依赖按这个版本精确声明。 |
| Node.js | 已验证 `v25.2.1`（DSH 自带的 pnpm 10.4.1 也打包了 Node v25.2.1）。`package.json` 没有声明 `engines`，更低版本未验证。 |
| 仓库路径 | `/Users/jwyuan/source_code/dsh-agents-config-panel`。安装的是指向这个目录的符号链接，见第 4 节。 |
| 浏览器 | DSH Web（`dsh web`）。面板挂在 DSH Web 的设置对话框里，TUI / headless 下不显示。 |

## 2. 构建

```bash
cd /Users/jwyuan/source_code/dsh-agents-config-panel
npm install && npm run build && npm run verify
```

- `npm run build`：`tsc` 生成 Host 产物 `lib/index.js`；`tsc` 类型检查 Client 后，由 `scripts/build-client.mjs`（esbuild）生成浏览器 bundle `lib/client.js`。该文件以 `window.__ModuleLoader__.load(` 开头，`react`、`react/jsx-runtime` 走宿主的 `require`，不打进 bundle。
- `npm run verify`（`scripts/verify-runtime-deps.mjs`）只检查构建产物：
  - `lib/` 能被导入，`apply()` 注册了三条 API 路由；
  - 能从真实 DSH 运行时解析到 `@deepseek-ai/dsh-atomic-write`；
  - 模型目录能走运行时 `resolveModelInfo`，失败时退回读取 patch；
  - 用构建出的路由对临时 fixture 副本做一次 spawn create，返回 200；
  - 模拟符号链接安装：只用插件自身位置作为锚点会解析失败，加上 profile 锚点后成功；
  - `lib/**` 的 Host 产物里没有未经 `createRequire` 绑定的裸 `require`。
- `npm pack` / `npm publish` 会先经过 `prepack`，自动执行 `build` 和 `verify`。

## 3. 安装前备份（必须做）

插件会改动 web profile 里的两个文件：

- `package.json`：`dsh plugin add` 会写入 `dependencies` 并把插件追加到 `dsh.profile.bundles`，同时更新 `pnpm-lock.yaml`。
- `cordis.patch.yml`：每次在面板里点保存，插件都会**直接改写**这个文件里的 delegation 组（Panel A）或 `agent-teams` 成员（Panel B）。改写只动目标节点，其余字节保持不变，但它改的就是你真实在用的配置。

安装前把这些文件备份到 profile 目录之外。web 目录里已有 `cordis.patch.yml.backup*`，用带时间戳的独立目录可以避免互相覆盖：

```bash
BACKUP=~/.dsh/backups/wuyou-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP"
cp -p ~/.dsh/profiles/web/cordis.patch.yml \
      ~/.dsh/profiles/web/package.json \
      ~/.dsh/profiles/web/pnpm-lock.yaml "$BACKUP"/
shasum -a 256 "$BACKUP"/* | tee "$BACKUP/SHA256SUMS"
echo "备份目录：$BACKUP"
```

恢复方法：

1. 先停掉使用 web profile 的 `dsh web` 进程，避免恢复过程中 HMR 读到一半的文件。
2. 只想撤销面板做过的配置修改：

   ```bash
   cp -p "$BACKUP/cordis.patch.yml" ~/.dsh/profiles/web/cordis.patch.yml
   ```

3. 想连插件一起撤掉：先按第 8 节卸载，再按需恢复 `cordis.patch.yml`。`package.json` 和 `pnpm-lock.yaml` 优先让 `remove` 自己改回来；只有 `remove` 失败时，再从备份复制，然后执行 `$DSH plugin --profile web install` 同步 `node_modules`。
4. 核对：`shasum -a 256 ~/.dsh/profiles/web/cordis.patch.yml` 应与 `$BACKUP/SHA256SUMS` 里对应的一行相同（SHA256SUMS 记录的是备份路径，所以不能直接用 `shasum -c`）。

## 4. 安装

```bash
$DSH plugin --profile web add -w /Users/jwyuan/source_code/dsh-agents-config-panel
```

- `dsh plugin --profile <p> <pnpm-args...>` 会把参数原样交给 DSH 自带的 pnpm 10.4.1，在 `~/.dsh/profiles/<p>` 下执行。
- **必须带 `-w`**（pnpm 的 `--workspace-root`）。profile 目录里有 `pnpm-workspace.yaml`（`packages: [.]`），profile 本身就是 workspace 根，pnpm 默认拒绝往根里加依赖（t9 实测不带 `-w` 时安装失败）。
- 路径必须是**绝对路径**。
- 装进去的是链接：`package.json` 里记录为 `"@nanmicoder/dsh-wuyou-agent": "link:/Users/jwyuan/source_code/dsh-agents-config-panel"`，`node_modules/@nanmicoder/dsh-wuyou-agent` 是指向仓库的符号链接（经 E2E `dsh plugin --profile wuyou-test add -w <仓库>` 实测确认）。这意味着：
  - 安装后**不能移动、重命名或删除仓库**，否则 DSH 启动时找不到插件；
  - 运行的是仓库里的 `lib/`，改了源码要重新 `npm run build`，再重启 DSH 才会生效；
  - 不要在 DSH 运行时执行 `rm -rf lib` 这类清理。
- 插件写入 `cordis.patch.yml` 时，**保留文件的原有权限位**（读取 `stat` 再传给 `writeFileAtomic`）。文件不存在时默认使用 `0600`。安装前备份建议使用 `cp -p` 以保留权限。
- `add` 完成后，DSH 的 plugin-manager 会检查插件的 `dsh.bundle`，把它加入 `dsh.profile.bundles`。插件只需要自带的 `cordis.patch.yml` bundle patch 就能挂载（t25 对照实验验证），不需要手动向配置文件添加任何行。

核对安装态（只读）：

```bash
node -e 'console.log(require("fs").realpathSync(process.argv[1]))' \
  ~/.dsh/profiles/web/node_modules/@nanmicoder/dsh-wuyou-agent
# 期望输出仓库路径
node -e 'console.log(require(process.argv[1]).dsh.profile.bundles)' ~/.dsh/profiles/web/package.json
# 期望包含 @nanmicoder/dsh-wuyou-agent
```

## 5. 生效

新装的插件要重启 DSH 才会加载，HMR 不会自动装入新 bundle：

1. 停掉当前的 `dsh web` 进程（终端里 Ctrl+C）。**这会中断该 profile 下正在运行的会话。**
2. 重新启动。平时用法：

   ```bash
   $DSH web            # 等同于 dsh --profile web
   ```

   E2E 使用的启动方式如下，可用于指定地址和端口、不自动打开浏览器：

   ```bash
   $DSH --profile web --host 127.0.0.1 --port <端口> --no-open
   ```

3. 用启动日志里打印的 `http://127.0.0.1:<端口>/?token=...` 链接打开页面，已打开的页面要刷新。token 链接换取登录 cookie 后，插件的 API 才能访问。
4. 打开一个工作区，点击 **Settings** 按钮，在设置对话框左侧找到：
   - **无忧Agent · Subagent**（标题「Subagent 工具管理」）
   - **无忧Agent · 团队成员**（标题「团队成员管理」）

## 6. 使用

两个面板顶部都有「刷新」按钮和提示「保存后新建会话生效」。保存成功后会显示「已保存，新建会话后生效」：配置已经写进 `cordis.patch.yml`，但已经打开的会话不会改变，要**新建会话**才能用上新配置。

每次加载都会拿到当前文件的 `revision`（内容的 SHA-256）。每次保存都会带上它，文件在这期间被别处改过时，保存会被拒绝，见第 7 节。

### Panel A：无忧Agent · Subagent

列表展示 `preset-standard-acp` → `delegation` 组里所有 `@deepseek-ai/dsh-tool-subagent` 行，列为工具名、Provider、Background Mode 和操作。只读行带「只读」标记。

- **新增**：点「新建 Subagent 工具」。
  - 工具名 `toolName` 格式为 `subagent_xxx`（`^subagent(_[a-z0-9]+)*$`），不能与已有行重复。行 id 自动生成，例如 `subagent_e2e` → `tool-subagent-e2e`，新行追加到 delegation 组末尾。
  - Provider 选 `spawn` 或 `fork`：
    - `spawn`：启动独立 agent，**必须**选择 Agent Provider 和 Model，Reasoning Effort 可选；
    - `fork`：从当前会话分叉，**不能**配置 agentOptions，表单不显示这三项。
  - Agent Provider → Model → Reasoning Effort 三级联动。选项来自 DSH 运行时的 LLM 模型目录（`llm.listProviders` / `listModels` / `resolveModelInfo`）；运行时取不到时，退回读取 `cordis.patch.yml` 中 `llm-pi-ai` 的配置，面板会提示「模型目录来自配置文件，可能不完整」。
  - Background Mode：`continuable` 或 `one-shot`。
- **编辑**：点行上的「编辑」。把 spawn 改成 fork 时，插件会删除这一行的 `agentOptions`；把 fork 改成 spawn 时，需要补全模型。**清空可选字段**：把 Reasoning Effort 清空（选空选项或清空输入），保存后该字段从 YAML 中删除；其他字段同理，详见"清空字段"一段。
- **删除**：点「删除」，在「确认删除」对话框里确认。
- **ACP 行只读**：provider 不是 `spawn`/`fork` 的行（`ccacp`、`cursoracp`、`codex`、`claude-code` 等）会标「只读」，编辑和删除按钮不可用；服务端也会用 422 `READ_ONLY` 拒绝这类写入。
- **无改动时不发请求**：打开编辑、不修改任何内容、直接点保存时，面板会直接关闭表单并提示「没有改动」，不向服务端发请求。

### Panel B：无忧Agent · 团队成员

管理 `agent-teams` 项下 `config.profiles.<团队 profile>.members`。这里的「团队 profile」是 agent-teams 内部的 profile 名（例如 `standard-acp`），和 DSH 的 profile 目录（`web`）是两回事。

- **切换团队 profile**：配置里只有一个团队 profile 时，顶部显示「团队 profile：standard-acp」；有多个时变成下拉框，默认选 `standard-acp`，没有它就选第一个。
- **新增**：点「新建成员」。成员名以小写字母开头，只能用小写字母、数字和连字符，同一团队 profile 内不能重复。角色可选；Provider 和 Model 要么都填，要么都不填，填了就必须在模型目录里存在；Reasoning Effort 可选。
- **编辑**：点「编辑」。成员上面板没有展示的其他键会原样保留。**清空可选字段**：把 Role、Provider、Model 或 Reasoning Effort 清空，保存后该字段从 YAML 中删除；Provider 和 Model 必须同时清空或同时填写，只清空一个会报错。打开编辑后不做任何更改直接保存，面板会提示「没有改动」，不发请求。
- **删除**：点「删除」并确认。**团队至少保留一个成员**：只剩一个成员时，面板直接拦截，服务端也会返回 422 `LAST_MEMBER`（「团队至少需要保留一个成员」）。

## 7. 排查

| 现象 | 原因与处理 |
|---|---|
| 顶部出现「写入依赖 @deepseek-ai/dsh-atomic-write 未加载，暂时只能查看配置」，写按钮全部变灰 | Host 按插件位置、profile 的 `package.json`、DSH 入口脚本、Cordis 所在位置依次查找 `dsh-atomic-write`，全部失败。展开警告里的「已尝试的解析位置」看具体路径。这时写请求返回 503 `DEPENDENCY_UNAVAILABLE`。处理：确认 DSH 版本是 0.1.7-rc.2，且 `@deepseek-ai/dsh-atomic-write` 在 DSH 安装目录的 `node_modules` 下；带 `NODE_DEBUG=module` 启动，搜索 `dsh-atomic-write/lib/index.js` 的 `load` 行（Cordis 会缓冲 info 日志，`wuyou-agent: dsh-atomic-write loaded via ...` 不一定出现在终端里，E2E 也改用 `NODE_DEBUG` 证据）。修好后重启 DSH。 |
| 保存时出现「配置已被其他地方修改，请刷新后重试」 | 服务端返回 409 `STALE_REVISION`：加载后 `cordis.patch.yml` 被其他地方改过，例如另一个浏览器标签页、手动编辑或 DSH 自己的配置编辑器。文件不会被改动，面板会自动重新拉取最新状态。确认列表后重新操作即可。 |
| 保存时出现「工具名 'xxx' 已存在」或「id 'xxx' 已存在」 | 服务端返回 409 `DUPLICATE`：新建 subagent 时指定的 toolName 或生成的 id，与 delegation 序列中已有的行重复（面板列表只展示 dsh-tool-subagent 行，但 id 冲突会和所有行比对）。换一个不重复的工具名即可。 |
| 保存时出现「请求不合法」类错误（400 INVALID） | 请求字段格式不符合要求。常见情况：toolName 格式不对（不匹配 `^subagent(_[a-z0-9]+)*$`）、成员名格式不对（必须以小写字母开头、只含小写字母/数字/连字符）、spawn provider 没填模型、成员 provider 和 model 只填了一个。按提示检查对应字段。 |
| 设置对话框里没有两个「无忧Agent」页面 | 1）`package.json` 的 `dsh.profile.bundles` 里要有 `@nanmicoder/dsh-wuyou-agent`（第 4 节的核对命令）；2）符号链接要指向仓库，并且仓库里有 `lib/index.js` 和 `lib/client.js`，没有就执行 `npm run build`；3）装完要重启 DSH，并用新的 token 链接刷新页面；4）`$DSH --profile web --dump-config` 只打印合成后的配置并退出，检查里面有没有 `wuyou-agent`；5）检查启动日志里有没有 `wuyou-agent:` 开头的错误；6）服务运行时执行 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<端口>/plugins/dsh-wuyou-agent/api/state`：`401` 表示路由已注册，只是未登录；`404` 表示插件没有注册路由，通常是启动的 profile 不对或插件没有加载。 |
| 面板显示「请求失败（HTTP 4xx/5xx）」 | 这通常表示插件没有激活，或者网关出错（例如 404、502、504 等非插件错误）。排查步骤：（a）确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里有 `@nanmicoder/dsh-wuyou-agent`；（b）重启 `dsh web` 后用新 token 链接刷新浏览器；（c）查看 DSH 启动日志里有没有 `wuyou-agent:` 开头的激活错误。服务端返回非 JSON 或格式异常时（如 HTML 错误页、空 body），面板统一显示这一提示，不会暴露原始英文异常。 |
| 面板显示「未找到 preset-standard-acp 的 delegation 组…」或「未找到 agent-teams 配置…」 | 当前 profile 的 `cordis.patch.yml` 没有对应结构，这时 state 仍返回 200，并把原因放在 `errors` 里。Panel B 需要已安装 `@nanmicoder/dsh-agent-teams`，并在配置里有 `- id: agent-teams`。 |
| 安装时 pnpm 报错，拒绝向 workspace 根添加依赖 | 安装命令漏了 `-w`。profile 目录是 pnpm workspace 根，请用 `$DSH plugin --profile web add -w <绝对路径>`。 |
| 安装时提示版本不兼容 | DSH 会打印 `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <ver> --accept-risk`。本插件只在 0.1.7-rc.2 上验证过，放行前先确认风险。 |
| 保存返回 413 | 请求体超过 1MB（`PAYLOAD_TOO_LARGE`），通常是角色文本过长。 |

## 8. 卸载

`dsh plugin --profile <p> --help` 的输出是 pnpm 10.4.1 的帮助：DSH 把 `add`、`remove` 等参数原样交给 pnpm。DSH 自己只处理 `allow-version`、`revoke-version`、`version-exemptions` 三个子命令，**没有 disable 子命令**。卸载使用 pnpm 的 `remove`，别名为 `rm`、`uninstall`、`un`：

```bash
# 1. 停掉 web profile 的 dsh web 进程
# 2. 卸载
$DSH plugin --profile web remove @nanmicoder/dsh-wuyou-agent
# 3. 核对：bundles 里不再有 @nanmicoder/dsh-wuyou-agent
node -e 'console.log(require(process.argv[1]).dsh.profile.bundles)' ~/.dsh/profiles/web/package.json
# 4. 重启 dsh web
```

`remove` 会删除依赖和符号链接，plugin-manager 随后把插件从 `dsh.profile.bundles` 中去掉。不会动仓库本身。

卸载**不会**撤销面板写进 `cordis.patch.yml` 的修改。这些修改是普通配置，卸载后仍然生效。需要回到安装前的状态时，按第 3 节从备份恢复 `cordis.patch.yml`。

说明：`remove` 在 web profile 上没有实际执行过，这里只核对了 `remove --help` 和 plugin-manager 的对账逻辑。若 pnpm 提示 workspace 根相关错误，同样加 `-w`。

## 9. 开发

```bash
npm test                              # vitest：Host 纯函数（真实结构脱敏 fixture）、HTTP 路由、store、React 面板、集成测试
npm run verify                        # 构建产物检查（第 2 节）
bash scripts/e2e-isolated-profile.sh  # 隔离 profile 安装 E2E
```

- E2E 只在隔离 profile `wuyou-test` 中运行。`PROFILE` 不是 `wuyou-test` 时，脚本直接拒绝执行。它不会碰 `~/.dsh/profiles/web`：开始前记录 web 的 `cordis.patch.yml` 和 `package.json` 哈希，结束时再核对，不一致就判失败。
- 脚本流程：
  1. 用 `dsh plugin --profile wuyou-test add -w <仓库>` 确保安装的是指向仓库的链接；
  2. 检查 `lib/index.js` 与仓库一致；
  3. 用 `NODE_DEBUG=module dsh --profile wuyou-test --host 127.0.0.1 --port <空闲端口> --no-open` 启动；
  4. 检查鉴权：未登录返回 401，token 换 cookie 后返回 200；
  5. 用 Playwright 打开两个设置页并截图；
  6. 依次测试 create、fork→spawn、ACP 只读 422、过期 revision 409、成员增删改，以及最后一个成员返回 422；
  7. 重启一次，确认改过的 patch 能正常加载；
  8. 恢复 `wuyou-test` 的 `cordis.patch.yml`，停止进程，确认端口已经关闭。
- 需要 `python3` 和 Playwright（`playwright.sync_api` 与 Chromium）。
- 产物在 `test/e2e/artifacts-release/`（已被 `.gitignore` 忽略）：
  - `run.log`：步骤摘要，结尾 `E2E_PASS`；
  - `wuyou-isolated*.log`：启动日志，token 已脱敏；
  - `browser-settings.png` / `browser-settings-mobile.png`：截图；
  - `file-mode.json`：文件权限验证记录；
  - `state-*.json`、`*-response.json`：请求和响应；
  - `cordis.patch.*.yml` / `cordis.patch.diff`：写入前后的 patch 与 diff；
  - `production-hashes.txt`：web profile 前后哈希。
