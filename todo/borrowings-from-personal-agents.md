# 从三个开源 Personal Agent 借鉴：实施方案

> 状态：**已定稿，待实施**（2026-10-09；Pengfei 已对全部待决问题拍板，结论已写进各工作项，见各节「已定」标注）。D 编号已确认（§6）。
> **提交约定**：原硬约束为“只改工作树、不 commit”；2026-10-09 用户授权提交（P0 已分批提交）。仍**不 push、不开 PR**（除非用户另行要求）。每个工作项完成后在本文件对应 `- [ ]` 打勾并写一行完成日期。
> **范围调整（2026-10-09 用户决定）**：P1 只做 W3-P1 与 W6（W4、W8 暂缓）；W6 委派结果取“各任务结果摘要拼接”；原 W9（记忆导出 / 历史 / 导入）**确定不做，已从本文件删除**；W7 **延期**。
> **测试纪律**（AGENTS.md / `docs/dev/05-testing.md`）：开发中**只跑定向测试**（本文件每项都给了命令）；全量 `pnpm test` 只在阶段收尾/交付时跑**一次**，或改了共享契约（`packages/shared` schema）、testkit、迁移、vitest 配置时跑一次。不要反复全量。
> Mac 上 PATH 里的 node 是 v12，先 `export PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH`；改了 `packages/shared` 后先重建 `packages/shared/dist`。

---
## 0. 先读什么

实施任何一项前，先读：

1. `docs/design/02-execution.md`（D75 对话轮 / 任务分治、崩溃恢复顺序）、`docs/design/30-*`（任务、`ask_user`）。
2. `docs/design/24-durable-execution.md` §replay 分类（D67：`safe` / `idempotent` / `unsafe`，**未实现**）——W2 是它的第一步。
3. `docs/design/23-*`（D65 MCP）与 `docs/design/29-*` §风险分级（D73 计划的 `classifyRisk`，约 257 行起）——W5 提前落地这一块。
4. `docs/design/27-*`（D70/D71 Butler 与委派；**文件头“尚未实现”已过时**，代码已落地，见 §3.6）与 `docs/dev/DEVIATIONS.md` DEV-012。
5. `todo/sensors.md`（D76；本轮只维持麦克风能力，W7 不接传感器）。语音 `docs/design/26-voice-input.md`（D69）仅作背景，语音对话模式本轮不立项。
6. 本文件 §3 的现状地图——每项要改的代码位置都列在那里，**以代码为准**，文档与代码冲突时先核实代码。

## 1. 背景与目标

### 1.1 来源

公众号「逛逛GitHub」文章《3 个最近爆火的 Personal Agent，在 GitHub 上有开源平替了》介绍了三个项目。我们把源码拉到固定 commit 逐文件读过，本方案引用的上游细节都标了路径：

| 项目 | 仓库 | 读过的 commit | 定位 |
|---|---|---|---|
| Rakazo | https://github.com/elie222/rakazo | `8d3fedb63725ac1f896a8009484bf75fcd1ba7ac` | 多 Bot 个人助理（自托管服务 + 容器“电脑”），Bot 间消息、浏览器、审批、记忆 |
| OpenMuse | https://github.com/CopilotKit/openmuse | `1ac68f3909f2478ab6280883f1ab5ea65eb5719d` | 后台监看 / 任务引擎，确定性页面 diff、动作提案审批 |
| OpenDots | https://github.com/CopilotKit/OpenDots | `625452e06cde74cb25b0ce319e2c1be0488f5a5f` | 连接应用 + 页面 + 实时语音前端 |

上游关键文件（下文以 `[R]` `[M]` `[D]` 简称项目）：

- [R] `packages/adapters/src/builtin-tools.ts`（`message_bot` / `handoff_to_bot` / `run_subagent`）、`packages/core/src/bot-messages.ts`（intent、hop、唤醒提示）、`packages/adapters/src/bot-messages.ts`（`deliveryKey` 去重、`auto-outcome:{runId}` 自动回传）
- [R] `infra/sandboxes/computer/rakazo-page-browser`（CDP 助手：isolated world、`isConnected`/可见/禁用校验、80 元素、密码值省略、`act` 1–24 步、`uncertain`）、`packages/adapters/src/computer-browser.ts`、`browser-tools.ts`（“Do not replay completed or uncertain actions”、`fill_secret`）、`computer-tools.ts`（`MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS = 3`、同帧替换为 “previous screenshot remains valid”）
- [R] `packages/adapters/src/approval-effect.ts`（effect 状态机 intended→approved→executing→completed/denied/uncertain、`resolveDuplicateEffectGate`）、`packages/core/src/approval-effect-key.ts`（`stableJsonValue`，key = `runId:tool:sha256(args)[:occurrence]`）
- [R] `packages/core/src/action-approval.ts`（READ_ONLY / MUTATING / COMPOUND 动词正则、`connectorToolRequiresApproval`：声明只读不能放宽名字判定；规则优先级 tool > connector > category）
- [R] `packages/memory/src/index.ts`（`MarkdownMemoryStore`：documents + revisions、`expectedRevision` 冲突、`exportMarkdown`/`importMarkdown`）
- [M] `apps/server/src/engine/page-diff.ts`（`pageLines` / `withoutRelativeTimes` / `diffPage` / `describePageDiff`）、`apps/server/src/engine/service.ts` `observe()`（约 1080–1190 行：hash + 去时间 hash、边沿触发、`alertSequence`、通知键 `monitor:{id}:{seq}:{hash}`、CAS、`LostLeaseError`；约 828 行失败路径：退避 `min(60, 2^failures)` 分钟、5 次暂停、通知键 `watch-error:{task}:{streak}:{paused|retry}`）
- [M] `apps/server/src/actions.ts`（`ActionService.propose`：idempotencyKey→sha256 id、proposal hash 覆盖 input+connection+target、30 分钟过期；`decide(id, hash, decision)` hash 不符 409；结果 `succeeded / failed / outcome_unknown` + 活动回执）
- [D] `src/server/connections.ts` 约 188 行（`readOnly = annotations.readOnlyHint===true`；`requiresApproval = prior ?? !readOnly`；逐工具覆盖在刷新后保留）、`src/server/connection-tools.ts`（每次调用重新解析工具）、`src/server/pages.ts` `createReviewed`（`page_reviews(threadId, toolCallId)`：同草稿返回已有、不同则 409）、`src/server/store.ts`（租约过期 / 设置变化 → interrupted，“Review completed effects before retrying”）、`src/client/TaskActions.tsx`（Retry after review）、`src/server/voice.ts`（实时语音 + `ask_compute`、每通话 6 次计算上限、turn 去重）

### 1.2 目标

把对比结论里的 **9 个借鉴点** 落成可交给编程 Agent 的工作项，同时把 **“不要学”清单** 固化为护栏（§5）。不追求功能对齐上游，只借**确定性、幂等、可审计**的那部分机制。

| # | 借鉴点 | 工作项 | 优先级 |
|---|---|---|---|
| 1 | Bot 间消息带 intent | W6（在 `delegate_to_bot` 上加 `intent`，不新增 `message_bot`） | P1 |
| 2 | 浏览器 `uncertain` 结果、不重放、及配套防护 | W1（+ W2 记账） | **P0** |
| 3 | MCP / 连接应用审批默认值（只读自动、动词正则） | W5（含只读 MCP 工具进对话轮；无人值守下 MCP 自动批准 + 风险提示） | **P0** |
| 4 | 草稿/审批幂等 + 精确审批卡 | W4（基于 W2） | P1 |
| 5 | 中断 → 检查后重试 | W3（基于 W2；含“运行中撤销授权 → 立即中断”） | P0/P1 |
| 6 | 监看：去重 + 退避 | W7（本轮只做网页来源）——**延期** | P2 |
| 7 | Team / Private 电脑 → 浏览器资料与接管 | W8（自动接管租约 + 显式共享浏览器资料） | P1 |
| 9 | 语音前端 + 计算 Agent 配对 | —（**暂不立项**，只在 §4 记下分工原则） | — |

## 2. 实施顺序

```
P0:  W1 浏览器确定性 ──┐
     W5 MCP 风险分级 ──┤ (互相独立，可并行)
     W2 外部副作用台账 ─┴─→ W3 中断任务 (P0 部分：续接摘要标注“结果未知”)
P1:  W2 ─→ W3 (P1 部分：检查后重试面板 + 撤销授权立即中断)
     W2 ─→ W4 审批幂等与回执
     W6 Bot 间消息 intent + DEV-012 方案二   (独立；开工前确认 D75 已收尾)
     W1 ─→ W8 浏览器自动接管 + 共享浏览器资料
P2:  W7 监看原语（仅网页来源；W1 的后台页能力复用）——延期
```

粗略工作量（编程 Agent 人日，含定向测试，不含设计文档回写）：

| 工作项 | 量 | 说明 |
|---|---|---|
| W1 | 2–3 | 纯 core/desktop，无迁移；元素上限维持 150 |
| W2 | 2–3 | runs.db 一张新表 + 引擎钩子 |
| W3 | P0 0.5 / P1 2.5 | 摘要标注 / 重试面板 + `runs.retry` 扩展 + 撤销授权中断（+1） |
| W4 | 2 | 依赖 W2；无 approvals 表重建 |
| W5 | 2.5 | 分级器 + 逐工具策略 + 只读 MCP 进对话轮（+0.5）+ Bot 详情 MCP 区风险提示；无人值守不再新增拒绝逻辑 |
| W6 | 3 | DEV-012 方案二是大头；含 delegations 表重建 |
| W8 | 3.5 | 接管租约 1.5 + 共享浏览器资料 2 |
| W7 | 3.5–4 | 新服务 + 新表 + UI；不含传感器来源 |
| 合计 | 约 21–24（W9 已删除） | P0 ≈ 7.5–9；P1 ≈ 11（本轮只做 W3-P1 + W6 ≈ 5.5）；P2 = W7 ≈ 3.5–4（延期） |

## 3. 现状地图（以代码为准，2026-10-09 读取）

### 3.1 浏览器（借鉴点 2、7）

- `packages/core/src/tools/browser.ts`：9 个工具（`browser_open/snapshot/click/type/press/scroll/screenshot/back/close`）。每个动作先 `ensure()`，再 `resultWithSnapshot` 回一份新快照；错误经 `browserErrorHint` 映射 `BROWSER_BLOCKED / NAVIGATION_FAILED / REF_UNKNOWN / PAGE_CLOSED / UNAVAILABLE`。
  - **缺陷**：动作与快照在同一个 `try` 里，**动作成功但快照抛错**时返回 `asToolFailure`，模型会以为没点上而重试 → 副作用重复（重复提交、重复下单）。
  - 无 `uncertain` / `completed` 字段，无重复动作熔断；每次 `browser_screenshot` 都回全图。
  - `browser_type` 的 `text`（可能是密码）进工具参数、进 `run_steps`、进续接摘要。
- `apps/desktop/src/main/browser-host.ts`（755 行）：`BrowserHost`，partition `persist:bot-{botId}`（**已按 Bot 隔离资料**），页面键 `botId|conversationId`；`PageEntry.refs`（ref → backendNodeId）+ `refsValid`，`did-navigate` / `did-navigate-in-page` 时 `#invalidateDocumentState`；`#refNode` 抛 `BROWSER_REF_UNKNOWN`；`click` = `Runtime.callFunctionOn`（scrollIntoView + click）后 `#settle(5000)`；`type` = focus/select 后 `Input.insertText`。`show()` 打开可见查看窗口，**用户可与 run 同时操作，无独占**。页面权限全拒，网络拦截走 `decideBrowserRequest`；`clearBotData` 墓碑化。
  - ref 只在导航时失效；**同一文档内 DOM 变化（SPA 重渲染）后 backendNodeId 可能指向已脱离或已换内容的节点**，没有“元素还是不是那个元素”的校验。
- `packages/shared/src/browser/axtree.ts`：`buildSnapshotSummary`（交互角色、`maxElements`、`maxNameChars` 80）、`formatSnapshot`。**快照不含元素 value**（密码值已经不会出现）。
- `packages/shared/src/constants.ts`：`BROWSER_SNAPSHOT_MAX_ELEMENTS = 150`、`MAX_TEXT_CHARS = 4000`、视口 1280×800、`SCREENSHOT_MAX_BASE64 = 4e6`、`NAVIGATION_TIMEOUT = 30000`。
- `packages/shared/src/rpc/methods.ts` 约 1066 行 `browserSnapshotOutputSchema` 与各输入 schema；`apps/desktop/src/preload/index.ts:69`、`main/index.ts:249` `browser:show`；渲染端入口 `features/right-panel/show-browser.ts`（RightPanel / GroupInfo 两处按钮）。
- 测试：`packages/core/test/unit/browser-tools.test.ts`、`packages/core/test/integration/browser.test.ts`、`apps/desktop/test/e2e/browser.spec.ts`（browser-host 无单测）。

### 3.2 工具执行与记录（W2 / W3 的钩子）

- `packages/core/src/agent/tool-execution.ts` `executeToolSafely`：`runInToolCall` 作用域里执行，异常转失败结果。两个调用方：`agent/pi-engine.ts:85`（内置引擎）、`agent/external/mcp-bridge.ts:424`（ACP 外部智能体宿主桥）。
- `ToolContext` **没有 toolCallId**（pi 的 `execute(toolCallId, …)` 拿到了但没传下去）；`ToolResult = { ok, content, images?, errorCode?, terminate? }`。
- `run_steps`（runs.db 0002）：`type ∈ request/assistant/tool_call/tool_result/steer/progress/system`，`payload_json`；`agent/step-persistence.ts` 落 tool_call / tool_result。
- `packages/core/src/agent/context/continuation.ts` `buildRunDigest` / `renderStepLines`：**只有 tool_call、没有 tool_result 的步骤渲染成一行普通调用，不标“结果未知”**。
- runs.db 迁移到 0008；main.db 到 0020；memory 到 0002。**D73 已预定 main 0021 / runs 0009**（`todo/connected-apps.md`）——本方案新迁移取届时的下一个空号，见各项“迁移”。

### 3.3 任务与中断（借鉴点 5）

