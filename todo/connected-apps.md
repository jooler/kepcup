# 连接应用（Connected Apps）与开放平台基座 — 执行方案（D73 / D74）

> 状态：**未开始**（2026-10-07 设计完成，设计见 `docs/design/29-connected-apps.md`）。分 P0→P4 五个阶段，每阶段有**门禁**（不通过不进入下一阶段）。本文是给编码 Agent 的**自包含交接**：不依赖本 chat 历史即可开工。
>
> **硬约束**：
>
> - 只改本地工作树；**不要** `git commit` / `push` / 开 PR（除非用户另行明确要求）。
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

6. `pi-mcp/oauth` **API**（`node_modules/.pnpm/@earendil-works+pi-mcp@1.0.2/.../dist/oauth/*.d.ts`，**先读源码再用**）：

- 发现：`discoverOAuthServerInfo`、`discoverProtectedResourceMetadata`、`discoverAuthorizationServerMetadata`、`parseWwwAuthenticate`、`selectResource`、`resourceUrlFromServerUrl`（均接受可注入的 `fetch: McpFetch`——用它接 SSRF 防护）
- 流程：`startAuthorization`、`registerClient`、`exchangeAuthorizationCode`、`refreshAuthorization`、`stepUpScope(granted, challenged)`、`authorizeMcp`、`adaptOAuthProvider`
- 提供者：`McpOAuthProvider` / `OAuthClientProvider` / `McpOAuthStateStore`——**本方案不使用**（见下方已知坑与 §4.6）；交互流程只用上面的低层函数，运行时用自建 `AuthProvider`
- 传输：`StreamableHttpTransportOptions.authProvider`（`dist/transports/streamable-http.d.ts:33`）；`AuthProvider { token(); onUnauthorized?(ctx: UnauthorizedContext) }`（`dist/auth-provider.d.ts`）
- **已知坑**（审查确认，务必遵守设计 §5.6）：`adaptOAuthProvider` 的 `onUnauthorized` 在刷新失败 / `insufficient_scope` 时会调 `authorizeMcp` → `onRedirect`，即运行中自行发起交互授权——**运行时不得使用它**；`McpOAuthProvider` 无主动刷新、客户端信息按 server URL 存，且其 CIMD 钩子（`flow.js:178`）拒绝非 https 的 CIMD URL（测试用 http 文件服务会失败）；`OAuthCallbackServer` 不校验 `Host`；`OAuthClientMetadata` 类型无 `application_type`。

7. 代码锚点（行号为 2026-10-07 工作树，含 D72 未提交改动；实现时以实况为准）：

- **MCP**：`packages/core/src/mcp/service.ts`（`serversForBot` :82、`mcpToolName` :92、`testServer` :122、`#endpointHint` :151、`missingSecrets` :167、`listTools` :194、`callTool` :212、`#ensureConnected` :253（catch :269-285 把一切连接错误包成 `MCP_CONNECT_FAILED` 并累计 `#failures`，满 `MCP_RECONNECT_MAX` 永久停用——**授权错误必须在此绕开**）、`#connectClient` :318（`StreamableHttpTransport` :340）、`#isTransportFailure` :382、`#resolveSecretValue` :414）；`mcp/tools.ts`（`buildMcpTools` :21，listTools 失败静默跳过 :33-41；`wrapMcpTool` :57）；`mcp/sse-transport.ts`（自有旧版 SSE，无 authProvider）
- **编排**：`packages/core/src/dispatch/orchestrator.ts`（`retryRun` :942；`setupHit` :1854；`#mediaFacade(setupHit)` :2678 / `#searchFacade` :2711 是「工具记 setup 需求」的样板；MCP 接线 :2031-2045；SETUP_REQUIRED → abort :2366-2373）
- **工具汇总**：`packages/core/src/tools/index.ts`（`buildResponseTools` :182；MCP 工具并入 :816-860——在此加内置名冲突检查）；`tools/image-tools.ts` 的 `TOOL_SETUP_REQUIRED`
- **提示词**：`packages/core/src/agent/context/system-prompt.ts`（`section()` :129、`buildSystemPrompt` :200、段落顺序 :266-283；ACP 版 `buildAgentSessionPrompt` :514、`buildAgentRunContext` :548）
- **网关 / 审批**：`packages/core/src/gateway/index.ts`（`mcpToolCall`，autoApprove 查 `mcpAutoApprove`；`audit`）；`permissions/approvals.ts`（`NEVER_AUTO_DECIDED` :97、`SURVIVES_RUN` :104、`request` / `submitNonBlocking` :150/:207、`#autoDecideSync` :237、`decide` :334——`agent_tool` 用 `payload.durations` 限定可选时长 :362-375，**本方案照此扩展** `mcp_tool`）；`permissions/unattended.ts`；`start.ts:1086`（`mcpAutoApprove` 注入）
- **secrets**：`packages/core/src/domain/secrets.ts`（名称正则 :7、`setValue` 按名覆盖缓存 :63、`redact` 整值替换 :112）；`start.ts:776`（构造与预热）
- **SSRF**：`packages/core/src/search/service.ts`（真正的防线是私有的 undici `#connectGuard` Agent :56-74，连接时逐跳校验解析地址、无 DNS 重绑定窗口；`assertNoPrivateAddress` :272、`isPrivateAddress` :281）——本方案把 `#connectGuard` 抽到 `infra/` 复用
- **主进程服务的方法**（本方案新增 `shell.openExternal` 照此做）：`packages/shared/src/rpc/methods.ts` 的 `browser.*` 一段（:1345 起）与 `BROWSER_RPC_METHODS` 清单（:1388）；main 侧 `apps/desktop/src/main/browser-methods.ts`（`browserMethodSpecs`）及 `index.ts:221` 的 `serverMethods` 组装；core 侧 `packages/core/src/browser/facade.ts`、`packages/core/src/process-entry.ts:109`（`services.browserRpc.bind(platformServer)`）、`start.ts:277/654`（`CoreServicesOptions.browserRpc` 测试注入点）；现唯一 `shell.openExternal` 用法 `apps/desktop/src/main/index.ts:193`
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

**复用**：`McpService` 连接 / 缓存 / 调用；`ToolGateway` + `ApprovalsService`（`payload.durations` 做法）；D58 结构化 setup 失败 + `SetupRequiredCard` + `runs.retry`；`SecretsService`；`search/service.ts` 的 SSRF 校验；D72 的目录 / 发行门禁 / 导入脚本 / 契约测试 / 能力包 / 宿主桥；`browser.*` 的「主进程服务方法」通道。

**不做（整篇）**：为任何平台手写非 MCP 私有 API 集成；内嵌 WebView 登录或读浏览器 Cookie；令牌云同步 / 多设备；每对话独立授权（只做「+」菜单临时开关）；支付与分成；托管授权网关与企业 EMA 的实现（P4 只出任务书）；git commit / push / PR。

## 2. 前置与协作

### 2.1 与 D72（外部智能体）并行工作的协调

**现状（2026-10-07）**：D72 检查点已提交到 main——`b274cb1`（设计 / 方案）、`99013d6`（P0 spike）、`551fb7e`（P1–P4 + P5 第一部分，含 main 迁移 `0017`、runs 迁移 `0005`）。D73 **基于 `551fb7e` 在主工作树开工**。D72 的负责会话现为 **kepcup-03**；D72 的 P5 第二部分在独立 worktree `/home/jyy/wt/d72-p5-2`（分支 `t/d72-p5-2`，基于 `551fb7e`）进行，不碰主工作树，会改 `agent/external/{engine,host}.ts`、`dispatch/orchestrator.ts`、`scheduler/`、`domain/usage.ts`、`domain/lifecycle.ts` 等——合并回 main 时与 D73 在 `orchestrator.ts` / `types.ts` / `start.ts` 可能冲突，届时与 kepcup-03 协调。

