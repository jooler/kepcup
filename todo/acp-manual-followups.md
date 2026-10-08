# D72 外部智能体（ACP）— 需人工处理事项

> 来源：D72 P0–P6 开发、各轮独立审查与安全审查（2026-10-07 ～ 10-08）。代码侧已全部完成并合入 main；本文件只列**必须由人完成或决定**的事项。实现细节见 `todo/acp-external-agents.md`、`docs/design/28-external-agents-acp.md`、`docs/dev/DEVIATIONS.md`。
>
> 约束重申：KepCup 不读取、不保存、不中转任何订阅凭据；以下所有「登录实测」都只能由用户本人在官方登录流程中完成。

## 1. 发行与合规决策

- [ ] **发行门禁**：`apps/desktop/agent-release-gates.json` 当前 `approved: []`——发行版不含任何外部 Agent。逐个决定是否放开：
  - Claude Agent（Anthropic 订阅第三方使用条款为灰色地带；开发期按启用处理）
  - Codex、OpenCode、DeepSeek Harness、Cursor、Antigravity（仅 API key 登录；个人 / 企业 Google OAuth 已在代码中禁用）
  - 放开 OpenCode 前请看 §3 的残留风险
- [ ] **品牌图标授权**：`claude-acp.svg`、`codex-acp.svg` 需确认品牌使用许可后再放入 `apps/desktop/resources/agents/`
- [ ] **ZCode 已放弃**（DEV-008）：app-server 需宿主推送账号配置并按请求提供鉴权头，接入必须中转凭据；edit 模式不分工作区内外、用户级放行无法关闭、无 OS 沙箱。若 ZCode 将来提供 ACP / 独立登录，再重新评估

## 2. 协调者代为决定的默认值（请确认或改动）

均已写入设计 28 §8 与 todo §9.3.1「待用户确认的默认」。

- [ ] **后台任务只路由到能关闭原生工具的 Agent**：目前只有 Claude（`tools: []`）。Codex / Cursor / DeepSeek Harness / Antigravity 未验证能完全禁用原生工具；OpenCode 理论上可用 `"*":"deny"` + 只放行宿主桥，但该配置是进程级的，需要单独的「干净后台进程」（未做）
- [ ] 开启「加载我的个人配置」的 Agent 不参与后台任务
- [ ] 后台「自动」只使用该 Bot 自己的 Agent，**不跨厂商回退**；全局用户画像整理、群聊摘要等无归属 Bot 的工作只有显式选定后台 Agent 时才走外部 Agent（且不计入任何 Bot 预算——考虑是否要全局上限）
- [ ] 群聊判断（triage）走 Agent 时默认「仅 @ 响应」；关闭后：60 s 超时、每（Bot, 群）2 分钟节流、计入日预算
- [ ] Agent 并发 < 2 不参与后台；后台作业为对话保留一个槽位；后台 run 上限 10 分钟
- [ ] 反思 / 摘要在仅有外部 Agent 时每 5 次 run 跑一次；技能生成默认关；续接 L2 保持关闭
- [ ] OpenCode 用户配置扫描（fail-closed）：`~/.opencode` / 全局配置中出现非 ask/deny 的权限、`tools: {x: true}`、自定义工具代码、非 YAML frontmatter（`---js` 等）、`{file:}` / `{env:}` 替换、TOML、无法解析的文件 → 拒绝启动并在设置卡列出文件与键。可能误伤合法配置
- [ ] 模型 / effort 设置调用超时（30 s）现在使 run 失败（以前只警告）
- [ ] 应用重启后外部 Agent 会话不复用（已见消息记录只在内存），首条消息发送完整上下文。若要重启后复用需给 `agent_sessions` 加列（迁移号需与 D73 协调）

## 3. 已知残留风险（记录未拦截，发行门禁决策依据）

- [ ] **OpenCode**：
  - 用户配置中的 `mcp.<x>`（local command）、`formatter.<x>.command`、`lsp.<x>.command` 会在无宿主裁决下执行用户自配命令（拒绝会影响真实 MCP 用户，故只记录）——是否改为拒绝？
  - console 组织远程配置、`auth.json` wellknown 远程配置（读取需碰凭据文件）、管理员 `/etc/opencode` 均在我方配置之后合并，无法扫描
  - 用户层在同一 agent 对象中把 `"*"` 放在 `edit` 之后 → plan / explore 的 edit 由 deny 变 ask（仍由宿主裁决）
  - OpenCode 运行中热加载配置时，本 run 内不重扫（下次开会话会扫）
  - 用户自己的 slash command 模板可含 `` !`shell` ``；KepCup 已保证自身提示词不以 `/` 开头，用户本人触发不拦截
