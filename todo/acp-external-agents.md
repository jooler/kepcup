# 外部智能体引擎（ACP）— 执行方案（D72）

> 状态：**P1–P6 已实现（2026-10-08）**；剩余为需要真实账号的人工项（P0 登录后 spike、原生优先遵守度真机运行、三平台人工验收，见 §9.1 / §9.3）。（2026-10-07 调研完成，设计见 `docs/design/28-external-agents-acp.md`。）分 P0→P6 七个阶段；**P0 是门禁**（技术验证 + 合规确认），不通过不进入 P1。本文是给编码 Agent 的**自包含交接**：不依赖本 chat 历史即可开工。
>
> **硬约束**：只改本地工作树；**不要** `git commit` / `push` / 开 PR（除非用户另行明确要求）。内置 pi 引擎的行为与测试**零回归**。
>
> **修订记录**：
> - v2：对照代码与适配器源码的审查修订（Claude `settingSources` 安全、进程级指令配置、steering 必须 `promptRequired`、run 外输出、租约改显式、数据目录优先级与无人值守底线、桥事件与 errorCode、会话级 token、用量字段语义、ACP-only 后台 loop 时序）。
> - v4（本版）：用户决定——Claude Agent 开发期按启用处理、全部功能走通，发行前再定是否随发行版发布（`releaseGate`）；ZCode 评估不能完整覆盖即放弃；本期加入 Cursor、Google Antigravity（ACP Registry 已收录，原生 ACP）；注入能力分「宿主语义类（宿主优先）/ 补位类（原生优先）」，经工具描述前缀与 `<tool_policy>` 让外部 Agent 优先使用自带工具。
> - v3：按用户四项要求重构——① 设置页智能体目录（兼容 ACP Registry 条目格式）；② Bot 在「模型 / 智能体」间选择；③ 宿主能力按能力包可选注入；④ Provider 架构便于持续新增 Agent。本期 Agent：Claude Agent、Codex、OpenCode、DeepSeek Harness；ZCode（无 ACP）以垫片接入、以 P0 评估为前提。术语统一为「Agent / 智能体」，键前缀 `agent:{id}`。

## 0. 先读什么（按顺序）

1. `docs/design/28-external-agents-acp.md` — 产品契约（目录、Bot 选择、能力包、Provider 架构、隔离让渡、适配矩阵、条款）
2. `docs/design/09-tech-stack.md`「Agent loop：pi」+ `docs/dev/02-architecture.md`「AgentEngine」+ `docs/dev/04-agent-runtime.md`
3. `docs/design/13-permissions.md`、`10-sandbox.md` — 被让渡的隔离语义
4. `docs/design/23-mcp-and-subagent.md`（D65 MCP 客户端现状；本方案新增**服务端**桥）、`25-capability-tools.md`（能力补位工具）
5. `docs/design/18-inline-setup.md` — 结构化 setup 失败与对话内设置卡（新增 `agent` kind）
6. 外部资料（实现时打开；版本为 2026-10-07 调研时的值，开工时以目录锁定值为准）：
   - ACP 规范 https://agentclientprotocol.com/protocol/overview ；SDK `@agentclientprotocol/sdk@1.7.0`（`schema/schema.json` 是权威字段表；`ClientSideConnection`、`ndJsonStream`、`AgentSideConnection`）
   - ACP Registry `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`（`version: 1.0.0`；条目字段 `id/name/version/description/repository/website/authors/license/icon/distribution{npx|binary|uvx}`；binary 按平台给 `archive/cmd/args/sha256`）
   - Claude：`@agentclientprotocol/claude-agent-acp@0.86.0` 的 `dist/acp-agent.js`：`initialize`（authMethods、`_meta.steering`）、`createSession`（`_meta.systemPrompt`、`_meta.claudeCode.options`：`tools`/`disallowedTools`/`settingSources`/`maxTurns`/`sandbox`/`allowDangerouslySkipPermissions`）、`_session/steering` 的 `idleBehavior`（~2290–2310）、`AUTONOMOUS_RESULT_ORIGINS`（~227）
   - Codex：`@agentclientprotocol/codex-acp@2.1.1`：README Runtime options；`CODEX_CONFIG` 只在进程启动读一次（`dist/index.js:40302`）；cwd 一律 `trust_level:"trusted"`（:34203）
   - OpenCode：`github.com/anomalyco/opencode` tag `v1.18.35` 的 `packages/opencode/src/acp/`；文档 opencode.ai/docs/{acp,providers,config,rules}；环境变量 `OPENCODE_CONFIG_CONTENT` / `OPENCODE_PERMISSION` / `OPENCODE_DISABLE_CLAUDE_CODE*`
   - DeepSeek Harness：`github.com/deepseek-ai/deepseek-harness` 的 `packages/acp/acp/README.md`；npm `@deepseek-ai/dsh`（0.2.0-rc.2）、`@deepseek-ai/dsh-acp`；`dsh --profile acp`
   - Cursor：Registry `cursor`（2026.10.01，`cursor-agent acp`）；文档 https://cursor.com/docs/cli/acp 、`/docs/cli/reference/authentication`、`/docs/cli/reference/permissions`、`/docs/agent/security/run-modes`、`/docs/models-and-pricing`
   - Google Antigravity：Registry `antigravity-acp`（1.3.0，`agy_acp_server`）；文档 https://antigravity.google/docs/{rules,plans,faq} ；条款 https://antigravity.google/terms （第 6 条）
   - ZCode：`github.com/zai-org/ZCode`（v3.14.x，Apache-2.0）；`zcode app-server` / `agent-server`（ZCode Protocol，stdio）、`packages/client`（客户端 SDK）、`zcode login`
7. 代码锚点（实现时打开）：
   - `packages/core/src/agent/types.ts` — `AgentEngine`（:124）、`RunSpec`（:69）、`RunHandle`（:110，`steer` 同步返回 boolean）、`EngineEvent`（:46）、`ToolDefinition` / `ToolContext.terminate`（:80–108）、`RunIdentity`（:17）
   - `packages/core/src/agent/pi-engine.ts` — `startRun`（:49）、工具包装（截断 / 图片判定 / errorCode，:96–105 一带）、事件（:238–263）、`#settle` / `finalText`（:319、:401）、`complete()`（:182）
   - `packages/core/src/agent/structured.ts` — `completeStructured`
   - `packages/core/src/agent/context/system-prompt.ts`（`buildSystemPrompt` :132）、`context/conversation.ts`（:100/:135/:146）、`context/continuation.ts`（:63）；`project/context.ts:152`（`<project>` 注入 AGENTS.md / CLAUDE.md）
   - `packages/core/src/dispatch/orchestrator.ts` — `#startResponseRun`（:1516）、`#modelRefForBot`（:1548）、`#executeResponseRun`（:1563；`engine.startRun` 在 :1809 **硬编码 `this.#deps.engine`**）、单条用户消息拼装（:1833）、`buildResponseTools` 调用（:1843）、续接 L2（:1632、:2110–2230）、SETUP_REQUIRED（:1975）、用量（:2011）、`#deliverInterimTexts`（:2345）、`#steerRunningRun`（:2389）、`#settleRun`（:2411）、`recoverInterrupted`（:1214）
   - `packages/core/src/dispatch/dispatcher.ts`（`lightModelRefForBot` :121、`triageOneBot` :137）；`scheduler/scheduler.ts`（`concurrencyFor` :42）
   - `packages/core/src/tools/index.ts` — `buildResponseTools`（:182，返回 :834）；各能力工具工厂：`memory-tools.ts`、`wiki-tools.ts`、`schedule-tools.ts`、`browser.ts`、`image-tools.ts`（`generate_image` / `understand_image`）、`speech-tools.ts`（`generate_speech` / `generate_video` / `transcribe_audio`）、`web-tools.ts`、`skill-tools.ts`、`delegation-tools.ts`、`butler-tools.ts`、`media-source.ts`
   - `packages/core/src/gateway/index.ts`（`checkPath` :226、`ensurePathAccess` :360、写租约 :375、`protectRules` :285–296、`mcpToolCall` :650、`audit` :686）；`project/service.ts`（`ensureWriteLease` 快照 :181、`releaseRun` :209）；`infra/paths.ts:94`（workspace 在 `~/.kepcup` 内）
   - `packages/core/src/permissions/approvals.ts` — `#autoDecideSync`（:239–258 数据目录底线）、`request` / `submitNonBlocking` / `describe` / `renderContextLine`
   - `packages/core/src/mcp/service.ts` / `mcp/tools.ts`（MCP 客户端，结果包裹规则）
   - `packages/core/src/env/` — 环境管理器（按需安装 + 审批；Node 运行时条目）
   - 后台 LLM 调用点：`memory/reflection.ts:257`、`memory/consolidation.ts`、`memory/loop-utils.ts:7`、`agent/loops/conversation-summary.ts:73`、`wiki/maintenance.ts:103/258`、`skills/authoring.ts:114/335`
   - `packages/shared/src/domain/types.ts` — `botRuntimeSchema`（:39）、`settingsSchema`（:292）、`providerConcurrencySchema`（:171）、run schema（:521–635）、`approvalKindSchema`；`shared/src/domain/vendors.ts`（「描述层」先例）
   - desktop：`features/bot-panel/BotProfileForm.svelte`（主模型选择器 :146–160、MCP 勾选 :174–193 是能力包 UI 的样板）、`features/settings/`（`SettingsDialog.svelte`、`McpSection.svelte`、`EnvironmentSection.svelte`）、`features/onboarding/OnboardingWizard.svelte`、`features/approvals/ApprovalCard.svelte`、`features/chats/RunStatusLine.svelte`
   - 迁移：main 现有到 `0016_butler_and_delegation.sql` → **`0017_external_agents.sql`**；runs 现有到 `0004` → **`0005_run_engine.sql`**（号以目录实况为准；迁移只有前进）

## 1. 背景与目标

- **问题**：大量用户只有 Claude / ChatGPT / Copilot / GLM Coding Plan 等订阅，没有通用 API key，无法驱动内置 pi loop。
- **用户要求（本期必须满足）**：
  1. 设置中像 ACP Registry 那样浏览并启用 Agent；
  2. Bot 可指定 Agent（与现在选模型同一位置）；
  3. Bot 用外部 Agent 时，用户选择注入哪些 KepCup 能力（能力补位工具等）；
  4. 本期支持 Claude Code（Claude Agent）、Codex、OpenCode、DeepSeek Harness、Cursor、Google Antigravity，ZCode 视 P0 评估（不能完整覆盖则放弃），代码结构便于后续不断新增 Agent；
  5. 注入的能力若 Agent 自带，须让 Agent 明白优先使用自带（非注入）工具；
  6. Claude Agent 开发期按启用处理、全部功能走通，是否随发行版发布另行决定。
- **调研结论（2026-10-07）**：
  - ACP v1 稳定（`PROTOCOL_VERSION=1`），Registry 目前 41 个 Agent，条目格式可直接复用。
  - Claude（适配器）、Codex（适配器）、OpenCode（原生 `opencode acp`）、DeepSeek Harness（原生 `dsh --profile acp`，automation-only、preview）、Cursor（原生 `cursor-agent acp`）、Google Antigravity（原生 `agy_acp_server`）支持 ACP；Antigravity 条款禁止第三方软件用个人 Google 账号登录 → 只开放 API key / Vertex / Enterprise；**ZCode 不支持 ACP**，只有私有 `zcode app-server`（ZCode Protocol）——需进程内垫片，P0 评估可行性。
  - Registry 里的 `glm-acp-agent` 是个人项目，与 ZCode 无关，不纳入本期。
  - 必须让渡：外部 Agent 原生文件 / 命令工具不经 KepCup 沙箱；OpenCode 无 OS 沙箱 → 命令逐条确认。
  - 条款：OpenAI 最宽松；Anthropic 灰区（P0 合规门禁）；OpenCode 中禁止登录 Claude 订阅；Google 本期不做。

**复用**：`AgentEngine` 接缝；mailbox / scheduler / run_steps / usage / settle；`buildResponseTools` + `ToolGateway`；`ApprovalsService`；环境管理器；D58 setup 失败与设置卡；D56 续接；`structured.ts`；`vendors.ts` 的描述层做法。

**不做（整篇）**：提取 / 中转订阅 token；修改或打包厂商二进制；原生工具走 KepCup 沙箱；运行时同步 ACP Registry、`uvx`、Gemini 等未适配 Agent；流式输出 / 思考展示 / plan / diff 面板；外部 Agent 的 durable 与 `delegate_task`；ACP 不稳定特性；KepCup 作为 ACP Agent；git commit / push / PR。

## 2. 实施顺序

```
P0 验证与门禁（6 个 ACP Agent 的 spike + ZCode 协议评估 + 合规清单）
 → P1 地基：数据模型 + 目录 + Provider 架构 + ExternalAgentEngine 最小闭环（fake agent，开发开关）
 → P2 能力注入：宿主 MCP 桥 + 能力包 + ACP 版提示词；Claude / Codex Provider
 → P3 权限与隔离：权限桥 + agent_tool 审批 + 档位映射 + 显式租约
 → P4 用户入口：安装器（npx / binary / system）+ 登录 + 设置页目录 + Bot 选择器与能力包 UI + 对话内设置卡 + onboarding + 后台兜底
 → P5 供应商扩展与体验：OpenCode、DeepSeek Harness、Cursor、Antigravity、ZCode 垫片（门禁，不能覆盖即放弃）；steering、会话复用、用量、并发、崩溃
 → P6 无 API key 的后台 loop + 回归 / e2e / 跨平台验收
```

P1/P2 期间外部 Agent 只允许 `read_only` 档，且只在开发开关下可见；P3 完成前不对用户开放可写档位。P4 的 UI 可与 P2/P3 并行。

---

## 3. P0 — 验证与门禁

### 3.1 通用 spike 脚本（`packages/core/scripts/agent-spike/`，不进产品代码）

用 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 写一个**参数化**脚本，对每个 Agent 跑同一组探测，输出 JSON 报告（P1 的 Provider 契约测试由此演化）：

- [ ] 启动：命令行、环境变量、冷启动耗时、内存；Electron 自带 Node（`ELECTRON_RUN_AS_NODE=1`）能否运行 JS 入口
- [ ] `initialize`：`agentCapabilities`、`authMethods`、`_meta.steering`、`promptCapabilities`、`mcpCapabilities`、`sessionCapabilities` 原文
- [ ] 认证：terminal 方法在**无 TTY 的管道子进程**里能否完成；不能则定 UI 方案（内嵌伪终端 / 系统终端 / 复制命令）
- [ ] `session/new`：注入一个 http MCP server（带 Authorization 头），记录工具可见名与往返；该 Agent 对 MCP 工具是否也发 `request_permission`
- [ ] `session/prompt`：完整 `session/update` 序列（文本、工具、`tool_call_update`、`plan`、`usage_update`）与 `PromptResponse`（`stopReason`、`usage`）→ 存为 testkit fixture 素材
- [ ] steering（`_session/steering` + `idleBehavior:'promptRequired'`）、`session/cancel` 时延、`resume` / `load` 行为、`load` 重放的更新特征
- [ ] `request_permission`：触发「工作目录外读 / 写」「执行命令」「模式切换」，记录全部 optionId → Provider 的 optionId 白名单
- [ ] 模式 / config options：列出全部模式与模型选项 → Provider 的档位映射表
- [ ] 原生能力清单：该 Agent 自带哪些与能力包重叠的工具（联网搜索 / 抓取、看图、图像生成、浏览器…）及其工具名 → Provider 的 `nativeCapabilities` 映射
- [ ] 原生优先遵守度：同时提供原生工具与带「[补充能力]」前缀 + `<tool_policy>` 的注入工具，各跑 10 次需要联网 / 看图的任务，统计 Agent 选择原生工具的比例（目标 ≥ 9/10），不达标调整措辞
- [ ] 沙箱：是否有 OS 沙箱、默认可读范围、能否拒读 `~/.kepcup`（保留 workspace / 技能目录）
- [ ] Agent 侧会自动加载的配置 / 指令文件（全局与 project）及关闭方式
- [ ] `complete()` 方案：一次性精简会话只输出 JSON 的成功率与时延（各 20 次）
- [ ] 三平台各跑一次（Windows 下无沙箱 Agent 的实际行为）

### 3.2 逐 Agent 专项

- [ ] **Claude**：`_meta.systemPrompt={append}`、`settingSources:[]`、`allowDangerouslySkipPermissions:false`、原生 `sandbox` 的 `denyRead`/`denyWrite` 表达力、能否关闭后台任务（自主 turn）、与 KepCup 自带 srt 同机共存
- [ ] **Codex**：指令走 prompt 前置段（`CODEX_CONFIG` 进程级，已定论）；`CODEX_CONFIG` 只放审批 / 沙箱；project `.codex/` 与 `AGENTS.md` 加载行为 → 确认弹框条件
- [ ] **OpenCode**：`opencode acp` 二进制分发与 sha256；`opencode auth login` 的 terminal 认证；`OPENCODE_CONFIG_CONTENT` 能否按进程关掉 CLAUDE.md 回退、`OPENCODE_PERMISSION` 能否强制 bash 询问 / 拒绝 `~/.kepcup`；会话忙时再发 prompt 的行为（排队 / 报错）；无 OS 沙箱确认
- [ ] **DeepSeek Harness**：`dsh --profile acp`（锁 `@deepseek-ai/dsh` 精确版本）；`DEEPSEEK_API_KEY` 注入；沙箱与权限请求形态；无 `session/load`、每会话单 prompt 的影响；preview 版本稳定性
- [ ] **Cursor**：`agent login` 的 terminal 认证与 `CURSOR_API_KEY`；未登录时 `session/new` 返回 `-32000`；ACP 模式下 Landlock / Seatbelt 沙箱与 `cli.json` 权限规则是否生效（决定 `features.osSandbox`）；扩展请求 `cursor/ask_question` / `cursor/create_plan` 的负载与可接受的应答（决定 Provider 的 `extRequests`：ask_question 是否映射为对话内问题卡、create_plan 是否自动确认）；客户端不应答权限请求会卡住——验证宿主的超时与兜底；能否经 `.cursor/cli.json` 以外的途径关闭项目规则加载；steering 与会话忙时 prompt 的行为；三平台
- [ ] **Antigravity**：`gemini-api-key` / `agent-platform` 两种认证（`oauth-personal` 必须在 Provider 中过滤，验证 UI 与 `authenticate` 都无法触发它）；`initialize.clientInfo` 如实填 KepCup；工作区信任与 `AGY_ACP_DISABLE_WORKSPACE_TRUST`；全局 `~/.gemini/config/mcp_config.json` 合并的影响；个人 / key 方式无沙箱 → 命令逐条确认；安装体积（Linux 约 1 GB）与 Windows 可用性；Linux 下 `--uid=` 参数（以 root 运行时不降权）对普通用户无影响的确认；steering
- [ ] **ZCode（门禁项）**：读 `zcode app-server` / `packages/client` 的协议定义，评估：消息模型能否映射到 ACP（prompt / 流式更新 / 工具调用 / 权限请求 / cancel / MCP 注入 / 自定义指令）、协议版本化与兼容承诺、二进制分发与 `zcode login`。结论只有两种：「能完整覆盖（附垫片工作量估计）」或「放弃支持」——任一必需项不能覆盖即放弃

### 3.3 合规门禁

- [ ] 条款原文截取 + 链接 + 日期：Anthropic（Agent SDK 概述、法务与合规页、support 15036540）、OpenAI（Codex、Sign in with ChatGPT）、OpenCode（及其登录的各家订阅）、智谱（GLM Coding Plan 第三方工具使用范围）、DeepSeek
- [ ] Claude Agent：**不阻塞开发**（已决定开发期按启用处理）；条款材料整理好，留待发行前由产品决定是否放行 `releaseGate`、是否联系 Anthropic
- [ ] Cursor：文档鼓励自建 ACP 客户端、ToS 未禁止——记录原文即可
- [ ] Antigravity：条款第 6 条禁止第三方软件经 Antigravity OAuth 访问（可封 Antigravity 与 Gemini CLI 账号）→ 已定只开放 API key / Vertex / Enterprise；Enterprise（`oauth-business`）是否受同条约束需确认，不明确则也过滤；加 `releaseGate`
- [ ] 品牌：Claude 对外名称「Claude Agent」；各 Agent 名称 / 图标使用遵循其许可

### 3.4 验收

- 5 个 Agent 的 spike 报告（附在本文末或 `docs/dev/`）；与设计 28 §9.2 矩阵的出入直接修订设计或记 `DEVIATIONS.md`
- ZCode 结论明确（覆盖 / 放弃）；合规清单书面化（不阻塞开发，供发行决策）

---

## 4. P1 — 地基：数据模型 + 目录 + Provider 架构 + 最小闭环

### 4.1 改动清单

- [x] **shared `domain/agent-catalog.ts`**：`AgentCatalogEntry` 类型（设计 28 §2.1，ACP Registry 同构字段 + `provider` / `transport` / `tier` / `nativeCapabilities`（能力 → 原生工具名）/ `auth` / `terms` / `releaseGate`）与 `AGENT_CATALOG` 常量（P1 只放 testkit 的 fake agent 条目，开发开关下可见；真实 Agent 条目在 P2 / P5 加入）；`scripts/import-acp-registry.mjs`：从 Registry JSON 导出指定 id 的条目骨架（扩展字段人工补）；Registry 未给 sha256 的 binary 条目（Cursor、Antigravity 即如此）由脚本下载各平台归档、计算并写入 sha256 锁定
- [x] **发行门禁**：打包脚本（`apps/desktop/scripts/dist.mjs`）读取放行清单，发行构建剔除 `releaseGate` 未放行的目录条目；开发构建与测试不受影响（Claude Agent 开发期默认可启用）
- [x] **shared `domain/host-capabilities.ts`**：`HOST_CAPABILITIES` 能力包登记表（设计 28 §4.1：id、**类别 `host` | `supplement`**、工具名列表、默认、`overlapsNative` 键、前置配置描述、i18n key）；`defaultCapabilities(entry)` 纯函数；`NEVER_INJECTED_TOOLS`
- [x] **shared `botRuntimeSchema`**：增 `agent: z.object({ id: z.string().default(''), model: z.string().default(''), effort: z.string().default(''), permission: z.enum(['read_only','workspace','ask']).default('workspace'), capabilities: z.array(z.string()).nullable().default(null) }).prefault({})`（Profile JSON，无迁移；`id=''` = 内置引擎）
- [x] **shared `settingsSchema`**：增 `agents: Record<agentId, { enabled, installedVersion?, source: 'managed'|'system', loadUserConfig=false }>`、`customAgents: []`（预留，本期 UI 不开放）、`experimental.externalAgents: boolean`（默认 false）、`backgroundAgentId?: string`（P6 用）。并发不另设字段，用 `providerConcurrency['agent:{id}']`（`types.ts:171` catchall）
- [x] **shared constants**：`AGENT_RUN_TIMEOUT_MS`、`AGENT_IDLE_SHUTDOWN_MS`（35 分钟，≥ `CONTINUATION_WINDOW_MS`）、`AGENT_INIT_TIMEOUT_MS`、`AGENT_DEFAULT_CONCURRENCY`（2）
- [x] **runs 迁移 `0005_run_engine.sql`**：`runs.engine TEXT NOT NULL DEFAULT 'builtin'`、`runs.agent_session_id TEXT NULL`
- [x] **core `agent/types.ts`**：`RunSpec` 增可选 `workdir`、`promptParts`（会话级 / run 级 / 增量对话）、`external`（agentId、权限档位、能力集合、会话键）、`onSteerRejected(text)`；`PiEngine` 忽略（零回归）；同步 `docs/dev/02-architecture.md` 接口块
- [x] **core `agent/external/providers/`**：`AgentProvider` 接口（设计 28 §10，含 `authMethods` 过滤与 `extRequests` 扩展请求处理）、`generic-acp.ts`（只用 ACP 标准 + 已核对扩展；`prompt-prefix`；`toolName = mcp__{server}__{tool}` 可覆盖）、`index.ts` 的 `PROVIDERS` 登记表（`provider` 字段 → 模块）
- [x] **core `agent/external/host.ts` `AgentHost`**：每个 Agent 一个子进程 + 连接；懒启动、`initialize` 缓存、空闲退出、退出时活跃 run 以 `failed` 结算；stderr 进日志（经 `secrets.redact`）；环境变量**白名单**（不透传 KepCup 进程环境）
- [x] **core `agent/external/acp/client.ts`**：宿主侧 ACP `Client` 实现：`sessionUpdate` → 分发到会话的当前 run（无 run → 丢弃 + 日志）；`requestPermission` P1 **默认拒绝**（`reject_once`，`mcp__kepcup__*` 除外；P3 换成权限桥）；`readTextFile` / `writeTextFile` / `terminal/*` 不声明能力；**任何未处理的 Agent→客户端请求**（未知扩展方法、未声明能力的方法）立即返回「不支持」错误，不得悬挂；`initialize.clientInfo` 如实填 KepCup 名称与版本
- [x] **core `agent/external/engine.ts` `ExternalAgentEngine implements AgentEngine`**：`startRun` = `session/new`（cwd = `spec.workdir`；P1 每 run 新会话）→ Provider `applyPermissionTier` + `set_config_option`（model / thought_level）→ `session/prompt`；事件映射与 `PiEngine` **逐字段对齐**（`assistant` 带 `stopReason`、`toolCallId` 配对）；`abort` → `session/cancel`；`steer` P1 返回 `false`；`tokensSoFar` 返回 0；`stopReason` → `RunOutcome`；`complete()` P1 抛 `NOT_SUPPORTED`
- [x] **core 引擎选择**：`#executeResponseRun` 用 `engineFor(bot)`；`#modelRefForBot` 对外部 Agent Bot 返回伪 ref `agent:{id}/{model||default}`，使 `#providerForRef` 与调度器键落到 `agent:{id}`；写 `runs.engine` / `provider` / `model`
- [x] **模型门禁（D58）**：按 Bot 引擎判定：内置 Bot 看内置模型；外部 Agent Bot 看该 Agent 已启用（P4 细化为状态检查）
- [x] **开发开关**：`experimental.externalAgents=false` 时 RPC 拒绝把 Bot 设为外部 Agent；P1 期间能力集合为空、档位强制 `read_only`
- [x] **testkit `fake-acp-agent`**：基于 SDK `AgentSideConnection` 的剧本化假 Agent（剧本发 `session/update`、发起 `request_permission`、模拟 steering / cancel / 崩溃 / `auth_required` / 自主 turn / `load` 重放），以目录条目形式注册（`provider:'generic-acp'`）
- [x] **Provider 契约测试**（`packages/core/test/contract/agent-provider.contract.ts`）：一组与 Provider 无关的用例（启动、initialize、会话、prompt、事件映射、cancel、权限默认拒绝、MCP 往返〔P2〕、run 外更新丢弃），每个 Provider 以 fake agent 剧本 + 真实 Agent（P0 spike 脚本，手动 / 夜间跑）两种方式执行

