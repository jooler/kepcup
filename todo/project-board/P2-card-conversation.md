# P2 · 卡片对话与执行：`ChatSession` 抽取、`card` 会话、项目作用域、指派 / 排期 / 派发

> 状态：**已实施**（2026-10-26）。
> 设计 WP：**WP0 + WP2**。依赖：**P1 已合入**（后端部分需要 `board_cards` / `BoardService` / `TodoService` 看板缝）；轨道 A（WP0）本身不依赖 P1。分支：`feat/board/p2-card-conversation`。
> 先读 [README.md](README.md) §1、§4；设计依据 [docs/design/50-project-board.md](../../docs/design/50-project-board.md) §5.5（`card` 会话）、§6（执行）、§7（Bot 视角）、§8、§11（`ChatSession`）；背景 [39-workbench.md](../../docs/design/39-workbench.md) §2–§3、[41](../../docs/design/41-project-team.md) §6–§8。

## 1. 目标

两条轨道、**一个分支**：

- **轨道 A（WP0，渲染层）**：把聊天组件对全局 `chat.current` 的依赖抽成可多实例的 `ChatSession`，**行为完全中性**——这是 P3 把单聊组件嵌进弹框的前置。
- **轨道 B（WP2，core）**：新增隐藏会话类型 `card`；`projectScopeOf` 收口项目口径；提示词 `card` 分支；`BoardService` 的指派 / 排期 / 开始 / 完成 / 取消 / 重开；`TodoService` 看板缝（派发目标、执行成员离开、派发文本）；生命周期钩子；`board.summary`；cron 下限守卫。

**本阶段没有新的用户入口**：界面上除了「看板」里不会出现任何新东西；正确性靠集成测试与既有回归。

## 2. 范围

| 包含 | 不包含（P3） |
|---|---|
| `ChatSession` 抽取与组件迁移、任务 / 授权 store 按会话键控 | 卡片弹框的对话区、执行成员菜单、时间弹层、状态操作 UI |
| `conversations` 重建迁移（`card` 类型）、`ConversationsService` 卡片会话 | 看板 tab 徽标、卡面状态与徽标、通知深链 |
| `projectScopeOf` 及全部判断点改造、`<conversation_info>` card 分支、`CARD_RULES` | `DispatchCard` 对 `【看板】` 的识别（P3） |
| `BoardService` 执行方法、`TodoService` 看板缝、级联、`board.summary` RPC | e2e 全量、文档同步（P3） |

## 3. 开工前核对

```bash
git status --short && git log --oneline -3
# 轨道 A
rg -l "chat\\.current\\b" apps/desktop/src/renderer/src | sort                 # 约 35 个文件，逐个列入清单
rg -n "chat\\.currentId|chat\\.replyTo|chat\\.highlightMessageId|gateForSend|markRead\\(" apps/desktop/src/renderer/src | head -40
rg -n "#chat\\b|CurrentChat" apps/desktop/src/renderer/src/lib/stores/chat.svelte.ts | head -40
rg -n "openTaskId|loadActive|#conversationId" apps/desktop/src/renderer/src/lib/stores/tasks.svelte.ts
rg -n "loadForConversation|#currentConversationId|pendingOf|reloadApprovals" apps/desktop/src/renderer/src/lib/stores/permissions.svelte.ts
# 轨道 B
ls packages/core/migrations/main | tail -3
rg -n "type === 'project'|type !== 'direct'|type === 'direct'|directBotId" packages/core/src | sort | head -80   # 判断点清单的起点
rg -n "#targetOf|#dropExecutor|#validateAssignee|#adoptScheduleHolder|createForTodo" packages/core/src/workbench packages/core/src/schedule
rg -n "withDirectConversationBots|conversation.updated" packages/core/src/infra packages/core/src/dispatch | head
rg -n "showConversation" apps/desktop/src/main/index.ts
```

必读：`stores/chat.svelte.ts`（全文；`CurrentChat` 与 `#chat`、事件路由 `#ingestMessage` / `#replaceMessage` / `#applyRun`、`select()`、`markRead`、`gateForSend`）、`features/chats/{ChatView,ChatsArea,MessageList,Composer,ChatMessageRow,MessageBody,composer-drafts.svelte,send-gate,conversation-bot}`、`stores/{tasks,permissions}.svelte.ts`、`features/tasks/TaskCard.svelte`、`packages/core/migrations/main/0040_project_conversations.sql` 与 `0045_conversation_archive.sql`、`packages/core/src/domain/{conversations,lifecycle,projects}.ts`、`packages/core/src/workbench/{todo-service,todo-store}.ts`、`packages/core/src/schedule/service.ts`、`packages/core/src/dispatch/{orchestrator,jobs-runner}.ts`、`packages/core/src/agent/context/system-prompt.ts`、`packages/core/src/tools/wiki-tools.ts`、`packages/core/src/memory/{service,retrieve,my-state}.ts`、`packages/core/src/workdir/service.ts`、`packages/core/src/permissions/grants.ts`、`packages/core/src/handover/adapters/{schedule,watch}.ts`。

## 4. 提交顺序（重要）

```text
① B1 shared + 迁移（card 类型进契约）
② 轨道 A 全部（A1–A6，WP0：纯重构、行为中性，独立提交序列）
③ 轨道 B 其余（B2–B9）
```

① 先落契约，是因为 A6（把 `!== 'direct'` 改为「单 Bot 会话」判断）要用到 `'card'` 类型；② 在没有任何 `card` 会话存在的情况下是**死代码路径**，所以 WP0 仍是行为中性的；③ 才让 `card` 会话真正出现。

## 5. 轨道 B 的第一步（先做）

### B1：shared 与迁移

1. shared：`conversationTypeSchema` 增 `'card'`；`conversationSchema` 增 `parentProjectId`、`cardTodoId`（可空）；`domain/conversations.ts` 与 `wiki/service.ts` 里硬编码的 `'direct' | 'project'` 联合一并放宽（核对命令 `rg -n "'direct' \\| 'project'" packages`）。`pnpm --filter @kepcup/shared run build`。
2. 迁移 `00NN_card_conversations.sql`（首行 `-- kepcup:foreign-keys=off`，写法同 `0040`）：重建 `conversations`，README §4.1 的类型 CHECK / 新列 / 唯一索引。**建表语句以「迁移到 head 后库里 `conversations` 的实际定义」为准**（含 `0045` 的 `archived_at` 与后续迁移加的列、全部索引与触发器），不要只抄 `0040`；旧行原样保留（新列为 `NULL`）。更新所有迁移版本列表（`rg -n "<上一个编号>" packages apps --glob '!**/migrations/**'`）。
3. 同步 `docs/dev/03-data-model.md`：`conversations` 新列 / 类型、「删除级联」表（`parent_project_id` 为 FK 安全网，**实际删除由 service 驱动**）。

