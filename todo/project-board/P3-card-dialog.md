# P3 · 卡片弹框与收口：详情弹框、对话区、徽标、通知深链、e2e、文档同步

> 设计 WP：**WP4 + WP5**。依赖：**P2 已合入**（`ChatSession`、`card` 会话、`BoardService` 执行方法、`board.summary`）。分支：`feat/board/p3-card-dialog`。
> 先读 [README.md](README.md) §1、§4；设计依据 [docs/design/50-project-board.md](../../docs/design/50-project-board.md) §6.4（状态派生与操作）、§9.1（外壳集成）、§9.4（卡面）、§9.8（弹框）、§10、§13、§14；前两阶段的实施记录（[P1](P1-board-skeleton.md) §7、[P2](P2-card-conversation.md) §11）。

## 1. 目标

把前两阶段的能力接成完整功能：

- **卡片弹框**（设计 §9.8）：上工具栏（「任务详情」+ 执行成员头像）/ 中部左右（左：文本 + 执行记录；右：与执行成员的卡片对话，复用单聊组件）/ 下工具栏（时间、状态、metadata 与主操作）；窄容器改 tab。
- **卡面**补页脚（执行成员、派生状态、时间）与徽标（未读 / 待审批 / 等你回答 / 受阻原因）。
- **看板 tab 徽标**、**通知与各处「打开会话」的深链**（卡片会话永不进侧栏，跳转一律落到「项目 → 看板 → 卡片」）。
- **收口**：项目详情页（定时与监看、删除确认）对看板的体现、e2e、文档同步（设计 / 开发文档、PROGRESS）。

## 2. 范围

| 包含 | 不包含（P1 backlog，见 README §5） |
|---|---|
| 弹框全部区域与交互、窄容器 tab | 退回追问（`board.cards.reject`） |
| 卡面页脚与徽标、tab 徽标 | 工作台联动（看板徽标 / 跳转） |
| `DispatchCard` 识别 `【看板】` | 历史执行成员对话入口 |
| 通知 / 深链 / `chat.select` 兜底重定向 | `<project_board>` 摘要段 |
| `schedules.list` 聚合卡片排期（项目详情「定时与监看」）、删除项目确认框计数 | Bot / 负责人写看板 |
| e2e、文档同步 | |

## 3. 开工前核对

```bash
git status --short && git log --oneline -5
rg -n "ChatSession|getChatSession|setChatSession" apps/desktop/src/renderer/src | head -20       # P2 产物
rg -n "board\\.cards\\.(assign|schedule|start|complete|cancel|reopen|conversation)|board\\.summary" packages apps --glob '!**/dist/**' | head
rg -n "navigate-conversation" apps/desktop/src | head                                            # 主进程 → renderer 的通知导航
rg -n "chat\\.select\\(" apps/desktop/src/renderer/src --glob '!**/*.test.ts' | head -30       # 兜底重定向要覆盖的调用点
rg -n "parseDispatchText|DispatchCard" apps/desktop/src/renderer/src | head
rg -n "openTaskId|openDetail" apps/desktop/src/renderer/src | head -20
rg -n "listActiveForConversation|'schedules.list'" packages/core/src | head
```

必读：`features/workbench/{WhenPicker.svelte,when-presets.ts,describe.ts,workbench-model.ts,DispatchCard.svelte,TodoDrawer.svelte}`（时间 / 状态 / 派发卡的既有写法）、`features/project/{ProjectMembersMenu,ProjectTabs,ProjectSettingsDanger,ProjectSettingsSchedules}.svelte` 与 `project-chat-badge.ts`、`features/right-panel/SchedulesPanel.svelte`、`features/tasks/{TaskRunView,TaskCard}.svelte`、`features/approvals/ApprovalDock.svelte`、`features/chats/{ChatView,MessageList,Composer,ProjectTurnStatusLine}.svelte`、`features/shell/escape-layers.ts`、`apps/desktop/src/main/index.ts`（`showConversation`，约 l.124 与 l.691）、`apps/desktop/src/renderer/src/App.svelte`（`navigate-conversation` 处理，约 l.75）、`stores/{chat,shell,tasks}.svelte.ts`。