- [x] **开工前置（用户决定，2026-10-07）**：等 D72 检查点提交后再开工——已满足（`551fb7e`）。开工时 `git log` 确认 HEAD 包含 `551fb7e`，并用 `ListAgents` / `SendMessage` 通知 kepcup-03（若已不在则问用户）D73 已开始。
- [ ] 为减少与 D72 P5 第二部分的合并冲突：对 `orchestrator.ts` / `start.ts` / `types.ts` 的改动尽量集中、少动既有代码（新逻辑放新模块，主文件只加接线），并在附录 B 记录改动过的段落。
- [ ] 开工前 `git status`，并用 `ListAgents` / `SendMessage` 询问是否有其他 kepcup 会话正在执行 `todo/acp-external-agents.md` 或其他计划，确认文件归属。
- [ ] **不要** `git checkout` / `reset` / 覆盖任何不是你写的改动；与他人改动同文件时只做增量编辑。
- [ ] **迁移编号（2026-10-09 定：不预留）**：多个并行工作（D75、borrowings、D80 等）都在新增 main 迁移，且迁移必须连续（`infra/migrate.ts` 校验），D73 **不预留具体编号**——每次写迁移时 `ls packages/core/migrations/main/` 取当时的下一个空号（本文用 `{N}` / `{N+1}` / `{N+2}` 指代三个 D73 迁移，P0/P1/P2 之间若他人又占了号则继续顺延），写之前用 `ListAgents` 问一下有无会话即将合入新迁移（如 D80 的 worktree `t/schedule-nudges`），合入 main 前再核对一次不冲突。截至 2026-10-09 main 已用到 `0021_delegation_intent`。D73 不改 runs 库（runs `0006`–`0008` 归 D75、`0009_tool_effects` 归 borrowings W2）。另：D75 的 `0018` 重建了 `messages`（新增 `owner_bot_id` / `task_id`，`kind` 含 `task_event`）与 `attachments`，未动 `approvals`；loop_type `'response'` 已改名 `'turn'`（runs `0007`、main `0020`）。
- [ ] **已落地的相关工作（开工前必读其实现，D73 在其上扩展，不重复实现）**：borrowings W5（提交 `60e57d7`）——`core/mcp/risk.ts`（`classifyRisk` / `classifyRiskDetailed`：注解 + 名字推断，写动词一票否决）、`core/mcp/policy.ts`（逐工具策略：工具策略 > server `autoApprove` > 风险档默认，read→auto、其余→ask）、`mcpServerSchema.toolPolicies`（settings 单行 JSON）、审批 payload 带 `risk`、RPC `mcp.toolRisks`、网关 `mcpToolDecision`（对话轮与只读子代理只能调「只读 + auto」工具）、系统提示 `<mcp_tools>` 段、审批卡 `McpRiskBadge`、设置页 `McpToolPolicies.svelte`；**无人值守下 `mcp_tool` 所有风险档自动批准（用户决定，见 borrowings W5「目标 3」）**。D75（对话轮 / 任务分治，`docs/design/30-supervisor-and-tasks.md`）重构了 orchestrator——§0 第 7 条的行号锚点早于 D75 与 borrowings，**全部按函数名重新定位**。borrowings 的其余工作项由会话 kepcup-81 在主工作树推进，开工前用 `ListAgents` 确认文件归属。
- [ ] `approvals` CHECK 重建（P2 的 `egress`）须以 `0017_external_agents.sql` 的 CHECK 列表（含 `agent_tool`）为基础，并包含届时全部 kind。

### 2.2 测试环境