**测试**：迁移测试：三类型 CHECK（`card` 缺 `parent_project_id` / `card_todo_id` / `direct_bot_id` 被拒；`direct` / `project` 带这两列被拒）；唯一索引每卡至多一条 `read_only=0`；既有 direct / project / archived 行与索引完好；父项目删除的 FK 级联。

## 6. 轨道 A：`ChatSession` 抽取（WP0）

**铁律**：每一步都是**行为中性**的重构提交；`chat` 的对外 API（`chat.current`、`chat.currentId`、`chat.conversations`、`select()` 等）对**非聊天组件**保持原样可用；不夹带任何功能改动。**仓库里没有 `chat` store 的单测**，所以 A1 先补特征化测试再动手。

### A1：补特征化测试与基线

- 在 `stores/` 下新增 `chat-session-characterization.svelte.test.ts`（`desktop-svelte` 项目，mock `core`，写法参照同目录 `chat-main-view.svelte.test.ts`）：钉住**现状**——`select(id)` 的加载序列（`conversations.get`、`messages.list`、`runs.list`、`tasks.loadActive`、`permissions.reloadApprovals`）、`message.created` / `message.updated` 只并入当前会话、`run.status` / `run.progress` 更新 `activeRuns` / `failedRun`、`markRead`、`loadEarlier`、`gateForSend` 的三种结果、`replyTo` 与切换会话的重置。后面每步重构后这组测试必须不改动地通过。
- 先跑一遍回归 e2e 作绿色记录（只记结果，不要求全量）：`direct-chat`、`project-chat`、`project-shell`、`project-routing`、`approvals`、`tasks`、`composer-draft`、`composer-layout`、`stickies`、`setting-card`、`narrow-layout`、`workbench`、`schedules`、`lifecycle`。

### A2：抽出 `ChatSession`（新文件，先无人使用）

`stores/chat-session.svelte.ts`：把 `CurrentChat` 与 `chat.svelte.ts` 里「属于当前会话」的状态和方法搬进类（`$state` 字段）：`conversationId`、`conversation`、`messages`、`activeRuns`、`failedRun`、`hasEarlier`、`members`、`replyTo`、`highlightMessageId`；方法 `open(id)`（只含加载那一半：`conversations.get` + `messages.list` + `runs.list` + `tasks.loadActive` + `permissions.reloadApprovals`）、`dispose()`、`send`、`gateForSend`、`markRead`、`loadEarlier`、`retryRun`、`dismissFailedRun`、事件处理（`message.created` / `message.updated`、`run.status` / `run.progress`、`bot.updated`、`conversation.updated`），**每个会话实例自己订阅事件、按 `conversationId` 过滤**，`dispose()` 取消订阅。两种用法：`main`（单个对象，`open(id)` 切换会话，随 `chat.select()` 驱动）与弹框里的 `new ChatSession()` + `open(cardConversationId)` + 关闭时 `dispose()`。**不跨实例共享的**留在 `chat`：`conversations` 列表、`runningByConversation`、`turnByConversation`、`lastMessageText`、`composingProject`、`#pendingSetup` 等全局状态。

### A3：`chat` 委托给 `main`

`chat.current` / `currentId` / `replyTo` / `highlightMessageId` 变成对 `chat.main` 的派生读取；`select()` 只保留「导航副作用」（`shell.showChats`、`saveLastConversationId`、`projectView` 重置并 `board.closeCard()`、`tasks.closeDetail`、`cancelProjectCompose`、`#startSparseInterview`）+ `main.open(id)`；加载与事件交给 session。**`select()` 的外部行为不变**，A1 的特征化测试不改动地通过。

### A4：context 助手与组件迁移

新增 `setChatSession()` / `getChatSession()`（默认返回 `chat.main`，未设置 context 的位置行为不变）。逐个迁移下列组件对 `chat.current` 的读取（清单以 §3 的 `rg` 结果为准，**逐文件勾选，写进实施记录**）：`MessageList`、`Composer`、`ChatMessageRow`、`MessageBody`、`TaskCard`、`settings-card/{SettingCard,SettingSetupBody,open-deep-link}`、`ScheduleCard` / `ScheduleReceipt`、`BotWidgetCard`、`WidgetViewer`、`FileViewer`，以及 `ChatView` 里的横幅（只读、确认模式、失败重试，抽成可复用片段）。每迁移一批跑一次 `typecheck` 与 A1 测试。

### A5：任务与授权 store 按会话键控

- `stores/tasks.svelte.ts`：`loadActive` 目前只记一个 `#conversationId` 并清理其它会话已结束的视图——改成可同时服务多个会话（例如记 `Set<conversationId>`，且不再清理仍在被某个 session 使用的会话）；`openTaskId` 保持主区语义，**另外**让 `TaskRunView` 可由 session 级回调打开（弹框内使用，见设计 §9.8）：`TaskCard` 的「打开任务过程」改走当前 session 的 `openTask`，main session 的实现仍是 `tasks.openDetail`，所以主区行为不变。
- `stores/permissions.svelte.ts`：`loadForConversation` 的单个 `#currentConversationId`（用于授权）改成按 `conversationId` 键控的结构，可同时服务主区与弹框；`pendingOf(id)` / `reloadApprovals(id)` 已按会话，不动。

### A6：门禁与防泄漏

- `features/chats/send-gate.ts`、`features/chats/conversation-bot.ts`、`ChatView` 里的 `!== 'direct'` 改为共享的「单 Bot 会话」判断（`direct` 或 `card`，放在 shared 或 renderer 的一个小纯函数里，带单测）。
- `chat.#upsertConversation` 与 `stores/contacts.svelte.ts` 对 `conversation.updated` **显式忽略 `type === 'card'`**（带单测）；核心侧列表过滤见 B2。

**轨道 A 新增测试**：`stores/chat-session.svelte.test.ts`（两个 session 并存时各自只并入自己会话的事件；`open` 加载序列；`dispose` 后不再响应事件；`main.open(id)` 切换会话并重置 `replyTo`；per-session `gateForSend` / `markRead`）、`tasks.svelte.test.ts` 与（若无则新增）`permissions` 的多会话用例、单 Bot 会话判断与 upsert 忽略 `card` 的单测。**既有测试一律不改动地通过**。