## 4. 步骤

### 步骤 1：深链与 `chat.select` 兜底

- `shell.openBoardCard(projectId, cardId)`：`await chat.select(projectId)` → `shell.openProjectModule('board')` → `board.openCard(cardId)`（顺序重要：`select()` 会重置 `projectView` 并关弹框）。
- **集中兜底**：`chat.select(id)` 取到会话对象后若 `type === 'card'`，改走 `shell.openBoardCard(parentProjectId, cardTodoId)`，不选中它。这一处覆盖 §3 里全部 `chat.select(conversationId)` 调用点（待办「打开对话」、审批横幅、`open-deep-link`、搜索、委派卡、通知等），不逐点修改。
- `App.svelte` 的 `navigate-conversation` 处理沿用 `chat.select`（被兜底接住）；**去掉 P2 在 `main/index.ts` 里「忽略 card」的临时处理**——通知点击现在经 renderer 兜底进入卡片弹框。
- **测试**：`select()` 兜底单测（card → 走 `openBoardCard`；direct / project 不变）；`shell.openBoardCard` 顺序用例。

### 步骤 2：派生状态与卡面（设计 §6.4、§9.4）

- `board-model.ts` 增 `deriveCardStatus(card)`：输入 `BoardCard`，输出 `{ key, tone, label, params }`，对照设计 §6.4 的表（无指派 → `null`；`draft`+已指派 → `idle`；`scheduled`（周期卡另显示最近一次执行，沿用 `effectiveStatus`）；`in_progress` 且 `task.queued > 0` → `queued`（带 `queueReason`）；`in_progress` → `running`；`delivered`；`done`；`cancelled`（有 `lastRun` 显示 `stopped`）；`draft`+`blockedReason` → `blocked`）。复用 `workbench-model.ts` 的 `effectiveStatus` / `blockedNotice`（若入参形状不兼容，写一个结构化适配而不是复制逻辑）。另 `deriveCardBadges(card)` → `{ unread, approval, askUser }`（`askUser` 取 `task` 里等待用户回答的状态，若 `BoardCard.task` 未带则本步在 P2 投影里补字段并写实施记录）。
- `cardFooter(card)`（P1 已留）此时返回页脚数据：执行成员（`BotAvatar`，`size-4`，`animated={false}`）· 状态词（色点 + `text-xs`）· 时间（时钟图标 + `describeScheduleWhen` 人话）；**纯思路卡仍无页脚**。徽标 amber：`board-card-unread`（未读点）、待审批、等你回答、受阻原因。已完成整体 `opacity-70`。
- **刷新**：`board` store 维护「卡片会话 id → 卡片 id」映射（来自 `board.get`），收到 `message.created` / `run.status` / 审批事件且 `conversationId` 在映射里时，去抖（200ms）整体重拉；弹框打开期间卡片的增量由弹框内的 session 自己维护，store 拉取不覆盖弹框内未保存的文本。
- **测试**：`board-model.test.ts` 扩：状态派生全表（每行一用例，含周期卡、排队、取消 / 停止、受阻）、徽标派生、页脚数据；`board.svelte.test.ts` 扩：事件 → 重拉的映射过滤。

### 步骤 3：弹框外壳与布局（设计 §9.8）

重写 P1 的最小 `CardDialog.svelte`：

- `Dialog.Content`：`sm:max-w-5xl`（**必须带 `sm:`**）、高度 `min(80vh, 720px)`、`flex flex-col gap-0 overflow-hidden p-0`、`showCloseButton={false}`；三段：上工具栏 `shrink-0 border-b px-4 py-3`、中部 `min-h-0 flex-1`、下工具栏 `shrink-0 border-t px-4 py-3`；中部左右两栏**各自**纵向滚动（左栏宽约 40% / 最大 420px，右栏 `min-w-0 flex-1`）。
- **窄容器**（`bind:clientWidth` < 760，沿用工作台阈值 `TABS_BELOW`）：中部改为「详情 / 对话」两个 tab（手写 tablist，样式同 `ProjectTabs`，**不用** `ui/tabs`），tab 上带未读点。
- 上工具栏：左「任务详情」；右 `CardExecutorMenu` + 关闭钮（`Button size="icon-sm" variant="ghost"`，testid `board-dialog-close`）。
- 焦点与 Esc：打开时焦点在弹框容器（不抢文本光标）；Esc 关闭，但输入框与审批卡里的 Esc 先被它们消费（遵守 `escape-layers` 契约）；对话区若打开了任务过程页，Esc 先返回对话（步骤 6）。关闭前补存文本。弹框外沿用 `inert`。