### 4.2 验收

- 单测：事件映射（文本→工具→文本→结束；只有文本；取消；refusal；进程崩溃；run 外更新）与 `PiEngine` 事件字段对齐；中间说明（D54）切分正确
- 集成：开发开关开启，fake agent 的 Bot 单聊一问一答落消息、落 `run_steps`、`runs.engine='agent:fake'`
- **扩展性验证**：新增第二个 fake 条目（仅改目录数据）即可被选用并通过契约测试，core 其他代码零改动
- 内置引擎全量测试不变

### 4.3 实施记录（P1，2026-10-07）

**状态**：§4.1 全部完成，§4.2 验收满足（见下「测试」）。未 commit。

**改动文件**
- shared：新 `domain/agent-catalog.ts`（zod 版 `agentCatalogEntrySchema` / `AgentCatalogEntry`、`AGENT_CATALOG`〔仅 `fake`，`provider:'generic-acp'`、`releaseGate:'testkit'`〕、`agentModelRef` / `parseAgentModelRef` / `agentEngineKey`、`filterReleasedAgents`、`agentPermissionTierSchema`）；新 `domain/host-capabilities.ts`（`HOST_CAPABILITIES` 15 包含类别 / 工具 / 前缀 / 管家专属工具 / 默认策略 / `overlapsNative` / 前置配置 / i18n key、`defaultCapabilities`、`NEVER_INJECTED_TOOLS`、`nativeCapabilityKeySchema`）；`domain/types.ts`（`botRuntimeSchema.agent`、`BUILTIN_AGENT_RUNTIME`、`settingsSchema.agents/customAgents/experimental/backgroundAgentId`、`runSchema.engine/agentSessionId`）；`constants.ts`（`AGENT_RUN_TIMEOUT_MS`、`AGENT_IDLE_SHUTDOWN_MS`、`AGENT_INIT_TIMEOUT_MS`、`AGENT_CANCEL_GRACE_MS`、`AGENT_DEFAULT_CONCURRENCY`）；`errors.ts`（`NOT_SUPPORTED`、`AGENT_UNAVAILABLE`、`AGENT_AUTH_REQUIRED`、`AGENT_INCOMPATIBLE`、`AGENT_PROCESS_EXITED`、`AGENT_FAILED`）；`rpc/methods.ts`（`settings.update` 增 `agents` / `experimental` / `backgroundAgentId`）；`index.ts` 导出。
- core：新 `agent/external/{types,catalog,host,engine}.ts`、`acp/client.ts`、`providers/{index,generic-acp}.ts`；`agent/types.ts`（`RunSpec` 可选字段 + `ExternalRunSpec`）；`dispatch/orchestrator.ts`（`#engineFor`、伪 ref、按引擎的模型门禁、`runs.engine`、外部 run 的 `workdir/external`、P1 不建工具）；`domain/runs.ts`（`engine` / `agent_session_id` 读写）；`rpc/bindings.ts`（`bots.create/update` 实验开关门禁、`experimental` 部分 patch 合并）；`start.ts`（装配 `AgentHost` + `ExternalAgentEngine`、`services.agents`、关闭时 `dispose`、测试缝 `agentCatalog` / `agentLaunch` / `agentSpawn`）；`domain/bots.ts`（占位 Profile 带 `agent`）；`build-constants.d.ts`；`migrations/runs/0005_run_engine.sql`。
- testkit：新 `src/fake-acp-agent.ts`（剧本 / 构建器 `agentTurn()`、进程内 `startFakeAcpAgent`、子进程 `runFakeAcpAgentStdio`、JSONL 观测记录）、`src/fake-acp-launch.ts`（`fakeAcpAgentLaunch` / `fakeAgentSpawner` / `fakeAgentEntry`）、`bin/fake-acp-agent.mjs`；`fixtures.ts` / `helpers.ts` 透传测试缝、`botProfile` 带 `agent`；`package.json` 增 `@agentclientprotocol/sdk@1.7.0`（`pnpm-lock.yaml` 同步）。
- 脚本 / 打包：新 `scripts/import-acp-registry.mjs`（`--registry <url|file>`、`--hash` 流式下载算 sha256；未带 `--hash` 且缺 sha256 时报出并非零退出；已用本地 registry + 本地 HTTP 归档离线验证）；`apps/desktop/scripts/dist.mjs` 读新 `apps/desktop/agent-release-gates.json`（`{"approved": []}`）经 esbuild define 注入 `__KEPCUP_AGENT_RELEASE_GATES__` 并校验已替换；`eslint.config.js` 登记该全局。
- desktop：`features/bot-setup.ts` 的空 Profile 带 `agent`（类型要求，无 UI 改动）。
- 测试：新 `shared/test/unit/agent-catalog.test.ts`、`core/test/unit/external-agent-engine.test.ts`、`core/test/contract/{agent-provider.contract.ts,agent-providers.test.ts}`、`core/test/integration/external-agent.test.ts`；`integration/create-core.test.ts` 的 runs 库版本断言 4 → 5。
- 文档：`docs/dev/02-architecture.md`（RunSpec / RunHandle 接口块、ExternalAgentEngine 段）、`docs/dev/03-data-model.md`（settings 新键、`runtime.agent`、`runs.parent_run_id/engine/agent_session_id`）。

**偏差与理由**
- `AgentProvider` 等接口放在 `agent/external/types.ts`（而非 `providers/index.ts`），避免 `providers/index.ts` ↔ `generic-acp.ts` 循环引用；ACP 类型经 `acp/client.ts` 再导出，SDK 仍只在 `acp/` 与 testkit 引用。
- 发行门禁不改写 shared 产物，而是 dist.mjs 注入放行清单、core `effectiveAgentCatalog()` 运行时过滤（与 `__KEPCUP_TEST_HOOKS__` 同一模式；未注入 = 开发 / 测试不过滤；发行构建 fail-closed，未声明 gate 的条目也不收录）。条目数据仍随 shared 产物分发（设计「代码保留」）。
- P1 没有安装器：`AgentHost` 的启动解析只认 `system` 来源（PATH 查找），其余由测试缝注入；`fake` 条目的 `system.cmd` 是占位名。
- `HOST_CAPABILITIES` 默认策略统一为「默认注入 − 原生覆盖」（设计表中 browser / speech 等标「注入」、web 等标「原生无则注入」，与 D72 第 3 条「该 Agent 不具备的能力全部注入」合并为同一规则）；`nativeCapabilities` 声明空数组视为不具备。
- 新增常量 `AGENT_CANCEL_GRACE_MS`（取消后等 Agent 回 `cancelled` 的上限，防止卡住 mailbox）与 6 个错误码（含 `NOT_SUPPORTED`）。
- `RunSpec.external` 额外带 `effort` 与 `onSession`（回填 `runs.agent_session_id`）。
- P1 未提供 `promptParts` 的调用方（orchestrator 尚未拆分 ACP 版提示词，P2）由引擎以 `buildSystemPrompt()` + 消息拼成首个 prompt；此时提示词仍是内置版 `<platform_rules>`（提到的宿主工具外部 Agent 尚不可用）。
- 实验开关只拦「把 Bot 改成另一个外部 Agent」；开关关闭后已用 Agent 的 Bot 仍可编辑其他字段，其 run 以可读原因失败。
- 运行门禁失败（未开实验开关 / 不在目录 / 未启用）P1 只写 `run.error` 文案，结构化 setup `{kind:'agent'}` 留给 P4。

**未完成 / 留给后续阶段**
- 契约测试「MCP 往返」为 `it.todo`（P2）；真实 Agent 的契约执行依赖 P0 spike 脚本（本阶段未跑真机）。
- 调度器 `agent:{id}` 缺省并发仍是 `providerConcurrency.default`（`AGENT_DEFAULT_CONCURRENCY` 已定义，接入在 P5）。
- 用量（`PromptResponse.usage` 做差）、steering、会话复用、`load` 重放静音、子代理调用不切分均按计划在 P5；fake agent 已能模拟 steering 扩展与 `load` 重放。
- 群聊中外部 Agent Bot 的 triage / 续接 L2 仍走内置轻量模型（无内置模型时的兜底在 P4）。

**测试**（容器内；命令见下）
- `run.sh node scripts/run-tests.mjs run packages/core/test/contract packages/core/test/unit/external-agent-engine.test.ts packages/core/test/integration/external-agent.test.ts packages/shared/test/unit/agent-catalog.test.ts`：全部通过（契约 28 + 4 todo；单测 18 + 10；集成 5）。
- 全量（`run.sh node scripts/run-tests.mjs run`，613 s）：128 个文件 / 1028 用例，33 失败（8 个文件）——与基线失败清单逐条一致（全部是容器内沙箱 / bwrap 环境原因），无新增失败；989 通过、2 skipped、4 todo（契约 MCP 往返 ×4）。1 个 unhandled rejection 来自基线失败的 `projects.test.ts`（`lease.waiting` 等待超时）。
- `pnpm -r typecheck`：0 错误（svelte-check 1 条既有 warning）。`pnpm lint`：本任务文件 0 问题；仅剩并行会话新增、未纳入本任务的 `packages/core/scripts/agent-spike/` 的 5 个错误。

#### 审查修复（第 2 轮，REQUEST CHANGES → 已处理）

- **[M1] 准备期到达的消息丢失**：`dispatch/orchestrator.ts` 注册 run 时消费 `#pendingSteers`，`steer()` 返回 false 的批次放回缓冲，随 mailbox release 作为新 run 重投（内置引擎行为不变：pi 的 steer 在注册时恒为 true）。集成测试「run 准备期间发消息」（用阻塞的 embedder 把 run 卡在记忆检索）。
- **[M2] 默认拒绝可被绕过**：`acp/client.ts` `decidePermission` 只看结构化 `toolCall.name`（不看自由文本 `title`），且仅当会话挂了宿主桥（`SessionSink.bridgeAttached` / `AcpSessionRouter.bridgeAttached`，P1 恒 false，P2 在 `session/new` 带桥时置 true）才可能放行 `mcp__kepcup__*`。单测 + 契约（title / name 伪装均被拒）。
- **[M3] 关停时序**：`host.ts` dispose 后进程退出不再通知 sink；`engine.ts` `#settle` 在 `host.disposed` 时不结算（数据库已关；重启由 `recoverInterrupted` 标 interrupted，与 pi 一致）。单测。
- **[M4] settings 过严**：`customAgents` 存储形态改 `z.array(z.unknown())`；`agents` / `experimental` / `backgroundAgentId` 与 `botRuntime.agent` 各字段对未知值 `.catch` 容错（损坏值回落默认，不让整行解析失败）；RPC 入参另用严格的 `agentSettingInputSchema`，键用 `agentIdSchema`，binding 经存储 schema 补默认。单测。
- **[M5] 错误分类**：新 `agent/external/errors.ts`（`AgentErrorKind` / `AgentErrorPhase` / `toAgentError` / `classifierFor`）；`AgentProvider.classifyError?(err, phase)`，generic 默认 -32000→auth_required；engine 按阶段（initialize / session_new / prompt / other）分类；spawn ENOENT/EACCES → `AGENT_UNAVAILABLE`。消费 `_auth/status_update` 扩展通知，`AgentHost.authStatus(agentId)` 暴露最近状态（P4 状态机用）。单测 + 契约。
- **[M6] Windows 启动**：`findOnPath` 在 Windows 只按 PATHEXT 顺序查找（不命中 npm 的 sh shim）；`prepareSpawn` 把 `.cmd/.bat` 经 `cmd.exe /d /s /c` 运行、参数按 cross-spawn 规则转义（npm shim 双重转义），`windowsVerbatimArguments`。模拟 win32 的单测。
- **Minor**：
  - 异常结束（崩溃 / 超时 / cancel grace / 进程退出）在结算前用 `AcpEventMapper.abandon()` 为未配对的 tool_call 补失败结果；
  - abort 落在档位 / 配置调用期间不再发 `request` 步、不发 prompt；
  - `runs.engine` 在 `RunsService.create` 时写入，所有结算路径（开工前取消、Bot 不活跃、门禁失败）都带；
  - `bots.create` 拒绝 `interview:true` + 外部 Agent；
  - 发行门禁改 **fail-closed**：发行构建只收录 `releaseGate` 在放行清单中的条目，未声明 gate 的同样不收录（并有单测要求每个策展条目声明 gate）；
  - stderr 残行上限 `AGENT_STDERR_TAIL_MAX_CHARS`（4 KB），进程退出时 flush；
  - 环境白名单补 `SSL_CERT_FILE` / `SSL_CERT_DIR` / `NODE_EXTRA_CA_CERTS` / `DBUS_SESSION_BUS_ADDRESS` / `DISPLAY` / `WAYLAND_DISPLAY`；
  - 杀进程：POSIX 子进程 `detached` 成为进程组长，`process.kill(-pid)` SIGTERM，`AGENT_KILL_GRACE_MS`（5 s）后 SIGKILL；Windows `taskkill /T /F`（单测验证 SIGTERM 被忽略时升级为 SIGKILL 且孙进程被清理）；
  - `dist.mjs` external 增 `@agentclientprotocol/sdk`（与 pi-* 同为 core 依赖，经 electron-builder 收集 core 生产依赖树进 asar 的 node_modules；本轮未实际跑打包）；
  - 测试补强：-32601 覆盖 `fs/write_text_file`、全部 `terminal/*`、`_vendor/x`、`vendor/*`，并断言没有回 `result:null`；grace 测试断言 `session/cancel` 已发出，另测 Agent 正常回 cancelled 时 grace 定时器被清除；「run 外更新丢弃」断言假 Agent 确实发出了自主更新（fake 新增 `emitted` 观测）；`packages/testkit/test/fake-acp-agent.test.ts` 守卫类型擦除前提（不在 node_modules、无相对 import、无需转译的语法），`fake-acp-agent.ts` 头注释说明；
  - `AgentProvider.applyPermissionTier` 与 generic-acp 注释写明：generic 为 no-op，**真实 Agent 的 Provider 进目录前必须实现档位映射**（尤其 read_only）。
- **提交提醒**：`apps/desktop/agent-release-gates.json`、`packages/core/migrations/runs/0005_run_engine.sql`、`packages/testkit/bin/`、`packages/core/src/agent/external/` 等均为新文件（未跟踪），提交时必须一并带上，否则发行打包会因缺放行清单直接失败。
- 新增常量 `AGENT_KILL_GRACE_MS`、`AGENT_STDERR_TAIL_MAX_CHARS`；fake agent 新增 `notify` / `fail` 动作，`permission` 可带结构化 `name`。
- 本轮测试：受影响测试（契约 / 单测 / 集成 / shared / testkit）全部通过；全量见下行。
- 全量（第 2 轮）：129 个文件 / 1049 用例：33 失败（8 个文件），与基线失败清单逐条一致、无新增；1010 通过、2 skipped、4 todo；唯一 unhandled rejection 仍来自基线失败的 `projects.test.ts`（`lease.waiting`）。`pnpm -r typecheck` 0 错误（1 条既有 svelte warning）；`pnpm lint` 全仓 0 问题。

---

## 5. P2 — 能力注入：宿主 MCP 桥 + 能力包 + 提示词；Claude / Codex

### 5.1 改动清单

- [x] **core `agent/external/mcp-bridge.ts` `HostMcpBridge`**：
  - Streamable HTTP MCP server（`@modelcontextprotocol/sdk` 服务端；若 pi-mcp 提供服务端能力以锁定版本实况为准）监听 `127.0.0.1:0`，core 启停同步
  - `issueSessionToken(sessionKey)`（256-bit，按会话签发）、`bindRun(sessionKey, identity, tools)` / `unbindRun`、`revoke`；无 run → 拒绝；`Host` 非 `127.0.0.1:{port}` 或带非本机 `Origin` → 403
  - `tools/list` = 当前 run 的工具；`tools/call` 构造 `ToolContext`（`identity`、run 的 `signal`、`progress`、`terminate`）调用原 `execute`，结果转 MCP content
  - 截断与图片判定从 `pi-engine.ts` 工具包装层抽为共用函数，桥与 `PiEngine` 共用
  - 桥直接向当前 run 的 handle 发 `tool_call` / `tool_result`（带 `errorCode`，使 SETUP_REQUIRED 中断生效）；`ExternalAgentEngine` 忽略 ACP 对 `kepcup` 工具的镜像更新
  - 无 http MCP 能力的 Agent：`agent/external/stdio-proxy.mjs`（stdio↔http，Electron Node 运行，token 经环境变量）
- [x] **能力包落地**：`buildExternalAgentTools(bot, deps)` = `buildResponseTools` 结果 → 去掉 `NEVER_INJECTED_TOOLS` → 按 `resolveCapabilities(bot.profile.runtime.agent.capabilities, catalogEntry)`（`null` 用 `defaultCapabilities`；`core` 强制加入；管家强制加入其专属工具）过滤；`mcp` 包按既有 `mcp_server_ids`
- [x] **`skip_reply`**：`terminate` → 工具返回后 `session/cancel` → 结算为不发最终文本的 completed
- [x] **工具选择策略（设计 28 §4.2）**：
  - 补位类（`supplement`）工具：桥下发的 `description` 统一加前缀「[补充能力] 若你自带同类能力，优先使用自带能力；仅当其不存在、不可用或失败时调用本工具」
  - `buildAgentToolPolicy(capabilities, provider)` 生成 `<tool_policy>` 段：补位类逐项列出，Provider 的 `nativeCapabilities` 有对应原生工具名时点名（「联网搜索用你的 WebSearch / WebFetch，不要用 `mcp__kepcup__web_search`，除非它们不可用或失败」），否则通用表述；宿主语义类写明宿主优先（记忆用 `remember` 不写文件、定时用 `schedule` 不用 cron、发消息 / 附件用 `send_message`、找 Bot 用 `delegate_to_bot`、装环境用 `request_environment`）
  - 桥调用的 `tool_call` 步骤带 `capability` 与 `nativeOverlap` 标记，供遵守度统计
- [x] **提示词**：`system-prompt.ts` 增 `buildAgentSessionPrompt`（ACP 版 `<platform_rules>` + `<tool_policy>`：规则按注入的能力包增减，工具名经 `provider.toolName` 映射；去掉内置文件工具专属规则；+ identity / persona / conversation_info）与 `buildAgentRunContext`（其余动态段，只读上下文与能力包解耦照常注入）；按 `provider.instructionMode` 下发；`<project>` 段跳过 `provider.agentSideConfigFiles` 中 Agent 自己会读的文件
- [x] **图片**：触发批图片（D61）在 `promptCapabilities.image` 为真时作为 `image` 块
- [x] **Claude Provider**（`providers/claude.ts`）+ 目录条目（npx `@agentclientprotocol/claude-agent-acp@<锁定>`，`nativeCapabilities: ['web','vision']` 以 P0 为准）：`meta-append`；`_meta.claudeCode.options`：`settingSources: []`（`loadUserConfig` 时 `['user']`）、`allowDangerouslySkipPermissions:false`、`maxTurns = RUN_MAX_TURNS`、`disallowedTools` 去掉与注入能力冲突的（例如注入了 `web` 包则禁用其 `WebSearch`，以 P0 结论为准）
- [x] **Codex Provider**（`providers/codex.ts`）+ 目录条目（npx `@agentclientprotocol/codex-acp@<锁定>`）：`prompt-prefix`；`CODEX_CONFIG` 只放审批 / 沙箱全局项；`agentSideConfigFiles: ['AGENTS.md', '.codex/']`

### 5.2 验收

- 契约测试新增 MCP 往返用例全部通过（fake）；伪造 / 过期 token、run 外调用被拒；run 取消时进行中的桥调用收到 abort
- 能力包：取消 `image_generation` 后工具列表与平台规则都不含它；`core` 无法取消
- 工具选择策略：补位工具描述带前缀；`<tool_policy>` 对 Claude / Codex 点名其原生工具；未注入的包不出现在策略段
- 审计表对桥调用记录正确 `RunIdentity`；SETUP_REQUIRED 经桥触发对话内设置卡
- 真实 Claude / Codex（P0 账号）手动验证 `send_message` 发附件与 `remember`

### 5.3 实施记录（P2，2026-10-07）

**状态**：§5.1 全部完成；§5.2 验收除「真实 Claude / Codex 手动验证」（需 P0 登录态 + P4 安装器）外均有自动化测试覆盖。未 commit。

**改动文件**
- core 新增：`agent/tool-execution.ts`（`executeToolSafely` + `toolResultBlocks`：失败转结果、截断、图片判定；PiEngine 与桥共用）；`agent/external/mcp-bridge.ts`（`HostMcpBridge`）、`agent/external/stdio-proxy.mjs`、`agent/external/capabilities.ts`（`buildExternalAgentTools` / `bridgeToolMeta` / `hostToolNamer`）、`agent/external/providers/{claude,codex}.ts`。
- core 修改：`agent/pi-engine.ts`（只换成调用共用函数，行为不变）；`agent/external/engine.ts`（桥绑定 / 镜像忽略 / `hostToolCall`·`hostToolResult` / 终止型工具 → `session/cancel` → completed+skipReply / abort 传到桥调用 / 释放时解绑并按 token 吊销；`request` 步骤带 `sessionPrompt`〔meta-append〕与 `hostTools`）；`agent/external/acp/client.ts`（`AcpToolCallLike`、`HOST_MCP_SERVER_NAME`、`structuredToolNameOf` / `hostBridgeToolOf`，`decidePermission` 改用 Provider 的结构化名）；`agent/external/types.ts`（`SessionContext.maxTurns/loadUserConfig`、`AgentProvider.structuredToolName`）；`providers/index.ts`（登记 claude / codex）；`agent/types.ts`（`ExternalRunSpec.loadUserConfig`）；`agent/context/system-prompt.ts`（抽出 identity / persona / conversation_info / grants 辅助函数，`buildSystemPrompt` 输出不变；新增 `buildAgentSessionPrompt` / `buildAgentToolPolicy` / `buildAgentRunContext`）；`project/context.ts` + `project/service.ts`（`skipGuideFiles`）；`dispatch/orchestrator.ts`（`buildResponseTools` 提前算出；外部 Bot 经 `#agentRunSetup` 得到注入工具、能力集合与 `promptParts`）；`start.ts`（`HostMcpBridge` 随 core 启停，`services.agents.bridge`，审计走 `gateway.audit`）。
- shared：`host-capabilities.ts`（`mcp` 包 `toolPrefixes:['mcp_']`、`capabilityOfTool`、`resolveCapabilities`、`SUPPLEMENT_TOOL_DESCRIPTION_PREFIX`）；`agent-catalog.ts`（Claude Agent `claude-acp`、Codex `codex-acp` 条目）。
- testkit：`fake-acp-agent.ts` 增 `mcp_call` / `mcp_list` 动作（纯 fetch 的 Streamable HTTP 客户端，不引 MCP SDK；镜像更新可模拟通用 / Claude `_meta` / Codex `rawInput` 三种结构化名位置）与 `mcp` 观测。
- 测试：新 `core/test/unit/host-mcp-bridge.test.ts`、`core/test/unit/external-agent-p2.test.ts`；契约测试 `it.todo` 换成 6 个桥用例，并新增以假 Agent 模拟的 Claude / Codex 目标；`integration/external-agent.test.ts` 增 4 个 P2 用例；`unit/external-agent-engine.test.ts`（`mcp_` 前缀检查改用 `mcpToolName`）、`shared/test/unit/agent-catalog.test.ts`（新条目、`capabilityOfTool` / `resolveCapabilities`）。
- 文档：`docs/dev/04-agent-runtime.md` 外部引擎节（进度 + P2 落地要点）。

**偏差与理由**
- 目录 id 沿用 ACP Registry 的 `claude-acp` / `codex-acp`（引擎键 `agent:claude-acp`），Provider id 为 `claude` / `codex`。
- 桥为**无状态** Streamable HTTP（每请求新建 MCP Server，JSON 响应，GET/DELETE 405）：会话语义全由 token → run 绑定承担，免去 MCP 会话的生命周期管理。过期 token = 被吊销 / 被重签替换（P1/P2 每 run 一个会话，run 结束即吊销）；run 外调用因此多为 401（token 已吊销），「有 token 无 run」为 403。
- 桥在 `session/new` **之前**绑定 run（Agent 建会话时就连 MCP、拉工具列表）；无 http MCP 的 Agent 本期不注入宿主工具（只告警），stdio 代理未接线。
- 审计：桥对每次调用写 `agent_bridge_tool_call`（经 `gateway.audit` 脱敏），工具内部原有的网关审计照常。
- 工具归属：不属于任何能力包的工具（访谈专用 `save_profile` 等）外部 Agent 下一律不注入；`mcp` 包按工具名前缀 `mcp_` 识别（工具已按 `mcp_server_ids` 构建）。管家必含 `collaboration`（其专属工具在该包）。
- 「当前时间」从会话级 `<conversation_info>` 移到 run 级 `<current_time>`（会话可能跨 run，P5 复用时不会过时）。
- ACP 版 `<access>`：权限档位说明 + 「工具运行在你自身的沙箱中」+ 网关授权列表（`send_message` 附件等宿主工具仍走网关路径检查）。
- Claude：注入 `web` 包也不禁用 WebSearch（原生优先，未用 `disallowedTools`）；`agentSideConfigFiles: []`（`settingSources:[]` 下 Claude 不自读 CLAUDE.md，由 `<project>` 注入）；`features.steering/loadSession/resume/osSandbox` 按矩阵置真（P5 才消费）。档位所需模式不存在时 fail-closed（`AGENT_INCOMPATIBLE`）。
- Codex：进程级 `CODEX_CONFIG={approval_policy:'on-request', sandbox_mode:'read-only'}` + `INITIAL_AGENT_MODE=read-only`；档位优先 `session/set_mode`，无 modes 时退到 `mode` 类 config option。codex-acp 实际提供 modes（`read-only / workspace-write / agent / agent-full-access`），与离线 spike「无 modes」的记录不同（spike 未登录时 `session/new` 即失败，看不到 modes）。
- `skip_reply` 的终止判定同时认 `ToolResult.terminate` 与 `ctx.terminate()`；终止后不追加空的最终 assistant 步骤（与 pi 的 skip_reply 步骤形状一致）。
- 两次相继的桥调用是两个「模型轮」：第二次调用前补一条空文本的 `assistant(toolUse)`（与 pi 逐轮发 assistant 一致）。