**轨道 A 收口核对**：A1 的 e2e 回归清单全部通过（只跑这些 spec，不跑全量）；`git diff` 里除抽取 / 迁移外没有功能性改动；界面零变化。

## 7. 轨道 B：后端（WP2，B1 之后）

### B2：`ConversationsService` 与可见性

- `ConversationsService.ensureCardConversation({ projectId, todoId, botId, title })`：该卡片已有同一 Bot 的会话 → 复用（必要时取消只读）；否则新建（`type='card'`、`direct_bot_id=botId`、`parent_project_id`、`card_todo_id`、`title`）；同卡片其它在用会话设为 `read_only`。另有 `setCardTitle`、`readOnlyCardConversationsOf(todoId | botId | projectId)` 一类内部查询（命名由你定，登记实施记录）。**不新增通用的「打开卡片对话」RPC**。
- 可见性：`list` / `listVisible` / `conversations.all` 都排除 `card`；其它按 `type='direct'` 枚举的路径（`openDirect`、`listDirectByBot`、分享目标、移交适配器、通讯录归档查询）天然排除，**逐个核对并在测试里钉住**。`conversation.updated` 事件**仍照常发布**（弹框 session 要用），渲染层已在 A6 忽略。
- 防御：`apps/desktop/src/main/index.ts` 的 `showConversation(conversationId)`（审批通知点击路径）遇到 `card` 类型会话时**不要 `chat.select()`**（P3 会改成跳到「项目 → 看板 → 卡片」）；本阶段先直接忽略并写 `// P3` 注释。

**测试**：`packages/core/test/integration/card-conversation.test.ts`：`ensureCardConversation` 的复用 / 新建 / 其它转只读；列表与通讯录排除；唯一索引兜底（并发调用不产生两条在用会话）。

### B3：`projectScopeOf` 与判断点改造（M6 的核心）

1. 新建 `packages/core/src/domain/project-scope.ts`：`projectScopeOf(conversation) → projectId | null`（README §4.3），纯函数 + 单测（`project`/`card`/`direct`/`null` 全表）。
2. **判断点清单**：用 §3 的 `rg` 产出全部 `type === 'project'` / `!== 'direct'` / `=== 'direct'` / `directBotId` 位置，**逐处决定「card ≡ project」「card ≡ direct」或「不适用」**，把决定表写进实施记录。必须覆盖设计 §7.2 / §7.3 的这些点（行号仅供定位，以代码现实为准）：

| 判断点 | 位置 | 决定 |
|---|---|---|
| wiki 默认 scope：`wiki.projectContext(conversationId)`、`defaultWikiScope` / `resolveWikiScope` | `dispatch/orchestrator.ts`（约 l.4441）、`tools/wiki-tools.ts`（约 l.78–92、220 / 264 / 343） | card → 所属项目（含成员校验），`wiki_search` / `wiki_read` / `wiki_enqueue` 默认 `project` / `all` |
| `<project_wiki_topics>` 注入 | `dispatch/orchestrator.ts`（约 l.4245） | card → 注入所属项目主题段 |
| 反思 loop 的 wiki 建议归属 | `dispatch/jobs-runner.ts` `#wikiSuggestionOwner`（约 l.410） | card 且该 Bot 仍是成员 → 项目 wiki |
| 记忆 origin | `memory/service.ts`（约 l.418 / 489） | `'project'`（Q9） |
| 记忆读取 `isProject`、`warnPrivateOrigin` | `memory/service.ts`（约 l.678 / 875 / 881 / 934）、`memory/retrieve.ts`（约 l.56） | 同项目对话口径 |
| `<my_state>` 会话标签 | `memory/my-state.ts`（约 l.48） | 「项目组卡片对话」 |
| 工作目录 | `workdir/service.ts` `boundWorkdir`（约 l.148） | 经所属项目解析（不复制） |
| 访问授权 | `permissions/grants.ts`（约 l.152） | 经所属项目解析；若查询点分散导致本期无法统一，退化为卡片对话内重新授权（审批卡在弹框内可见），**写进实施记录** |
| 委派 `delegate_to_bot` | `dispatch/delegation.ts`（约 l.229 / 519） | 不适用（卡片对话无委派，v1） |
| 开箱引导 / 设置答复 | `dispatch/orchestrator.ts`（约 l.1322 / 1419） | 不适用（`type !== 'direct'` 已拒绝） |
| 项目负责人 / 成员规则、`projectRole` | `system-prompt.ts`（约 l.654–665）、`orchestrator.ts`（约 l.4622） | **不适用**（卡片对话没有路由、没有负责人） |
| 总结 job、反思 debounce | `agent/loops/conversation-summary.ts`、`memory/service.ts`（约 l.1017） | 无需改（走 `directBotId` / `(bot, conversation)`） |
| 移交适配器 | `handover/adapters/{schedule,watch}.ts` | 见 B8 |

**测试**：`project-scope.test.ts`；`card-project-scope.test.ts`（集成）：卡片对话下 wiki 工具默认 scope 为 project 且校验成员、`<project_wiki_topics>` 出现、记忆写入 origin 为 `'project'`、反思建议归属项目 wiki、工作目录解析到项目目录、`<my_state>` 标签；**同一 Bot 在其单聊里的行为完全不变**（对照用例）。

### B4：提示词

`agent/context/system-prompt.ts`：`SystemPromptInput` 增 `card`（项目名、目标、卡片文本、状态词、分栏名、`describeScheduleWhen`）；`<conversation_info>` 的 `card` 分支按设计 §7.1 的模板渲染（**不再落入「项目组」文案**）；新增 `CARD_RULES` 常量（写法参照 `PROJECT_MEMBER_RULES`，内容见设计 §7.1；不写进 Profile、不用 `system_role`）；项目负责人 / 成员规则对 `card` 不注入。`BoardService` 提供 `cardContext(conversationId)` 供 orchestrator 在 run 构建时取数（每次 run 都取当前文本与状态，所以编辑后的文本总是最新）。卡片文本由用户写入，视为可信（不包 `untrusted`）。**测试**：提示词快照（含 / 不含排期、含 / 不含项目目标与 wiki 主题段）；`card` 不出现负责人 / 成员规则。

### B5：`BoardService` 执行方法

均先过 P1 的公共校验（项目存在 / 非只读 / `canWriteModule`），再包 `TodoService`（`actor:'board'`）；成功后发 `board.changed`。