### 步骤 4：执行成员菜单 `CardExecutorMenu.svelte`

手写轻量弹层（`ProjectMembersMenu` 的写法：`<svelte:window onpointerdown onkeydown>` 关闭）：列出项目成员里 **active、非管家**的 Bot（负责人带标、头像 `size-5`）+「未指派」项；数据取自主项目会话的成员列表（`chat.main` 的 `members`）。当前执行成员打勾。选择 → `board.cards.assign`，`warnings` 用 toast 显示。**锁**：事项进行中 / 待验收 / 已关闭时整个菜单置灰并给提示（`board.dialog.executor.locked` / `.lockedClosed`）。触发按钮显示执行成员头像（无指派：虚线圆「＋」）。testid `board-dialog-executor`。

### 步骤 5：左栏——文本与执行记录

- 文本：`InlineEditable`（多行、600ms，P1 已有）；**已指派且进行中**时编辑会触发事项更新通知，界面不额外提示（设计 §6.3）。
- `CardRuns.svelte`：经既有 `todos.get { id }` 取 `runs`（卡片 id = 事项 id；`todos.get` 不属于被 `BOARD_MANAGED` 拦的改动入口，**核对**）；每行：派发时间、状态词（`board.runs.status.*`）、「›」→ 切到对话并高亮对应结果消息（`result_message_id`，缺则 `message_id`；经 session 的 `highlightMessageId`，窄容器下同时切到「对话」tab）。无记录时整块不渲染。testid `board-dialog-runs`。

### 步骤 6：右栏——卡片对话 `CardChat.svelte`

- 创建 `new ChatSession()`，`open(conversationId)`（`conversationId` 取 `card.conversationId`，缺失而卡片已指派时调 `board.cards.conversation` 补建）；`setChatSession(session)` 之后，**直接复用单聊的 `MessageList` / `Composer` / `ApprovalDock`（`conversationId`）/ 状态行 / 只读横幅**（P2 已让它们读 session）。会话切换（换指派后 `conversationId` 变化）或弹框关闭时 `dispose()`；不要调用 `chat.select()`。
- 未指派：居中说明 `board.dialog.chat.emptyUnassigned`；已指派无消息：Composer 占位 `board.dialog.chat.placeholder`；只读（执行成员已离开）：沿用只读横幅。
- **弹框内的任务卡**：`TaskCard` 的「打开任务过程」走当前 session 的 `openTask`（P2 A5），右栏显示 `TaskRunView`（改成接受 `taskId` / `onBack` 与审批会话 id 的 props，主区包装器继续用 `tasks.openTaskId`），带返回；不替换主区、不影响项目沟通。
- **已读**：弹框可见且窗口聚焦时对当前 session `markRead()`；更新 `board` 里该卡的 `unreadCount`。
- testid `board-dialog-chat`。**测试**：e2e（步骤 11）。

### 步骤 7：下工具栏——时间、状态与主操作