**给 P3 的注意**
- `decidePermission` 已按 `provider.structuredToolName` 识别宿主桥工具；权限桥替换它时沿用 `hostBridgeToolOf`，Claude / Codex 的权限请求里结构化名的实际位置需登录后 spike 确认（Codex 的 MCP 审批走 `_meta.codex_approval_kind === 'mcp_tool_call'`）。
- orchestrator 的 `AGENT_PERMISSION_UNTIL_P3` 常量是只读档的唯一开关（同时影响 `external.permission` 与 run 级 `<access>` 文案）。
- Claude `applyPermissionTier` 目前只切 `permissionMode`（plan / default）；`acceptEdits` 与原生 sandbox 的 `denyRead/denyWrite`（`_meta.claudeCode.options.sandbox`）在 P3 补；`CLAUDE_FORBIDDEN_MODES` / `CODEX_FORBIDDEN_MODES` 已导出供 `current_mode_update` 纠偏用。
- 桥的 token 在 run 释放时吊销；P5 会话复用需改为「会话删除 / 指纹变化时吊销」并在复用时 `bindRun` 新 run（`issueSessionToken` 重签会使旧 token 失效）。
- `stdio-proxy.mjs` 不被 tsc 复制到 `dist/`：P4 打包时需随应用分发并给出运行路径。

**测试**（容器内）
- 受影响测试：`contract`（84）、`unit/{host-mcp-bridge,external-agent-p2,external-agent-engine}`、`integration/external-agent`（11）、`shared/agent-catalog`、testkit 全部通过。
- 全量（616 s）：135 个文件 / 1167 用例：33 失败（8 个文件），与基线失败清单逐条一致、无新增；1132 通过、2 skipped、0 todo；唯一 unhandled rejection 仍来自基线失败的 `projects.test.ts`（`lease.waiting`）。`pnpm -r typecheck` 0 错误（1 条既有 svelte warning）；`pnpm lint` 0 问题。

#### 审查修复（P2 独立审查 COMMENT，2026-10-07）

1. **[Major] Claude 只读档不再用 `plan`**（plan 会抑制 MCP 工具并可能以 ExitPlanMode 收尾）：所有档位都用 `default` 模式；read_only 经 `_meta.claudeCode.options.disallowedTools` 禁 `Edit/Write/MultiEdit/NotebookEdit/Bash`，其余原生写入仍发权限请求被拒（`providers/claude.ts`）。`AGENT_PERMISSION_UNTIL_P3` 仍为 read_only。
2. **[Major] 代理**：`buildAgentEnv` 在存在任一 `*_PROXY` 时把 `127.0.0.1,localhost,::1` 并入 `NO_PROXY` / `no_proxy`（保留用户原值、两种写法一致），桥流量与 Bearer token 不经用户代理（`host.ts` `withLoopbackNoProxy`；单测）。
3. **[Major] Codex 兼容**：`tools/list` 带 `annotations`（`readOnlyHint` / `destructiveHint`，`capabilities.ts` `toolAnnotations`）。**无法为桥设超时**：codex-acp 2.1.1 只把 ACP http server 译成 `{url, http_headers}`，会话配置的 `mcp_servers` 整体覆盖 `CODEX_CONFIG` 同名键 → 沿用 Codex 默认（约 60 s），已记入 `providers/codex.ts` 注释；P5 项见下。
4. **[Major] 冒充**：桥 server 名改为按会话随机 `kepcup_<8hex>`（orchestrator 生成并随 `external.hostServerName` 传入，提示词的工具名用它映射；引擎缺省自行生成）；放行与镜像抑制都要求「指向本会话的桥名 **且** 是当前 run 注入的工具」（`SessionBridge{serverName, toolNames}`，`hostBridgeToolOf`）；没有对应桥调用的镜像在结束时按原生工具记录（`AcpEventMapper` 的 matched / unclaimed 配对）。顺带避开 Codex「与已配置 MCP 同名即丢弃」的去重。
5. 桥启动失败不再拖垮 core（`start.ts` catch + error 日志）；需要宿主工具而桥未运行时 run 以 `AGENT_UNAVAILABLE`「KepCup 宿主工具桥未启动…」失败（`engine.ts` `#attachBridge`）。
6. **访谈中的 Bot**（`setupState==='interviewing'`，含管家访谈）一律回落内置引擎（`orchestrator.ts` `#agentIdOf`，影响引擎选择、伪 ref / 调度键、`runs.engine`）；无内置模型时走既有 main-model 结构化 setup 失败。选回落而非禁止：访谈工具（ask_question / save_profile / finish_setup）从不注入外部 Agent，且管家可能在选定 Agent 后才进入访谈。
7. 桥审计参数上限 `BRIDGE_AUDIT_ARGS_MAX_CHARS`（2000，超出存截断的 JSON 摘要 + `argsTruncated`）。
8. **skip_reply 与并行调用**：桥按 run 统计进行中的调用，终止型工具的 `onTerminate` 等同 run 所有进行中调用都应答后才触发（单测 + 契约）。仍有的差异：在 skip 应答之后才**开始**的兄弟调用不受保护（Agent 收到 cancel 后通常不会再发）。
9. 外部 run 下工具名按 Provider 前缀限长（`MAX_AGENT_TOOL_NAME`=64，超长的用户 MCP 工具名截断 + 8 位哈希，`fitToolName`）。
10. `AgentProvider.structuredToolName` 改为 `bridgeToolFromCall(toolCall, serverName)`；通用识别 = `toolCall.name` 的 `toolName` 写法或 `rawInput.{server,tool,arguments}`（`acp/client.ts` `defaultBridgeToolFromCall`），P5 新增 Provider 须逐家实测（类型注释已写明）。
11. Claude 宿主强制项：核对适配器 0.86.0 —— 先展开 `_meta.claudeCode.options`，再以 `allowDangerouslySkipPermissions: allowBypass`（我方 false → false）与 `permissionMode` 覆盖；我方 options 中强制项（`settingSources`、`allowDangerouslySkipPermissions`）也放最后（单测断言顺序）。
12. Codex 跳过 AGENTS.md 后注入 CLAUDE.md 是预期（Codex 不读 CLAUDE.md）：`project/context.ts` 加注释，单测已覆盖。
13. 新增用真实 MCP SDK `Client` + `StreamableHTTPClientTransport` 驱动桥的单测：无状态 initialize（无 session id）、tools/list（含 annotations）、tools/call、SDK 的可选 GET 被 405 且被容忍、错误的 `mcp-protocol-version` 头 → 400。
- 测试缝：fake agent 增 `parallel`（并行 lane）、权限请求 `bridgeTool`（按会话桥名生成结构化名）、`mcp_call.skipCall`（只发镜像不调用）；默认桥名取会话里的 `kepcup` / `kepcup_*` server。

- 本轮测试：受影响测试（契约 96、`unit/{host-mcp-bridge,external-agent-p2,external-agent-engine,agents-service,agent-installer}`、`integration/external-agent` 12、testkit）全部通过；全量 136 个文件 / 1211 用例：33 失败（8 个文件），与基线失败清单逐条一致、无新增；唯一 unhandled rejection 仍是基线的 `projects.test.ts`（`lease.waiting`）。`pnpm -r typecheck` 0 错误（1 条既有 svelte warning），`pnpm lint` 0 问题。

**后续阶段备注**
- **P5 会话复用**：token 改为会话级吊销（会话删除 / 指纹变化），且 Agent 在连接时缓存 `tools/list` —— 复用必须重新 `bindRun` 新 run，且工具集合固定（指纹含能力集合与桥 server 名，桥名随 `agent_sessions` 持久化）。
- **P5 长耗时工具**：等待用户审批的 `install_skill` / `request_environment` / `git_remote` 与 `generate_video` 可能超过 Codex 默认 MCP 超时（约 60 s，无法经 ACP 调整）：评估桥改 SSE 响应 + `notifications/progress`（需实测 Codex 是否因 progress 重置超时），或改为「提交后立即返回、结果异步送达」。
- **P0 登录 spike 必验**：Codex MCP 审批请求（`_meta.codex_approval_kind === 'mcp_tool_call'`）是否带 `rawInput{server,tool,arguments}`；Claude 权限请求里 `_meta.claudeCode.toolName` 的位置；Claude `default` 模式下 MCP 工具与 `disallowedTools` 的实际行为。
- **P4 打包**：`agent/external/stdio-proxy.mjs` 不经 tsc 复制到 `dist/`，需随应用分发并提供运行路径。

---

## 6. P3 — 权限与隔离

### 6.1 改动清单

- [x] **main 迁移 `0017_external_agents.sql`**：
  - 重建 `approvals` 表加入 `agent_tool`（以 `0016:43–46` 为准**全部带上**：`access, unsandboxed, command, git_remote, environment, skill_import, profile_change, skill_preset, mcp_tool, butler_proposal`，再加 `agent_tool`；照 0015/0016 标准流程，重建 `approvals_pending` 索引）
  - `agent_sessions` 表（P5 用，一并建）：`id, bot_id, conversation_id, agent_id, agent_session_id, fingerprint, last_run_id, last_used_at, created_at`；唯一索引 `(bot_id, conversation_id, agent_id)`；无 CASCADE 外键
- [x] **shared**：`approvalKindSchema` 增 `'agent_tool'`；payload `{ agentId, title, kind, locations[], command?, options[] }`
- [x] **core `agent/external/permission-bridge.ts`**（替换 P1 的默认拒绝）：
  - `mcp__kepcup__*`（经 `provider.toolName` 识别）→ 允许
  - 路径优先级：cwd 与技能目录 → 应用数据目录其余部分（拒绝）→ 网关 `checkPath`
  - 读：工作目录内允许；外 → `checkPath`（已授权放行 / 弹卡）
  - 写（edit/delete/move）：`read_only` 拒绝；`workspace` 且工作目录内允许；`ask` 或越界弹卡
  - 执行：白名单（D40）放行；`workspace` 且 `provider.features.osSandbox` 放行；否则弹卡（只有「仅这一次」）
  - 其他 / 看不懂 → 弹卡
  - 只按 `provider.permissionOptions` 白名单选 optionId；路径类「本对话内」记 `access` 授权后 `allow_once`；不选 `allow_always` 与任何模式切换选项
  - 无人值守：`agent_tool` 并入 `#autoDecideSync`（`commandTouchesDataDir` 检查命令文本；`locations` 检查数据目录，workspace / 技能目录除外）→ 触及则拒绝，否则自动批准并审计
  - run 取消 → 挂起请求返回 `cancelled`
- [x] **档位映射**：各 Provider 的 `applyPermissionTier`（Claude：`permissionMode` + `sandbox` 的 `denyRead`/`denyWrite`；Codex：`read-only`/`workspace-write`）；目录 / Provider 层过滤 `bypassPermissions`、`auto`、`dontAsk`、`agent-full-access` 等；`current_mode_update` 偏离 → `session/set_mode` 改回 + 审计；Windows 下无沙箱 Agent 强制 `ask`；`preview` 档默认 `ask`
- [x] **租约**：外部 Agent Bot、project 绑定且档位可写 → `#executeResponseRun` 在 `startRun` 前显式 `projects.ensureWriteLease(identity, project.path, {signal})`（复用 `waiting_lease`），整 run 持有，结算照常 `releaseRun`（自动得到前后快照）
- [x] **project 内 Agent 配置确认**：project 含 `provider.agentSideConfigFiles` 中的文件时，该 Bot 首次在此 project 运行前弹确认卡（记住到对话）
- [x] **desktop**：`ApprovalCard.svelte` 增 `agent_tool` 渲染；`renderContextLine` 增分支

### 6.2 验收

- 真库集成测试：`agent_tool` 落库不触发 CHECK 失败
- fake 剧本：工作目录内写自动放行；越界写弹卡 → 拒绝 → Agent 收到 `reject_once`；数据目录写在无人值守下仍拒；模式被切到 bypass 时被改回
- project 中外部 Agent Bot 与内置 Bot 同时要写 → 租约串行；检查点 diff 与回退可用

### 6.3 实施记录（P3，2026-10-07）

**状态**：§6.1 全部完成，§6.2 验收全部有自动化测试（真库 + 子进程假 Agent）。未 commit。

**改动文件**
- 迁移：新 `packages/core/migrations/main/0017_external_agents.sql`（重建 approvals，CHECK 带全 0016 的 10 个 kind + `agent_tool`，重建 `approvals_pending`；`agent_sessions` 表 + `(bot_id, conversation_id, agent_id)` 唯一索引，无外键）。
- shared `domain/types.ts`：`approvalKindSchema` 增 `agent_tool`；`agentToolKindSchema`（read / write / execute / other / config）与 `agentToolApprovalPayloadSchema`（`agentId, agentName, title, kind, toolKind, access?, locations[], command?, cwd, options[], durations, reason, sensitive, exemptDirs, projectPath?`）；decision 注释。
- core 新 `agent/external/permission-bridge.ts`（`AgentPermissionBridge`、`classifyPermissionRequest`、`commandOfRawInput`、`effectiveAgentPermission`、`hasOsSandbox`、`FORBIDDEN_AGENT_MODES` / `isForbiddenAgentMode`、`isolationFor`）。
- core 修改：`acp/client.ts`（`selectPermissionOption` 按白名单顺序、allow 无可用选项降为 reject；`requestPermission` 改异步、先交给会话 run 的权限桥，异常回 cancelled；导出 `AcpRequestPermissionRequest/Response`、`AcpPermissionToolCall`、`PermissionVerdict`）；`host.ts`（`SessionSink.requestPermission?`、router 委托）；`types.ts`（`SessionContext.isolation?` / `AgentIsolation`、`AgentProvider.execSandboxed?`）；`engine.ts`（`permissions` 依赖、`isolation` 传给 Provider、`#applyTier` 模式守卫、`current_mode_update` / `config_option_update` 纠偏 + 审计、权限进度文案）；`providers/claude.ts`（workspace → acceptEdits、`claudeSandboxSettings`、白名单 `allow-once` / `reject`、`execSandboxed`）；`providers/codex.ts`（ask → read-only、禁 `agent`、白名单 `allow_once` / `decline,reject_permissions,cancel`、`execSandboxed` 恒 false）；`permissions/approvals.ts`（`#autoDecideSync` 并入 `agentToolTouchesDataDir`、自动批准记 once；`decide` 对命令类把 conversation 降为 once；`describe` / `renderContextLine` 的 agent_tool 分支；`approvedOfKind`；`commandTouchesDataDir` 增可选 `exemptDirs`）；`dispatch/orchestrator.ts`（去掉 `AGENT_PERMISSION_UNTIL_P3`，读 Bot 档位经 `effectiveAgentPermission`；`#agentProjectGate`：配置确认 + 显式租约）；`start.ts`（装配 `AgentPermissionBridge`）。
- testkit `fake-acp-agent.ts`：`permission` 可带 `kind` / `locations`（相对 cwd 解析）/ `rawInput`；新动作 `mode_update`（`current_mode_update`）、`write_file`（原生工具真实写盘）。
- desktop：`ApprovalCard.svelte` 渲染 agent_tool（Agent、工具标题、类别、命令原文与 cwd、路径 / 配置文件、原因、敏感警示、沙箱外风险提示；路径类「仅这一次 / 本对话内」与 1/2 键）；`zh-CN.ts` 新文案 `approvals.agentTool*`。
- 测试：新 `core/test/unit/permission-bridge.test.ts`（15）、`core/test/unit/external-agents-migration.test.ts`（真库：截到 0016 的旧库 + 全部旧 kind 行 → 升级后逐列保留、agent_tool 可写、非法 kind 仍被 CHECK 拒、agent_sessions 唯一）、`core/test/integration/external-agent-p3.test.ts`（10：工作目录内写放行 / 越界写弹卡 → 拒绝 → reject_once 且 run 进 waiting_approval、上下文行渲染；本对话内授权后同路径免卡；数据目录直接拒绝 + 无人值守下命令触及数据目录自动拒绝、workspace 内命令自动批准；白名单放行 + 无 OS 沙箱命令逐条弹卡且 conversation 降为 once；read_only 拒写拒命令拒切模式；取消 run → 挂起请求回 cancelled；模式被切到 bypass → set_mode 改回 + 审计；project 配置确认记住到对话 / 拒绝则不启动 Agent；外部 Agent run 整 run 持有租约、内置 Bot 写入 waiting_lease 串行、检查点 diff 与回退）；更新 `contract/agent-provider.contract.ts` + `agent-providers.test.ts`（Claude / Codex 目标用真实 optionId）、`unit/external-agent-p2.test.ts`（sandbox 选项、acceptEdits、ask → read-only）、`unit/butler-delegation-migration.test.ts` / `unit/public-skills-migration.test.ts`（迁移号含 17、回拨时摘除 agent_sessions）。
- 文档：`docs/dev/03-data-model.md`（approvals CHECK 与 agent_tool payload、agent_sessions、删除级联 P5 待接）、`docs/dev/04-agent-runtime.md`（P3 落地要点）。

**偏差与取舍**
- **配置确认复用 `agent_tool` 的子类型 `config`**（不另设 kind）：同属「外部 Agent 将做的事」一类卡，共用 Agent 标识 / 路径渲染、无人值守语义与 CHECK 值，少一次表重建；代价是 payload 的 `kind` 多一个分支。记住范围 =（对话、Bot、Agent、project 路径），project 根下的配置文件集合新增时重新询问。拒绝 → run 以「用户未确认…」failed，Agent 不启动。
- **工作目录 = cwd + 本 run 的 workspace**：project 绑定时 cwd 是 project，但 workspace（数据目录内）仍是 Agent 写附件给 `send_message` 的位置，与网关 `checkPath` 第 1 步一致；数据目录其余部分一律拒绝、不弹卡（不可授权，与网关一致）。
- **fetch（WebFetch / WebSearch）**：read_only / workspace 放行、ask 弹卡（Bot `network_policy` 对 Agent 不成立，design 13；逐次弹卡会让「原生优先」的联网能力不可用）。think 放行；switch_mode 一律拒绝（模式只由宿主按档位设）。
- **「workspace 且 osSandbox 放行」收紧为「Provider 能从请求确认在沙箱内」**（`execSandboxed`）：Codex 在 workspace-write / on-request 下发来的命令请求本身就是越出沙箱的提权，放行就等于绕过沙箱 → Codex 恒弹卡；Claude 在 workspace 档开 `autoAllowBashIfSandboxed`（沙箱内命令不再询问），`allowUnsandboxedCommands:false` 禁逃逸，`failIfUnavailable:true`（沙箱起不来整 run 失败而非静默降级）；其余档 `failIfUnavailable:false`、命令逐条走宿主。
- **Codex 的 ask 档用 `read-only` 模式**：codex-acp 2.1.1 的模式自带 approval_policy（全是 on-request），workspace-write 下 cwd 内写入不发权限请求，无法逐次确认；read-only 下每次写入都先请求宿主。进程级 `CODEX_CONFIG` 不变（对所有会话相同即可）。另禁 `agent` 模式（auto_review 由 AI 审核员代替宿主审批）。
- **`preview` 档默认 ask** 由 Bot 配置界面在选择 Agent 时设定（P4 已有），core 不覆盖用户选择；Windows 下 `workspace` 一律降为 `ask`（所有 Agent 的 Windows 沙箱均未核实）。
- **模式守卫**是引擎层（对所有 Provider 生效）：宿主包装 `setMode` / `setConfigOption`，禁止模式直接拒绝；纠偏同 run 超过 5 次即中止（结算为 cancelled）。
- 无人值守底线：数据目录内路径本就被直接拒绝；命令文本用 `commandTouchesDataDir(…, exemptDirs)`——token 的路径部分（`..` 规范化后）落在 workspace / 技能目录内才豁免，裸 `~` / `$HOME` 等祖先仍判为触及。自动批准的 agent_tool 记 `{duration:'once'}`。
- 选项白名单按 2026-10-07 源码核对：claude-agent-acp 0.86.0 `permissions/options/shared.js`（`allow-once` / `allow-with-updates` / `reject`，ExitPlanMode 的 `exit-plan-*` 不在白名单）；codex-acp 2.1.1 `ApprovalOptionId` / `McpApprovalOptionId`。allow 时找不到白名单内 allow_once → 降为 reject（P1 为 cancelled）。

**需登录实测（P0 登录 spike 补跑）**
- Claude：`_meta.claudeCode.options.sandbox` 在 0.86.0 / SDK 0.3.287 下的实际效果（Linux 需 bubblewrap，缺失时 workspace 档 run 失败的报错形态）；`filesystem.allowRead` 能否在 `denyRead:[~/.kepcup]` 中重新放开 workspace；acceptEdits 下 cwd 外 Edit/Write 是否确实发权限请求且带 `locations`；Bash 权限请求的 `kind` 是否为 `execute`、`rawInput.command` 形态；WebFetch / WebSearch 的 `kind` 是否为 `fetch`；`current_mode_update` 的回声时机（纠偏不应误触发）。
- Codex：read-only 模式下写入请求的 `kind` / `locations`（apply_patch）、命令请求 `rawInput{command,cwd}`；`set_mode` 后 `current_mode_update` 与 `config_option_update` 是否都会到达。
- 各家权限请求中宿主桥工具的结构化名位置（沿用 §5.3 的待验项）。
- （安全审查）Claude Code 对 cwd 内指向 cwd 外的符号链接执行 Read / Edit 是否不询问宿主；Codex apply_patch 是否跟随符号链接。
- （P4-B 审查）Claude 沙箱不可用（Linux 缺 bubblewrap / socat，`failIfUnavailable:true`）的确切错误形态与阶段（`session/new` / `session/prompt` / 首次 Bash 工具结果），据此收紧 `isClaudeSandboxUnavailable`；设置页「测试连接」只发 ping、不跑 Bash，可能测不出沙箱缺失——评估测试连接是否追加一次无害的沙箱内命令。

**给 P4-B / P5 的注意**
- P5 会话复用：`agent_sessions` 已建表（无写入方）；接入时须把删除对话 / 删除 Bot / 停用卸载 Agent 的清理接入 `lifecycle`（03-data-model 删除级联表已标「P5」）；fingerprint 须含档位（档位变化必须新建会话：Claude 的 sandbox / disallowedTools 只在 `session/new` 生效）与 `isolationFor` 的结果；复用时重新包装模式守卫（`#expectedMode` 取会话当前模式）。
- P5 新增 Provider（OpenCode / dsh / Cursor / Antigravity）：必须给出 `permissionOptions` 白名单（实测 optionId）、`execSandboxed`（无 OS 沙箱的不实现即可）、档位映射；`FORBIDDEN_AGENT_MODES` 已含 `yolo` / `full-access` 等，新的危险模式名要补进去；OpenCode 经 `OPENCODE_PERMISSION` 让命令走询问。
- 外部 Agent run 整 run 持有 project 租约：其桥工具若写入 project 外的已授权目录，`ensureWriteLease` 的「一 run 一租约」会先释放 project 租约（已知边角，未处理）。
- P4-B 对话内设置卡：配置确认被拒的 run 是普通 failed（无 setup 结构），如需「重试」入口可复用 setup 卡。

**测试**（容器内）：受影响测试（新 `permission-bridge`、`external-agents-migration`、`integration/external-agent-p3`；契约、`external-agent-{engine,p2}`、`integration/external-agent`、`agents-service`、`approvals`、迁移测试、testkit）全部通过。全量 139 个文件 / 1238 用例：33 失败（8 个文件），与基线失败清单逐条一致、无新增；1203 通过、2 skipped；唯一 unhandled rejection 仍是基线的 `projects.test.ts`（`lease.waiting`）。`pnpm -r typecheck` 0 错误（1 条既有 svelte warning），`pnpm lint` 0 问题。

**并发会话事故（2026-10-07 17:47–17:49 CEST）**：另一会话（kepcup-17）同时在本工作树上做 P3，写过 `0017_external_agents.sql`、shared `types.ts`（之后自行删除其 payload 块）并把 `permissions/approvals.ts` 整文件还原到 HEAD。核对结果：0017 为本实现版本（approvals 重建带全 10 个旧 kind + agent_tool、agent_sessions）；`types.ts` 只剩一处 `'agent_tool'`（无重复），注释已统一，本实现的 payload schema 完整；approvals.ts 的本实现改动是在其还原之后才应用的（此前的写入因断言失败未落盘），无丢失；其余文件未受影响。

#### 安全审查修复（P3 安全审查 HIGH：3 high / 6 medium / 6 low → 全部处理，2026-10-07）