- `packages/core/src/dispatch/tasks.ts`（2020 行）`TaskHost.recover()`：已 started 无终态记录的任务补失败记录、状态 `interrupted`，文案“应用退出，任务中断”。`retry(taskId)` **只接受 `status==='failed'`**：建续接 run（`continuedFromRunIds`）、复用 brief、幂等。
- `apps/desktop/src/renderer/src/lib/features/tasks/task-view.ts:74`：`canRetry: task.state === 'failed' && task.setup === null && task.continuedByTaskId === null` → **中断任务没有重试按钮**。`TaskCard.svelte`（重试 / 取消 / 撤销）。
- 测试：`packages/core/test/integration/tasks*.test.ts`、`task-cards.test.ts`、`apps/desktop/src/renderer/src/lib/features/tasks/task-view.test.ts`、`apps/desktop/test/e2e/tasks.spec.ts`、`packages/core/test/unit/continuation.test.ts`。

### 3.4 审批（借鉴点 3、4）

- `packages/core/src/permissions/approvals.ts`（1436 行）：`NEVER_AUTO_DECIDED = ['butler_proposal']`；`SURVIVES_RUN = ['environment','butler_proposal']`；`request` / `submitNonBlocking` 查 `unattended.effective()`；`#autoDecideSync` 的数据目录底线只对 `command/unsandboxed/git_remote/agent_tool` 生效——**`mcp_tool` 在无人值守下无条件自动批准**。另有 `decide`、`cancelPendingForRun`、`describe`、`renderContextLine`（约 650 行 mcp_tool 分支）、`summary`。
- approvals 表（main 0016 重建版）：`payload_json` 创建后不变；`status ∈ pending/approved/denied/cancelled/failed`；`decision_json`；`auto_approved`。`kind` 有 CHECK 约束，**加 kind 要重建表**（照 0015/0016 写法、带上全部既有 kind：access, unsandboxed, command, git_remote, environment, skill_import, skill_preset, profile_change, mcp_tool, butler_proposal, agent_tool）。
- `packages/shared/src/rpc/methods.ts:740` `approvalsDecideInputSchema = { id, approve, duration?, selection? }`。
- `packages/core/src/permissions/grants.ts`：路径授权 once / conversation，`GRANT_ABSOLUTE_TTL_MS`；`tool-call-scope.ts` `runInToolCall`（AsyncLocalStorage）。
- 测试：`packages/core/test/integration/approvals.test.ts`、`apps/desktop/test/e2e/approvals.spec.ts`。

### 3.5 MCP（借鉴点 3）

- `packages/shared/src/domain/types.ts:272` `mcpServerSchema`：`id, name, transport stdio/http/sse, command/args/env/url/headers, enabled, autoApprove`（**只有 server 级开关**）；Bot 侧 `mcp_server_ids`（:54）；`approvalKindSchema`（:942）；`mcpToolApprovalPayloadSchema`（:1046）。
- `packages/core/src/mcp/service.ts` `listTools` 返回 pi-mcp `Tool[]`，**带 `annotations`**（pi-mcp 导出 `ToolAnnotations` 类型），目前没人用。
- `packages/core/src/mcp/tools.ts` `wrapMcpTool`：`gateway.mcpToolCall`（审批）→ `mcp.callTool` → 结果包 `<untrusted>`。
- `packages/core/src/gateway/index.ts` 约 787 行 `mcpToolCall`：非 `mcpAutoApprove(serverId)` 则 `approvals.request(identity,'mcp_tool',{serverId,serverName,toolName,argsSummary≤400 脱敏})`，审计 `mcp_tool_call`。
- `packages/core/src/agent/external/capabilities.ts`：`READ_ONLY_TOOLS` / `DESTRUCTIVE_TOOLS` / `toolAnnotations()`（D72 给外部智能体标注宿主工具，方向相反但词表可复用）。
- D73（`docs/design/29-*`、`todo/connected-apps.md`）计划的 `classifyRisk`：`readOnlyHint===true` → read；`destructiveHint===false` → write；其余 → destructive；无人值守不自动批准 destructive。**未开工**。
- 测试：`packages/core/test/unit/mcp-tools.test.ts`、`packages/core/test/integration/mcp.test.ts`、`mcp-loop.test.ts`。

### 3.6 Bot 间委派（借鉴点 1）——D70/D71 现状

- **D70/D71 已在代码中实现**（commit `5d22ef8`、`3579fb3`；`todo/butler-and-delegation.md` 状态“P1–P4 已实现（2026-10-06）”）；`docs/design/27-*` 文件头仍写“尚未实现”，**是文档滞后**，留给 Pengfei 回写时修正。
- 代码：`packages/core/src/tools/delegation-tools.ts`（`delegate_to_bot{bot_id, task}`、`cancel_delegation{delegation_id}`，**无 intent**）、`dispatch/delegation.ts`（586 行 DelegationHost：投递闸门 = B 邮箱空闲且不在免打扰、崩溃一致性、按 run_id 的 settle 钩子、单跳检查、卡片 `delegation_sent` / `delegation_result`）、`dispatch/butler.ts`、`domain/delegations.ts`、`domain/butler.ts`、`tools/butler-tools.ts`、迁移 `0016_butler_and_delegation.sql`。
- 测试：unit `butler-route` / `butler-team` / `butler` / `delegation`；integration `butler-delegation-migration`、`delegation-host`、`delegation`。
- **DEV-012**（`docs/dev/DEVIATIONS.md`，2026-10-08 决定）：D71 结果仍取 B 的“单个委派对话轮回复”，D75 后它可能只是“我去做”。推荐方案二（委派跟随 B 在该轮 `start_task` 起的任务，`origin_run_id` 关联），**D75 收尾后单独修订**——即 W6 的主体。

### 3.7 监看、记忆、语音（借鉴点 6、8、9）

- `packages/core/src/schedule/service.ts`：cron / once 定时每次触发都唤醒一个对话轮（要花 LLM）；仅失败 tick 有退避；**没有“确定性检查、变化才唤醒”的原语**。
- 传感器 D76：`packages/shared/src/domain/sensors.ts`、`apps/desktop/src/renderer/src/lib/sensors/*`（hub、webmedia、registry、preferences）、`apps/desktop/src/main/sensor-permission.ts`、`app-permissions.ts`；`todo/sensors.md` P1–P4 代码已完成待真机验收，**core 无 Bot 能力**。**已定**：本轮维持现有麦克风能力，不做 Bot 侧传感器监看，摄像头等其他来源后期处理（见 W7、§4）。
- 记忆：`packages/core/migrations/memory/0001_p07_memory.sql`（`memory_items`：kind、content、subject、source explicit/inferred、evidence_json、origin private/group、sensitivity normal/sensitive、private_to_bot、status active/superseded/retracted/void、supersedes；`memory_fts` unicode61；CHECK 约束覆盖 kind/source/origin/sensitivity/status）、`memory/store.ts`、`memory/profile-store.ts`（profile 条目 supersedes 链 + proposals）；RPC `memory.list/update/retract`、`profile.*`（methods.ts 约 1329–1336）。**无导出 / 导入**；`infra/backup.ts` 只在迁移前备份 main.db。memory 迁移到 0002。
- 语音：D69 只做点击录音转文字；语音对话模式**已推迟**，本方案也**暂不立项**；`tools/speech-tools.ts`：`generate_speech / generate_video / transcribe_audio`。

---

## W1. 浏览器动作确定性（P0，借鉴点 2）

### 目标

模型永远能区分三种结局：**没做**（可安全重试）、**做了**（别再做）、**不确定**（先看页面再决定，禁止盲重放）。顺带收掉三处防护缺口：同文档 ref 漂移、重复无效动作、敏感输入进记录。

### 借鉴什么 / 刻意不同

- 借 [R] page-browser：一旦开始派发就记 `uncertain=true`，派发确认后才转 `completed`；mutation 前做 stale-ref 预检（`isConnected` / 可见 / 未禁用）；工具说明 “Do not replay completed or uncertain actions”。
- 借 [R] computer-tools：连续 3 次画面不变的视觉动作被拦；同帧截图只回一句 “previous screenshot remains valid”。
- **不同**：
  - 不换成 JS 元素对象引用 + isolated world 的整套 Python 助手——我们已有 `backendNodeId` + CDP，补一个“指纹”校验就够，改动面小。
  - 不做 `act` 批量 1–24 步：批量会让“哪一步不确定”更难表达，且我们的模型每步都拿到快照；保留单步。
  - 元素上限**维持 150**（已定），不跟 Rakazo 降到 80：长列表少滚动更重要；只补截断提示。

### 设计

1. **结果形状**（`packages/core/src/tools/browser.ts`，模型看到的文本 + 结构化字段写进 `run_steps` payload）：

   ```ts
   type BrowserActionOutcome = 'not_started' | 'completed' | 'uncertain';
   interface BrowserActionReport {
     action: 'click' | 'type' | 'press' | 'scroll' | 'back' | 'open';
     outcome: BrowserActionOutcome;
     /** 动作成功但取快照失败时给出；此时 outcome 仍为 completed。 */
     snapshotError?: string;
     /** 页面是否因动作发生了导航 / 文档替换。 */
     navigated?: boolean;
   }
   ```
   - `not_started`：参数错、ref 预检失败（`REF_UNKNOWN` / 新增 `REF_STALE`）、`PAGE_CLOSED`、`BROWSER_BLOCKED` 等**派发前**的失败 → `ok:false`，可重试。
   - `completed`：CDP 调用返回成功。之后取快照失败 → **`ok:true`** + `snapshotError` + 文案“动作已执行，快照失败，请先 browser_snapshot 再继续，不要重复该动作”。（修掉 §3.1 的缺陷。）
   - `uncertain`：已进入派发（`callFunctionOn` / `Input.insertText` / `Input.dispatchKeyEvent` 已发出）后抛错或超时（含 `#settle` 期间页面崩溃、debugger detach）→ `ok:false, errorCode:'BROWSER_OUTCOME_UNKNOWN'`，文案“动作可能已生效：先 browser_snapshot 核实，确认未生效再重做；涉及提交/付款/发送时用 ask_user 问用户”。
   - 实现：在 `BrowserHostRpc` 的 `click/type/press/scroll/back` 返回值里带 `dispatched: boolean` 阶段标记——browser-host 在派发前抛的错误打 `phase:'pre'`，派发后抛的打 `phase:'post'`（`AppError.details.phase`），core 按 phase 映射 outcome。
2. **ref 指纹预检**（`apps/desktop/src/main/browser-host.ts`）：`PageEntry.refs` 从 `ref → backendNodeId` 扩为 `ref → { backendNodeId, role, name }`；`click/type/press` 前 `DOM.resolveNode` + 一次 `callFunctionOn` 取 `isConnected`、可见（`checkVisibility` 或 rect 非零）、`disabled`/`aria-disabled`、当前 role+可访问名（AX `getPartialAXTree` 取单节点），不符 → `BROWSER_REF_STALE`（`phase:'pre'`），提示“页面已变化，重新 browser_snapshot”。
3. **重复动作熔断**（core，`tools/browser.ts` 每页一个小状态，按 `botId|conversationId` 存在 BrowserFacade 内存里）：
   - 每次动作后对快照文本（去掉 ref 编号后）取 sha256；**同一动作签名**（action + ref 指纹 + 参数 hash）连续 3 次且快照 hash 不变 → 第 4 次直接 `ok:false, errorCode:'BROWSER_NO_PROGRESS'`、`not_started`，提示换做法或 ask_user。
   - `browser_screenshot`：base64 的 sha256 与上一张相同 → 不回图，只回“截图与上一张相同，上一张仍有效”（省 token）。
4. **敏感输入不落盘**：`browser_type` 增可选参数 `sensitive?: boolean`（工具说明：密码、验证码、卡号必须置 true）；为 true 时 `run_steps` 的 tool_call payload 里 `text` 替换为 `«redacted:N chars»`，结果文本也不回显；另外**无论模型是否标注**，若目标元素 `type=password`（预检时已拿到）则强制按 sensitive 处理。落盘脱敏在 `agent/step-persistence.ts` 加一个按工具名的参数脱敏表（`browser_type.text` when sensitive），**不要**在工具里改 params 对象本身。
   - 更彻底的 `fill_secret`（凭据不经模型，按 origin 绑定）列为非目标（§4），以后对齐 D52 的凭据审批卡思路单列。
5. **元素上限维持 150**（已定）：`BROWSER_SNAPSHOT_MAX_ELEMENTS = 150` 不改；`buildSnapshotSummary` 截断时在快照尾加“还有 N 个元素未列出，可 browser_scroll 或缩小范围”（若已有类似提示则只核对文案）。
6. 工具说明（`tools/browser.ts` 各 description）补一句通用规则：“结果为已完成或不确定的动作不要重放；不确定先快照核实”。

### 改动清单

- [x] `packages/shared/src/rpc/methods.ts`：browser 动作输出 schema 增 `outcome`、`snapshotError?`、`navigated?`；错误码枚举（若有）增 `BROWSER_REF_STALE` / `BROWSER_OUTCOME_UNKNOWN` / `BROWSER_NO_PROGRESS` （2026-10-09 完成）
- [x] `packages/shared/src/constants.ts`：`BROWSER_NO_PROGRESS_LIMIT = 3` （2026-10-09 完成）
- [x] `apps/desktop/src/main/browser-host.ts`：refs 指纹、预检、phase 标记、`#settle` 内异常归为 post （2026-10-09 完成）
- [x] `packages/core/src/browser/facade.ts`：透传 outcome；每页无进展计数器 （2026-10-09 完成）
- [x] `packages/core/src/tools/browser.ts`：拆开“动作 / 快照”两个 try；outcome 映射；`browserErrorHint` 新码；screenshot 去重；`browser_type.sensitive` （2026-10-09 完成）
- [x] `packages/core/src/agent/step-persistence.ts`：按工具参数脱敏表 （2026-10-09 完成）
- [x] `packages/core/src/agent/context/continuation.ts`：渲染 `uncertain` 结果时带“结果未知”标记（与 W3 共用渲染函数） （2026-10-09 完成）

### 迁移 / 兼容

无数据库迁移。旧 `run_steps` 没有 outcome 字段，渲染时按缺省处理。工具参数只增可选字段，旧模型提示不受影响。

### 测试

- 定向：`node scripts/run-tests.mjs run packages/core/test/unit/browser-tools.test.ts`（新增：动作成功+快照失败 → ok:true；post 异常 → uncertain；pre 异常 → not_started；连续 3 次无变化 → NO_PROGRESS；同图去重；sensitive 不回显）
- 定向：`node scripts/run-tests.mjs run packages/core/test/integration/browser.test.ts`
- 定向：`node scripts/run-tests.mjs run packages/core/test/unit/continuation.test.ts`（uncertain 渲染）
- step 脱敏：在既有 step-persistence 相关单测中加用例（`rg -l step-persistence packages/core/test` 找到对应文件后定向跑）
- e2e（改了 browser-host，需真 Electron）：`pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/browser.spec.ts`，新增 SPA 重渲染后点旧 ref → REF_STALE
- `pnpm --filter @kepcup/shared typecheck && pnpm --filter @kepcup/core typecheck && pnpm --filter @kepcup/desktop typecheck`