- `CardStatusBar.svelte`：chip 行（`text-xs`）：时间 chip（`board-dialog-when`，点开 `CardWhenPopover`）、状态 chip（`board-dialog-status`，`deriveCardStatus`）、「下次 {time}」（有排期）、创建 / 更新时间；最右主操作区（`board-dialog-action`）按设计 §6.4 表：已指派未开始 → 开始执行（`board.cards.start`）；已排期 → 改期、周期卡「立即执行一次」（`start`，保留周期）、清除时间（`schedule(null)`）；进行中 → 取消执行（**行内二次确认**，仿 `SchedulesPanel` 的两步取消）；待验收 → **验收完成**（`complete`）、取消；已完成 / 已取消 → 重新打开（`reopen`）。成功 / 失败都经 toast（`errorText`）。
- `CardWhenPopover.svelte`：手写弹层，内嵌 **`WhenPicker`**（`bind:draft`）+「保存 / 清除」；用 `when-presets.ts` 的 `draftFromSchedule` / `whenFromDraft` / `sameWhen` / `nextFireOfPreset`；无指派时时间 chip 置灰并提示 `board.dialog.when.needAssignee`；锁定态（进行中 / 待验收 / 已关闭）置灰；保存 → `board.cards.schedule`，`BOARD_CRON_TOO_FREQUENT` 等错误就地显示。「免打扰时段提示」：**由你判断**——仅当设置里已有可读取的免打扰时段入口时，在选到该时段时给一行提示（D90 风险项），否则不做并写进实施记录。
- **测试**：`board-model.test.ts` 里 `primaryActions(card)`（状态 → 可用操作清单，纯逻辑）全表。

### 步骤 8：`DispatchCard`、tab 徽标、项目详情页对接

1. **`DispatchCard` / `parseDispatchText`**（`features/workbench/`）：识别 `【看板】` 前缀，渲染为「任务派发」卡，**不带**「在工作台查看」链接（弹框里就是该线程）。**测试**：`workbench-model.test.ts` 扩 `parseDispatchText` 用例。
2. **tab 徽标**：`features/project/project-board-badge.ts`（纯逻辑，仿 `project-chat-badge.ts`）：`boardTabBadge({ unread, pendingApprovals, delivered })` → `{ count, pending }`；`ProjectTabs` 给 board tab 渲染徽标（`board.tab.badgeCount` / `board.tab.badgePending`）。数据来源：项目会话打开期间（`ProjectView` 挂载，**不要求用户进过看板 tab**）订阅并读 `board.summary`，在 `message.created`（卡片会话）/ 审批事件 / `board.changed` / `todos.changed` 时去抖刷新。**测试**：纯逻辑单测 + `board.svelte.test.ts` 的订阅用例。
3. **`schedules.list` 聚合**（core，小改）：当 `conversationId` 是项目会话时，结果并入其卡片会话的排期（`parent_project_id = conversationId`），`SchedulesPanel` 的行在 `origin==='workbench'` 的看板排期上显示「工作台」徽标 + 卡片标题（取排期 `title` / 会话标题）。**测试**：`schedule-service.test.ts` 或 `board-execution.test.ts` 加一条聚合用例；`schedules` 既有测试不变。
4. **删除项目确认框**（`ProjectSettingsDanger.svelte`）：仿 `projectSettings.deleteWikiCount` 增一行「看板：{cards} 张卡片（其中 {assigned} 张已指派）将一并删除」；计数在组件里经 `board.get { projectId }`（不带 `seedTitles`）客户端统计（≤ 500 张，无需新 RPC）。
5. **删卡确认**：界面按 `needsDeleteConfirm(card)`（P1 已有，P2 起对已指派卡为真）弹确认（小 `Dialog`，`sm:max-w-sm`）：「这张卡片的对话与执行记录会一并删除，无法恢复」。

### 步骤 9：i18n

`zh-CN.ts` 与 `en-US.ts` 同步新增（键顺序一致；下为中文原文，英文你翻译且不含中文）：