- **H1 Codex 补丁请求被自动放行**：`AgentProvider.writeSandboxed?`（Codex 恒 false：它只为沙箱拒绝的写入发请求）→ 写入请求即便可见路径都在 cwd 内也弹卡；路径收集增加 `content[]` 的 diff 路径、`rawInput` 的 move 目标键与 `changes`（数组 / 以路径为键的对象）；cwd 内 `.git/`（hooks）与 Provider 的 `agentSideConfigFiles` 的写入一律弹卡（敏感）。
- **H2 只读白名单在沙箱外执行**：外部 Agent 只有 Provider 确认「在其 OS 沙箱内」（`hasOsSandbox` + `execSandboxed`）的命令才走白名单（Codex / 通用 Agent 恒不走，read_only 直接拒绝）。同时修复内置 D40 白名单的既有漏洞：`allowlist-match.ts` 新增 `isDangerousOption`（长选项 `--opt=value` 与 GNU 缩写、短选项附带值与 sed/sort/tree/file 的短选项簇），危险项补 `rg --pre/--pre-glob`、`git --output/--ext-diff/--textconv/--exec-path`、`sort --output/--compress-program`、`tree -R`、`file -C/--compile`、`sed --in-place`（修正原 `-in-place` 笔误）；`--opt=/path` 的值按路径检查；Windows 分支同样检查危险选项。
- **H3 无人值守底线忽略 cwd 与相对路径**：桥里命令工作目录位于数据目录（workspace / 技能目录除外）→ 直接拒绝；`agentToolTouchesDataDir` 检查 `payload.cwd` 本身，`commandTouchesDataDir` 新增 `{cwd, platform}`：相对 token（及 `--opt=` 的值）相对命令 cwd 解析（不再落到 core 进程自己的 cwd），任何跳出豁免目录的 `..` 视为触及；无 cwd 的内置调用方不判相对 token。
- **M1**：read_only 下未识别 kind、无路径的写、无命令的执行一律拒绝；无人值守对 `kind:'other'` 与无 locations 的 write 卡自动拒绝（`agentToolUnattendedRefusal`）。
- **M2 配置闸门**：`approvedAgentConfigs` 跳过无人值守自动批准；记住改按配置内容哈希（`hashAgentConfigFiles`：文件内容、目录树、符号链接目标，上限 5000 项 / 32MB，超出记截断标记——已知限制），内容变化即重新确认；Agent 对配置文件的写入一律弹卡（选弹卡而非拒绝：用户可能就是要 Agent 改 AGENTS.md）。
- **M3 Codex 全盘可读**：评估后不改 cwd（Codex 沙箱的读本身不受 cwd 限制，挪 cwd 无助于读取隔离，反而破坏 workspace 附件路径）→ 记为让渡：Bot 首次切换弹框新增一条、Bot 详情的隔离说明扩写、设计 28 §6 与 13-permissions 增「读取让渡（披露）」。P5 项：评估 Codex 进程级 `sandbox_workspace_write` 的可读根限制（若 codex 版本提供）。
- **M4 Codex 模式跟踪过期**：`setMode` 同步更新 `mode` 配置项的预期值（仅当该值在选项中），`set_config_option(mode)` 同步更新模式预期（仅当模式列表含该值）。
- **M5**：桥按解析后路径去重；`ApprovalCard` 的路径列表以 index 为 key。
- **M6 租约边角**：`ProjectRuntime.ensureWriteLease` 增 `pin`，外部 run 的 project 租约整 run 不可被其他租约目标替换（再要别的目标 → `PATH_OUT_OF_SCOPE`）；桥对网关 `needs_lease` 的路径直接拒绝（不再弹卡后不取租约）。
- **L1**：卡片的 title / command 经 `secrets.redact` 并截断（200 / 2000 字符）；`renderContextLine` 把 Agent 提供的标题 / 命令 / 路径包在 `<untrusted>` 内。
- **L2**：通用 `rawInput{server,tool,arguments}` 识别只对 kind 为 other / 缺省的调用生效。
- **L3**：fetch 自动放行保持，在设计 28 §6、13-permissions、首次切换弹框与 Bot 详情中披露。
- **L4**：设置页「加载我的个人配置」下加醒目风险文案（放行规则与钩子绕过权限桥）。
- **L5**：命令文本检查在 macOS / Windows 大小写归一；`~user/…` 一律视为触及；Windows 上路径内的 8.3 短名（`KEPCUP~1`）视为触及（`HEAD~1` 这类不含路径分隔符的不受影响）。其余 8.3 / 硬链接形式仍是已知限制。
- **L6**：配置确认查询改为按 `kind='agent_tool'` + `json_extract(payload,'$.kind')='config'` + `auto_approved=0` 定向查询（`approvedAgentConfigs`），不受其他审批总量影响；删除 `approvedOfKind`。
- **新增登录实测项**：Claude Code 对 cwd 内指向外部的符号链接执行 Read / Edit 时是否不询问宿主（acceptEdits 下尤甚）——若不询问，需在 isolation 的 denyRead / 权限规则上补；Codex apply_patch 是否跟随符号链接。
- 测试：`unit/permission-bridge.test.ts`（H1 / H2 / H3 / M1 / M5 / M6 / L1 / L2 / L5 新用例）、`unit/allowlist-match.test.ts`（H2：新危险项各种写法 + 既有 `git -c` / `-C` / `find -execdir` / `sed -i.bak` 回归 + Windows）、`unit/external-agent-p2.test.ts`（M4）、`integration/external-agent-p3.test.ts`（12 → 14：无 OS 沙箱命令不走白名单、read_only 拒未识别 / 白名单命令、无人值守下相对路径 / 数据目录 cwd / 未识别请求自动拒绝、M2 内容哈希与自动批准不记住与配置写入弹卡、M6 租约钉住）。
- 本轮测试（容器内）：受影响测试全部通过（另跑契约、`external-agent-engine`、`integration/external-agent`、`agents-service`、testkit、`projects`：除基线的 6 个 `projects` 用例外全部通过）。全量 139 个文件 / 1249 用例：33 失败（8 个文件），与基线失败清单逐条一致、无新增；1214 通过、2 skipped；唯一 unhandled rejection 仍是基线 `projects.test.ts`。`pnpm -r typecheck` 0 错误（1 条既有 svelte warning），`pnpm lint` 0 问题。

#### 安全复核修复（第 2 轮，2026-10-07）

只改 `permissions/approvals.ts`、`permissions/allowlist-match.ts`、`agent/external/permission-bridge.ts`、`agent/external/providers/claude.ts` 与测试；第 6 项按复核要求一并修了 `infra/data-boundary.ts` 与几处工具输出（见下）。

1. **H3 绕过（高）→ fail-closed**：新 `unattendedCommandVerdict`（approvals.ts）+ `literalCommandSegments`（allowlist-match.ts，bash-parser）。无人值守下命令只有同时满足以下条件才自动批准，否则自动拒绝：能解析且全是去引号后的纯字面量词（无展开 / 命令替换 / 算术、无 `* ? [ ] { }`〔含引号内〕、无 `~user`、无赋值前缀 / 子 shell / 复合命令 / 后台 / 取反）；不含切换目录或执行上下文的命令（cd / pushd / popd / env / eval / source / . / exec / xargs / sudo / su / doas / chroot / 各种 shell / PowerShell 的 Set-Location、iex…）与选项（`git|make|tar|ninja|pnpm|cargo|cmake -C`、`--chdir / --directory / --cwd / --dir / --work-tree / --git-dir / --prefix / --manifest-path / --exec-path`、`-chdir`）；cwd 已知且不在数据目录内（豁免目录除外），cwd 在数据目录内（workspace）时任何含 `..` 的词即拒绝；每个词（及 `--opt=` / `-Xvalue` 的值）相对 cwd 解析后 `canonicalPath`（最长已存在前缀 realpath，跟随符号链接）不在数据目录内（豁免除外）、也不是其祖先。Windows 用简单分词（含 `` ` $ % ; | & < > ( ) { } * ? [ ] ^ ! `` 即拒）。复核者的全部绕过用例（`cd s/t && rm ../…`、`env -C`、project 下 `cd sub && rm ../../.kepcup/…`、`.kep'cup'`、`.kep""cup`、`~/.kep*`、`.kepcu?`、workspace 内 `l -> ~/.kepcup` 后 `cat l/main.db`、`"$HOME"`…）均写成测试。
   - **命令豁免目录只含本 run 的 workspace**（不含技能目录：路径请求对技能目录只读，命令可以删除它们）。agent_tool 的 locations 底线仍按 `exemptDirs`。
   - **有人值守**：卡片照常弹，命令过不了上述分析时原因栏追加「⚠ 可能触及应用数据目录 / 无法静态分析（原因）」。
   - **内置引擎影响**：`command`（逐条确认模式，沙箱不可用时）/ `unsandboxed`（`request_unsandboxed`）的无人值守底线同样改为上述规则（豁免 = 该 Bot 在该对话的 workspace）。内置 bash 平时在 srt 沙箱内执行、不经这条底线，故日常无人值守不受影响；受影响的是沙箱不可用的机器上与「沙箱外执行」申请：含通配（`ls *.py`）、变量（`$HOME`）、`cd` / `env` / `bash -c` / 子 shell、或指向数据目录的命令，在无人值守下由「自动批准」变为「自动拒绝」（Bot 收到拒绝、可改写为字面命令重试），Windows 上含 PowerShell 管道 / 变量的命令同理。宁可多拒（底线语义），已在设计 13 的底线描述范围内。`git_remote` 仍用原文本检查（参数本是字面列表）。
2. **H1 无人值守（高）**：`writeSandboxed === false`（Codex）的写卡带 `targetUncertain: true`（未进 shared schema，底线按原始 payload 读取；P4 统一时再正式化），无人值守一律自动拒绝（`agentToolUnattendedRefusal`）；有人值守卡片原因注明「真实写入目标可能与显示的路径不同」。未做「按 toolCallId 合并此前 diff 内容补全目标」（可选项，留作 P5：需要引擎把会话内 tool_call 的 content 按 id 缓存给权限桥）。
3. **H2 缺口（中）**：Claude 所有档位 `sandbox.failIfUnavailable: true`（claude.ts），沙箱不可用（Linux 缺 bubblewrap / socat、平台不支持）时整 run 失败，错误经 `toAgentError` 呈现为「智能体「Claude Agent」出错：<适配器原文>」；`execSandboxed` 的「在沙箱内」以此为前提（再无「沙箱静默缺席」的组合）。映射为对话内环境设置卡（提示安装 bubblewrap / socat）留给 P4-B 的 setup 失败分类。
4. **M2 缺口**：`hashAgentConfigFiles` 改为 fail-closed——超上限、链接指向 project 外 / 成环 / 读不到、非常规文件 → 返回一次性随机值（永不与已记住的相等，每次确认）；project 内的符号链接按 realpath 哈希被指向的内容。
5. **低（D40 内置白名单）**：短选项紧贴的路径值（`git diff -O/etc/passwd`、`grep -f/etc/x`）做路径检查（`optionValuePath`）；`git --text` 精确识别为合法只读选项（`SAFE_LONG_OPTIONS`），`--textc` 等缩写仍拒。
6. **低（`<untrusted>` 转义）**：`renderContextLine` 包裹的 Agent 文本经 `neutralizeUntrusted`；`infra/data-boundary.ts` 的 `neutralizeUntrusted` 扩为同时中和开标签 `<untrusted`（原只处理闭标签）；原先未经它的工具输出一并改用 `untrustedBlock` / `neutralizeUntrusted`：`tools/web-tools.ts`（2 处）、`tools/wiki-tools.ts`（2 处）、`tools/speech-tools.ts`、`tools/image-tools.ts`、`memory/reflection.ts`（execution_steps）。
- 测试：`unit/permission-bridge.test.ts`（复核者全部绕过用例 + 安全用例、symlink 实盘夹具、targetUncertain、卡片警示、配置哈希 fail-closed、开闭标签转义）、`unit/allowlist-match.test.ts`（`-O/etc/passwd`、`--text`）、`unit/external-agent-p2.test.ts`（failIfUnavailable）。复核脚本 `scratchpad/probe/probe.mjs` 除 `cat l/main.db`（脚本里的 `l` 在磁盘上不存在，无链接可跟随）外全部判为触及；真实链接场景由单测覆盖。
- 本轮测试（容器内）：受影响 10 个文件 135 用例全部通过。全量 140 个文件 / 1259 用例：34 失败 = 基线 33 + `integration/external-agent-p4b.test.ts`「auth_required → … retry completes」1 个（P4-B 并行会话正在改的新文件，全量跑期间被修改〔19:24〕；单独重跑 4/4 通过，与本轮改动无关）；unhandled rejection 来自基线 `projects.test.ts` 与该 P4-B 文件。`pnpm -r typecheck` 0 错误（1 条既有 svelte warning），`pnpm lint` 0 问题。



---

## 7. P4 — 用户入口

> **状态：已完成（2026-10-07）**。独立只读核查：容器全量 146 文件 / 1367 用例，33 失败与基线逐条一致、无新增；typecheck / lint 全绿；§7.1 十项实现与勾选一致；§7.4.1 / §7.4.2 两轮修复在代码中全部在位、互不冲突。§7.2 中「无 key 新用户走完 onboarding」「日志 / 库 / secrets 无凭据」为部分覆盖（core 层测试 + 静态守卫），onboarding 与设置卡 e2e、凭据内容扫描用例归 P6。遗留：`claude-acp.svg` / `codex-acp.svg` 图标待补（需确认品牌使用许可，当前回落首字母）。

### 7.1 改动清单

- [x] **core `agent/external/installer.ts`**：三种来源——`npx`（环境管理器的 Node 运行时 + npm 装锁定版本到 `toolchains/agents/{id}@{version}/`）、`binary`（下载平台归档、**sha256 校验**、解压、可执行位）、`system`（探测官方 CLI，校验版本范围）；环境管理器新增 `agent:{id}` 条目，审批卡显示体积、来源、许可与条款提示；卸载清理目录
- [x] **core `domain/agents.ts` `AgentsService`**：目录 + 本机状态合成视图（`available` / `installing` / `needs_auth` / `ready` / `update_available` / `incompatible` / `error`）、启用 / 停用 / 卸载、测试连接、登录 / 退出、读取模型 / 档位选项（缓存）；停用或卸载被 Bot 使用的 Agent 时返回受影响 Bot 列表
- [x] **登录**：按 P0 结论实现 terminal 认证 UI；`agent` 类认证走 `authenticate`；API key 类存 secrets `agent:{id}:api-key` 并按 Provider 声明的变量名注入。**禁止**读取任何 Agent 的凭据文件（写成测试：grep 代码中不出现这些路径）
- [x] **对话内设置（D58）**：setup kind `{kind:'agent', agentId, reason}`；`ExternalAgentEngine` 遇未启用 / 未安装 / `auth_required` / 版本不兼容以结构化 setup 失败结算；设置卡复用目录卡片组件；完成后自动重试原 run
- [x] **RPC**：`agents.catalog / list / enable / disable / uninstall / login / logout / test / options`；事件 `agent.status`
- [x] **desktop 设置页「智能体」**（新 `features/settings/AgentsSection.svelte`，在 `SettingsDialog.svelte` 登记）：目录卡片（图标随应用打包）、状态与操作、高级选项（使用系统 CLI、加载个人配置、并发）
- [x] **desktop Bot 运行配置**（`BotProfileForm.svelte`；Bot 详情徽标在 P4-B 完成）：主模型下拉改为分组「模型 / 智能体」；选 Agent 后展开 Agent 模型 / 推理强度 / 权限档位 / **能力包勾选**（照 MCP 勾选样式；`core` 灰显必选；「未配置」标注；显示预计工具数；「恢复默认」）；「轻量模型」在无内置模型时隐藏；首次切换弹框说明让渡项；Bot 详情徽标
- [x] **onboarding**：「配置模型」步骤增「我有订阅（Claude / ChatGPT / Copilot / GLM…）」分支 → 推荐对应 Agent → 启用 → 首个 Bot（含管家）默认使用它
- [x] **后台 loop 最小兜底**（P6 前必须有）：无内置模型时，摘要 / 反思 / 画像 / 群聊判断 / 续接 L2 优雅跳过并记日志，不报错
- [x] **i18n**：`locales/zh-CN.ts` 全部新文案（目录、状态、能力包名称与说明、条款提示）

### 7.2 验收

- 无 API key、只有 fake Agent 的新用户走完 onboarding 并对话；后台任务不报错
- 设置页启用 / 停用 / 卸载 / 登录状态流转正确；binary 来源 sha256 不符时拒绝安装
- 未启用 / 未登录 → 发消息 → 对话内设置卡 → 完成 → 原 run 续跑
- 日志、数据库、secrets 中无订阅凭据

### 7.3 实施记录（P4 A 部分：安装器 / Agents 服务 / RPC / 设置页 / Bot 运行配置 UI，2026-10-07）

- 新增：shared `domain/agent-status.ts`（状态视图与 `agents.*` zod 契约、`agentApiKeySecretName`）；core `agent/external/installer.ts`（npx / binary / system）、`agent/external/terminal-auth.ts`（登录方式归一 + terminal 命令改写）、`agent/external/acp/control-session.ts`（短命管理连接：登录 / authenticate / logout / 选项探测）、`domain/agents.ts`（`AgentsService`）、`rpc/agents-bindings.ts`；desktop `stores/agents.svelte.ts`、`features/settings/AgentsSection.svelte`、`features/settings/agent-icons.ts`、`features/bot-panel/agent-capabilities.ts`（含测试）、`resources/agents/fake.svg`（占位）；测试 `core/test/unit/agent-installer.test.ts`、`core/test/unit/agents-service.test.ts`（含凭据路径守卫与 RPC 契约）、`core/test/integration/agents-service.test.ts`。
- 追加式修改：`agent-catalog.ts`（`auth.kinds` 增 `anonymous`、`auth.apiKeyEnv`、`sizeBytes`、`system.versionRange`）、`types.ts`（环境审批载荷 `obtain` 增 `npm`、`license`、`termsNoticeKey`）、RPC methods / events；core `host.ts`（`stop(agentId)` 仅空闲时停）、`env/manager.ts`（`ensureToolchain(item)`）、`rpc/bindings.ts`、`start.ts`（装配 `AgentInstaller` / `AgentsService`，`AgentHost.resolveLaunch` 改为 `agentsService.resolveLaunch → agentLaunch 测试缝 → defaultLaunchResolver`）；desktop `BotProfileForm`、`SettingsDialog`、`shell.svelte.ts`、`ApprovalCard`（显示许可与条款）、`zh-CN.ts`。
- 实现选择：tar.* 用系统 tar；zip 用内置解析（`node:zlib`，越界路径防护，zip64 / 符号链接回落 bsdtar / unzip）；npm 安装用环境管理器的 Node 执行 `npm-cli.js install --save-exact --omit=dev`（保留 lockfile；**未加 `--ignore-scripts`**，待评估）；安装 / 登录后台进行、进度经 `agent.status` 推送（RPC 60s 超时）；terminal 登录无 TTY，只回传输出并支持向 stdin 写一行，纯 TUI 登录（如 OpenCode 选择界面）待真机验证；设置页「启用」用安装确认卡（体积 / 来源 / 许可 / 条款），`approvalPayload()` 留给对话内设置卡；登录态只在内存（重启后靠测试连接或 `_auth/status_update` 刷新）；secrets 键中目录 id 的 `.` 记为 `_`。
- 测试：相关 10 个文件 188 条通过；全量 1163 条，34 失败 = 基线 33 + `unit/web-tools.test.ts` web_fetch 5s 偶发超时（单独重跑通过）。typecheck / lint 0 问题。
- 未完成：Bot 详情徽标；对话内设置卡（orchestrator 部分）、onboarding、后台 loop 兜底（P4 B 部分）。
- 待补：图标 `claude/codex/opencode/dsh/cursor/antigravity/zcode.svg` 放 `apps/desktop/resources/agents/`；条款文案 key 统一 `agents.terms.{id}`；确认 Claude / Codex Provider 的 `launch` 透传 `target.env`（API key 注入依赖）；Windows 下 `ensureToolchain('node')` 安装宿主侧 Node 可能进入沙箱 PATH 前缀，需复核；旧版本目录到卸载时才清理。

#### 7.3.1 审查修复（第 2 轮，P4 A 部分）

- HIGH：渲染端整表回写 `settings.agents` → 新增 `agents.configure {id, loadUserConfig?, concurrency?}` 服务端逐 Agent 合并；`settings.update` 的 agents 按 id 合并、只接受 `enabled` / `loadUserConfig`；渲染端收到 `agent.status` 后刷新快照。
- 安全：入口 / 解压树拒绝越界符号链接（lstat + realpath 双检）；内置 zip 解压器自建符号链接并做包含性检查，删除 `unzip` 回落；tar 加 `--no-same-owner --no-same-permissions`；npm 改 `npm ci --ignore-scripts --omit=dev` + 白名单环境；**npx 条目随应用发布锁文件**（`core/src/agent/external/npx-lockfiles.generated.ts`，由 `scripts/generate-agent-lockfiles.mjs` 生成，缺锁文件拒绝安装，单测要求每个 npx 条目都有）；`agentVersionSchema`（semver）限制版本，`dirFor()` / marker entry 必须在安装根内。
- 生命周期：host 进程 `retiring`（登出 / 换 key / 卸载后忙进程退役、新 acquire 起新进程）、进程使用中拒绝卸载；安装任务可取消（停用 / 卸载 / dispose 中止，完成后不回写 enabled）；下载 60s 空闲超时、`pipeline` 处理写盘错误；登录进程组 kill + SIGKILL 升级、超时强制结束会话；dispose 杀登录 / 控制进程。
- 其他：登录 env 丢弃 `PATH` / `NODE_OPTIONS` / `LD_*` / `DYLD_*` / `ELECTRON_*`；`ensureToolchain` 并发等待；API key trim；跨块输出按行脱敏；secrets 键无歧义编码（`_`→`__`、`.`→`_d`）；探测去重；`options()` 需实验开关（`disable` / `uninstall` 不需要，以便关闭实验后仍可清理）；Agent 视图加载前禁用能力包勾选。
- 新测试 `unit/agents-lifecycle.test.ts` 等；全量 33 失败 = 基线。**升级 npx 目录版本时须先 build shared 再跑 `node scripts/generate-agent-lockfiles.mjs`。**

### 7.4 实施记录（P4 B 部分：对话内 Agent 设置卡 / onboarding / 后台兜底 / 徽标 / stdio-proxy 打包，2026-10-07）

**状态**：§7.1 全部勾完（project 内 `.codex/` 等 Agent 侧配置确认已由 §6.1 `#agentProjectGate` 实现并勾选，Codex `agentSideConfigFiles: ['AGENTS.md', '.codex/']` 核对无误；§3.2 Codex 一项的「加载行为」实测仍待登录 spike）。未 commit。

**改动文件**
- shared：`agent-status.ts`（`agentSetupReasonSchema` = `experimental_off / not_enabled / not_installed / auth_required / incompatible / unavailable`；`agentSetupReasonOf(view, experimental)`、`agentSetupReasonForError(code, stateReason)`——core run 门禁与渲染端发送门禁共用）；`types.ts`（`setupRequirementSchema` 增 `{kind:'agent', agentId, reason}`；`settings.defaultAgentId`）；`rpc/methods.ts`（`settings.update.defaultAgentId`）。
- core：`agent/external/catalog.ts`（`agentUnavailableReason` → `agentRunGate`：实验开关 / 目录 / AgentsService 状态视图 → `{message, reason}`，`agentSetupMessage`）；`dispatch/orchestrator.ts`（deps `agents`〔AgentsService〕；开工前门禁给结构化 setup；引擎失败码 → `#agentFailureSetup`〔先 `noteRunError` 回写登录态〕→ failed + setup；续接 L2 无模型记 debug）；`domain/agents.ts`（`noteRunError`：`AGENT_AUTH_REQUIRED` 且条目需登录 → `needs_auth` 并推送）；`domain/bots.ts`（`DefaultAgentResolver`：非访谈新建、无模型无 Agent 时填默认 Agent）；`start.ts`（装配 resolver：`defaultAgentId` 非空 + 无默认主模型 + 实验开关 + 已启用，预览档 `ask`；orchestrator `agents: agentsService`）；`rpc/bindings.ts`（`defaultAgentId` 须在目录中）；后台兜底：`memory/loop-utils.ts`（`builtinModelRefOrNull`）、`agent/loops/conversation-summary.ts`、`memory/{reflection,consolidation,profile-curation}.ts`、`wiki/lint.ts`、`skills/authoring.ts`（建 run 之前跳过 + info 日志）、`dispatch/dispatcher.ts`（triage 跳过改 info，= 仅 @ / 回复响应）；新 `agent/external/stdio-proxy-path.ts`（`resolveStdioProxyPath` / `unpackedAsarPath`）；新 `scripts/copy-assets.mjs` + `package.json` build。
- testkit：`fake-acp-agent.ts` 记录 `session_rejected`（`requireAuth` 拒绝建会话）。
- desktop：新 `settings/AgentCard.svelte`（自 `AgentsSection` 抽出的单张目录卡片，`embedded` 只留启用 / 安装确认 / 登录 / API key / 测试连接，`onTested`，`data-settings-anchor="agent-{id}"`）；`AgentsSection.svelte` 改用它；新 `chats/AgentSetupBody.svelte`（`SetupRequiredCard` 的 agent 分支：实验开关「开启」→ 内嵌 AgentCard → Agent 由不可用变可用〔登录进行中不算〕或测试连接通过即 `continueAfterSetup`，也可手动继续）；新 `chats/send-gate.ts`（+ 测试，`chat.svelte.ts` 发送门禁改用它：Agent Bot 不再被 main-model 卡误拦，改按 Agent 状态拦）；`OnboardingWizard.svelte`（「我有订阅（Claude / ChatGPT / Copilot / GLM…）」分支：说明实验功能并打开 `experimental.externalAgents` → 列 `authKinds` 含 subscription 的条目〔AgentCard 含条款提示〕→ 选用 + 让渡项告知 → 写 `defaultAgentId`；订阅分支下管家 `butler.ensure({interview:false})`）；`NoModelBanner.svelte`（默认 Agent 可用时不提示）；新 `bot-panel/AgentBadge.svelte` + `RightPanel.svelte`（Bot 详情：Agent 图标 / 名称 + 隔离说明，点击 `openSettings('agents', 'agent-{id}')`）；`zh-CN.ts`；`scripts/dist.mjs`（stdio-proxy.mjs 拷到 `out/main/core-entry/` 并校验）；`electron-builder.yml`（`asarUnpack`）。
- 测试：新 `core/test/integration/external-agent-p4b.test.ts`（实验关 → 开 → 未启用 → 启用，每步结构化 setup、门禁不启动 Agent、`runs.retry` 续跑出原消息回复；`auth_required` 剧本 → setup + `needs_auth` → 重试被门禁拦下〔无新的 session 尝试〕→ 设置卡登录〔agent 类 authenticate〕→ 重试完成；默认 Agent〔管家 / 新 Bot / 预览档 ask / 有默认主模型时不生效 / 目录外 id 拒绝〕；无内置模型：反思与摘要 job done、无后台 run）、`core/test/unit/stdio-proxy-path.test.ts`、`shared` `agent-catalog.test.ts`（原因映射、schema）、desktop `chats/send-gate.test.ts`（发送门禁）。onboarding 无组件测试先例（desktop 只有纯函数单测，e2e 归 P6），未补。
- 文档：`docs/dev/04-agent-runtime.md`（P4 B 落地要点、stdio-proxy 分发）、`docs/design/18-inline-setup.md`（agent kind）。

