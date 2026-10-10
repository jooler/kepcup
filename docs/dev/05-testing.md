# 05 测试策略

## 测试分层

| 层 | 范围 | 工具 | 位置 |
|---|---|---|---|
| 单元测试 | 纯函数、解析器、策略生成、上下文组装、白名单匹配、租约冲突判定 | vitest | 各包 `test/unit/` |
| 集成测试 | 核心服务的服务层 + 真实数据库（临时目录）+ 模拟模型服务 | vitest | `packages/core/test/integration/` |
| 沙箱测试 | 真实沙箱中的逃逸用例与网络用例 | vitest（按平台条件执行） | `packages/core/test/sandbox/` |
| 端到端测试 | 启动打包前的 Electron 应用，模拟用户操作界面 | Playwright（`_electron`） | `apps/desktop/test/e2e/` |
| 手工冒烟 | 使用真实模型厂商 | 检查清单（下文） | — |

每个阶段的“测试要求”说明该阶段必须新增哪些测试；阶段收口时全部测试必须通过（全量跑一次即可）。开发与修复迭代中先跑定向测试，见下文[开发中如何跑测试](#开发中如何跑测试)。

## 开发中如何跑测试

**先定向、后全量**。开发与修复迭代中只跑与改动相关的测试；全量只在收口时跑一次。

定向命令（根目录执行；容器里同样只用 `node scripts/run-tests.mjs run …`，见下文[本机容器运行](#本机容器运行linux-开发机)）：

| 范围 | 命令 |
|---|---|
| 单个文件或目录 | `node scripts/run-tests.mjs run packages/core/test/unit/xxx.test.ts` |
| 文件内按用例名 | `node scripts/run-tests.mjs run <测试文件> -t "用例名片段"` |
| 单个包 | `pnpm --filter @kepcup/core test`（`shared` / `testkit` 同理）；desktop 单测用 `node scripts/run-tests.mjs run --project desktop` |
| 单个 e2e spec | `pnpm build` 后 `pnpm --filter @kepcup/desktop test:e2e test/e2e/xxx.spec.ts` |
| 单包类型检查 | `pnpm --filter @kepcup/core typecheck`（`shared` / `desktop` 同理） |

- 顺序：先跑改动文件对应的测试与新增测试 → 需要时再跑改动所在包 → 收口时全量。
- **全量 `pnpm test` 只在以下情况跑**：
  1. 阶段收口或最终交付前，跑**一次**；
  2. 改了跨包公共部分（`packages/shared` 契约、`packages/testkit`、数据库迁移、`vitest.config.ts` / `scripts/run-tests.mjs`）；
  3. 用户或调度会话明确要求。
- 不做「连续多轮全量」。全量里出现偶发失败时，只单跑失败的那个文件复核。
- 改动前不重跑全量建基线：直接引用下文已记录的基线（及 PROGRESS.md / todo 中最近一次全量结果）。
- 不推荐 `vitest related` / `--changed`：各包测试经 `@kepcup/shared`、`@kepcup/core` 的入口别名导入，依赖图几乎覆盖全部测试文件。实测 `node scripts/run-tests.mjs related --run packages/shared/src/browser/net-rules.ts` 选中了 148/148 个文件，等同全量。
- `pnpm typecheck` / `pnpm lint` 较快，可在交付前整体跑；迭代中可用单包 typecheck。

## 模拟模型服务（packages/testkit）

测试中不调用真实模型。`testkit` 提供一个本地 HTTP 服务，实现 **OpenAI 兼容的 Chat Completions 接口**（流式 SSE，支持 tool calls），通过 pi 的自定义 `baseUrl` 接入。

### 场景脚本

```ts
const llm = await startMockLlm();
llm.script('mock-main', [
  step().expect(req => req.lastUserText().includes('帮我'))
        .replyToolCall('send_message', { text: '收到' }),
  step().replyText('完成了'),
]);
llm.script('mock-light', [
  step().replySubmit({ decision: 'respond', confidence: 0.9, reason: '...' }),
]);
```

能力要求：

- **按模型 id 分别编排**：`mock-main`、`mock-light` 等，互不干扰，便于同时测试响应 loop 与后台 loop。
- **断言请求内容**：每个步骤可以检查收到的请求（系统提示词、消息、工具列表），不匹配时测试失败并打印差异。
- **记录全部请求**：测试结束后可以检查“某段内容是否出现在发给模型的请求中”（例如 API key 绝不出现）。
- **可控延迟与闸门**：`step().hold()` 让响应挂起，直到测试调用 `release()`；用于测试执行中注入、取消、租约等待。
- **错误注入**：返回 401、429、500、中途断流。
  `failWith` 默认带 `x-should-retry: false`，引擎的模型请求重试（`packages/core/src/agent/model-retry.ts`）不会重试，脚本失败即失败；要测重试路径传 `{ retryable: true }`（可带 `Retry-After` 等 headers），并用 `KEPCUP_MODEL_RETRY_BASE_DELAY_MS` 压短退避。
- **usage**：每个响应返回可配置的 token 用量，用于测试用量账本。
- 未编排的请求直接失败，避免测试静默通过。

### 对话轮与任务的剧本（D75）

D75 后一条用户消息先跑**对话轮**（只读、工具面小），需要动手的工作在对话轮派出的**任务**里跑；两者共用同一个模型脚本时按请求区分：

- `step().inTurn()` / `step().inTask()`：步骤只匹配对话轮 / 任务的请求（`isTaskRequest`：请求消息里含 `<task_brief` 即任务）；两条 lane 可在同一个脚本上任意交错，`expect(...)` 与 lane 条件叠加。
- `viaTask({ taskSteps, title?, instruction?, writes?, sourceMessageIds?, ack?, relay? })`（`packages/testkit/src/helpers.ts`）：把旧的「回复 run 里干活」改写为「对话轮 `start_task` + 确认 → 任务跑 `taskSteps` → 结果唤醒对话轮转述（`relay`）」。任务以空结果结束（`skip_reply` / 失败不跟进）或测试自己编排唤醒轮时省略 `relay`。e2e 同样用它迁移（`browser` / `projects` / `environment` / `sandbox` / `approvals` 等 spec；`approvals.spec` 的访问审批由只读任务的 `read` 发起——对话轮越界读当场失败、不等审批，修复批 D M4：原先在回复 run 里做的工作改在任务里做；只读浏览器任务除下载用例外都设 `writes:false`；改动摘要卡来自写任务）；`projects.spec` 的租约用例改为「排在另一对话的写任务之后、在其任务卡上取消后执行」（DEV-015）。
- 迁移旧用例的判断：写文件、命令、浏览器、媒体、MCP、审批 / 授权、环境安装都必须在任务里断言（对话轮会被网关拒为 `RUN_READ_ONLY` 或根本没有该工具）；「执行中追加消息」改为断言下一个对话轮收到合并批，或断言 `inject_task` 进了任务。
- D75 主要用例：`supervisor-turns`、`supervisor-review-fixes`、`tasks`、`tasks-review-fixes`、`tasks-agent-review-fixes`、`tasks-review-fixes-e`、`tasks-review-fixes-f`（最终审查：等用户时被取消的写任务立即放租约、投递计数与持有）、`task-cards`、`task-subagent-read-only`、`task-timeline-visibility`（多 Bot 泄露契约）、`workspace-lease`、`external-agent-tasks`（集成）；`supervisor-turn`、`scheduler`、`gateway-read-only`、`turn-tools-review-fixes`、`messages-task-events`、`runs-tasks`、`task-timeline-render`、`agent-sessions-per-task`、`task-events-migration`、`usage-turn-migration`、`untrusted-lines`（`<untrusted>` 中和与归属）（单元）；e2e `tasks.spec.ts`。

### 测试夹具

- `createTestHome()`：创建临时数据目录，设置 `KEPCUP_HOME`，测试结束删除。
- 钥匙串：`NODE_ENV=test` 且 `KEPCUP_KEYSTORE=memory` 时使用内存实现；**非测试环境下该变量无效**，启动时检测到则拒绝启动。
- `createCore(options)`：在测试进程内启动核心服务（不经过 Electron 主进程），返回可直接调用的 RPC 客户端与事件监听器。D73 起的注入点 `shellRpc` / `oauthLoopbackAllowlist` / `oauthCimdUrl` / `oauthCallbackPorts` / `oauthFlowTimeoutMs` 见下文「假授权 + MCP 服务器与连接应用测试」。
- 工厂函数：`makeBot()`、`makeGroup()`、`sendBatch()`、`waitForRun()`、`waitForEvent()`。

### 假授权 + MCP 服务器与连接应用测试（D73）

连接应用（OAuth）的所有测试只用 testkit 的**假服务**，不访问真实网络（真实平台验证放在手工项里，见下）。

**`startFakeOAuthMcpServer(options)`**（`packages/testkit/src/fake-oauth-mcp-server.ts`）：一个 `127.0.0.1` 随机端口的 HTTP 服务，同时是 MCP Streamable HTTP 资源服务器（`@modelcontextprotocol/sdk` server，`/mcp`，RFC 9728 元数据，Bearer 校验含 audience 与逐工具 scope，工具列表可运行中修改并发 `list_changed`）和 OAuth 授权服务器（RFC 8414 / OIDC 发现、CIMD、DCR、预注册客户端、**无 UI** 的 `/authorize`、带 PKCE 的 `/token`、RFC 7009 `/revoke`）。真实服务器会变化的行为都是 `configure()` 可在运行中切换的开关：`discovery`（oauth / oidc / both / none）、`cimdSupported`、`dcrEnabled`、`issMode`（correct / omit / wrong）与 `authorizeError`、`redirectMatch`（exact / loopback）、`requireResource`、`rotateRefreshTokens`、`issueRefreshToken`、`expiresIn`、`grantScope`、`revokeStatus` 等。辅助：

- 令牌：`issueToken()`（绕过流程直接签发，Vault 种子用）、`expireToken()`（令牌仍在但过期 → 401）、`revokeToken()` / `revokeAllTokens()`、`isAccessTokenValid()` / `isRefreshTokenValid()`、`failToken()`（注入 `invalid_grant` 等）。
- 记录（断言用，`resetRecords()` 清空）：`requests`、`authorizeRequests`（含 `clientSource`：preregistered / dcr / cimd 与 `outcome`）、`tokenRequests`、`revokeRequests`、`registrations`（DCR 收到的 `application_type` / `redirect_uris`）、`cimdFetches`、`mcpRequests`、`toolCalls`。
- `simulateBrowser(url)`：替代系统浏览器——GET 授权 URL、跟随一次 302 到 KepCup 的本机回调服务，返回回调页的状态与正文。
- CIMD：`file-server.ts` 的 `publishCimdDocument(server)` 在测试文件服务上托管一份自引用的 CIMD 文档，返回的 URL 即 `client_id`（传给 `oauthCimdUrl`）。

自测在 `packages/testkit/test/fake-oauth-mcp-server.test.ts`（每个开关一个用例）。P2 增开关 `registerGate`（`/register` 记录注册后、应答前等待一个 promise，用来在客户端 DCR 往返途中动手脚，如并发保存自带客户端）。`packages/testkit/src/mcpb-fixture.ts`（`buildZip` 手写 ZIP、`buildMcpbFixture` 生成含 node 回声 MCP server 的 `.mcpb`、`defaultMcpbManifest`）供 MCPB 单测 / 集成测试用，不依赖外部打包工具。

**`CoreServicesOptions` 新注入点**（`createCore` / `createTestStack` / `createTestCore` 透传；`oauth*` 只在 `NODE_ENV=test` 且打包产物含测试钩子时生效——`__KEPCUP_TEST_HOOKS__` 在发布构建里折叠为 `false`，生产恒为常量 / 空）：

| 选项 | 作用 |
|---|---|
| `shellRpc` | 替换主进程 `shell.openExternal`（core 侧 `services.shellRpc.bindFacade`，优先于端口 B 客户端）。测试里记录调用并接 `simulateBrowser`；断言「run 中从不打开浏览器」就是断言它没被调用 |
| `oauthLoopbackAllowlist` | 允许 OAuth 发现 / 令牌 / 吊销请求访问的额外回环主机（`['127.0.0.1']`）；生产恒为空 |
| `oauthCimdUrl` | 覆盖 CIMD `client_id`（http 的测试文件服务 URL）；生产恒为 `KEPCUP_OAUTH_CLIENT_ID`，且非测试环境要求 https |
| `oauthCallbackPorts` | 回调服务的固定候选端口（并行用例各取空闲端口，避免争用） |
| `oauthFlowTimeoutMs` | 交互流程总时限（超时用例用小值） |
| `toolLockTrustFirstList` | D73 P1 工具定义锁定：首次见到的工具直接批准（行为同存量基线），**定义变化仍锁定**。`createTestCore` / `createTestStack` 默认 `true`，使经 `settings.update` 加 MCP server 的既有用例不必逐个批准工具；验证真实默认（新 server 的工具未批准前不暴露）的用例显式传 `false`（`integration/app-tool-lock.test.ts`）。同样只在 `NODE_ENV=test` 且含测试钩子的构建里生效 |
| `oauthPreregisteredClients` | D73 P2 预注册客户端表（形态同 `oauth-clients.json`：`{ [clientRef]: { issuer, clientId, clientSecret? } }`），替换文件 / 构建注入值；同样只在测试钩子构建里生效 |
| `mcpbRuntimes` | D73 P2 MCPB 的托管运行时（`{ node: { command: process.execPath } }`），绕过环境管理器；缺省时走真实的 `envManagerRuntimeResolver`（测试环境里即「运行时缺失」路径）。仅测试钩子构建生效 |

**用例分布（D73 P0，228 例 / 20 文件）**：`packages/shared/test/unit/`（`connected-apps.test.ts` 类型 / RPC / 事件契约，`cimd-document.test.ts` 读 `infra/cloudflare/oauth-cimd/public/oauth/client.json`）；`packages/core/test/unit/`（`app-connections-migration` / `connection-store` / `token-vault` / `secrets-redact` / `oauth-callback-server` / `oauth-safe-fetch` / `oauth-connect-flow`（CIMD、DCR、手填、`iss` / `state` / `Host` 伪造、端口回落、PKCE、拒绝、超时、取消、去重、私网拒绝）/ `runtime-provider` / `mcp-auth-transport`（锁定 pi-mcp 的真实传输层行为）/ `mcp-service-auth` / `mcp-tools-auth`）；`packages/core/test/security/connected-apps-tokens.test.ts`（完整连接—调用—刷新—过期—重连—断开之后扫描 `runs.db`、`audit_log`、日志、全部 RPC 返回与事件，令牌零明文）；`packages/core/test/integration/`（`oauth-connect-rpc`：RPC 链路 + 注入点 + `shell.openExternal` 门面；`connected-apps-runtime`：Bot 运行中刷新 / 失效 → SETUP_REQUIRED → `runs.retry`、`<connected_apps>`、断开与 `mcp.removeServer`、`settings.update` 改认证方式 / URL 时的断开；`connected-apps-e2e`：**P0 门禁的自动化部分**，CIMD / DCR / 手填三条注册路径各走一遍真实交互流程 → Bot 调用 → 强制过期 + 透明刷新 → `apps.disconnect` 吊销 → 工具不可用）；`apps/desktop/src/main/shell-methods.test.ts`（URL 白名单）与渲染端 `features/apps/connect-flow.test.ts`。

**用例分布（D73 P1）**：后端（`553fd03`）——`packages/core/test/unit/`（`connector-catalog`〔包装 `test/contract/connector-catalog.contract.ts`：每条目 schema / slug / 图标 / https / `toolPolicy` / `releaseGate`〕、`connector-spike-probe`、`app-tools-migration`、`app-policy`（W5 结果 × 目录覆盖表驱动、`toolDefinitionHash`）、`app-naming`、`tool-lock`、`app-tool-grants`、`app-tool-gateway`（`durations` / grant 命中）、`app-exposure`、`app-prompt-capabilities`、`catalog-connect-units`、`oauth-connect-flow` 增目录目标 / `reviewing_tools` / 去重并入 `grantBotId` 与 `ending` 守卫 / 显式 scopes 旧 ∪ 新）；`packages/core/test/integration/`（`catalog-connect`：目录连接、多账号、账号识别、`connectionId` 重新授权与 scope 并集、`grantBotId` 由 core 写入、两 Bot 共享一个流程；`catalog-connections-rpc`；`app-tool-lock`（显式 `toolLockTrustFirstList:false`）；`app-recovery`；`bot-app-connections`；`app-approvals`；`app-tool-grants-lifecycle`；`app-exposure-e2e` / `app-tools-e2e`）；`packages/core/test/security/catalog-connect-tokens.test.ts`。**P1 门禁的自动化部分**：`integration/connected-apps-p1-gate.test.ts`（端到端：`app_request_connection` → `connect-app` 卡 → 目录连接带 `grantBotId` → `simulateBrowser`〔DCR〕→ `reviewing_tools` 带账号标签 → `confirmTools` → Bot 获授权 → `runs.retry` → 写工具 `mcp_tool` 卡〔`connectionId` / `connectorSlug` / `accountLabel` / `risk` / `durations`〕→ 选 `bot` → grant → 第二个对话免卡 → 断开级联，令牌零明文；风险档：只读免卡、写三种时长、缺注解 → 破坏性仅 `once` 且 `bot` 降级、目录 `toolPolicy` 调高、无人值守全自动并审计；工具锁定：改描述 → `tools_changed` → 工具消失 → `reviewTools` → 恢复、新工具复核前隐藏、无 OAuth 自定义 server 经 `mcp.test` `toolHashes` + `approveAfterTest`）与 `connected-apps-p1-gate-acp.test.ts`（勾选 `apps` 包的外部智能体 Bot：桥 `tools/list` 的 `app_*` 带风险注解、名字 ≤64、提示词两段、经桥的审批卡一致；Bot 校验：同 connector 两账号 `INVALID_INPUT`、断开清所有 Bot 勾选、`bots.delete` 撤销授权、与内置同名的外部工具被丢弃并告警）。渲染端 `features/apps/{connect-flow,app-catalog,app-tools}.test.ts`、`features/bot-panel/bot-apps.test.ts`、`features/settings/sections.test.ts`（分区别名 / 页签解析）。2026-10-10 定向回归：core D73 相关 45 文件 517 例 + 安全用例、渲染端 13 文件 111 例，全绿。

**用例分布（D73 P2）**（例数为静态计数——测试文件里 `it(` / `test(` 出现次数——以实际运行为准）：`packages/core/test/unit/`——`app-step-up-discovery`（16：`AppStepUpLimiter` 每窗口一张 / `isAvailable` 不占名额而 `tryAcquire` 占 / 仅带连接 id 的 scope 需求计数 / `null` 对话独立桶；`wrapMcpTool` 被拒卡时为普通失败；服务端文本不能闭合 `<untrusted>`；`appToolsDeferred` 严格大于阈值与提示词措辞；`app_search_tools` 排序 / 过滤 / 截断 / 说明不能闭合边界；`app_call_tool` 参数校验与分发、`originOf` 供台账分级；`buildAppTools`）、`egress-migration`（3：0026 升级保留旧行并可写 `egress`、CHECK 带全 kind 且仍拒绝未知值、`app_taint` 主键与非空）、`taint-egress`（21：`TaintService` 置位 / 续期 / 过期与开关、群聊对话级判定、`inherit`、生命周期清理；网关对应用 / 自定义 MCP 工具的 `egress`〔持续授权与 `auto` 策略失效、只读与 `openWorldHint:false` 不算通道、自定义读工具显式 `openWorldHint:true` 算、关开关 / 24 小时后不弹、拒绝抛 `APPROVAL_DENIED`、会弹 `mcp_tool` 卡的只出一张带污点标记与完整参数、`egress` 卡只有一次且不写 grant〕；`egressCheck` 截断与对话轮不等待；`web_fetch` / `web_search`、沙箱 `bash`〔网络 `open`、allowlist / none、只读白名单命令、确认模式只加标记〕、`git_remote` 提示、`watch_create`）、`browser-tools-taint`（5：`browser_open` 完整 URL、点击角色白名单外一律问并列出已输入内容〔密码遮蔽〕、Enter、无闸门时不问）、`permission-bridge-taint`（3：ACP 桥 fetch 类与自动放行命令降为逐次 `egress`，只读白名单命令仍放行）、`mcpb`（30：manifest 解析 / 兼容性 / 启动命令渲染与敏感值只能是整值 / `user_config` 校验；归档安全〔zip-slip、绝对与反斜杠与符号链接、重复路径、缺清单或入口、CRC 损坏〕；安装 / 卸载〔sha256 与检视不符、运行时缺失与不兼容的可读错误、binary 直接运行、共享目录、目录来源不带 developer 档且须匹配固定 sha256、审批载荷含完整命令且拒绝即不安装〕；复查加固〔伪造 `compressedSize` 为 `MCPB_INVALID` 而非进程中止、文件大小上限先于哈希、Windows 设备名 / 冒号 / 尾随点或空格、`command` 不得依赖 `user_config`、快照与暂存文件不残留、目录名小写化、标记不符时重新解包、文件权限位、审计只含包标识、畸形 `source` 被 schema 丢弃、只删标记匹配的目录〕）、`oauth-clients`（3：预注册表按 issuer 查找确定性与尾斜杠、缺项与 issuer 不符可区分、缺 `clientRef` 的目录条目停放在 `OAUTH_CLIENT_REQUIRED` 而不是 DCR / CIMD）、`mcp-policy`（12：W5 默认不变；开发者档只读也 `ask`、逐工具 / server 级放宽、`destructive` 不可放宽、停用工具仍停用；授权事件日志脱敏〔只留 `scheme://host/path`、JSON / 冒号形态 / Bearer / JWT / 长不透明串、注入的 `redact`〕、server 数 LRU 与每 server 环形上限）。`packages/core/test/integration/`——`connected-apps-p2-stepup-discovery`（4：默认 scope → `insufficient_scope` → 一张 scope 卡 → 并集重连 → 重试成功，同对话再命中为普通失败、另一对话仍出卡；卡片被忽略后设置页式重连（不带 scopes）补上被挑战的 scope；超阈值只剩摘要 + 两个稳定工具、`app_call_tool` 走真实网关路径并拒绝停用 / 锁定 / 未知工具；阈值内不变）、`connected-apps-p2-discovery-acp`（1：桥 `tools/list` 为两个发现工具、提示词随决定、`app_call_tool` 出真实工具卡）、`connected-apps-p2-egress`（3：读取应用数据后 `web_fetch` / 应用写工具 / `web_search` / 浏览器各出 `egress` 卡、`runs.retry` 继承、别的对话干净、关开关、无人值守审计与 `apps.egressSummary`；同一任务链里相同的污点浏览器点击是普通逐次卡〔不触发重复效果门〕且无人值守仍自动批准；污点随委派传到 B 的私聊、B 的污点随结果回到 A）、`mcpb`（5：经 RPC 安装 → `McpService` 调用其工具 → 干净卸载；`settings.update` 删除也清解包目录；文件被替换〔sha256 不符〕与不兼容包被拒；对话发起的安装出 `environment` 卡含完整命令；无人值守按 D41 自动批准该卡〔锁定已知隐患，见 DEV-021 第 5 项〕）、`oauth-clients`（11：预注册公开 PKCE 客户端端到端且不走 DCR、表里的非保密 secret 送到令牌端点、issuer 不符失败且不回退、BYO 仍能解析 issuer 不符的预注册条目、无法解析 `clientRef` 的条目不可连接并给原因；BYO 增改删与 secret 不外泄 / 连接占用时拒删、BYO 压过预注册表；输入校验；DCR 往返途中保存 BYO 不被覆盖、issuer 规范化、`clearSecret` 与换 client id 清 secret）、`developer-mode`（7：开关默认关且 `settings.update` 可写、保留 core 自有字段；授权事件日志脱敏〔无令牌 / code / state / 查询值〕、server 移除清日志、按 server 隔离且仅内存、失败只留错误码与文案；`mcp.rawTools` 含注解、`mcp.refreshTools` 重新列出且工具锁定仍生效、开关关闭也可刷新、未知 server 被拒）。渲染端 `features/settings/mcpb-install.test.ts`（6：表单默认值 / 缺必填项 / 类型化 `userConfig` / 提交后只清敏感项 / 安装按钮门控 / 体积格式化）。另有既有测试因迁移号 / 注入点的小改（`create-core`、`app-tools-e2e`、`tool-lock`、`public-skills-migration`、`catalog-connect-env`）。**P2 门禁的自动化部分**：step-up / 污点 / 按需发现三组集成测试，MCPB 示例包（testkit 生成）的安装与调用，协议版本结论见 todo 附录 B.6；预注册客户端条目的真实平台走通依赖 U3 / U4，不在自动化范围。独立评审（MCPB / OAuth 客户端 / 开发者模式；污点 / step-up / 按需发现各一组）的发现均已修复并各带回归测试，列表见 PROGRESS「连接应用 P2」。**全量回归：2912 通过 / 28 失败（Docker kepcup-test:trixie）——其中 26 例为沙箱 / es-git / wiki 环境基线（sandbox-isolation、toolchain-sandbox、environment、projects、skills、skills-authoring、wiki-url、workspace-tools），另 agents-service、memory 各 1 例为负载下的偶发失败，单跑均通过；pnpm typecheck、pnpm lint 通过**

**真机项（用户待办 U1，不在自动化里）**：部署 `infra/cloudflare/oauth-cimd`（见该目录 README）后运行 `node infra/cloudflare/oauth-cimd/verify.mjs` 对线上 `https://kepcup.com/oauth/client.json` 做检查；再用 Notion 或 Linear 的官方 MCP 以「自定义」方式手工走通一次（连接 → 调用 → 过期重连 → 断开），结果记 PROGRESS。开发会话不代为登录。**P1 的真机项（用户待办 U2）**：提供首批应用的测试账号 → 用 P0 引擎完整连接一次（带登录的 spike），导出工具清单、注解覆盖率与账号识别可行性 → 补 `catalog.json` 的 `toolPolicy` / `whoami` / `scopes` → 通过者加入 `apps/desktop/connector-release-gates.json`。门禁打开前目录条目不会出现在发布构建里。

## 原生模块

better-sqlite3-multiple-ciphers、`@napi-rs/keyring`、es-git 等原生模块需要同时在 Electron（核心服务运行于 `utilityProcess`）与测试中加载。

- 原生模块按 **Electron 的 ABI** 编译（`electron-builder install-app-deps` 或 `@electron/rebuild`，在 `postinstall` 中执行）。
- 需要加载原生模块的测试，**用 Electron 作为 Node 运行 vitest**：`ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run`。根目录提供 `pnpm test` 脚本封装。
- 不依赖原生模块的纯单元测试（例如 `packages/shared`）可以用普通 Node 运行。
- P00 必须验证以上方案在三个平台上可行；不可行时按 [README.md](README.md#偏差与问题) 记录。

## 安全用例集

`packages/core/test/security/` 维护一组**每个阶段都必须继续通过**的用例，随阶段补充：

| 用例 | 引入阶段 |
|---|---|
| API key 明文不出现在：日志文件、runs.db（解密后检索）、发给界面的任何 RPC 返回与事件、发给模型的请求 | P01 |
| 数据库文件无法用不带密钥的 SQLite 打开 | P00 |
| 沙箱内读取 `~/.ssh`、`~/.aws`、`~/.kepcup/main.db` 失败 | P02 |
| 沙箱内写入 workspace 以外的路径失败 | P02 |
| workspace 中指向外部的符号链接，经文件工具读取被拒绝 | P02 |
| 沙箱内访问内网地址与 `169.254.169.254` 失败（所有网络模式） | P02 |
| 同一 Bot 的两个对话，workspace 互相不可访问 | P02 |
| 沙箱初始化失败时命令不会在沙箱外执行（除非经逐条确认） | P02 / P03 |
| 未授权路径经文件工具访问时触发审批，拒绝后不可访问 | P03 |
| 授权只对申请的 Bot 与对话生效 | P03 |
| 无人值守模式下 `~/.kepcup` 仍不可访问 | P03 |
| 其他 Bot 的发言、工具输出中的“指令”不会导致记忆或画像写入（画像证据必须来自用户消息） | P07 |
| 已删除 Bot 的数据目录不存在，id 未被新 Bot 复用 | P01 |

## 本机容器运行（Linux 开发机）

开发机 glibc 2.35 加载不了 es-git 预编译绑定（需 ≥ 2.38），大部分集成测试在宿主上直接失败。单元 / 集成测试在 Debian 13 镜像 `kepcup-test:trixie` 里跑，e2e 用派生镜像 `kepcup-test:trixie-xvfb`：

```bash
docker run --rm -v "$WT:$WT" -v "$NODE_DIR:$NODE_DIR:ro" -w "$WT" --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/home -e CI=1 -e PATH="$NODE_DIR/bin:/usr/bin:/bin" \
  kepcup-test:trixie bash -c "mkdir -p /tmp/home && node scripts/run-tests.mjs run [文件或目录]"
```

- 容器里**只用** `node scripts/run-tests.mjs run …`；不要在容器里跑 `pnpm test` / `pnpm install`（会触发依赖检查、重装并破坏 worktree 的 `node_modules`）。typecheck / lint 在宿主跑（`pnpm -r typecheck`、`pnpm lint`），Node 24 需先放进 `PATH`（系统默认 node 版本过旧）。
- `packages/core/test/integration/projects.test.ts` 已按 D75 重写，容器里约 18 s；其中「allows localhost ports … (OS sandbox)」一条依赖系统沙箱，容器里按基线失败。
- 宿主 `timeout` 只杀 docker 客户端、杀不掉容器：需要硬超时就给容器起名（`--name`），另起一个 `sleep N; docker kill <名>` 的看门狗。
- vitest `--outputFile`（如 `--reporter=json --outputFile=…`）必须写在 worktree 内：容器里的 `/tmp` 不挂载到宿主。
- **基线**（`d75@7138daf`，2026-10-08）：全量 1559 例中 33 条失败，全部是容器环境原因（沙箱自检 / bwrap / socat / 外网：`sandbox-isolation` 10、`projects` 6、`skills-authoring` 4、`env-distro-toolchain` 3、`skills` 3、`workspace-tools` 3、`toolchain-sandbox` 2、`wiki-url` 2），逐条清单见 `todo/supervisor-and-tasks.md` §6。判定标准是「失败集合不超出基线」，不是全绿；偶发负载超时（`web-tools`、`memory`「两个 Bot 同时产生画像提案」、`agents-service` 登录状态）单跑复核。D75 收口时（W3 后）全量 1755 例、33 条失败，除 `approvals` 一条（已由 `26e15f2` 修正）外均在基线集合内；`projects` 的「blocks switching projects while a bot is executing」已转为通过。
- **e2e**：在 `kepcup-test:trixie-xvfb` 中先 `npx electron-vite build`（产出 `apps/desktop/out`），再在 `apps/desktop` 下 `xvfb-run node ../../node_modules/@playwright/test/cli.js test …`（容器加 `--shm-size=1g`）。D75 W3 后全量 70 例、3 例失败（`browser.spec`「删除 Bot 后其浏览器分区数据不存在」、`sandbox.spec`「run status line shows the command description while a command executes」、`wiki.spec`「wiki tab: browse the page tree …」），与 main 上的失败一致。

## CI 矩阵

| 任务 | macOS（arm64） | Ubuntu 24.04（x64） | Windows（x64） |
|---|---|---|---|
| lint、类型检查、svelte-check | — | ✓ | — |
| 单元与集成测试 | ✓ | ✓ | ✓ |
| 沙箱测试 | ✓ | ✓（需先 `sysctl …userns=0`，并安装 `bubblewrap` / `socat` / `ripgrep`；应用自带 `resources/bin/linux-*/rg`，srt 初始化须把该路径写入 `ripgrep` 配置） | P12 起（WSL2 需自建运行器，否则手工验证） |
| 端到端测试 | ✓ | ✓（`xvfb-run`） | ✓ |
| 打包冒烟 | P13 | P13 | P13 |

- CI 配置写在 `.github/workflows/`；仓库托管在其他平台时按同等内容改写。
- 端到端测试从 P01 开始加入 CI。

## 端到端测试约定

- 启动应用时设置：`KEPCUP_HOME`（临时目录）、`NODE_ENV=test`、`KEPCUP_KEYSTORE=memory`、`KEPCUP_MOCK_LLM_URL`（模拟模型服务地址，启动时自动配置为一个厂商）。
- 界面元素使用 `data-testid` 定位，命名形如 `composer-input`、`draft-queue-item`、`approval-card-approve`。
- 每个阶段的验收标准中凡是界面行为的，都要有对应的端到端测试。
- 外部智能体（D72 P6，`external-agents.spec.ts`）：设置 `KEPCUP_FAKE_ACP_AGENT_BIN`（testkit `FAKE_ACP_AGENT_BIN`）+ `KEPCUP_FAKE_ACP_AGENT_SCRIPT`（`writeFakeAgentScript` 写的剧本）[+ `KEPCUP_FAKE_ACP_AGENT_RECORD`（`readFakeAgentRecord` 读）]，core 让目录的 `fake` 与额外的 `fake-sub`（订阅登录，onboarding 分支用）条目以 Electron 的 Node 运行 testkit 假 Agent（仅测试构建，打包产物剔除）；不设 `KEPCUP_MOCK_LLM_URL`（置空）即「只有智能体」的新用户。剧本的回合按 prompt 依次消耗：对话以外的后台任务会占用回合，用例先在设置「后台任务」里关闭。

### 外部智能体的真机项（D72）

- Provider 契约测试（`packages/core/test/contract/`）用假 Agent 剧本覆盖各家差异；真实 Agent 的行为由 `packages/core/scripts/agent-spike/` 的 spike 脚本在**用户登录后**手动执行（README「需要用户登录后再跑的步骤」），开发会话不代为登录、不读取任何凭据文件。
- 原生优先遵守度回归（P6）：`node packages/core/scripts/agent-spike/adherence.mjs --runs 10`，结果表贴进设计 28 §9.2。措辞 fixture 由 `native-first-wording.test.ts` 守护（产品措辞变动即失败，`KEPCUP_UPDATE_WORDING=1` 重新生成，之后须重跑真机遵守度）。

## 手工冒烟清单（真实模型）

每个阶段结束时，用至少一个真实厂商（建议 Anthropic 或 OpenAI 各一个）执行本阶段新增的冒烟步骤，结果写入 PROGRESS.md。通用步骤：

1. 在设置中配置 API key，重启应用后仍有效。
2. 新建 Bot，发送消息，收到符合人设的回复。
3. 让 Bot 做一件耗时的事（派出任务、出现任务卡），任务进行中追加消息：Bot 立即在新的对话轮里回应，并把追加的要求转给任务（任务卡出现追加行）或另起任务；任务结束后 Bot 转述结果。
4. 在任务卡上取消任务，界面状态正确（卡片转「已取消」、附改动摘要，不再唤醒 Bot）。
