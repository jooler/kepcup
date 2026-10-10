# 连接应用（Connected Apps）与开放平台基座 — 执行方案（D73 / D74）

> 状态：**P0、P1、P2、P3 实现完成，待门禁中需用户的部分（U1 部署 CIMD；U2 已移出用户待办、转为 extension-center.md 的逐家适配；U3 / U4 真实平台预注册客户端条目；U5 目录签名密钥与** `dl.` **/** `registry.` **线上部署）；P4 只出任务书，两份（**`hosted-auth-gateway.md`**、**`enterprise-ema.md`**）已写（2026-10-10，未实现）**（2026-10-07 设计完成，设计见 `docs/design/29-connected-apps.md`；P0 于 2026-10-09、P1 于 2026-10-09～10、P2 与 P3 于 2026-10-10 在 `t/d73-connected-apps` 实现并经独立评审修复；P2 的 §6.8「+」菜单临时开关为可选项，未做；P3 全量回归由收口时补）。分 P0→P4 五个阶段，每阶段有**门禁**（不通过不进入下一阶段）。本文是给编码 Agent 的**自包含交接**：不依赖本 chat 历史即可开工。
>
> **需要你手动处理的事项**（部署、账号、密钥、合入确认）已汇总在 [connected-apps-user-actions.md](connected-apps-user-actions.md)；**已完成 / 未完成的总览**见 [connected-apps-status.md](connected-apps-status.md)。
>
> **硬约束**：
>
> - 分支 `t/d73-connected-apps` 的提交与推送已获批准（用户决定，2026-10-09）：每次提交都推到 origin（走 SSH：`git push git@github.com:jooler/kepcup.git t/d73-connected-apps:t/d73-connected-apps`）；**合入 main、推送 main、开 PR 仍须用户明确批准**。
> - 现有 MCP（D65）、外部智能体（D72）与内置 pi 引擎的行为与测试**零回归**。
> - 令牌明文**只**允许出现在 core 发起 HTTP 请求的那一刻（以及 Token Vault 内部）：不进 RPC 返回、界面、日志、`runs.db`、审计明细、LLM 上下文、外部智能体进程。每个阶段的安全测试都要覆盖这一条。
> - 标注「**用户待办**」的事项（Cloudflare 部署、平台应用注册、真实账号）由用户完成，Agent 只做准备与验证脚本，不要尝试代为登录或注册。
>
> **修订记录**：
>
> - v3（本版，2026-10-09）：迁移不再预留编号（开工时取下一个空号）；与已落地的 borrowings W5（风险分级 / 逐工具策略 / 无人值守全部自动批准——用户决定）与 D75（对话轮 / 任务）对齐：分级器与策略复用 `core/mcp/risk.ts` / `policy.ts`，删去「destructive 无人值守不自动批准」。
> - v2：对照代码的审查修订——连接阶段授权错误被 `#ensureConnected` 吞掉并计入停用、DCR 端口须在打开浏览器前预判、交互流程只用 pi-mcp 低层函数、`shell.openExternal` 的 Port B 接线与测试注入点、审批时长独立 schema、自定义连接行不删除、目录连接如何进入 McpService、契约测试命名、显式 `mcp.removeServer`、与设计 29 的出入（已同步修订设计）。
> - v1：首版。



## 0. 先读什么（按顺序）

1. `docs/design/29-connected-apps.md` — **产品契约**（全文）。重点：§5 授权引擎（§5.6 运行时 / 交互授权分离是本方案最关键的实现约束）、§6 连接、§7 工具暴露、§8 审批与安全、§12 数据模型、§13 分期、§15 Cloudflare 部署。
2. `docs/design/23-mcp-and-subagent.md`（D65 现状）、`docs/design/18-inline-setup.md`（结构化 setup 失败 → 卡片 → `runs.retry`）、`docs/design/13-permissions.md`（D37 授权时长、D41 无人值守）、`docs/design/30-supervisor-and-tasks.md`（D75 对话轮 / 任务）、`todo/borrowings-from-personal-agents.md` W5（MCP 风险分级与逐工具策略，已落地）、`docs/design/11-storage.md`（D25 加密与 secrets）。
3. `docs/design/28-external-agents-acp.md` §4（能力包、宿主 MCP 桥）与 `todo/acp-external-agents.md`（目录 / 发行门禁 / Provider 契约测试的做法，本方案多处照搬；附录 A.3 是本机测试环境说明）。
4. `docs/dev/01-conventions.md`、`02-architecture.md`、`03-data-model.md`、`05-testing.md`。
5. 外部资料（实现时打开；版本为 2026-10-07 调研值）：

- MCP Authorization 2026-07-28：[https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) （及 `/client-registration`）；2025-11-25 版同路径（`pi-mcp@1.0.2` 实现到此版）
- MCP 安全最佳实践：[https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- MCP 工具注解缺省值：规范 `server/tools` 一节（`readOnlyHint=false`、`destructiveHint=true`、`idempotentHint=false`、`openWorldHint=true`）
- RFC 8252（原生应用）、RFC 9728（资源元数据）、RFC 8414、RFC 8707、RFC 9207、RFC 7009（吊销）、RFC 7591（DCR）、CIMD 草案 `draft-ietf-oauth-client-id-metadata-document`
- MCP Registry `server.json` schema 与 OpenAPI v0.1：[https://modelcontextprotocol.io/registry/about](https://modelcontextprotocol.io/registry/about) 、[https://github.com/modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)
- MCPB manifest v0.3：[https://github.com/modelcontextprotocol/mcpb](https://github.com/modelcontextprotocol/mcpb) （P2）
- MCP Apps：[https://modelcontextprotocol.io/docs/extensions/apps](https://modelcontextprotocol.io/docs/extensions/apps) 、`@modelcontextprotocol/ext-apps`（P3）
- Cloudflare：Workers Static Assets `_headers`、Worker routes、Bot Fight Mode 限制（设计 §15 已汇总）

1. `pi-mcp/oauth` **API**（`node_modules/.pnpm/@earendil-works+pi-mcp@1.0.2/.../dist/oauth/*.d.ts`，**先读源码再用**）：

- 发现：`discoverOAuthServerInfo`、`discoverProtectedResourceMetadata`、`discoverAuthorizationServerMetadata`、`parseWwwAuthenticate`、`selectResource`、`resourceUrlFromServerUrl`（均接受可注入的 `fetch: McpFetch`——用它接 SSRF 防护）
- 流程：`startAuthorization`、`registerClient`、`exchangeAuthorizationCode`、`refreshAuthorization`、`stepUpScope(granted, challenged)`、`authorizeMcp`、`adaptOAuthProvider`
- 提供者：`McpOAuthProvider` / `OAuthClientProvider` / `McpOAuthStateStore`——**本方案不使用**（见下方已知坑与 §4.6）；交互流程只用上面的低层函数，运行时用自建 `AuthProvider`
- 传输：`StreamableHttpTransportOptions.authProvider`（`dist/transports/streamable-http.d.ts:33`）；`AuthProvider { token(); onUnauthorized?(ctx: UnauthorizedContext) }`（`dist/auth-provider.d.ts`）
- **已知坑**（审查确认，务必遵守设计 §5.6）：`adaptOAuthProvider` 的 `onUnauthorized` 在刷新失败 / `insufficient_scope` 时会调 `authorizeMcp` → `onRedirect`，即运行中自行发起交互授权——**运行时不得使用它**；`McpOAuthProvider` 无主动刷新、客户端信息按 server URL 存，且其 CIMD 钩子（`flow.js:178`）拒绝非 https 的 CIMD URL（测试用 http 文件服务会失败）；`OAuthCallbackServer` 不校验 `Host`；`OAuthClientMetadata` 类型无 `application_type`。

1. 代码锚点（行号为 2026-10-07 工作树，含 D72 未提交改动；实现时以实况为准）：

- **MCP**：`packages/core/src/mcp/service.ts`（`serversForBot` :82、`mcpToolName` :92、`testServer` :122、`#endpointHint` :151、`missingSecrets` :167、`listTools` :194、`callTool` :212、`#ensureConnected` :253（catch :269-285 把一切连接错误包成 `MCP_CONNECT_FAILED` 并累计 `#failures`，满 `MCP_RECONNECT_MAX` 永久停用——**授权错误必须在此绕开**）、`#connectClient` :318（`StreamableHttpTransport` :340）、`#isTransportFailure` :382、`#resolveSecretValue` :414）；`mcp/tools.ts`（`buildMcpTools` :21，listTools 失败静默跳过 :33-41；`wrapMcpTool` :57）；`mcp/sse-transport.ts`（自有旧版 SSE，无 authProvider）
- **编排**：`packages/core/src/dispatch/orchestrator.ts`（`retryRun` :942；`setupHit` :1854；`#mediaFacade(setupHit)` :2678 / `#searchFacade` :2711 是「工具记 setup 需求」的样板；MCP 接线 :2031-2045；SETUP_REQUIRED → abort :2366-2373）
- **工具汇总**：`packages/core/src/tools/index.ts`（`buildResponseTools` :182；MCP 工具并入 :816-860——在此加内置名冲突检查）；`tools/image-tools.ts` 的 `TOOL_SETUP_REQUIRED`
- **提示词**：`packages/core/src/agent/context/system-prompt.ts`（`section()` :129、`buildSystemPrompt` :200、段落顺序 :266-283；ACP 版 `buildAgentSessionPrompt` :514、`buildAgentRunContext` :548）
- **网关 / 审批**：`packages/core/src/gateway/index.ts`（`mcpToolCall`，autoApprove 查 `mcpAutoApprove`；`audit`）；`permissions/approvals.ts`（`NEVER_AUTO_DECIDED` :97、`SURVIVES_RUN` :104、`request` / `submitNonBlocking` :150/:207、`#autoDecideSync` :237、`decide` :334——`agent_tool` 用 `payload.durations` 限定可选时长 :362-375，**本方案照此扩展** `mcp_tool`）；`permissions/unattended.ts`；`start.ts:1086`（`mcpAutoApprove` 注入）
- **secrets**：`packages/core/src/domain/secrets.ts`（名称正则 :7、`setValue` 按名覆盖缓存 :63、`redact` 整值替换 :112）；`start.ts:776`（构造与预热）
- **SSRF**：`packages/core/src/search/service.ts`（真正的防线是私有的 undici `#connectGuard` Agent :56-74，连接时逐跳校验解析地址、无 DNS 重绑定窗口；`assertNoPrivateAddress` :272、`isPrivateAddress` :281）——本方案把 `#connectGuard` 抽到 `infra/` 复用
- **主进程服务的方法**（本方案新增 `shell.openExternal` 照此做）：`packages/shared/src/rpc/methods.ts` 的 `browser.`* 一段（:1345 起）与 `BROWSER_RPC_METHODS` 清单（:1388）；main 侧 `apps/desktop/src/main/browser-methods.ts`（`browserMethodSpecs`）及 `index.ts:221` 的 `serverMethods` 组装；core 侧 `packages/core/src/browser/facade.ts`、`packages/core/src/process-entry.ts:109`（`services.browserRpc.bind(platformServer)`）、`start.ts:277/654`（`CoreServicesOptions.browserRpc` 测试注入点）；现唯一 `shell.openExternal` 用法 `apps/desktop/src/main/index.ts:193`
- **shared 类型**：`packages/shared/src/domain/types.ts`（`botRuntimeSchema` :41、`mcp_server_ids` :54、`mcpServerSchema` :270、`settings.mcpServers` :397、`setupRequirementSchema` :670（已有 `agent` kind，D72）、`grantDurationSchema` :810（被 `grantSchema` :1106、`agent_tool` durations :958、`ApprovalDecision` :1019 共用——**不要直接扩展它**）、`approvalKindSchema` :817、`mcpToolApprovalPayloadSchema` :921）；`settings.update` 整体替换 `mcpServers`（只有 `agents` 做了合并防陈旧快照，`core/src/rpc/bindings.ts:259-292`）；`shared/src/domain/host-capabilities.ts`（`mcp` 能力包 :212）；`shared/src/constants.ts`（MCP 常量 :101-109）；`shared/src/errors.ts`（MCP 错误码 :66-70）；`shared/src/rpc/methods.ts`（`mcp.`* :210-242 / :1107-1109；`APP_METHODS` / `PLATFORM_RPC_METHODS` :1541）；`shared/src/rpc/events.ts`（`mcp.server_status` :200）
- **外部智能体**：`packages/core/src/agent/external/capabilities.ts`（`buildExternalAgentTools` :21、`fitToolName` :55、`capabilityOfTool` 归包、`toolAnnotations` :92 / `READ_ONLY_TOOLS`——应用工具的风险须映射成桥上的注解）、`agent/external/mcp-bridge.ts`；提示词注入点 orchestrator `buildSystemPrompt` 闭包（:2305 一带）与 `buildAgentRunContext`（:1711 一带）
- **目录先例**：`packages/shared/src/domain/agent-catalog.ts`（`filterReleasedAgents` fail-closed）、`apps/desktop/agent-release-gates.json`、`packages/core/src/agent/external/catalog.ts:18-22`（构建期注入）、`scripts/import-acp-registry.mjs`、`packages/core/test/contract/agent-provider.contract.ts`；预置技能 `apps/desktop/resources/preset-skills/catalog.json` + `packages/core/src/skills/presets.ts:31-52`（运行时读资源 JSON 的做法）
- **渲染端**：`stores/permissions.svelte.ts:99`（审批时长）、`features/settings/SettingsDialog.svelte`（导航 :58、分区渲染 :163）、`features/settings/McpSection.svelte`（`removeServer` :215-228 遗留不清密钥）、`features/bot-panel/BotProfileForm.svelte`（MCP 勾选 :55/:191/:462）、`features/chats/SetupRequiredCard.svelte`（kind 分发 :113）、`features/approvals/ApprovalCard.svelte`（`mcp_tool` :174-216）、`stores/shell.svelte.ts`（分区 id、`openSettings`）、`features/settings/agent-icons.ts`（图标加载先例）、`i18n/locales/zh-CN.ts`
- **迁移**：本方案三个迁移 `{N}_app_connections.sql`（P0）、`{N+1}_app_tools.sql`（P1）、`{N+2}_egress_approval.sql`（P2）——`N` 为写迁移时 main 的下一个空号（见 §2.1）；号以目录实况为准，迁移只前进；`approvals` 的 CHECK 约束改动须重建表并带全现有 kind（参照 0015 / 0016 / 0017）
- **测试**：`packages/core/test/unit/mcp-tools.test.ts`、`host-mcp-bridge.test.ts`（现有 MCP 测试样板）；`packages/testkit/src/`（`web-server.ts`、`file-server.ts`、`fake-acp-agent.ts` 是假服务样板）；`pi-mcp/testing` 只导出 `createInMemoryTransportPair`；**vitest 只收** `*.test.ts`（根 `vitest.config.ts:25-27`）——契约文件须由 `.test.ts` 包装（照 `agent-providers.test.ts`）



## 1. 背景与目标

- **用户诉求**：对标 Grok「Connect apps」，让用户把 Google、GitHub、Notion、Figma 等账号授权给 Bot 代为操作；长期以开放平台形式让第三方开发并入驻。
- **设计结论**（设计 29）：连接应用 = MCP server + 用户的一个 OAuth 授权；授权严格遵循 MCP Authorization；令牌只在本机；按工具风险分级审批 + 工具定义锁定 + 污点外发控制；对外契约全部采用开放标准（MCP / MCP Apps / Agent Skills / Registry `server.json` / MCPB），KepCup 只加 `_meta["app.kepcup/connector"]`；服务端组件部署在 Cloudflare（`kepcup.com`）。
- **现状**（设计 29 §2）：无任何 OAuth 代码、无 deep link、`shell.openExternal` 只用于 macOS 隐私设置；`pi-mcp/oauth` 提供协议原语但运行时编排需自建。

**复用**：`McpService` 连接 / 缓存 / 调用；`ToolGateway` + `ApprovalsService`（`payload.durations` 做法）；D58 结构化 setup 失败 + `SetupRequiredCard` + `runs.retry`；`SecretsService`；`search/service.ts` 的 SSRF 校验；D72 的目录 / 发行门禁 / 导入脚本 / 契约测试 / 能力包 / 宿主桥；`browser.`* 的「主进程服务方法」通道。

**不做（整篇）**：为任何平台手写非 MCP 私有 API 集成；内嵌 WebView 登录或读浏览器 Cookie；令牌云同步 / 多设备；每对话独立授权（只做「+」菜单临时开关）；支付与分成；托管授权网关与企业 EMA 的实现（P4 只出任务书）；git commit / push / PR。

## 2. 前置与协作



### 2.1 与 D72（外部智能体）并行工作的协调

**现状（2026-10-07）**：D72 检查点已提交到 main——`b274cb1`（设计 / 方案）、`99013d6`（P0 spike）、`551fb7e`（P1–P4 + P5 第一部分，含 main 迁移 `0017`、runs 迁移 `0005`）。D73 **基于** `551fb7e` **在主工作树开工**。D72 的负责会话现为 **kepcup-03**；D72 的 P5 第二部分在独立 worktree `/home/jyy/wt/d72-p5-2`（分支 `t/d72-p5-2`，基于 `551fb7e`）进行，不碰主工作树，会改 `agent/external/{engine,host}.ts`、`dispatch/orchestrator.ts`、`scheduler/`、`domain/usage.ts`、`domain/lifecycle.ts` 等——合并回 main 时与 D73 在 `orchestrator.ts` / `types.ts` / `start.ts` 可能冲突，届时与 kepcup-03 协调。

- [x] **开工前置（用户决定，2026-10-07）**：等 D72 检查点提交后再开工——已满足（`551fb7e`）。开工时 `git log` 确认 HEAD 包含 `551fb7e`，并用 `ListAgents` / `SendMessage` 通知 kepcup-03（若已不在则问用户）D73 已开始。
- [ ] 为减少与 D72 P5 第二部分的合并冲突：对 `orchestrator.ts` / `start.ts` / `types.ts` 的改动尽量集中、少动既有代码（新逻辑放新模块，主文件只加接线），并在附录 B 记录改动过的段落。
- [x] 开工前 `git status`，并用 `ListAgents` / `SendMessage` 询问是否有其他 kepcup 会话正在执行 `todo/acp-external-agents.md` 或其他计划，确认文件归属。
- [x] **不要** `git checkout` / `reset` / 覆盖任何不是你写的改动；与他人改动同文件时只做增量编辑。
- [ ] **迁移编号（2026-10-09 定：不预留）**：多个并行工作（D75、borrowings、D80 等）都在新增 main 迁移，且迁移必须连续（`infra/migrate.ts` 校验），D73 **不预留具体编号**——每次写迁移时 `ls packages/core/migrations/main/` 取当时的下一个空号（本文用 `{N}` / `{N+1}` / `{N+2}` 指代三个 D73 迁移，P0/P1/P2 之间若他人又占了号则继续顺延），写之前用 `ListAgents` 问一下有无会话即将合入新迁移（如 D80 的 worktree `t/schedule-nudges`），合入 main 前再核对一次不冲突。截至 2026-10-09 main 已用到 `0021_delegation_intent`。D73 不改 runs 库（runs `0006`–`0008` 归 D75、`0009_tool_effects` 归 borrowings W2）。另：D75 的 `0018` 重建了 `messages`（新增 `owner_bot_id` / `task_id`，`kind` 含 `task_event`）与 `attachments`，未动 `approvals`；loop_type `'response'` 已改名 `'turn'`（runs `0007`、main `0020`）。
- [x] **已落地的相关工作（开工前必读其实现，D73 在其上扩展，不重复实现）**：borrowings W5（提交 `60e57d7`）——`core/mcp/risk.ts`（`classifyRisk` / `classifyRiskDetailed`：注解 + 名字推断，写动词一票否决）、`core/mcp/policy.ts`（逐工具策略：工具策略 > server `autoApprove` > 风险档默认，read→auto、其余→ask）、`mcpServerSchema.toolPolicies`（settings 单行 JSON）、审批 payload 带 `risk`、RPC `mcp.toolRisks`、网关 `mcpToolDecision`（对话轮与只读子代理只能调「只读 + auto」工具）、系统提示 `<mcp_tools>` 段、审批卡 `McpRiskBadge`、设置页 `McpToolPolicies.svelte`；**无人值守下** `mcp_tool` **所有风险档自动批准（用户决定，见 borrowings W5「目标 3」）**。D75（对话轮 / 任务分治，`docs/design/30-supervisor-and-tasks.md`）重构了 orchestrator——§0 第 7 条的行号锚点早于 D75 与 borrowings，**全部按函数名重新定位**。borrowings 的其余工作项由会话 kepcup-81 在主工作树推进，开工前用 `ListAgents` 确认文件归属。
- [x] `approvals` CHECK 重建（P2 的 `egress`，`0027_egress_approval.sql` 带全部 12 个 kind）须以 `0017_external_agents.sql` 的 CHECK 列表（含 `agent_tool`）为基础，并包含届时全部 kind。



### 2.2 测试环境

- 命令：迭代中跑定向测试 `node scripts/run-tests.mjs run <测试文件或目录>`、`pnpm --filter @kepcup/core test`；交付前全量 `pnpm test`（Electron-as-Node 跑 vitest）一次、`pnpm lint`、`pnpm typecheck`（已包含 desktop 的 svelte-check）。详见 [docs/dev/05-testing.md](../docs/dev/05-testing.md#开发中如何跑测试)。新增依赖后先 `pnpm install`。
- 本机 Ubuntu 22.04 的 glibc 与 `es-git` 不兼容、缺 `socat`：按 `todo/acp-external-agents.md` 附录 A.3 在 Debian 13 容器中运行；沙箱类用例超时属环境限制，不计入回归判断。
- 所有 OAuth 测试只用 testkit 的假服务（P0 §4.1），**不访问真实网络**；真实服务验证放在 spike 脚本里、需用户登录态（见 `connected-apps-user-actions.md` U2）。



### 2.3 用户待办与阶段门禁（汇总；逐项清单与最新状态见 [todo/connected-apps-user-actions.md](connected-apps-user-actions.md)）

> 本文没有「附录 A」——原计划的附录 A（用户待办）已独立成 `connected-apps-user-actions.md`，本文只保留附录 B（首批应用实测结论）。下表是最初的汇总，进度以那份文档为准。


| #   | 事项                                                                                          | 阻塞           |
| --- | ------------------------------------------------------------------------------------------- | ------------ |
| U1  | Cloudflare：决定 Bot Fight Mode 处理方式（关闭或 Pro + Skip 规则）；部署 CIMD 文档                             | P0 验收        |
| U2  | ~~首批应用的测试账号供 spike~~ **已移出（2026-10-10）**：逐家适配转入 [extension-center.md](extension-center.md)（§4 / X5）                                                | —            |
| U3  | GitHub App 注册（仅当 spike 证实 GitHub 不支持 CIMD）                                                  | P1 GitHub 条目 |
| U4  | Google Cloud 项目 / OAuth 同意屏幕 / Desktop 客户端 / 应用验证；Microsoft Entra 应用；Slack 应用与上架；Figma 合作申请 | P2 对应条目      |
| U5  | Ed25519 目录签名密钥与 CI 密钥；`dl.` / `registry.` 子域；Workers Paid                                   | P3           |




## 3. 实施顺序

```
P0 MCP OAuth 地基（自定义 HTTP server 走通 OAuth；假授权服务器；运行时/交互授权分离；Token Vault；CIMD 文件）
 → P1 连接应用 MVP（目录 + 连接 + Bot 授权 + 风险分级审批 + 工具锁定 + 对话内连接 + 设置「应用」分区 + ACP 能力包）
 → P2 规模化与大平台（step-up、污点外发、按需工具发现、预注册客户端、Google/Microsoft/Slack、MCPB、开发者模式、协议升级）
 → P3 开放平台基座（签名目录索引、子注册表 Worker、校验器 CLI、分级信任、MCP Apps 渲染、随附 Skills）
 → P4 企业与托管网关（只出任务书）
```

P0 内各项可按 §4 顺序推进；P1 的设置 UI 可在 P1 后端完成一半后并行。每阶段结束：更新 `docs/dev/PROGRESS.md`（新增「连接应用 Pn」行与验收记录）、偏离记 `docs/dev/DEVIATIONS.md` 或直接修订设计 29。

---



## 4. P0 — MCP OAuth 地基

**目标**：用户在设置页把一个自定义 Streamable HTTP MCP server 的认证方式设为 OAuth，点「连接」→ 系统浏览器授权 → 回到 KepCup 即可用；令牌自动刷新；过期 / 被吊销时对话里出现重连卡，重连后 `runs.retry` 续跑；可断开（吊销）。补齐 D65 的「OAuth 后续单排」。

### 4.1 testkit：假授权 + MCP 服务器（先做，后续全部测试依赖它）

- [x] 新 `packages/testkit/src/fake-oauth-mcp-server.ts`：一个本机 HTTP 服务，同时是 **MCP Streamable HTTP 资源服务器**（用 `@modelcontextprotocol/sdk` 的 server；testkit 补依赖并锁与 core 相同的版本 1.32.1）与 **OAuth 授权服务器**。可配置项：
  - 资源侧：`/mcp` 无令牌返回 401 + `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`；`/.well-known/oauth-protected-resource`（RFC 9728，可配置 `authorization_servers`、`scopes_supported`）；按工具配置所需 scope，不足返回 `403` + `error="insufficient_scope", scope="…"`；校验令牌 audience 与 `resource`；工具列表可在运行中修改并发 `notifications/tools/list_changed`；工具可带任意注解。
  - 授权侧：`/.well-known/oauth-authorization-server`（可切换为仅 OIDC 发现路径）；`client_id_metadata_document_supported` 开关（CIMD：服务端抓取 `client_id` URL 并校验 `client_id`/`redirect_uris`）；`registration_endpoint` 开关（DCR，记录收到的 `application_type` 与 `redirect_uris`）；预注册客户端表；`/authorize`（**无 UI**：校验参数后直接 302 回 `redirect_uri?code&state&iss`；可配置不回 `iss` / 回错误 `iss` / 返回 `error=access_denied`；redirect 匹配可选「精确」或「回环端口无关」）；`/token`（授权码 + PKCE S256 校验、`resource` 必填开关、刷新令牌轮换开关、`invalid_grant` 注入、`expires_in` 可配）；`/revoke`（RFC 7009，记录调用）。
  - 测试辅助：`simulateBrowser(url)`——在测试中替代系统浏览器：GET 授权 URL、跟随一次 302 到回调地址（即 KepCup 的本机回调服务）。
- [x] `packages/testkit/test/fake-oauth-mcp-server.test.ts`：自测上述每个开关。
- [x] 测试用 CIMD：testkit 的 `file-server.ts` 托管一份测试 CIMD JSON；core 读取 CIMD URL 的常量在 `NODE_ENV=test` 下允许经 `CoreServicesOptions` 覆盖（非测试环境无效，照 `KEPCUP_KEYSTORE` 的做法）。因本方案不走 pi-mcp 的 CIMD 钩子，http 的测试 URL 不受其 https 校验限制；生产代码自行断言 CIMD URL 为 https。
- [x] 测试注入点（`CoreServicesOptions`，照 `browserRpc`）：`shellRpc`（替换主进程 `shell.openExternal`，测试里接 `simulateBrowser` 并记录调用次数）、`oauthLoopbackAllowlist`（测试中允许目录条目指向假服务器的 http 回环地址；非测试环境无效）。



### 4.2 shared：类型、常量、错误码、RPC

- [x] `constants.ts`：
  - `KEPCUP_OAUTH_CLIENT_ID = 'https://kepcup.com/oauth/client.json'`（CIMD URL，**永不更改**）
  - `OAUTH_CALLBACK_PORTS`（3 个固定候选端口，建议 47615–47617，实现时检查与常见开发工具无冲突）、`OAUTH_CALLBACK_PATH = '/callback'`
  - `OAUTH_FLOW_TIMEOUT_MS`（5 分钟）、`OAUTH_REFRESH_SKEW_MS`（60 秒）、`OAUTH_METADATA_MAX_BYTES`（如 64 KB）
- [x] `errors.ts`：`APP_AUTH_REQUIRED`、`OAUTH_FLOW_FAILED`、`OAUTH_FLOW_CANCELLED`、`OAUTH_FLOW_TIMEOUT`、`OAUTH_CLIENT_REQUIRED`（无任何注册途径，需用户填 client id）、`OAUTH_ISSUER_MISMATCH`、`OAUTH_INSECURE_ENDPOINT`、`APP_CONNECTION_NOT_FOUND`。
- [x] `types.ts`：
  - `mcpServerSchema` 增 `auth: z.enum(['none','headers','oauth'])`；缺省值须由同级 `headers` 推断（有 headers → `headers`，否则 `none`），字段级 `.catch()` 看不到兄弟字段——用对象级 `z.preprocess`；`superRefine`：`oauth` 只允许 `transport === 'http'`。
  - 新 `appConnectionSchema`（对应 §4.3 表，**不含任何令牌字段**）、`appConnectionStatusSchema`（`not_connected | connecting | connected | expired | needs_scope | tools_changed | error | disabled`）。
  - 新 `approvalDurationSchema = z.enum(['once','conversation','bot'])`，只用于 `ApprovalDecision.duration` 与 `mcp_tool` 的 `payload.durations`；`grantDurationSchema`（`grants` 表与 `agent_tool`）**保持不变**。
  - `setupRequirementSchema` 增 `{ kind: 'connect-app', target: { kind: 'custom', serverId } | { kind: 'catalog', connectorId }, connectionId?: string, scopes?: string[], reason: 'not_connected' | 'expired' | 'scope' }`（P0 只产生 `custom` 目标；`catalog` 形状先定好，P1 使用）。
- [x] `rpc/methods.ts`（命名遵循 `domain.verb`）：
  - `apps.connect`：`{ target, scopes?, grantBotId? }` → `{ flowId }`（P0 只接受 `custom`）
  - `apps.connect.continue`：`{ flowId }`（用户在界面确认打开授权页后调用，见 §4.6）
  - `apps.connect.cancel`：`{ flowId }`
  - `apps.connections.list` → `{ connections: AppConnection[] }`
  - `apps.disconnect`：`{ connectionId }`
  - `apps.setClientCredentials`：`{ flowId, clientId, clientSecret? }`（手填客户端；issuer 只有在失败的流程里才知道，所以以 `flowId` 定位；写入 issuer 键的 secrets、只写不读回；随后流程自动继续）。`OAUTH_CLIENT_REQUIRED` 的事件负载须带 `issuer` 与**需用户在其平台登记的回调地址列表**
  - `mcp.removeServer`：`{ serverId }`——显式删除自定义 server 并清理其 `mcp:{id}:*`、令牌与连接（不再依赖 `settings.update` 整体替换的差集，陈旧快照会误删）
  - 主进程服务方法 `shell.openExternal`：`{ url }` → `{ ok }`；新增 `SHELL_RPC_METHODS` 清单（类型照 `BROWSER_RPC_METHODS`）
  - 以上加入 `APP_METHODS` 白名单（`shell.openExternal` 除外，它只由 core 经 Port B 调主进程）
- [x] `rpc/events.ts`：`apps.connect_flow`（`{ flowId, phase: 'discovering'|'awaiting_consent'|'awaiting_browser'|'exchanging'|'done'|'failed'|'cancelled', authorizationHost?, authorizationUrl?, connectionId?, error? }`——`authorizationUrl` 仅在 `awaiting_consent` 下发供用户核对，不含任何令牌）、`apps.connection_status`（`{ connectionId, status }`）；`mcp.server_status` 的 status 增 `needs_auth`。



### 4.3 数据：迁移 `{N}_app_connections.sql`

- [x] 建 `app_connections`（设计 29 §12 字段：`id, connector_id, connector_ver NULL, label, account_sub NULL, server_url NULL, issuer NULL, scopes, token_expires_at NULL, discovery_json NULL, status, created_at, updated_at, last_used_at NULL` + 部分唯一索引 `(connector_id, account_sub) WHERE account_sub IS NOT NULL`）。自定义 server 的连接 `connector_id = 'custom:{serverId}'`、`id` 同为 `custom:{serverId}`（每个自定义 server 唯一一行）；stdio server 的行 `server_url` 为 NULL（P1 工具锁定用）。**自定义行不随断开删除**（改 `not_connected`），只随 `mcp.removeServer` 删除；`apps.connections.list` 默认不返回 `custom:` 行（`includeCustom` 参数）。
- [x] 迁移测试（真库，照 `external-agents-migration.test.ts`）。
- [x] 同步 `docs/dev/03-data-model.md`。



### 4.4 SecretsService 改造（`domain/secrets.ts`）

- [x] `setValue` 覆盖已有名称时，把旧值移入「仅脱敏」集合（进程结束前一直参与 `redact`）；`removeValue` 同理。集合设上限（如 512 条，LRU 淘汰最旧），防止长期运行时随令牌轮换无限增长。
- [x] 新增 `removeByPrefix(prefix)`（返回删除的名称列表；被删值进入仅脱敏集合）。
- [x] 单测：令牌轮换后旧值、新值都被 `redact` 掩码；删除后仍被掩码；名称正则不变（`conn:{id}:access` 等合法）。



### 4.5 Token Vault（新 `packages/core/src/apps/token-vault.ts`）

- [x] 机密**逐值**存放（设计 29 §5.3）：`conn:{connectionId}:access`、`conn:{connectionId}:refresh`、`oauth:client:{issuerHash}:id`、`oauth:client:{issuerHash}:secret`（`issuerHash` = sha256(issuer) hex 前 24 位）。非机密的 `token_expires_at`、`scopes`、`discovery_json`、`issuer` 存 `app_connections` 行。
- [x] 自有 API（不实现 pi-mcp 的 `McpOAuthStateStore`）：`getTokens(connectionId)` / `saveTokens(connectionId, OAuthTokens)`（拆值写 secrets，`expires_in` 换算成 `token_expires_at` 写行）、`getClient(issuer)` / `saveClient(issuer, info)`（DCR 结果含 `redirect_uris`，一并存行以便端口预判，见 §4.6）、`saveDiscovery(connectionId, OAuthServerInfo)`；code verifier **只放流程内存**，不持久化。
- [x] `clearConnection(connectionId)`、`clearIssuerClientIfUnused(issuer)`（无其他连接引用该 issuer 且客户端来自 DCR 时删除）。
- [x] 单测：落库内容中不出现 JSON 打包的令牌；跨连接共享同 issuer 客户端。



### 4.6 授权引擎：交互流程（新 `packages/core/src/apps/auth/`）

- [x] `callback-server.ts`：**自建**本机回调服务（不用 `OAuthCallbackServer`，它不校验 `Host`）：`node:http` 监听 `127.0.0.1`，端口依次尝试 `OAUTH_CALLBACK_PORTS`，全占用再用 0（随机）；只接受 `GET {OAUTH_CALLBACK_PATH}`；校验 `Host` 头等于 `127.0.0.1:{port}`；按 `state` 匹配等待者；一次性；`OAUTH_FLOW_TIMEOUT_MS` 超时；回给浏览器一个**无脚本**的本地化结果页（成功：「已连接，可回到 KepCup」；失败：原因）。
- [x] `safe-fetch.ts`：给 pi-mcp 发现 / 令牌请求注入的 `McpFetch`：只允许 `https:`；把 `search/service.ts` 的 `#connectGuard`（undici `Agent`，连接时逐跳校验地址）抽到 `packages/core/src/infra/safe-dispatcher.ts` 供两处共用，作为 `dispatcher` 使用（不要只做 DNS 预查，存在重绑定窗口）；**唯一例外**——自定义 server 的 URL 本身是回环地址时，允许访问同一回环主机（本机开发），以及测试注入的 `oauthLoopbackAllowlist`；响应体上限 `OAUTH_METADATA_MAX_BYTES`；不跟随跨源重定向。
- [x] `flow.ts`（`ConnectFlowManager`）——**只用 pi-mcp 低层函数**（`discoverOAuthServerInfo` → 选客户端 → `registerClient`（DCR 时）→ `startAuthorization` → 自建回调 → `exchangeAuthorizationCode`），不使用 `McpOAuthProvider` / `authorizeMcp`；CIMD 时以 `clientInformation: { client_id: CIMD URL }` 调用低层函数：
  1. 发现：`discoverOAuthServerInfo(serverUrl, { fetch: safeFetch })`；记录 issuer。
  2. 客户端身份（设计 29 §5.1 第 3 步的顺序）：本机已有该 issuer 的客户端 → 用；（P1 起）预注册 `clientRef` → 用；AS 声明 `client_id_metadata_document_supported` → CIMD（`clientMetadataDocument` 钩子返回 `{ url: KEPCUP_OAUTH_CLIENT_ID, redirectUrl }`）；有 `registration_endpoint` → DCR（`clientMetadata` 带 `application_type: 'native'`——扩展类型后传入、`redirect_uris` 登记**全部固定端口**、`token_endpoint_auth_method: 'none'`、`grant_types: ['authorization_code','refresh_token']`、`client_name: 'KepCup'`）；都没有 → 失败 `OAUTH_CLIENT_REQUIRED`（界面引导手填）。
  3. 起回调服务 → **端口预判**：客户端来自 DCR 且本次绑定端口（固定端口全被占用而回落随机端口时）不在其已登记 `redirect_uris` 中 → 先以「全部固定端口 + 本次端口」重新注册（授权服务器对非法 redirect **不会回调**，RFC 6749 §4.1.2.1，不能等失败再补救）；手填 / 预注册客户端遇此情况 → 失败并提示释放端口 → PKCE(S256)、`state`、预期 issuer → 构造授权 URL（带 `resource` = server 规范 URI、`scope`）。
  4. **同意与打开**：授权端点 host 属于目录内已审核 issuer（P1 起）→ 直接经主进程 `shell.openExternal`（core 经 Port B 调用）打开；否则（自定义 / developer）发 `phase:'awaiting_consent'`（带完整 URL 与 host），等 `apps.connect.continue` 再打开。
  5. 回调：校验 `state`、`iss`（RFC 9207；AS 声明支持却缺失 `iss` 也失败）→ `exchangeAuthorizationCode`（带 `resource`）→ Token Vault 保存 → 建 / 更新 `app_connections` 行（status `connected`）→ 通知 `ConnectionAuthRegistry` 失效缓存 → `phase:'done'`。
  6. 令牌端点返回 `invalid_client`（DCR 客户端被授权服务器清理等）→ 清除该 issuer 客户端、重新注册一次后重试整个流程。
  - **并发去重**：同一目标（custom serverId / 后续 connectorId / connectionId）进程内同时至多一个流程；重复 `apps.connect` 返回同一 `flowId`。
  - 取消 / 超时 / 应用退出：关闭回调服务、丢弃 verifier。
- [x] `shell.openExternal` 全链路：shared 方法定义 + `SHELL_RPC_METHODS`；main 新 `shell-methods.ts`（`new URL()` 解析；只允许 `https:` 与主机为 `127.0.0.1` / `[::1]` 的 `http:`；调用 Electron `shell.openExternal`，不经 shell 命令），在 `index.ts:221` 与 `browserMethodSpecs` 合并进 `serverMethods`；core 新 `apps/shell-facade.ts`（照 `browser/facade.ts`），在 `process-entry.ts:109` 旁 `services.shellRpc.bind(platformServer)`；`CoreServicesOptions.shellRpc` 注入点（§4.1）。
- [x] 单测 / 集成（全部用假服务器）：CIMD 路径、DCR 路径（断言 `application_type: native` 与固定端口）、手填路径、`iss` 缺失 / 不符、`state` 不符、`Host` 头伪造、端口全占用回落随机、PKCE 校验失败、用户拒绝（`access_denied`）、超时、取消、并发去重、非 https 端点拒绝、私网地址拒绝与回环例外。



### 4.7 授权引擎：运行时（`apps/auth/runtime-provider.ts`）

- [x] `ConnectionAuthProvider implements AuthProvider`：
  - `token()`：读缓存的 access token；距过期 < `OAUTH_REFRESH_SKEW_MS` 且有 refresh token → **single-flight** 调 `refreshAuthorization` 主动刷新并保存；无令牌 → 抛 `AppAuthRequiredError{ reason: 'not_connected' }`。
  - `onUnauthorized(ctx)`：`ctx.token` 与当前令牌不同 → 直接返回（他处已刷新）；`parseWwwAuthenticate`：`403 insufficient_scope` → 状态 `needs_scope`，抛 `AppAuthRequiredError{ reason: 'scope', scopes: stepUpScope(granted, challenged) }`；401 → 有 refresh token 则刷新一次，成功返回、失败（`invalid_grant` 等）→ 状态 `expired`，抛 `AppAuthRequiredError{ reason: 'expired' }`。**绝不**调用 `authorizeMcp` / 打开浏览器。
- [x] `ConnectionAuthRegistry`：每个连接进程内唯一实例；run、设置页「测试」、工具清单刷新共用；交互流程完成后 `invalidate(connectionId)`。
- [x] **先验证**（写测试锁住）：① `onUnauthorized` / `token()` 抛出的错误能否原样穿出 `StreamableHttpTransport` → `client.connect` / `listTools` / `callTool`，被包装则在 `McpService` 侧解包识别；② GET 事件流（`openGetStream` 默认开启）收到 401 时错误走向——若触发 `onClose` 并被当作连接失败，须同样识别为授权错误、不计失败（必要时对 OAuth 连接关闭 GET 流）。
- [x] `ConnectionAuthRegistry.invalidate(connectionId)` 同时调用 `McpService.resetFailures(serverKey)` 并丢弃该连接的缓存客户端，使重连后立即可用。



### 4.8 McpService / MCP 工具接线

- [x] `#connectClient`：`server.auth === 'oauth'` 时给 `StreamableHttpTransport` 传 `authProvider`（来自 Registry，连接 id = `custom:{serverId}` 对应行）；`sse` 不支持 OAuth（schema 已拒绝）。
- [x] `#ensureConnected` **的 catch（:269-285）**：识别 `AppAuthRequiredError`（含被包装的情况）→ 不累计 `#failures`、不发 `failed`、发 `mcp.server_status: needs_auth`、**原样重抛**（不包成 `MCP_CONNECT_FAILED`）；新增 `resetFailures(serverId)`。`#isTransportFailure` 同样排除授权错误。`#endpointHint` 对 `oauth` server 改为提示「请在设置中连接」。
- [x] `testServer`：`oauth` 且无令牌 → 返回可读结果「尚未连接」，不发起授权。
- [x] `mcp/tools.ts`：
  - `buildMcpTools` 返回值改为 `{ tools, unavailable: Array<{ serverId, reason: 'expired'|'not_connected'|'scope' }> }`（listTools 因授权失败时收集，**不再只记日志**）；`McpToolFacade` 与 orchestrator 调用点同步，`unavailable` 须同时送到 `buildSystemPrompt` 闭包（:2305 一带）与 `buildAgentRunContext`（:1711 一带）。
  - `wrapMcpTool`：捕获 `AppAuthRequiredError` → 经门面回调 `onSetupRequired(requirement)` 记下 `{kind:'connect-app', target:{kind:'custom', serverId}, connectionId, reason, scopes?}`，工具结果 `errorCode = TOOL_SETUP_REQUIRED`、文本「需要重新连接 X」。
- [x] `orchestrator.ts`（:2031 一带）：`McpToolFacade` 增 `onSetupRequired`，写入同一个 `setupHit`（照 `#mediaFacade(setupHit)`），复用既有 abort → failed + `run.setup` → 卡片 → `runs.retry` 链路。
- [x] 提示词：新 `section('connected_apps', …)`（`buildSystemPrompt`，放在 `skills` 附近）：P0 只列出**需要重新连接**的自定义 server（名称 + 原因）与一句规则「需要时调用 `app_request_connection`，不要让用户粘贴令牌」；无内容则整段省略。
- [x] 新工具 `app_request_connection`（`packages/core/src/tools/app-tools.ts`，P0 只接受 `connection_id` / 自定义 `server_id`）：校验目标存在且属于该 Bot 已勾选的 server → 记 setup 需求、返回 `SETUP_REQUIRED`。（P0 时 ACP Bot 拿不到它——`apps` 能力包在 P1 才加，属预期。）
- [x] 删除自定义 server：`McpSection.removeServer`（:215）改调 `mcp.removeServer`（§4.2），core 侧删除 settings 条目并清理 `mcp:{id}:*`、`custom:{id}` 连接行与 `conn:*`、必要时 issuer 客户端、断开连接——修复设计 29 §2 所列遗留泄漏。



### 4.9 断开与吊销

- [x] `apps.disconnect`：AS 有 `revocation_endpoint` → 先吊销 refresh token（再 access token），失败只记日志不阻断；删除 `conn:{id}:*`；目录连接删除 `app_connections` 行（工具锁定行级联删除，重连时重新复核），自定义 server 的行保留并置 `not_connected`（保留工具锁定）；`clearIssuerClientIfUnused`；`McpService` 断开该连接；发 `apps.connection_status`。
- [x] 审计：`app_connect`、`app_disconnect`（明细只含 connectionId / connector / issuer / scopes，经 `redact`）。



### 4.10 渲染端

- [x] `McpSection.svelte`：HTTP server 增「认证方式」选择（无 / Header / OAuth）；OAuth 时显示连接状态（未连接 / 已连接（账号）/ 需重新连接 / 权限不足）与「连接 / 重新连接 / 断开」；`awaiting_consent` 时展示完整授权 URL、突出域名、「在浏览器中继续」与取消；`OAUTH_CLIENT_REQUIRED` 时展开 client id / secret 输入（`apps.setClientCredentials`）。
- [x] 新 `stores/apps.svelte.ts`：订阅 `apps.connect_flow` / `apps.connection_status`，持有连接列表与进行中流程（照 `stores/agents.svelte.ts`）。
- [x] 新共享组件 `features/apps/ConnectAppPanel.svelte`（设置页与对话卡共用；P1 扩展目录形态）：按 phase 显示进度；`OAUTH_CLIENT_REQUIRED` 时显示 issuer、需登记的回调地址与 client id / secret 输入。
- [x] `SetupRequiredCard.svelte` 增 `connect-app` 分支（用 `ConnectAppPanel`）；完成后走既有「dismiss + `runs.retry`」。
- [x] i18n 键（zh-CN）。



### 4.11 CIMD 文档与 Cloudflare 部署材料

- [x] 新 `infra/cloudflare/oauth-cimd/`：`wrangler.jsonc`（仅静态资源，路由 `kepcup.com/oauth/*`）、`public/oauth/client.json`、`public/_headers`（`/oauth/*`：`Content-Type: application/json`、`Cache-Control: public, max-age=86400`、`Access-Control-Allow-Origin: *`）、`README.md`（部署步骤、Bot Fight Mode 注意事项、验证命令）。
- [x] `client.json`：`client_id` = `KEPCUP_OAUTH_CLIENT_ID`（逐字相等）、`client_name: "KepCup"`、`redirect_uris`（`http://127.0.0.1/callback` + 每个固定端口的完整地址）、`grant_types`、`response_types: ["code"]`、`token_endpoint_auth_method: "none"`、`logo_uri`、`client_uri: "https://kepcup.com"`、`policy_uri`（隐私政策 URL 用户确认）；≤5 KB。
- [x] 单测 `shared/test/unit/cimd-document.test.ts`：读取该文件，断言 `client_id === KEPCUP_OAUTH_CLIENT_ID`、`redirect_uris` 覆盖全部 `OAUTH_CALLBACK_PORTS`、体积 ≤5 KB、无 `localhost`。
- [ ] 外部验证脚本 `infra/cloudflare/oauth-cimd/verify.mjs`：对线上地址检查 200、`application/json`、无重定向、内容与仓库文件一致（**用户待办 U1** 部署后运行）。*（脚本已写好并有 README 说明；线上运行待 U1。）*



### 4.12 文档与测试汇总

- [x] 安全测试（`packages/core/test/security/`）：完整连接—调用—刷新—过期—重连—断开流程后，扫描 `runs.db`、`audit_log`、日志文件、所有 RPC 返回与事件负载，均不含任何令牌明文。
- [x] 集成测试：Bot 勾选一个 OAuth 自定义 server → run 中调用成功；令牌过期且刷新失败 → 工具结果 SETUP_REQUIRED → run failed + `setup.kind === 'connect-app'` → 模拟完成连接 → `runs.retry` 成功；run 开头 listTools 授权失败 → 不中断 run、`<connected_apps>` 列出该 server；run 中途 401 时**没有**调用 `shell.openExternal`。
- [x] 同步 `docs/dev/02-architecture.md`（apps 模块、主进程方法）、`03-data-model.md`、`04-agent-runtime.md`（新提示段与工具）、`05-testing.md`（假授权服务器）、`23-mcp-and-subagent.md`（认证方式）。



### 4.13 P0 验收（门禁）

- [x] 自定义 OAuth server 在假服务器的 CIMD / DCR / 手填三条路径上均可连接、调用、刷新、断开（含吊销）。（`connected-apps-e2e.test.ts`）
- [x] run 中授权失效只出现对话内卡片，不弹浏览器；重连后 `runs.retry` 完成任务。（`connected-apps-runtime.test.ts`）
- [x] 安全测试通过（令牌零泄露）；D65 既有 MCP 测试全绿（跑 MCP 相关测试文件即可，全量留到交付前一次）。（`connected-apps-tokens.test.ts`、`mcp.test.ts` 等）
- [ ] （用户待办 U1 完成后）`verify.mjs` 对 `https://kepcup.com/oauth/client.json` 通过；用 Notion 或 Linear 官方 MCP 以「自定义」方式手工走通一次（记录在 PROGRESS）。

**实施记录（2026-10-09）**：P0 代码与自动化测试已完成（20 文件 228 例，见 `docs/dev/PROGRESS.md`「连接应用 P0」）；偏差与补充见 `docs/dev/DEVIATIONS.md` DEV-019；文档已同步 `docs/dev/02 / 03 / 04 / 05`、`docs/design/23`。剩余仅门禁里需要用户的部分（U1）。

---



## 5. P1 — 连接应用 MVP

**目标**：设置页「应用」分区可浏览内置目录、一键连接（多账号）；Bot 勾选连接；工具按风险分级审批；工具定义锁定与复核；Bot 在对话中请求连接；ACP Bot 可注入应用能力。

### 5.1 首批应用实测（spike，先于目录定稿）

- [x] `packages/core/scripts/connector-spike/`（不进产品代码）：对候选 URL（Notion `https://mcp.notion.com/mcp`、Linear `https://mcp.linear.app/mcp`、Atlassian `https://mcp.atlassian.com/v1/mcp/authv2`、Sentry `https://mcp.sentry.dev/mcp`、Asana `https://mcp.asana.com/…`、HubSpot、Canva `https://mcp.canva.com/mcp`、Stripe `https://mcp.stripe.com`、GitHub `https://api.githubcopilot.com/mcp/`；以各家文档为准）输出 JSON 报告：401 challenge、PRM、AS 元数据、**是否支持 CIMD / DCR**、`scopes_supported`、`code_challenge_methods_supported`、`authorization_response_iss_parameter_supported`、`revocation_endpoint`。
- [ ] 带登录模式（已转入 [extension-center.md](extension-center.md) §4 / X5 逐家适配；原需 U2 的账号，用户在浏览器里登录）：用 P0 引擎完整连接，导出工具清单、注解覆盖率（多少工具缺 `readOnlyHint` / `destructiveHint`）、账号识别可行性。
- [x] 结论入本文附录 B：每家「可上目录 / 需预注册 / 暂不支持」。只有能自动注册（CIMD 或 DCR）的进 P1 目录；GitHub 不支持 CIMD 时需用户注册 GitHub App（U3）并走 P2 的预注册客户端机制——**不要**为赶 P1 提前做半套。



### 5.2 目录（catalog）

- [x] shared `domain/connector-catalog.ts`：zod schema = `server.json` 子集（`name`、`title`、`description`、`version`、`remotes[]`（P1 只认 `streamable-http`）、`packages[]`（P2 MCPB）、`_meta`）+ `_meta["app.kepcup/connector"]`（设计 29 §4：`slug` `[a-z0-9]{2,16}`、`icon`、`category`、`tier`、`auth{kind, registration, clientRef, scopes{default, write}}`、`toolPolicy`、`skills`、`ui`、`privacyPolicy`、`whoami?`（账号识别用只读工具名 + 结果字段路径）、`releaseGate`）。导出 `filterReleasedConnectors`（fail-closed，照 `filterReleasedAgents`）。
- [x] 资源 `apps/desktop/resources/connectors/catalog.json` + `icons/*.svg`；core 运行时读取（照 `skills/presets.ts` 读资源 JSON）；发行门禁清单 `apps/desktop/connector-release-gates.json`，构建期注入（照 `agent/external/catalog.ts:18-22` 与 `scripts/dist.mjs`；新常量在 `packages/core/src/build-constants.d.ts` 声明）。
- [x] 脚本 `scripts/import-mcp-registry.mjs`：从 MCP Registry 按 name 导出 `server.json` 骨架，`_meta` 扩展字段留占位人工补。
- [x] 契约测试 `packages/core/test/contract/connector-catalog.contract.ts`，由 `packages/core/test/unit/connector-catalog.test.ts` 包装执行（vitest 只收 `*.test.ts`）：每个条目 schema 合法、slug 唯一且符合字符集、图标文件存在、`remotes[0].url` 为 https、`toolPolicy` 中的风险值合法、带 `releaseGate`。



### 5.3 数据：迁移 `{N+1}_app_tools.sql`

- [x] `app_connection_tools`（设计 29 §12：`connection_id, tool_name, approved_hash NULL, current_hash, risk, user_policy NULL, definition_json`，PK `(connection_id, tool_name)`）。
- [x] `app_tool_grants`（`id, bot_id, connection_id, tool_name, conversation_id NULL, approval_id, created_at, revoked_at`；`conversation_id` NULL = 对该 Bot 总是允许；索引 `(bot_id, connection_id, tool_name) WHERE revoked_at IS NULL`）。
- [x] 清理：Bot 删除时撤销其全部 `app_tool_grants`（接入 `domain/lifecycle.ts`）；对话删除由外键 `ON DELETE CASCADE` 处理（`foreign_keys=ON`，`infra/db.ts:37`）；Bot 被移出群时撤销其在该对话的 `app_tool_grants`。



### 5.4 连接服务（`packages/core/src/apps/connections.ts`）

- [x] 目录连接：`apps.connect({ target: { kind: 'catalog', connectorId }, grantBotId? })`；`server_url` 取 `remotes[0].url`；`connector_ver` 记录目录版本；多账号 = 同一 connector 多行。`grantBotId` 由 **core** 在流程完成时写入该 Bot 的 `app_connection_ids`（不由渲染端改 Profile）。
- [x] **进入 McpService**：`McpService` 的服务器来源从「只有 settings」改为 `settings.mcpServers` ∪ 目录连接合成的 `McpServer`（`id = connectionId`、`name = 应用名（账号）`、`transport: 'http'`、`url = server_url`、`auth: 'oauth'`、`enabled: true`）；`listServers` / `#connections` / `closeAll` / `mcp.server_status` 均按此 id；授权提供者统一按「连接 id」从 `ConnectionAuthRegistry` 取（自定义为 `custom:{serverId}`，目录为 `connectionId`）；`mcpAutoApprove` 只对 settings 中的自定义 server 生效。
- [x] 账号识别（设计 29 §5.1 第 6 步）：有 `id_token` / userinfo → `account_sub` + 显示名；否则条目 `whoami` 只读工具；否则 `label = "{title} #{n}"`。`account_sub` 冲突（同账号重复连接）→ 复用旧行（更新令牌）而非新建。
- [x] **首连工具复核**：交换令牌后进入 `phase: 'reviewing_tools'`（事件带工具清单：名称、标题、描述、计算出的风险）；用户在面板确认 → `apps.connect.confirmTools({ flowId })` → 写 `app_connection_tools` 的 `approved_hash` → `connected`。拒绝 = 取消并吊销。
- [x] RPC：`apps.catalog.list`（含每个条目的已连接账号数）、`apps.connections.update`（标签、停用 / 启用）、`apps.connections.setToolPolicy({ connectionId, toolName, policy })`（`policy` 与 W5 的 `mcpToolPolicy` 同形：`{ approval?: 'auto'|'ask', enabled?: boolean }`；自定义 server 继续用 W5 的 `settings.mcpServers[].toolPolicies`，目录连接存 `app_connection_tools.user_policy` JSON）、`apps.connections.reviewTools({ connectionId, accept: string[] })`、`apps.connections.grants({ connectionId })` / `apps.grants.revoke({ grantId })`；事件 `apps.connection_status` 增 `tools_changed` 详情。

**实施记录（2026-10-09，§5.4 后端）**：`apps/connections.ts`（目录视图 / 流程目录端 / 连接管理）、`apps/auth/flow.ts`（目录目标、`reviewing_tools`、`confirmTools`、id_token / userinfo 账号标识、同站点授权服务器免确认直开）、`mcp/service.ts`（目录连接合成 server：`connectionToMcpServer`、`serverFor`、`listServers` = settings ∪ 目录连接）、`rpc/apps-connections-bindings.ts`；迁移 0026（原 0023，合入 main 时两次顺延）增 `approved_definition_json`（复核 diff 的“旧”）。`apps.connect` 增可选 `connectionId`（重新授权已有连接，账号必须一致）；自定义 server 的“测试 → 保存”经 `mcp.test` 的 `toolHashes` + `apps.tools.approveAfterTest` 只批准测试时看到的定义；`settings.update` 删除 server 时一并清 `custom:` 行与工具锁定行，并拒绝以 `conn`_ 开头的自定义 server id（保留给目录连接）。测试：`catalog-connect.test.ts`、`catalog-connections-rpc.test.ts`、`catalog-connect-units.test.ts`、`app-recovery.test.ts`、`security/catalog-connect-tokens.test.ts`。

### 5.5 策略：风险分级与工具锁定（`packages/core/src/apps/policy.ts`，纯函数为主）

- [x] **分级复用 W5**：直接调用 `core/mcp/risk.ts` 的 `classifyRiskDetailed`（若 D73 需要在 shared / 校验器中复用，再把纯函数移到共享位置并保持 W5 测试全绿）。D73 只在其外层叠加目录 `toolPolicy`：只能调高；`builtin` 条目可为**未声明注解且名字推断不出只读**的工具给出分级，不能放宽 W5 的判定结果。`openWorldHint` 不参与分级（只用于 §6.2 污点）。补表驱动单测覆盖「W5 结果 × 目录覆盖」。
- [x] `toolDefinitionHash(tool)`：对 `{ name, title, description, inputSchema, annotations }` 做规范化 JSON（键排序）后 sha256。
- [x] 工具刷新（`tools/list_changed` 或缓存过期）时：新增工具 → `approved_hash NULL`；定义变化 → `current_hash ≠ approved_hash`；二者都**不暴露**；连接状态 `tools_changed` 并发事件；删除的工具直接删行。
- [x] 锁定对**所有** MCP server 生效：过滤点在 `buildMcpTools`（注入 `toolFilter(serverKey, tools)`），自定义 server（含 stdio、无 OAuth）用 `custom:{serverId}` 行承载工具锁定（`server_url` 可为 NULL）。
- [x] **存量基线**：core 启动时若 `settings.apps.toolLockBaselineDone` 不为真，则为当时**已存在**的每个自定义 server 建 `custom:` 行并标记「首次拉取到的工具直接批准」（`app_connections.baseline_pending` 列，`{N+1}` 以 `ALTER TABLE … ADD COLUMN` 加入），完成后置位标记——只作用一次。之后新加的自定义 server：设置页「测试」成功后展示工具清单，保存即批准；未批准前工具不暴露。



### 5.6 网关与审批

- [x] 在 W5 的网关决策（`mcpToolDecision`，工具策略 > server `autoApprove` > 风险档默认）上扩展连接上下文 `{ connection?, accountLabel?, connectorSlug? }`，**不另起一套**：
  - 策略 `enabled:false` → 拒绝（W5 已有）；对话轮 / 只读子代理只能调「只读 + auto」工具（W5 / D75 已有，应用工具同样适用）。
  - 决策为 `ask` 时，新增一步：先查 `app_tool_grants`（本对话 or Bot 级、未撤销）→ 命中免卡；否则 `mcp_tool` 审批，`payload.durations`：`write` 为 `['once','conversation','bot']`，`destructive` 为 `['once']`（卡片标「不可撤销」）。
  - 审批通过且时长为 `conversation` / `bot` → 写 `app_tool_grants`。
- [x] `mcpToolApprovalPayloadSchema` 增可选 `connectionId`、`connectorSlug`、`accountLabel`、`risk`、`durations`（`approvalDurationSchema` 数组）；`ApprovalDecision.duration` 与 `approvals.decide` / RPC 入参改用 `approvalDurationSchema`；`decide()` 中：`'bot'` 只对 `mcp_tool` 且在 `payload.durations` 内时接受，否则降为 `'once'`；`'conversation'` 对 `mcp_tool` 同样按 `payload.durations` 判定（现只对 `agent_tool` 降级）；`grants` 表与 `agent_tool` 仍只见 `once|conversation`。同步 `ApprovalCard`、`renderContextLine`、`stores/permissions.svelte.ts:99`。
- [x] **无人值守**：沿用 W5——`mcp_tool` 所有风险档自动批准（用户决定），**不改** `NEVER_AUTO_DECIDED`；应用工具的风险档与账号身份写入审计与上下文行，Bot 详情的 MCP 风险提示覆盖应用工具。
- [x] `ApprovalCard.svelte`（W5 已有 `mcp_tool` 专用正文与 `McpRiskBadge`，在其上扩展）：显示「以 {account} 身份在 {app} 执行 {tool}」、时长选项按 `durations` 渲染；`destructive` 显示完整参数（不只摘要）与醒目提示。



### 5.7 Bot 授权与工具暴露

- [x] `botRuntimeSchema` 增 `app_connection_ids: z.array(z.string()).default([])`（Profile JSON，无迁移）；校验放在 bots 领域层（`bots.create` 与 `bots.update` 都会带 Profile）：每个 connector 至多一个连接、连接存在且未删除，否则 `INVALID_INPUT`。删除连接时从所有 Bot 移除。
- [x] 工具命名 `appToolName(slug, toolName)`：`app_{slug}_{tool}` sanitize `[A-Za-z0-9_-]`、≤50 字符（截断冲突时加短哈希后缀）。
- [x] orchestrator：在 MCP 接线旁新增连接应用接线（Bot 勾选的、`connected` 的连接 → 只暴露 `approved_hash === current_hash` 且未 `disabled` 的工具）；`expired` / `needs_scope` 的连接不暴露工具，进入 `<connected_apps>` 状态行。
- [x] `tools/index.ts` 汇总处加**全局去重**：任何 MCP / 应用工具与内置工具同名 → 丢弃并告警（现只在 MCP 之间去重）。
- [x] `<connected_apps>` 段：每个已授权连接一行（应用名、账号标签、状态、条目一句话说明）；`<available_apps>` 段：目录中未连接的已发行条目（名称 + 一句话，≤30 条）；平台规则补一句「需要未连接或需重连的应用时调用 `app_request_connection`」。
- [x] `app_request_connection` 完整版：`{ connector?: slug, connection_id?, reason }`；未连接 → `target: catalog`；已勾选但过期 → `connectionId`。



### 5.8 对话内连接（完整）

- [x] `ConnectAppPanel` 支持目录形态：图标、名称、将申请的权限、「连接后授权给当前 Bot」（默认勾选；该 Bot 已有同应用的另一账号时提示将替换）、工具复核步骤。
- [x] 卡片完成连接 → 按勾选写入 Bot 的 `app_connection_ids` → `runs.retry`。
- [x] 群聊多个 Bot 同时请求同一应用：后到的卡片加入同一流程（§4.6 去重），完成后各自按自身勾选授权。

**实施记录（2026-10-10，§5.8）**：`features/chats/ConnectAppSetupBody.svelte` 处理 `target.kind === 'catalog'`——`grantBot` = 失败 run 的 Bot（卡片「连接后授权给当前 Bot」默认勾选，该 Bot 已有同应用另一账号时提示替换），scopes = 连接行现有 ∪ 需求 `scopes`；用户已有可用连接但没勾给该 Bot 时给 `continueCandidate`（先 `contacts.update` 授权再 `runs.retry`）。「各自按自身勾选授权」落在 core：`apps/auth/flow.ts` 同目标去重时把后到者的 `grantBotId` 并入 `Flow.catalog.grantBotIds`，`confirmTools` 后 `CatalogFlowHost.confirm` 逐个 `BotsService.grantConnection`（每 Bot 单独 try / catch）；`Flow.ending` 守卫：授权开始 / 终止后再来的 `grantBotId` 起新流程、不追溯；渲染端保留幂等兜底（`done` 后本卡的 Bot 仍未持有则自行补写 Profile）。`ConnectAppPanel` 目录形态：图标 / 首字母、tier、scopes、隐私政策纯文本（渲染端无打开任意 URL 的通道）、`unavailableReason`、`reviewing_tools` 步骤（按破坏性 → 写 → 只读排序，「确认并完成连接」/「取消」）、`reconnectConnectionId`（只有它才落到既有连接）。偏差见 DEV-020 第 1 / 2 / 4 / 7 项。测试：`unit/oauth-connect-flow.test.ts`（去重并入、`ending`、scopes 旧 ∪ 新）、`integration/catalog-connect.test.ts`（重连 scope 并集、两 Bot 共享流程）、渲染端 `features/apps/connect-flow.test.ts`。

### 5.9 设置「应用」分区

- [x] `stores/shell.svelte.ts` 分区 id 新增 `apps`，`mcp` 作为别名映射到 `apps` 的「自定义」页；`SettingsDialog` 导航用 `Plug` 图标替换原 MCP 项。
- [x] `features/settings/AppsSection.svelte`：三个页签——**目录**（卡片网格、搜索、分类、tier 标签、连接按钮）、**已连接**（按应用分组的连接列表：账号、状态、已授权 Bot、最近使用）、**自定义**（嵌入现 `McpSection`）。
- [x] 连接详情页：权限范围、逐工具列表（风险徽标 + 策略下拉）、待复核工具 diff（旧 / 新定义对比）、Bot 级持续授权列表（可撤销）、重新连接、断开（确认框列出受影响 Bot）。
- [x] `BotProfileForm.svelte`：「应用」区按应用分组，单选账号；未连接的应用显示「去连接」（`shell.openSettings('apps')`）；工具数估计纳入应用工具。
- [x] 图标加载照 `agent-icons.ts`；i18n。

**实施记录（2026-10-10，§5.9）**：`features/settings/sections.ts`（`SettingsSectionId` 增 `apps`，`mcp` 别名 → `apps` 自定义页，`resolveSettingsSection` / `appsTabForKey`）、`stores/shell.svelte.ts`（`settingsAppsTab`，`openSettings(section, anchor?, appsTab?)`）、`SettingsDialog` 导航 `apps`（`Plug`）取代 MCP 项（`settings.navMcp` 删除）；`AppsSection.svelte` 三页签（a11y `role=tablist` + 方向键）；`features/apps/AppCatalogGrid.svelte`（搜索、分类芯片、tier 徽标、连接 / 再连一个账号 → 内嵌 `ConnectAppPanel`）、`AppConnectionsList.svelte`（按应用分组、状态徽标、已授权 Bot 数、最近使用）、`AppConnectionDetail.svelte`（标签编辑、停用开关、权限范围、待复核 diff〔`app-tools.ts` 行级 LCS `diffLines`，超大 schema 退化为整块删 / 增〕、接受所选 / 全部 → `apps.connections.reviewTools`、工具表 `McpRiskBadge` + 策略下拉 → `setToolPolicy`、授权列表 + 撤销、重新连接〔`reconnectConnectionId` + scopes〕、断开确认列出受影响 Bot）；`stores/app-detail.svelte.ts`（工具 / 授权缓存与动作）、`stores/apps.svelte.ts`（目录、`connect(connectionId)`、`confirmTools`、`toolsByConnection` 缓存与失效）。`features/bot-panel/bot-apps.ts` + `BotProfileForm`「应用」区：每应用单选 不使用 / 账号，「去连接」→ `openSettings('apps', undefined, 'catalog')`，工具数估计从已暴露的应用工具算，无人值守提示。`McpSection.svelte`：测试结果只归属被测 server，工具芯片带风险，「批准这些工具」/「保存并批准工具」→ `apps.tools.approveAfterTest`（`mcp.test` 不登记锁定行，见 DEV-020 第 3 项），待复核徽标；`settings.svelte.ts testMcp` 返回 `McpTestResult`。i18n `apps.`* / `settings.navApps` / `settings.mcpTools*` / `contacts.apps*`。独立评审 9 项已修（重连 scopes、目录连接解析、标签草稿重置、工具估计重取、重复加载、testid、页签 a11y、each key、navMcp 残留）。测试：`features/apps/app-catalog.test.ts`、`app-tools.test.ts`、`bot-panel/bot-apps.test.ts`、`settings/sections.test.ts`；渲染端合计 13 文件 111 例，typecheck 0 错误。

**扩展中心修订（2026-10-10，extension-center X1–X4）**：本节的页签结构已调整——「目录」页签并入扩展中心「连接」组，「自定义」页签移到「设置 → 开发者模式」分区（`mcp` 别名与 `apps` + `custom` 旧参数落该分区），「应用」分区只留已连接账号管理；`appsTabForKey` 随页签移除。组件（`AppCatalogGrid` / `AppConnectionsList` / `AppConnectionDetail` / `McpSection`）不变，只换承载位置。详见设计 29 §16 与 [extension-center.md](extension-center.md)。

### 5.10 外部智能体（ACP）

- [x] `HOST_CAPABILITIES` 增 `apps` 能力包（`category: 'supplement'`、`default: 'follow_bot'`、`toolPrefixes: ['app_']`、无 `overlapsNative`）；`app_request_connection` 归入该包（前缀即可命中 `capabilityOfTool`）。
- [x] 宿主桥的工具名经 `fitToolName` 后 `mcp__kepcup__{name}` 总长 ≤64 的测试。
- [x] 桥的 `tools/list` 为应用工具输出与风险一致的注解（扩展 `toolAnnotations` / `READ_ONLY_TOOLS` 的判定：`read` → `readOnlyHint:true`；`destructive` → `destructiveHint:true`），让外部 Agent 侧的权限提示与宿主一致。
- [x] ACP 提示词（`buildAgentRunContext`）同样注入 `<connected_apps>` / `<available_apps>`。
- [x] 外部智能体自身 shell / fetch 不受网关管控的残余风险：Bot 切到外部智能体且勾选 `apps` 包时，首次弹框说明（文案键）。

**实施记录（2026-10-10，§5.10）**：shared `domain/host-capabilities.ts` `apps` 包（`supplement` / `follow_bot` / `toolPrefixes: ['app_']`）；`agent/external/capabilities.ts toolAnnotations` 对应用工具按风险出 `readOnlyHint` / `destructiveHint`；orchestrator 的 ACP run 上下文带 `connectedApps` / `availableApps` 两段（`mapAppToolNames` 把正文里的 `app_request_connection` 映射为桥所见名）。一次性提示：`bot-apps.ts shouldShowAcpAppsNotice`，在 `BotProfileForm` 切到外部智能体 / 勾上 `apps` 包 / 在智能体下选中应用账号时各检查一次，确认存 `localStorage` `kepcup.apps.acpNoticeAck`（按本机，DEV-020 第 6 项）；文案键 `apps.acpNotice.`*。测试：`integration/connected-apps-p1-gate-acp.test.ts`（桥 `tools/list` 注解、名字 ≤64、提示词两段、经桥审批一致）、`unit/app-prompt-capabilities.test.ts`、渲染端 `bot-apps.test.ts`。

### 5.11 P1 验收（门禁）

- 附录 B 的首批应用（spike 通过者）可从目录连接、多账号、Bot 勾选、在对话中完成任务。
- 端到端（假服务器）：新用户说「把这个 bug 记到 X」→ 连接卡 → 授权 → 工具复核 → `runs.retry` → 写工具审批卡（显示账号）→ 完成。
- 风险分级（复用 W5）：只读工具免审；`destructiveHint:false` 写工具弹卡且可选三种时长；缺注解且名字推断不出只读的工具按 destructive 弹卡（仅「仅这一次」）；无人值守下全部自动批准，审计记风险档与账号。
- 工具锁定：假服务器修改某工具描述后，该工具从 Bot 工具集消失，复核后恢复。
- ACP Bot 勾选 `apps` 包后可调用应用工具，审批一致。
- 安全测试仍通过；D65 / D72 回归全绿（跑相关测试文件即可，全量留到交付前一次）。

**门禁结果（2026-10-10）**：自动化部分全绿——第 2 条（端到端）、第 3 条（风险分级）、第 4 条（工具锁定）由 `packages/core/test/integration/connected-apps-p1-gate.test.ts`（4 例）覆盖，第 5 条（ACP）与 Bot 校验 / 全局去重由 `connected-apps-p1-gate-acp.test.ts`（3 例）覆盖，第 6 条：`security/catalog-connect-tokens.test.ts` + `connected-apps-tokens.test.ts` 通过，D73 相关回归 45 文件 517 例 0 失败（Docker `kepcup-test:trixie`）。**待用户的部分**：第 1 条（附录 B 的首批应用真实连接、多账号、Bot 勾选、对话中完成任务）需 **U2**——提供测试账号 → 带登录的 spike（§5.1 第 2 项）→ 补 `catalog.json` 的 `toolPolicy` / `whoami` / `scopes` → 把通过者加入 `connector-release-gates.json`（当前 `approved: []`，6 条全部门禁关闭）；U1（CIMD 部署、`verify.mjs`、Notion / Linear 手工走通）沿 P0 未动。偏差汇总见 `docs/dev/DEVIATIONS.md` DEV-020；进度见 `docs/dev/PROGRESS.md`「连接应用 P1」。

---



## 6. P2 — 规模化与大平台



### 6.1 权限追加（step-up）

- [x] 运行时 `reason: 'scope'` → 卡片说明新增权限 → `apps.connect({ target, connectionId, scopes })` 以 `stepUpScope` 并集重新授权（跳过刷新）。
- [x] 计数：`(conversationId, connectionId)` 30 分钟窗口内至多 1 次 step-up 卡（进程内 Map 即可，重启清零可接受）；超出时工具结果为普通失败文本。
- [x] 默认最小范围：目录 `auth.scopes.default` 只读优先，写权限在 `insufficient_scope` 时追加。

**实施记录（2026-10-10，§6.1）**：`apps/step-up.ts` `AppStepUpLimiter`（进程内，(对话, 连接) 为键，`APP_STEP_UP_WINDOW_MS`=30 分钟）。关键约束是**名额与出卡分离**：工具调用当下只用非消耗的 `isAvailable()` 决定出卡 / 普通失败（`mcp/tools.ts` 的 `onSetupRequired` 返回 `false` → 工具结果 `APP_SCOPE_INSUFFICIENT`，文案要求模型别重试、请用户去设置重新授权），名额由 orchestrator `#commitStepUp` 在胜出的 setup 需求让 run 以 `failed` 收尾时才 `tryAcquire`——同一 run 里多个连接各自要求追加权限、最终只有一个需求胜出（后写覆盖），落选的不该白白烧掉名额（评审发现的「名额被烧 / 连接卡死」）。挑战要求的 scopes 存 `AppConnectionStore` 的进程内映射（`setPendingScopes` / `getPendingScopes`，经 TokenVault；`runtime-provider.onUnauthorized` 写，迁移已冻结所以不落库），`AppConnectionsService #begin` 并入重新授权的请求，使卡片被忽略 / 被限流抑制后设置页「重新连接」与 `apps.connect({connectionId})` 仍能补上缺的权限；重启丢失，下一次 403 重新得到。渲染端 `ConnectAppSetupBody` 显示「需要追加的权限」（`apps.setupScopesAdded`）。目录连接首次只申请 `auth.scopes.default`。偏差见 DEV-021 第 6 项。测试：`unit/app-step-up-discovery`、`integration/connected-apps-p2-stepup-discovery`（默认 scope → 一张卡 → 并集重连 → 重试成功；同对话再命中为普通失败；另一对话仍出卡；被忽略的卡之后设置页式重连补上 scope）。

### 6.2 污点外发控制（设计 29 §8.3）

- [x] 污点状态表（随 `{N+2}_egress_approval.sql`）：`app_taint(bot_id, conversation_id, first_at, expires_at)`；任意应用工具**成功返回内容**后置位 / 续期 24 小时。按（Bot, 对话）计，`runs.retry` 与续接天然继承。
- [x] 新审批 kind `egress`（设计 29 §8.3 / §12 已同步；同迁移重建 `approvals` CHECK，带全现有 kind；§8.1「不新增审批 kind」只针对应用工具本身的审批）：payload `{ channel: 'web_fetch'|'web_search'|'browser'|'app_tool'|'mcp_tool', target, summary }`，时长仅 `once`。
- [x] 污点期间拦截点：应用 / 自定义 MCP 非只读且 `openWorldHint !== false` 工具（即使有持续授权也要卡）；`web_fetch`（任意 URL）、`web_search`；浏览器导航与表单提交；沙箱 `bash` 在 Bot `network_policy === 'open'` 时强制逐条 `command` 确认；`git_remote` 卡片附加污点提示；ACP 权限桥对网络类请求降为逐次确认。
- [x] 无人值守：按 D41 / W5 自动批准，但审计 action `egress_tainted` 标记，Bot 详情汇总展示。
- [x] 开关 `settings.apps.taintGuard`（默认 true，高级）。
- [x] 测试：读取应用数据后 web_fetch 弹 `egress` 卡；retry 后仍弹；关闭开关后不弹；24 小时后过期。

**实现记录（2026-10-10）**：迁移 `0027_egress_approval.sql`（`approvals` 重建 + `app_taint`）；`core/apps/taint.ts`（`TaintService`）；网关 `ToolGateway.egressCheck` / `markAppTaint` / `taintOf`。决定：①污点**来源**只有目录连接的应用工具（成功返回后在 `wrapMcpTool` 置位），自定义 MCP 工具是通道不是来源；②污点期间非只读应用 / 自定义 MCP 工具：本会免卡的调用（持续授权命中、auto 策略 / server autoApprove）改弹 `egress` 卡（channel `app_tool` / `mcp_tool`，只有「允许一次」）；本来就要弹 `mcp_tool` 卡的调用不叠第二张卡——该卡带 `tainted` 标记并展示完整参数；③沙箱 `bash`：沙箱可用且 `network_policy === 'open'` → `egress`（channel `bash`）逐条确认，确认模式（无沙箱）本就逐条 `command` 确认 → 不叠第二张卡，`command` 卡带 `tainted` 标记与提示，`request_unsandboxed` 同；④浏览器：`browser_open`、点击按钮 / 链接 / 未知 ref、按 Enter 为外发（卡里列出提交前已输入的内容，敏感项遮蔽）；⑤对话轮 / 子代理不等待审批（D75），非无人值守时失败并引导 `start_task`；⑥ACP 权限桥：fetch 类请求与 agent 沙箱内自动放行的命令（允许名单内只读命令除外）降为 `egress` 逐次确认；⑦无人值守自动批准 + 审计 `egress_tainted`（`command` / `git_remote` 的 `tainted` 卡同），Bot 详情 `apps.egressSummary` 汇总；⑧开关在设置「无人值守」分区（`settings.update` 的 `apps.taintGuard`）。测试：`unit/egress-migration`、`unit/taint-egress`、`unit/browser-tools-taint`、`unit/permission-bridge-taint`、`integration/connected-apps-p2-egress`。

**补记（2026-10-10，独立评审后）**：①通道还包括 `watch_create`（网页监看会周期性用 Bot 的浏览器资料访问 URL，`egress` channel `watch`）；`egress` payload 的 `channel` 枚举最终为 `web_fetch|web_search|browser|app_tool|mcp_tool|bash|git_remote|watch`。②污点按**对话**判定并传递：群聊里任一成员的行未过期则全体的外发都要确认；委派投递 / 结果贴回经 `DelegationsService.onMoved` → `TaintService.inherit` 把污点带到目标对话（保留 `first_at`，`expires_at` 取较晚者），否则污点可经 Bot 间交接洗白；对话删除删该对话全部行，Bot 删除只删它私聊里的行。③自定义 MCP 读工具若显式声明 `openWorldHint:true` 也算外发通道（目录读工具与缺省注解不算）。④浏览器点击改为 deny-by-default：只有一小组惰性角色（文本框、滑块等）免确认，未知 ref 也算外发。⑤W4 重复效果门对 `egress` 卡不启用（浏览器点击 / Enter 的参数在不同快照间重复，误判会让无人值守也停下）；`app_tool` / `mcp_tool` 通道仍按 `mcp_tool` 判定。⑥无人值守审计：`mcp_tool` 卡（含带 `tainted` 标记的）也记 `egress_tainted`，channel 标签正确。⑦接受不改：`browser_type` 向已打开且已批准的页面输入不拦；被污点数据经 `remember` / wiki 写入后会出现在之后无污点的对话里（规格范围内）。偏差见 DEV-021 第 3 / 4 / 7 项。

### 6.3 按需工具发现

- [x] 阈值常量 `APP_TOOLS_INLINE_MAX`（如 40，按全部应用工具总数）。超过时：只注入 `<connected_apps>` 摘要 + 两个稳定工具 `app_search_tools(query, connector?)`（返回匹配工具名、说明、参数 schema）与 `app_call_tool(name, arguments)`（分发器：按被调工具自身风险走网关与锁定，审批卡显示真实工具）。工具列表 run 内不变。
- [x] 测试：超阈值时工具数稳定；`app_call_tool` 调用未批准 / 被禁用的工具被拒。

**实施记录（2026-10-10，§6.3）**：`APP_TOOLS_INLINE_MAX`=40、`APP_SEARCH_RESULTS_MAX`=20（shared `constants.ts`）。`exposure.ts appToolsDeferred(count)`（严格大于阈值）在 orchestrator run 开头对 Bot 全部目录应用工具（锁定 / 停用过滤后）算一次，之后 run 内不变；自定义 MCP 工具仍逐个暴露。`apps/discovery.ts buildAppToolDiscovery`（`search` / `call` / `originOf`）与 `tools/app-tools.ts buildAppDiscoveryTools`（`app_search_tools` / `app_call_tool`；`buildAppTools` 在有 discovery 时一并注册）。`app_call_tool` **不自己实现任何审批**：转给 orchestrator 为同一批条目包装好的真实工具（`wrapMcpTool` → `gateway.mcpToolCall` 恰好一次），真实工具卡 / grant / 工具锁定与停用 / 逐工具策略 / step-up / 脱敏全部原样生效；入参先用 `validateToolArguments` 按真实工具 schema 校验；`name` 不在本 run 集合里（未批准 / 待复核 / 被停用 / 别的 Bot 的 / 捏造的）一律拒绝。效果台账经新增的 `ToolDefinition.mcpOf?(params)` 钩子（`agent/types.ts`、`effects/recorder.ts`）按被调工具的风险分级，而不是把 `app_call_tool` 一律当外部写。搜索结果与说明来自第三方，经 `untrustedBlock()` 包裹（此函数同时修正了 `mcp/tools.ts` 普通结果里 `</untrusted>` 可提前闭合边界的问题）。提示词：`<connected_apps>` 相关行标「工具按需发现」并加用法规则。只读子代理拿同样两个工具，范围限于只读 + 免审子集；ACP 桥 `tools/list` 与提示词随同一决定。偏差见 DEV-021 第 8 项。测试：`unit/app-step-up-discovery`、`integration/connected-apps-p2-stepup-discovery`（超阈值只剩摘要 + 两个稳定工具；`app_call_tool` 走真实网关；停用 / 锁定 / 未知工具被拒；阈值内不变）、`integration/connected-apps-p2-discovery-acp`。

### 6.4 预注册客户端与大平台条目

- [x] `apps/desktop/oauth-clients.json`：`{ [clientRef]: { issuer, clientId, clientSecret? } }`（仅放平台定义为**非保密**的桌面客户端凭据），构建期注入 `__KEPCUP_OAUTH_CLIENTS__`；流程第 2 步按 `clientRef` 取用；用户可在「自定义」中按 issuer 覆盖（BYO 客户端）。
  - 实施记录（2026-10-10）：客户端选择顺序 = 用户自带 / 已存的非 DCR 客户端（`apps.oauthClients.*`，`source: manual`）→ 目录 `clientRef`（无 `clientRef` 的自定义 server 按 issuer 在表里找；表项 issuer 与发现到的不符则不用）→ 此前 DCR 得到的客户端 → CIMD → DCR → `OAUTH_CLIENT_REQUIRED`。`registration: 'preregistered'` 条目仅当 `clientRef` 在表里有项时 `connectable`，否则 `unavailableReason`。表项不复制进 Token Vault（连接各自记授权时所用客户端供刷新 / 吊销）。Google / Microsoft / Slack / GitHub 条目待 U3 / U4，表现为空。
- [ ] Google Workspace（需 **U4**）：Workspace MCP 端点（预览，以届时文档为准）+ Google「桌面应用」客户端；首批只用非受限范围（`drive.file`、日历、`gmail.send` 等），受限范围等用户决定 CASA；`tier: builtin` + `releaseGate`。
- [ ] Microsoft 365、Slack（需 **U4**）：同上模式；Slack 只能用已发布 / 内部应用。
- [ ] GitHub（若 P1 spike 证实不支持 CIMD，需 **U3**）。
- [ ] Figma：未获白名单前不进目录。

**状态（2026-10-10，§6.4）**：上面四条**保持未勾**——机制（预注册表、`clientRef` 解析、`registration:'preregistered'` 条目的 `connectable` 判定、BYO 覆盖）已在第一条实现并测试，但真实平台条目需要用户在各平台注册客户端（**U3**：GitHub App；**U4**：Google Cloud 桌面客户端 / 同意屏幕 / 应用验证、Microsoft Entra 应用、Slack 应用、Figma 合作申请）后才能放进 `oauth-clients.json` 与 `catalog.json`，当前表为 `{}`、目录里没有这几家。填表步骤见 `apps/desktop/oauth-clients.README.md`。复查修复与偏差：客户端选择顺序与「预注册不回退」见 DEV-021 第 2 项；issuer 规范化（trim + 去尾斜杠）、DCR 保存不覆盖中途出现的 BYO 客户端、`apps.oauthClients.set` 不带 secret 时保留原 secret（`clearSecret` 清除、换 client id 丢弃）；渲染端 `OAuthClientsPanel`（「自定义」页，按 issuer 管理）。测试：`unit/oauth-clients`、`integration/oauth-clients`（预注册公开 PKCE 客户端端到端、issuer 不符不回退、BYO 压过预注册、并发 DCR 与 BYO）。

### 6.5 MCPB 本地包

- [x] 解析与校验 manifest v0.3（`server.type` node / python / binary / uv、`mcp_config`、`user_config`、`compatibility`）；平台 / 运行时不兼容给出可读错误。
- [x] 安装：审批卡显示**完整启动命令**、来源、体积（环境管理器 D13 流程）；解包到 `~/.kepcup/toolchains/mcpb/{name}@{version}/`（内容哈希校验）；运行时由环境管理器按需安装。
- [x] `user_config`：`sensitive` 字段存 `mcp:{serverId}:env:{name}`；生成一条自定义 stdio server（标注来源 bundle、tier `developer` 除非来自目录）。
- [x] 入口：设置「自定义」页「安装 .mcpb」（扩展中心修订后：扩展中心「MCP」组「安装 .mcpb」）+ 目录条目的 `packages[].registryType === 'mcpb'`。

**实施记录（2026-10-10，§6.5）**：`core/src/apps/mcpb/{manifest,zip,install,index}.ts`、`rpc/mcpb-bindings.ts`、shared `domain/mcpb.ts`（RPC `mcpb.inspect` / `mcpb.install({path, sha256, userConfig, conversationId?, fromCatalog?})`）、`mcpServerSchema.source{kind:'mcpb',name,version,sha256}`（`name` / `version` 正则约束，不含路径分隔符）+ `tier`；错误码 `MCPB_INVALID` / `MCPB_INCOMPATIBLE` / `MCPB_RUNTIME_MISSING`。流程：包文件先拷成私有快照（防检视后被替换的 TOCTOU）→ `inspect`（sha256、manifest v0.1–v0.3、兼容性、zip 加固：zip-slip、符号链接、绝对路径、盘符、Windows 设备名、冒号、尾随点 / 空格、重名与大小写冲突、条目数 / 单条 / 解压总量 / 文件大小上限、中央目录声明大小自洽——伪造的 `compressedSize` 曾使进程中止，已修）→ 解到 `{toolchains}/mcpb/{name@version 小写}/`（暂存目录 + 标记文件〔sha256 + 目录树哈希〕，复用前重新校验，只删标记匹配的目录）。`sensitive` 的 `user_config` 存 secrets `mcp:{serverId}:env:{KEY}`，设置里只留 `secret:env:KEY` 占位符且必须是整个参数 / 环境变量值；`mcp_config.command` 不得依赖 `user_config`。运行时经环境管理器（`envManagerRuntimeResolver`；`CoreServicesOptions.mcpbRuntimes` 为测试钩子），缺运行时给可读错误、不下载任何东西（未走「按需安装」，留待后续）；binary 包直接运行。同意方式：设置页没有对话可承载审批卡，以对话框内确认面板（完整启动命令、来源、sha256、体积）为同意，`mcpb.install` 必须回传面板上的 `sha256`；带 `conversationId` 才出 `environment` 类审批卡（完整命令，密钥遮蔽）。**已知隐患**：D41 无人值守会自动批准该 `environment` 卡（`integration/mcpb` 有用例锁定该行为），任何将来由 Agent 发起的安装入口必须先加「永不自动批准」标记；本期无此入口。审计 `mcpb_install` / `mcpb_uninstall`（只含包标识）；`mcp.removeServer` 与 `settings.update` 移除 server 都经 `afterServerRemoved` 清解包目录与密钥。入口：渲染端 `McpbInstall.svelte`（「自定义」页，选文件走主进程 `dialog:selectFile`）；目录条目 `packages[].registryType==='mcpb'` 的后端路径 `fromCatalog`（须匹配固定的 `fileSha256`，且不带 `developer` 档）已实现，**界面按钮「安装本地包」与 URL 下载安装未做**。延后：python / uv 的端到端测试、启动前自动复验。偏差见 DEV-021 第 1 / 5 项。测试：`unit/mcpb`、`integration/mcpb`、渲染端 `settings/mcpb-install.test.ts`、testkit `mcpb-fixture.ts`。

### 6.6 开发者模式

- [x] 设置开关（扩展中心修订后：设置 → 开发者模式分区）；开启后「自定义」页显示原始工具定义（含注解）、授权流程事件日志（不含令牌）、手动刷新工具；自定义条目 tier `developer`：所有工具每次确认（可手动放宽，`destructive` 除外）。
  - 实施记录（2026-10-10）：事件日志 = `apps.flowLog`（进程内环形缓冲，每 server 100 条，授权地址只留 host+path，错误文案过脱敏）；原始定义 = `mcp.rawTools`；手动刷新 = `mcp.refreshTools`（丢弃缓存重新列出，工具锁定照常登记；未开开发者模式也允许调用，只是界面隐藏）。**偏离**：「developer 档 = 全部每次确认」只对 `McpServer.tier === 'developer'` 的 server 生效（`mcp/policy.ts` 的 `isDeveloperTier`，MCPB 包安装生成的 server 带该标记），**不**对所有自定义 server 生效——否则会改变 W5 已落地的「只读自动」默认，用户未要求；普通自定义 server 保持 W5 默认。
  - 测试与复查（2026-10-10）：`unit/mcp-policy`（开发者档策略表、日志脱敏、LRU 与环形上限）、`integration/developer-mode`；评审后补强的脱敏覆盖 JSON / 冒号形态 / `Bearer` / JWT / 长不透明串（字母-only、十六进制）并叠加 `SecretsService.redact`，日志按 server 隔离、仅在内存、server 移除（`mcp.removeServer` 与 `settings.update`）时清除。渲染端 `McpDevTools.svelte`，开关在「自定义」页。偏差见 DEV-021 第 1 项。



### 6.7 协议版本

- [x] 跟踪 `pi-mcp` 对 MCP 2026-07-28（无状态、MRTR、`server/discover`）的支持；若 P2 开始时仍无：spike 在 `McpService` 的 HTTP 连接中改用官方 `@modelcontextprotocol/sdk` 届时支持 2026-07-28 的版本（当前锁定 1.32.1 为 v1 线，需评估升级对宿主桥的影响），接口不变；假服务器增加无状态模式以覆盖。结论记附录 B。

**结论（2026-10-10，§6.7）**：只读源码与锁文件，未联网——`pi-mcp@1.0.2` 与 `@modelcontextprotocol/sdk@1.32.1` 都只到 `2025-11-25`，没有 `server/discover` / 无状态 / MRTR；**本期不动，保持 pi-mcp**；触发条件、改造路径与假服务器无状态模式的需求见附录 B.6。

### 6.8 「+」菜单临时开关（可选）

- [ ] 对话输入坞「+」菜单列出当前 Bot 已授权的应用，可在本对话临时关闭某应用（存对话级设置，不影响 Bot 授权）。

**状态（2026-10-10，§6.8）**：可选项，**未做**（需要对话级设置存放处与输入坞菜单改动，收益小于 P2 其余项；留待有明确需求再做）。

### 6.9 P2 验收（门禁）

- step-up、污点、按需发现的测试全绿；至少一个预注册客户端条目（Google 或 GitHub）真实走通（依赖用户待办）；MCPB 示例包安装运行；协议版本结论明确。

**门禁结果（2026-10-10）**：自动化部分全绿——step-up 由 `unit/app-step-up-discovery` + `integration/connected-apps-p2-stepup-discovery` 覆盖；污点由 `unit/egress-migration`、`taint-egress`、`browser-tools-taint`、`permission-bridge-taint` + `integration/connected-apps-p2-egress`（retry 继承、关开关、委派传递、无人值守审计）覆盖；按需发现由 `connected-apps-p2-stepup-discovery` + `connected-apps-p2-discovery-acp` 覆盖；MCPB 示例包（testkit 生成）由 `unit/mcpb` + `integration/mcpb` 安装并被 Bot 调用；预注册 / 自带客户端由 `unit/oauth-clients` + `integration/oauth-clients`（假授权服务器上的预注册公开客户端）覆盖；开发者模式由 `unit/mcp-policy` + `integration/developer-mode` 覆盖；协议版本结论见附录 B.6（保持 pi-mcp）。全量回归：2912 通过 / 28 失败（Docker kepcup-test:trixie）——其中 26 例为沙箱 / es-git / wiki 环境基线（sandbox-isolation、toolchain-sandbox、environment、projects、skills、skills-authoring、wiki-url、workspace-tools），另 agents-service、memory 各 1 例为负载下的偶发失败，单跑均通过；pnpm typecheck、pnpm lint 通过。**待用户的部分**：第 2 条的**真实**预注册条目（Google / Microsoft / Slack / GitHub）需 **U3 / U4** 注册客户端后填 `oauth-clients.json` 与 `catalog.json`，再按 U2 的做法逐家走通后加入放行清单；U1 / U2 沿 P0 / P1 未动。偏差汇总见 `docs/dev/DEVIATIONS.md` DEV-021（待决定）；进度见 `docs/dev/PROGRESS.md`「连接应用 P2」。

---



## 7. P3 — 开放平台基座



### 7.1 签名目录索引

- [x] 索引格式 `connectors/v1/index.json`：`{ version, generatedAt, keyId, entries: server.json[] }` + 分离签名 `index.json.sig`（Ed25519，base64）；增量 `deltas/{from}-{to}.json` 按内容寻址。
- [x] CI 签名脚本 `scripts/sign-connector-index.mjs`（私钥只从 CI 环境变量读取，**用户待办 U5**）；公钥列表（含 keyId，支持轮换）编译进 shared 常量。
- [x] 客户端 `apps/directory-sync.ts`：每日拉取 `https://dl.kepcup.com/connectors/v1/index.json`（ETag）→ Node `crypto` 验签 → 防回滚（`generatedAt` 单调、记录最后版本）→ 与打包快照合并（同名取较新且通过验签者）→ 缓存 `~/.kepcup/cache/directory/`；验签失败回落快照并告警。
- [x] `infra/cloudflare/directory/`：Static Assets 或 R2 自定义域部署材料（设计 29 §15.2）。

**实施记录（2026-10-10，§7.1）**：shared `domain/directory-index.ts`（索引信封、增量文件 schema 与内容寻址路径、`CONNECTOR_INDEX_PUBLIC_KEYS`〔**生产列表为空，等 U5**〕、`selectIndexKey`、`stableStringify` / `canonicalEntriesJson` / `applyDirectoryDelta`、状态 `disabled|ok|degraded|stale`、各常量）；`scripts/sign-connector-index.mjs`（`--out/--key-id/--previous/--generated-at` 签名；`--verify`；`--generate-dev-key`〔测试用，拒绝写进仓库树〕；私钥只读环境变量 `KEPCUP_CONNECTOR_SIGNING_KEY`；条目校验失败即中止除非 `--skip-validation`；超前一天以上的 `--generated-at` 拒绝；自检按密钥有效期）；core `apps/directory-sync.ts`（每日拉取 ±10% 抖动、失败约 1 小时后重试、ETag、对原始字节验 Ed25519、4 MiB / 5000 条上限、`generatedAt` 严格单调的棘轮〔`~/.kepcup/cache/directory/state.json`；相等仅限同一份字节；超前一天以上拒绝；缓存加载时重新验签〕、原子写缓存、RPC `apps.directory.status` / `apps.directory.sync`、`settings.apps.directorySync` 默认 `true`〔关闭 → 远端条目清空并 bump 修订号〕）；`apps/directory-merge.ts`（合并规则见 DEV-022 第 1 / 12 项）与 `apps/catalog.ts` 合并视图；`infra/cloudflare/directory/`（`wrangler.jsonc`、资源根的 `public/_headers`、README 含密钥轮换、`verify.mjs`）。**增量文件由脚本生成，客户端暂不消费**（DEV-022 第 3 项）。生产公钥为空时同步 `disabled`（不联网）。测试：shared `directory-index`；core `directory-sync`（28）、`directory-merge`（16）、`sign-connector-index`（12）、集成 `connected-apps-p3-tier-directory`。偏差见 DEV-022 第 1 / 3 / 11 / 12 项。

### 7.2 分级信任落地

- [x] `tier` 影响默认值：`community` 写工具不可「对该 Bot 总是允许」、首连额外提示；`developer` 全部每次确认。目录 UI 社区分组默认折叠、`verified` 标识。

**实施记录（2026-10-10，§7.2）**：core `apps/tier.ts`（`community` 写工具时长只有 `once` / `conversation`，任何创建路径都不能产生 Bot 级授权——`AppToolGrants.create({connectionTier})` 兜底拒绝、`find({excludeBotLevel})` 令既有 Bot 级行对该档不命中；分级未知 / 缺失 fail-closed；`developer` 沿用 P2 的 `isDeveloperTier`）；首连确认：渲染端勾选框 + core 强制（`apps.connect.confirmTools({acknowledgeCommunity})`，缺确认 → `INVALID_INPUT`），无工具可复核的社区条目没有该步；`reviewing_tools` 事件带 `tier`；`AppCatalogGrid.svelte`：内置在前、社区组默认折叠（搜索时 / 只有它有命中时自动展开）、`verified` 带「认证」徽标、目录同步降级时一行提示；`apps/prompt.ts oneLine` 清洗远端标题 / 说明（去 `<>`、控制 / 双向 / 零宽字符）再进 `<available_apps>` / `<connected_apps>`。偏差见 DEV-022 第 2 / 13 项。测试：core `app-tier`（11）、`app-prompt-sanitize`（4）、集成 `connected-apps-p3-tier-directory`；渲染端 `tier-grouping.test`（13）。

### 7.3 子注册表 Worker

- [x] `infra/cloudflare/registry/`：Workers + D1 实现官方 Registry OpenAPI v0.1 的只读接口（`GET /v0.1/servers`、`/v0.1/servers/{name}/versions` 等，以官方 OpenAPI 为准）；Cron 触发从官方注册表同步；审核状态表；`createMcpHandler` 不需要。部署为 `registry.kepcup.com`（U5）。
- [x] 用官方 Registry 的 OpenAPI 做契约测试。

**实施记录（2026-10-10，§7.3）**：`infra/cloudflare/registry/` 已实现——`src/worker.ts`（`GET /v0.1/servers`、`…/{name}/versions`、`…/versions/{version|latest}`、`health|ping|version`，`/v0` 别名；非 GET 一律 405；`(name, version)` keyset 游标、`limit` 默认 30 / 最大 100、`updated_since`、`search`、ETag / 304、Cache API 读穿透）、`src/sync.ts`（Cron 增量同步，有界可续，幂等 upsert，`is_latest` 唯一，网络失败不抛、不碰 `reviews`）、`schema.sql`（D1 三表）、`wrangler.jsonc`（`database_id` 为占位）。审核合并：仅 `approved` 的审核对外带 `_meta["app.kepcup/connector"].tier` 与 `app.kepcup/review`，发布者自标的 tier 被剔除。**契约测试**用 2026-10-10 联网抓取的官方 `openapi.json` 的手工维护子集（`test/openapi-v0.1.subset.json`）校验每种响应；Docker 内 `node scripts/run-tests.mjs run infra/cloudflare/registry` 144 例全绿（评审修复后；`node:sqlite` 内存库实现 `D1Like`，无 wrangler / miniflare）；`npx tsc -p infra/cloudflare/registry --noEmit`、eslint、prettier 通过。有意偏离 / 需对照官方核对的点（`_meta` 扩展键、参数违规用 422、游标格式、`updated_since` 边界等）与线上部署用户待办（建 D1、DNS、Cron、U5）见 `infra/cloudflare/registry/README.md`；真实 Cloudflare 运行时未验证（离线，未引入 wrangler）。

### 7.4 校验器 CLI

- [x] 新包 `packages/app-validator`（bin `kepcup-app`）：`kepcup-app validate <server.json | url>`——可达性、PRM / AS 发现、CIMD 或 DCR 可用、每个工具有 `title` 与风险注解、读写拆分启发式检查、名称 ≤64、`_meta["app.kepcup/connector"]` 合法、MCP Apps 的 CSP 声明、隐私政策链接；`--auth` 交互模式用 KepCup CIMD 身份走一次真实授权。复用 core 的 policy / catalog schema（抽到 shared 或独立包，避免依赖 Electron）。

**实施记录（2026-10-10，§7.4）**：新包 `packages/app-validator`（`@kepcup/app-validator`，bin `kepcup-app`，ESM，`tsc` → `dist`，根 vitest 项目 `app-validator`）。`kepcup-app validate <server.json 路径 | https URL> [--auth] [--json] [--timeout ms] [--no-browser]`；检查项分组（id 与说明见包 `README.md`，`readme-anchors.test` 保证 README 与实现一致）：`manifest.`*（schema、`_meta` 扩展、slug / icon / category / tier / auth / toolPolicy / skills / ui / whoami、远端、隐私政策）、`remote.*`（可达、TLS、401 挑战、PRM、AS 元数据、端点 https、PKCE、`iss`、CIMD / DCR、公共客户端、refresh、吊销）、`auth.*`（`--auth`：CIMD 文档、客户端身份、回调 `iss`、流程、令牌、refresh、吊销）、`tools.*` / `tool.*`（标题、描述、schema、名称 ≤ 64、风险注解、读写拆分、注入扫描）、`ui.*`（`_meta.ui` 与 CSP 条目）；退出码 0（无 error）/ 1（有 error）/ 2（用法错误或工具自身失败）；`--json` 为 `schemaVersion: 1`，URL 只保留 origin + path。`--auth` 用 KepCup 的 CIMD 身份经 pi-mcp 低层 OAuth 函数 + 自带回环回调服务（校验 `Host`、一次性）走一次真实授权；授权 / 令牌 / 注册端点必须 https（仅当 MCP server 本身是回环时允许回环 http）且先于打开浏览器校验；受保护 fetch 拒绝公网 → 回环 / 私网的重定向；描述注入扫描在 NFKC 规范化后的文本上做并列出隐藏字符。**复用方式**：core 的纯策略函数抽到 `packages/shared/src/policy/{sha256,risk,tool-policy,naming}.ts`（shared 会被打进渲染端，所以用纯 JS SHA-256），core `mcp/risk.ts` / `apps/policy.ts` / `apps/naming.ts` 只保留再导出，既有 import 与测试不变；校验器只依赖 shared 与 pi-mcp，不依赖 Electron / core。测试：12 文件 145 例，含 §7.8 验收 `acceptance-listed-app`（Linear 形态 `server.json` 夹具 + 假服务器通过 `validate --auth`）。

### 7.5 MCP Apps 渲染（先 spike）

- [x] Spike（2026-10-10，附录 B.7）：真实 Electron 44 里验证——特权方案 `kepcup-app`（standard + secure）+ 响应头 CSP、`sandbox="allow-scripts"` iframe 的 opaque origin、CSP 外的网络被拦且 `connect-src` 白名单生效、postMessage JSON-RPC 与 `event.source` 校验、权限 / 导航 / 弹窗被拒、`@modelcontextprotocol/ext-apps@1.7.5`（SDK 1.x 兼容；2.x 需 SDK 2.x）的 `AppBridge` 可用。**结论：可行；唯一偏差是 iframe 没有独立 partition**（协议处理器必须挂在宿主窗口的 session）。
- [x] 实现：core `apps/ui/{store,resource,service}.ts`（工具结果 / 定义带 `_meta.ui.resourceUri` → `mcp_app` 卡片消息；`apps.ui.open` 经 `resources/read` 取 HTML、校验 MIME / ≤ 2 MB、清洗 CSP、登记内存资源；平台方法 `apps.ui.resource` 供主进程协议处理器取页面；`apps.ui.callTool` 走网关同一审批路径、`loopType:'host'`、`visibility` 默认拒绝、限流每秒 5 次 / 在途 3 个；`apps.ui.openLink` 仅 https）；`McpService.readResource` 与 `io.modelcontextprotocol/ui` 客户端能力；主进程 `main/apps-ui.ts`（方案注册、处理器、子框架导航拦截）；渲染端 `features/apps-ui/{McpAppCard.svelte,app-bridge-host.ts,bridge-guard.ts}`（消息流卡片、官方 `AppBridge` + 方法白名单 / 体积上限、高度 100–800、外链确认条）。`ui/message`、`ui/update-model-context` 本期不支持（`-32601`）。
- [x] 安全测试：e2e `apps/desktop/test/e2e/mcp-apps.spec.ts`（真实 Electron：iframe 读不到 `window.kepcup` / 父页面 / cookie / 存储，CSP 外请求与回环请求被拦且服务端命中 0，白名单内可达，弹窗 / 导航被拦，写工具出审批卡、未声明 / 仅模型可见的工具被拒，外链确认后才 `openExternal`）；core `integration/mcp-apps-ui`、`security/mcp-apps-ui-tokens`（OAuth 连接：卡片 / open / 页面 / 调用结果 / 事件无令牌）、`unit/app-ui-service`；shared `apps-ui`；主进程 `apps-ui-policy.test`；渲染端 `bridge-guard.test`。

- 安全评审修复（2026-10-10）：**严重**——渲染端 `core-port` 窗口消息无来源校验，沙箱 iframe 可劫持 core RPC 端口（已修：preload 带每次加载的秘密 nonce + `event.source === window`）；界面发起的写入不再被无人值守 / auto 策略 / 持续授权绕过（`origin:'app_ui'`、仅一次、必须人点）；拒绝后 30 秒静默、每对话 3 个待处理上限；关闭 / 过期 / 断开取消待处理审批且之后不执行；CSP 拒绝一切通配、回环只认所属 server 的精确 host:port，响应头加 `sandbox allow-scripts` 与 `frame-ancestors`（e2e 验证 iframe 照常工作）；`__kepcupRpc` 入产物剔除清单；子框架导航判定失败即关闭；外链取消冷却 5 秒、确认条突出主机名；`tools/call` 入参按 inputSchema 校验；`size-changed` 节流 100 ms。`resources/read` 的 2 MB 上限只能在 pi-mcp 返回完整响应之后检查（客户端库先缓冲整个响应，无法更早截断）。
- 未做 / 后续：外部智能体（ACP 桥）调用应用工具时不出卡；`ui/message` / `ui/update-model-context` / `ui/download-file` / `request-display-mode`；`permissions`（camera 等）一律不授予；主题切换不推给已打开的界面；ext-apps 2.x 待 SDK 2.x（只换 `app-bridge-host.ts` 的 import）；卡片重新挂载（虚拟列表滚出再滚入）会重新 `resources/read`。



### 7.6 随附 Skills

- [x] 目录条目 `_meta.skills` → 连接成功后提示安装（走既有 `skill_import` 审批，D63），安装到被授权的 Bot。

**实施记录（2026-10-10，§7.6）**：`_meta.skills` 条目为 `{name, source〔https git URL〕, description?, ref?, subdirectory?}`（旧的纯字符串形态能解析但永远不会被提示）；`isSafeSkillSourceUrl`（https、无用户信息 / 端口 / 查询、带点域名、非 IP / localhost / `.local`、≤ 500 字符）在目录 schema 与安装时各校验一次；core `apps/skills-offer.ts`：连接完成后条目声明了技能 + 有 Bot 持有该连接 + 该 Bot 未装同名技能 → 发 `apps.skills_offer`；RPC `apps.skills.offers` / `apps.skills.install`（`rpc/apps-skills-bindings.ts`）→ 既有 `SkillImporter.import` → 常规 `skill_import` 审批（从不自动安装，无人值守沿用该审批既有规则）；声明名必须等于 SKILL.md 名（`expectedName`，不符 → `status: 'mismatch'`，不提交审批，本进程内不再提示 / 克隆）；**git 克隆发生在审批之前，libgit2 无体积 / 时间上限**（D63 既有行为，列为后续，DEV-022 第 4 项）；渲染端 `ConnectedSkillsPrompt.svelte`（稍后 / 失败项 / 已提交状态）；测试钩子 `CoreServicesOptions.appSkillSourceOverride`（仅测试钩子构建）。测试：shared `connector-skill-source`（30）；core `apps-skills-offer`（26）、集成 `connected-apps-skills-offer`（7）；渲染端 `connected-skills.test`（3）。

### 7.7 开发者门户与审核流水线

- [x] 本阶段只出任务书 `todo/developer-portal.md`（Cloudflare：GitHub OAuth + DoH TXT 命名空间验证 + Turnstile + D1/R2 + Workflows + Sandbox SDK 扫描，设计 29 §11.5、§15），不实现。

**实施记录（2026-10-10，§7.7）**：任务书 `todo/developer-portal.md` 已写（未实现）：目标 / 硬约束、Cloudflare 架构（Worker + D1 + R2 + Workflows + Containers / Browser Run）、数据模型、审核状态机（`community` 自动 → `verified` 人工）、GitHub / DoH 命名空间证明、提交流水线（`kepcup-app validate --json` → 远程探测 → MCP Apps 渲染检查）、`tool_contract_hash` 复审触发、SSRF 与滥用防护、与 registry `reviews` 的写入方案、API 清单、匿名遥测（Analytics Engine）、分阶段任务（D0–D6，含验收）与用户待办（Workers Paid、Turnstile、GitHub OAuth 应用、子域等）。

### 7.8 P3 验收

- 签名索引端到端（篡改 / 回滚被拒、离线回落）；子注册表通过 OpenAPI 契约测试；`kepcup-app validate` 对一个已上架 Claude / ChatGPT 目录的第三方应用的 `server.json`（补 `_meta` 后）通过；MCP Apps 示例渲染并通过安全测试。

**门禁结果（2026-10-10）**：自动化部分全绿——签名索引端到端由 core `directory-sync`（篡改字节 / 签名、他钥、未知 / 吊销 / 窗口外钥、防回滚、离线回落并保留最后验签缓存、空密钥与设置开关停用）+ 集成 `connected-apps-p3-tier-directory`（真实 core + 假 `dl.kepcup.com`）覆盖；子注册表 OpenAPI 契约由 `infra/cloudflare/registry/test/contract.test.ts`（官方 `openapi.json` 手工子集）+ worker / sync / reviews 共 144 例覆盖；`kepcup-app validate` 的验收由 `packages/app-validator/test/acceptance-listed-app.test.ts` 覆盖（Linear 形态 `server.json` 夹具补 `_meta` 后，对替身远端 `validate --auth` 端到端通过——**夹具是自写的，不是对线上真实 Linear 的实测**）；MCP Apps 示例渲染与安全测试由 e2e `mcp-apps.spec.ts`（3 例，真实 Electron）+ core `mcp-apps-ui`* / 安全测试覆盖（§7.5 记录）。定向测试例数与分布见 `docs/dev/05-testing.md`「用例分布（D73 P3）」。全量回归：3375 通过 / 26 失败（均为环境基线文件，无新增失败）；pnpm typecheck、pnpm lint 通过。**待用户的部分**：对真实已上架应用（如 Linear 官方 MCP）的 `server.json` 跑 `kepcup-app validate --auth`（要真实账号登录）；U5（目录签名密钥、`dl.` / `registry.` 子域、D1、Workers Paid）及各目录的线上 `verify.mjs` / `curl` 冒烟；子注册表在真实 Cloudflare 运行时与官方实现上的核对（见 `infra/cloudflare/registry/README.md`）。偏差汇总见 `docs/dev/DEVIATIONS.md` DEV-022（待决定）；进度见 `docs/dev/PROGRESS.md`「连接应用 P3」。

---



## 8. P4 — 企业与托管网关（只出任务书）

- [x] `todo/hosted-auth-gateway.md`：Cloudflare `workers-oauth-provider`（CIMD + `global_fetch_strictly_public`）+ Agents SDK `createMcpHandler` + D1 / Durable Objects 令牌库（应用层加密、`eu` 管辖区）+ URL 模式 elicitation 账号关联页（`__Host-` Cookie、一次性 state、同一用户校验）；只在某平台无法本地直连时启动（设计 29 §11.7、§15.3）。
  - 任务书已写（2026-10-10，未实现，默认不建）：[hosted-auth-gateway.md](hosted-auth-gateway.md)，阶段 G0–G6。
- [x] `todo/enterprise-ema.md`：MCP Enterprise-Managed Authorization（ID-JAG / Okta XAA）客户端支持。
  - 任务书已写（2026-10-10，未实现）：[enterprise-ema.md](enterprise-ema.md)，阶段 E0–E6。

---



## 附录 B — 首批应用实测结论（P1 §5.1，2026-10-09）

> **范围声明（用户决定）**：真实账号相关步骤（U1 / U2 / U3）由用户自行完成，本附录**只含无登录探测**——`packages/core/scripts/connector-spike/probe.mjs` 只发 `POST initialize`（无凭据）与若干 `GET` 发现请求，**未登录、未注册、未发 DCR POST**。「带登录模式」（用 P0 引擎完整连接、导出工具清单与注解覆盖率、账号识别可行性）**整体跳过，等 U2**。
>
> **发行门禁：目录中全部条目的** `releaseGate` **在** `apps/desktop/connector-release-gates.json`**（**`approved: []`**）里保持关闭**，直到用户完成带登录实测后再逐家放行；开发构建 / 测试不注入门禁常量，条目全部可见，发行构建（`pnpm dist`）一条都不收录。



### B.1 探测方法与复现

```
node packages/core/scripts/connector-spike/probe.mjs [--only notion,linear] [--out report.json] [--timeout 10000]
```

- 每家：`POST <url>`（`initialize`，无 `Authorization`）→ 记录 401 与 `WWW-Authenticate`；按 `resource_metadata`（缺省走 RFC 9728 well-known 路径插入式 URL）取 PRM；对 `authorization_servers[0]` 依次试 RFC 8414 与 OIDC 发现 URL，取 AS 元数据。
- 判定：`client_id_metadata_document_supported === true` → CIMD；否则有 `registration_endpoint` → DCR；否则 → 无自动注册。**DCR 只凭** `registration_endpoint` **判断，不实际注册**。
- 超时 10 s、仅 https（重定向逐跳校验）、失败只记录不重试。主机上 Node 默认的 250 ms 逐地址连接超时过紧（本机无 IPv6、RTT 高会整批 ETIMEDOUT），脚本里已调到 3 s。
- 原始报告：`packages/core/scripts/connector-spike/reports/2026-10-09.json`（探测时间 2026-10-09，本机出站网络可用）。契约 / 解析逻辑有单测 `packages/core/test/unit/connector-spike-probe.test.ts`（假 fetch，不联网）。



### B.2 候选 URL 核对（均对照厂商当前文档）


| 应用        | URL                                       | 文档依据 / 备注                                                                                                                                              |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Notion    | `https://mcp.notion.com/mcp`              | developers.notion.com/docs/mcp；Registry `com.notion/mcp`（另有 `/sse`，不用）                                                                                 |
| Linear    | `https://mcp.linear.app/mcp`              | linear.app/docs/mcp；Registry `app.linear/linear`（`/sse` 已弃用）                                                                                           |
| Atlassian | `https://mcp.atlassian.com/v1/mcp/authv2` | Atlassian 支持文档（自定义客户端）；开发者文档写 `/v1/mcp`，Registry 2.0.0 另列 `/v2/mcp`（探测同样 401 + 同一 AS）。**目录先用** `authv2`**，带登录实测时一并确认** `/v2/mcp`；SSE 端点 2026-06-30 起停用 |
| Sentry    | `https://mcp.sentry.dev/mcp`              | docs.sentry.io/ai/mcp；Registry `io.github.getsentry/sentry-mcp`                                                                                        |
| Asana     | `https://mcp.asana.com/v2/mcp`            | developers.asana.com「Integrating with Asana's MCP Server」；旧 `/sse` 已于 2026-08 前后下线，`/v2/mcp` 才是现行；文档明确写「V2 不支持动态客户端注册」，须在 Asana 开发者控制台建「MCP app」预注册    |
| HubSpot   | `https://mcp.hubspot.com`                 | developers.hubspot.com「Integrate with the remote HubSpot MCP server」（2026-04 GA）；须在「Development > MCP Connectors」建连接器取 client id/secret，PKCE S256 必需   |
| Canva     | `https://mcp.canva.com/mcp`               | canva.dev/docs/mcp；Registry `com.canva.mcp/mcp`（Canva 称部分接入有等候名单，见 B.4）                                                                                |
| Stripe    | `https://mcp.stripe.com`                  | docs.stripe.com/mcp；Registry `com.stripe/mcp`                                                                                                          |
| GitHub    | `https://api.githubcopilot.com/mcp/`      | github/github-mcp-server `docs/host-integration.md`                                                                                                    |




### B.3 探测结果


| 应用        | 无凭据 initialize           | PRM                       | AS（issuer）                          | 自动注册                                           | `code_challenge_methods` | `iss` 参数 (RFC 9207) | `revocation_endpoint` | `scopes_supported`                                                      | 令牌端点认证                                              |
| --------- | ------------------------ | ------------------------- | ----------------------------------- | ---------------------------------------------- | ------------------------ | ------------------- | --------------------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| Notion    | 401，`scope="default"`    | 有                         | `https://mcp.notion.com`            | **CIMD + DCR**                                 | S256                     | 是                   | 有（与 token 同 URL）      | `default`                                                               | none / secret_basic / secret_post                   |
| Linear    | 401，`scope="read write"` | 有                         | `https://mcp.linear.app`            | **CIMD + DCR**                                 | S256                     | 是                   | 有（与 token 同 URL）      | `read write openid email`                                               | none / secret_basic / secret_post                   |
| Atlassian | 401，`invalid_token`      | 有                         | `https://auth.atlassian.com/<租户前缀>` | **CIMD + DCR**                                 | S256                     | 未声明                 | 有（`/oauth/revoke`）    | AS 未列；PRM 列 22 项（`read:jira-work`、`write:jira-work`、`offline_access` 等） | none / secret_post / secret_basic / private_key_jwt |
| Sentry    | 401                      | 有                         | `https://mcp.sentry.dev`            | **CIMD + DCR**                                 | S256                     | 是                   | 有（与 token 同 URL）      | `org:read project:write team:write event:write alerts:write`            | none / secret_basic / secret_post                   |
| Asana     | 401，`invalid_request`    | 有                         | `https://app.asana.com`             | **无**（无 `registration_endpoint`、无 CIMD）        | S256                     | 未声明                 | 有（`/-/oauth_revoke`）  | PRM 仅 `default`                                                         | secret_post / secret_basic（**必须带 secret**）          |
| HubSpot   | 401                      | 有（`scopes_supported: []`） | `https://mcp.hubspot.com`           | **无**                                          | S256                     | 未声明                 | **无**                 | 空                                                                       | secret_post（**必须带 secret**）                         |
| Canva     | 401，`invalid_token`      | 有                         | `https://mcp.canva.com`             | **CIMD + DCR**                                 | `plain`、S256             | 未声明                 | 有（与 token 同 URL）      | PRM 列 16 项（`design:content:write` 等）                                    | none / secret_basic / secret_post                   |
| Stripe    | 401                      | 有                         | `https://access.stripe.com/mcp`     | **DCR**（无 CIMD 声明）                             | S256                     | 未声明                 | 有（`/oauth2/revoke`）   | `mcp`                                                                   | none                                                |
| GitHub    | 401，`invalid_request`    | 有                         | `https://github.com/login/oauth`    | **无**（据报 2026-07 支持 CIMD——**AS 元数据里没有声明，未证实**） | S256                     | 是                   | **无**                 | AS 仅 `offline_access`；PRM 列 10 项（`repo`、`read:org` 等）                   | 未声明                                                 |


> 「revocation 与 token 同 URL」是厂商把 RFC 7009 吊销合并到令牌端点的写法，能否真正吊销要带登录实测（P0 的断开流程按「尽力吊销、失败不阻塞」，不受影响）。



### B.4 每家结论

图例：**可上目录** = 无登录探测满足「CIMD 或 DCR + PKCE S256」，P1 目录收录；但**一律仍待登录实测**（extension-center.md §4）后才放行。**需预注册** = 无自动注册，按计划走 P2 预注册客户端（§6.4），**不进 P1 目录**、不做半套。**暂不支持** = 当前无可行路径。


| 应用        | 结论              | 进 P1 目录        | 依据与待办                                                                                                                                                             |
| --------- | --------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notion    | **可上目录**（待登录实测） | 是（`notion`）    | CIMD + DCR，`iss` 与 S256 齐全。登录实测要看：工具注解覆盖率、`notion-update-page` 等写工具的风险、账号识别（`whoami`）                                                                             |
| Linear    | **可上目录**（待登录实测） | 是（`linear`）    | CIMD + DCR，`iss` 齐全；文档另提到 API key 方式，目录只用 OAuth                                                                                                                   |
| Atlassian | **可上目录**（待登录实测） | 是（`atlassian`） | CIMD + DCR。PRM 的 scope 很多且分读写，适合 step-up（P2）；**风险**：Atlassian 有管理员「已批准客户端 / 域名」限制，无登录探测看不出，须用真实站点验证 CIMD 客户端是否被允许；`authv2` 与 `/v2/mcp` 择一                         |
| Sentry    | **可上目录**（待登录实测） | 是（`sentry`）    | CIMD + DCR，`iss` 齐全；授权时需选组织                                                                                                                                       |
| Canva     | **可上目录**（待登录实测） | 是（`canva`）     | CIMD + DCR；AS 同时接受 `plain` PKCE（我们恒用 S256）。**风险**：Canva 称私有访问有等候名单，需确认 KepCup 不在受限客户端之外                                                                           |
| Stripe    | **可上目录**（待登录实测） | 是（`stripe`）    | 仅 DCR（无 CIMD 声明）；令牌端点认证 `none`（公共客户端）。涉及资金，**风险分级务必取严**：登录实测后逐工具补 `toolPolicy`，并确认测试模式 / 受限权限                                                                     |
| Asana     | **需预注册**        | 否              | 文档明确 V2 不支持 DCR；元数据无 `registration_endpoint`。且令牌端点**只支持带 secret 的认证**（`client_secret_post/basic`）——桌面应用无法安全持有 secret，预注册能否以公共客户端 + PKCE 使用须先问 Asana。入 P2 §6.4 评估  |
| HubSpot   | **需预注册**        | 否              | 无 DCR / CIMD；须在 HubSpot 账号内建「MCP Connector」（client id + secret）；令牌端点仅 `client_secret_post`；**无吊销端点**。与 Asana 同样有 secret 难题，且需 HubSpot 侧批准分发——P2 评估，无进展前视为**暂不支持** |
| GitHub    | **需预注册**（U3）    | 否              | AS 元数据未声明 CIMD / DCR，且无吊销端点；`iss` 与 S256 具备。需用户注册 KepCup 的 GitHub App（U3）+ P2 预注册客户端机制。若 GitHub 后续在元数据里声明 `client_id_metadata_document_supported`，重跑探测即可改判        |


**P1 目录（6 家）**：`notion`、`linear`、`atlassian`、`sentry`、`canva`、`stripe`——对应 `apps/desktop/resources/connectors/catalog.json`；图标为中性占位（圆角方块 + 首字母），不含厂商商标图形。`toolPolicy` 与 `whoami` 暂空，待登录实测后补；`auth.scopes` 暂空（按服务端 `WWW-Authenticate` / PRM 取）。**当前没有「暂不支持」的厂商**（HubSpot 视 P2 进展）。

### B.5 门禁与后续

- 放行流程：U1（CIMD 文档部署）已完成；各家按 [extension-center.md](extension-center.md) §4 逐家适配（账号持有人在浏览器登录一次）后，对每家用 P0 引擎连接并导出工具清单 → 补 `toolPolicy` / `whoami` / 修正 URL → 在 `connector-release-gates.json` 的 `approved` 里加入该条目的 `releaseGate` 值（= slug）。**在此之前不要放行任何一家。**
- 探测的局限：无登录探测不能证明 (a) KepCup 的 CIMD URL 会被各家接受（vendors 可有客户端白名单 / 域名限制，且 U1 尚未部署）、(b) 工具注解质量、(c) 账号识别可行性——这些都是「待登录实测」的内容。
- 工具与脚本：`scripts/import-mcp-registry.mjs <registry-name>` 可导出新应用的 `server.json` 骨架（`privacyPolicy: "TODO"` 故意让契约测试失败，须人工补全）；契约测试 `packages/core/test/contract/connector-catalog.contract.ts`（入口 `test/unit/connector-catalog.test.ts`）覆盖目录所有条目。
- 打包：`apps/desktop/electron-builder.yml` 三平台 `extraResources` 增加 `resources/connectors → connectors`，`core-host.ts` 注入 `KEPCUP_CONNECTORS`；`dist.mjs` 注入 `__KEPCUP_CONNECTOR_RELEASE_GATES__`（与 D72 同款，`testkit` 门禁禁止放行）。



### B.6 协议版本（P2，2026-10-10）

> §6.7 spike。**只读源码与锁文件，未联网**；2026-07-28 版规范的细节（无状态、MRTR、`server/discover`）取自本方案 §6.7 的描述，未对照规范原文核对。


|                                                                                                                 | 支持的协议版本                                                                                                                                   | 2026-07-28 特性                                                                                                                                                                                                       | 依据                                                                             |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@earendil-works/pi-mcp@1.0.2`（KepCup 的全部 MCP 连接：stdio / Streamable HTTP / OAuth 低层函数）                          | `2025-11-25`（最新）、`2025-06-18`、`2025-03-26`、`2024-11-05`                                                                                   | **无**：握手固定为 `initialize` → `notifications/initialized`（`client.js:125-148`）；服务端回的版本不在列表内即抛 `MCP server selected unsupported protocol version`；无 `server/discover`、无 MRTR、无无状态模式（`dist` 内 `discover` 仅出现在 OAuth 发现里） | `dist/protocol/types.js`、`dist/client.js`、`dist/transports/streamable-http.js` |
| `@modelcontextprotocol/sdk@1.32.1`（core 仅 `agent/external/mcp-bridge.ts` 的**服务端**用它；testkit 假服务器用它；**不**用于出站连接） | `2025-11-25`（最新）、`2025-06-18`、`2025-03-26`、`2024-11-05`、`2024-10-07`                                                                      | **无**：客户端同样走 `initialize`；有实验性 `tasks/`*；服务端 `StreamableHTTPServerTransport` 可 `sessionIdGenerator: undefined` 做「无会话」（2025 规范内的无状态用法，不等于 2026-07-28 的无状态协议）                                                         | `dist/esm/types.js`、`client/streamableHttp.js`                                 |
| 更新的版本                                                                                                           | 仓库锁文件只有 `pi-mcp@1.0.2`；pnpm 本地存储只见 `pi-mcp@1.0.2` 与 sdk `1.29.0 / 1.32.1`；`pi-mcp` CHANGELOG 最新条目即 1.0.2（2026-10-04）。离线无法得知 npm 上是否已有更新版本 | —                                                                                                                                                                                                                   | `pnpm-lock.yaml`、`~/.local/share/pnpm/store/v11/index.db`                      |


**KepCup 现在要不要动：不要。**

- 兼容性靠协商：2026-07-28 的服务端在过渡期应仍接受 `initialize` 并回 `2025-11-25`（规范的版本协商惯例；B.3 的无登录探测只证明各家端点要求授权，**没有**验证版本协商，真实协商结果待 U2 带登录实测时顺带记录 `initialize` 返回的 `protocolVersion`）；本期目录的 6 家 + GitHub / Asana 都是 2025 线实现。pi-mcp 只有在服务端**只**说 2026-07-28、拒绝 `initialize` 时才连不上——那种服务端出现之前没有可验证的失败样本，现在写适配只能凭猜。
- 无状态服务端对现有客户端本来就可用：pi-mcp 在服务端不给 `Mcp-Session-Id` 时照常工作，`GET` 流 405 时跳过（`streamable-http.js:399`）。**代价**是没有服务端推送：`notifications/tools/list_changed` 收不到，工具变化只能靠 `MCP_TOOL_LIST_CACHE_MS`（5 分钟）过期或手动刷新——§6.6 的「手动刷新工具」（`mcp.refreshTools`）正好覆盖；工具锁定在每次重新列出时登记，不依赖推送。
- 影响面：KepCup 对 MCP 协议的依赖集中在 `McpService`（`listTools` / `callTool` / `onNotification`）与 `apps/auth/*`（OAuth 低层函数，与传输版本无关），换传输层不碰授权引擎。

**建议路径**

1. **保持 pi-mcp**，每次升级 pi 时（`pi-ai` / `pi-coding-agent` / `pi-mcp` 同版本发布）看 pi-mcp CHANGELOG 是否出现 `server/discover` / 无状态 / MRTR；有则只升级，接口不变。
2. 触发条件（任一）才启动「HTTP 传输换官方 SDK」：(a) 目录里有厂商**只**支持 2026-07-28（探测脚本 `connector-spike/probe.mjs` 可加一次 `server/discover` 探测；连接失败文案里已会带出 `unsupported protocol version`）；(b) 官方 SDK 发布 2026-07-28 版客户端而 pi-mcp 数周内无跟进。届时的做法：`McpService` 的 HTTP 连接抽成窄接口（`connect` / `listTools` / `callTool` / `onNotification` / `close`，现有 `McpClient` 即其形状），为 Streamable HTTP 增加官方 SDK 适配实现，OAuth 仍用 `apps/auth` 的 `AuthProvider`（SDK 的 `authProvider` 接口需薄适配），stdio 与 SSE 继续用 pi-mcp；先用假服务器无状态模式跑通再切流量。当前锁定的 1.32.1 是 v1 线，升级需评估对宿主 MCP 桥（`mcp-bridge.ts` 服务端）和 testkit 假服务器的影响。
3. **假服务器需要的改动**（不在本期实现）：`startFakeOAuthMcpServer` 增 `statelessMode`——每个 POST 用独立的 `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`、不下发 `Mcp-Session-Id`、`GET` 回 405（因此 `setTools` 等不再能推 `list_changed`，测试改用手动刷新）；2026-07-28 本身另需：`server/discover`（不经 `initialize` 返回能力 / 版本）、每个请求自带协议版本头、MRTR（工具调用中途要求补充输入时返回「需要输入」结果而不是服务端发起的 elicitation 请求）。后三项等 SDK 或 pi-mcp 有对应客户端实现后再做，否则无法被任何客户端驱动。
4. 风险登记：MRTR 若成为主流，当前 pi-mcp 的 `elicitation` 能力（`capabilities.elicitation`）不会被触发，工具调用会在需要用户输入处失败而不是挂起——目前 KepCup 不声明 `elicitation` 能力，所以服务端本就不应发起；无需处理。



### B.7 MCP Apps 渲染 spike（P3，2026-10-10）

> §7.5 spike。在 `kepcup-test:trixie-xvfb` 容器内用**真实 Electron 44.4.5**（xvfb，`--no-sandbox` 同 Playwright）跑一次性探针：主窗口带 preload（`window.kepcup = { secret }`）、`file://` 宿主页（CSP 与真实渲染端同款，另加 `frame-src kepcup-app:`）、特权方案 `kepcup-app`（`standard` + `secure`，`supportFetchAPI:false`、`corsEnabled:false`）经 `protocol.handle` 服务一份 `text/html` + 响应头 CSP 的页面；iframe `sandbox="allow-scripts" allow="" referrerpolicy="no-referrer"`；iframe 内用**真实的** `@modelcontextprotocol/ext-apps` `App`，宿主用**真实的** `AppBridge` + `PostMessageTransport`（esbuild 打包）。两个 127.0.0.1 HTTP 服务端（一个在 CSP 白名单、一个不在）统计命中数。探针不入库（一次性）；结论如下，实现与安全测试见 `apps/desktop/test/e2e/mcp-apps.spec.ts`。

**结论：可行，但有一处与设计 29 §11.6 的措辞不同——iframe 没有「独立 partition」。**


| 问                                    | 结论  | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) 特权方案 + 响应头 CSP                   | 可行  | iframe 加载 `kepcup-app://conn1/res`，响应头 `content-security-policy: default-src 'none'; script-src 'unsafe-inline'; … connect-src http://127.0.0.1:<白名单端口>; frame-src 'none'; base-uri 'none'; form-action 'none'` 生效（违规以 `securitypolicyviolation` 事件上报）。`protocol.handle` **必须注册在宿主窗口所在的 session（默认 session）上**：只在 `session.fromPartition('kepcup-apps-ui')` 上注册时，宿主窗口里的 iframe 不走它（`handled=[]`，iframe 静默停在 about:blank，无 `did-fail-load`）。iframe 是页面的子框架，网络栈跟随**宿主 webContents 的 session**，`<iframe>` 没有 per-frame partition。要真独立 partition 只有 `<webview partition>`（需开 `webviewTag`，放大主窗口攻击面且 Electron 不推荐）或覆盖在窗口上的 `WebContentsView`（无法嵌入可滚动消息流）——**都不采用**。替代：不依赖 partition 的隔离见下（opaque origin + 逐应用 CSP + 导航拦截），iframe 因 opaque origin 本就没有 cookie / localStorage / IndexedDB 可共享。                                                                                                                                        |
| (b) 独立 origin / 无法碰宿主                | 可行  | `window.origin === "null"`（`location.origin` 是 `kepcup-app://conn1`，仅用于 CSP `'self'`）；`typeof window.kepcup === "undefined"`（宿主里是 `HOST-SECRET-TOKEN`）；`typeof window.require / process` 为 `undefined`；`parent.document`、`parent.kepcup`、`top.location.href`（读写）均抛 `SecurityError`；`document.cookie`、`localStorage` 抛 `SecurityError`（"The document is sandboxed"）；`indexedDB.open` 被拒；`window.open(...)` 返回 `null`。iframe 与宿主在**不同渲染进程**（`frame.processId` 5 对 4，OOPIF）。preload 只进主框架，不进子框架。                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| (c) CSP 外的网络请求被拦；`connect-src` 白名单生效 | 可行  | `fetch("https://example.com/")`、`fetch("http://127.0.0.1:<非白名单>")`、`fetch("kepcup-app://conn2/res")`（别的应用）、`fetch("file:///etc/hostname")`、`new Image().src`、`new WebSocket("ws://127.0.0.1:…")`、`navigator.sendBeacon(...)`、`<form action=…>.submit()` 全部被 CSP 拦下（`securitypolicyviolation`：`connect-src` / `img-src`），**非白名单服务端命中数 0**；`connect-src http://127.0.0.1:<白名单>` 的 `fetch` 返回 200（服务端命中 1，需服务端自带 CORS，请求来源是 `null`）。`script-src` 之外的 `eval` 也被拦（zod / SDK 的 `new Function` 探测，库会回退）。                                                                                                                                                                                                                                                                                                                                                                                                                              |
| (d) postMessage JSON-RPC             | 可行  | 真实 `App.connect()` ↔ 宿主 `AppBridge.connect(new PostMessageTransport(win, win))`：`ui/initialize` 往返（宿主能力与 `hostContext` 到达应用）、`ui/notifications/initialized`、`tool-input` / `tool-result` 通知、`tools/call`（`App.callServerTool`）→ 宿主 `oncalltool`、`ui/open-link` → 宿主 `onopenlink`、`ui/notifications/size-changed`（宿主收到 `{width,height}`，autoResize 随 body 高度变化 81 → 351）。`ui/message`、`ui/update-model-context` 在宿主未设处理器时返回 `-32601 Method not found`（正是 P3 要的「不支持」）。**来源校验**：`PostMessageTransport` 只接受 `event.source === eventSource` 的消息；同窗口里另一个 `kepcup-app://conn1/rogue` 兄弟 iframe 发来的 `tools/call` / `ui/initialize` 不触发宿主 `oncalltool`（宿主自己的监听器把它们记为 foreign-message，`origin` 均为 `"null"`——不能靠 origin 区分，只能靠 `event.source`）。                                                                                                                                                                                           |
| (e) 权限 / 导航 / 弹窗                     | 可行  | iframe 的 `allow=""`（Permissions-Policy）使 camera / microphone / geolocation 等在到达 `setPermissionRequestHandler` 之前就被拒（`geolocation` 回调 `code 1`；权限日志里只有 `notifications` 请求与 `background-sync` 检查，均被处理器拒绝）。`will-frame-navigate` 在子框架导航到**另一个** `kepcup-app://` **应用**时触发（`e.frame.url` 已是 `kepcup-app://…`），`preventDefault()` 后别的应用的 HTML **没有**被服务（`handled` 里只有自己）；导航到 `https://example.com/` 先被宿主页 CSP `frame-src kepcup-app:` 拦（`did-fail-load -30 ERR_BLOCKED_BY_CSP`，先于 `will-frame-navigate`，框架落在错误页——卡片自己坏掉，不影响宿主）。`window.open` 被 `sandbox`（无 `allow-popups`）直接返回 `null`；`top.location=…` 无 `allow-top-navigation` 抛 `SecurityError`。因此渲染端 `index.html` 的 CSP 必须加 `frame-src kepcup-app:`（二道防线），主进程对子框架导航加 `will-frame-navigate` 拦截。                                                                                                                                                                                   |
| (f) `@modelcontextprotocol/ext-apps` | 可用  | npm `2.0.3`（最新）的 peer 是 `@modelcontextprotocol/{client,core}@^2`（仓库是 SDK 1.x，**不兼容**）；`1.7.5` 的 peer 是 `@modelcontextprotocol/sdk@^1.29`、`zod@^3.25 || ^4`（仓库锁 sdk 1.32.1 / zod 4.6.5，**兼容**）→ 采用 **1.7.5**。`AppBridge` 可 `new AppBridge(null, hostInfo, capabilities, { hostContext })`（无需 MCP `Client`），用 `oncalltool` / `onopenlink` / `onmessage` / `onupdatemodelcontext` / `onsizechange` / `oninitialized` 挂宿主处理；`sendToolInput` / `sendToolResult` / `setHostContext` / `teardownResource`；`PostMessageTransport(eventTarget, eventSource)`；`getToolUiResourceUri(tool)`（同时识别 `_meta.ui.resourceUri` 与旧的 `_meta["ui/resourceUri"]`）、`buildAllowAttribute(permissions)`、`RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"`。esbuild 压缩后宿主侧约 520 KB（含 zod 4 与 SDK 协议层），渲染端按需 `import()`。`csp` / `permissions` 在 `resources/read` **内容项的** `_meta.ui` 上，不在工具上；工具 `_meta.ui.visibility` 默认 `["model","app"]`（KepCup 更严，见下）。 |


**偏差与决定**

1. **没有独立 partition**（见 (a)）：靠 opaque origin（无 cookie / 存储）+ 逐应用响应头 CSP + `frame-src kepcup-app:` + `will-frame-navigate` 拦截 + 默认 session 的权限处理器（含 `kepcup-app:` 一律拒绝）+ 子框架无 preload。设计 29 §11.6 的「独立 partition」措辞随实现改为「独立 origin 的特权方案 + opaque origin」。
2. `visibility` **默认拒绝**：规范默认 `["model","app"]`，KepCup 要求工具**显式**含 `"app"` 才允许界面调用（比规范严；审批与风险策略照常）。
3. **HTML 通道**：HTML 由 core 经 `resources/read` 取得并存在内存里；主进程协议处理器通过平台 RPC 向 core 取（只服务渲染端经主进程 IPC 登记过的 `(connectionId, resourceId)`，核对发送方 webContents）；HTML 与令牌都不进模型上下文。
4. `ext-apps` **2.x 待 SDK 2.x**：升级条件见 B.6 的 SDK 路径；到时只换 `AppBridgeHost` 的 import。