**协调方追加的两项（P3 第 2 轮安全修复之后）**
- **Claude 沙箱不可用 → 结构化 setup**：`AgentErrorKind` 增 `sandbox_unavailable`（`toAgentError` → 新错误码 `AGENT_SANDBOX_UNAVAILABLE`「沙箱无法启动：<原文>」）；`providers/claude.ts` `isClaudeSandboxUnavailable`（message + data 文本：提到 bubblewrap / bwrap / socat，或 sandbox + unavailable / not installed / not supported / missing / failed to start）；shared 原因增 `sandbox_unavailable`，orchestrator 经同一条映射给 `{kind:'agent', agentId, reason:'sandbox_unavailable'}`。设置卡显示安装命令（`sudo apt install bubblewrap socat` / `dnf`，与 KepCup 自身 srt 的提示同文）+ 「测试连接」通过即续跑。「改用 ask 档」的说明如实写为**不能绕过**：Claude 所有档位都是 `failIfUnavailable:true`（ask 档命令逐条确认的前提仍是在沙箱内执行），暂时装不了时改用其他智能体或内置模型。确切错误文案需登录 spike 核对（匹配宽松只影响引导文案，不放宽权限）。
- **`targetUncertain` 正式入 schema**：shared `agentToolApprovalPayloadSchema.targetUncertain?: boolean`；`permission-bridge.ts` 去掉「未入 schema」注释；`approvals.ts` `agentToolUnattendedRefusal` 改为经 schema（`pick({kind, locations, targetUncertain})`）解析后判定，解析失败一律拒绝（fail closed）；`ApprovalCard.svelte` 对它显示醒目警示 `approvals.agentToolTargetUncertain`。测试：`core/test/unit/agent-setup-errors.test.ts`（沙箱错误识别、分类 → 原因映射、auth 优先、`agentRunGate` 各原因、targetUncertain 经 schema + 畸形 payload 拒绝）。

**偏差与取舍**
- **默认 Agent 用新设置 `defaultAgentId`，在新建时写入 profile**（而非运行时回落）：Bot 配置界面与徽标看到的就是实际引擎；只在没有默认主模型时生效（配好内置模型后新 Bot 回到内置引擎），对话式访谈新建不生效——访谈工具不注入外部 Agent，只有内置模型的用户走侧栏「对话式新建」仍会得到 main-model 卡（已知限制，P6 / 访谈支持外部 Agent 后再议）。订阅分支下管家不访谈（直接欢迎语），onboarding 文案说明组队访谈需内置模型。
- **原因来源**：开工前门禁按状态视图（未启用 / 安装中或损坏 / `needs_auth` / 不兼容），run 内失败按错误码；`AGENT_UNAVAILABLE` 先看状态（未安装等）否则 `unavailable`（宿主工具桥未启动、进程启动失败等），`AGENT_FAILED` / `AGENT_PROCESS_EXITED` / 超时仍是普通失败横幅。条目已不在目录中是普通失败（只能改 Bot 配置）。P3 的「配置确认被拒」仍为普通失败（未接 setup 卡）。
- **登录态**：run 报未登录才把 `needs_auth` 写进 AgentsService（内存，重启后靠下次 run / 测试连接 / 探测刷新）；设置卡里「测试连接」通过即续跑，覆盖用户在 KepCup 外完成登录的情况。
- **后台兜底范围**：摘要、反思、记忆整理（过期失效照做）、画像整理、Wiki 巡检、技能生成在建 run 前跳过；群聊判断 / 续接 L2 / SubAgent 压缩原本就在无模型时不发请求（triage 日志从 warn 降为 info）。**Wiki 入库**（用户显式触发）保留「未配置主模型」报错。跳过的摘要 job 不推进 `summary_upto_seq`，每次响应后会再登记一次（即刻 done，代价可忽略）。
- **stdio-proxy**：与引用模块同目录分发（源码 / core dist / 打包 bundle 同一相对路径），打包时 `asarUnpack` 解出、解析函数映射到 `app.asar.unpacked`；未接线（P5 遇到只支持 stdio 的 Agent 时由引擎在 `mcpServers` 里用 `resolveStdioProxyPath()` + Electron Node）。打包产物未实际构建验证（无 electron-builder 运行），由单测核对 dist.mjs / builder 配置文本。

**测试**（容器内）：受影响测试（新 `external-agent-p4b`〔4〕、`stdio-proxy-path`〔4〕、`agent-setup-errors`、`send-gate`；`agent-catalog`、`external-agent{,-p3}`、`agents-service`、`response-loop`、`memory`、`permission-bridge`、契约）全部通过。全量第 1 轮（追加项之前）142 个文件 / 1269 用例：33 失败，与基线逐条一致。第 2 轮（合入 P3 第 2 轮修复与追加项后）143 个文件 / 1273 用例：35 失败 = 基线 33 + `memory-consolidation`（KNN 断言）与 `unit/web-tools`（web_fetch 5s 超时），两者单独重跑 2 次均通过（满载偶发，前者有 mock 模型、不经本次跳过逻辑）；unhandled rejection 仍来自基线 `projects.test.ts`。`pnpm -r typecheck` 0 错误（1 条既有 svelte warning），`pnpm lint` 0 问题。

**遗留**
- e2e（Playwright，fake Agent）：对话内 Agent 设置卡、onboarding 订阅分支——归 §9.1 e2e 项。
- 对话式新建（访谈）在仅有外部 Agent 时不可用；Wiki 入库无内置模型时报错；后台任务改用外部 Agent 跑（P6 `llm-router`）。
- 配置确认被拒的 run 仍是普通失败（可改为 setup 卡的「重试」入口）。

#### 7.4.1 审查修复（P4-B 独立审查 COMMENT，2026-10-07）

- **M1 自动续跑基线**（`AgentSetupBody.svelte`）：不再在挂载时取 `usable` 初值；Agent 状态首次加载出来（或实验开关关着）那一刻才建立基线，之后观察到的「不可用 → 可用」转变才自动续跑——重启后打开对话、store 加载完不会把旧消息自动重试（unavailable / sandbox_unavailable / 运行期 incompatible 同理）。新 requirement 到来时以当时已知状态重建基线。
- **M2 安装 / 登录后的探测**：`AgentView.probing`（shared，默认 false）；`#afterChange` 先登记探测再发布，首个发布的视图即 `probing: true`，设置卡不把它算作可用，探测结束（登录态已知）再发布一次。
- **M3 草稿**：`chat.continueAfterSetup` 在重试失败 run 之后，若有被发送门禁扣下的草稿也照常 `flush()`；同时加**一次性续跑令牌**（`#continuedSetupRunIds`）：同一失败 run 只被设置卡自动重试一次（测试连接回调后又来迟到的 ready 事件不会重放两次）。
- **M4 中途失败不挂 setup**（`orchestrator.ts` `#runProducedWork`）：run 已有 assistant / tool_call / tool_result 步骤或已发消息时，`AGENT_*` 失败一律走普通失败横幅（重试会整段重放：中间说明与文件改动重复）；只有「什么都还没做」的失败挂 `{kind:'agent'}`。
- **M5 onboarding 显式开启**：「我有订阅」先只显示说明（实验功能、改用 API key 时会关回）+「开启外部智能体（实验）并继续」按钮；实验开关由本流程打开时，「改用 API key」把它关回；选用 Agent 保存后保留。
- **m6 默认 Agent 可见可改**：设置 → 智能体增「新建 Bot 默认使用的智能体」下拉（`settings.defaultAgentId`，含生效条件说明；已停用的当前值仍列出）；停用 / 卸载默认 Agent 时一定弹确认并说明「新建 Bot 不再默认使用它」（resolver 本就只在已启用时生效，不另清除）。
- **m7**：`noteRunError` 记下时间；之后 Agent 推送的非 `none` `_auth/status_update` 覆盖这次「未登录」记录（探测 / 登录 / 测试连接重新判定时清除记录）。
- **m8**：bubblewrap / socat 安装提示只在 Linux 显示（`core.platform.platform`）；「改用 ask 档不能绕过」的说明各平台都显示。
- **m9**：`isClaudeSandboxUnavailable` 必须先匹配 `/sandbox/i`，再看依赖名或「不可用 / 未安装 / 不支持」。
- **m10**：无内置模型时群聊判断跳过的 info 日志每个 Bot 只记一次（进程内）。
- 开放问题（「测试连接」测不出沙箱缺失、沙箱错误的确切形态）已写入 §6.3「需登录实测」。
- 测试：`integration/external-agent-p4b.test.ts` 增「无输出时的 auth_required → setup；有中间说明 + 工具后的同一错误 → 普通失败」；`unit/agents-lifecycle.test.ts` 增 m7（较旧推送不覆盖、较新非 none 推送覆盖、其他错误码不记未登录）与 M2（安装完成后首个发布视图 `probing: true`、探测结束后为 false）；`unit/agent-setup-errors.test.ts` 按 m9 更新（未提 sandbox 的依赖缺失 / 「unavailable」保持普通失败）。M1 / M3 / M5 为 Svelte 组件与 store 行为，desktop 无组件测试先例，未补（e2e 归 §9.1）。
- 格式：本轮对 `orchestrator.ts`、`dispatcher.ts`（以及之前的 `approvals.ts` / `ApprovalCard.svelte`）跑了 prettier，顺带重排了这几处既有的未格式化代码（仅格式）。
- 测试结果：受影响测试 11 个文件 / 215 用例全部通过（`agent-setup-errors`、`agents-lifecycle`、`agents-service`〔unit + integration〕、`external-agent{,-p3,-p4b}`、`groups`、契约、shared `agent-catalog`、desktop `send-gate`、`permission-bridge`）。全量（容器）143 个文件 / 1276 用例：34 失败 = 基线 33 + `memory-consolidation`「合并后 KNN 检出」——该用例在本轮与上一轮全量满载时各失败一次，单独连跑 3 次（连同 `memory.test.ts`）全部通过；用例有 mock 模型，不经本次的无模型跳过分支，判断为既有的嵌入写入与 KNN 断言之间的时序竞争（该测试文件另有其他会话的格式化改动）。`pnpm -r typecheck` 0 错误（1 条既有 svelte warning），`pnpm lint` 0 问题。

#### 7.4.2 审查修复（第 2 轮，REQUEST CHANGES，2026-10-07）

- **H1 重启后自动重放旧 run**：自动续跑判定抽为纯函数 `chats/setup-continue.ts` `stepAutoContinue`——Agent 状态未加载时不建基线，首个已加载快照作基线，只对本会话内之后观察到的「不可用 → 可用」续跑（`AgentSetupBody.svelte` 改用它）；`restoredFailedRun`（`chat.svelte.ts` `select()` 改用）：带 setup 的旧失败若之后已有同 Bot 的响应 run，不再恢复为可续跑的设置卡。测试 `chats/setup-continue.test.ts`。
- **M2 整理每小时重复入队**：`memory/consolidation.ts` 无内置模型的跳过分支也写 `last_consolidation_date`。测试 `integration/memory-consolidation.test.ts` 新用例（过期失效照做、日期已记、`enqueueDueConsolidations()` 不再入队）。
- **M3 create_skill 静默跳过**：`start.ts` 的 `skills.requestAuthoring` 门面在无内置模型（Bot 模型与默认主模型都空）时直接返回 `{ok:false, message:'需要内置模型…'}`，不登记（与 Wiki 入库一致：用户显式触发的报错，后台自动的跳过）。
- **M4 既有竞态**：`consolidation.ts` `await applyOperations(...)`——合并与向量写入完成后才写日期 / 结算 job，内部错误经 catch 让 run 与 job 失败（此前满载下 `memory-consolidation.test.ts:169` 偶发失败与 unhandled rejection 的根因）。
- **m5**：选「推送非 none 时清除」——§7.4.1 m7 已实现（较新的非 `none` `_auth/status_update` 覆盖 run 失败记下的未登录；`agents-lifecycle` 有测试），文档表述据此成立。
- **m6 测试连接测不出的原因**：`unavailable`（桥未启动）/ `sandbox_unavailable` 的设置卡在测试连接通过后**不**自动续跑，只提供手动「继续」（`AgentSetupBody.svelte` `testProves`）；文案同步。
- **m7**：§7.4.1 M3 已处理（重试后若有门禁扣下的草稿也 `flush()`；一次性续跑令牌防同一失败 run 重放两次）。
- **m8 onboarding**：进入分支先说明、显式「开启并继续」（§7.4.1 M5）；返回 API key 时若用户未在分支内启用任何 Agent 才把本流程打开的实验开关关回；`agentPath` 改与 core 解析器同一判定（`defaultAgentId` 非空且无默认主模型）；API key 路径完成（保存 key / 保存默认模型）时清掉 `defaultAgentId`。
- **m9**：`permission-bridge.ts` `targetUncertain` 的卡 `durations` 只给 `['once']`（服务端 `decide` 本就按 payload.durations 把 conversation 降为 once）；`permission-bridge.test.ts` 断言。
- **m10 沙箱匹配**：claude-agent-sdk 0.3.287 的 d.ts 只说明依赖缺失时 `query()` 发错误结果后退出，确切文本在 Claude Code 本体（本机无源码）——改为只看错误 **message**，且同时含 `sandbox` 与 `bubblewrap / bwrap / socat / sandbox-exec` 之一（`data` 中的文本不算）；`agent-setup-errors.test.ts` 更新。确切文案仍在 §6.3 登录实测清单。
- 格式：误把同目录 3 个无关文件（composer-draft-persist / key-handling）纳入 prettier，已按 diff 原样回退。
- 并行注意：`shared/agent-catalog.test.ts`「ships only … Claude Agent and Codex (P2)」曾失败（并行 P5 新增目录条目），P5 已把断言更新为 7 个 id 并新增用例，现稳定通过。契约测试 `fake-alt` 的 3 个 subprocess 用例（bridge 往返 ×2、`skip_reply`）曾在一次全量中失败：子进程 fake agent 经 `testkit/bin/fake-acp-agent.mjs` 直接 import 工作树源文件，失败时段恰有并行会话批量重写 `testkit/src/fake-acp-agent.ts` 等文件——判断为读到半写文件的测试环境竞态（单跑 9 次、并发压测均通过）；**全量验证期间勿让其他会话写工作树**。
- §7.4.1 m9 的沙箱匹配描述已被本轮 m10 取代：现为只看错误 message，且须同时含 `sandbox` 与依赖名（`providers/claude.ts:64-67`）。
- 测试结果：独立核查容器全量 146 文件 / 1367 用例：1332 通过、2 跳过、33 失败（与基线清单逐条一致，无新增；唯一 unhandled error 仍为基线 `projects.test.ts` 的 `lease.waiting`）；`memory-consolidation` 全量 + 并发 + 单跑均过（M4 生效）；`web-tools` 并发下 1 次 5s 超时（真实 DNS 查询，非本次改动，单跑均过）。`pnpm -r typecheck` 0 错误（1 条既有 svelte warning），`pnpm lint` 通过。

---

## 8. P5 — 供应商扩展与体验

### 8.1 新增 Agent（每个都要：目录条目 + Provider 模块〔仅差异〕+ `PROVIDERS` 登记 + 契约测试 fake 剧本 + P0 spike 真机跑通）

- [x] **OpenCode**（`providers/opencode.ts`）：目录 binary 分发（6 个平台归档 + sha256，由导入脚本生成）；`prompt-prefix`；`OPENCODE_CONFIG_CONTENT` 只放全局项（关闭 CLAUDE.md 回退、权限：bash 一律询问、拒绝 `~/.kepcup`）；`features.osSandbox=false`（`workspace` 档命令逐条确认）；`agentSideConfigFiles: ['AGENTS.md', 'opencode.json', '.opencode/']`；条款提示「不要在 OpenCode 中登录 Claude 订阅」；会话忙时的 prompt 行为按 P0 结论处理（steering 视为不支持）
- [x] **DeepSeek Harness**（`providers/dsh.ts`）：目录 npx `@deepseek-ai/dsh@<锁定>` + `args: ['--profile','acp']`；`tier:'preview'`（默认 `ask`）；`auth.kinds:['api-key']`（`DEEPSEEK_API_KEY`，存 secrets 注入）；`features: { steering:false, loadSession:false }`；会话复用只用 `resume`
- [x] **Cursor**（`providers/cursor.ts`）：目录 binary（6 个平台，sha256 由导入脚本计算锁定）+ `args:['acp']`；认证 terminal（`agent login`）或 API key（`CURSOR_API_KEY`，存 secrets）；`prompt-prefix`；`agentSideConfigFiles: ['.cursor/rules', '.cursor/cli.json', 'AGENTS.md', 'CLAUDE.md']`；`features.osSandbox` 按 P0（未生效则命令逐条确认）；`extRequests`：`cursor/ask_question` 按 P0 结论映射为对话内问题卡（用户作答后回填）或直接返回「请自行决定」，`cursor/create_plan` 按 P0 结论自动确认或映射为卡片；无 `resume` → 会话复用用 `load`（重放静音）；条款提示「计入 Cursor 套餐额度」
- [x] **Google Antigravity**（`providers/antigravity.ts`）：目录 binary（6 个平台，sha256 由导入脚本计算锁定；审批卡显示约 1 GB 体积）；`authMethods` 过滤掉 `oauth-personal`（及 P0 确认受限的 `oauth-business`），只留 `gemini-api-key`（key 存 secrets 注入）与 `agent-platform`；`tier:'preview'`、`releaseGate`；`prompt-prefix`；`agentSideConfigFiles: ['AGENTS.md', 'GEMINI.md', '.agents/', '.gemini/']`；`features.osSandbox=false`（命令逐条确认）；档位映射：`read_only` / `ask` → `default`，`workspace` → `auto_edit`（仅放宽工作目录内编辑，命令仍询问，以 P0 实测为准）；**禁止 `yolo`**；条款提示「不要在 KepCup 中使用 Google 个人账号登录 Antigravity」。**实现偏差**：源码显示 `auto_edit` 不区分工作区内外地自动批准编辑，档位改为一律 `default` 并禁止 `auto_edit`（见 §8.3）
- [x] ~~**ZCode**~~ **已放弃**（2026-10-08，P5 实现前源码核对推翻附录 A.1 的「能完整覆盖」：app-server 模式的订阅登录要由宿主读取 / 中转用户凭据提供鉴权头，且 `edit` 模式不分工作区内外自动批准写入、用户级放行规则无法关闭）：目录不收录、不新增 `providers/zcode/`；原因见 `docs/dev/DEVIATIONS.md` DEV-008 与设计 28 §9.2。通用的 `connect(proc, client)` / `transport:'shim'` 接线保留（有测试）。
- [x] **steering**：`provider.features.steering` 为真时发 `_session/steering`（固定 `idleBehavior:'promptRequired'`），同步返回 true；被拒 / 出错 → `RunSpec.onSteerRejected` → orchestrator 放回 `#pendingSteers`（在 `#steerRunningRun` 旁加回调入口）
- [x] **run 外输出**：`load` / `resume` 重放静音；按 P0 结论关闭 Claude 后台任务
- [x] **会话复用**：`agent_sessions` 读写；指纹（会话级提示词、cwd、档位、模型、能力集合）；窗口内复用只发增量 + 触发段 + run 级动态段；按 Provider 能力用 `resume` / `load`，都不支持则新建 + D56 回放
- [x] **用量**：不加列（`provider='agent:{id}'`、费用为空）；`PromptResponse.usage` 按会话做差；缺失只记轮数；用量页单列「订阅 / 外部 Agent」；连锁预算按轮数折算
- [x] **并发**：调度器 `agent:{id}` 读 `providerConcurrency`，缺省 `AGENT_DEFAULT_CONCURRENCY`
- [x] **崩溃与生命周期**：进程崩溃 → 活跃 run `failed`、会话行保留；删除对话 / Bot → `session/delete`（尽力而为）+ 删行；删除提示说明 Agent 侧磁盘历史不归 KepCup 管理
- [x] **中间说明**：带 `parentToolUseId` 的子代理调用不切分；状态行文案取 `tool_call.title`
- [x] **长耗时桥工具**（§5.3 遗留）：超过 `AGENT_BRIDGE_TOOL_DETACH_MS` 的桥调用先应答「已转入后台」，结果在 prompt 结束后以 follow-up prompt 送回同一 run（见 §8.4）

### 8.2 验收

- 每个新增 Agent 通过契约测试（fake）并在三平台真机跑通单聊 + 一次 project 内改代码
- OpenCode：命令逐条弹卡；DeepSeek Harness：执行中追加消息在 run 结束后续投、不丢
- 30 分钟内连续两问复用会话（支持的 Agent）；杀进程后可重试、下一次正常

### 8.3 实施记录（P5 第一部分：Provider，2026-10-07）

**状态**：§8.1 的 OpenCode / DeepSeek Harness / Cursor / Google Antigravity 四项完成（目录条目 + Provider 模块 + `PROVIDERS` 登记 + 契约测试 fake 剧本 + i18n / 图标）；「P0 spike 真机跑通」需真实账号，列入下方各 Agent 的待登录实测清单。未 commit。依据：离线 spike 报告 + 下载归档后**离线阅读**其内嵌源码 / JS bundle（OpenCode bun 二进制、Cursor `dist-package/*.js`、Antigravity `.par` 内嵌 Python、`@deepseek-ai/dsh-acp` npm 包），未运行任何下载来的程序。

**目录与分发**（shared `agent-catalog.ts` 追加 4 条，`releaseGate` 各自独立）
- `opencode`（supported）：binary 6 平台，Registry 自带 sha256 已逐个下载复核一致；Registry 的 windows-aarch64 `cmd: ./opencode` 与归档实际文件 `opencode.exe` 不符，目录更正为 `./opencode.exe`。`auth.kinds: subscription / api-key / anonymous`（不经 KepCup 配 key）。
- `dsh`（preview）：npx `@deepseek-ai/dsh@0.2.0-rc.2` + `--profile acp`；锁文件经 `scripts/generate-agent-lockfiles.mjs` 生成，**只追加 dsh 一项**（重新生成时 claude-agent-acp 的传递依赖 `@anthropic-ai/sdk` 漂移，已保留原锁定树不变）。`api-key` / `DEEPSEEK_API_KEY`；`sizeBytes` 800 MB。
- `cursor`（supported）、`antigravity-acp`（preview）：binary 6 平台，Registry 无 sha256 → `node scripts/import-acp-registry.mjs cursor antigravity-acp --hash` 计算，并与独立 `curl` 下载的 `sha256sum` 交叉核对 12/12 一致（网络与磁盘允许，**全部平台已锁定**，无待生成项）。Cursor `api-key` = `CURSOR_API_KEY`；Antigravity `api-key` = `GEMINI_API_KEY`（源码：authenticate 无 `_meta` key 时回落该变量）。
- `sizeBytes` 取各平台解压后最大值：OpenCode 186 MB、Cursor 620 MB、Antigravity 1.06 GB；`nativeCapabilities` 保守填写并注释「待登录实测」（dsh / Antigravity 为空）。
- 图标：`apps/desktop/resources/agents/{opencode,cursor,antigravity-acp}.svg`（取 Registry 单色图标，套深色圆角底以适配深浅主题）、`dsh.svg`（文字占位）。
- 条款：`agents.terms.{opencode,dsh,cursor,antigravity}`（P4 已有）；Antigravity 文案改为「不要使用 Google 个人账号登录…只提供 Gemini API key 与 Vertex AI」。

**Provider 模块**（`core/src/agent/external/providers/{opencode,dsh,cursor,antigravity,mode-tier}.ts`）
- 共用 `mode-tier.ts` `switchToMode`：按 session modes 或 `mode` 类 config option 切到档位目标模式，缺失即 `AGENT_INCOMPATIBLE`（fail closed）。
- **OpenCode**：进程级 `OPENCODE_CONFIG_CONTENT`（`autoupdate:false`、`share:'disabled'`、`permission`）+ `OPENCODE_PERMISSION`（同一份权限在全部配置层——含 project 的 opencode.json——之后再合并，规则「后者匹配优先」）+ `OPENCODE_DISABLE_CLAUDE_CODE=1`（CLAUDE.md 回退与 `~/.claude/skills`）+ `OPENCODE_DISABLE_AUTOUPDATE=1`；权限：`edit`/`bash` 一律 `ask`，`external_directory` 缺省 `ask`、数据目录 `deny`（数据目录内的 workspace 作 cwd 时 cwd 本身不算 external）；字段格式取自二进制内嵌的 customize-opencode 文档与 schema。档位：read_only → `plan`，ask / workspace → `build`（config option）；权限选项 `once`/`reject`（generic 的 `allow_once` 对不上，否则放行会退化为拒绝）；`toolName = {server}_{tool}`；`execSandboxed=false`；`agentSideConfigFiles` 另加 `opencode.jsonc`；steering 不支持，load / resume 有。terminal 认证沿用 P4 `terminal-auth.ts` 的 `_meta['terminal-auth']` 改写（单测已覆盖），Provider 无需差异。
- **DeepSeek Harness**：`classifyError`：-32000 或「-32603 且 message 含 no API key」→ auth_required（任何阶段）；无 modes → `applyPermissionTier` 为显式 no-op（只靠宿主权限桥）；选项 `allow-once`/`reject-once`；`features {steering:false, loadSession:false, resume:true, osSandbox:false}`。
- **Cursor**：档位 read_only → `ask`（Q&A，无编辑 / 命令），ask / workspace → `agent`，不用 `plan`；全局禁止表的 `agent`（Codex AI 审核员语义）对 Cursor 豁免（新 `AgentProvider.safeModes`）。`extRequests`（应答形态取自 bundle 的 `acp/interaction-handlers`）：`cursor/ask_question` → `{outcome:{outcome:'skipped', reason:'用户当前不在线…自行决定…'}}`；`cursor/create_plan` → `{outcome:{outcome:'rejected', reason:'…把计划写进回复并在当前权限下继续…'}}`——**不自动 accepted**：那等于替用户声明已审阅同意，而 KepCup 没给用户看过；拒绝不改变任何权限。其余 `cursor/*` 请求立即 -32601（Cursor 自有回退）。桥识别：MCP `tool_call` 的 `rawInput{providerIdentifier, toolName}`（仅 kind other）+ generic 回落。`agentSideConfigFiles: ['.cursor/', 'AGENTS.md', 'CLAUDE.md']`（`.cursor/` 覆盖 rules、cli.json、mcp.json、hooks，比清单更宽）；`osSandbox=false`；无 resume → load。
- **Antigravity**：`authMethods` 白名单只留 `gemini-api-key` / `agent-platform`（`oauth-personal`、`oauth-business`〔是否受限待合规确认，保守过滤〕、rollout 中的 `gateway` 及未来新增一律不出现）；**私有 `GEMINI_HOME`**（`{数据目录}/agents/antigravity-acp/gemini-home`）：源码显示客户端不调 authenticate 时它按 `$GEMINI_HOME/antigravity-acp/settings.json` 的 `auth.type` 推断登录方式，共用 `~/.gemini` 会让用户在别处选过的 `oauth-personal` 静默生效——私有 home 同时隔离全局 MCP 配置合并、全局 hooks 与信任表。**工作区信任**：不设 `AGY_ACP_DISABLE_WORKSPACE_TRUST`（设了 = 信任所有工作区，project 的 hooks.json 在沙箱外自动执行）；ACP 会话加载 hooks 不弹询问，未知信任的工作区 hooks 被抑制（私有 home 下即全部抑制）。**档位一律 `default`**——偏离设计稿「workspace → auto_edit」：源码显示非 Enterprise 登录下 `auto_edit` 自动批准所有文件编辑工具、**不区分工作区内外**，等于工作区外任意写入免确认；改由宿主权限桥在 workspace 档放行 cwd 内写入，效果相同而可控。`forbiddenModes: ['auto_edit','yolo']`（新 `AgentProvider.forbiddenModes`，Agent 自行切入会被引擎切回并审计）。选项 `allow`/`deny`；桥识别 `_meta.mcp.{server,tool}` + `is_mcp_tool_call`（权限请求与 tool_call 都带）；`clientInfo` 由宿主如实填 KepCup。