### 验收

- 人为让快照抛错（测试桩），模型拿到 `ok:true` 且文案含“不要重复”。
- SPA 改写 DOM 后用旧 ref 点击 → `REF_STALE`，无副作用。
- `browser_type` 在密码框输入后，`run_steps` / 续接摘要 / 执行记录 UI 里都看不到明文。
- 连续 3 次同一点击且页面不变，第 4 次被拦。

### 本项不做

批量 `act`；isolated world 引用模型；saved-login / `fill_secret`；浏览器资料（私有 / 共享）由 W8 负责，本项不动 partition。

### 风险

- 指纹校验对“名字随内容变化”的元素（计数徽章、时间）可能误判 stale → 只比 role + 名字前 40 字符，且名字比较前去数字；误判代价只是多一次快照。
- `phase` 划分不准会把真失败标成 uncertain → 宁可多报 uncertain（安全侧），在测试里覆盖每个 CDP 调用点。

### 实施记录（2026-10-09）

- **continuation.ts 未改**（留给 W3-P0 一并做）：`uncertain` 已落在 `run_steps` 的 tool_result payload——`{ toolCallId, toolName, ok:false, content, errorCode:'BROWSER_OUTCOME_UNKNOWN', outcome:'uncertain' }`；其它浏览器动作结果带 `outcome:'not_started' | 'completed'`。`ToolResult` 新增 `outcome?` 与 `sensitiveParams?`（pi-engine 与外部智能体宿主桥都透传进 tool_result 事件）。
- `snapshotError` / `navigated` **不落结构化字段**：只体现在结果文本里（“动作已执行，但随后获取页面快照失败……不要重复该动作”、“（页面已跳转）”）。RPC 层：click/type/press/scroll/back 输出改为 `browserActionOutputSchema = { ok, outcome?, navigated?, passwordField? }`；快照输出增 `elementsOmitted?`；错误码进 `ERROR_CODES`。宿主错误的 `details.phase` 经 port B 的 AppError 序列化原样到达 core（`rpc/channel.ts` 带 details）。
- phase 归类：宿主在 click/type/press/scroll/back 里打 `pre`/`post`；**navigate 不打标签**——`browser_open` 失败按 not_started（GET 导航可安全重做）。未打标签的错误：`INVALID_INPUT / REF_UNKNOWN / REF_STALE / PAGE_CLOSED / BLOCKED / BOT_DELETED / CONVERSATION_DELETED / UNAVAILABLE` 视为 not_started，其余在 click/type/press/back 上记 uncertain（安全侧），open/scroll 上记 not_started。`type` 的 focus/select 视为派发前，`Input.insertText` 起为派发后；click 的 `callFunctionOn` 若返回 `exceptionDetails`（我们的函数在 `click()` 前就抛了）按派发前处理。
- 指纹比较做成 shared 纯函数（`packages/shared/src/browser/ref-fingerprint.ts`：名字去数字、比前 40 字符、允许前缀关系以兼容 80 字截断）；可见性用 `checkVisibility()`（`<option>` 豁免：关着的 select 里没有自己的盒子）；`disabled` / `aria-disabled` 也报 `REF_STALE`（文案说明是禁用）；AX 单节点查询失败不算 stale（尽力而为）。
- 无进展熔断：状态按 host 句柄 + `botId|conversationId` 存在 `browser/facade.ts`（`browserPageState`，WeakMap，每 host 至多 256 页）。**偏离**：熔断计数与截图去重是 **run 级**的——另一个 run 触碰该页即清零（新 run 的模型没见过上一张图；用户换一轮让重试不是死循环）。只计 click / type（签名含文本 sha256）/ Enter、Escape 两个键；scroll、其它键（Tab、方向键、Backspace 改的是焦点/值，快照看不出）、back、open 不计并重置连续计数。“页面没变”= 动作后快照（去 ref 编号）hash 与动作前最后一次快照相同。
- 敏感输入：`browser_type.sensitive=true` 时 tool_call 步骤里 `text` 写成 `«redacted:N chars»`；值登记为本 run 敏感值，之后落盘的 request / assistant / tool_result / progress / tool_call 步骤里的原文与 JSON 转义形式都替换成 `«redacted»`（长度 < 4 的值只脱敏它自己的参数，不全局替换）。**密码框强制**：tool_call 步骤在执行前已落盘（pi `tool_execution_start`），宿主报 `passwordField` 后工具结果带 `sensitiveParams:['text']`，step-persistence 用新增的 `RunsService.replaceStepPayload` 改写那条 tool_call 步骤。**残留**：执行期间（tool_call 落盘到 tool_result 之间）明文在 runs.db 里短暂存在，此间崩溃则留存；外部智能体（ACP）自身进程/会话里的参数不受控；`wiki/maintenance.ts`、`skills/authoring.ts` 自己的步骤记录不走这张表（它们没有浏览器工具）。结果文本不回显：声明敏感或密码框时，陈述句不含文本，回程快照里出现的该值（≥4 字符）替换为 `«已隐藏»`。
- e2e：`browser.spec.ts` 新增「SPA 重渲染后点旧 ref → REF_STALE 且无副作用；密码框输入不回显」（testkit `web-server.ts` 新增 `/spa` 夹具），大页面用例补断言「还有 250 个元素未列出」。

#### 复查后修正（2026-10-09）

- **阻断：字符串 `sensitive` 泄漏**：pi 用 `Value.Convert` 把 `"true"` 强转给工具，但 tool_call 步骤看的是原始参数。现在 `browser_type` 只要声明敏感或命中密码框就**总是**回报 `sensitiveParams:['text']`（含 ensurePage 失败、熔断拦截等早退路径），落盘侧据此改写；脱敏表接受 `true / 1 / "true" / "1" / "yes" / "y" / "on"`。pi 参数校验失败时回显的 `Received arguments: …` 不经工具（pi 直接回错误结果），其中的 `"text": "…"` 在之后的 request 步骤里按下条结构化规则抹掉（前提是值已登记——校验失败且只有密码框能证明敏感时无从得知，记为残留）。
- 宿主桥审计：`agent_bridge_tool_call` 审计行改记 `redactToolArgs(toolName, rawArgs)` 之后的参数（声明敏感的输入不进审计库；只有执行期才发现的密码框在审计行里仍是明文——审计行写在执行前且只追加，记为残留）。
- 短值（CVV / PIN）：除 ≥4 字符的子串抹除外，新增**结构化**抹除（任意长度）：对象里同名参数字段恰为该值 → `«redacted»`；JSON 文本里的 `"text": "<值>"`（provider 的 `arguments` 字符串、pi 校验回显）及再转义一层的形式。标识字段（`id / call_id / tool_call_id / tool_use_id / toolCallId / toolName`）一律不改写，tool_call 步骤只抹 `args` / `title`。
- 指纹：只去掉 ≤3 位的数字串（“删除 订单 10023”与“…10024”不再相等）；前缀匹配只在快照名被截断（以“…”结尾）时允许（“Pay”≠“Pay $500 now”）；空名只等于空名；纯短数字名（分页“2”/“3”）按原文比较。
- 无进展熔断：宿主快照输出新增 `stateDigest`（列出元素的 AX value + checked / expanded / selected / pressed 的 sha256，只出 hash），并入页面 hash——步进器“+”、勾选框不再被误拦。
- 先写后登记：登记新敏感值时，回写本 run 最近一条 assistant 步骤和最近 50 条（单条 ≤64KB）tool_call 步骤；REF_STALE / 禁用 / 焦点失败的错误 details 带 `passwordField`，失败的密码框尝试也会回报 `sensitiveParams`。
- 宿主动作流程抽到 `apps/desktop/src/main/browser-actions.ts`（无 Electron 依赖），每个 CDP 调用点有 pre/post 单测（`browser-actions.test.ts`）。点击函数在同一 JS 回合里再查 isConnected / 可见 / 禁用（返回 `{clicked:false}` → pre，关掉预检→点击的 TOCTOU）；`type` 校验焦点确实落在目标上（`activeElement`），否则 pre 失败、不 `insertText`；AX 单节点查询只比对 backendDOMNodeId 精确命中的节点；“Execution context was destroyed”不再映射成 PAGE_CLOSED（改为“页面在操作过程中跳转或重载”）；`toPageError` 先判 `instanceof AppError`；uncertain 文案用原始错误消息，不带“可 browser_open 重新打开”。
- 删除级联：`browser.close({permanent:true})` 与 `clearBotData` 同时清掉 core 侧该页 / 该 Bot 的 W1 页面状态。
- 残留（仍未覆盖）：密码框（模型未标注）的明文在 tool_call 落盘到 tool_result 之间短暂存在于 runs.db；用户自己在对话里发出的敏感值、更早 request 步骤里已有的值不追溯；外部智能体自身会话不受控。

---

## W2. 外部副作用台账（P0，借鉴点 2/4/5 的地基；D67 第一步）

### 目标

为**有外部副作用的工具调用**落一条“开始前写、结束后结”的记录，使崩溃 / 中断 / 重试时能回答“哪些动作可能已经发生了”。只记账、不续跑——这正是 D67 durable journal 里 tool lifecycle `opened → running → settled` 的最小子集，以后 D67 落地时直接并入。

### 借鉴什么 / 刻意不同

- 借 [R] `approval-effect.ts` 的状态机与 `approval-effect-key.ts` 的稳定 key（`stableJsonValue` + sha256 + occurrence）。
- 借 [M] `actions.ts` 的 `outcome_unknown` 终态与“活动回执”。
- **不同**：Rakazo 的 effect 只挂在审批上；我们挂在**工具副作用类别**上（有些副作用工具不需要审批，比如已授权路径下的 `browser_click`），审批只是其中一种前置。不引入 Postgres；放在 runs.db（加密 SQLite），随 run 清理策略走。

### 设计

1. **副作用分类**（新文件 `packages/core/src/agent/effects/classify.ts`，与 D67 replay 类对齐）：

   ```ts
   export type EffectClass = 'none' | 'local' | 'external';
   // none: 只读（read/ls/grep/web_search/browser_snapshot/screenshot/memory 查询…）
   // local: 只改本机且可撤销/可重做（write/edit 在项目内——已有 revert；memory 写）
   // external: 离开本机或不可撤销（browser_click/type/press/open 的提交类、mcp 非只读、git_remote、bash 非沙箱、send_message 到外部渠道、delegate_to_bot）
   export function effectClassOf(toolName: string, params: unknown, ctx: { mcpRisk?: ToolRisk }): EffectClass;
   ```
   - MCP 工具用 W5 的 `ToolRisk`：`read → none`，`write/destructive → external`。
   - bash：沙箱内 → `local`；`unsandboxed` 审批通过的 → `external`（保守）。
   - 词表放一处，`agent/external/capabilities.ts` 的 `READ_ONLY_TOOLS` 改为从这里派生或互相断言一致（测试里断言）。
2. **表**（runs.db 新迁移，编号见“迁移”）：

   ```sql
   CREATE TABLE tool_effects (
     id            TEXT PRIMARY KEY,          -- eff_…
     run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     tool_call_id  TEXT NOT NULL,
     tool_name     TEXT NOT NULL,
     effect_key    TEXT NOT NULL,             -- runId:tool:sha256(stableJson(args))[:16]:occurrence
     args_hash     TEXT NOT NULL,
     summary       TEXT NOT NULL,             -- 已脱敏、≤200 字，给人看的“做了什么”
     approval_id   TEXT,                      -- 有审批时关联 main.approvals.id（跨库，无外键）
     status        TEXT NOT NULL CHECK (status IN (
                     'intended','executing','completed','failed','uncertain','denied')),
     receipt_json  TEXT,                      -- 工具可选回执：{url?, externalId?, note?}
     created_at    INTEGER NOT NULL,
     settled_at    INTEGER,
     UNIQUE (run_id, tool_call_id)
   );
   CREATE INDEX tool_effects_by_run ON tool_effects(run_id, created_at);
   CREATE INDEX tool_effects_by_key ON tool_effects(effect_key);
   ```
3. **钩子**：`executeToolSafely` 增一个可选 `EffectRecorder`（由 pi-engine 与 mcp-bridge 注入），流程：
   - `effectClassOf` 为 `external` 时：执行前 `insert(status='executing')`（审批在工具内部发生，审批被拒时工具返回 denied 错误码，recorder 结为 `denied`）。
   - 工具返回 `ok:true` → `completed`；`ok:false` 且 errorCode 为 `BROWSER_OUTCOME_UNKNOWN` 或工具显式 `outcome:'uncertain'` → `uncertain`；其他失败 → `failed`。
   - 抛异常且异常发生在 `runInToolCall` 内、且无法判断阶段 → `uncertain`（保守）。
   - `ToolContext` 增 `toolCallId: string`（pi-engine 已有该值；mcp-bridge 用 MCP request id / 生成 id）。
   - `ToolResult` 增可选 `effect?: { outcome?: 'completed'|'uncertain'; receipt?: {...}; summary?: string }`，工具可主动报告（W1 浏览器、MCP、git_remote 先接）。
4. **恢复**：`TaskHost.recover()`（以及对话轮的同类恢复）在标 interrupted 时，把该 run 所有 `executing` 行改为 `uncertain`（一条 UPDATE，幂等）。
5. **读取接口**（core 内部 + RPC）：`effects.listForRun(runId)`、`effects.listForTask(taskId)`（沿 continuation 链收集）。RPC `effects.list: { input:{ taskId }, output:{ effects: ToolEffect[] } }`（给 W3 面板用）。

### 改动清单

- [x] `packages/shared/src/domain/types.ts`：`toolEffectSchema`、`effectStatusSchema` （2026-10-09 完成）
- [x] `packages/shared/src/rpc/methods.ts`：`effects.list`（加进 renderer 白名单数组，照 `tasks.get` 的写法） （2026-10-09 完成）
- [x] `packages/core/migrations/runs/0009_tool_effects.sql` （2026-10-09 完成）
- [x] `packages/core/src/agent/effects/{classify,key,recorder,store}.ts` （2026-10-09 完成）
- [x] `packages/core/src/agent/tool-execution.ts`、`pi-engine.ts`、`external/mcp-bridge.ts`、`types.ts`（ToolContext.toolCallId、ToolResult.effect） （2026-10-09 完成）
- [x] `packages/core/src/dispatch/tasks.ts` `recover()`：executing → uncertain（实际落在 `orchestrator.recoverInterrupted()` 第 0 步，见实施记录） （2026-10-09 完成）
- [x] `packages/core/src/agent/external/capabilities.ts`：与 classify 词表一致性断言 （2026-10-09 完成）