- 命令：迭代中跑定向测试 `node scripts/run-tests.mjs run <测试文件或目录>`、`pnpm --filter @kepcup/core test`；交付前全量 `pnpm test`（Electron-as-Node 跑 vitest）一次、`pnpm lint`、`pnpm typecheck`（已包含 desktop 的 svelte-check）。详见 [docs/dev/05-testing.md](../docs/dev/05-testing.md#开发中如何跑测试)。新增依赖后先 `pnpm install`。
- 本机 Ubuntu 22.04 的 glibc 与 `es-git` 不兼容、缺 `socat`：按 `todo/acp-external-agents.md` 附录 A.3 在 Debian 13 容器中运行；沙箱类用例超时属环境限制，不计入回归判断。
- 所有 OAuth 测试只用 testkit 的假服务（P0 §4.1），**不访问真实网络**；真实服务验证放在 spike 脚本里、需用户登录态（附录 A）。

### 2.3 用户待办与阶段门禁（汇总，详见附录 A）

| #  | 事项                                                                                                                   | 阻塞           |
| -- | ---------------------------------------------------------------------------------------------------------------------- | -------------- |
| U1 | Cloudflare：决定 Bot Fight Mode 处理方式（关闭或 Pro + Skip 规则）；部署 CIMD 文档                                     | P0 验收        |
| U2 | 首批应用的测试账号（Notion、Linear、Atlassian、Sentry、Asana、HubSpot、Canva、Stripe、GitHub）供 spike                 | P1 目录定稿    |
| U3 | GitHub App 注册（仅当 spike 证实 GitHub 不支持 CIMD）                                                                  | P1 GitHub 条目 |
| U4 | Google Cloud 项目 / OAuth 同意屏幕 / Desktop 客户端 / 应用验证；Microsoft Entra 应用；Slack 应用与上架；Figma 合作申请 | P2 对应条目    |
| U5 | Ed25519 目录签名密钥与 CI 密钥；`dl.` / `registry.` 子域；Workers Paid                                             | P3             |

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

- [ ] 新 `packages/testkit/src/fake-oauth-mcp-server.ts`：一个本机 HTTP 服务，同时是 **MCP Streamable HTTP 资源服务器**（用 `@modelcontextprotocol/sdk` 的 server；testkit 补依赖并锁与 core 相同的版本 1.32.1）与 **OAuth 授权服务器**。可配置项：
  - 资源侧：`/mcp` 无令牌返回 401 + `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`；`/.well-known/oauth-protected-resource`（RFC 9728，可配置 `authorization_servers`、`scopes_supported`）；按工具配置所需 scope，不足返回 `403` + `error="insufficient_scope", scope="…"`；校验令牌 audience 与 `resource`；工具列表可在运行中修改并发 `notifications/tools/list_changed`；工具可带任意注解。
  - 授权侧：`/.well-known/oauth-authorization-server`（可切换为仅 OIDC 发现路径）；`client_id_metadata_document_supported` 开关（CIMD：服务端抓取 `client_id` URL 并校验 `client_id`/`redirect_uris`）；`registration_endpoint` 开关（DCR，记录收到的 `application_type` 与 `redirect_uris`）；预注册客户端表；`/authorize`（**无 UI**：校验参数后直接 302 回 `redirect_uri?code&state&iss`；可配置不回 `iss` / 回错误 `iss` / 返回 `error=access_denied`；redirect 匹配可选「精确」或「回环端口无关」）；`/token`（授权码 + PKCE S256 校验、`resource` 必填开关、刷新令牌轮换开关、`invalid_grant` 注入、`expires_in` 可配）；`/revoke`（RFC 7009，记录调用）。
  - 测试辅助：`simulateBrowser(url)`——在测试中替代系统浏览器：GET 授权 URL、跟随一次 302 到回调地址（即 KepCup 的本机回调服务）。
- [ ] `packages/testkit/test/fake-oauth-mcp-server.test.ts`：自测上述每个开关。
- [ ] 测试用 CIMD：testkit 的 `file-server.ts` 托管一份测试 CIMD JSON；core 读取 CIMD URL 的常量在 `NODE_ENV=test` 下允许经 `CoreServicesOptions` 覆盖（非测试环境无效，照 `KEPCUP_KEYSTORE` 的做法）。因本方案不走 pi-mcp 的 CIMD 钩子，http 的测试 URL 不受其 https 校验限制；生产代码自行断言 CIMD URL 为 https。
- [ ] 测试注入点（`CoreServicesOptions`，照 `browserRpc`）：`shellRpc`（替换主进程 `shell.openExternal`，测试里接 `simulateBrowser` 并记录调用次数）、`oauthLoopbackAllowlist`（测试中允许目录条目指向假服务器的 http 回环地址；非测试环境无效）。

### 4.2 shared：类型、常量、错误码、RPC

- [ ] `constants.ts`：
  - `KEPCUP_OAUTH_CLIENT_ID = 'https://kepcup.com/oauth/client.json'`（CIMD URL，**永不更改**）
  - `OAUTH_CALLBACK_PORTS`（3 个固定候选端口，建议 47615–47617，实现时检查与常见开发工具无冲突）、`OAUTH_CALLBACK_PATH = '/callback'`
  - `OAUTH_FLOW_TIMEOUT_MS`（5 分钟）、`OAUTH_REFRESH_SKEW_MS`（60 秒）、`OAUTH_METADATA_MAX_BYTES`（如 64 KB）
- [ ] `errors.ts`：`APP_AUTH_REQUIRED`、`OAUTH_FLOW_FAILED`、`OAUTH_FLOW_CANCELLED`、`OAUTH_FLOW_TIMEOUT`、`OAUTH_CLIENT_REQUIRED`（无任何注册途径，需用户填 client id）、`OAUTH_ISSUER_MISMATCH`、`OAUTH_INSECURE_ENDPOINT`、`APP_CONNECTION_NOT_FOUND`。
- [ ] `types.ts`：
  - `mcpServerSchema` 增 `auth: z.enum(['none','headers','oauth'])`；缺省值须由同级 `headers` 推断（有 headers → `headers`，否则 `none`），字段级 `.catch()` 看不到兄弟字段——用对象级 `z.preprocess`；`superRefine`：`oauth` 只允许 `transport === 'http'`。
  - 新 `appConnectionSchema`（对应 §4.3 表，**不含任何令牌字段**）、`appConnectionStatusSchema`（`not_connected | connecting | connected | expired | needs_scope | tools_changed | error | disabled`）。
  - 新 `approvalDurationSchema = z.enum(['once','conversation','bot'])`，只用于 `ApprovalDecision.duration` 与 `mcp_tool` 的 `payload.durations`；`grantDurationSchema`（`grants` 表与 `agent_tool`）**保持不变**。
  - `setupRequirementSchema` 增 `{ kind: 'connect-app', target: { kind: 'custom', serverId } | { kind: 'catalog', connectorId }, connectionId?: string, scopes?: string[], reason: 'not_connected' | 'expired' | 'scope' }`（P0 只产生 `custom` 目标；`catalog` 形状先定好，P1 使用）。
- [ ] `rpc/methods.ts`（命名遵循 `domain.verb`）：
  - `apps.connect`：`{ target, scopes?, grantBotId? }` → `{ flowId }`（P0 只接受 `custom`）
  - `apps.connect.continue`：`{ flowId }`（用户在界面确认打开授权页后调用，见 §4.6）
  - `apps.connect.cancel`：`{ flowId }`
  - `apps.connections.list` → `{ connections: AppConnection[] }`
  - `apps.disconnect`：`{ connectionId }`
  - `apps.setClientCredentials`：`{ flowId, clientId, clientSecret? }`（手填客户端；issuer 只有在失败的流程里才知道，所以以 `flowId` 定位；写入 issuer 键的 secrets、只写不读回；随后流程自动继续）。`OAUTH_CLIENT_REQUIRED` 的事件负载须带 `issuer` 与**需用户在其平台登记的回调地址列表**
  - `mcp.removeServer`：`{ serverId }`——显式删除自定义 server 并清理其 `mcp:{id}:*`、令牌与连接（不再依赖 `settings.update` 整体替换的差集，陈旧快照会误删）
  - 主进程服务方法 `shell.openExternal`：`{ url }` → `{ ok }`；新增 `SHELL_RPC_METHODS` 清单（类型照 `BROWSER_RPC_METHODS`）
  - 以上加入 `APP_METHODS` 白名单（`shell.openExternal` 除外，它只由 core 经 Port B 调主进程）
- [ ] `rpc/events.ts`：`apps.connect_flow`（`{ flowId, phase: 'discovering'|'awaiting_consent'|'awaiting_browser'|'exchanging'|'done'|'failed'|'cancelled', authorizationHost?, authorizationUrl?, connectionId?, error? }`——`authorizationUrl` 仅在 `awaiting_consent` 下发供用户核对，不含任何令牌）、`apps.connection_status`（`{ connectionId, status }`）；`mcp.server_status` 的 status 增 `needs_auth`。

### 4.3 数据：迁移 `{N}_app_connections.sql`

- [ ] 建 `app_connections`（设计 29 §12 字段：`id, connector_id, connector_ver NULL, label, account_sub NULL, server_url NULL, issuer NULL, scopes, token_expires_at NULL, discovery_json NULL, status, created_at, updated_at, last_used_at NULL` + 部分唯一索引 `(connector_id, account_sub) WHERE account_sub IS NOT NULL`）。自定义 server 的连接 `connector_id = 'custom:{serverId}'`、`id` 同为 `custom:{serverId}`（每个自定义 server 唯一一行）；stdio server 的行 `server_url` 为 NULL（P1 工具锁定用）。**自定义行不随断开删除**（改 `not_connected`），只随 `mcp.removeServer` 删除；`apps.connections.list` 默认不返回 `custom:` 行（`includeCustom` 参数）。
- [ ] 迁移测试（真库，照 `external-agents-migration.test.ts`）。
- [ ] 同步 `docs/dev/03-data-model.md`。

### 4.4 SecretsService 改造（`domain/secrets.ts`）

- [ ] `setValue` 覆盖已有名称时，把旧值移入「仅脱敏」集合（进程结束前一直参与 `redact`）；`removeValue` 同理。集合设上限（如 512 条，LRU 淘汰最旧），防止长期运行时随令牌轮换无限增长。
- [ ] 新增 `removeByPrefix(prefix)`（返回删除的名称列表；被删值进入仅脱敏集合）。
- [ ] 单测：令牌轮换后旧值、新值都被 `redact` 掩码；删除后仍被掩码；名称正则不变（`conn:{id}:access` 等合法）。

### 4.5 Token Vault（新 `packages/core/src/apps/token-vault.ts`）

- [ ] 机密**逐值**存放（设计 29 §5.3）：`conn:{connectionId}:access`、`conn:{connectionId}:refresh`、`oauth:client:{issuerHash}:id`、`oauth:client:{issuerHash}:secret`（`issuerHash` = sha256(issuer) hex 前 24 位）。非机密的 `token_expires_at`、`scopes`、`discovery_json`、`issuer` 存 `app_connections` 行。
- [ ] 自有 API（不实现 pi-mcp 的 `McpOAuthStateStore`）：`getTokens(connectionId)` / `saveTokens(connectionId, OAuthTokens)`（拆值写 secrets，`expires_in` 换算成 `token_expires_at` 写行）、`getClient(issuer)` / `saveClient(issuer, info)`（DCR 结果含 `redirect_uris`，一并存行以便端口预判，见 §4.6）、`saveDiscovery(connectionId, OAuthServerInfo)`；code verifier **只放流程内存**，不持久化。
- [ ] `clearConnection(connectionId)`、`clearIssuerClientIfUnused(issuer)`（无其他连接引用该 issuer 且客户端来自 DCR 时删除）。
- [ ] 单测：落库内容中不出现 JSON 打包的令牌；跨连接共享同 issuer 客户端。

### 4.6 授权引擎：交互流程（新 `packages/core/src/apps/auth/`）

- [ ] `callback-server.ts`：**自建**本机回调服务（不用 `OAuthCallbackServer`，它不校验 `Host`）：`node:http` 监听 `127.0.0.1`，端口依次尝试 `OAUTH_CALLBACK_PORTS`，全占用再用 0（随机）；只接受 `GET {OAUTH_CALLBACK_PATH}`；校验 `Host` 头等于 `127.0.0.1:{port}`；按 `state` 匹配等待者；一次性；`OAUTH_FLOW_TIMEOUT_MS` 超时；回给浏览器一个**无脚本**的本地化结果页（成功：「已连接，可回到 KepCup」；失败：原因）。
- [ ] `safe-fetch.ts`：给 pi-mcp 发现 / 令牌请求注入的 `McpFetch`：只允许 `https:`；把 `search/service.ts` 的 `#connectGuard`（undici `Agent`，连接时逐跳校验地址）抽到 `packages/core/src/infra/safe-dispatcher.ts` 供两处共用，作为 `dispatcher` 使用（不要只做 DNS 预查，存在重绑定窗口）；**唯一例外**——自定义 server 的 URL 本身是回环地址时，允许访问同一回环主机（本机开发），以及测试注入的 `oauthLoopbackAllowlist`；响应体上限 `OAUTH_METADATA_MAX_BYTES`；不跟随跨源重定向。
- [ ] `flow.ts`（`ConnectFlowManager`）——**只用 pi-mcp 低层函数**（`discoverOAuthServerInfo` → 选客户端 → `registerClient`（DCR 时）→ `startAuthorization` → 自建回调 → `exchangeAuthorizationCode`），不使用 `McpOAuthProvider` / `authorizeMcp`；CIMD 时以 `clientInformation: { client_id: CIMD URL }` 调用低层函数：

  1. 发现：`discoverOAuthServerInfo(serverUrl, { fetch: safeFetch })`；记录 issuer。
  2. 客户端身份（设计 29 §5.1 第 3 步的顺序）：本机已有该 issuer 的客户端 → 用；（P1 起）预注册 `clientRef` → 用；AS 声明 `client_id_metadata_document_supported` → CIMD（`clientMetadataDocument` 钩子返回 `{ url: KEPCUP_OAUTH_CLIENT_ID, redirectUrl }`）；有 `registration_endpoint` → DCR（`clientMetadata` 带 `application_type: 'native'`——扩展类型后传入、`redirect_uris` 登记**全部固定端口**、`token_endpoint_auth_method: 'none'`、`grant_types: ['authorization_code','refresh_token']`、`client_name: 'KepCup'`）；都没有 → 失败 `OAUTH_CLIENT_REQUIRED`（界面引导手填）。
  3. 起回调服务 → **端口预判**：客户端来自 DCR 且本次绑定端口（固定端口全被占用而回落随机端口时）不在其已登记 `redirect_uris` 中 → 先以「全部固定端口 + 本次端口」重新注册（授权服务器对非法 redirect **不会回调**，RFC 6749 §4.1.2.1，不能等失败再补救）；手填 / 预注册客户端遇此情况 → 失败并提示释放端口 → PKCE(S256)、`state`、预期 issuer → 构造授权 URL（带 `resource` = server 规范 URI、`scope`）。
  4. **同意与打开**：授权端点 host 属于目录内已审核 issuer（P1 起）→ 直接经主进程 `shell.openExternal`（core 经 Port B 调用）打开；否则（自定义 / developer）发 `phase:'awaiting_consent'`（带完整 URL 与 host），等 `apps.connect.continue` 再打开。
  5. 回调：校验 `state`、`iss`（RFC 9207；AS 声明支持却缺失 `iss` 也失败）→ `exchangeAuthorizationCode`（带 `resource`）→ Token Vault 保存 → 建 / 更新 `app_connections` 行（status `connected`）→ 通知 `ConnectionAuthRegistry` 失效缓存 → `phase:'done'`。
  6. 令牌端点返回 `invalid_client`（DCR 客户端被授权服务器清理等）→ 清除该 issuer 客户端、重新注册一次后重试整个流程。

  - **并发去重**：同一目标（custom serverId / 后续 connectorId / connectionId）进程内同时至多一个流程；重复 `apps.connect` 返回同一 `flowId`。
  - 取消 / 超时 / 应用退出：关闭回调服务、丢弃 verifier。
- [ ] `shell.openExternal` 全链路：shared 方法定义 + `SHELL_RPC_METHODS`；main 新 `shell-methods.ts`（`new URL()` 解析；只允许 `https:` 与主机为 `127.0.0.1` / `[::1]` 的 `http:`；调用 Electron `shell.openExternal`，不经 shell 命令），在 `index.ts:221` 与 `browserMethodSpecs` 合并进 `serverMethods`；core 新 `apps/shell-facade.ts`（照 `browser/facade.ts`），在 `process-entry.ts:109` 旁 `services.shellRpc.bind(platformServer)`；`CoreServicesOptions.shellRpc` 注入点（§4.1）。
- [ ] 单测 / 集成（全部用假服务器）：CIMD 路径、DCR 路径（断言 `application_type: native` 与固定端口）、手填路径、`iss` 缺失 / 不符、`state` 不符、`Host` 头伪造、端口全占用回落随机、PKCE 校验失败、用户拒绝（`access_denied`）、超时、取消、并发去重、非 https 端点拒绝、私网地址拒绝与回环例外。

### 4.7 授权引擎：运行时（`apps/auth/runtime-provider.ts`）

- [ ] `ConnectionAuthProvider implements AuthProvider`：
  - `token()`：读缓存的 access token；距过期 < `OAUTH_REFRESH_SKEW_MS` 且有 refresh token → **single-flight** 调 `refreshAuthorization` 主动刷新并保存；无令牌 → 抛 `AppAuthRequiredError{ reason: 'not_connected' }`。
  - `onUnauthorized(ctx)`：`ctx.token` 与当前令牌不同 → 直接返回（他处已刷新）；`parseWwwAuthenticate`：`403 insufficient_scope` → 状态 `needs_scope`，抛 `AppAuthRequiredError{ reason: 'scope', scopes: stepUpScope(granted, challenged) }`；401 → 有 refresh token 则刷新一次，成功返回、失败（`invalid_grant` 等）→ 状态 `expired`，抛 `AppAuthRequiredError{ reason: 'expired' }`。**绝不**调用 `authorizeMcp` / 打开浏览器。
- [ ] `ConnectionAuthRegistry`：每个连接进程内唯一实例；run、设置页「测试」、工具清单刷新共用；交互流程完成后 `invalidate(connectionId)`。
- [ ] **先验证**（写测试锁住）：① `onUnauthorized` / `token()` 抛出的错误能否原样穿出 `StreamableHttpTransport` → `client.connect` / `listTools` / `callTool`，被包装则在 `McpService` 侧解包识别；② GET 事件流（`openGetStream` 默认开启）收到 401 时错误走向——若触发 `onClose` 并被当作连接失败，须同样识别为授权错误、不计失败（必要时对 OAuth 连接关闭 GET 流）。
- [ ] `ConnectionAuthRegistry.invalidate(connectionId)` 同时调用 `McpService.resetFailures(serverKey)` 并丢弃该连接的缓存客户端，使重连后立即可用。

### 4.8 McpService / MCP 工具接线

- [ ] `#connectClient`：`server.auth === 'oauth'` 时给 `StreamableHttpTransport` 传 `authProvider`（来自 Registry，连接 id = `custom:{serverId}` 对应行）；`sse` 不支持 OAuth（schema 已拒绝）。
- [ ] `#ensureConnected` **的 catch（:269-285）**：识别 `AppAuthRequiredError`（含被包装的情况）→ 不累计 `#failures`、不发 `failed`、发 `mcp.server_status: needs_auth`、**原样重抛**（不包成 `MCP_CONNECT_FAILED`）；新增 `resetFailures(serverId)`。`#isTransportFailure` 同样排除授权错误。`#endpointHint` 对 `oauth` server 改为提示「请在设置中连接」。
- [ ] `testServer`：`oauth` 且无令牌 → 返回可读结果「尚未连接」，不发起授权。
- [ ] `mcp/tools.ts`：
  - `buildMcpTools` 返回值改为 `{ tools, unavailable: Array<{ serverId, reason: 'expired'|'not_connected'|'scope' }> }`（listTools 因授权失败时收集，**不再只记日志**）；`McpToolFacade` 与 orchestrator 调用点同步，`unavailable` 须同时送到 `buildSystemPrompt` 闭包（:2305 一带）与 `buildAgentRunContext`（:1711 一带）。
  - `wrapMcpTool`：捕获 `AppAuthRequiredError` → 经门面回调 `onSetupRequired(requirement)` 记下 `{kind:'connect-app', target:{kind:'custom', serverId}, connectionId, reason, scopes?}`，工具结果 `errorCode = TOOL_SETUP_REQUIRED`、文本「需要重新连接 X」。
- [ ] `orchestrator.ts`（:2031 一带）：`McpToolFacade` 增 `onSetupRequired`，写入同一个 `setupHit`（照 `#mediaFacade(setupHit)`），复用既有 abort → failed + `run.setup` → 卡片 → `runs.retry` 链路。
- [ ] 提示词：新 `section('connected_apps', …)`（`buildSystemPrompt`，放在 `skills` 附近）：P0 只列出**需要重新连接**的自定义 server（名称 + 原因）与一句规则「需要时调用 `app_request_connection`，不要让用户粘贴令牌」；无内容则整段省略。
- [ ] 新工具 `app_request_connection`（`packages/core/src/tools/app-tools.ts`，P0 只接受 `connection_id` / 自定义 `server_id`）：校验目标存在且属于该 Bot 已勾选的 server → 记 setup 需求、返回 `SETUP_REQUIRED`。（P0 时 ACP Bot 拿不到它——`apps` 能力包在 P1 才加，属预期。）
- [ ] 删除自定义 server：`McpSection.removeServer`（:215）改调 `mcp.removeServer`（§4.2），core 侧删除 settings 条目并清理 `mcp:{id}:*`、`custom:{id}` 连接行与 `conn:*`、必要时 issuer 客户端、断开连接——修复设计 29 §2 所列遗留泄漏。

### 4.9 断开与吊销

- [ ] `apps.disconnect`：AS 有 `revocation_endpoint` → 先吊销 refresh token（再 access token），失败只记日志不阻断；删除 `conn:{id}:*`；目录连接删除 `app_connections` 行（工具锁定行级联删除，重连时重新复核），自定义 server 的行保留并置 `not_connected`（保留工具锁定）；`clearIssuerClientIfUnused`；`McpService` 断开该连接；发 `apps.connection_status`。
- [ ] 审计：`app_connect`、`app_disconnect`（明细只含 connectionId / connector / issuer / scopes，经 `redact`）。

### 4.10 渲染端

- [ ] `McpSection.svelte`：HTTP server 增「认证方式」选择（无 / Header / OAuth）；OAuth 时显示连接状态（未连接 / 已连接（账号）/ 需重新连接 / 权限不足）与「连接 / 重新连接 / 断开」；`awaiting_consent` 时展示完整授权 URL、突出域名、「在浏览器中继续」与取消；`OAUTH_CLIENT_REQUIRED` 时展开 client id / secret 输入（`apps.setClientCredentials`）。
- [ ] 新 `stores/apps.svelte.ts`：订阅 `apps.connect_flow` / `apps.connection_status`，持有连接列表与进行中流程（照 `stores/agents.svelte.ts`）。
- [ ] 新共享组件 `features/apps/ConnectAppPanel.svelte`（设置页与对话卡共用；P1 扩展目录形态）：按 phase 显示进度；`OAUTH_CLIENT_REQUIRED` 时显示 issuer、需登记的回调地址与 client id / secret 输入。
- [ ] `SetupRequiredCard.svelte` 增 `connect-app` 分支（用 `ConnectAppPanel`）；完成后走既有「dismiss + `runs.retry`」。
- [ ] i18n 键（zh-CN）。

### 4.11 CIMD 文档与 Cloudflare 部署材料

- [ ] 新 `infra/cloudflare/oauth-cimd/`：`wrangler.jsonc`（仅静态资源，路由 `kepcup.com/oauth/*`）、`public/oauth/client.json`、`public/_headers`（`/oauth/*`：`Content-Type: application/json`、`Cache-Control: public, max-age=86400`、`Access-Control-Allow-Origin: *`）、`README.md`（部署步骤、Bot Fight Mode 注意事项、验证命令）。
- [ ] `client.json`：`client_id` = `KEPCUP_OAUTH_CLIENT_ID`（逐字相等）、`client_name: "KepCup"`、`redirect_uris`（`http://127.0.0.1/callback` + 每个固定端口的完整地址）、`grant_types`、`response_types: ["code"]`、`token_endpoint_auth_method: "none"`、`logo_uri`、`client_uri: "https://kepcup.com"`、`policy_uri`（隐私政策 URL 用户确认）；≤5 KB。
- [ ] 单测 `shared/test/unit/cimd-document.test.ts`：读取该文件，断言 `client_id === KEPCUP_OAUTH_CLIENT_ID`、`redirect_uris` 覆盖全部 `OAUTH_CALLBACK_PORTS`、体积 ≤5 KB、无 `localhost`。
- [ ] 外部验证脚本 `infra/cloudflare/oauth-cimd/verify.mjs`：对线上地址检查 200、`application/json`、无重定向、内容与仓库文件一致（**用户待办 U1** 部署后运行）。

### 4.12 文档与测试汇总

- [ ] 安全测试（`packages/core/test/security/`）：完整连接—调用—刷新—过期—重连—断开流程后，扫描 `runs.db`、`audit_log`、日志文件、所有 RPC 返回与事件负载，均不含任何令牌明文。
- [ ] 集成测试：Bot 勾选一个 OAuth 自定义 server → run 中调用成功；令牌过期且刷新失败 → 工具结果 SETUP_REQUIRED → run failed + `setup.kind === 'connect-app'` → 模拟完成连接 → `runs.retry` 成功；run 开头 listTools 授权失败 → 不中断 run、`<connected_apps>` 列出该 server；run 中途 401 时**没有**调用 `shell.openExternal`。
- [ ] 同步 `docs/dev/02-architecture.md`（apps 模块、主进程方法）、`03-data-model.md`、`04-agent-runtime.md`（新提示段与工具）、`05-testing.md`（假授权服务器）、`23-mcp-and-subagent.md`（认证方式）。

### 4.13 P0 验收（门禁）

- 自定义 OAuth server 在假服务器的 CIMD / DCR / 手填三条路径上均可连接、调用、刷新、断开（含吊销）。
- run 中授权失效只出现对话内卡片，不弹浏览器；重连后 `runs.retry` 完成任务。
- 安全测试通过（令牌零泄露）；D65 既有 MCP 测试全绿（跑 MCP 相关测试文件即可，全量留到交付前一次）。
- （用户待办 U1 完成后）`verify.mjs` 对 `https://kepcup.com/oauth/client.json` 通过；用 Notion 或 Linear 官方 MCP 以「自定义」方式手工走通一次（记录在 PROGRESS）。

---

## 5. P1 — 连接应用 MVP

**目标**：设置页「应用」分区可浏览内置目录、一键连接（多账号）；Bot 勾选连接；工具按风险分级审批；工具定义锁定与复核；Bot 在对话中请求连接；ACP Bot 可注入应用能力。

### 5.1 首批应用实测（spike，先于目录定稿）

- [ ] `packages/core/scripts/connector-spike/`（不进产品代码）：对候选 URL（Notion `https://mcp.notion.com/mcp`、Linear `https://mcp.linear.app/mcp`、Atlassian `https://mcp.atlassian.com/v1/mcp/authv2`、Sentry `https://mcp.sentry.dev/mcp`、Asana `https://mcp.asana.com/…`、HubSpot、Canva `https://mcp.canva.com/mcp`、Stripe `https://mcp.stripe.com`、GitHub `https://api.githubcopilot.com/mcp/`；以各家文档为准）输出 JSON 报告：401 challenge、PRM、AS 元数据、**是否支持 CIMD / DCR**、`scopes_supported`、`code_challenge_methods_supported`、`authorization_response_iss_parameter_supported`、`revocation_endpoint`。
- [ ] 带登录模式（需**用户待办 U2** 的账号，用户在浏览器里登录）：用 P0 引擎完整连接，导出工具清单、注解覆盖率（多少工具缺 `readOnlyHint` / `destructiveHint`）、账号识别可行性。
- [ ] 结论入本文附录 B：每家「可上目录 / 需预注册 / 暂不支持」。只有能自动注册（CIMD 或 DCR）的进 P1 目录；GitHub 不支持 CIMD 时需用户注册 GitHub App（U3）并走 P2 的预注册客户端机制——**不要**为赶 P1 提前做半套。

### 5.2 目录（catalog）

- [ ] shared `domain/connector-catalog.ts`：zod schema = `server.json` 子集（`name`、`title`、`description`、`version`、`remotes[]`（P1 只认 `streamable-http`）、`packages[]`（P2 MCPB）、`_meta`）+ `_meta["app.kepcup/connector"]`（设计 29 §4：`slug` `[a-z0-9]{2,16}`、`icon`、`category`、`tier`、`auth{kind, registration, clientRef, scopes{default, write}}`、`toolPolicy`、`skills`、`ui`、`privacyPolicy`、`whoami?`（账号识别用只读工具名 + 结果字段路径）、`releaseGate`）。导出 `filterReleasedConnectors`（fail-closed，照 `filterReleasedAgents`）。
- [ ] 资源 `apps/desktop/resources/connectors/catalog.json` + `icons/*.svg`；core 运行时读取（照 `skills/presets.ts` 读资源 JSON）；发行门禁清单 `apps/desktop/connector-release-gates.json`，构建期注入（照 `agent/external/catalog.ts:18-22` 与 `scripts/dist.mjs`；新常量在 `packages/core/src/build-constants.d.ts` 声明）。
- [ ] 脚本 `scripts/import-mcp-registry.mjs`：从 MCP Registry 按 name 导出 `server.json` 骨架，`_meta` 扩展字段留占位人工补。
- [ ] 契约测试 `packages/core/test/contract/connector-catalog.contract.ts`，由 `packages/core/test/unit/connector-catalog.test.ts` 包装执行（vitest 只收 `*.test.ts`）：每个条目 schema 合法、slug 唯一且符合字符集、图标文件存在、`remotes[0].url` 为 https、`toolPolicy` 中的风险值合法、带 `releaseGate`。

### 5.3 数据：迁移 `{N+1}_app_tools.sql`

- [ ] `app_connection_tools`（设计 29 §12：`connection_id, tool_name, approved_hash NULL, current_hash, risk, user_policy NULL, definition_json`，PK `(connection_id, tool_name)`）。
- [ ] `app_tool_grants`（`id, bot_id, connection_id, tool_name, conversation_id NULL, approval_id, created_at, revoked_at`；`conversation_id` NULL = 对该 Bot 总是允许；索引 `(bot_id, connection_id, tool_name) WHERE revoked_at IS NULL`）。
- [ ] 清理：Bot 删除时撤销其全部 `app_tool_grants`（接入 `domain/lifecycle.ts`）；对话删除由外键 `ON DELETE CASCADE` 处理（`foreign_keys=ON`，`infra/db.ts:37`）；Bot 被移出群时撤销其在该对话的 `app_tool_grants`。

### 5.4 连接服务（`packages/core/src/apps/connections.ts`）

- [ ] 目录连接：`apps.connect({ target: { kind: 'catalog', connectorId }, grantBotId? })`；`server_url` 取 `remotes[0].url`；`connector_ver` 记录目录版本；多账号 = 同一 connector 多行。`grantBotId` 由 **core** 在流程完成时写入该 Bot 的 `app_connection_ids`（不由渲染端改 Profile）。
- [ ] **进入 McpService**：`McpService` 的服务器来源从「只有 settings」改为 `settings.mcpServers` ∪ 目录连接合成的 `McpServer`（`id = connectionId`、`name = 应用名（账号）`、`transport: 'http'`、`url = server_url`、`auth: 'oauth'`、`enabled: true`）；`listServers` / `#connections` / `closeAll` / `mcp.server_status` 均按此 id；授权提供者统一按「连接 id」从 `ConnectionAuthRegistry` 取（自定义为 `custom:{serverId}`，目录为 `connectionId`）；`mcpAutoApprove` 只对 settings 中的自定义 server 生效。
- [ ] 账号识别（设计 29 §5.1 第 6 步）：有 `id_token` / userinfo → `account_sub` + 显示名；否则条目 `whoami` 只读工具；否则 `label = "{title} #{n}"`。`account_sub` 冲突（同账号重复连接）→ 复用旧行（更新令牌）而非新建。
- [ ] **首连工具复核**：交换令牌后进入 `phase: 'reviewing_tools'`（事件带工具清单：名称、标题、描述、计算出的风险）；用户在面板确认 → `apps.connect.confirmTools({ flowId })` → 写 `app_connection_tools` 的 `approved_hash` → `connected`。拒绝 = 取消并吊销。
- [ ] RPC：`apps.catalog.list`（含每个条目的已连接账号数）、`apps.connections.update`（标签、停用 / 启用）、`apps.connections.setToolPolicy({ connectionId, toolName, policy })`（`policy` 与 W5 的 `mcpToolPolicy` 同形：`{ approval?: 'auto'|'ask', enabled?: boolean }`；自定义 server 继续用 W5 的 `settings.mcpServers[].toolPolicies`，目录连接存 `app_connection_tools.user_policy` JSON）、`apps.connections.reviewTools({ connectionId, accept: string[] })`、`apps.connections.grants({ connectionId })` / `apps.grants.revoke({ grantId })`；事件 `apps.connection_status` 增 `tools_changed` 详情。

### 5.5 策略：风险分级与工具锁定（`packages/core/src/apps/policy.ts`，纯函数为主）

- [ ] **分级复用 W5**：直接调用 `core/mcp/risk.ts` 的 `classifyRiskDetailed`（若 D73 需要在 shared / 校验器中复用，再把纯函数移到共享位置并保持 W5 测试全绿）。D73 只在其外层叠加目录 `toolPolicy`：只能调高；`builtin` 条目可为**未声明注解且名字推断不出只读**的工具给出分级，不能放宽 W5 的判定结果。`openWorldHint` 不参与分级（只用于 §6.2 污点）。补表驱动单测覆盖「W5 结果 × 目录覆盖」。
- [ ] `toolDefinitionHash(tool)`：对 `{ name, title, description, inputSchema, annotations }` 做规范化 JSON（键排序）后 sha256。
- [ ] 工具刷新（`tools/list_changed` 或缓存过期）时：新增工具 → `approved_hash NULL`；定义变化 → `current_hash ≠ approved_hash`；二者都**不暴露**；连接状态 `tools_changed` 并发事件；删除的工具直接删行。
- [ ] 锁定对**所有** MCP server 生效：过滤点在 `buildMcpTools`（注入 `toolFilter(serverKey, tools)`），自定义 server（含 stdio、无 OAuth）用 `custom:{serverId}` 行承载工具锁定（`server_url` 可为 NULL）。
- [ ] **存量基线**：core 启动时若 `settings.apps.toolLockBaselineDone` 不为真，则为当时**已存在**的每个自定义 server 建 `custom:` 行并标记「首次拉取到的工具直接批准」（`app_connections.baseline_pending` 列，`{N+1}` 以 `ALTER TABLE … ADD COLUMN` 加入），完成后置位标记——只作用一次。之后新加的自定义 server：设置页「测试」成功后展示工具清单，保存即批准；未批准前工具不暴露。

### 5.6 网关与审批

- [ ] 在 W5 的网关决策（`mcpToolDecision`，工具策略 > server `autoApprove` > 风险档默认）上扩展连接上下文 `{ connection?, accountLabel?, connectorSlug? }`，**不另起一套**：
  - 策略 `enabled:false` → 拒绝（W5 已有）；对话轮 / 只读子代理只能调「只读 + auto」工具（W5 / D75 已有，应用工具同样适用）。
  - 决策为 `ask` 时，新增一步：先查 `app_tool_grants`（本对话 or Bot 级、未撤销）→ 命中免卡；否则 `mcp_tool` 审批，`payload.durations`：`write` 为 `['once','conversation','bot']`，`destructive` 为 `['once']`（卡片标「不可撤销」）。
  - 审批通过且时长为 `conversation` / `bot` → 写 `app_tool_grants`。
- [ ] `mcpToolApprovalPayloadSchema` 增可选 `connectionId`、`connectorSlug`、`accountLabel`、`risk`、`durations`（`approvalDurationSchema` 数组）；`ApprovalDecision.duration` 与 `approvals.decide` / RPC 入参改用 `approvalDurationSchema`；`decide()` 中：`'bot'` 只对 `mcp_tool` 且在 `payload.durations` 内时接受，否则降为 `'once'`；`'conversation'` 对 `mcp_tool` 同样按 `payload.durations` 判定（现只对 `agent_tool` 降级）；`grants` 表与 `agent_tool` 仍只见 `once|conversation`。同步 `ApprovalCard`、`renderContextLine`、`stores/permissions.svelte.ts:99`。
- [ ] **无人值守**：沿用 W5——`mcp_tool` 所有风险档自动批准（用户决定），**不改** `NEVER_AUTO_DECIDED`；应用工具的风险档与账号身份写入审计与上下文行，Bot 详情的 MCP 风险提示覆盖应用工具。
- [ ] `ApprovalCard.svelte`（W5 已有 `mcp_tool` 专用正文与 `McpRiskBadge`，在其上扩展）：显示「以 {account} 身份在 {app} 执行 {tool}」、时长选项按 `durations` 渲染；`destructive` 显示完整参数（不只摘要）与醒目提示。

### 5.7 Bot 授权与工具暴露

- [ ] `botRuntimeSchema` 增 `app_connection_ids: z.array(z.string()).default([])`（Profile JSON，无迁移）；校验放在 bots 领域层（`bots.create` 与 `bots.update` 都会带 Profile）：每个 connector 至多一个连接、连接存在且未删除，否则 `INVALID_INPUT`。删除连接时从所有 Bot 移除。
- [ ] 工具命名 `appToolName(slug, toolName)`：`app_{slug}_{tool}` sanitize `[A-Za-z0-9_-]`、≤50 字符（截断冲突时加短哈希后缀）。
- [ ] orchestrator：在 MCP 接线旁新增连接应用接线（Bot 勾选的、`connected` 的连接 → 只暴露 `approved_hash === current_hash` 且未 `disabled` 的工具）；`expired` / `needs_scope` 的连接不暴露工具，进入 `<connected_apps>` 状态行。
- [ ] `tools/index.ts` 汇总处加**全局去重**：任何 MCP / 应用工具与内置工具同名 → 丢弃并告警（现只在 MCP 之间去重）。
- [ ] `<connected_apps>` 段：每个已授权连接一行（应用名、账号标签、状态、条目一句话说明）；`<available_apps>` 段：目录中未连接的已发行条目（名称 + 一句话，≤30 条）；平台规则补一句「需要未连接或需重连的应用时调用 `app_request_connection`」。
- [ ] `app_request_connection` 完整版：`{ connector?: slug, connection_id?, reason }`；未连接 → `target: catalog`；已勾选但过期 → `connectionId`。

### 5.8 对话内连接（完整）

- [ ] `ConnectAppPanel` 支持目录形态：图标、名称、将申请的权限、「连接后授权给当前 Bot」（默认勾选；该 Bot 已有同应用的另一账号时提示将替换）、工具复核步骤。
- [ ] 卡片完成连接 → 按勾选写入 Bot 的 `app_connection_ids` → `runs.retry`。
- [ ] 群聊多个 Bot 同时请求同一应用：后到的卡片加入同一流程（§4.6 去重），完成后各自按自身勾选授权。

### 5.9 设置「应用」分区

- [ ] `stores/shell.svelte.ts` 分区 id 新增 `apps`，`mcp` 作为别名映射到 `apps` 的「自定义」页；`SettingsDialog` 导航用 `Plug` 图标替换原 MCP 项。
- [ ] `features/settings/AppsSection.svelte`：三个页签——**目录**（卡片网格、搜索、分类、tier 标签、连接按钮）、**已连接**（按应用分组的连接列表：账号、状态、已授权 Bot、最近使用）、**自定义**（嵌入现 `McpSection`）。
- [ ] 连接详情页：权限范围、逐工具列表（风险徽标 + 策略下拉）、待复核工具 diff（旧 / 新定义对比）、Bot 级持续授权列表（可撤销）、重新连接、断开（确认框列出受影响 Bot）。
- [ ] `BotProfileForm.svelte`：「应用」区按应用分组，单选账号；未连接的应用显示「去连接」（`shell.openSettings('apps')`）；工具数估计纳入应用工具。
- [ ] 图标加载照 `agent-icons.ts`；i18n。

### 5.10 外部智能体（ACP）

- [ ] `HOST_CAPABILITIES` 增 `apps` 能力包（`category: 'supplement'`、`default: 'follow_bot'`、`toolPrefixes: ['app_']`、无 `overlapsNative`）；`app_request_connection` 归入该包（前缀即可命中 `capabilityOfTool`）。
- [ ] 宿主桥的工具名经 `fitToolName` 后 `mcp__kepcup__{name}` 总长 ≤64 的测试。
- [ ] 桥的 `tools/list` 为应用工具输出与风险一致的注解（扩展 `toolAnnotations` / `READ_ONLY_TOOLS` 的判定：`read` → `readOnlyHint:true`；`destructive` → `destructiveHint:true`），让外部 Agent 侧的权限提示与宿主一致。
- [ ] ACP 提示词（`buildAgentRunContext`）同样注入 `<connected_apps>` / `<available_apps>`。
- [ ] 外部智能体自身 shell / fetch 不受网关管控的残余风险：Bot 切到外部智能体且勾选 `apps` 包时，首次弹框说明（文案键）。

### 5.11 P1 验收（门禁）

- 附录 B 的首批应用（spike 通过者）可从目录连接、多账号、Bot 勾选、在对话中完成任务。
- 端到端（假服务器）：新用户说「把这个 bug 记到 X」→ 连接卡 → 授权 → 工具复核 → `runs.retry` → 写工具审批卡（显示账号）→ 完成。
- 风险分级（复用 W5）：只读工具免审；`destructiveHint:false` 写工具弹卡且可选三种时长；缺注解且名字推断不出只读的工具按 destructive 弹卡（仅「仅这一次」）；无人值守下全部自动批准，审计记风险档与账号。
- 工具锁定：假服务器修改某工具描述后，该工具从 Bot 工具集消失，复核后恢复。
- ACP Bot 勾选 `apps` 包后可调用应用工具，审批一致。
- 安全测试仍通过；D65 / D72 回归全绿（跑相关测试文件即可，全量留到交付前一次）。

---

## 6. P2 — 规模化与大平台

### 6.1 权限追加（step-up）

- [ ] 运行时 `reason: 'scope'` → 卡片说明新增权限 → `apps.connect({ target, connectionId, scopes })` 以 `stepUpScope` 并集重新授权（跳过刷新）。
- [ ] 计数：`(conversationId, connectionId)` 30 分钟窗口内至多 1 次 step-up 卡（进程内 Map 即可，重启清零可接受）；超出时工具结果为普通失败文本。
- [ ] 默认最小范围：目录 `auth.scopes.default` 只读优先，写权限在 `insufficient_scope` 时追加。

### 6.2 污点外发控制（设计 29 §8.3）

- [ ] 污点状态表（随 `{N+2}_egress_approval.sql`）：`app_taint(bot_id, conversation_id, first_at, expires_at)`；任意应用工具**成功返回内容**后置位 / 续期 24 小时。按（Bot, 对话）计，`runs.retry` 与续接天然继承。
- [ ] 新审批 kind `egress`（设计 29 §8.3 / §12 已同步；同迁移重建 `approvals` CHECK，带全现有 kind；§8.1「不新增审批 kind」只针对应用工具本身的审批）：payload `{ channel: 'web_fetch'|'web_search'|'browser'|'app_tool'|'mcp_tool', target, summary }`，时长仅 `once`。
- [ ] 污点期间拦截点：应用 / 自定义 MCP 非只读且 `openWorldHint !== false` 工具（即使有持续授权也要卡）；`web_fetch`（任意 URL）、`web_search`；浏览器导航与表单提交；沙箱 `bash` 在 Bot `network_policy === 'open'` 时强制逐条 `command` 确认；`git_remote` 卡片附加污点提示；ACP 权限桥对网络类请求降为逐次确认。
- [ ] 无人值守：按 D41 / W5 自动批准，但审计 action `egress_tainted` 标记，Bot 详情汇总展示。
- [ ] 开关 `settings.apps.taintGuard`（默认 true，高级）。
- [ ] 测试：读取应用数据后 web_fetch 弹 `egress` 卡；retry 后仍弹；关闭开关后不弹；24 小时后过期。

### 6.3 按需工具发现

- [ ] 阈值常量 `APP_TOOLS_INLINE_MAX`（如 40，按全部应用工具总数）。超过时：只注入 `<connected_apps>` 摘要 + 两个稳定工具 `app_search_tools(query, connector?)`（返回匹配工具名、说明、参数 schema）与 `app_call_tool(name, arguments)`（分发器：按被调工具自身风险走网关与锁定，审批卡显示真实工具）。工具列表 run 内不变。
- [ ] 测试：超阈值时工具数稳定；`app_call_tool` 调用未批准 / 被禁用的工具被拒。

### 6.4 预注册客户端与大平台条目

- [ ] `apps/desktop/oauth-clients.json`：`{ [clientRef]: { issuer, clientId, clientSecret? } }`（仅放平台定义为**非保密**的桌面客户端凭据），构建期注入 `__KEPCUP_OAUTH_CLIENTS__`；流程第 2 步按 `clientRef` 取用；用户可在「自定义」中按 issuer 覆盖（BYO 客户端）。
- [ ] Google Workspace（需 **U4**）：Workspace MCP 端点（预览，以届时文档为准）+ Google「桌面应用」客户端；首批只用非受限范围（`drive.file`、日历、`gmail.send` 等），受限范围等用户决定 CASA；`tier: builtin` + `releaseGate`。
- [ ] Microsoft 365、Slack（需 **U4**）：同上模式；Slack 只能用已发布 / 内部应用。
- [ ] GitHub（若 P1 spike 证实不支持 CIMD，需 **U3**）。
- [ ] Figma：未获白名单前不进目录。

### 6.5 MCPB 本地包

- [ ] 解析与校验 manifest v0.3（`server.type` node / python / binary / uv、`mcp_config`、`user_config`、`compatibility`）；平台 / 运行时不兼容给出可读错误。
- [ ] 安装：审批卡显示**完整启动命令**、来源、体积（环境管理器 D13 流程）；解包到 `~/.kepcup/toolchains/mcpb/{name}@{version}/`（内容哈希校验）；运行时由环境管理器按需安装。
- [ ] `user_config`：`sensitive` 字段存 `mcp:{serverId}:env:{name}`；生成一条自定义 stdio server（标注来源 bundle、tier `developer` 除非来自目录）。
- [ ] 入口：设置「自定义」页「安装 .mcpb」+ 目录条目的 `packages[].registryType === 'mcpb'`。

### 6.6 开发者模式

- [ ] 设置开关；开启后「自定义」页显示原始工具定义（含注解）、授权流程事件日志（不含令牌）、手动刷新工具；自定义条目 tier `developer`：所有工具每次确认（可手动放宽，`destructive` 除外）。

### 6.7 协议版本

- [ ] 跟踪 `pi-mcp` 对 MCP 2026-07-28（无状态、MRTR、`server/discover`）的支持；若 P2 开始时仍无：spike 在 `McpService` 的 HTTP 连接中改用官方 `@modelcontextprotocol/sdk` 届时支持 2026-07-28 的版本（当前锁定 1.32.1 为 v1 线，需评估升级对宿主桥的影响），接口不变；假服务器增加无状态模式以覆盖。结论记附录 B。

### 6.8 「+」菜单临时开关（可选）

- [ ] 对话输入坞「+」菜单列出当前 Bot 已授权的应用，可在本对话临时关闭某应用（存对话级设置，不影响 Bot 授权）。

### 6.9 P2 验收（门禁）

- step-up、污点、按需发现的测试全绿；至少一个预注册客户端条目（Google 或 GitHub）真实走通（依赖用户待办）；MCPB 示例包安装运行；协议版本结论明确。

---

## 7. P3 — 开放平台基座

### 7.1 签名目录索引

- [ ] 索引格式 `connectors/v1/index.json`：`{ version, generatedAt, keyId, entries: server.json[] }` + 分离签名 `index.json.sig`（Ed25519，base64）；增量 `deltas/{from}-{to}.json` 按内容寻址。
- [ ] CI 签名脚本 `scripts/sign-connector-index.mjs`（私钥只从 CI 环境变量读取，**用户待办 U5**）；公钥列表（含 keyId，支持轮换）编译进 shared 常量。
- [ ] 客户端 `apps/directory-sync.ts`：每日拉取 `https://dl.kepcup.com/connectors/v1/index.json`（ETag）→ Node `crypto` 验签 → 防回滚（`generatedAt` 单调、记录最后版本）→ 与打包快照合并（同名取较新且通过验签者）→ 缓存 `~/.kepcup/cache/directory/`；验签失败回落快照并告警。
- [ ] `infra/cloudflare/directory/`：Static Assets 或 R2 自定义域部署材料（设计 29 §15.2）。

### 7.2 分级信任落地

- [ ] `tier` 影响默认值：`community` 写工具不可「对该 Bot 总是允许」、首连额外提示；`developer` 全部每次确认。目录 UI 社区分组默认折叠、`verified` 标识。

### 7.3 子注册表 Worker

- [ ] `infra/cloudflare/registry/`：Workers + D1 实现官方 Registry OpenAPI v0.1 的只读接口（`GET /v0.1/servers`、`/v0.1/servers/{name}/versions` 等，以官方 OpenAPI 为准）；Cron 触发从官方注册表同步；审核状态表；`createMcpHandler` 不需要。部署为 `registry.kepcup.com`（U5）。
- [ ] 用官方 Registry 的 OpenAPI 做契约测试。

### 7.4 校验器 CLI

- [ ] 新包 `packages/app-validator`（bin `kepcup-app`）：`kepcup-app validate <server.json | url>`——可达性、PRM / AS 发现、CIMD 或 DCR 可用、每个工具有 `title` 与风险注解、读写拆分启发式检查、名称 ≤64、`_meta["app.kepcup/connector"]` 合法、MCP Apps 的 CSP 声明、隐私政策链接；`--auth` 交互模式用 KepCup CIMD 身份走一次真实授权。复用 core 的 policy / catalog schema（抽到 shared 或独立包，避免依赖 Electron）。

### 7.5 MCP Apps 渲染（先 spike）

- [ ] Spike：Electron 中以自定义特权协议 `kepcup-app://{connectionId}/`（standard + secure）在**独立 partition** 内承载 `ui://` 资源 HTML，iframe `sandbox="allow-scripts"`（无 same-origin）、无 preload / Node；CSP 由 `_meta.ui.csp` 生成；验证 `@modelcontextprotocol/ext-apps` AppBridge 在 Svelte 渲染端可用。结论记附录 B，不可行则调整方案后再实现。
- [ ] 实现：工具结果带 `_meta.ui.resourceUri` → core `resources/read` 取 HTML → 消息流内卡片渲染；界面发起的 `tools/call` 经 RPC `apps.ui.callTool` 回到网关（同一审批与风险策略）；外链经 `shell.openExternal` 且先确认。
- [ ] 安全测试：iframe 无法访问 `window.kepcup`、其他应用数据、令牌；CSP 外的请求被拦。

### 7.6 随附 Skills

- [ ] 目录条目 `_meta.skills` → 连接成功后提示安装（走既有 `skill_import` 审批，D63），安装到被授权的 Bot。

### 7.7 开发者门户与审核流水线

- [ ] 本阶段只出任务书 `todo/developer-portal.md`（Cloudflare：GitHub OAuth + DoH TXT 命名空间验证 + Turnstile + D1/R2 + Workflows + Sandbox SDK 扫描，设计 29 §11.5、§15），不实现。

### 7.8 P3 验收

- 签名索引端到端（篡改 / 回滚被拒、离线回落）；子注册表通过 OpenAPI 契约测试；`kepcup-app validate` 对一个已上架 Claude / ChatGPT 目录的第三方应用的 `server.json`（补 `_meta` 后）通过；MCP Apps 示例渲染并通过安全测试。

---

## 8. P4 — 企业与托管网关（只出任务书）

- [ ] `todo/hosted-auth-gateway.md`：Cloudflare `workers-oauth-provider`（CIMD + `global_fetch_strictly_public`）+ Agents SDK `createMcpHandler` + D1 / Durable Objects 令牌库（应用层加密、`eu` 管辖区）+ URL 模式 elicitation 账号关联页（`__Host-` Cookie、一次性 state、同一用户校验）；只在某平台无法本地直连时启动（设计 29 §11.7、§15.3）。
- [ ] `todo/enterprise-ema.md`：MCP Enterprise-Managed Authorization（ID-JAG / Okta XAA）客户端支持。

---