**共享代码的追加式修改**
- `types.ts`：`LaunchContext.dataHome?` / `stateDir?`；`AgentProvider.forbiddenModes?` / `safeModes?`。`permission-bridge.ts` `isForbiddenAgentMode(modeId, provider?)`；`engine.ts` 4 处调用传入 Provider（全局表不变，未传 Provider 时行为不变）。
- `host.ts` / `domain/agents.ts`：deps 增 `dataHome?`、`stateDirFor?`，传给 `provider.launch`（run 进程与探测 / 登录控制进程一致）；`start.ts` 装配 `paths.home` 与新 `infra/paths.ts` `agentStateDir(paths, id)` = `{home}/agents/{id}`。
- `installer.ts`：新 `hasPinnedSha256`；`managedKindFor` 对 sha256 缺失 / 非法的平台返回 null（状态 `incompatible`「本平台暂无可用的安装方式」），`#installBinary` 再守一道（拒绝下载）。
- testkit `fake-acp-agent.ts`：MCP 镜像结构化名新增 `antigravity_meta` / `cursor_raw_input` / `opaque`（只有自由文本 title）。契约 `agent-provider.contract.ts`：`mirrorNameIn` 同步；`opaque` 目标的桥用例不发镜像，桥工具权限请求预期为拒绝（无结构化名不自动放行）。

**测试**：契约新增 4 个目标（各 16 例：fake 剧本模拟认证形态 / 权限选项 id / 模式 / 镜像名位置）；新 `unit/agent-providers-p5.test.ts`（19 例：Provider 登记、禁止模式与豁免、OpenCode 进程配置与档位与匿名会话、dsh 错误分类〔-32603 各阶段 → AGENT_AUTH_REQUIRED〕与 run 结算、Cursor 扩展请求立即应答且 run 内外都不悬挂、Cursor 档位、Antigravity 过滤 / 档位 / 自行切 auto_edit 被切回 / 私有 GEMINI_HOME / 桥识别、安装器拒绝未锁定 sha256 的平台且不下载）；新 `integration/agents-p5.test.ts`（Antigravity 被过滤方式在 `agents.list` 与 `agents.login → authenticate` 两端均无法触发，只有 gemini-api-key 被 authenticate，探测 / 控制进程均带私有 GEMINI_HOME 与 key；OpenCode 未登录即 `ready`、run 报未登录也不下线）；shared `agent-catalog.test.ts` 目录形态。全量与基线对比见文末。

**待登录实测清单**
- OpenCode：`OPENCODE_CONFIG_CONTENT` / `OPENCODE_PERMISSION` 实际生效（`opencode debug config`）、`edit`/`bash` 逐条发 `request_permission`、数据目录 `external_directory` 拒绝；`plan` 模式与 `question` 工具在 ACP 下的表现；`opencode auth login` 在无 TTY 子进程下能否完成（选择界面是 TUI，P4 已记）；匿名免费模型可用性；MCP 工具的 ACP 镜像无结构化名 → 宿主桥工具会多一条原生步骤（考虑按 toolCallId 关联）；会话忙时再发 prompt 的行为；用户全局 `~/.config/opencode` 配置仍生效（设置页提示）；原生工具名。
- DeepSeek Harness：配 key 后的权限请求覆盖面（写入 / 命令是否都发请求，决定 read_only 能否成立）与自身沙箱；安装器 `npm ci --ignore-scripts` 下 `node-pty` / `koffi` / `@deepseek-ai/dsh-subprocess-local`（install 脚本：prebuild、spawn-helper 可执行位）是否可用——不可用则需为该条目放开受控的 install 脚本；冷启动 77 s 的预热（安装器尚无 postInstall 钩子 → **遗留**）与首个 run 超时放宽；`AGENTS.md` 等 project 配置读取范围；原生工具名；resume 复用。
- Cursor：`cursor_login`（ACP `authenticate` 自行开浏览器）与 `CURSOR_API_KEY` 两种登录；ACP 模式下 Landlock / Seatbelt 是否生效（生效则可把 `osSandbox` 置真）；`agent` 模式下写入 / 命令 / MCP 是否都发权限请求、`.cursor/cli.json` allowlist 是否会绕过；MCP 权限请求无结构化名 → 桥工具审批可能逐条弹卡；`toolName` 写法（模型侧 MCP 工具名）与 `providerIdentifier` 是否等于 ACP server 名；ask_question / create_plan 的拒绝应答对模型行为的影响（是否改为对话内问题卡）；Windows `.cmd` 入口；原生工具名。
- Antigravity：`gemini-api-key` 流程（存 key → 选方式 authenticate → 私有 settings.json 记住 → 后续进程推断）；`agent-platform` 需要 `GOOGLE_API_KEY` 或 `GOOGLE_CLOUD_PROJECT`/`_LOCATION` + ADC，宿主环境白名单目前不透传，需设计配置入口；`default` 模式下每个工具都发请求的频度（读工具是否也弹）；`oauth-business` 合规结论；`--uid=` 参数含义；Linux 1 GB 解压在内置 zip 解压器（整文件读入内存）下的内存峰值；Windows 支持；MCP 工具在模型侧的名字（SDK `call_mcp_tool` 派发）；原生工具名。

**遗留**
- dsh 安装后预热（需安装器 postInstall 钩子）；dsh 原生依赖与 `--ignore-scripts`。
- steering / 会话复用 / 用量 / ZCode 垫片属 P5 其他部分（本次各 Provider 的 `features` 已按实测填写供其使用）。
- 内置 zip 解压器对 300 MB+ 归档整读入内存（Antigravity Linux），考虑流式解压。

#### 审查修复（P5 第一部分独立审查 REQUEST CHANGES，2026-10-07，分支 t/d72-p5-2「D72 P5-1 审查修复」）

依据：p5prov 下载产物的离线阅读（OpenCode 1.18.35 二进制内嵌源码 `Config.loadInstanceState` / `ConfigPaths.directories` / `Instruction.systemPaths`；Cursor `dist-package/index.js` 的 `cursor-config/paths`；未运行任何二进制）。

- **H1 OpenCode 权限可被配置覆盖** → `providers/opencode.ts` 重写进程级配置：
  - `OPENCODE_DISABLE_PROJECT_CONFIG=1`：源码确认它同时关掉 project 的 opencode.json、`ConfigPaths.directories` 里 project 的 `.opencode/`（agent / mode / command / plugin，也就不再往 project 里后台装 `@opencode-ai/plugin`）与 project AGENTS.md 指令 → `agentSideConfigFiles` 改为 `[]`，AGENTS.md 由宿主 `<project>` 注入（不再需要配置确认卡）。
  - 权限块只用字符串动作（`edit` / `bash` / `external_directory` / `task` 一律 `ask`）——不依赖 remeda mergeDeep 的键序与 `findLast`；同一块写顶层、`agent.{build,plan,general,explore}.permission`（`plan` / `explore` 的 `edit` 保持 `deny`）与 `mode.{build,plan}.permission`（mode 在 CONTENT 之后并入 agent），顶层再经 `OPENCODE_PERMISSION` 合并。数据目录 deny 规则（对象写法）去掉：工作目录外路径一律 ask，数据目录由宿主权限桥拒绝（与网关同一底线）。`task: ask` 让自定义子代理（`~/.opencode/agent/*.md` 等）只能经宿主裁决启动。
  - `!loadUserConfig` 时 `XDG_CONFIG_HOME` = `{数据目录}/agents/opencode/xdg-config`（登录凭据在 `XDG_DATA_HOME`，不受影响）；没有私有状态目录时拒绝启动（fail closed）。`OPENCODE_PURE=1` 不加载外部插件（沙箱外任意代码）。新增 `LaunchContext.loadUserConfig`（host 经 `loadUserConfigFor`、AgentsService 控制进程读 settings；`agents.configure` 改它时已有的 `host.stop` 让进程按新值重启）。
  - project 配置确认（P3 闸门，对所有 Provider）改为从 project 向上查到 git worktree 根（OpenCode / Codex 都向上找），卡片原因文案加「可能放宽智能体的权限」与「含项目上层直到 git 根目录中的同类文件」。
  - 残留（无配置项）：全局配置目录（私有目录或用户的 `~/.config/opencode`）与 `~/.opencode` 仍被后台安装 `@opencode-ai/plugin`；`~/.opencode/` 仍被读取（HOME 不改，否则命令里的 git 等失去用户身份）——条款提示已说明。
  - 测试：`agent-providers-p5.test.ts` 新增「配置层模型」用例（按源码顺序以 mergeDeep 叠加用户全局 / project / `~/.opencode` 的放宽配置后，四个内置 agent 的有效 bash / external_directory / task 仍为 ask）；P3 集成新增 git 根向上查找用例。
- **H2 dsh 权限请求只带 `{toolCallId}`** → 引擎记录每个调用的 `tool_call` / `tool_call_update` 字段（kind / title / name / rawInput / locations / content / _meta，每 run 上限 500 条），权限请求交权限桥前按 ACP「请求的 toolCall 即 ToolCallUpdate」补全（请求自带字段优先），对所有 Agent 生效。fake agent 增 `permission.bare`；单测覆盖。
- **H3 dsh 在 `--ignore-scripts` 下 spawn-helper 无可执行位** → 目录 `distribution.npx.postInstall.chmodExecutable`（相对安装根、段可为 `*`、schema 拒绝 `.` / `..` / 绝对路径），安装器 `npm ci` 后只对匹配的**普通文件** chmod 0755（符号链接、目录、经符号链接目录逃出安装根的一律跳过），不放开任何脚本；dsh 条目登记 `node_modules/node-pty/prebuilds/*/spawn-helper`。**需 Mac 真机验证**（Linux 预编译是否同样需要、koffi 是否另有安装步骤）。
- **M1 Agent 进程 cwd 为共享 /tmp** → `infra/paths.ts` `ensureAgentProcessCwd` = `{数据目录}/agents/{id}/cwd`（0700），AgentHost（`processCwdFor`）与 AgentsService 控制进程共用；Cursor 从进程 cwd 向上找 `.cursor/cli.json` 不再落到可被他人写入的 `/tmp`。
- **M2** 注册表不变量测试（所有 `safeModes` ⊆ 全局禁止表且不在自身 `forbiddenModes`，只有 Cursor 为 `['agent']`）；Cursor `!loadUserConfig` 时 `CURSOR_CONFIG_DIR` 指向私有目录（用户 `~/.cursor/cli-config.json` 的命令 allowlist 不生效；`auth.json` 路径不随它变化——**待登录实测**登录态是否保留），条款提示披露。
- **M3** Antigravity `agent-platform` 在配置入口完成前从白名单隐藏（只留 gemini-api-key；UI 与 authenticate 两端测试更新）。**M4** 私有 `GEMINI_HOME` 取不到时抛错（不再回落共享临时目录）。
- **LOW**：dsh 未配 key 判定精确匹配 `no API key for provider route`；安装下载进度不再把解压后大小 `sizeBytes` 当总字节数（改用响应头长度）；OpenCode 后台插件安装写入在条款提示说明。
- 测试：新 `unit/agent-review-p5-1.test.ts`（不变量、Cursor 隔离、dsh 精确匹配与只带 id 的请求、chmod 钩子、进程私有 cwd）；契约测试 harness 提供 `stateDirFor`（配置隔离类 Provider 无私有目录即拒绝启动）。

### 8.4 实施记录（P5 第二部分：体验与 ZCode，2026-10-07，分支 `t/d72-p5-2`）

**状态**：§8.1 的 steering / run 外输出 / 会话复用 / 用量 / 并发 / 崩溃与生命周期 / 中间说明，以及 §5.3 遗留的长耗时桥工具完成；ZCode 放弃（下方小节）。另含 P5 第一部分独立审查的修复（§8.3 末尾「审查修复」）。

**改动文件**
- core `agent/external/engine.ts`（重写 run handle）：prompt 阶段机 `before / prompting / between / done`；会话打开 `#openSession`（同进程复用 → `session/resume` → `session/load` → 新建）；`#attachBridge` 支持沿用会话 token；`#prompt` + `#recordUsage`；follow-up 循环；`steer` / `#sendSteering`；`discardSession`；权限请求按 tool_call 更新补全（审查 H2）。`AcpEventMapper`：子代理（`parentToolUseId`）调用与文本、状态行 `title`、轮数计数、`finishInterim`。
- core `agent/external/acp/client.ts`：`ACP_STEERING_METHOD` / `advertisesSteering`、`loadSession` / `resumeSession`（重放静音）/ `deleteSession` / `extMethod`；`host.ts`：进程内保留会话（`openSession` / `keepSession` / `forgetSession`，进程退出即清空）、`AgentHost.openSession` / `forgetSession`、`processCwdFor` / `loadUserConfigFor`；`mcp-bridge.ts`：`detachAfterMs` / `onToolDetached` / `onDetachedResult`、`detachedToolNotice`；`types.ts`：`AgentProvider.usageSemantics` / `bridgeToolDetachMs`、`connect(proc, client)`、`LaunchContext.loadUserConfig`；`capabilities.ts` `hostServerNameFor`。
- core `agent/types.ts`：`RunSpec.promptParts.conversationDelta`、`ExternalRunSpec.session`、`onSession(id, mode)`、`AgentSessionMode`、tool_call payload `title?`；`step-persistence.ts`：状态行用 title；`agent/context/conversation.ts` `buildConversationDelta`。
- core `domain/agent-sessions.ts`（新，`AgentSessionsStore`）；`dispatch/orchestrator.ts`：`#agentRunSetup` 读 `agent_sessions`、按候选行派生桥名并算指纹、增量对话段；`#recordAgentSession` / `touch`、内存 seen-state（`baseCutoff` + 单独展示过的消息；应用重启后没有就不复用，见下方审查修复）；`#onAgentSteerRejected`；`agentSessionsOn{ConversationDeleted,BotDeleted,GroupMemberRemoved}`；project 配置确认向上到 git 根（审查 H1）。`domain/lifecycle.ts` + `start.ts`：删除级联接入。
- core `scheduler/scheduler.ts`（`agent:` 缺省并发）、`domain/usage.ts`（`sumForRuns` 轮数折算、`entriesSince` 带 provider）、`rpc/bindings.ts`（`usage.summary` 的 `agentId` / `turns`）；`providers/claude.ts`（进程级 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` / `CLAUDE_CODE_DISABLE_CRON`、`usageSemantics:'turn'`）、`providers/codex.ts`（`usageSemantics:'turn'`）。
- shared：`constants.ts`（`AGENT_TURN_BUDGET_TOKENS` 10 000、`AGENT_BRIDGE_TOOL_DETACH_MS` 45 000）、`ids.ts`（`ags_`）、`domain/types.ts`（用量条目 `agentId` / `turns`）。
- desktop：用量页「订阅 / 外部 Agent」分表（`UsageSection.svelte`）；删除对话 / Bot 确认框对使用外部智能体的 Bot 追加「智能体自己的会话记录不归 KepCup 管理」；i18n。
- testkit `fake-acp-agent.ts`：steering 应答（`injected` / `promptRequired` / `startedNewTurn` / 错误）、`echo_steers`、turn `usage`、`resume` / `sessionDelete` 能力与观测、`permission.bare`。
- 测试：新 `unit/external-agent-p5.test.ts`（25）、`integration/external-agent-p5.test.ts`（3）、`unit/agent-review-p5-1.test.ts`；更新契约（tool_call 带 title）、`integration/external-agent.test.ts`（准备期到达的消息并入 prompt）。

**设计要点与偏差**
- **steering**：只在 prompt 进行中、Provider `features.steering` 且 Agent `initialize._meta.steering(.supported)` 时发 `_session/steering`；应答 `injected` 才记 steer 步骤，`promptRequired` / 出错 → `onSteerRejected`；`startedNewTurn`（codex-acp 2.1.1 **忽略** `idleBehavior`，无进行中 turn 时自开新 turn——源码核对）→ 立即 `session/cancel` 该 turn 再交还。偏差：prompt 发出**之前**（会话建立中）与 follow-up 之间到达的消息不论 Provider 是否支持 steering 都并入下一个 prompt（同步返回 true）——这比「run 结束后另起 run」更贴近内置引擎；run 在发出 prompt 前失败时交还。orchestrator 记录每个交给外部 run 的批次，被拒时 run 未释放 → `#pendingSteers`（释放时续投），已释放 → 直接投递邮箱。
- **run 外输出**：`session/load` / `session/resume` 期间该会话的 `session/update` 在连接层静音丢弃（不逐条记日志），会话在返回后才挂 run；其余 run 外更新沿用 P1（丢弃 + 日志、桥 403）。Claude 后台任务：claude-agent-sdk 0.3.287 内置 CLI 认 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`（二进制字符串核对），另关 `CLAUDE_CODE_DISABLE_CRON`（Cron 工具会在 run 外自主触发 turn，且宿主语义要求定时用 `schedule`）。
- **会话复用**：
  - 指纹 = sha256(会话级提示词、cwd、档位、模型 ref、effort、能力集合、**工具名集合**、桥名、loadUserConfig)。工具集合入指纹：Agent 连接 MCP 时缓存 `tools/list`，而 `buildResponseTools` 的结果随 run 变化（如被委派 run 无 `delegate_to_bot`）。
  - **桥名由 `agent_sessions` 行 id 派生**（`kepcup_` + sha256(id) 前 8 位）而非新增列：main 迁移 0018–0020 被 D73 预留且迁移号必须连续，本批不加 main 迁移；换会话 = 新行 id = 新桥名。
  - 引擎另比较「会话选项哈希」（Provider `sessionNew` 的 `_meta`〔含 Claude 沙箱 / disallowedTools / 系统提示词〕、额外 MCP、桥名、工具名、cwd），不一致就关掉旧会话新建——指纹之外的 run 级差异（技能目录变化引起的隔离设置等）也不会沿用旧会话。
  - 复用（同进程）不重设档位 / 模型（指纹保证不变），从保留状态恢复模式守卫的期望值；resume / load / 新建都重设。resume / load 失败 → 新建（对话段回落为完整上下文 + D56 回放）。
  - 增量对话段 = 会话 seen-state 的 `baseCutoff` 之后、至触发批最大 seq 为止、未单独展示过（steer）、不在触发批、不是本 Bot 回复的消息；超出最近 120 条窗口或 seen-state 未知 → 不复用（经审查修复后的口径）。
  - 桥 token 随会话：新建 / resume / load 时签发（`issueSessionToken` 吊销同键旧 token），复用时沿用；run 结束只解绑；会话被替换 / 删除 / 进程退出 / 中毒时吊销（中毒 = 超时、取消后 Agent 不应答、建会话后出错）。
  - 窗口 `CONTINUATION_WINDOW_MS`（30 分钟）从上次 run 结束算；`AGENT_IDLE_SHUTDOWN_MS`（35 分钟）后进程退出，下次 run 走 resume / load。
- **用量**：规范注释写「across session」，但核对源码 claude-agent-acp 0.86.0 在 turn 激活时清零累计器、codex-acp 2.1.1 报 `lastTokenUsage`——均为**本 turn** 口径 → `AgentProvider.usageSemantics`（Claude / Codex `turn`，缺省 `session` 做差；数值回退视为 Agent 重新计数；resume / load 后的首次报告只作基线）。缺失 → 每个模型轮一条零 token 账本行（「只记轮数」= 行数；不加列）；`sumForRuns` 对 `provider like 'agent:%'` 且零 token 的行按 `AGENT_TURN_BUDGET_TOKENS` 折算，`tokensSoFar` 运行中按轮估算。用量页把 `agent:{id}` 行单列（智能体 / 轮数 / token，费用不显示）。
- **并发**：`Scheduler.concurrencyFor('agent:{id}')` 无覆盖时取 `AGENT_DEFAULT_CONCURRENCY`（2），不再落到全局 default。
- **崩溃与生命周期**：进程崩溃 → 活跃 run failed（P1 已有）、行保留，下次 resume / load；删除对话 / Bot / 移出群 → 引擎 `discardSession({deleteHistory:true})`：会话仍开在活进程里才 `session/delete`（Agent 声明 `sessionCapabilities.delete`）或 `session/close`，正被 run 占用则在释放时删除；进程不在时不为删除专门拉起进程（尽力而为，记入偏差）；删行。确认框文案说明 Agent 侧磁盘历史不归 KepCup 管理。
- **中间说明**：带 `_meta.claudeCode.parentToolUseId`（或通用 `_meta.parentToolUseId`）的调用不切分、不落步骤，只发状态行 `子任务：{title}`；子代理文本忽略。原生调用的 `tool_call` 步骤带 `title`（与 toolName 不同时），状态行显示它。
- **长耗时桥工具（选择：提交后转入后台 + follow-up，而非 SSE + progress）**：理由——Codex 的 MCP 超时无法经 ACP 调整，progress 是否重置其超时无法离线确认，而转后台不依赖客户端行为。桥对超过 `bridgeToolDetachMs`（缺省 `AGENT_BRIDGE_TOOL_DETACH_MS` 45 s，Provider 可设 null 关闭）仍在执行的调用先应答「已转入后台…完成后结果会作为新消息发给你」（该调用的 `tool_result` 步骤即此通知，配对不变），工具继续执行且不再受 HTTP 请求取消影响（只受 run 取消）；prompt 结束后 run 不结算：本轮文字作为中间说明（`toolUse`）发出，等所有后台调用完成，再以 `<background_tool_results>` 的 follow-up prompt 在同一会话、同一 run 内继续（run 仍可 waiting_approval，审批卡不会因超时被取消）。期间到达的 steer 也并入 follow-up。

#### 审查修复（P5-2 独立代码审查 + 安全审查 REQUEST CHANGES，2026-10-08，提交「D72 P5-2 审查修复」）

1. **保留会话的可信度（H）**：模式纠偏超过上限或改回失败 → 会话中毒；run 结算后 / run 外收到偏离期望的 `current_mode_update` / `config_option_update` → run 内标记中毒，run 外由 AgentHost 路由直接遗忘 + `session/close` 并通知失效。`#release` 只在「档位已设定（或复用时已复核）+ prompt 已发出 + 未中毒 + 未被删除」时 keepSession，否则 forget + close + `onSessionInvalidated`（orchestrator 删 `agent_sessions` 行，不再 resume / load）。复用分支在 prompt 前幂等重设期望模式（`set_mode` / `set_config_option`），被拒即关闭并新建。run 持有期间会话从保留集合中取出、释放时放回（忙碌会话不被并发 run 复用）；`lease.detach` 只移除本 run 的 sink。orchestrator 只在 `onPromptSent`（新回调）后才提交 seen-state、只在 prompt 发出后 `touch`。
2. **seen-state 取代高水位 cutoff（H）**：`AgentSeen = {baseCutoff, ids}`——新会话 = 上下文最大 seq；增量 run 之后 = 触发批最大 seq；steer 批次按 id 记入 `ids`（被拒则移除），不再抬高 cutoff；增量 = `baseCutoff < seq ≤ 触发批最大 seq`、不在 `ids` / 触发批、非本 Bot。群聊里未 @ 本 Bot 的消息不会再被 steer 跳过。
3. **重启后（M）**：不再用上次 run 的触发 / 输出消息回推（输出消息会把中间消息算成已见）；seen-state 只在内存，应用重启后不复用（新会话 + 完整上下文 + D56 回放）——无迁移方案。
4. **后台等待有上限（M）**：等待与 `AGENT_RUN_TIMEOUT_MS`（自 run 开始）竞速，到期中止后台调用（桥 `detachedSignal`）并以 `error_code="TIMEOUT"` 的结果 follow-up；排队的 steer 立即唤醒等待并单独 follow-up（不必等工具完成）。
5. **增量上界（M）**：`seq ≤ 触发批最大 seq`，准备期间到达的消息不进本次增量（之后经 steer 或下一批）。
6. **Codex `startedNewTurn`（M）**：引擎按会话计数进行中的 prompt（任意 run），只有为 0 时才 `session/cancel`。
7. **OpenCode 通配（M）**：核对 1.18.35 `Permission.fromConfig`（对象键序展开）/ `merge`（拼接）/ `evaluate`（`findLast`，权限名通配匹配）；各层权限块以 `"*":"ask"` 打头，点名放行工作区内只读与会话内部工具（read / list / glob / grep / lsp / todo*），`question` / `plan_*` 拒绝，写入 / 命令 / 工作目录外 / 子代理 / 联网一律 ask。残留：若用户层（仅「加载我的个人配置」或 `~/.opencode`）在同一 agent 对象里把 `"*"` 键放在 `edit` 之后，plan / explore 的 `edit` 由 deny 变为 ask（仍交宿主裁决，测试断言「从不 allow」）。
8. 状态行 / progress 文本经 `secrets.redact`（tool_call 的 title、子任务状态行、权限说明）；只带 id 的权限请求状态行用合并后的标题。
9. `#settle` 即解绑桥（结算后的桥调用 403）。
10. follow-up 中工具名只保留安全字符、内容里的 `<tool_result` / `<background_tool_results` 标签被转义。
11. 后台结果的 `errorCode` 写入 follow-up（`error_code`）；后台结果的终止语义（skip_reply）**不再结束 run**（Agent 已收到「已转入后台」并继续，由它决定），记为决定。
12. 被拒 steer 的 Bot 已删除 / 已移出 / 对话只读 → 不再投递。
13. 删除级联后：`#recordAgentSession` 不为已删对话 / Bot 写行；`touch` 与 seen-state 只对仍存在的行。
14. 撤回：core 目前没有撤回入口（`messages.status='recalled'` 仅为枚举，无 RPC / 写入方），无处挂钩；增量渲染已排除 recalled 消息。撤回功能落地时须调用会话失效（记入遗留）。
15. `chmodInstalledFiles`：零匹配记 warn（安装器新 `logger` 依赖），`realpathSync` 失败跳过。
16. 累计用量回退判定只看 input + output 总和（缓存字段缺失不触发），差值不为负。
17. OpenCode `XDG_CONFIG_HOME` 影响其执行的命令（gh / git 等读 `~/.config` 的工具）：条款提示中披露。
18. 进程退出（崩溃 / 空闲退出 / 停止）时 AgentHost 通知 `onSessionsLost`，引擎吊销这些保留会话的桥 token（文档与实现一致）。