- `assign(cardId, botId | null)`：校验 `botId` 为该项目 **active 成员、非管家**（`BOARD_ASSIGNEE_INVALID`）、事项当前未锁（进行中 / 待验收 / 已关闭 → `BOARD_LOCKED`）；`ensureCardConversation`；`TodoService.update({ assignee: { kind:'project', projectId, leadBotId: botId } })`（已有排期则走既有「改派」：取消旧排期、在**新会话**重建）；`null` = 取消指派：清空指派 → 事项回 `draft`、排期取消、卡片会话转只读保留。返回 `{ card, warnings }`（`warnings` 沿用 `#validateAssignee`，如「该 Bot 未配置模型」）。
- `schedule(cardId, when)`：需已有指派；`when` 口径 `'now'` / ISO / cron / `null`；cron 走**看板专属守卫**：取接下来若干次（建议 5 次）触发时间的最小间隔，`< BOARD_CRON_MIN_INTERVAL_MS` 抛 `BOARD_CRON_TOO_FREQUENT`；排期的 `conversation_id` 取**卡片对话**（回执卡落在卡片线程里）；改期用 `ScheduleService.reschedule` 原地更新。
- `start` / `complete` / `cancel` / `reopen`：沿用事项转移（`TODO_TRANSITIONS`），错误按事项现有错误码。
- `conversation(cardId)`：已指派而缺会话时补建（幂等），返回 `conversationId`；未指派抛 `BOARD_ASSIGNEE_INVALID`。
- 投影补全（`get` / 各方法返回的 `BoardCard`）：`todo.assignee { botId, name }`、`schedule`、`lastRun`、`conversationId`（当前在用卡片会话）、`unreadCount`（取该会话的已读游标）、`pendingApprovals`（审批 store 按会话计数）、`task`（该卡片会话里 `loop_type='task'` 的 run：`running` / `queued` 计数与排队原因，取任务视图的 `queueReason`）。
- `summary(projectId)` → `{ unread, pendingApprovals, delivered }`（跨该项目全部卡片会话汇总；`delivered` = 状态为待验收的卡片数）。
- `updateCard` 补：同步卡片会话标题（`deriveCardTitle`）。

### B6：`TodoService` 看板缝（执行相关）

仍以「是否存在 `board_cards` 侧表行」为唯一开关：

- `#targetOf`：看板事项 → `{ conversationId: <当前在用卡片会话>, leadBotId: null }`（单 Bot 会话，**不 `@`、不走项目路由**）；事项更新通知（`todoUpdate`）的目标同理指向卡片会话。
- 派发文本：`【看板】{notes}`（取代 `【工作台】标题 + 说明`，避免首行重复）；周期事项触发时若上一次 `todo_runs` 仍是 `dispatched`，末尾附 `（上一次执行尚未交付）`。
- `#validateAssignee`：沿用（成员 / active / 项目可写）；看板事项的指派必须是 `{ kind:'project', leadBotId: <非空> }`（`leadBotId` 恒显式，不依赖「默认负责人」，避开 `#adoptScheduleHolder` 把空 `leadBotId` 钉成负责人的行为；看板事项跳过该钉扎）。
- `#dropExecutor`（执行成员被移出 / 被删 / 项目只读）：看板事项**清空指派**（而不是降级为「项目负责人执行」），事项回 `draft`，`blocked_reason` 写「执行成员已移出项目组」/「执行成员已删除」，排期取消，卡片会话转只读。
- 交付追踪、失败 / 取消回写：**预期原样复用**（派发消息仍带 `origin:'workbench'` + `todoId` / `todoRunId`）；用集成测试证明，若发现不成立写 DEVIATIONS。
- `createForTodo` 的 `conversationId` 取卡片会话；回执卡随之落在卡片线程。

**测试**：`packages/core/test/integration/board-execution.test.ts`（真实库 + mock 模型）：指派 → 排期 / 立即开始 → 卡片会话里出现 `【看板】…` 派发消息并触发该 Bot 一轮 → 交付后事项 `delivered`；周期卡二次触发带「上一次尚未交付」；改派得到新会话、旧会话只读；取消指派；锁（进行中不可换人）；cron 过密被拒；执行成员被移出项目 / 被删 → 指派清空 + `blocked_reason` + 会话只读 + 排期取消；项目只读下指派 / 排期被拒；卡片文本编辑在进行中触发事项更新通知并进入卡片线程；卡片会话里的写任务排队时 `task.queueReason` 可见；**该 Bot 的单聊与项目沟通完全不受影响**。

### B7：生命周期与级联

- `deleteCard` 补全：取消排期 → 删除其**全部**卡片会话（走 `lifecycle.deleteConversation`，不依赖 FK，否则漏 `runs.db` / FTS / 附件清理）→ `todos.purge`。删分栏的 `deleteCards:true` 同走它。
- `board.onProjectDeleting` 补全：**先**逐张卡片删除卡片会话，再 purge 事项，**最后**才轮到项目会话行（`lifecycle.deleteConversation` 的项目分支顺序）。
- `board.onMemberRemoved(projectId, botId)`（`lifecycle.ts` 的 `removeProjectMember` 约 l.517 调用）：该 Bot 在本项目的卡片按 `#dropExecutor` 处理。`board.onBotDeleting(botId)`（`lifecycle.ts` 删除 Bot 路径约 l.393–400，现有「单聊转只读」循环旁）：其全部卡片同样处理。
- `needsDeleteConfirm`（P1 的 `board-model.ts`）此时对已指派卡片自动为真（界面确认在 P3）。

**测试**：`board-lifecycle.test.ts`：删卡 / 删栏 / 删项目后卡片会话、排期、`runs.db`、FTS、事项、侧表行全部清理；移出成员 / 删 Bot 的看板处理；级联顺序不报 FK 错误。

### B8：RPC、`board.summary`、移交核对

- `rpc/bindings.ts` 注册：`board.cards.assign / schedule / start / complete / cancel / reopen / conversation` 与 `board.summary`（契约 P1 已定义）；错误码按 README §4.2。**测试**：扩 `board-rpc.test.ts`。
- **D88 移交核对**：`handover/adapters/schedule.ts` 对 `origin='workbench'` 排期的现有行为——本期决定：**看板事项不随移交带走**（适配器跳过带 `board_cards` 的事项排期），被移交 Bot 的卡片按「执行成员离开」处理；先读适配器现状再落实，若与现实冲突写 DEVIATIONS。**测试**：`handover` 相关既有测试不变 + 一条看板事项不被移交的用例。

