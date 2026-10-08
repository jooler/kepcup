# agent-spike：外部编码 Agent 的 ACP 探测脚本（P0）

用 `@agentclientprotocol/sdk`（`ClientSideConnection`，ACP v1）驱动外部 Agent，对每个 Agent 跑同一组探测，输出带原始 JSON-RPC 往返的 JSON 报告。
对应 `todo/acp-external-agents.md` §3.1 / §3.2 与设计 `docs/design/28-external-agents-acp.md` §9.2。**不进产品代码**；P1 的 Provider 契约测试 / testkit fixture 由它演化。

- Node >= 22（用 Node 24 跑：`export PATH=/home/jyy/.nvm/versions/node/v24.13.0/bin:$PATH`）
- 依赖只有 core 已有的 `@agentclientprotocol/sdk`；npx 类 Agent 由 `npx -y` 临时拉取，binary 类从 ACP Registry 下载（sha256 校验）
- 目录：`spike.mjs`（入口）、`agents.mjs`（Agent 配置表）、`fake-agent.mjs`（假 Agent，自测 / 预留 testkit）、`lib/`

## 用法

```bash
cd packages/core/scripts/agent-spike
node spike.mjs --agent <id> [--home <dir>] [--cwd <dir>] \
  [--steps initialize,auth,session,prompt,steer,cancel,permission,mcp,modes,complete,native] \
  [--out report.json] [--work-dir <dir>]
```

`--agent`：`claude | codex | opencode | dsh | cursor | antigravity | zcode | fake`。`node spike.mjs --help` 看全部选项。要点：

| 选项 | 说明 |
|---|---|
| `--work-dir` | 工作根，默认 `$TMPDIR/kepcup-spike/<agent>/`，内含 `home/`（Agent 进程的独立 HOME，**登录态保存在这里**）、`cwd/`、`outside/`（越界读写用例的目标）、`bin/`（binary 解压） |
| `--home` / `--cwd` | 覆盖 HOME / session 工作目录 |
| `--command <cmd>` + `--args=<v>`（可重复）或 `-- <args...>` | 用已安装的可执行文件覆盖启动命令，如 `--command /snap/bin/opencode -- acp`；`fake` 的 `--command` 预留给 testkit |
| `--env K=V` / `--pass-env K` | 注入 / 透传环境变量（API key 用 `--pass-env`，值自动脱敏）。Agent 进程**只**继承 PATH / 代理 / 证书 / 语言等白名单变量，HOME 指向独立目录，不读用户真实配置与凭据 |
| `--permission allow_once\|reject_once\|cancel` | 客户端对 `request_permission` 的自动应答；默认 `permission` 步 reject_once，其余步 allow_once（从不选 allow_always） |
| `--runs N` | `complete` / `native` 的次数，默认 5；**正式验收：complete 20、native 10** |
| `--isolate` / `--session-meta '<json>'` | 往 `session/new._meta` 加「不读用户 / 项目配置」预设（目前只有 claude：`settingSources: []`）/ 任意 JSON |
| `--warm` | `initialize` 后再启动一次，记 `warmStartMs`（冷启动 = 首次 spawn→initialize 响应，含 npx 下载） |
| `--auth-method <id>` | `auth` 步真正执行该认证（见下） |
| `--allow-large` | 允许下载 cursor（~0.5–1 GB）/ antigravity（~1 GB）；默认拒绝 |
| `--timeout <sec>` | 每步超时；默认 initialize 300、其余 90–240。结束 / 异常 / Ctrl-C 都会 kill 进程树；每步结束即落盘，部分报告可用 |

### 步骤