- 测试：`unit/external-agent-p5.test.ts` 新增 13 例（中毒 / run 外模式变化 / 未发 prompt 不保留 / onPromptSent / 复用前重设模式与被拒 / 忙碌会话不并发复用 / 进程退出吊销 token / 后台等待截止与 steer 唤醒 / follow-up 转义与错误码 / 用量回退 / 结算后桥 403 / startedNewTurn 两种情形 / 状态行脱敏）；`integration/external-agent-p5.test.ts` 新增 4 例（未展示消息进入下一次增量、准备期间到达的消息不进本次增量、重启后不复用、Bot 删除后被拒 steer 不投递）；`agent-providers-p5`（OpenCode `"*"` 规则 + `{"bash":"allow","*":"allow"}` 层）、`agent-review-p5-1`（chmod 零匹配 / 根不存在）。fake agent 增 `steeringDelayMs` / `rejectModes`。

#### 复审修复（P5-2 复审 COMMENT，2026-10-08，提交「D72 P5-2 复审修复」）

1. **崩溃保留会话行（M）**：`sink.onClosed` 记下「进程已不在」（另以 `AcpConnection.isClosed`——连接关闭时同步置位、先于挂起请求被拒——兜住 prompt 先失败、onClosed 后到的时序）。进程不在时：会话不保留、桥 token 吊销、不 `session/close`，**不**通知失效（行保留，下次 run 经 resume / load 恢复）；只有 run 在崩溃前已因自身原因中毒才删行。按原因：中毒 = run 超时、取消后不应答（宽限计时器）、会话设置调用超时（#10）、活着的 Agent 在建会话后出错（catch 且连接未关）、模式纠偏超限 / 改回失败、run 外偏离期望模式；崩溃 / 进程退出 = 不中毒。测试：orchestrator 级「prompt 中途崩溃 → 行与 agent_session_id 不变 → 下一问 `session/resume` 同一会话、只发增量」；引擎级「崩溃不触发 onSessionInvalidated」。
2. **复用分支先占有再等待（M-）**：同进程复用时，在任何 await 之前就把会话归本 run——从保留集合取出、立即 `#attachBridge`（沿用 token）并挂上 sink（`AgentHost.openSession` 报 busy → 并发的 `discardSession` 记入 `discardOnRelease`，释放时删除）、`#sessionId` 已设（之后任何失败经 `#release` 关闭 + 失效 + 吊销保留的 token，绑桥失败时也吊销）。复核被拒时解绑、吊销、关闭（若期间被删除则按删除处理且不重复失效）后新建。测试：复核期间 discard → 释放时 `session/delete`、不失效；桥停掉后复用 → 失败 + 关闭 + 失效。
3. `#steerRejected` 在 `between` 入队后 `#wakeDetached()`（被拒的 steer 立即单独 follow-up）。测试：后台等待中被拒的 steer 立即进 follow-up。
4. **follow-up 受 run 截止约束**：首个 prompt 用整段 `AGENT_RUN_TIMEOUT_MS`；follow-up 用 `max(min(AGENT_FOLLOW_UP_MIN_MS〔5 分钟〕, T), 开始时间 + T − now)`。后台等待到截止（或进入 follow-up 时已过截止）后只发一次报告超时的 follow-up 即结算，之后到达的 steer 由 `#release` 交还。测试：follow-up 在剩余预算处超时；截止后只发一次 TIMEOUT follow-up。
5. AgentHost 新增 `setKeptSessionGuard`：run 外的 `current_mode_update` / `config_option_update` 只有偏离保留状态里的 `expectedMode` / `expectedModeOption` 时才弃用会话（与 run 内守卫同口径，无期望值不算偏离；未设守卫时仍一律弃用）。测试：重复期望模式的通知不弃用、下次复用。
6. 与 1 一致：进程退出（不在 prompt 中，如等后台工具）时会话不保留、token 吊销、行保留。测试：等后台工具时进程退出 → 401、无失效。
7. `#recordAgentSession` 增加群成员检查（与被拒 steer 投递共用 `#botInConversation`）。测试（orchestrator 级）：`session/new` 期间 Bot 已不在群（绕过级联模拟竞态）→ 不写行。
8. **OpenCode 用户层通配（安全，先核对后修复）**：只读核对 1.18.35 内嵌源码（未运行、未读凭据）：各层经 remeda `mergeDeep`（`{...r,...a}`：已有键保持原位置、新键追加末尾）合并；`OPENCODE_PERMISSION` 在全部层与 `mode.*`→`agent.*` 之后合并，但同样不重排、且只作用于顶层；`fromConfig` 按键序展开、`merge` 拼接、`evaluate` 为 `findLast` + 通配匹配（`b*` / `**` / `*` 都匹配 `bash`）；每个 agent 的规则 = 默认 → agent 内置 → 顶层 → `agent.<name>.permission`。`ConfigPaths.directories` 恒含 `~/.opencode`（与 `OPENCODE_DISABLE_PROJECT_CONFIG` / `XDG_CONFIG_HOME` 无关，只有测试钩子 `OPENCODE_TEST_HOME` 能移走）：其中 `opencode.json(c)`、`{agent,agents}/**/*.md`、`{mode,modes}/*.md` 的 frontmatter、`{tool,tools}/*.{js,ts}`（`OPENCODE_PURE` 不管，执行不经权限确认）都会被读；开启「加载我的个人配置」时另有 `$XDG_CONFIG_HOME/opencode/` 的 `config.json` / `opencode.json(c)` / 旧版 TOML `config` 与同样的子目录。**结论：漏洞成立**——最简单的是 `~/.opencode/opencode.json` 写 `{"mode":{"build":{"permission":{"b*":"allow"}}}}`（mode 并入 agent 时 `b*` 追加在我们 `agent.build.permission` 的所有键之后）；或在 agent 级把 `"*"` 与点名键放在前面再加通配键。没有任何配置 / 环境机制能让宿主的层「最后且按我们的键序」生效 → 修复为**启动前扫描、fail closed**：`opencodeUserConfigIssues` 扫上述用户可写层（含私有配置目录），任何对非只读权限（只读 = read / list / glob / grep / lsp / todoread / todowrite，按名精确匹配；通配键一律算非只读）的 `allow`（含嵌套 pattern、整个 `permission:"allow"`、`tools:{x:true}`）、markdown frontmatter 中出现 `allow` 或 `tools` 下的 `true`（不做完整 YAML 解析，宁严）、自定义工具代码、旧版 TOML、无法解析的文件 → `launch` 抛 `AGENT_INCOMPATIBLE`，列出文件与键。只 ask / deny 的用户层不受影响（模型测试：无论键序都不会产生 allow）。`opencode.ts` 头注释中「内置 agent 的权限被上面的块覆盖」的错误说法已更正。**残留**（不在扫描范围）：登录 OpenCode 控制台且有活跃组织时的远程组织配置、`auth.json` 中 wellknown 远程配置（读取须碰凭据文件，宿主不读；组织配置在我们的层之后合并）、管理员的 `/etc/opencode`（root 管理，在我们之后合并）；另：1.18.35 没有 `list` / `todoread` / `codesearch` 工具（这些键无效但无害），`write` / `apply_patch` 归入 `edit`。
9. 文档：design 28 第 16 行、`docs/design/README.md`（28 行、D72 行）、`09-tech-stack.md` 的 ZCode 改为已放弃并列入 DEV-008 的已更新文档；design 28 §7「中断 / 删除」、「会话复用」与 dev/04 的中毒原因按 1 / 2 / 4 / 5 / 10 重写。
10. 会话设置调用有上限：`#sessionCall` 包住档位映射（`setMode` / `setConfigOption`）、复用复核与模型 / effort 设定，`AGENT_SESSION_CALL_TIMEOUT_MS`（30 s）未应答 → TIMEOUT（复核 / 档位：run 失败、会话中毒 → 关闭 + 失效 + 释放租约；模型 / effort：同样失败而非「仅警告」）；run 取消时立即放弃等待（race `#toolAbort`），保证 `start()` 的 finally / `#release` 总会执行。测试：复用复核挂起 → TIMEOUT + 失效 + 租约释放；档位切换挂起 → TIMEOUT；挂起中取消 → 立即 cancelled 且进程不再被占用。fake agent 增 `hangModes` / `modeDelayMs` / `newSessionDelayMs`。
11. **Codex `startedNewTurn` 与进行中 prompt 的取舍（记录）**：会话上有任一 prompt 在途（本 run 的 follow-up 或后到的 run）时收到 `startedNewTurn` 不发 `session/cancel`（否则取消的是那个 prompt），只把 steer 交还 orchestrator 续投；此时 codex-acp 自开的 turn 可能已处理过这段文字，续投后**同一段文字可能被处理两次**（其输出若落在 run 外则被丢弃）。宁可重复也不误取消真实 prompt；待 Codex 登录实测确认 `startedNewTurn` 在 prompt 在途时是否会出现。

- 测试：`unit/external-agent-p5.test.ts` 新增 10 例（崩溃不失效 + resume、等后台时进程退出、复核期间 discard、绑桥失败、被拒 steer 唤醒、follow-up 剩余预算、截止后单次 follow-up、重复期望模式不弃用、复核挂起超时、档位挂起超时 / 取消）；`integration/external-agent-p5.test.ts` 新增 2 例（崩溃后 orchestrator 级 resume 同一行、移出群后不写行）；`unit/agent-providers-p5.test.ts` 新增 1 例（合并模型证明 `mode.build` 的 `b*`、agent 级 `**` / `b*` 会胜出、只 ask / deny 的层无论键序都不放行；`~/.opencode/opencode.jsonc` 的 `b*`（加载个人配置开 / 关）、agent markdown 的 `"**": allow`、自定义工具、个人全局配置的 `**` 与 `tools.bash`（仅开启时扫描）、私有目录里无法解析的文件都拒绝启动），原「宽松层」用例改为共享合并模型并更名（只覆盖我们点名键的层仍输给宿主规则）。以上新增用例在修复前的代码上均失败（逐一回退核对）。

**ZCode：放弃**（详见 `docs/dev/DEVIATIONS.md` DEV-008）
- 实现前逐项核对 v3.14.3 源码（只读，经两个只读调研子任务 + 主线复核）：线格式为无 `jsonrpc` 字段的 NDJSON（schema strict），无 initialize，`session/create`（必填 `workspace.workspacePath/workspaceKey`，可显式 `mode`、`mcpServers` 含 http + headers + `timeoutMs`）→ 必须 `session/subscribe` 才推 `session/event`；`session/send` 立即 ACK，turn 经 `model.streaming`（`text_delta` / `reasoning_delta`，`part.delta` 实际不发）、`tool.updated`（scheduled / started / progress / result / error，`parentToolCallId` / `source:'subagent'`）、`turn.completed{resultType}` / `turn.failed` 推送；`session/stop` → `turn.completed{resultType:'cancelled'}`；反向请求 `interaction/requestPermission`（应答严格为 `{decision:'allow'|'deny', reason?}`，按 `params.requestId` 去重——服务端会以新 id 重发）；`session/requestRuntimePreferences` 回 -32601 即用缺省；未登录 / 无模型 → `turn.failed`（`turnPhase:'model_creation'` 或 `error.code:'provider_not_configured'` / `model_request_auth_missing`）。会话 / 流式 / 取消 / 权限请求 / 未登录识别都可映射。
- **决定性阻断**：app-server 不读 `zcode login` 的凭据（进程级 Provider Registry 无 standalone 账号源），账号模型的配置由宿主经 `provider/updateAccountConfig` 推送、每次模型请求前经反向请求 `interaction/requestProviderRuntimeHeaders` 向宿主索取鉴权头——KepCup 接入就必须读取 / 中转用户凭据（违反 design 28 §9.1）。
- 次要：`edit` 模式不分工作区内外自动批准写入（只能 read_only → `plan`、ask / workspace → `build`）；`build` 前仍会被用户级 `~/.zcode/cli/config.json` allowedTools、SQLite「在此项目中始终允许」规则、用户级 hooks 放行，无关闭开关；无 OS 沙箱。
- 处理：目录条目、垫片、`locateSystem` 定位钩子等半成品均未提交；保留并以单测覆盖通用的 `createShimChannel` + AgentHost `transport:'shim'` 接线（无 `connect` 的 shim 条目在拉起进程前即 `AGENT_INCOMPATIBLE`）。

**待登录实测**
- Claude：`_session/steering` 的 `injected` 时序与 `steered: …` 回复；`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` / `CLAUDE_CODE_DISABLE_CRON` 经 SDK 传到 CLI 后确实禁用；`session/resume` 带 `_meta`（系统提示词、sandbox）后行为；`PromptResponse.usage` 的口径；`deleteSession` 删除磁盘 transcript。
- Codex：steering `injected` 与 `startedNewTurn` 后取消的效果；resume 后 `mcp_servers`（新 token）是否重连；`lastTokenUsage` 口径；后台通知后模型是否会结束本轮等待 follow-up（还是反复调用）。
- 各 Agent：follow-up prompt 的措辞是否被模型正确理解；45 s 阈值对 Claude（其 MCP 超时较长）是否偏保守（可设 `bridgeToolDetachMs: null`）。

---

## 9. P6 — 无 API key 的后台 loop + 收尾

### 9.1 改动清单

- [x] **`ExternalAgentEngine.complete()`**：一次性精简会话（Claude：替换式 `systemPrompt` 字符串、`tools: []`、`settingSources: []`；其他：只读档；均用空临时目录作 cwd）；只输出 JSON；结束即 `session/close`；复用 `structured.ts` 文本 JSON 回退 + zod + 重试 1 次（重试提示「只输出 JSON」）
- [x] **`agent/llm-router.ts`**：`resolveForBot(bot, purpose)` / `resolveDefault(purpose)` → `{ engine, modelRef }`：有内置模型 → 内置；否则 → `settings.backgroundAgentId`（默认第一个 `ready` Agent）；改造调用点（triage、续接、摘要、反思、整理、画像、Wiki、技能生成、SubAgent 压缩），替换 P4 的「跳过」兜底
- [x] **设置页「后台任务」**：选用 Agent / 关闭；仅外部 Agent 时反思 / 摘要每 `AGENT_BACKGROUND_EVERY_N_RUNS` 次一跑，技能生成默认关，续接 L2 保持关闭，群聊判断超时视为 `no_action`（可选「群聊仅 @ 响应」）
- [ ] **原生优先遵守度回归**：对每个 Agent 跑 P0 的遵守度用例，结果记入设计 28 §9.2（不达标的 Agent 在其 Provider 中加强点名措辞，或把该补位包默认值改为不注入）——**harness 已完成（§9.3），真机运行需真实账号登录：待用户执行**（`node packages/core/scripts/agent-spike/adherence.mjs --runs 10`）
- [x] **文档同步**：`docs/dev/02/03/04/05`、`PROGRESS.md`、设计 28 状态与适配矩阵实测值
- [x] **e2e**（Playwright，fake Agent）：设置页目录启用、Bot 切换 Agent 与能力包、`agent_tool` 审批卡、对话内 Agent 设置卡、onboarding 订阅分支
- [ ] **人工跨平台验收**（真实账号，**待用户执行**，开发会话不代为登录）：macOS / Windows / Linux × 本期全部 Agent：启用、登录、单聊、能力包注入、project 内改代码 + 回退、越界审批、steering（支持者）、群聊混合引擎、委派

### 9.2 验收

设计 28 §13 的 10 条全部满足；内置引擎回归全绿。

### 9.3 实施记录（P6，2026-10-08，分支 `t/d72-p6`，基于 b576eac）

**提交**（每项一个）：P6-1 `complete()` + 后台精简会话；P6-2 `llm-router` 与调用点；P6-3 设置「后台任务」；P6-4 原生优先遵守度 harness；P6-5 e2e + core 测试缝 + 凭据扫描用例；P6-6 文档。

**1. `ExternalAgentEngine.complete()`**（`agent/external/engine.ts`、`providers/claude.ts`、`external/types.ts`、`agent/types.ts`、`agent/structured.ts`）
- `RunSpec.external.background`：引擎强制只读档、`mkdtemp(os.tmpdir()/kepcup-agent-bg-*)`（0700）作 cwd（忽略 `workdir`，release 时删除）、不复用（忽略 `session`，结束 `session/close`）；会话 sink 不带 `requestPermission` → P1 规则（只放行本 run 的桥工具，其余拒绝，无审批卡、无人值守安全）；`SessionContext.oneShot` → Claude `_meta.systemPrompt` 为替换式字符串、`claudeCode.options.tools: []`、`settingSources: []`（个人配置也不加载），`disallowedTools` / 沙箱 / `allowDangerouslySkipPermissions:false` 照旧。其余 Provider 不变（宿主已强制只读 + 临时 cwd + 无桥；进程级配置如 Codex `CODEX_CONFIG` 沿用进程）。
- `complete(req)` = 用上述 run handle 跑一个 prompt：`tools: []`（不挂桥）、`promptParts.session = systemPrompt`（meta-append 进 `_meta`，否则前置段）；时限 `min(runTimeoutMs, AGENT_COMPLETE_TIMEOUT_MS=3min)`、`AGENT_COMPLETE_MAX_TURNS=3`；`req.signal` → `handle.abort` → `session/cancel`；失败按引擎错误码抛 `AppError`（未登录 `AGENT_AUTH_REQUIRED` 等，取消 `TIMEOUT`）；`usage` = 各轮之和（未报 token 返回零 token 用量，账本照记一行）；`toolCalls` 恒空。进程经 AgentHost 正常租用 / 空闲退出。
- `completeStructured`：`agent:` 模型不下发 `submit`，`jsonOnlyInstruction(parametersSchema)` 追加到系统提示词（说明 submit 在此不可用、直接输出参数 JSON）；文本 JSON 回退 + zod；重试提示「只输出 JSON」。
- 测试：`unit/external-agent-p6.test.ts`（临时 cwd 新建且删除、两次调用两个会话都 close、无桥、Claude meta、用量、失败码、取消、后台 run 不经权限桥）；`external-agent-engine.test.ts` 原「refuses complete()」改为未知 Agent → `AGENT_UNAVAILABLE`。

**2. `agent/llm-router.ts`**
- `LlmRouter.resolveForBot(bot|id|null, purpose)` / `resolveDefault(purpose)` → `{engine, modelRef, provider, agentId}`；`purpose` ∈ triage / continuation / summary / reflection / consolidation / profile_curation / wiki_maintenance / skill_authoring / subagent_compaction。内置取法逐一沿用 P6 前各调用点（见 04-agent-runtime「P6 落地要点」），保证内置引擎零回归。无内置模型 → `backgroundTasks.agentEnabled` 且实验开关开 → `settings.backgroundAgentId`（须 `agentRunGate` 通过，否则跳过、不换用别家）或自动（**扩展**：先该 Bot 自己的 Agent，再目录顺序第一个就绪的；Bot 自己的 Agent 时沿用其模型）；续接 → 只用内置；技能生成需 `agentSkillAuthoring`；群聊判断在 `groupMentionOnly` 时跳过。`admit()`：Agent 路由上反思（按 Bot）/ 摘要（按对话）每 `AGENT_BACKGROUND_EVERY_N_RUNS=5` 次放行一次（进程内计数，重启从头计；摘要跳过的消息留给下一次）。
- 调用点：群聊判断（`dispatcher.triageOneBot` 新 `router` 入参；超时照旧 `no_action`）、续接 L2 仲裁、SubAgent 结果压缩（`SubagentFacadeInput.lightEngine`）、摘要（直聊按其 Bot 选 Agent）、反思、整理（无路由仍只做过期失效）、画像、Wiki 维护（lint / ingest）、技能生成 + start.ts 的 `requestAuthoring` 预检；`routeFor(deps, …)` 让未装配路由器的旧调用方 / 单测保持「只用内置」。Wiki / 技能的 Agent 路由用 `backgroundRunSpec`（后台精简会话 `startRun`，维护 / 起草工具经宿主桥，`runs.engine/provider = agent:{id}`）。`JobsRunner.#providerFor` 按路由取调度器并发键。P4 的 `builtinModelRefOrNull` / `mainModelRef` / `reflection.lightModelRef` 删除。
- 用量：后台调用记 `provider='agent:{id}'`（零 token 行照记）；连锁预算本就折算；**每日后台预算 `BudgetService.usedToday` 同样把 `agent:` 零 token 行按 `AGENT_TURN_BUDGET_TOKENS` 计**（否则订阅 Agent 的后台 loop 永不触顶）。
- 设置（JSON 设置行，**无迁移**）：`backgroundTasks {agentEnabled=true, agentSkillAuthoring=false, groupMentionOnly=false}`；`backgroundAgentId` 语义改为 ''/缺省 = 自动；`settings.update` 对 `backgroundTasks` 部分 patch 合并，`backgroundAgentId` 须在目录中。
- 测试：`unit/llm-router.test.ts`（内置取法逐用途、Agent 选择、降配、降频、`backgroundRunSpec`、无路由器回退；triage 经 Agent：并发键 / 只输出 JSON / 用量 `agent:alpha`、超时 `no_action`）；`integration/external-agent-p6.test.ts`（只有 fake Agent：反思 + 摘要一次性会话完成、用量行、每日预算折算、第二次反思被降频；设置开关与 RPC 校验；Wiki 巡检经后台会话 + 宿主桥写页面、`runs.engine`；**数据目录凭据扫描**〔P4 遗留：API key 登录 + 对话 + 后台调用后，数据目录任何文件都不含明文 key〕）；`external-agent-p4b.test.ts` 的 P4 兜底用例改为「后台任务关闭时」。

**3. 设置「后台任务」**：`apps/desktop/.../settings/BackgroundTasksSection.svelte`（智能体分区，实验开关打开时显示）：用于后台的智能体（自动 / 已启用的 Agent〔不可用的标注〕/ 关闭）、降频说明、允许生成技能、群聊仅 @ 响应；有内置模型时提示暂不生效。i18n `agents.background.*`。

**4. 原生优先遵守度回归**（真机待登录）：
- `packages/core/test/support/native-first-wording.ts` 按 Provider 生成产品措辞（`buildExternalAgentTools` 的「[补充能力]」前缀 + `buildAgentToolPolicy`，server 名固定 `kepcup_adherence`）→ `scripts/agent-spike/fixtures/native-first-wording.json`；`unit/native-first-wording.test.ts` 保证 fixture = 产品措辞（`KEPCUP_UPDATE_WORDING=1` 重新生成）并以 spike 假 Agent 跑通 harness（无需登录）；契约测试新增用例：每个 Provider 经引擎 + 宿主桥实际送达 Agent 的 `<tool_policy>` / 工具描述与 fixture 一致。
- spike 新 step `adherence`（web / vision〔Agent 声明图片时〕两个用例，按产品方式下发：meta-append → `_meta.systemPrompt.append`，否则前置段）+ `adherence.mjs`（逐 Agent 调 spike、汇总 `adherence-summary.md`，可直接贴设计 28 §9.2）。**需要真实账号：用户登录后运行 `node packages/core/scripts/agent-spike/adherence.mjs --runs 10`（dsh 加 `-- --pass-env DEEPSEEK_API_KEY`），结果贴设计 28 §9.2；不达标的 Agent 调 Provider 措辞或补位包默认值。**

**5. e2e**（`apps/desktop/test/e2e/external-agents.spec.ts`，4 例）：设置页开实验开关 + 目录启用（安装确认卡）+ 后台任务关闭 → Bot 切换智能体（让渡说明框）+ 能力包（core 必选、勾掉图像生成、工具数变化、桥上不再列出）→ 对话由假 Agent 回复；`agent_tool` 审批卡（越出数据目录与 workspace 的写入 → 卡片列出路径 → 批准 → Agent 收到 allow 并继续）；对话内 Agent 设置卡（停用后发消息 → 门禁扣下草稿 + 设置卡 → 卡内启用 → 自动发出 → 回复）；onboarding「我有订阅」（开启 → 只列订阅登录条目 → 启用 fake-sub → 选为驱动 → 管家由它驱动并回复）。core 测试缝 `KEPCUP_FAKE_ACP_AGENT_BIN/_SCRIPT/_RECORD`（`__KEPCUP_TEST_HOOKS__` 守卫，打包剔除）：目录 `fake` 与额外 `fake-sub`（订阅登录）以 Electron 的 Node 跑 testkit 假 Agent。运行：本机 glibc 2.35 跑不了 Electron e2e → 在 `kepcup-test:trixie` 派生镜像（加 xvfb / xauth / CJK 字体，`kepcup-test:trixie-xvfb`）里 `xvfb-run` 运行，见下「验证」。