| key | 文案 |
|---|---|
| `board.status.idle` / `.scheduled` / `.queued` / `.running` / `.delivered` / `.done` / `.cancelled` / `.stopped` / `.blocked` | 待开始 / 已排期 · 下次 {time} / 排队中 · {reason} / 执行中 / 待验收 / 已完成 / 已取消 / 已停止 / {reason} |
| `board.badge.unread` / `.approval` / `.askUser` | 有新消息 / 待审批 / 等你回答 |
| `board.dialog.executor.none` / `.change` | 未指派 / 更换执行成员 |
| `board.dialog.executor.locked` | 执行中不能更换，请先取消执行 |
| `board.dialog.executor.lockedClosed` | 已结束，请先重新打开 |
| `board.dialog.chat.emptyUnassigned` | 指派一位成员后，可在这里就这张卡片与 TA 沟通 |
| `board.dialog.chat.placeholder` | 就这张卡片与 {name} 沟通… |
| `board.dialog.tab.detail` / `.chat` | 详情 / 对话 |
| `board.dialog.when.label` / `.none` | 执行时间 / 未设置 |
| `board.dialog.when.needAssignee` | 先指派执行成员 |
| `board.dialog.when.locked` | 执行中或已结束，不能修改时间 |
| `board.dialog.when.save` / `.clear` | 保存 / 清除 |
| `board.action.start` / `.reschedule` / `.runOnce` / `.clearWhen` | 开始执行 / 改期 / 立即执行一次 / 清除时间 |
| `board.action.cancel` / `.cancelConfirm` | 取消执行 / 确认取消？ |
| `board.action.accept` / `.reopen` | 验收完成 / 重新打开 |
| `board.runs.title` / `.open` | 执行记录 / 查看结果 |
| `board.runs.status.dispatched` / `.delivered` / `.unclaimed` / `.failed` | 进行中 / 已交付 / 无人回应 / 失败 |
| `board.meta.createdAt` / `.nextFire` | 创建 {time} / 下次 {time} |
| `board.tab.badgeCount` / `.badgePending` | {count} 项待处理 / 有待审批的操作 |
| `board.deleteCard.title` / `.body` / `.confirm` | 删除这张卡片？ / 其对话与执行记录会一并删除，无法恢复。 / 删除 |
| `projectSettings.deleteBoardCount` | 看板：{cards} 张卡片（其中 {assigned} 张已指派）将一并删除 |
| `dispatch.board.title`（`DispatchCard` 的看板变体，键名按该组件现有命名风格取） | 任务派发 |

### 步骤 10：e2e

扩 `apps/desktop/test/e2e/project-board.spec.ts`（P1 已有 ①–⑦，本阶段接着编号；沿用 `project-chat.spec.ts` / `tasks.spec.ts` 的 mock 模型夹具与 `helpers/create-project.ts`）：⑧指派一位成员 + 设时间 → 排期出现在项目详情「定时与监看」（带「工作台」徽标与卡片标题）；⑨「开始执行」→ 卡片对话里出现 `【看板】…` 派发卡与 Bot 回复，状态依次 执行中 → 待验收，点「验收完成」→ 已完成，重新打开 → 回 `draft`；用户直接在卡片对话里发消息得到回复，**与该 Bot 的单聊互不串**；⑩审批出现在弹框内审批坞，且看板 tab 徽标与卡面徽标同时亮，处理后消失；⑪换指派得到新会话、旧会话不再在弹框出现；取消指派后弹框显示空态；⑫卡片会话里的任务点开在弹框内显示任务过程、返回回到对话、主区不变；⑬删卡（含确认）/ 删非空栏 / 删项目的级联（项目删除确认框带卡片计数）；⑭窄屏（容器 < 760）弹框变「详情 / 对话」tab；⑮通知点击 / 待办「打开对话」等 `chat.select(cardConversationId)` 路径落到卡片弹框而不是侧栏选中隐藏会话；⑯执行成员被移出项目 → 卡片回 `draft` 并显示受阻原因、对话只读。同步把 `project-shell.spec.ts` 里 board 相关断言补全（board tab 带徽标的可见性）。

### 步骤 11：文档同步（定稿时一次做完）

- **设计文档 50**：顶部状态改为「已实施」，落地与设计不一致处**直接改正文**（以代码为准）；§2 表不改，其余按实施记录修订。
- 按设计 §14 表同步：[41](../../docs/design/41-project-team.md)（§10.1 注册表状态 / 顺序；§10.3 看板行、§9.2 / §17.9 写租约不再是前置——正文改成现状）、[39](../../docs/design/39-workbench.md)（非目标「不做看板视图」改指 50；增「看板事项」概念：`TodoEntry.board`、`BOARD_MANAGED`、`todos.list` 默认排除）、[12-ui-layout](../../docs/design/12-ui-layout.md)（项目组外壳加看板 tab 与弹框；卡片对话不进侧栏）、[01-conversation](../../docs/design/01-conversation.md)（会话类型 `card`）、[04-memory](../../docs/design/04-memory.md) / [05-wiki-and-skills](../../docs/design/05-wiki-and-skills.md)（项目作用域解析、wiki 默认 scope）、[30-supervisor-and-tasks](../../docs/design/30-supervisor-and-tasks.md)（卡片对话作为任务会话；`queueReason` 在卡面）、`docs/design/README.md`（索引行与 D103 改为「已实施」）、`docs/dev/03-data-model.md`（确认两阶段的表 / 级联已齐）。
- `docs/dev/PROGRESS.md` 追加本功能条目（三阶段、全量测试结果、新增依赖 `svelte-dnd-action@0.9.80`）；偏差已记 `DEVIATIONS.md` 的补「已落实」状态。
- 本目录三个阶段文档的状态改为「已实施」，各自「实施记录」已填。