| step | 记录 |
|---|---|
| `initialize` | 冷 / 热启动耗时、进程树 RSS、initialize 原文（`agentCapabilities` / `authMethods` / `_meta` / `promptCapabilities` / `mcpCapabilities` / `sessionCapabilities`） |
| `auth` | 各 authMethod 的分类（terminal / agent）与终端调用命令（`type:'terminal'` → agent 调用 + `args`；仅有 `_meta['terminal-auth']` → 取其 command/args，且与已装 binary 同名时换成实际路径）。不带 `--auth-method` 时**只分析不执行** |
| `session` | `session/new` 结果或错误（`code` / `message` / `data`，auth_required 分类）、modes / configOptions |
| `prompt` | 一次 prompt 的完整 `session/update` 序列（`rpc` 里是原始往返，`sequence` 是行程压缩）与 PromptResponse、首包时延 |
| `steer` | `_session/steering` + `_meta.steering.idleBehavior:'promptRequired'`（运行中注入 / 空闲时回 `promptRequired`）；不支持时探测「忙时再发 prompt」 |
| `cancel` | `session/cancel` → prompt 返回的时延、stopReason、取消后更新、同会话能否继续 |
| `permission` | 读 / 写工作目录外、写目录内、执行命令、plan 模式退出（有 `plan` 模式时）的 `request_permission` 完整负载与 **optionId 白名单** |
| `mcp` | 脚本内起 127.0.0.1 Streamable HTTP MCP（`echo` 工具 + `Authorization: Bearer`）；记 Agent 调用的 MCP 方法、是否带头、Agent 看到的工具名、是否对 MCP 工具发 `request_permission` |
| `modes` | 全部模式（逐个 `session/set_mode`）与 configOptions / 模型选项 → Provider 档位映射 |
| `complete` | 一次性精简会话「只输出 JSON」跑 N 次：成功率、严格仅 JSON 比例、p50 / p95 |
| `native` | 原生优先：同时给原生工具与注入的 `web_search`（描述带「[补充能力]」前缀 + 提示词 `<tool_policy>`），统计选原生的比例（目标 ≥ 0.9；启发式分类，须人工复核 `results[].allTools`） |
| `adherence`（P6，可选，不在默认列表） | 原生优先遵守度回归：用**产品真实措辞**（`fixtures/native-first-wording.json`，由 core 单测 `native-first-wording.test.ts` 按产品代码生成，措辞一改单测即失败、`KEPCUP_UPDATE_WORDING=1` 重新生成）按产品方式下发（meta-append → `_meta.systemPrompt.append`；prompt-prefix → prompt 前置段），注入同名补位工具，分 `web` / `vision`（Agent 声明支持图片时）两个用例统计选原生的比例（目标 ≥ 0.9） |
| `resume`（可选，不在默认列表） | 重启进程后 `session/resume` / `session/load` 行为、重放更新特征、是否记得上文 |

客户端实现：对所有未处理的 Agent→客户端请求立即回 `-32601`（fs / terminal / 扩展方法；见下「SDK 坑」）；不声明 fs / terminal 能力；`clientInfo = {name:'KepCup-spike', version:'0'}`；声明 `clientCapabilities.auth.terminal = true` 与 `_meta['terminal-auth'] = true`。报告末尾 `agentInitiated` 汇总 Agent 主动发来的请求 / 通知方法（可发现 `cursor/ask_question` 之类扩展）。

脱敏：字段名像 token / key / secret / authorization 的字符串值、已知密钥字面量、`sk-…` / `Bearer …` / JWT 形态一律 `***`。交回前仍建议 `grep -nE 'sk-|Bearer [A-Za-z0-9]{8}|eyJ' report.json` 复核。

### 自测

```bash
node spike.mjs --agent fake --work-dir /tmp/spike-fake --steps initialize,auth,session,prompt,steer,cancel,permission,mcp,modes,complete,native,resume --runs 3
```

### 原生优先遵守度（P6，`adherence.mjs`）

登录后（与下文同一 `--work-dir`，默认 `$TMPDIR/kepcup-spike/<agent>`）对本期全部 Agent 跑 `adherence` step 并汇总：

```bash
node adherence.mjs --runs 10                       # 默认 claude,codex,opencode,dsh,cursor,antigravity
node adherence.mjs --agents dsh --runs 10 -- --pass-env DEEPSEEK_API_KEY
node adherence.mjs --agents fake --runs 2          # 自测（假 Agent，无需登录）
```

输出目录里有每个 Agent 的报告（`adherence-<agent>.json`）与 `adherence-summary.md`（可直接贴进设计 28 §9.2「原生优先遵守度」）。未达标的 Agent：在其 Provider 里加强点名措辞，或把对应补位包的默认值改为不注入；分类是启发式，请人工复核 `results[].allTools`。

## 需要用户登录后再跑的步骤

离线（未登录）只能覆盖 `initialize`、`auth`（分析）、`session`（部分 Agent）。其余全部要登录态，并且**用同一个 `--work-dir`（同一 HOME）**。顺序：先登录，再 `--steps session,prompt,steer,cancel,permission,mcp,modes,complete,native,resume`。

登录命令以 `initialize.authMethods` 为准，脚本会代跑（交互式，需要在真终端里执行；无 TTY 时用 `--auth-stdio pipe` 验证「管道子进程能否完成 terminal 认证」，这本身是 P0 检查项）：