### B9：文档与收尾

`docs/dev/03-data-model.md` 补全（B1 已做大部分）；不改设计文档正文（P3 统一同步）。

## 8. 验收标准

- [ ] **轨道 A**：`ChatSession` 抽取完成，`chat` 对外 API 不变；35 个引用文件逐一核对（迁移或确认无需迁移）；两个 session 并存互不串事件；任务 / 授权 store 可同时服务主区与另一会话；既有测试与 A1 e2e 清单全部原样通过；界面零变化。
- [ ] `conversations` 新类型 / 新列 / 唯一索引迁移正确，旧行完好；迁移版本列表已更新。
- [ ] `card` 会话不出现在 `conversations.list` / `all` / 侧栏 / 通讯录 / 分享目标 / 移交；审批通知点击不会选中卡片会话。
- [ ] 判断点决定表完整；卡片对话下 wiki 默认 scope、项目 wiki 主题段、记忆 origin、反思建议归属、工作目录都按项目口径；同一 Bot 的单聊行为不变（对照测试）。
- [ ] 指派 / 排期 / 开始 / 完成 / 取消 / 重开 / 补建会话 全部可用；派发落在卡片会话、不 `@`、不走项目路由；文本为 `【看板】…`；交付追踪成立。
- [ ] 执行成员离开、项目只读、改派、取消指派、周期叠加、cron 过密、锁，行为符合设计 §5.6 / §6。
- [ ] 删卡 / 删栏 / 删项目 / 移出成员 / 删 Bot 的级联全部清理，不依赖 FK。
- [ ] 看板事项不随 D88 移交带走。

## 9. 测试与收口

```bash
pnpm --filter @kepcup/shared run build
pnpm typecheck && pnpm lint
node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/stores           # 轨道 A 的 store 单测
node scripts/run-tests.mjs run packages/core/test/unit/project-scope.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/card-conversation.test.ts packages/core/test/integration/card-project-scope.test.ts packages/core/test/integration/board-execution.test.ts packages/core/test/integration/board-lifecycle.test.ts packages/core/test/integration/board-rpc.test.ts
# 既有回归（相关）
node scripts/run-tests.mjs run packages/core/test/integration/workbench-service.test.ts packages/core/test/integration/workbench-project.test.ts
pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/direct-chat.spec.ts test/e2e/project-chat.spec.ts test/e2e/project-shell.spec.ts test/e2e/project-routing.spec.ts test/e2e/approvals.spec.ts test/e2e/tasks.spec.ts test/e2e/composer-draft.spec.ts test/e2e/setting-card.spec.ts test/e2e/narrow-layout.spec.ts test/e2e/workbench.spec.ts test/e2e/schedules.spec.ts test/e2e/lifecycle.spec.ts test/e2e/handover.spec.ts
pnpm test      # 阶段收口跑一次全量；失败集合不得超出基线
```

## 10. 风险与注意

1. **轨道 A 波及面大**：35 个引用文件 + 事件路由。严格「一步一提交、行为中性」，A1 的特征化测试是护栏；任何一步让既有测试失败，**回退该步**而不是改测试。
2. **`conversations` 重建**：子表多（FK 关闭下重建），务必以「head 库里的实际定义」为准，迁移测试要验索引 / 触发器 / 旧行。
3. **判断点漏改 = 卡片对话在那一处按单聊表现**（wiki 落个人库、记忆 origin 为 private）：靠决定表 + `card-project-scope` 对照测试兜。
4. **隐藏会话泄漏**：核心侧列表过滤 + 渲染层 upsert 忽略 + 主进程通知防御，三道都要有测试 / 核对。
5. **看板事项特例只许由 `board_cards` 行触发**，不得改变既有事项行为；工作台既有测试原样通过。
6. **授权**：若卡片对话的访问授权无法统一经项目解析，v1 接受「卡片对话内重新授权」，但必须在实施记录写明，P3 弹框里审批卡可见。

## 11. 实施记录

B1 + 轨道 A 见下方原文。**B2–B9 已在本分支落地**（无新界面；P3 未做）。决策与名字见文末「轨道 B」。

### B1

- 迁移 `packages/core/migrations/main/0051_card_conversations.sql`。建表按 head 实况（`0040` 列 + `0045` 的 `archived_at` 在末列；索引 `conversations_one_direct_per_bot`、`conversations_archived`；**没有触发器**）。旧行复制，新列 `NULL`。
- 契约 CHECK 原样保留：`(type = 'card') = (parent_project_id IS NOT NULL AND card_todo_id IS NOT NULL AND direct_bot_id IS NOT NULL)`，以及原有的 project/lead CHECK。
- **额外一条 CHECK**：`(type = 'card') OR (parent_project_id IS NULL AND card_todo_id IS NULL)`。等式单独允许「`direct_bot_id` 为空的 project 行」或「只填了两列之一的 direct 行」通过；阶段测试要求 direct / project 写下这两列被拒，所以加严。不是替换契约等式。
- `conversationSchema` 的 `parentProjectId` / `cardTodoId` 是 `z.string().nullable().default(null)`：输出类型 `string | null`；缺键的旧载荷解析为 `null`。
- `domain/conversations.ts` 的行类型改为 `ConversationType`，映射写出两列。`wiki/service.ts` 的 `ConversationsFacade.get` 返回类型改为 `ConversationType`。没有因此新增行为分支。
- `rg "'direct' | 'project'"` 的其余命中**未放宽**：`tools/index.ts` 与 `setup-tools.ts` 是访谈面 `setupSurface`，不是会话类型；`workbench-service.test.ts` / `wiki-text-source.test.ts` 是局部夹具。`orchestrator` 里 `setupSurface: type === 'project' ? 'project' : 'direct'` 仍把非 project（含将来的 card）当成 direct。`system-prompt.ts` 的 `<conversation_info>` 仍是「非 direct 即项目组文案」——card 还不能被创建，B4 再改提示词。
- 文档：`docs/dev/03-data-model.md` 的表、类型、删除级联（`parent_project_id` 的 FK CASCADE 只删 main.db 行，是安全网；真正删除含 `runs.db` / FTS / 附件由 service 驱动，**B7 未做**）。

### A1

- 特征化测试：`stores/chat-session-characterization.svelte.test.ts`。`select` 的加载序列钉的是现状：`conversations.get`、`messages.list`、两次 `runs.list`（`limit: 30` 与 `active: true`）、`tasks.active`（`tasks.loadActive`）、`approvals.list` + `grants.list`（`permissions.loadForConversation`，**不是** `reloadApprovals`）。之后每步都未改这个文件。