## 5. 验收标准

- [ ] 弹框三段结构与设计 §9.8 一致；窄容器（< 760）为「详情 / 对话」tab；Esc / 焦点 / 补存行为正确。
- [ ] 执行成员菜单只列项目里 active 非管家 Bot，用户不在其中；锁定态置灰并提示。
- [ ] 时间 / 周期经 `WhenPicker` 设置，无指派 / 锁定时置灰；cron 过密有就地错误；排期出现在项目详情「定时与监看」。
- [ ] 右栏是真正的单聊组件（消息、审批坞、状态行、Composer、只读横幅），绑定卡片会话；弹框内任务过程页可进可返；与该 Bot 单聊互不串。
- [ ] 状态派生与页脚 / 徽标与设计 §6.4 一致；待验收需手动「验收完成」；周期卡显示最近一次执行状态。
- [ ] 看板 tab 徽标在用户处于沟通 / Wiki tab 时仍会提示未读与待审批；通知点击与所有 `chat.select(cardConversationId)` 路径都落到卡片弹框，卡片会话永不被侧栏选中。
- [ ] 删卡 / 删栏 / 删项目的确认与级联正确，删除项目确认框带看板计数。
- [ ] 文档同步完成，PROGRESS 已记录；`locales.test.ts` 通过。

## 6. 测试与收口

```bash
pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/core run build
pnpm typecheck && pnpm lint
node scripts/run-tests.mjs run --project desktop
node scripts/run-tests.mjs run packages/core/test/integration/board-execution.test.ts packages/core/test/integration/board-rpc.test.ts
pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/project-board.spec.ts test/e2e/project-shell.spec.ts test/e2e/project-chat.spec.ts test/e2e/project-wiki.spec.ts test/e2e/workbench.spec.ts test/e2e/schedules.spec.ts test/e2e/approvals.spec.ts test/e2e/tasks.spec.ts test/e2e/direct-chat.spec.ts test/e2e/narrow-layout.spec.ts
pnpm test      # 最终交付前跑一次全量；失败集合不得超出基线
```

## 7. 风险与注意

1. **弹框里嵌单聊组件**：P2 的 `ChatSession` 是前提；任何仍读全局 `chat.current` 的遗漏组件会让弹框显示项目沟通的内容——e2e ⑨ 专门断言卡片对话与单聊 / 沟通互不串。
2. **Esc 与焦点层次**：弹框 → 任务过程页 → 审批卡 / 输入框，谁先消费 Esc 要按 `escape-layers` 契约逐层验证。
3. **`chat.select` 兜底**：必须在拿到会话对象后判断类型；卡片会话不在 `chat.conversations` 里，需要经 `conversations.get`——核对 `select()` 现有的取会话路径，别让未知 id 误判。
4. **审批易漏**：派发回合永远非用户触发。徽标 + 卡面 + 通知三条线缺一不可。
5. **弹框宽度类**：`Dialog` 基类带 `sm:max-w-sm`，所有覆盖都要写 `sm:max-w-*`（P1 / P3 的弹框、确认框都一样）。
6. **文档以代码为准**：同步时发现设计与实现不一致，改设计正文并在实施记录写明，不要留两套说法。

## 8. 实施记录

（执行智能体在最后一个提交里填写：`askUser` 徽标的数据来源；`todos.get` 对看板事项的核对结论；免打扰提示是否实现；`chat.select` 兜底的取会话路径；新增的非 README §4 名字；DEVIATIONS 编号；全量测试结果与基线对比。）