| Agent | 登录（`--steps auth --auth-method <id>`） | 离线现象（2026-10-07） |
|---|---|---|
| claude | `claude-ai-login`（订阅）或 `console-login`（Console）。等价命令：`npx -y @agentclientprotocol/claude-agent-acp@0.86.0 --cli auth login --claudeai`（`--console`）；两者均 `type:'terminal'`，`args` 追加在 agent 调用后；另带 `_meta['terminal-auth']`（绝对路径形式）。条款门禁见设计 §9.3：只走官方登录、不碰凭据 | `session/new` 成功；`session/prompt` 才报 `-32000 Authentication required` |
| codex | `chat-gpt`（`authenticate`，由 Agent 自行拉起浏览器）或 `api-key`（`--pass-env OPENAI_API_KEY --auth-method api-key`）。两者都不是 terminal 类 | `session/new` 即 `-32000 Authentication required` |
| opencode | `opencode-login` → `<binary> auth login`（authMethod 没有 `type`，只有 `_meta['terminal-auth']`，且 command 是裸名 `opencode`）。**不要在其中登录 Claude 订阅** | `session/new` 成功；自带 `opencode/*-free` 匿名模型，未登录也能 prompt——脚本离线不发 prompt |
| dsh | 无登录流程：`--pass-env DEEPSEEK_API_KEY` | `session/new` 成功；`prompt` 报 `-32603`，message 含 `no API key for provider route "deepseek-official"`（不是 -32000） |
| cursor | 需 `--allow-large` 下载。`cursor_login`（`cursor-agent login`）或 `--pass-env CURSOR_API_KEY` | 见 todo 附录 A.2：`-32000 Authentication required` |
| antigravity | 需 `--allow-large`。**只用** `gemini-api-key` / `agent-platform`；脚本拒绝执行 `oauth-personal`。注意工作区信任 `AGY_ACP_DISABLE_WORKSPACE_TRUST`、全局 `~/.gemini/config/mcp_config.json` 合并（独立 HOME 下为空，真实场景需另验） | 见 todo 附录 A.2 |
| zcode | 无 ACP，脚本只检测桌面应用是否安装（`steps.detect`）。登录用其内置 CLI `zcode login`；垫片联调另议 | — |

登录后要补测的 todo §3.1 / §3.2 项（脚本已覆盖的步骤名）：认证（`auth`，含无 TTY）、`session/new` + http MCP（`mcp`）、`prompt` 完整序列、`steer`、`cancel`、`resume`、`permission`（optionId 白名单）、`modes`、`complete`、`native`。**脚本未覆盖、需手工验证**：Electron `ELECTRON_RUN_AS_NODE=1` 能否跑 JS 入口（用 `--command <electron> --env ELECTRON_RUN_AS_NODE=1 -- <npm pack 解出的入口.js>`）、沙箱可读范围 / 拒读 `~/.kepcup`、Agent 自动加载的配置 / 指令文件及关闭方式、三平台各跑一次、各 Agent 专项（§3.2：`_meta.systemPrompt`、`CODEX_CONFIG`、`OPENCODE_CONFIG_CONTENT` 等，用 `--session-meta` / `--env` 配合）。

## 如何交回报告

1. 每个 Agent 跑完得到一个 JSON（`--out`，默认 `./spike-<agent>-<时间>.json`；`steps.<name>.rpc` 是原始 JSON-RPC，`data` 是摘要）。
2. 用上面的 grep 复核无敏感值；`complete` / `native` 默认只存摘要，需要原始往返加 `--trace-all`。
3. 把文件放到仓库外的共享位置并告知路径（或放进 `docs/dev/` 下约定目录由会话整理）；终端输出里的 `report -> <path>` 就是路径。会话据此填 todo 附录 A、修订设计 28 §9.2，或记 `DEVIATIONS.md`。
4. 同时附一句：平台（报告里有 `host`）、Agent 版本（`agentInfo`）、登录方式（订阅 / key）、是否改动过 `--permission`。

## SDK 坑（P1 实现必读）

`ClientSideConnection`（旧 API）对 Client 上**未实现**的 `fs/*`、`terminal/*` 方法**静默回 `result: null`**，不是 `-32601`。要「未处理请求立即 -32601」必须在 Client 上显式实现这些方法并 `throw RequestError.methodNotFound(method)`（本脚本 `lib/client.mjs` 已这样做，扩展方法同理）。