### 迁移 / 兼容

- runs.db 新增一张表，forward-only，无回填（旧 run 无台账 = “未知”，W3 面板对旧任务显示“本任务无副作用记录，请查看执行记录”）。
- 编号：D73 预定了 runs 0009；谁先落谁先占号，**写迁移时以 `ls packages/core/migrations/runs` 实况取下一个号**，并同步改另一份 todo 里的预定号（那一步由 Pengfei 回写文档时处理，本方案执行时不改别的 todo）。
- 改迁移属于“必须全量跑一次”的触发条件。

### 测试

- 新单测 `packages/core/test/unit/tool-effects.test.ts`：key 稳定性（键序无关、occurrence 递增）、分类表、recorder 状态转移。定向：`node scripts/run-tests.mjs run packages/core/test/unit/tool-effects.test.ts`
- 新集成 `packages/core/test/integration/tool-effects.test.ts`：假工具（external）成功/失败/抛错/uncertain；模拟崩溃后 `recover()` → uncertain。定向同上路径。
- 迁移测试：照 `task-events-migration.test.ts` 写 `tool-effects-migration.test.ts`，定向跑。
- `pnpm --filter @kepcup/core typecheck`；本项收尾（含迁移）跑一次全量 `pnpm test`。

### 验收

- 一个任务点了两次外部按钮、调用了一次 MCP 写工具，`effects.list` 返回 3 行且状态正确。
- 强杀进程重启后，执行中的那行变为 `uncertain`。
- 只读工具不产生任何行（台账不膨胀）。

### 实施记录（2026-10-09）

- **文件**：新 `packages/core/src/agent/effects/{classify,key,store,recorder}.ts`、`packages/core/migrations/runs/0009_tool_effects.sql`（表与索引照设计；FK `runs(id) ON DELETE CASCADE`，runs.db 开着 `foreign_keys`）；shared `domain/types.ts` 增 `effectStatusSchema` / `effectReceiptSchema` / `toolEffectSchema`（类型 `EffectStatus` / `EffectReceipt` / `ToolEffect`），`ids.ts` 增前缀 `eff_`；RPC `effects.list`（输入复用 `taskIdInputSchema`，输出 `effectsListOutputSchema`，已进 `APP_METHODS` 白名单），绑定在 `rpc/bindings.ts`；`CoreDomainServices.effects`（`ToolEffectsStore`）。
- **钩子**：`executeToolSafely(tool, params, ctx, effects?)`；`PiEngine` 与 `HostMcpBridge` 的 deps 增可选 `effects`（start.ts 用同一个 `createEffectRecorder` 注入）。`ToolContext.toolCallId` 为**可选**（偏差：pi 与桥都会填；做成可选是为了不改几十处直接调 `execute` 的测试）；桥用它自己的 `kc_<uuid>`。`ToolResult.effect?: { outcome?, receipt?, summary? }` 只进台账，本轮**只有 MCP 包装工具**在 `callTool` 抛错时报 `outcome:'uncertain'`（请求可能已到 server）；浏览器沿用 W1 的 `outcome`，git_remote 暂不报回执（留给 W4）。
- **分类**（`effectClassOf(toolName, params, ctx)`）：全部 69 个内置工具名逐个登记（单测扫描工具源码断言无遗漏、无陈旧项），未登记 → external。偏差 / 细化：`send_message` 平时 local，`mention_bot_ids` 非空（会触发其他 Bot）→ external；`browser_open/scroll/back/close` → none（与 W1 一致：GET 导航可重做）；`generate_*` 媒体 → local（重做只多花费用）；`delegate_task`（只读 SubAgent）→ local，子 run 自己的外部调用按子 run 入账。MCP 工具：`ToolDefinition.mcp = {serverId, toolName, risk}`（mcp/tools.ts 包装时写入，外部智能体改名后仍在），记录器取它与 `McpService.riskOf` 实时值中更严的一档。
- **bash**：沙箱内 → local（不记）；沙箱外由网关判定——`ToolCallScope` 增 `effect` 钩子，`gateway #executeUnsandboxedApproved`（确认模式下已批准的命令、`request_unsandboxed`）执行前 `escalate('unsandboxed')`，记录器此时才写 `executing` 行（摘要「bash（沙箱外执行） …」）。确认模式的白名单只读命令不记。审批关联同理：`ApprovalsService #insert` 调 `noteApproval(id)`，行的 `approval_id` = 本次调用最近一次审批。
- **状态**：执行前 `executing`；ok → completed；`effect.outcome/outcome==='uncertain'` 或 `BROWSER_OUTCOME_UNKNOWN` → uncertain；`APPROVAL_DENIED`（返回或抛出）→ denied；`outcome:'not_started'` → failed；其它失败 → failed，**但 run 已被中止时 → uncertain**（细化）；抛异常 → uncertain。`settle` 只改 executing / uncertain 行（恢复改成 uncertain 后真实结果仍可落定）。记录器任何异常只 `logger.warn`，不影响工具（含 run 不存在时 FK 拒绝）。
- **脱敏**：摘要与 `args_hash` 的输入 = W1 参数脱敏表（`redactToolArgs`）+ 台账专用表（`browser_type.text` **一律**不入台账——密码框是执行中才知道的，行在执行前已写）+ `secrets.redact`；`args_hash` 是脱敏后 canonical JSON 的完整 sha256，`effect_key` 取前 16 位。摘要 ≤200 字。
- **键**：`effect_key = runId:tool:hash16:occurrence`，occurrence 在写入事务里按（run、工具、args_hash）计数。**发现**：mock 模型（以及部分 OpenAI 兼容服务）每轮复用同一个 tool call id，`UNIQUE(run_id, tool_call_id)` 冲突时改存 `id#2`、`id#3`…而不是丢行；此时与 run_steps 按 id 关联有歧义（W3 面板按时间顺序对齐即可）。
- **恢复**：没有放进 `TaskHost.recover()`，而是 `Orchestrator.recoverInterrupted()` 的第 0 步（任务修复之前）执行一条 `UPDATE … WHERE status='executing'`（`ToolEffectsStore.markExecutingUncertain()`，幂等）：启动时没有任何活着的 run，所有 executing 行都属于已死的进程；一条语句同时覆盖任务、对话轮、子 run、外部智能体 run 与任务修复失败的兜底路径，且先于任务修复写失败摘要（摘要可据此标注）。W3-P1 的 `interrupt(taskId)` 用带 runIds 的同一方法。
- **读取**：`listForRun(runId)`、`listForRuns(ids)`、`chainRunIds(taskId)` / `listForTask(taskId)`——沿 `continued_from_run_ids_json` 向前追溯（重试的重试）并带上各 run 的 SubAgent 子 run（`parent_run_id`），按创建时间排序；只向前不向后（给出的是最新任务时即全链）。
- **一致性**：`capabilities.ts` 的 `READ_ONLY_TOOLS` 改为导出，单测断言其每一项分类为 none、任何 external 工具都不带只读注解（注解集合本身未改，避免改变外部智能体的审批行为）。
- **W3-P0 / W1 续接项**：`buildRunDigest` 增可选 `effects`（台账行）；未配对的 tool_call 若有副作用（分类非 none）或台账 uncertain → `[结果未知] 工具(参数) —— 中断时仍在执行、没有返回结果，可能已经生效：先核实页面 / 外部状态，勿直接重做`，只读的未配对调用只标「→（未返回结果）」；结果 `outcome==='uncertain'` / `BROWSER_OUTCOME_UNKNOWN`（旧行无 outcome 也认）/ 台账 uncertain → `[结果未知] 工具(参数) —— 动作可能已经生效（结果不确定）：… → 失败：<untrusted>…</untrusted>`。任务续接回放（orchestrator `#taskContinuation`）与任务失败摘要（`TaskHost #failureText`）传入台账；SubAgent 的摘要不传（只读）。无台账的旧 run 只靠步骤配对。
- **测试**：`packages/core/test/unit/tool-effects.test.ts`（17）、`packages/core/test/unit/tool-effects-migration.test.ts`、`packages/core/test/integration/tool-effects.test.ts`（真实任务：两次点击 + 输入 + MCP 写工具 → 4 行、只读浏览器 / 只读 MCP 不产生行、审批关联；uncertain 点击 + 拒绝的 MCP；重启恢复 + 失败摘要 + `effects.list` 续接链）、`continuation.test.ts` 增 3 例；`task-events-migration.test.ts` 的 runs 迁移期望改为 `[6, 7, 8, 9]`。改了迁移与 shared 契约，P0 收尾需跑一次全量。

- **复查后修正（2026-10-09）**：
  - **审批串到别的 run**：`Scheduler.submit()` → `#drain()` 在提交方的异步上下文里同步启动 job，委派 / @ 提及 / 任务派出 / 工具里设的定时器启动的另一个 run 会继承该工具调用的 ALS scope（它的 agent_tool 审批会改写委派行的 approval_id；once 授权的归属同理）。根治：`#drain` 用新的 `outsideToolCall()`（`storage.exit`）启动 job——核实过没有合法依赖：once 授权本就按 `grant.runId === identity.runId` 过滤，别的 run 拿不到；子 run 自己的工具调用各自开新 scope。另加两道护栏：钩子改用 `activeEffectHooks()`（scope 已结束则不给），`escalate` / `noteApproval` 带 `identity.runId`，记录器忽略别的 run；`store.noteApproval` 只改 `executing` 行。
  - **结果未知写进步骤**：`executeToolSafely` 在台账结为 uncertain（抛错、MCP 传输失败、中止期间失败）且工具没给 outcome 时，给结果补 `outcome:'uncertain'`；pi-engine 与桥的 tool_result 报 `outcome ?? effect.outcome`。续接摘要因此不依赖台账也能标注；台账兜底按基础 id（去掉 `#n`）匹配，且只作用于失败结果（同 id 的成功调用不被牵连）。`settle` 移出 try，记录器出错不会替换真实结果。
  - **工具自报的 summary / receipt** 与参数摘要同样过 W1 敏感值擦除（本次调用的敏感参数值 + 执行时报告的 `sensitiveParams`）再 `secrets.redact`。
  - **沙箱内联网命令维持 local（已定）**：逐条记录会让几乎每个编程任务都触发 W3-P1 的检查门。台账**不覆盖沙箱内执行的命令**——W3-P1 面板文案须写明「沙箱内执行的命令不在此清单中，请查看执行记录」（classify.ts 注释已写）。
  - 0009 增 `CREATE INDEX IF NOT EXISTS runs_by_parent ON runs(parent_run_id)`（续接链收集子 run 用）。
  - 测试：tool-effects 单测 +5（跨 run / 已结束 scope 的审批与 escalate 被忽略、调度器 job 不继承 scope、步骤补 outcome、记录器抛错不影响结果、自报摘要擦除），continuation +2（`id#2` 基础 id 匹配、步骤自带 outcome），host-mcp-bridge +1（effect.outcome / 台账 uncertain 进 tool_result 报告），迁移测试断言新索引。

### 风险

- 分类表漏掉某个外部工具 → 默认值取**保守**：未登记的工具名按 `external`（只多记一行，不影响行为），测试列出全部内置工具名断言均已登记。
- 每次外部调用多两次 runs.db 写：量级很小（外部动作本就慢），可接受。

---

## W3. 中断任务「检查后重试」+ 撤销授权立即中断（P0 摘要标注 + P1 重试面板 / 撤销中断，借鉴点 5）

### 目标

1. 应用退出 / 崩溃导致的 `interrupted` 任务**可以重试**，但有外部副作用时**必须先检查**：先让用户看到“可能已经做了什么”，续接的模型也被明确告知“这些结果未知，先核实，勿直接重做”。（已定：开重试按钮；有外部副作用必须检查后才能重试。）
2. 用户在任务运行中**撤销授权**（路径授权 / MCP 允许）时，受影响的任务**立刻**标为 `interrupted`，走同一条“检查后重试”路径。（已定。）

### 借鉴什么 / 刻意不同

- 借 [D] `store.ts`：租约过期 / 设置变化 → interrupted，文案 “Review completed effects before retrying”；`TaskActions.tsx` 的 “Retry after review”。
- **不同**：不做自动恢复（D49/D67 的 ephemeral 语义不变）；触发中断的“设置变化”只限于**用户主动撤销授权**（下文 §设计 3 列举），不包括无关设置（模型、外观等）。

### 设计

1. **P0（无 UI，0.5 天）**：`continuation.ts` `renderStepLines` 对“有 tool_call 无 tool_result”的步骤、以及 `tool_effects.status='uncertain'` 的步骤渲染为：
   `- [结果未知] browser_click e12 "提交订单" —— 应用中断时正在执行，先核实页面/外部状态，勿直接重做`
   （无台账时仅依据步骤配对判断，P0 不依赖 W2。）
2. **P1 重试**：
   - `TaskHost.retry(taskId, opts?: { reviewed?: boolean })`：允许 `status ∈ {'failed','interrupted'}`；`interrupted` 且该任务链上存在 `external` 台账行（completed/uncertain）时，**要求** `reviewed:true`，否则返回 `REVIEW_REQUIRED`。
   - 续接 run 的 brief 前置一段 `<effects_before_interrupt>`：列出 completed / uncertain 行（summary + 状态），并写明“completed 的不要重做；uncertain 的先核实”。
   - RPC：现有重试入口是 `runs.retry`（`methods.ts:1258`，输入 `runIdInputSchema`）。新增 `runsRetryInputSchema = runIdInputSchema.extend({ reviewed: z.boolean().optional() })`，不改其他调用方。
   - 渲染端：`task-view.ts` `canRetry` 改为 `(state==='failed' || state==='interrupted') && setup===null && continuedByTaskId===null`，并新增 `needsReview`（interrupted 且有 external 行）；`TaskCard.svelte` 中 `needsReview` 时按钮文案“检查后重试”，点开展示 `effects.list` 的清单（状态徽标：已完成 / 结果未知 / 失败），用户勾“我已核实”后才可点“重试”。无 external 行时按钮直接是“重试”。