### A2 / A3

- `stores/chat-session.svelte.ts` 的 `ChatSession`。视图是**一块** `$state` 对象（`view`），`open` / `clear` 才换引用；消息与 run 在原对象上改。窄屏路由只跟踪 `chat.current` 的引用，不能每次读都 new 一个对象。`replyTo`、`highlightMessageId`、`pendingSetup` 是各自的 `$state`。
- `main` 在 `chat` 构造时 `attach: false`，由 `chat.start()` 调用 `main.start()` 订阅。特征化测试的 mock 每个事件只留最后一个 handler，所以列表更新经 host 回调做在同一次订阅里，而不是再注册一套会被覆盖的监听。
- `open` 含：get、归档则 unarchive、`afterResolved`（`select` 在这里 `cancelProjectCompose` + upsert）、消息与 runs、`tasks.loadActive`（不 await）、装上视图、`onReady`（`select` 在这里 `showChats` / 重置项目视图 / `board.closeCard` / `tasks.closeDetail` / 记住上次会话 / 侧栏预览 / 稀疏访谈）、项目则 `reloadMembers`、`markRead`、`permissions.loadForConversation`。`markRead` 必须在 `showChats` 之后，否则工作台盖住时第二次 `select` 不会补标已读（`chat-main-view` 的用例）。复核把成员加载挪到 `onReady` 之后，见文末。
- `chat.current` / `currentId` / `replyTo` / `highlightMessageId` / `setupRequirement` 以及发送、已读、翻页、重试、关横幅都委托 `main`。列表、`runningByConversation`、`turnByConversation`、`lastMessageText`、`composingProject` 留在 `chat`。

### A4 逐文件清单

已改读 `getChatSession()`（未设置 context 时就是 `chat.main`，主区行为不变）：

| 文件 | 处理 |
|---|---|
| `features/chats/chat-session-context.ts` | 新增 `setChatSession` / `getChatSession` |
| `features/chats/ChatBanners.svelte` | 从 `ChatView` 抽出的只读 / 确认模式 / 失败重试横幅 |
| `features/chats/ChatView.svelte` | 当前视图与设置卡需求改读 session；横幅交给 `ChatBanners` |
| `features/chats/MessageList.svelte` | 消息、run、已读、翻页、高亮 |
| `features/chats/Composer.svelte` | 当前会话、引用、发送、门禁、语音设置卡（组件内录音序号仍叫 `session`，聊天会话变量是 `chatSession`） |
| `features/chats/ChatMessageRow.svelte` | 项目判断、成员、引用消息、高亮、开始引用 |
| `features/chats/MessageBody.svelte` | 用户气泡颜色取当前会话 Bot |
| `features/chats/SetupPathCard.svelte` / `SetupQuestionCard.svelte` | 访谈卡读当前会话消息 |
| `features/chats/ConnectAppSetupBody.svelte` / `MainModelSetupBody.svelte` / `AgentSetupBody.svelte` | 设置卡续跑走 session |
| `features/chats/SelectionPinToolbar.svelte` | 便签归属当前会话 |
| `features/tasks/TaskCard.svelte` | 是否项目组；打开任务过程走 `session.openTask`（A5） |
| `features/settings-card/SettingCard.svelte` / `SettingSetupBody.svelte` | 当前会话 id / 工作目录 / 项目判断 |
| `features/settings-card/open-deep-link.ts` | 增加可选的当前会话参数；上述两张卡传入 session。缺省仍是 `chat.current`（导航 `select` / `openDirect` 仍是主区） |
| `features/schedules/ScheduleCard.svelte` / `ScheduleReceipt.svelte` | 是否项目组、项目名。`chat.botName` 仍是名册查找 |
| `features/widgets/BotWidgetCard.svelte` | 打开覆盖层时带上 session 的会话 id |
| `features/widgets/WidgetViewer.svelte` / `features/files/FileViewer.svelte` | 会话一切换就关覆盖层；未设 context 时仍是主区 |

看过、故意留在 `chat.current` / `chat.currentId` 上（主区外壳，卡片弹框不会包住它们；`getChatSession()` 缺省也是 `main`，留着是为了窄屏路由继续只跟踪主区对象引用）：

| 文件 | 理由 |
|---|---|
| `features/chats/ChatsArea.svelte` | 主区外壳：项目组沟通 vs 单聊、创建项目组。不是可嵌进弹框的会话片段 |
| `features/project/ProjectView.svelte`、`ProjectHeader.svelte`、`ProjectMembersMenu.svelte`、`ProjectMembersEditor.svelte`、`ProjectSettingsPage.svelte` | 主区项目组壳。卡片弹框不承载项目详情 |
| `features/right-panel/RightPanel.svelte`、`BotMenu.svelte` | 主区右栏 |
| `features/settings-card/BotConfigCard.svelte`、`BotModelCard.svelte`、`ProjectLeadCard.svelte`、`ProjectMembersCard.svelte` | 复核时改读 session。它们经 `SettingCardEmbed` 出现在消息里的设置卡中；项目名单与加人仍走 `chat`（见文末复核） |
| `features/workdirs/WorkdirSelector.svelte` | 主区「有 run 在跑」指示 |
| `features/shell/NarrowShell.svelte`、`BotDetailOverlay.svelte`、`features/web-shell/back-navigation.svelte.ts`、`App.svelte` | 窄屏 / 返回 / 启动恢复都是主区 `currentId` |
| `features/shell/narrow-routing.svelte.ts`、`stores/shell.svelte.ts` | 只有注释提到 `chat.current` |
| `features/tasks/TaskRunView.svelte` | 主区任务过程页。打开动作已改走 session（见 A5），页面本身仍是主区 |
| `stores/chat-*.svelte.test.ts`、`narrow-routing.svelte.test.ts` | 测试钉的是对外 API 或假 store，不是产品组件 |

### A5