- [ ] **Codex / Cursor 只读档**会不经确认读取整盘（设计 28 §6 已列为让渡项）
- [ ] **撤回功能**落地时需接入「外部 Agent 会话失效」（目前 core 无撤回入口）
- [ ] 删除对话时若 run 正在建 / 恢复会话，迟到的会话只关闭不 `session/delete`（Agent 侧磁盘历史尽力而为；删除确认框已说明）

## 4. 真机 / 登录实测（只能用户本人登录）

- [ ] **P0 spike 登录态跑通**：Claude Agent、Codex、OpenCode、DeepSeek Harness、Cursor、Antigravity（`packages/core/scripts/agent-spike/`）
- [ ] **原生优先遵守度回归**：登录后 `node packages/core/scripts/agent-spike/adherence.mjs --runs 10`（DeepSeek Harness 加 `-- --pass-env DEEPSEEK_API_KEY`），结果贴进设计 28 §9.2；不达标的 Agent 在 Provider 中加强措辞或把对应补位包默认改为不注入
- [ ] **DeepSeek Harness**：node-pty `spawn-helper` chmod 后置步骤需 macOS 真机验证；Linux 预编译是否同样需要；koffi 是否另有安装步骤
- [ ] **Cursor**：`CURSOR_CONFIG_DIR` 指向私有目录后登录态是否保留
- [ ] **Claude**：`_session/steering` 的 injected 时序；`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` / `CLAUDE_CODE_DISABLE_CRON` 是否生效；`session/resume` 带 `_meta` 后行为；usage 口径；`deleteSession` 是否删除磁盘 transcript；后台 `tools: []` 是否保留宿主 MCP 桥工具
- [ ] **Codex**：steering injected 与 `startedNewTurn` 后取消的效果；resume 后 `mcp_servers`（新 token）是否重连；`lastTokenUsage` 口径；长耗时桥工具转后台后模型是否等待 follow-up
- [ ] **同进程并行会话**（`features.parallelSessions`）：对每个 Agent 在同一进程的两个会话上同时发 prompt，确认互不干扰；代码按适配器源码实证取值（见 `todo/acp-external-agents.md` §8.5），未实证者 `agent:{id}` 并发钳为 1、不参与后台任务——实测通过后可放开
- [ ] **各 Agent**：follow-up 措辞是否被正确理解；45 s 桥工具转后台阈值是否合适（Claude 可设 null）；全选能力包时的工具数上限
- [ ] **人工跨平台验收**（macOS / Windows / Linux × 全部 Agent）：启用、登录、单聊、能力包注入、project 内改代码 + 回退、越界审批、steering、群聊混合引擎、委派、后台任务

## 5. 测试环境备注

- 本机 glibc 2.35 无法运行 es-git，单元 / 集成测试在 Docker 镜像 `kepcup-test:trixie` 中跑，**只用** `node scripts/run-tests.mjs run`（容器内 `pnpm test` / `pnpm install` 会重装并破坏 worktree 的 node_modules）；e2e 用派生镜像 `kepcup-test:trixie-xvfb`
- 基线 33 个环境性失败（es-git / 沙箱自检 / wiki URL 等）；偶发负载超时：`memory.test.ts`「两个 Bot 同时产生画像提案」、`agents-service.test.ts`「agent-type login」（单跑均通过）
- e2e 全量 65 例中 3 例失败（`browser.spec` 删 Bot 后分区目录、`sandbox.spec` 状态行、`wiki.spec` 页面浏览）——在 main 上同样失败（同一断言行），与 D72 无关，需另行排查；`external-agents.spec` 4/4 通过

## 6. 后续设计衔接

- [ ] **D75（设计 30）已修订 D72**：对话轮固定内置引擎，外部 Agent 改为**任务**引擎；`features.parallelSessions`、无内置模型用户两级降级等。实现 D75 时需改造本期的 `runtime.agent` 语义、后台路由（llm-router）与会话复用——D72 代码按「Bot 引擎」语义交付
- [ ] **D75 并行任务与会话复用冲突**（设计 30 §8.5）：D72 的 `agent_sessions` 唯一键 `(bot, conv, agent)` 只适合串行 run（D72 本身由邮箱保证串行，无冲突）；D75 T5 需把键加上 `task_id`、`continues_task_id` 改为继承旧任务会话行，估 +0.5–1 周
- [ ] main 迁移号：D72 未新增迁移（沿用 0017）；0018–0020 仍为 D73 预留；D75 的 `agent_sessions` 迁移号需协调