3. **P1 撤销授权 → 立即中断**：
   - **触发源**（用户主动撤销，均为宿主事件，不靠模型）：
     - `grants.revoke`（路径授权，`methods.ts:1276`）→ 影响该授权所属对话中**正在运行的任务**；
     - MCP：server 被停用（`enabled:false`）、被移出 Bot 的 `mcp_server_ids`、server `autoApprove` 由开改关、W5 的逐工具策略 `approval` 由 `auto` 改 `ask` 或 `enabled` 改 `false` → 影响**工具面里含该 server 工具**的 Bot 的运行中任务。
     - **不算撤销**：once 授权在调用结束时的自动失效、`GRANT_ABSOLUTE_TTL_MS` 到期、任务自然结束——这些不触发中断。（解读：Pengfei 的答复针对“用户撤销”，自动过期沿用现状。）
   - **机制**：GrantsService / MCP 设置写入路径发出 `permission.revoked` 内部事件 `{ scope: 'path'|'mcp', conversationId?, botIds, serverId?, toolName? }`；TaskHost 订阅 → 对受影响任务调用新的 `interrupt(taskId, reason)`：abort run handle → 取消该 run 的待决审批（`cancelPendingForRun`）→ W2 台账中 `executing` 行改 `uncertain` → run 与任务状态写 `interrupted`，`error_json.reason='permission_revoked'`，文案“授权已被撤销，任务已中断。请检查已完成的操作后再重试”。之后就是上面的检查后重试流程。
   - **对话轮不中断**：对话轮秒级、只读（W5 后可调只读 MCP 工具），撤销后其后续调用自然失败即可。（解读：Pengfei 的问题与答复针对“任务”。）
   - 幂等：同一任务多次收到事件只中断一次（已终态则忽略）。

### 改动清单

- [x] P0 `packages/core/src/agent/context/continuation.ts`：未配对 tool_call / uncertain 标注 （2026-10-09 完成）
- [ ] P1 `packages/core/src/dispatch/tasks.ts`：`retry` 放宽 + `REVIEW_REQUIRED` + brief 前置段；新增 `interrupt(taskId, reason)` 与 `permission.revoked` 订阅
- [ ] P1 `packages/core/src/permissions/grants.ts`：用户撤销时发事件（区分自动失效）
- [ ] P1 MCP 设置写入路径（`packages/core/src/mcp/service.ts` 或 settings 写入处）与 `bots.update`（`mcp_server_ids` 变化）：计算差集后发事件
- [ ] P1 `packages/shared/src/rpc/methods.ts`：`runs.retry` 输入 `reviewed?`
- [ ] P1 `apps/desktop/src/renderer/src/lib/features/tasks/task-view.ts`、`TaskCard.svelte`、新组件 `TaskEffectsReview.svelte`、i18n `zh-CN.ts` 文案（含“授权已被撤销”中断原因）

### 迁移 / 兼容

无迁移（`runs.status` 已含 `interrupted`；原因放 `error_json`）。旧的 interrupted 任务没有台账 → 不要求 review，但续接 brief 仍带 P0 的未配对标注。

### 测试

- `node scripts/run-tests.mjs run packages/core/test/unit/continuation.test.ts`
- `node scripts/run-tests.mjs run packages/core/test/integration/tasks.test.ts -t retry`（新增：interrupted 无台账可直接重试；有台账未 reviewed → REVIEW_REQUIRED；reviewed → 成功且 brief 含前置段；重复点幂等）
- `node scripts/run-tests.mjs run packages/core/test/integration/tasks.test.ts -t revoke`（新增：撤销路径授权 → 该对话运行中任务 interrupted、待决审批取消、executing 台账变 uncertain；其他对话任务不受影响；once 授权自动失效不触发；移出 `mcp_server_ids` → 该 Bot 含该 server 的任务中断；重复事件幂等）
- `node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/features/tasks/task-view.test.ts`
- e2e：`pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/tasks.spec.ts`（新增中断重试路径，可用测试钩子模拟 recover / 撤销）

### 验收

- 任务中断后卡片出现“检查后重试”，清单与执行记录一致；核实前按钮禁用。
- 续接模型的第一步是核实而不是重做（以 fake model 断言 brief 内容）。
- 任务运行中在授权列表里撤销一条路径授权，该任务在 1 秒内变为“已中断（授权已被撤销）”。

### 风险

- 用户嫌麻烦：没有 external 行时不弹清单，直接可重试。
- 撤销波及面过大（一个 MCP server 被多个 Bot 用）：只中断**工具面含该 server** 的任务；中断前不弹确认（已定为立即中断），但在撤销操作处的 toast 里写明“已中断 N 个进行中的任务”。

---

## W4. 审批幂等与回执（P1，借鉴点 4；依赖 W2）

### 目标

- 同一 run 里模型对**完全相同的外部动作**再次请求审批时，不再弹第二张卡：已批准且已完成 → 直接返回上次回执；已拒绝 → 直接返回拒绝（附“用户已拒绝过同样的操作”）。参数不同 → 新卡。
- 审批卡在执行后显示**结果回执**（已完成 / 失败 / 结果未知），用户能看到“批准的那件事最后怎样了”。
- 决定绑定内容：`approvals.decide` 可带 `payloadHash`，与服务端不符则拒绝。

### 借鉴什么 / 刻意不同

- 借 [R] `resolveDuplicateEffectGate`、[D] `createReviewed`（同草稿返回已有，不同草稿 409）、[M] `decide(id, hash)` 与 `outcome_unknown`。
- **不同**：
  - KepCup 的审批行 payload 创建后不可变、卡片按 id 取数据，所以 hash 绑定的收益有限——只作为防御（渲染端缓存了过期卡片 / 将来出现可编辑审批卡时）；**可选字段**，不强制。
  - 不做 30 分钟过期：KepCup 审批绑在 run 上，run 结束即 `cancelPendingForRun`，已有生命周期；`SURVIVES_RUN` 的 kind 维持现状。
  - 不加新 approval kind（避免重建 approvals 表），回执放 W2 的 `tool_effects` 行，卡片按 `approval_id` 反查。

### 设计

1. `approvals.request` 增可选 `effectKey`（由 recorder 在 external 工具的审批前通过 `tool-call-scope` 的 AsyncLocalStorage 提供，工具代码不需改）。
2. 去重门：`request` 时若同 `run_id` 链（含 continuation 链）上存在相同 `effect_key` 前缀（不含 occurrence）的行：
   - `completed` → 不建卡，工具得到 `DUPLICATE_EFFECT`，文案“相同操作已在本任务中完成（回执：…），不要重复执行”；
   - `denied` → 返回拒绝，文案“用户已拒绝相同操作”；
   - `uncertain` → **仍建卡**，但卡片顶部标“上次同样的操作结果未知，请先确认是否已生效”；
   - 模型确实需要重复执行（例如发两条同样的消息）→ 工具参数里本就会有差异；若真完全相同，靠用户在 `uncertain` 卡上决定。对 `completed` 的情形给模型提示“如确需再做一次，用 ask_user 征得用户同意”。
3. `approvalsDecideInputSchema` 增 `payloadHash?: string`；`approvalSchema` 输出增 `payloadHash`（`sha256(stableJson(payload))`，计算不落库）；不符 → `APPROVAL_STALE`。
4. 卡片回执：`approvals.list/describe` 输出增 `effect?: { status, receipt?, settledAt? }`（core 跨库查 `tool_effects where approval_id=?`）；`ApprovalCard.svelte` 底部显示状态行。
5. 精确卡片：核对 `mcp_tool` 卡展示的 `argsSummary≤400`——对“发送类”工具（名字或 W5 风险为 write/destructive 且参数里有 `to/recipient/channel/email` 等键）把这些键**完整**列在卡片上，不参与截断。

### 改动清单

- [ ] `packages/core/src/permissions/approvals.ts`：effectKey 去重门、payloadHash 校验、describe 带 effect
- [ ] `packages/core/src/agent/effects/recorder.ts`：审批前暴露 effectKey；审批结果回填 approval_id
- [ ] `packages/core/src/gateway/index.ts` `mcpToolCall`：收件人类字段完整展示
- [ ] `packages/shared/src/rpc/methods.ts`、`domain/types.ts`：decide `payloadHash?`、approval 输出 `payloadHash`、`effect?`
- [ ] `apps/desktop/src/renderer/src/lib/features/**/ApprovalCard.svelte`（`rg -l ApprovalCard apps/desktop/src` 定位）：回执行、“上次结果未知”提示、决定时回传 hash

### 迁移 / 兼容

无 main.db 迁移；依赖 W2 的 runs 表。旧审批无 effect → 不显示回执行。

### 测试

- `node scripts/run-tests.mjs run packages/core/test/integration/approvals.test.ts -t effect`（新增：completed 去重、denied 去重、uncertain 建卡带提示、参数不同建新卡、hash 不符拒绝）
- `node scripts/run-tests.mjs run packages/core/test/integration/mcp.test.ts`
- e2e：`pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/approvals.spec.ts`
- 改了 shared 契约 → 本项收尾跑一次全量。

### 验收

- fake model 连续两次调用同一 MCP 写工具同参数：第一次弹卡并执行，第二次不弹卡、拿到 `DUPLICATE_EFFECT`。
- 卡片执行后显示“已完成 / 结果未知”。

### 风险

- 去重误伤合法重复：只在**同一任务链**内去重；跨任务不去重。

---

## W5. MCP 工具风险分级、逐工具策略与只读工具进对话轮（P0，借鉴点 3；提前落地 D73 的分级器）

### 目标

1. 只读 MCP 工具默认免审批（体验），写/破坏性工具默认审批（安全），用户可逐工具覆盖。
2. 只读 MCP 工具**可以出现在对话轮与只读子代理的工具面**（已定：允许），对话轮能直接查询，不必为一次只读查询起任务。
3. **无人值守下 MCP 工具调用自动批准执行**（已定：自动豁免，不拒绝、不排队），同时在 **Bot 详情（右栏）的 MCP 设置区**常驻提示这一点与风险。应用尚无迁移期，**按最终逻辑统一处理**，不为老配置做过渡或特殊豁免。
4. 同一个 `classifyRisk` 以后直接给 D73 连接应用用。

> 解读（决定原文“自动豁免……提示MCP工具在无人值守时自动批准执行……按最终正确的逻辑处理”）：理解为**所有风险档的 MCP 工具在无人值守下都自动批准**（即保留当前 `#autoDecideSync` 对 `mcp_tool` 的行为并把它定为正式设计），不再设计“无人值守拒绝 / 排队 / 逐工具无人值守白名单”；收紧手段只剩风险提示与审计。D73 文档里“无人值守不自动批准 destructive”的计划与此冲突——连接应用按 D73 定义就是 MCP server，回写 D73 时以本决定为准。

### 借鉴什么 / 刻意不同

- 借 [D] `connections.ts`：`readOnlyHint===true` → 只读；`requiresApproval = prior ?? !readOnly`；逐工具覆盖在刷新工具列表后保留。
- 借 [R] `action-approval.ts`：名字动词正则（READ_ONLY / MUTATING / COMPOUND `_and_` / `_or_` / `_then_`）**只能升级风险，不能降级**（`connectorToolRequiresApproval`：声明只读也不能放过一个名字像写操作的工具）。
- 借 [R]：规则优先级 tool > server > 类别默认。
- **不同 / 不学**：
  - **不学 Rakazo 的 `APPROVAL_EXEMPT_TOOLS`（shell / write_file 免审批）**——它的边界是容器，KepCup 跑在用户主机上，沙箱/授权体系不放松（§5 护栏 2）。
  - 不学 Rakazo 的“无人值守白名单”（`UNATTENDED_SAFE_BUILTIN_TOOLS` 一类）：KepCup 的无人值守是用户开关（D53），开了就表示用户接受自动批准；我们只把风险说清楚（提示 + 审计里标风险档）。
  - annotations 是 server 自报的，不可信 → 只用来**放宽到“只读”**，且受名字正则一票否决；`destructiveHint===false` 只把默认从 destructive 降到 write，不免审批。

### 设计

1. **分级器**（新 `packages/core/src/mcp/risk.ts`；D73 落地时移到共享位置或直接复用）：

   ```ts
   export type ToolRisk = 'read' | 'write' | 'destructive';
   export interface ToolRiskInput { name: string; annotations?: ToolAnnotations; }
   const READ_VERBS = /^(get|list|search|find|read|fetch|query|lookup|describe|view|show|count|check|stat)(_|$)/i;
   const MUTATING_VERBS = /(^|_)(create|update|delete|remove|send|post|put|patch|write|set|add|move|rename|archive|publish|submit|pay|transfer|invite|share|merge|close|cancel|approve|reply|forward|upload|exec|run)(_|$)/i;
   const COMPOUND = /_(and|or|then)_/i;
   export function classifyRisk(t: ToolRiskInput): ToolRisk {
     const nameMutating = MUTATING_VERBS.test(t.name) || COMPOUND.test(t.name);
     if (t.annotations?.readOnlyHint === true && !nameMutating) return 'read';
     // 已定：无注解但名字是明确只读动词 → 视为只读
     if (t.annotations?.readOnlyHint === undefined && READ_VERBS.test(t.name) && !nameMutating) return 'read';
     if (t.annotations?.destructiveHint === false) return 'write';
     return 'destructive';
   }
   ```
   与 D73 计划规则一致（read / write / destructive 三档），多了“名字一票否决”和“无注解但名字明确只读 → read”。`readOnlyHint === false`（显式声明非只读）永远不走名字放宽。
2. **配置**（`mcpServerSchema` 扩展，向后兼容）：

   ```ts
   toolPolicies?: Record<string /*toolName*/, {
     approval?: 'auto' | 'ask';   // 覆盖默认（默认：read→auto，其余→ask）
     enabled?: boolean;           // 默认 true；false 则不暴露给模型
   }>;
   ```
   - 旧字段 `autoApprove: true` 语义保持：等价于该 server 所有工具 `approval:'auto'`（逐工具 `ask` 可再收回）。
   - 覆盖按工具名存，刷新工具列表后仍在（[D] 的做法）；工具消失时保留配置但设置页标灰。
   - 不设逐工具“无人值守”开关（见上方解读）。
3. **审批路径**（`gateway.mcpToolCall`）：
   - 有人值守时决定顺序：tool policy > server `autoApprove` > 类别默认（read→auto，write/destructive→ask）。
   - 每次调用都**重新解析**工具风险（[D] `connection-tools.ts` 的做法：工具列表刷新后注解可能变），不只用构建工具面时的快照。
   - 需审批时 payload 增 `risk: ToolRisk`（`mcpToolApprovalPayloadSchema` 加可选字段，**不加新 kind，不重建表**）；卡片按 risk 显示徽标（只读 / 写入 / 破坏性），破坏性用警示色。