**验证**：`pnpm -r typecheck` 0 error（1 条既有 svelte warning）；`pnpm lint` 0 problem；容器全量测试（`kepcup-test:trixie`，`node scripts/run-tests.mjs run`，即 `pnpm test` 的实际命令）153 文件 / 1454 用例：1418 passed、2 skipped、34 failed——其中 33 条与环境基线逐条一致，另 1 条为负载下偶发超时（两次全量各出现一条不同的：`agents-service`「agent-type login」、`memory`「两个 Bot 同时产生画像提案」，单独各跑 3 次均通过）。e2e（派生镜像 `kepcup-test:trixie-xvfb` + `xvfb-run`）：`external-agents.spec.ts` 4/4 通过，连同 setup-card / onboarding / group-chat / memory / direct-chat 共 21/21 通过；全量 e2e 65 例 62 通过，3 例失败均为容器环境所致、与 P6 无关（`sandbox.spec` 命令状态行与 `wiki.spec` URL 来源：容器内沙箱自检失败 → 逐条确认模式 / 沙箱内抓取失败，同 `wiki-url` 集成测试的基线失败；`browser.spec` 删除 Bot 后的分区目录断言）。`agents-service`「agent-type login」单独复跑 10/10 通过。注意：容器里直接 `pnpm test` 会触发 pnpm 的依赖状态检查并尝试 `pnpm install`（容器无 Python，原生模块构建失败，会破坏 worktree 的 `node_modules/.bin`）；应直接跑 `node scripts/run-tests.mjs run`。`integration/agents-service.test.ts` 的「agent-type login」在全量负载下偶发失败（logout 与登录后探测竞态，单跑 3/3 通过，与 P6 无关，P4 既有）。

**偏离**：无硬偏离。两处在设计允许范围内的取舍已写进设计 28 §8：自动选择先用 Bot 自己的 Agent；指定的后台 Agent 不可用时跳过而不换用别家。

**需要人工 / 真实账号**：原生优先遵守度真机运行（上文 4）；§9.1 末项三平台人工验收；各 Agent 登录后的 P0 spike（§3）。

#### 9.3.1 P6 审查修复（2026-10-08，分支 `t/d72-p6`）

先合并 `t/d72-p5-2` 的 86fb460（P5-2 复审修复，冲突只在 engine.ts 的常量 import），合并后容器全量与基线 33 条逐条一致。随后一个提交「D72 P6 审查修复」（含测试）。以下决定由协调会话按「保守优先」作出，**均为待用户确认的默认**（设计 28 §8 同步）：

- **S1 后台会话无原生工具**：Provider 新能力 `backgroundNoNativeTools`（`external/types.ts`），本期只有 Claude 声明（`tools: []` + `settingSources: []`，会话级）；testkit 假 Agent（`releaseGate:'testkit'`，剧本化、无原生工具）同样合格（`providers/index.ts` `backgroundToolFree`）。`llm-router.ts` `agentBackgroundBlocker(settings, entry)`：不能关原生工具 / 开启了「加载我的个人配置」/ 并发 < 2 → 不参与后台路由，原因经 `AgentView.backgroundBlocker` 在设置「后台任务」中逐个列出（选项也标「暂不可用」）。引擎第二道防线：后台会话（`complete()` 与 `external.background`）落到不合格 Provider 时直接 `AGENT_UNAVAILABLE`。OpenCode：离线核对 1.18.35 内嵌源码，`Permission.disabled` 对「末条命中规则为 `"*"` + deny」的工具直接从工具表下架，`"*":"deny"` + `"{server}_*":"allow"` 理论上可做到只留宿主桥工具；但其权限是进程级配置（`OPENCODE_CONFIG_CONTENT`），需另起一个干净的后台进程（AgentHost 进程变体），且用户层只读权限键会以 mergeDeep 键序留在前面——本期不做，记为后续项。其余 Agent 未核实，不可用于后台。
- **S2 不跨厂商**：「自动」只用该 Bot 自己的 Agent（不可用即跳过，**不再**回落目录第一个就绪的——撤销 §9.3「偏离」中的扩展）；画像整理（跨 Bot 全局画像）与群聊摘要等无所属 Bot 的任务只在 `backgroundAgentId` 明确指定时运行；`agentEnabled` 默认仍为 true。设置页说明写明发给所选厂商的内容（Bot 记忆、全局画像、对话内容与摘要、Wiki 资料）与额度消耗。
- **S3**：`KEPCUP_FAKE_ACP_AGENT_BIN/_SCRIPT/_RECORD` 加入 `apps/desktop/scripts/dist.mjs` 构建期探针与 `pack-hooks.cjs` `FORBIDDEN_MARKERS`。
- **S4**：凭据扫描用例注明范围（数据目录明文文件与日志；数据库静态加密，另经已打开的连接检查解密后的 `settings.value_json` 与全部 `run_steps.payload_json` 都不含 key）。
- **C1**：调度器对 `agent:*` 键的 priority-2 任务只在「在用数 < 并发-1」时启动（为 priority 0/1 留一个名额；并发 1 时不预留——路由器不把后台任务派给并发 1 的 Agent，已排队的仍能跑完）；新常量 `AGENT_BACKGROUND_RUN_TIMEOUT_MS`（10 分钟）封顶后台 `startRun`。
- **C2 群聊判断**：`backgroundTasks.groupMentionOnly` 默认改为 **true**（经 Agent 的群聊判断须用户关掉此项）；Agent 路由时限 `AGENT_TRIAGE_TIMEOUT_MS`（60 s，超时 `no_action`）；`admit(route,'triage','bot:conv')` 节流：同一 Bot 同一群每 `AGENT_TRIAGE_MIN_INTERVAL_MS`（2 分钟）至多一次，期间仅 @ / 回复；计入每日后台预算（`usedToday` 计入 `agent:` 的 triage 行，预算用完路由器即跳过该 Bot 的 Agent 群聊判断；内置模型的群聊判断仍不计，理由：便宜且有 20 s 上限）。
- **C3**：`completeStructured` 对 Agent（jsonOnly）只在 `StructuredParseError` 时重试；调用失败 / 超时 / 取消直接抛出（每次重试是一整个订阅会话）。
- **C4**：`JobsRunner.#providerFor` 只在路由到 Agent 时用 `agent:{id}`，内置路由保持 P6 前的键；摘要任务按 `conversations.get(conversation_id)?.directBotId` 取 Bot（与摘要 loop 一致）。
- **C5 / C11**：Agent 路由的直聊摘要行与记忆整理行记在所属 Bot 名下（`recordLoopUsage` 新可选 `botId`），`JobsRunner` 也按所属 Bot 检查每日预算并推迟；画像整理 / 群聊摘要无所属 Bot，不计入任何 Bot；内置路由的归属不变。零 token 行的折算口径写进 `BudgetService.usedToday` 注释与设计 28 §8（每行一轮：`complete()` 每次调用一行，多轮也按一轮）。
- **C6**：设计 28 §8 / 设置页说明改为：私有临时 cwd 只说明工作目录不是 workspace，不等于读不到用户文件——后台会话没有原生工具，只能经宿主桥工具（受网关约束）访问。
- **C7**：`BackgroundTasksSection.svelte`：按全局主 / 轻量模型逐用途提示哪些仍走内置模型（只有轻量模型时画像整理 / Wiki / 技能生成仍走 Agent）；保存失败把选择框复原为已保存的值；`backgroundAgentId` 指向目录外的 Agent 时仍渲染一项（「不在目录中」）；列出已启用但不能用于后台的 Agent 及原因。
- **C8**：降频计数回到 0 即删除（不再无限积累键）；群聊节流表按间隔清理。
- **C9**：e2e `enableFakeAgent`：选「关闭」后断言两个降配项都随保存消失，并关闭、重开设置页确认选择框仍为「关闭」（取自已保存设置）。
- **C10**：`AgentHost.onDispose()`；后台会话（`complete()` / 后台 run）在核心关闭时以 `AGENT_UNAVAILABLE` 结算并删除临时目录（不发事件），已关闭后的新调用立即失败；对话 run 照旧不结算。
- 测试：`unit/llm-router.test.ts`（自动只用自己的 Agent / 画像需明确指定 / 合格条件 / 群聊默认不跑 + 预算 + 节流 + 60 s 时限）、`unit/scheduler.test.ts`（agent 名额预留、并发 1 不预留）、`unit/external-agent-p6.test.ts`（不合格 Provider 拒绝后台会话、核心关闭中途 reject 且删临时目录、jsonOnly 失败不重试）、`integration/external-agent-p6.test.ts`（摘要行归属 Bot、预算 2 轮、自动下画像 / 群聊摘要不跑、个人配置使 Agent 不合格且视图带原因、凭据扫描查解密后的设置与 run_steps）。

**验证（审查修复）**：`pnpm -r typecheck` 0 error（1 条既有 svelte warning）；`pnpm lint` 0 problem；合并 86fb460 后与本提交后各跑一次容器全量（`node scripts/run-tests.mjs run`）：153 文件，失败恰为基线 33 条（逐条一致，本提交后 1440 passed / 2 skipped）；e2e（`kepcup-test:trixie-xvfb` + `xvfb-run`，宿主机先 build shared / core / desktop）`external-agents.spec.ts` 4/4 通过；按 dist.mjs 同参数（`__KEPCUP_TEST_HOOKS__=false`）离线 esbuild core-entry，三个 `KEPCUP_FAKE_ACP_AGENT_*` 标记均不在产物中。注意：容器里 `npx playwright` 会挂起，改用 `./node_modules/.bin/playwright`。

---

## 10. 并行调研项（不阻塞本方案）

- [ ] **OpenAI「Sign in with ChatGPT」token sharing**（`developers.openai.com/siwc`）：若获批，ChatGPT 用户可不换引擎直接用内置 loop。确认闭源桌面应用审批要求、pi-ai 的 Responses API 支持、token 存储要求
- [ ] **GLM Coding Plan / DeepSeek key 走内置引擎**：增加对应 vendor 描述符（`vendors.ts`），并确认套餐条款是否允许第三方应用使用
- [ ] **社区 Agent**：运行时同步 ACP Registry + 通用 Provider + 默认 `ask` 档的产品形态与风险
- [ ] 在 KepCup 的 WSL 发行版 / 增强沙箱中运行外部 Agent（恢复硬隔离）

## 11. 新增 Agent 操作手册（交付后长期使用）

1. 若在 ACP Registry 中：`node scripts/import-acp-registry.mjs <id>` 生成目录条目骨架；否则手写条目（`transport:'shim'` 时需写垫片）。
2. 补扩展字段：`provider`、`tier`、`nativeCapabilities`、`auth`、`terms`；图标放 `apps/desktop/resources/agents/`。
3. 用 spike 脚本对真机跑一遍，按报告决定：与通用实现无差异 → `provider:'generic-acp'`；否则在 `providers/` 新建模块只覆盖差异（`launch` / `instructionMode` / `sessionNew` / `applyPermissionTier` / `permissionOptions` / `toolName` / `features` / `agentSideConfigFiles`）。
4. 在 `PROVIDERS` 登记；为契约测试写该 Agent 的 fake 剧本（基于 spike 录制的更新序列）。
5. 补 i18n 与条款提示；更新设计 28 §9.2 适配矩阵。
6. 合规确认（登录 / 计费方式的第三方使用条款）后进入目录。

## 12. 文件路径速查（预期会碰）

| 区域 | 文件 |
|---|---|
| shared | 新 `domain/agent-catalog.ts`、新 `domain/host-capabilities.ts`、`domain/types.ts`（botRuntime.agent / settings / approvalKind / run）、`constants.ts`、`rpc/methods.ts`、`rpc/events.ts` |
| core 引擎 | 新 `agent/external/{engine,host,mcp-bridge,permission-bridge,installer,stdio-proxy.mjs}.ts`、新 `agent/external/acp/client.ts`、新 `agent/external/providers/{index,generic-acp,claude,codex,opencode,dsh,cursor,antigravity}.ts`、`providers/zcode/`（门禁）、新 `agent/llm-router.ts`、`agent/types.ts`、`agent/pi-engine.ts`（抽出工具结果共用函数）、`agent/context/system-prompt.ts`、`agent/structured.ts` |
| core 编排与其他 | `dispatch/orchestrator.ts`、`dispatch/dispatcher.ts`、`scheduler/scheduler.ts`、`tools/index.ts`、`gateway/index.ts`、`permissions/approvals.ts`、`project/service.ts`（调用方）、`env/`、新 `domain/agents.ts`、`domain/lifecycle.ts`、`memory/*`、`wiki/maintenance.ts`、`skills/authoring.ts`、`rpc/bindings.ts`、`start.ts` |
| 迁移 | `migrations/main/0017_external_agents.sql`、`migrations/runs/0005_run_engine.sql` |
| 脚本 | 新 `scripts/import-acp-registry.mjs`、新 `packages/core/scripts/agent-spike/` |
| testkit / 测试 | 新 `fake-acp-agent`、新 `packages/core/test/contract/agent-provider.contract.ts` |
| desktop | 新 `features/settings/AgentsSection.svelte`、`SettingsDialog.svelte`、`features/bot-panel/BotProfileForm.svelte`、`features/onboarding/OnboardingWizard.svelte`、`features/approvals/ApprovalCard.svelte`、`features/chats/RunStatusLine.svelte`、`resources/agents/`（图标）、`locales/zh-CN.ts` |

## 13. 风险与注意

- **条款风险（最高）**：Anthropic 政策 2026 年内多次变动；只拉起官方二进制、只走官方登录、不碰凭据；目录条目可随应用更新下线。Claude Agent 开发期按启用处理，发行范围由 `releaseGate` 在发行前决定；Cursor / Antigravity 为专有软件，条款不明确的同样加门禁；OpenCode 中禁止登录 Claude 订阅。
- **Antigravity 封号风险**：其条款明确禁止第三方软件经个人 Google 账号访问且牵连 Gemini CLI 账号；Provider 必须过滤 `oauth-personal`，并有测试保证 UI 与 `authenticate` 都无法触发它。
- **厂商扩展请求**：Cursor 等 Agent 会发阻塞式扩展请求，客户端不应答就卡住；宿主对未处理请求一律立即返回错误，已知扩展由 Provider 处理。
- **原生优先只是提示**：Agent 不一定遵守；靠描述前缀 + `<tool_policy>` 点名 + 遵守度统计迭代措辞，不在桥内硬拦截（宿主无法判断原生能力是否可用）。
- **上游迭代快**：claude-agent-acp 几乎每天发版，DeepSeek Harness 是 preview，ZCode 协议私有。目录精确锁版本；升级 = 改目录版本 + 重跑契约测试与 spike；只依赖 ACP v1 稳定字段 + 已核对的 `_meta` 扩展。
- **ZCode 垫片**：私有协议无兼容承诺，垫片是长期维护负担；P0 结论为放弃则不做，不要为赶进度硬上。
- **能力包与提示词一致性**：平台规则必须按实际注入的工具生成，否则模型会调用不存在的工具；只读上下文与工具解耦（记忆内容照常注入）。
- **工具数量**：能力包全选时注入工具较多，可能影响 Agent 表现；UI 显示工具数，P0 / P6 观察各 Agent 的工具数上限。
- **隔离让渡**：原生工具在 KepCup 沙箱之外；控制点只有 `request_permission` + Agent 沙箱 + 档位。看不懂的请求弹卡；永不 bypass / full-access。无 OS 沙箱的 Agent（OpenCode 等）命令逐条确认。
- **Agent 侧配置**：Claude `settingSources: []`；Codex / OpenCode 无法关闭的 project 配置靠确认弹框；用户全局配置（`~/.codex`、`~/.config/opencode`）会生效——设置页提示。
- **run 外输出**：steering 不带 `promptRequired`、`load` 重放、自主 turn 都会产生不属于任何 run 的更新；一律丢弃，桥在无 run 时拒绝。
- **整 run 持有租约**：外部 Agent run 期间同一 project 的其他 Bot 写入要排队；这是让渡项。
- **双份历史**：Agent 在自己目录保存会话 transcript；KepCup 删除对话不清理，删除提示必须说明。
- **订阅限额**：后台 loop 与用户本人使用共享额度；默认降频；限额耗尽映射为可读失败，不重试风暴。
- **`skip_reply` 与取消**：`skip_reply` 后的 `session/cancel` 结算为 completed（不发最终文本），不能映射成 cancelled。
- **事件形状对齐**：续接摘要、反思、中间说明都读 `run_steps`；外部 Agent 映射出的事件必须与 pi 版字段一致。
- **桥的安全**：只绑 127.0.0.1；会话级 token、只在有进行中 run 时有效；校验 `Host` / `Origin`；日志 `secrets.redact`。
- **安装来源**：binary 必须校验 sha256；npm 安装锁精确版本（含锁文件）；安装目录不可被 Agent 写（Agent 沙箱的 `denyWrite` 覆盖 `toolchains/`）。
- **approvals CHECK**：新 kind 必须重建表并带全现有 kind；要有真库测试。迁移无 down。

## 14. 完成定义（整包）

- [ ] P0 门禁通过（6 个 ACP Agent 的 spike 报告、ZCode 覆盖 / 放弃结论、合规清单）——6 个为 Claude Agent、Codex、OpenCode、DeepSeek Harness、Cursor、Antigravity
- [ ] P1–P6 清单勾完，验收口径满足
- [ ] 「新增 Agent 只需目录条目 + Provider 差异模块 + 登记 + 契约测试」经 fake 第二条目验证
- [ ] 设计 28 与实现无未记录的硬偏离（有则改 28 或记 `DEVIATIONS.md`）
- [x] `docs/dev/02/03/04/05`、`PROGRESS.md` 已同步（P6，2026-10-08）
- [ ] 内置引擎回归全绿
- [ ] **未**执行 git commit / push / 创建 PR（除非用户另行明确要求）

---

## 附录 A — P0 进展记录

### A.1 ZCode 协议评估（2026-10-07，只读源码，v3.14.3 commit 29628c9，未实测）

**结论：能完整覆盖（门禁 1–7 项全部可映射）→ 本期支持**；垫片约 6–8 人日。**（2026-10-08 补充：P5 实现前复核推翻此结论——app-server 模式的订阅鉴权由宿主经 `interaction/requestProviderRuntimeHeaders` 提供，接入须读取 / 中转用户凭据；`edit` 模式不分工作区内外放行写入。已放弃，见 §8.1 / §8.4 与 DEV-008。）**证据路径（缩写 S=`packages/shared/src`，B=`apps/zcode-cli/packages/bootstrap/src/zcode-protocol`，A=`apps/zcode-cli/packages`）：

| 项 | 映射 | 证据 |
|---|---|---|
| 会话 / cwd / 多会话 | `session/create` 的 `workspace.workspacePath`；多会话 | S/zcode-protocol/index.ts:1559-1580；B/session-mapper.ts:130；B/server-operations.ts:1281 |
| prompt（文本 + 图片）/ 结束 | `session/send`（attachments `kind:image`）→ 只返回 accepted；结束看 `turn.completed.resultType`（success / cancelled / error_*）、`turn.failed` | B/server-operations.ts:501-545；index.ts:1231-1262 |
| 流式更新 | `part.delta`（文本 / 推理）、`tool.updated`（scheduled 带 input、started / result / error）；`session/subscribe` + `session/event` | index.ts:1286、1322-1385；B/server-operations.ts:771 |
| 权限 / 模式 | 反向请求 `interaction/requestPermission`（options，回 allow / deny）；`session/setMode`（plan / build / edit / yolo / auto） | index.ts:2279；B/interaction-broker.ts:59-90；legacy-types.ts:74 |
| 取消 | `session/stop` → `resultType=cancelled` | B/server-operations.ts:2592-2611 |
| MCP 注入 | create 的 `mcpServers`（stdio / http / sse + headers），形状近 ACP | index.ts:629-654 |
| 指令 | 无系统提示词字段 → `prompt-prefix`；自动加载 `~/.zcode/AGENTS.md`、cwd 向上的 `AGENTS.md`、`.zcode/config.json`、`.zcode/agents` | A/adapters/src/context/index.ts:24,94-130；A/bootstrap/src/plugins.ts:1298；subagents.ts:56 |
| 认证 | `zcode login [zai\|bigmodel]`（浏览器 OAuth + 轮询），凭据 `~/.zcode/v2/credentials.json`；未登录无专门错误（`provider_not_configured` / “No available models”）→ 垫片映射为 `auth_required` | A/cli/src/login-command.ts:15-17；A/contracts/src/model/index.ts:99 |

**落地约束（写入 P5 ZCode 项）**：
- **分发只用 `system` 来源**：没有独立 CLI 二进制（GitHub release 只有桌面 dmg / exe，CDN 也是 Electron 安装包）。检测用户已安装的 ZCode 桌面应用，拉起其内置 `app-server --stdio` 入口（packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:369）；未安装时设置卡引导用户去官网安装。不自行下载解包。
- **协议无兼容承诺**：无版本握手（`ZCODE_PROTOCOL_VERSION=1` 仅出现在快照，index.ts:74,1016-1023），`session/send` / `session/stop` 已标 `@deprecated`（index.ts:3576-3583），V4 草稿未冻结 → `tier:'preview'` + `releaseGate`；垫片入口校验应用版本在 3.14.x，不符即 `incompatible`；契约测试锁住行为。
- 垫片须：未知反向请求一律回 `-32601`（`session/requestRuntimePreferences` 收到会自动回退默认值，B/server-operations.ts:3219）；自行生成必填的 `workspaceKey`。
- `agentSideConfigFiles: ['AGENTS.md', '.zcode/']`。

### A.2 Cursor / Antigravity 离线探测（2026-10-07，Linux x64，独立 HOME，`initialize` + 未登录 `session/new`）

- Cursor：`authMethods=[cursor_login]`（前置 `agent login`，或 `CURSOR_API_KEY` / `--auth-token`）；未登录 `session/new` → `-32000 Authentication required`；`loadSession` 有、无 resume；模式 agent / plan / ask；MCP http / sse；权限选项 allow-once / allow-always / reject-once；扩展请求 `cursor/ask_question`、`cursor/create_plan`（阻塞，必须应答）；图片有。
- Antigravity：`authMethods=[oauth-personal, oauth-business, gemini-api-key, agent-platform]`；load / resume / list；模式 default / auto_edit / yolo；MCP stdio / http / sse 且与全局 `~/.gemini/config/mcp_config.json` 合并；图片 / 音频 / embeddedContext；个人与 key 方式无 OS 沙箱（仅 Enterprise 管理开关启用 exebox）；`clientInfo` 名称进入 User-Agent。

### A.3 本机测试环境说明

- 本机 Ubuntu 22.04（glibc 2.35）：`es-git@0.7.0` 预编译绑定需要 glibc ≥ 2.38（`__isoc23_strtol`），导致 54 个测试文件在宿主上无法加载；且宿主缺 `socat`，沙箱用例失败。
- 处理：测试在 Debian 13（glibc 2.41）容器中运行，仓库与宿主 Node 以相同路径挂载（镜像与脚本在会话 scratchpad，不入库）。容器内 bwrap 无特权，沙箱隔离用例仍会超时——属环境限制，不计入回归判断，需在具备 bwrap / socat 的机器或 CI 上复核。
- 真实账号相关的 P0 项（认证流程、真实 prompt / 权限请求序列、原生优先遵守度、三平台）需用户提供登录态后执行；spike 脚本先行实现，见 P0 §3.1。

### A.4 离线 spike 结果（2026-10-07，`packages/core/scripts/agent-spike/`，独立 HOME、未登录）

报告存会话 scratchpad `spike/reports/`（不入库）；脚本用法与登录后需补跑的步骤见 `packages/core/scripts/agent-spike/README.md`。

| Agent | authMethods | 能力摘要 | 未登录表现 | 冷启动 / 热启动 |
|---|---|---|---|---|
| Claude 0.86.0 | `claude-ai-login`、`console-login`（terminal 类，args `--cli auth login --claudeai/--console` 追加在适配器调用之后，另有 `_meta['terminal-auth']`） | load / resume / fork / list / close / delete；MCP http+sse；图片；`_meta.steering.supported`；5 种模式（含 bypassPermissions，须过滤） | `session/new` 成功，`session/prompt` 才报 `-32000 Authentication required` | npx 12.4s / 1.4s，RSS 300–580MB |
| Codex 2.1.1 | `api-key`、`chat-gpt`（均 agent 类，无 terminal 类） | load / resume；MCP **仅 http**；图片；steering；无 modes | `session/new` 即 `-32000` | npx 10.9s / 1.6s |
| DeepSeek Harness 0.2.0-rc.2 | 空 | 无 load、无图片；MCP http；无 steering；无 modes，config 只有 model / reasoning_effort | `session/new` 成功，prompt 报 `-32603`（message 含 `no API key for provider route "deepseek-official"`） | npx **77.6s** / 2.8s；缓存 758MB，RSS ~790MB |
| OpenCode 1.18.35 | `opencode-login`（无 `type`，仅 `_meta['terminal-auth']`，command 为裸名 `opencode`，args `auth login`） | load / resume / fork；MCP http+sse；图片；未声明 steering | **不报错**：自带 `opencode/*-free` 匿名免费模型 | binary 2.7s（下载 60MB，sha256 通过） |
| ZCode | — | — | 本机未安装桌面应用 | — |

**由此带来的实现要求（已并入对应阶段）**：
1. **auth_required 判定按 Provider**：`AgentProvider` 增 `classifyError(err, phase)` → `auth_required | not_installed | incompatible | other`（Codex：`session/new` 的 `-32000`；Claude：`session/prompt` 的 `-32000`；dsh：`-32603` + message 匹配；OpenCode 离线不报错）；另消费 `_auth/status_update` 扩展通知（Claude / Codex 未登录时推 `{authStatus:{kind:'none'}}`）更新 Agent 状态。→ P1 接口补字段、P4 状态机使用。
2. **terminal 认证命令改写**：`_meta['terminal-auth'].command` 可能是裸名（OpenCode）或当前进程路径（Claude），宿主一律替换为目录安装的可执行文件路径 + 声明的 args，并在受控环境变量下运行。→ P4。
3. **OpenCode 免登录可用**（匿名免费模型）：目录状态在未登录时也可为 `ready`（`auth.kinds` 增 `anonymous`），设置卡提示「登录后可用订阅模型」。→ P4 / P5。
4. **DeepSeek Harness 体积与冷启动**：安装审批卡显示约 760MB；安装后预热一次（首启 77s）；会话超时对首次启动放宽。→ P4 / P5。
5. **SDK 坑**：`ClientSideConnection` 对 Client 未实现的 `fs/*` / `terminal/*` 会静默回 `result:null`，必须显式抛 `methodNotFound`（P1 实现需核对并有测试）。
6. Codex 只支持 http MCP（桥用 http 即可，无需 stdio 代理）；dsh 无 load → 会话复用只用 resume。