- `tasks.retain(id)` / `tasks.release(id)`：按会话引用计数。`loadActive` 用 `pruneTaskViewsMany`：仍被某个 session 持有的会话，其已结束视图保留；任何会话里进行中的任务都保留。`refresh` 重拉每一个仍被持有的会话。`openTaskId` 语义不变。
- `ChatSession` 在 `open` 成功时 retain（切换 id 先 release 旧的），`clear` / `dispose` release。
- `openTask` 是 session 上的可替换字段。复核后只有前台 session 的默认实现是 `tasks.openDetail`；后台 session 默认空操作，避免抢走 `openTaskId`。`TaskCard` 的「打开任务过程」改走 `session.openTask`。主区因此不变。
- `permissions`：`#grantsByConversation` 按会话存授权。`grants` 只镜像**前台**会话（右栏 / 项目授权页仍读它）。`grantsOf(id)` 读任意已加载会话。`grant.changed` 写入对应桶，仅当前台 id 时改 `grants`。`loadForConversation(id, { foreground })`：`foreground: false` 不抢右栏列表。复核后只有显式 `foreground: true` 的 `main` 是前台。`pendingOf` / `reloadApprovals` 未改。

### A6

- `features/chats/single-bot-conversation.ts` 的 `isSingleBotConversation`：`direct` 或 `card`。`send-gate.ts`、`conversation-bot.ts`、`ChatView` 的访谈闸门（原先 `!== 'direct'`）改用它。
- `chat.#upsertConversation` 与 `contacts` 的 `conversation.updated` 见到 `type === 'card'` 直接返回。没有改 `conversations.list` / `all` 的过滤（那是 B2；现在也没有代码能插入 card 行）。

### 新增、不在 README §4 里的名字

`ChatSession`、`ChatSessionView`、`ChatSessionHost`、`OpenSessionOptions`（`afterResolved` / `onReady`）、`getChatSession` / `setChatSession`、`ChatBanners`、`isSingleBotConversation`、`pruneTaskViewsMany`、`tasks.retain` / `tasks.release`、`permissions.grantsOf`、`loadForConversation` 的 `foreground`、`ChatSession.openTask`、`ChatSession` 构造参数 `attach` / `foreground`。

### 偏差

未新开 DEVIATIONS 条目。唯一相对契约等式的加严是 B1 那条「非 card 两列皆空」CHECK，理由见上，等式本身仍在。

### 测试（本切片，未跑全量 `pnpm test`）

- store 目录：`node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/stores` — 16 文件 / 88 例通过。
- `pnpm --filter @kepcup/shared run build`、`pnpm --filter @kepcup/core typecheck`、`pnpm --filter @kepcup/desktop typecheck` 通过。
- 迁移与契约：`card-conversations-migration`、`project-conversations-migration`、`public-skills-migration`、`project-board-migration`、`project-contract`、`conversation-archive`、`projects-service` 通过。
- e2e（`pnpm build` 之后，`DISPLAY=:1`，45 例，约 6.3 分钟）：**40 通过 / 5 失败**。失败与 v0.4.0 / P1 已确认的基线同类，未改 spec：
  - `project-chat`「create, @ mention, reply-quote, turn status」：悬停后 `message-quote` 在 DOM 里但 `element is not visible`（P1 已记：引用按钮悬停后仍不可见）。
  - `workbench`「scheduled todo…」与「layout: long text…」：点 `todo-save` 后 `todo-drawer` 仍为 1（P1 已记：两条 workbench 在排期保存后抽屉不关）。
  - `stickies` 两条：`message-pin` 同样是悬停后按钮不可见（与引用按钮同一类）；另一条是环境里没有 bubblewrap，确认模式横幅（`confirm-mode-banner`）挡住便签拖动手柄。横幅标记与抽出前一致，不是本切片改出来的门禁。未改这两份 spec。

### 复核（对照 P1 的 `chat.svelte.ts`，未改特征化测试）

- **项目组 `select` 的顺序**：抽出后 `reloadMembers` 在 `onReady`（`showChats` / `tasks.closeDetail`）之前。工作台或任务过程页会一直盖到成员 RPC 回来。改回先 `onReady` 再拉成员，`markRead` 仍在 `showChats` 之后。`replyTo` 与失败 run 仍在 `open` 换视图时清掉。`highlightMessageId` 在 P1 的 `select` 里本来就不清（只在 `close` / `leaveCurrent` 清），没有改。
- **`conversation.updated` 写了两遍打开中的会话**：侧栏 upsert 先把合并后的未读数写上视图，session 再用原始事件盖掉，未读数丢失。host 在已经写过视图时返回 true，session 不再覆盖。`type === 'card'` 仍不进侧栏，由 session 自己更新视图。
- **第二个 `ChatSession()` 会抢走主区**：`foreground` 默认是 true，`openTask` 一律是 `tasks.openDetail`。改成只有显式 `foreground: true`（`chat.main`）才更新右栏授权列表和 `openTaskId`。`new ChatSession()` 是后台会话：`loadForConversation(..., { foreground: false })`，`openTask` 为空操作，等弹框自己换上。主区已经 retain 的已结束任务，在第二个会话打开和 `dispose` 时保留。
- **转录里仍读 `chat.current` 的设置卡**：`BotConfigCard`、`BotModelCard`、`ProjectLeadCard`、`ProjectMembersCard` 改读 `getChatSession()`（未设 context 时仍是 `main`）。`SetupRequiredCard` 与 `ConfirmLocalConnectorBody` 的收卡改走 `session.dismissSetupCard()`。项目名单、加人、`chat.botName` 仍在 `chat` 上：那是主区名册和项目写操作，不是这一份转录的视图。
- **仍留在 `chat.current` 上的**：`ChatsArea`（主区外壳：项目组沟通 vs 单聊）、项目组壳（`ProjectView` / 顶栏 / 成员菜单与编辑器 / 项目设置）、右栏（`RightPanel`、`BotMenu`）、`WorkdirSelector`、窄屏与返回、`TaskRunView`。`TaskRunView` 只由 `ChatsArea` 在 `tasks.openTaskId` 时挂上，是主区替换页，不是消息列表里的片段；弹框要内嵌任务过程时再给它单独的 session。`BotConfigCard` 等四张已从这张「故意留主区」的表里划走，见上一条。
- **订阅**：`start` 只订一次，`open` 不重订，`dispose` 卸订。切换 id 不叠加 handler。
- **迁移 CHECK**：等式之外的 `(type = 'card') OR (parent_project_id IS NULL AND card_todo_id IS NULL)` 保留。它不拒绝合法的 direct / project / archived 行（新列为空），也不放松「每卡至多一条 `read_only = 0`」。索引仍是 `conversations_one_direct_per_bot`、`conversations_archived`、`conversations_one_open_per_card`。没有改旧迁移文件。
- **未做 B2**（轨道 A 收口时的快照）：当时 `list` / `listVisible` 仍不过滤 `card`。渲染层对 `conversation.updated` 的 `type === 'card'` 直接返回。B2 已补上列表过滤，见下节。
- `isSingleBotConversation` 仍只含 `direct` 与 `card`。项目组不走单聊发送路径。