4. **无人值守**（`approvals.ts` `#autoDecideSync`）：`mcp_tool` **保持自动批准**（所有风险档），行写 `auto_approved=1`，payload 带 `risk`；执行记录与审计 `mcp_tool_call` 写“无人值守自动批准（写入 / 破坏性）”，便于事后追查。代码里把这一分支从“隐式落空”改成显式分支 + 注释引用本决定，并加测试锁定。
5. **只读 MCP 工具进只读工具面**（已定：允许）：
   - `packages/core/src/tools/index.ts`：对话轮工具面与只读子代理（`buildSubagentResearchTools` / `task-subagent-read-only` 所用的面）加入该 Bot 可用 MCP 工具中 **`risk==='read'` 且有效审批为 `auto`** 的工具（被用户改成 `ask` 的只读工具不进对话轮——对话轮是秒级的，不在对话轮里等审批）。
   - 调用时二次校验：若此刻解析出的风险已不是 read，或有效审批变成 ask → 返回 `RUN_READ_ONLY`，提示“该工具需要在任务中执行，请用 start_task”。
   - 工具说明 token 成本：对话轮每次请求都带这些 schema。若某 Bot 的只读 MCP 工具超过 20 个，只放前 20 个（按 server 顺序）并在系统提示里说明“更多 MCP 工具在任务中可用”。（20 为初值，写成常量 `TURN_MCP_READ_TOOLS_MAX`。）
6. **Bot 详情（右栏）MCP 区风险提示**（已定）：`apps/desktop/src/renderer/src/lib/features/bot-panel/BotProfileForm.svelte` 的 MCP server 勾选区，只要该 Bot 选了任一 MCP server，就**常驻**一行提示：“无人值守模式下，MCP 工具调用会自动批准执行（包括写入、删除类操作），请注意风险。”；无人值守当前生效且选中 server 中含 write/destructive 工具时，提示升级为警示色并列出数量（“其中 N 个写入 / 破坏性工具”）。
7. **设置页**：MCP server 详情增“工具”列表（名字、风险徽标、判定来源=注解/名字、审批 auto/ask、启用两个开关）。`rg -l "autoApprove" apps/desktop/src/renderer` 定位现有 MCP 设置组件。

### 改动清单

- [x] `packages/core/src/mcp/risk.ts` + 单测 （2026-10-09 完成）
- [x] `packages/shared/src/domain/types.ts`：`mcpServerSchema.toolPolicies?`、`mcpToolApprovalPayloadSchema.risk?`；新 RPC（若渲染端要拿风险档）`mcp.toolRisks: { input:{ serverId }, output:{ tools: {name, risk, source}[] } }` （2026-10-09 完成）
- [x] `packages/shared/src/constants.ts`：`TURN_MCP_READ_TOOLS_MAX = 20` （2026-10-09 完成）
- [x] `packages/core/src/mcp/service.ts`：缓存每工具 annotations，暴露 `riskOf(serverId, toolName)` （2026-10-09 完成）
- [x] `packages/core/src/mcp/tools.ts`：`enabled:false` 的工具不注册；调用时重新解析风险 （2026-10-09 完成）
- [x] `packages/core/src/tools/index.ts`：对话轮 / 只读子代理工具面加入只读 MCP 工具 （2026-10-09 完成）
- [x] `packages/core/src/gateway/index.ts` `mcpToolCall`：决定顺序 + payload.risk + 审计写风险档 （2026-10-09 完成）
- [x] `packages/core/src/permissions/approvals.ts`：`#autoDecideSync` 显式 mcp_tool 自动批准分支；`renderContextLine` / `describe` 显示风险 （2026-10-09 完成）
- [x] 渲染端：`BotProfileForm.svelte` 风险提示、MCP 设置组件工具列表、`ApprovalCard.svelte` 风险徽标、`zh-CN.ts` （2026-10-09 完成）

### 迁移 / 兼容

- settings 是 JSON（`mcpServerSchema` 存在 settings 里，写之前核实存储位置），新增可选字段，零迁移。
- 无过渡期逻辑（已定）：升级后所有 server 按新规则——只读工具默认免审批（对老配置是放宽），写工具仍按旧的 `autoApprove` 决定，无人值守行为不变。

### 测试

- 新单测 `packages/core/test/unit/mcp-risk.test.ts`：注解 × 名字 的真值表（`readOnlyHint:true` + `delete_x` → destructive；`get_and_delete` → destructive；无注解 `list_files` → read；`readOnlyHint:false` + `get_x` → destructive；`destructiveHint:false` + `create_issue` → write）。`node scripts/run-tests.mjs run packages/core/test/unit/mcp-risk.test.ts`
- `node scripts/run-tests.mjs run packages/core/test/unit/mcp-tools.test.ts`
- `node scripts/run-tests.mjs run packages/core/test/integration/mcp.test.ts`（read 免审批、write 弹卡、policy 覆盖、`enabled:false` 不暴露、调用时风险变化被重新解析）
- `node scripts/run-tests.mjs run packages/core/test/integration/mcp-loop.test.ts`（对话轮可调只读 MCP 工具；调写工具 → `RUN_READ_ONLY`；只读工具被改成 ask 后不在对话轮面）
- `node scripts/run-tests.mjs run packages/core/test/integration/task-subagent-read-only.test.ts`（只读子代理可调只读 MCP 工具）
- `node scripts/run-tests.mjs run packages/core/test/integration/approvals.test.ts -t unattended`（无人值守下 read / write / destructive 均自动批准，`auto_approved=1` 且 payload 带 risk）
- 渲染端提示：BotProfileForm 若无组件测试，在 e2e `apps/desktop/test/e2e/approvals.spec.ts` 或新 spec 里断言提示文案出现（`pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/approvals.spec.ts`）
- 改了 shared 契约 → 本项收尾跑一次全量。

### 验收

- 接入一个带注解的 MCP server：只读工具直接执行、写工具弹卡且卡上有风险徽标。
- 直聊里问一个只读 MCP 能答的问题，对话轮直接调用，不起任务。
- 开无人值守：写工具自动执行，执行记录写明“无人值守自动批准（写入）”。
- Bot 详情 MCP 区可见风险提示；开无人值守时变为警示样式。

### 风险

- 正则误判：只会把工具判得更严（多弹卡），不会更松；用户可逐工具覆盖。
- “无注解 + 只读动词名 → 只读”放宽了一档：名字叫 `get_` 却有副作用的工具会被免审批执行。缓解：名字含任一写动词即否决；设置页显示判定来源“按名字推断”，用户可改 `ask`。
- 恶意 server 自报 `readOnlyHint` → 名字一票否决只能挡住名字诚实的；结果仍包 `<untrusted>`。
- 对话轮工具面变大 → 每轮 token 增加，且对话轮可读外部数据（外部内容注入面增大）：结果一律 `<untrusted>`；数量上限 20。
- 无人值守自动批准写 / 破坏性 MCP 工具是有意保留的风险，靠提示与审计兜底（§5 护栏 7）。

### 实施记录（2026-10-09）

- **分级器**：`packages/core/src/mcp/risk.ts` 导出 `ToolRisk` / `ToolRiskSource`（= shared `McpToolRisk` / `McpToolRiskSource`）、`ToolRiskInput`、`ToolRiskDetail`、`classifyRisk`、`classifyRiskDetailed`（另带判定来源 annotation / name / default）、`normalizeToolName`、`nameLooksMutating`、`nameLooksReadOnly`。**偏差（只会更严）**：名字先归一化（camelCase / kebab / 点号 → 下划线小写）再套动词正则，`deleteFile`、`send-mail` 同样被否决（原方案只认下划线）；相应地 `getUser` 这类无注解驼峰只读名也按名字推断为 read。
- **策略**：新 `packages/core/src/mcp/policy.ts`（`effectiveMcpApproval` / `decideMcpTool` / `mcpToolEnabled` / `allowedOnReadOnlySurface`）。shared 增 `mcpToolRiskSchema`、`mcpToolRiskSourceSchema`、`mcpToolPolicySchema`；`mcpServerSchema.toolPolicies?` 存在 settings 单行 JSON（`settings.value_json`，已核实），零迁移。
- **调用时重新解析**：网关依赖由 `mcpAutoApprove(serverId)` 换成 `mcpToolDecision(serverId, toolName)`（start.ts：每次调用重读 settings + `mcp.resolveRisk`——工具列表失效 / 过期则先刷新）。停用的工具调用时拒绝（`MCP_TOOL_NOT_FOUND`）；对话轮 / 子代理（loopType `turn` / `subagent`）调用非「只读 + auto」工具 → `RUN_READ_ONLY`（对话轮文案「该工具需要在任务中执行，请用 start_task」）。审计 `mcp_tool_call` 记 `risk / riskSource / approval(auto|user|unattended) / approvalSource / unattendedAutoApproved`，无人值守时另记 `note:「无人值守自动批准（写入 / 破坏性）」`；`approval_auto` 审计记 `risk`；mcp_tool 的折叠上下文行写「无人值守自动批准（写入）」。
- **工具面**：orchestrator 对话轮也解析 MCP 工具，但最多等 `TURN_MCP_RESOLVE_TIMEOUT_MS = 3000`（新常量；对话轮是秒级的，超时本轮不带 MCP 工具，连接后台继续）；只读子代理拿同一份只读工具（按子 run 身份包装）。对话轮系统提示新增 `<mcp_tools>` 段（仅 Bot 选了 MCP server 时）：本轮可直接调用的只读工具数 + 「更多 MCP 工具在任务中可用，用 start_task」。注：对话轮现在会触发 MCP server 懒连接，连接失败计入 `MCP_RECONNECT_MAX`。
- **未改**：`writes:false` 的只读任务仍拿全部 MCP 工具（写工具照常弹卡）——本项只收紧对话轮与子代理；是否让只读任务也只用只读 MCP 工具另行决定。
- **渲染端**：`features/approvals/McpRiskBadge.svelte`、`features/approvals/mcp-risk.ts`（纯函数）；设置页每个 server 增「工具与审批」展开（`features/settings/McpToolPolicies.svelte`：风险徽标、判定来源、审批 默认 / 免审批 / 每次确认、启用；已消失的工具标灰）；新 RPC `mcp.toolRisks`（输出另含 `description`、`missing`、可选 `error`；应用级未启用的 server 用一次性连接）。`ApprovalCard` 的 mcp_tool 卡原先落到通用「命令」分支（显示空命令），现有专用正文（服务器 · 工具、参数）+ 风险徽标，破坏性加警示条。
- **测试**：BotProfileForm 提示没有组件测试设施（渲染端只有纯 .ts 单测），改为 `apps/desktop/src/renderer/src/lib/features/approvals/mcp-risk.test.ts` 锁定提示逻辑；**e2e 未加**（与并行的 W1 会话共用 `apps/desktop/out` 构建产物，未跑 `pnpm build`）。改了 shared 契约，按约定需跑一次全量——留到 P0 收尾统一跑。
- **复查后修正（2026-10-09）**：
  - `McpService` 连接去重：进行中的连接按 server 存 `#pending`，并发的 listTools / callTool / resolveRisk 共用一次连接（不再起第二个进程、留下孤儿 client）；`closeAll` 先等进行中的连接落定。
  - 重连预算（`MCP_RECONNECT_MAX`）只由任务与工具调用消耗：对话轮解析工具面（`resolveMcpToolEntries({countFailures:false})`）与设置页 / Bot 详情的 `mcp.toolRisks` 不计数；`resolveRisk` 只在连接在线时刷新注解（随调用 signal 中止、最多 5 s），离线时直接用已知注解（没见过的工具按 destructive），不为判定风险去连接；已停用（failed）的 server 对所有路径都不再连。
  - `mcpToolDecision` 改为 `{botId, serverId, toolName, signal}`：server 应用级已停用、或 Bot 已不再勾选它 → `enabled:false`（进行中的任务也不能再调）。
  - 写动词否决表扩充：execute / invoke / trigger / drop / insert / edit / modify / clear / reset / revoke / kill / save / toggle / enable / disable / buy / check_in（checkIn）任意位置否决；也常作名词的 commit / push / deploy / install / import / sync / start / stop / mark / order / book / grant 只在名字开头否决（`get_commit`、`get_order`、`get_sync_status` 仍是读）。
  - 对话轮 `<mcp_tools>` 段改为稳定注入：Bot 选了 MCP server 就有（含本轮未能及时取到工具列表时），数量已知时再附可直接调用 / 只在任务中可用的个数。
  - Bot 详情提示：`mcp.toolRisks` 出错或请求失败按「无法确认工具风险」处理（无人值守时警示样式），不再当作 0 个风险工具；只在选中的 server 集合或无人值守状态变化时重新查询。
  - 设置页编辑表单保存时合并当前的 `toolPolicies`（表单不编辑逐工具策略，不再用打开表单时的快照覆盖）。
  - 测试：mcp.test 增并发连接只起一个进程、预算计数；mcp-loop 的对话轮用例先预热连接（不依赖 3 s 内完成 stdio 连接），增「无人值守 → 真实网关 + ApprovalsService：写工具自动批准、auto_approved、payload.risk=write、审计 note」用例。

---

## W6. Bot 间消息 intent + 委派跟随任务（P1，借鉴点 1；含 DEV-012 方案二）

### 目标

1. A 给 B 发的东西有明确意图：**请求**（要结果）、**提问**（要答复）、**告知**（不需要回复）。
2. 委派结果不再是 B 的“我去做”，而是 B 为此起的任务的最终结果（DEV-012 方案二）。
3. 防止“写在回复里以为发出去了”和投递重放。

### 借鉴什么 / 刻意不同

- 借 [R] `message_bot{bot_id, confirm_name, message, intent: request|result|question|status|fyi}`、按 intent 的唤醒提示（result/status 必须转述实质、不许空确认；fyi 允许沉默；request 的终回复自动回传）、`deliveryKey` 防重放、`auto-outcome:{runId}` 自动回传、对端内容视为不可信。
- **不同**：
  - **不加 6 跳**：保留 D71 的单跳（B 处理委派时不能再委派），多跳编排复杂度和失控面不值得。
  - **不新增 `message_bot` 工具**（已定）：在 `delegate_to_bot` 上加 `intent`，避免两个相近工具让模型选错；`result`/`status` 两个 intent 在单跳下用不上（结果自动回传），只取 `request | question | fyi`。
  - `confirm_name`（发送前回填对方名字防选错）：KepCup 用 bot_id + 发出卡片已能让用户看到对象，**不加**。