## 轨道 B（B2–B9）

没有新的用户入口。P3 的卡片弹框、执行菜单、徽标、深链、对话框重写都没做。`showConversation` 见到 `card` 直接返回，注释 `// P3`。

### B3 判断点

`projectScopeOf`：`project` → 自身 id，`card` → `parentProjectId`，其余 `null`。

| 判断点 | 决定 |
|---|---|
| wiki `projectContext` / 默认 scope | card ≡ project（所属项目，含成员校验） |
| `<project_wiki_topics>` | card ≡ project |
| 反思 `#wikiSuggestionOwner` | card ≡ project（仍是成员才写入项目 wiki） |
| 记忆 origin | card ≡ project（`'project'`） |
| 记忆读取 `isProject` / `warnPrivateOrigin` | card ≡ project |
| `<my_state>` 标签 | card → 「项目组卡片对话」 |
| 工作目录 `boundWorkdir` | card ≡ project（不复制 workdir） |
| 访问授权 `grants` | **不经项目**。`GrantsService` 按 `conversation_id` 取授权，没有会话查找。卡片对话里重新授权；审批卡按会话 id，P3 弹框里可见 |
| 委派 `delegate_to_bot` | 不适用。`type === 'card'` 直接拒绝 |
| 开箱引导 / 设置答复 | 不适用。`type !== 'direct'` 已拒绝；访谈工具不对 card 注册 |
| 项目负责人 / 成员规则、`projectRole` | 不适用。只在 `type === 'project'` 注入 |
| 总结 job、反思 debounce | 不改（`directBotId` / `(bot, conversation)`） |
| 设置目录 `isProject` | card ≡ direct（一对一，不走项目组设置面） |
| 移交盘点的敏感记忆过滤 | card ≡ project |
| 中途进度条上限 | card ≡ direct（不是项目组那档） |
| 用户消息 / 工作台派发路由 | card ≡ direct（`directBotId` 走投递闸口，不 `@`、不进项目路由） |
| `withDirectConversationBots` | card ≡ direct（补 `bot` 字段；侧栏仍忽略 `type === 'card'`） |
| 分享目标 / 通讯录 / `listDirectByBot` | 不适用（本来就只查 `project` 或 `direct`） |
| 移交适配器 | 见 B8 / DEV-047 |

### 授权

卡片对话的路径授权**不**继承所属项目。查询点在 `GrantsService.listEffective` / `listActive`，键是会话 id。本阶段不把项目授权并进卡片会话，也不做路径作用域写租约。

### D88

看板事项的 workbench 排期**不移交**。`ScheduleAdapter` 跳过 `board_cards` 上的事项：清单里没有、`validate` / `apply` 拒绝。适配器表达不了「执行成员离开」（盘点不能改指派，移交后 Bot 仍是成员）。离开语义在移出成员和删除 Bot：`#dropExecutor` 清空指派、回 `draft`、`blocked_reason`、会话只读、取消排期。见 DEV-047。

### 新增名字（README §4 没有的）

`ensureCardConversation`、`openCardConversation`、`cardConversations`、`readOnlyCardConversationsOf`、`setCardTitle`、`closeOpenCardConversations`、`projectScopeOf`、`CARD_RULES`、`CardPromptContext`、`BoardService.cardContext`、`BoardService.assign` / `schedule` / `start` / `complete` / `cancel` / `reopen` / `conversation` / `summary`、`TodoService.releaseExecutor`、`TodoService.isBoardTodo`、`BOARD_DISPATCH_TAG`、`BOARD_UNDISPATCHED_NOTE`、`BLOCKED_EXECUTOR_LEFT`、`BLOCKED_EXECUTOR_DELETED`、平台方法 `conversations.kind`（通知点击用来识别 card，避免 `chat.select`）。

### 偏差

DEV-047。没有别的新编号。

### 测试

定向（8 个文件 / 151 例）通过：`project-scope`、`card-conversation`、`card-project-scope`、`board-execution`、`board-lifecycle`、`board-rpc`、`board-service`、`system-prompt-card`、`workbench-service`（单元）、`workbench-project`。`pnpm --filter @kepcup/core typecheck` 与 `pnpm --filter @kepcup/desktop typecheck` 通过。

全量 `pnpm test`：**6393 通过 / 21 失败 / 44 跳过**（609 个文件里 6 个失败）。21 例全部是沙箱基线（本环境没有 bubblewrap / socat），与 P1 记录的 21 例同一集合：`sandbox-isolation`、`toolchain-sandbox`、`skills-authoring`、`skills`、`workdirs` 的 OS sandbox、`workspace-tools`。没有非沙箱失败。未改这些测试。未跑 e2e（界面除主进程 `showConversation` 忽略 card 外没有变化；`project-shell` / `project-board` 不覆盖这条通知路径）。

### 复核（对照 §7–§11，只记改过的地方）

- **删除确认计数**：`deletionPreview` 按 `direct_bot_id` 计数，卡片对话也会被算进「将清理 N 个对话」。改为只计 `type = 'direct'` 且未只读的行。消息条数仍是该 Bot 发出的全部消息。
- **`board.changed` 次数**：`when: 'now'` 和 `start` 原先在派发时发一次，取消单次排期之后再发一次（`start` 的那一次还发生在取消之前，同步监听会看到排期还在）。现在这两条路径只在取消提交之后发一次。取消指派改为先把卡片对话标只读，再发那一次 `board.changed`，监听里读到的 `conversationId` 已经是 `null`。
- **进行中改时间**：`schedule` 与换人一样拒绝，错误码 `BOARD_LOCKED`。测试补上了这一支。
- **移交终态**（DEV-047 的决定）：不取消看板排期，也不清空指派。卡片仍指派给原 Bot，状态 `scheduled`，没有 `blocked_reason`，对话可写，排期仍在该卡片对话上。不写「执行成员已移出项目组」——移交没有把 Bot 移出项目组。
- **核对后未改**：`conversations.kind` 是平台口方法（主进程 `callPlatform`），不进 `APP_METHODS`；`list` / `listVisible` / `conversations.all` / `openDirect` / `listDirectByBot` / 分享目标已排除 `card`，`conversation.updated` 仍发布。`GrantsService` 没有会话查找，授权仍是卡片对话内重新授权（见上「授权」）。`projectScopeOf` 已用在 wiki、记忆、反思、工作目录。