### 设计

1. **工具 schema**（`tools/delegation-tools.ts`）：

   ```ts
   delegate_to_bot {
     bot_id: string;
     task: string;                                   // 仍叫 task，兼容
     intent?: 'request' | 'question' | 'fyi';        // 默认 'request'
   }
   ```
   - `fyi`：投递给 B 后**不建结果等待**，`delegations` 行直接 `delivered → settled(no_reply_expected)`；B 的唤醒提示：“这是 A 转告的信息，无需回复；只有需要用户知道时才回复”。B 若回复，正常作为 B 对话里的消息，不回贴 A。
   - `question`：B 的终回复（对话轮回复，不跟随任务）回贴 A——问题通常对话轮就能答。
   - `request`：走下面的“跟随任务”。
   - `delegations` 表增列 `intent`（见改动清单：因 status 要加新值，本就要重建表，intent 一并加入，不加 CHECK）。
2. **跟随任务（DEV-012 方案二）**（`dispatch/delegation.ts`）：
   - B 的委派对话轮结束时，查该轮 run 起的任务（runs.db `0006_tasks.sql` 的 `origin_run_id = 委派轮 run_id`）。
     - 无任务 → 现状：取对话轮回复作为结果。
     - 有任务 → 委派状态改 `awaiting_tasks`，记下任务 id 列表；对话轮的“我去做”**不**作为结果回贴（但仍在 B 的对话里显示）。
   - TaskHost 任务终态钩子：属于某委派的任务全部终态后，结果 = 各任务结果摘要拼接（每个截断，总长仍 ≤2000）（**已定** 2026-10-09；注意 DEV-012 方案二原文为“消费任务结果的下一个对话轮的最终回复”，本方案以拼接为准，回写 DEVIATIONS 时同步），失败/取消的任务标注状态；然后走既有的结果卡 + internal follow-up 给 A。
   - 任务被 `inject_task` 续接 / 重试（W3）产生的新任务：通过 `continuedByTaskId` 链跟随最终那个。
   - 超时：沿用委派现有超时（若无，按任务 4h 墙钟自然兜底）。
   - `cancel_delegation`：同时取消关联任务（调用既有 `cancel_task` 路径）。
3. **防重放**：投递用确定性 `delivery_key = delegationId`（`delegations` 已有 id），投递前查“B 对话里是否已有 `origin=delegation` 且 `delegation_id` 相同的消息”，有则跳过（崩溃重启后的重投防重复）。先核实 `dispatch/delegation.ts` 的崩溃一致性是否已覆盖，若已覆盖则只补测试。
4. **“写在回复里不算发送”**：A 的 prompt（委派工具说明 + 系统提示里委派段）加一句：“在回复里写‘我已经告诉 B 了’不会发给 B；要发给 B 必须调用 delegate_to_bot”。可选的检测器（回复里 @B 名字但本轮没调用委派工具 → 在执行记录写一条 system 提示）列为 P2，不做。
5. **B 侧唤醒提示**：按 intent 生成（照 [R] `bot-messages.ts` 的三段文案改写为中文）；A 的 follow-up 提示里对 `request` 结果强调“转述实质结果，不要只说‘B 已完成’”。

### 改动清单

- [ ] main.db 迁移：`delegations.status` 在 0016 里**有 CHECK 约束**，加 `awaiting_tasks` 必须重建 delegations 表（照 0016 重建 approvals 的写法：建 `_new` → 全列 INSERT…SELECT → DROP → RENAME → 重建索引），同时加 `intent TEXT NOT NULL DEFAULT 'request'`（不加 CHECK，由 zod 校验）与 `task_ids_json TEXT NOT NULL DEFAULT '[]'`
- [ ] `packages/shared/src/domain/types.ts`（或 `domain/delegations` 的 schema 所在处）：`intent`、`awaiting_tasks`、`taskIds`
- [ ] `packages/core/src/tools/delegation-tools.ts`：参数 + 说明
- [ ] `packages/core/src/dispatch/delegation.ts`：intent 分支、跟随任务、取消联动、防重投
- [ ] `packages/core/src/dispatch/tasks.ts`：终态钩子通知 DelegationHost
- [ ] 提示词：委派段（`rg -n "delegate_to_bot" packages/core/src/agent/prompt*` 定位）
- [ ] 渲染端 `delegation_sent` / `delegation_result` 卡：显示 intent、等待任务中状态

### 迁移 / 兼容

- 旧委派行 `intent='request'`；已在途的旧委派按旧逻辑结束（无 `taskIds` 即走对话轮回复）。
- 迁移编号取届时下一个空号（D73 预定 main 0021）。

### 测试

- `node scripts/run-tests.mjs run packages/core/test/unit/delegation.test.ts`
- `node scripts/run-tests.mjs run packages/core/test/integration/delegation-host.test.ts`（新增：B 起 1 个任务 → 结果为任务结果；起 2 个 → 拼接；任务失败 → 标注；fyi 不回贴；question 取对话轮；取消联动；重启不重投）
- `node scripts/run-tests.mjs run packages/core/test/integration/butler-delegation-migration.test.ts`（迁移）
- 有迁移 → 本项收尾跑一次全量。

### 验收

- 让 A 委派 B “查 X 并整理”，B 回“我去做”并起任务；A 收到的结果卡内容是任务产出，不是“我去做”。
- `fyi` 委派后 A 不会收到“B 已收到”之类的空回贴。

### 风险

- 跟随任务让委派等待时间变长（最长任务 4h）：A 侧卡片显示“B 正在执行任务…”并可取消。
- 与 D75 收尾时间耦合：DEV-012 写明“D75 收尾后再做”，**开工前确认 D75 已收尾**。

---

## W7. 确定性监看原语（P2，借鉴点 6；本轮仅网页来源）——延期（2026-10-09 用户决定）

### 目标

“盯着某个网页，变了才叫我”：检查本身**不花 LLM**，只有满足条件（边沿触发）才唤醒 Bot 一个对话轮；失败退避、连续失败暂停并通知；同一次变化不重复提醒。

**范围（已定）**：本轮只做**网页**来源。传感器维持现有麦克风能力（D76 渲染端 + 语音输入），不做 Bot 侧传感器监看；摄像头等其他来源后期处理（§4）。

> 解读（决定原文“维持麦克风能力即可，其它后期处理”）：理解为“不新增 Bot 侧传感器能力，现有麦克风能力保持不动”，而不是“本轮要把麦克风接成监看来源”——麦克风作为监看来源需要常驻录音与本地事件检测，体量和隐私面都远超“维持”。

### 借鉴什么 / 刻意不同

- 借 [M] `page-diff.ts` + `observe()`：页面按行 diff、去掉相对时间后的“安静 hash”、`contains` / `price` 条件**边沿触发**（上次不满足、这次满足才报）、`alertSequence`、通知键 `monitor:{id}:{seq}:{hash}` 去重、CAS 防并发、失败退避 `min(60, 2^failures)` 分钟、5 次暂停、错误通知键 `watch-error:{task}:{streak}:{paused|retry}`。
- **不同**：不引入服务端租约（单机单进程，用 SQLite 事务 + 进程内单 worker 即可）；不另起 Postgres。

### 设计

1. **数据**（main.db 新表 `watches`）：

   ```sql
   CREATE TABLE watches (
     id              TEXT PRIMARY KEY,       -- wat_…
     bot_id          TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     source_json     TEXT NOT NULL,          -- 本轮仅 {kind:'web_page', url, selector?}；kind 判别字段为后期传感器来源留口
     condition_json  TEXT NOT NULL,          -- {kind:'changed'} | {kind:'contains', text} | {kind:'not_contains', text} | {kind:'number_below'|'number_above', selector?, value}
     interval_sec    INTEGER NOT NULL,       -- 下限 300
     status          TEXT NOT NULL,          -- active | paused | stopped
     last_hash       TEXT, last_quiet_hash TEXT,
     last_matched    INTEGER NOT NULL DEFAULT 0,
     alert_seq       INTEGER NOT NULL DEFAULT 0,
     failures        INTEGER NOT NULL DEFAULT 0,
     next_check_at   INTEGER NOT NULL,
     version         INTEGER NOT NULL DEFAULT 0,  -- CAS
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   );
   ```
2. **检查器**：`web_page` 用 BrowserHost 的**独立后台页**（键 `botId|watch:{id}`，使用该 Bot 当前生效的浏览器资料——私有或 W8 的共享资料——复用登录态）取正文文本 → `pageLines` → `withoutRelativeTimes` → hash；条件求值；边沿触发时 `alert_seq++`，以 `watch:{id}:{seq}:{hash}` 为幂等键唤醒一个对话轮（trigger_reason=`watch`），消息里带 `describePageDiff` 的增删改摘要（≤1500 字）。
3. **失败**：`failures++`，`next_check_at = now + min(60, 2^failures) 分钟`；`failures>=5` → `paused` 并在对话里发一条系统卡片（键 `watch-error:{id}:{streak}:paused`），用户可点“恢复”。
4. **工具**（任务面与对话轮面都给，因为创建监看是“托管动作”，参照 D75 对 schedule 的处理，核实 schedule 工具在哪个面）：`watch_create{source, condition, interval_minutes}`、`watch_list`、`watch_stop{id}`。创建需要**用户可见卡片**（像 schedule 一样），不需审批（只读访问）。
5. **传感器来源（后期，不在本轮）**：摄像头等来源以后可做“帧感知 hash 变化 → 才调用多模态理解”，与此原语同构，届时只加 `source.kind='sensor'` 的检查器；本轮 zod schema 只接受 `web_page`。
6. 中文：不用 FTS / tokenizer，纯行 diff，不受 §5 护栏 5 影响。

### 改动清单（概要，开工前细化）

- [ ] main.db 迁移 `watches`；`packages/shared` schema + RPC `watches.list/pause/resume/stop`
- [ ] `packages/core/src/watch/{service,page-diff,conditions}.ts`
- [ ] `packages/core/src/tools/watch-tools.ts`；工具面注册
- [ ] `apps/desktop/src/main/browser-host.ts`：后台页 `fetchText(url)`（不显示、遵守 `decideBrowserRequest`）
- [ ] 渲染端：对话内监看卡 + 右侧面板列表

### 测试

- 新单测：`node scripts/run-tests.mjs run packages/core/test/unit/watch-page-diff.test.ts`、`node scripts/run-tests.mjs run packages/core/test/unit/watch-conditions.test.ts`（边沿触发、相对时间去噪、退避序列、5 次暂停、非 web_page 来源被 schema 拒绝）
- 新集成：`node scripts/run-tests.mjs run packages/core/test/integration/watch.test.ts`（fake clock + fake fetcher；同一变化不重复唤醒；重启后不重复）
- 后台页：`pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/browser.spec.ts`（`fetchText` 不显示窗口、受网络策略约束）
- 有迁移 → 收尾全量一次。

### 验收

- 监看一个价格页，价格从 100 跌到 90（条件 `<95`）唤醒一次；保持 90 不再唤醒；回到 100 再跌到 90 再唤醒一次。
- 页面只有“3 分钟前”变“4 分钟前”时不唤醒。

### 风险

- 后台抓页可能触发反爬 / 登录过期：失败退避 + 暂停通知已覆盖；间隔下限 5 分钟。

---


## W8. 浏览器自动接管 + 共享浏览器资料（P1，借鉴点 7）

### 目标

1. **自动接管**（已定：用户一操作即接管，不用点按钮）：用户在 Bot 浏览器查看窗口里点击或键入时，该页面控制权立即转给用户，Bot 的浏览器动作暂停，避免双方同时点；用户交还（或关闭窗口）后 Bot 继续。也给“需要用户登录 / 过验证码”提供正式的交接路径。
2. **共享浏览器资料**（已定：提供共享选项）：默认仍是每个 Bot 私有资料；用户可以显式建立“共享浏览器资料”，把多个 Bot 挂到同一份资料上，共用登录状态（对应上游 Team vs Private 电脑）。

### 借鉴什么 / 刻意不同

- 借 Rakazo / OpenDots 的 Team vs Private 电脑：**身份与资料是否共享要显式**。KepCup 已按 Bot 分 partition（`persist:bot-{botId}`），保持为默认；共享是用户主动选择，界面上写清后果。
- 借上游“人工接管”的交接语义。
- **不同**：
  - 共享的单位是“浏览器资料”（Electron partition，含 cookie、localStorage、IndexedDB），不是“按网站同步 cookie”——后者覆盖不了存在 localStorage 里的登录态，且同步时序复杂。
  - 不做团队 / 多用户共享电脑（§5 护栏 6）；共享资料只在本机本用户的 Bot 之间。
  - Bot 的网络策略（`decideBrowserRequest`）、记忆、委派隔离**不随资料共享而共享**，仍按 Bot 判断。

### 设计

**A. 自动接管租约**

1. `PageEntry` 增 `control: 'agent' | 'user'`。查看窗口打开时仍是 `agent`（只看）；用户在查看窗口内产生**点击或键盘输入**（`before-input-event` / `mouseDown`）→ 立即 `user`，工具条显示“你正在操作 · 交还给 Bot”。滚轮、移动鼠标、改窗口大小不算接管。
2. `control==='user'` 时，`click/type/press/scroll/back/open` 抛 `BROWSER_USER_CONTROL`（`phase:'pre'`，即 W1 的 `not_started`）；`snapshot/screenshot` 仍允许（Bot 可以看）。工具提示：“用户正在操作浏览器，等用户交还或用 ask_user 询问”。
3. 交还：工具条“交还给 Bot”按钮，或关闭查看窗口 → `agent`，并向该页面所属的进行中任务 inject 一条“用户已交还浏览器控制，先 browser_snapshot 再继续”（走既有 `inject_task` 宿主路径）。用户无操作 10 分钟自动交还（常量 `BROWSER_USER_CONTROL_IDLE_MS`），同样 inject。
4. 交接请求：在浏览器工具说明里加一条“需要登录 / 验证码时，用 ask_user 请用户在浏览器窗口完成”。`ask_user` 选项是否支持动作按钮（“打开浏览器”）开工时核实，不支持则只文案引导。
5. 接管只锁定**该页面**（`botId|conversationId`）；同一共享资料里其他 Bot 的页面不受影响。

**B. 共享浏览器资料**

1. 数据（零迁移）：
   ```ts
   // settings JSON
   browserProfiles?: Array<{ id: string /* bpf_… */; name: string; createdAt: number }>;
   // botRuntimeSchema（Profile JSON，与 mcp_server_ids 同处，无迁移）
   browser_profile: z.string().default('').catch('');   // '' = 私有（默认）；否则为共享资料 id
   ```
2. partition：私有 → `persist:bot-{botId}`（不变）；共享 → `persist:shared-{profileId}`。core 在 `ensurePage` / `navigate` 等 RPC 输入里带 `profileKey`（`bot:{botId}` 或 `shared:{profileId}`），browser-host 由它算 partition；`decideBrowserRequest` 仍按 `botId` 判断。
3. 切换：Bot 的 `browser_profile` 改变时关闭该 Bot 所有页面；若该 Bot 有使用浏览器的运行中任务，按 W3 的 `permission.revoked` 事件（`scope:'browser_profile'`）立即中断——身份在任务脚下变了，与“运行中撤销授权”同理。
4. 删除：
   - 删除 Bot：私有资料照旧 `clearBotData`；共享资料不动。
   - 删除共享资料：使用它的 Bot 先回到私有（同上切换规则），再清 `Partitions/shared-{id}` 目录（照 `clearBotData` 的墓碑写法）。
   - “清除数据”按钮：清共享资料存储但保留条目。
5. UI：
   - 设置 › 浏览器资料：列表（名称、使用它的 Bot、清除数据、删除）、新建、重命名。
   - Bot 详情（`BotProfileForm.svelte`）：“浏览器资料：私有（默认）/ 共享：xxx”下拉；选共享时显示警示“同一共享资料里的 Bot 共用所有网站的登录状态，其中任一 Bot 都能以你的身份操作这些网站”。
   - 新建的共享资料是空的；用户通过任一挂在上面的 Bot 的浏览器查看窗口登录（接管机制 A 正好用上）。不提供“从某 Bot 私有资料复制登录态”（partition 目录在使用中复制不安全）。

### 改动清单

- [ ] `apps/desktop/src/main/browser-host.ts`：control 状态、输入事件监听、空闲自动交还、工具条 IPC；`profileKey → partition`；共享资料清除
- [ ] `packages/shared/src/domain/types.ts`：`botRuntimeSchema.browser_profile`、settings `browserProfiles`
- [ ] `packages/shared/src/rpc/methods.ts`：browser 输入带 `profileKey`；`browserProfiles.list/create/rename/delete/clear`
- [ ] `packages/shared/src/constants.ts`：`BROWSER_USER_CONTROL_IDLE_MS = 600_000`
- [ ] `packages/core/src/browser/facade.ts` / port-B：解析 Bot 生效资料；控制权变化事件 → core（用于 inject）
- [ ] `packages/core/src/tools/browser.ts`：`BROWSER_USER_CONTROL` 提示；`ask_user` 引导文案
- [ ] `packages/core/src/dispatch/tasks.ts`：`browser_profile` 变化 → `permission.revoked`（复用 W3）
- [ ] 渲染端：设置页“浏览器资料”区、`BotProfileForm.svelte` 下拉与警示、查看窗口工具条文案（按 i18n 放渲染端再传入，参照 `browser:show` 的 title 传法）、`zh-CN.ts`

### 迁移 / 兼容

零数据库迁移。老 Bot 的 `browser_profile` 缺省为 `''` → 私有，行为不变。

### 测试

- `node scripts/run-tests.mjs run packages/core/test/unit/browser-tools.test.ts -t USER_CONTROL`
- `node scripts/run-tests.mjs run packages/core/test/integration/browser.test.ts`（profileKey 解析：私有 / 共享；切换资料关闭页面；运行中任务被中断）
- `node scripts/run-tests.mjs run packages/core/test/integration/tasks.test.ts -t revoke`（`scope:'browser_profile'`）
- e2e：`pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/browser.spec.ts`（打开查看窗口、模拟点击 → Bot 点击被拒、交还后成功；两个 Bot 挂同一共享资料 → A 页面设置的 cookie B 可见；私有 Bot 不可见；删除共享资料后目录被清）

### 验收

- 用户在查看窗口里点一下，Bot 下一次点击得到 `BROWSER_USER_CONTROL`；点“交还”或关窗后 Bot 继续并先快照。
- 两个 Bot 挂同一共享资料，在其中一个的查看窗口登录某网站后，另一个打开该网站已是登录状态；第三个私有 Bot 不是。

### 风险

- 误把“只是看看”当接管：只有点击 / 键盘算接管；空闲 10 分钟自动交还。
- 共享资料扩大了单个 Bot 被提示注入后的危害面（可借其他 Bot 的登录身份操作）：默认私有、界面警示、网络策略仍按 Bot；与 §5 护栏 6 的表述同步。

---


## 4. 本方案不做（非目标）

- 不实现 D67 的 durable resume（只做 W2 台账；续跑仍是 D67 的事）。
- 不做多跳 Bot 消息（> 1 跳）、不做 `handoff_to_bot`（会话转移）；**不新增 `message_bot` 工具**（已定：在 `delegate_to_bot` 上加 `intent`）。
- 不做 `act` 批量浏览器动作、不换 isolated-world 引用模型；快照元素上限**维持 150**，不改为 80。
- 不做 saved-login / `fill_secret`（凭据按 origin 绑定自动填充）——留给 D52 凭据体系后续单列。共享登录走 W8 的“共享浏览器资料”，不走凭据填充。
- 不做按网站同步 cookie、不做“从 Bot 私有资料复制登录态到共享资料”（W8）。
- 不做团队工作区 / 多用户。
- 不做无人值守下 MCP 的拒绝 / 排队 / 逐工具白名单（已定：无人值守下 MCP 自动批准，靠提示与审计）；不为老配置做迁移期过渡。
- 不做 Bot 侧传感器能力与传感器监看来源（摄像头等后期处理）；现有麦克风能力维持不动。
- 不做记忆导出 / 版本历史 / 导入（原 W9，2026-10-09 用户决定不做，已删除）；不做记忆云同步、不把记忆存储换成文件。
- **语音对话模式暂不立项**（不写代码、不出设计稿）。仅记下以后立项时的分工原则：实时语音层 = 对话轮（快、只读、可打断），重活 = 任务（`start_task`，完成后 `generate_speech` 播报摘要），不另造 [D] `voice.ts` 的 `ask_compute`；不默认依赖云端实时语音（§5 护栏 1）。
- 不改 D73 连接应用的 OAuth / 目录部分；W5 只提前落地分级器与 MCP 审批策略。

## 5. 护栏（“不要学”清单）

实施任何一项时，以下行为一律不引入；代码评审按此逐条检查：

1. **不依赖托管服务、默认不开遥测**。上游（尤其 Rakazo）默认连自家服务、全量遥测；KepCup 是本地应用，任何新功能离线可用，需要联网的（监看）只访问用户指定的目标。
2. **不照搬 Rakazo 的 shell / write 免审批**（`APPROVAL_EXEMPT_TOOLS`）。它的边界是一次性容器；KepCup 在主机上跑，srt 沙箱 + 路径授权 + 数据目录底线一个都不放松。W5 的“只读免审批”只适用于 MCP 只读工具；W5 的“无人值守自动批准”只适用于 `mcp_tool`，不外溢到 command / unsandboxed / git_remote / agent_tool 的数据目录底线。
3. **不把待办队列放在客户端**。follow-up / 委派结果 / 监看唤醒 / 导入预览全部由 core 持有（持久化的进 SQLite），渲染端只展示；渲染进程刷新或崩溃不能丢消息。
4. **桌面应用不引入 Docker / Postgres 依赖**。新表进既有加密 SQLite（main / runs / memory）；测试可用 Docker 镜像，产品运行时不行。
5. **中文检索不用 `'simple'` 类分词**。新增的任何全文检索沿用现有 FTS 配置（unicode61 + 现有分词入库）+ 向量检索，或不做 FTS（W7 用行 diff）。
6. **共享不等于安全边界**。不引入“团队工作区”的模型。W8 的共享浏览器资料是**用户显式选择、默认关闭**的例外，只共享浏览器存储；挂在同一资料上的 Bot 之间**不视为隔离**（界面明示）；其他隔离（`private_to_bot`、单跳委派、对端内容 `<untrusted>`、按 Bot 的网络策略）保持为硬边界。
7. 额外：**server 自报的注解只能放宽到只读、且受名字一票否决**（W5）；**任何“结果未知”都不得自动重放**（W1/W2/W3）；**无人值守自动批准的 MCP 调用必须带风险档进审计**（W5），Bot 详情 MCP 区必须常驻风险提示。

## 6. D 编号（已确认）

现行约定：`docs/design/README.md` 决策表按顺序编号，最新为 **D76**（传感器）。本方案的编号已由 Pengfei 确认；回写设计文档时如发现已被其他会话占用，再顺延并同步改本节。

| 编号 | 内容 | 备注 |
|---|---|---|
| D77 | 浏览器动作结局三态（not_started / completed / uncertain）、ref 指纹预检、无进展熔断、敏感输入脱敏、元素上限维持 150；自动接管租约与共享浏览器资料（W1 + W8） | 修订 P11 浏览器 |
| D78 | 外部副作用台账 `tool_effects`、中断任务检查后重试、运行中撤销授权立即中断、审批幂等与回执（W2 + W3 + W4） | 标注为 D67 第一步；修订 D49 中断任务的重试规则 |
| —（D65 修订） | MCP 工具风险分级、逐工具策略、只读 MCP 工具进对话轮 / 只读子代理、无人值守自动批准 + Bot 详情风险提示（W5） | 不新开号；D73 引用同一分级器，并按本决定修正其无人值守规则 |
| —（D71 修订） | 委派 intent（request / question / fyi）+ 跟随任务（W6） | 对应 DEV-012 方案二 |
| D79 | 确定性监看原语，本轮仅网页来源（W7） | P2 |
| — | 语音前端分工 | 暂不立项，无编号（§4） |

## 文件路径速查

| 用途 | 路径 |
|---|---|
| 浏览器工具 | `packages/core/src/tools/browser.ts` |
| 浏览器宿主 | `apps/desktop/src/main/browser-host.ts` |
| 浏览器 facade / RPC | `packages/core/src/browser/facade.ts`、`packages/shared/src/rpc/methods.ts`（约 1066 行） |
| 快照摘要 | `packages/shared/src/browser/axtree.ts`、`packages/shared/src/constants.ts` |
| 工具执行 | `packages/core/src/agent/tool-execution.ts`、`pi-engine.ts`、`external/mcp-bridge.ts`、`types.ts` |
| 步骤落库 / 续接摘要 | `packages/core/src/agent/step-persistence.ts`、`agent/context/continuation.ts` |
| 任务 | `packages/core/src/dispatch/tasks.ts`、`apps/desktop/src/renderer/src/lib/features/tasks/{task-view.ts,TaskCard.svelte}` |
| 审批 / 授权 | `packages/core/src/permissions/{approvals,grants,unattended,tool-call-scope}.ts`；RPC `grants.revoke`（methods.ts:1276）、`runs.retry`（:1258） |
| MCP | `packages/core/src/mcp/{service,tools}.ts`、`packages/core/src/gateway/index.ts`（约 787 行） |
| 工具面 | `packages/core/src/tools/index.ts` |
| 工具注解词表 | `packages/core/src/agent/external/capabilities.ts` |
| Bot 详情（MCP 区、浏览器资料） | `apps/desktop/src/renderer/src/lib/features/bot-panel/BotProfileForm.svelte`；Bot 运行配置 `botRuntimeSchema`（`packages/shared/src/domain/types.ts`） |
| 无人值守 UI | `apps/desktop/src/renderer/src/lib/features/settings/UnattendedSection.svelte`、`features/approvals/UnattendedBanner.svelte` |
| 委派 | `packages/core/src/tools/delegation-tools.ts`、`dispatch/delegation.ts`、`domain/delegations.ts`、`migrations/main/0016_butler_and_delegation.sql` |
| 定时 | `packages/core/src/schedule/service.ts` |
| 记忆 | `packages/core/migrations/memory/{0001_p07_memory,0002_p09_wiki_fts}.sql`、`packages/core/src/memory/{store,profile-store}.ts` |
| 迁移目录 | `packages/core/migrations/{main,runs,memory}`（main 0020、runs 0008、memory 0002；D73 预定 main 0021 / runs 0009） |

## 风险与注意

- **工作树很脏 / 有并行会话**：另一会话在改大量 docs / todo / 代码与测试。实施时不要顺手“修”别人的改动；跑定向测试遇到无关文件的失败先确认是否与本项相关。
- **迁移编号冲突**：W2（runs）、W6 / W7（main）与 D73 抢号，写迁移前 `ls` 一次取实况。
- **approvals 表 CHECK**：本方案刻意不加新 kind；若实施中发现非加不可，照 0015/0016 重建并带上全部 11 个既有 kind。
- **delegations 表 CHECK**：W6 必须重建（status 加 `awaiting_tasks`），照 0016 写法带全列。
- **D75 收尾依赖**：W6 的跟随任务依赖 D75 任务模型稳定，开工前确认 `todo/supervisor-and-tasks.md` 状态。
- **W3 与 W8 共用 `permission.revoked`**：W8 的“切换浏览器资料 → 中断”依赖 W3 P1 的中断机制，W8 排在 W3 P1 之后或同批做。
- **全量测试次数**：每个阶段（P0 / P1 / P2）收尾**只跑一次**全量，而不是每项一次。

## 完成定义

- [x] P0（W1、W2、W5、W3-P0）全部 `- [ ]` 打勾，定向测试通过，P0 收尾跑一次全量 `pnpm test` 通过。（2026-10-09 完成：每项均经独立复查并修正；收尾全量 1986 例 / 28 条失败，失败集合与 D75 后容器基线一致（sandbox-isolation 10、skills-authoring 4、env-distro-toolchain 3、skills 3、workspace-tools 3、toolchain-sandbox 2、wiki-url 2、projects 1）；另 1 条 `create-core`「applies the settings migration」因 runs 版本号写死为 8，已改为 9 并单跑通过。`pnpm typecheck` / `pnpm lint` 通过；W1 e2e `browser.spec` 10/11，失败为基线「删除 Bot 后其浏览器分区数据不存在」。）
- [ ] P1（本轮：W3-P1、W6；W4、W8 暂缓）同上，收尾全量一次。
- [ ] P2（W7）同上，收尾全量一次。——W7 延期；原 W9 已删除（2026-10-09）
- [ ] 交付说明列出每项新增 / 修改的文件，供 Pengfei 回写设计文档（D 编号见 §6）。
- [ ] 全程无 push / PR（提交已获用户授权，见文首）。
