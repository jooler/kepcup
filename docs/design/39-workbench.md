# 39 工作台（Workbench）：事项统筹 + 备忘 + 管家接管

用户需要一个**不进任何对话**也能统筹全局的地方：看清谁在忙什么、把念头整理成要做的事、把活派给 Bot 或群、让管家代为整理。工作台在对话之外提供三样东西：事项（待办 + 定时派活）、备忘（闪念）、管家对二者的增删改查。决策：**D90**。

**状态：已定稿，实施中**（2026-10-15 定稿并经用户确认 §6 的两项关键决策；旧版「按 Bot 列定时任务 + 备忘 tab」整体作废）。实施编排与记录见 [todo/workbench.md](../../todo/workbench.md)。早期阶段，不做向后兼容、不迁旧数据，以当前代码逻辑正确为准。

相关：D80（定时任务的自然引导，[todo/schedule-nudges.md](../../todo/schedule-nudges.md)）、D71 / D70（管家与委派，[27](27-butler-and-delegation.md)）、D75（对话轮与任务，[30](30-supervisor-and-tasks.md)）、D88（资产移交，[37](37-bot-asset-handover.md)）、D89（对话内设置的触发判据，[38](38-conversational-settings.md)）、[03-bot.md](03-bot.md)、[01-conversation.md](01-conversation.md)（群聊）、[02-execution.md](02-execution.md)（群路由与执行）。

## 决策

- **D90 工作台**：
  1. **心智模型**：每个 Bot 是用户的一名员工，群是一个项目组，管家是用户的助理。工作台是经理的看板，不是又一个对话。
  2. **一套计时引擎**：事项的定时复用 `schedules`（计时、错过补发、唤醒都复用），工作台不另造调度器。时间只存在 schedule 上，事项表不重复存。
  3. **派活是用户的指令，不是 Bot 的主动行为**：到点后宿主以「工作台代你发出」的**可见用户消息**把活派给员工，走现有的用户消息路由（私聊 / 群）。**不受**主动消息开关、免打扰、每日上限约束；`triggerFromUser=false`，执行者在这一轮里做敏感写入仍按「非本人」出卡确认。
  4. **事项归用户所有**：Bot 被删、对话被删，事项不跟着消失，而是退回草案等用户改派。
  5. **事项 ≠ Bot 自己的安排**：Bot 通过 `schedule` 工具、提议卡、例行事项、承诺建的定时任务不转成事项，仍受主动消息护栏约束；工作台只在员工分道里并列展示。**事项 = 你派的活；自排 = 员工自己的日程。**
  6. **待验收不自动完成**：Bot 说做完了不等于用户认可；用户点「完成」或告诉管家。
  7. **备忘是闪念**：纯文本，不绑对话，不进任何 Bot 的上下文；**唯一例外**是管家可通过工具读写。与对话内辅助阅读的 `stickies` 无关，另建 `memos`。
  8. **管家接管的权限边界由宿主强制**：判据与 D89 设置工具的 `effectiveMode` 一致——这一轮是不是**用户本人触发**。非本人触发的一轮里，管家只能读、记、起草，不能派活、收尾、删除。
  9. **管家的写操作可见且可撤回**：带 `source='butler'` 标记与「管家」徽标；备忘软删可恢复，事项「已取消」可 `reopen`。
  10. **权限分级判据与「不新造审批卡」**：被拒绝时管家在回复里列出建议，用户一句「好，就这么办」就是用户本人触发的下一轮，不新增审批实体。

## 1 用户视角

| 用户在想什么 | 工作台给什么 |
| ---- | ---- |
| **了解现状**：谁在忙、忙什么、什么卡住了、什么等我拍板 | 按员工 / 项目组分道的事项看板；进行中、待验收、需要你处理的汇总 |
| **思考**：脑子里冒出来的念头先记下 | 备忘（闪念）：一句话即记，随时检索 |
| **规划**：把念头整理成要做的事，暂不定人定时 | 事项草案：只写「做什么」，执行者、时间都可空 |
| **调度**：交给谁、什么时候做、做完没 | 指派给 Bot / 群 + 立即 / 定时 / 周期；到点派发，结果回流到工作台待验收 |
| **托付**：懒得自己点，让助理代管 | 管家拥有事项与备忘的增删改查工具，可代为整理、指派、排期、收尾 |

三项需求的落点：

1. **事项（待办）**：集中展示一切待处理的事。指派给 Bot → 成为该 Bot 的计划任务；指派给群 → 成为该群的计划任务；不指派执行者也不定时间 → 仅留作草案。
2. **备忘**：用户的闪念记录工具，可转成事项。
3. **管家接管**：管家可对事项、备忘增删改查，权限边界由宿主强制，不靠提示词自觉。

## 2 概念与状态

### 2.1 事项（todo）

一件要做的事。字段：标题（必填，≤ 120 字）、说明（可空，≤ 4000 字，派发时给执行者看）、执行者（空 / Bot / 群[+可选负责 Bot]）、时间（空 / 立即 / 某时 / 周期）、来源（用户 / 管家）、可选来源备忘。

**不变式**：

- 有时间 ⇒ 必有执行者。选时间而不选人，表单直接要求先选人。
- 有排期 ⇔ 存在一条 `todo_id` 指向它的 active schedule。时间只存在 schedule 上，事项表不重复存，避免两处不一致。

**状态机**：

```text
             指派+定时                 到点派发              执行者交付
  draft ───────────────▶ scheduled ───────────▶ in_progress ───────────▶ delivered
  (草案)  ───立即开始──────────────────────────▶   (进行中)               (待验收)
    ▲            │ 取消排期                          │ 群内无人认领 /           │ 用户：完成
    │            ▼                                   │ 执行者被删               ▼
    └──── 退回草案 ◀───────────────────────────────────┘                        done
  任意未结束状态 ──取消──▶ cancelled                    delivered ──退回──▶ in_progress（附追问）
```

- **周期事项**：自身停在 `scheduled`，每次触发是一条「执行记录」（`todo_runs`），各自有进行中 / 已交付；卡片显示最近一次的结果。停止周期 = `cancelled`（展示为「已停止」）。
- **待验收不自动完成**：用户点「完成」，或告诉管家「这件算完成」。「退回」= 在原对话里追加一条追问并回到进行中。
- **退回草案的原因**记在 `blocked_reason` 里显示，例如「负责 Bot 已删除」「群已解散」「群里无人认领」，等用户改派。
- `done` / `cancelled` 可经 `reopen` 恢复为草案；已关闭超过 7 天的事项默认不出现在列表里（`includeClosed` 可取回）。

### 2.2 执行者的语义

| 执行者 | 派发到哪 | 谁响应 |
| ---- | ---- | ---- |
| Bot | 该 Bot 私聊（`openDirect`，幂等；私聊不存在则建并发布会话事件） | 该 Bot |
| 群 | 该群 | 指定了负责 Bot → 消息带 @，走显式目标；未指定 → 走 triage，谁认领谁做 |
| 管家 | 管家私聊 | 管家（可以把事项交给管家本人去办，它再自行委派） |

群没有负责人角色：事项派给群与用户在群里发一句话等价，谁认领由现有群路由（`GroupTurnCoordinator` 的 triage）决定。暂不支持「我自己」作为执行者（到点提醒用户本人），列为后续增强。

### 2.3 与 Bot 自己的安排的关系

Bot 通过 `schedule` 工具、提议卡、例行事项、承诺建的定时任务，是**员工自己的安排**，不是用户派的活。

- 它们**不**转成事项，避免两份状态。
- 工作台在该员工的分道里**并列展示**，带来源标签（自排 / 例行 / 承诺 / 提议），可取消、可跳到对话。
- 它们的到点行为保持不变，仍受主动消息护栏约束。

这样「集中展示」覆盖全部待处理的事，所有权和语义仍然清楚。

### 2.4 备忘（memo）

纯文本闪念，一条一段（≤ 10000 字）。不绑对话，不进任何 Bot 的上下文。唯一例外：**管家可通过工具读写**。

可置顶，可「转为事项」（新事项记 `memo_id`，备忘保留并显示「已转事项」）。删除进「最近删除」，30 天后在启动时清理。管家也能删，因此必须可恢复。

## 3 数据、服务与派发

### 3.1 数据

main 库三张新表（迁移 `0037_workbench`，字段见 [dev/03-data-model.md](../dev/03-data-model.md)）：

- `todos`：事项。`status ∈ {draft, scheduled, in_progress, delivered, done, cancelled}`，`source ∈ {user, butler}`；执行者编码在 `assignee_bot_id` + `assignee_group_id` 上。
- `todo_runs`：每次派发一条（单次事项通常只有一条）。`status ∈ {dispatched, delivered, unclaimed, failed}`；`conversation_id` 不设外键，对话删了记录仍可读。
- `memos`：备忘。`deleted_at` 非空 = 在「最近删除」。

执行者编码：Bot 执行者 = `assignee_bot_id` 非空、`assignee_group_id` 空；群执行者 = `assignee_group_id` 非空（`assignee_bot_id` 可选，作负责 Bot）；都空 = 未指派。shared 层统一表示为 `TodoAssignee`（`{kind:'bot', botId}` / `{kind:'group', conversationId, leadBotId}` / `null`）。

检索：备忘 / 事项量级在千条以内，用 `LIKE`；超过再考虑 FTS。

### 3.2 `schedules` 的变化

SQLite 改不了 CHECK，也放宽不了 NOT NULL，所以按 0021 的写法重建 `schedules`：

- `origin` CHECK 增 `'workbench'`。
- 增 `todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL` 与索引。
- 增 `CHECK (bot_id IS NOT NULL OR origin = 'workbench')` 与单向 `CHECK (todo_id IS NULL OR origin = 'workbench')`（单向：事项硬删会把 `todo_id` 置空，孤儿 workbench 行由对账取消）。
- `bot_id` 放宽为可空。仅「派给群、未指定负责 Bot」的事项排期行为空，其余来源仍必填（service 层校验）。

`bot_id` 可空的波及面：凡按 Bot 查的路径都要能跳过空值（`listActiveForBot`、`contextSection`、`cancelForBotInConversation`、`prepareBotDeletion`、`fireabilityWarnings` / `#deferredReason`、移交适配器、定时任务列表的 Bot 名）。

### 3.3 TodoService

职责：事项 CRUD 与状态机、指派校验、排期（调 ScheduleService）、派发、交付追踪、对账。

- **排期**：`ScheduleService.createForTodo({ todoId, botId|null, conversationId, when })`，`origin='workbench'`。
  - 时间校验沿用 `validateWhen`；`when` 的口径同 `createFromWhen`：`'now'` = 立即派发，ISO 8601 = 单次，其它按 cron 解析。
  - 不走 `#assertFireable` 的 Bot 成员检查（群无负责 Bot 时没有 botId）。改由 TodoService 校验：Bot active、群未只读、负责 Bot 是群成员。
  - 目标对话里照常插回执卡，文案「工作台安排：「标题」· 周五 09:00」，状态随 schedule 回写。
- **改期**：`ScheduleService.reschedule(id, when)` 原地更新 `run_at` / `cron` / `next_fire_at` 并回写回执卡，不走「取消 + 重建」，避免时间线堆两张卡。
- **改派**：取消旧 schedule（回执卡显示「已改派」）后在新对话重建。
- **到点**：`#fire` 遇 `origin='workbench'` 时，不走 `evaluateGuard`，也不写 internal `schedule_fired`，改调 `todos.dispatch(todoId, { scheduleId, fireAt })`。`next_fire_at` / 单次置 done 的推进照旧。错过补发沿用 `catchUpMissed`，派发消息注明「原定 X，延迟派发」。
- **立即开始**：直接 `dispatch`，不建 schedule。
- **对账**（启动时 + `schedules.changed`）：
  - 状态为 `scheduled` 却没有 active schedule → 退回 `draft`，写入原因。
  - 执行者 Bot 已删 / 群已删或已只读 / 负责 Bot 已删或已移出群 → 退回 `draft`（`assignee_group_id` 不设外键：外键置空会把「群 + 负责 Bot」静默读成 Bot 执行者）。
  - `origin='workbench'` 的 active 排期若事项已不存在（硬删）或事项不在 `scheduled` → 取消该排期。
  - 不依赖各删除路径都记得调钩子：conversations 的 FK 级联会绕过 service，对账才是兜底。
- **D88 移交**：移交适配器搬 schedule 时带上 `todo_id`，TodoService 把 `assignee_bot_id` 改到接收方。

### 3.4 派发：工作台代你发出

派发 = 宿主在目标对话里追加一条**可见消息**，然后按用户消息路由。消息构成：

- `senderType='user'`，`textContent.origin='workbench'`，带 `todoId` / `todoRunId`；触发这次派发的操作是管家做的另带 `viaButler: true`（到点派发取最后一次设置排期的操作者）；事项由管家起草过另带 `butlerDrafted: true`（说明按不可信数据对待）。
- 正文为 `【工作台】标题` + 说明。管家建的事项另加「（管家代你安排）」。
- 群里指定了负责 Bot 时，加结构化 @。
- 界面上渲染成「派发卡」而不是普通气泡：标题、说明、「在工作台查看」。

路由：

- 私聊走直聊投递闸口（`#deliverDirectThroughGate`）。
- 群走 `GroupTurnCoordinator`：有 @ 走显式目标，无 @ 走 triage。

为什么这样做：

- **不受主动消息护栏约束**：派活是用户的指令。Bot 关了主动消息、正处免打扰、今天发够 5 条，都不该让用户排的活静默不执行。时间是用户选的，即使在深夜，用户也是知情的。
- **群语义自然成立**：群里本来就没有负责人，事项派给群与在群里发一句话等价，谁认领由现有 triage 决定。
- **时间线可审计**：员工私聊里能看到「老板什么时候交代了什么」。

约束：

- **不算用户本人触发**：与 D71 委派代发相同，`triggerFromUser=false`。执行者在这一轮里做敏感设置写入，仍按「非本人」出卡确认。到点时用户未必在场，不能借派发消息绕过确认。
- **记忆证据**：`source='butler'` 的事项派发消息不算用户原话。反思不能把它当用户偏好的证据，对齐 D71。
- **执行者提示**：系统提示加一条规则：「工作台派发的事项：做完给出明确结论；做不了说明原因与需要什么。」便于用户验收。

### 3.5 交付追踪

照搬定时轮的 `#scheduleSourceOf` 链路，泛化出「事项来源」：

- 批次里含 `origin='workbench'` 的消息，或任务的 `origin_run_id` 的触发里含它 → 这一轮属于该 `todoRunId`。
- 该轮结算时出了可见回复，且同链路没有未结算任务（`runs.origin_run_id` = 该轮且非终态）→ `todo_runs.status='delivered'`，`result_message_id` = 该回复，事项进入 `delivered`。
- 回复带「📋 标题」标签，对照现有「⏰ 标题」。
- 执行者的轮失败 / 被取消 → 执行记录 `failed`，事项退回草案，原因为「执行失败：…」/「执行已被取消」，用户可重新开始。
- 群：一轮结束仍无人响应、出现 `group_no_claim` → `unclaimed`，事项退回草案，原因为「群里无人认领」。多个 Bot 响应时，以最后结算者为准，所有回复都挂在执行记录下。
- 兜底：执行者正在跑时消息会被 steer 进当前 run，归属可能落到别的批次。追踪失败时事项停在「进行中」，用户可手动标完成。**追踪是增强，不是正确性前提。**

### 3.6 RPC 与事件（shared 契约）

| 方法 | 入参 | 出参 |
| ---- | ---- | ---- |
| `todos.list` | `{ statuses?, query?, includeClosed? }` | `{ todos: TodoEntry[] }` |
| `todos.get` | `{ id }` | `{ todo: TodoEntry, runs: TodoRun[] }` |
| `todos.create` | `{ title, notes?, assignee?: TodoAssignee \| null, when?: string \| null, memoId? }` | `{ todo: TodoEntry, warnings: string[] }` |
| `todos.update` | `{ id, title?, notes?, assignee?: TodoAssignee \| null, when?: string \| null }` | `{ todo: TodoEntry, warnings: string[] }` |
| `todos.start` | `{ id }` 立即派发（需已有执行者） | `{ todo: TodoEntry }` |
| `todos.complete` / `todos.cancel` / `todos.reopen` | `{ id }` | `{ todo: TodoEntry }` |
| `memos.list` | `{ query?, trashed? }` | `{ memos: Memo[] }` |
| `memos.create` | `{ body }` | `{ memo: Memo }` |
| `memos.update` | `{ id, body?, pinned? }` | `{ memo: Memo }` |
| `memos.delete` / `memos.restore` | `{ id }`；`delete` = 移入最近删除 | `{ memo: Memo }` |

- `TodoEntry` = 事项 + `assigneeName` / `leadBotName`（Bot 名或群名）+ 当前 active `schedule`（`id` / `kind` / `runAt` / `cron` / `timezone` / `nextFireAt`，无排期为 `null`）+ `lastRun`。人话时间由界面用 `describeScheduleWhen` 渲染。
- `when` 的口径：`'now'` = 立即派发；ISO 8601 = 单次；其它按 cron 解析（同 `createFromWhen`）；`null` = 清空排期；省略 = 不变（create 时即不定时）。`assignee: null` = 清空执行者，会连带清排期、退回草案。
- `warnings` 就地显示在界面上，例如「该 Bot 未配置模型」「群已只读」。主动消息相关的警告对事项不再出现（§3.4）。
- 事件：`todos.changed { todoId }`、`memos.changed { memoId }`（管家在后台改了，工作台要实时跟上）。`schedules.changed` 保留。
- 汇总方法 `workbench.summary`（需要你处理 / 进行中 / 待验收 / 今天的计数与条目）属于后续增强，不在首批契约内。

## 4 界面

### 4.1 入口与主视图

- 左栏「工作台」条目放在管家之上，图标 `LayoutDashboard`，`data-testid="workbench-nav"`。折叠态只显示图标。徽标 = 待验收 + 需要你处理的数量（后续增强）。
- 新增 `shell.mainView: 'chats' | 'workbench'`，主区按它渲染工作台或对话区。
- **收口不变式**：只在 `chat.select()` 内部置 `mainView='chats'`，所有跳转（侧栏、搜索、通知、深链、卡片跳转）自然回到对话，不逐点修改。点「工作台」只改 `mainView`，**不清** `chat.currentId`，草稿、已读、右栏状态都不受影响。
- 侧栏对话行的选中高亮改为派生：`mainView==='chats' && id===currentId`。工作台打开时没有对话高亮。
- 启动默认进对话（保持现状）。`mainView` 不持久化。

### 4.2 工作台布局（宽屏）

```text
┌ 工作台 ───────────────────────────────────────────────────────────────┐
│ [需要你处理 2] [进行中 3] [待验收 1] [今天 4] [草案 5]   ← 汇总条，点击即筛选（后续）│
├──────────────────────────────────────────────┬────────────────────────┤
│ 事项                     [按成员 | 按时间]      │ 备忘                    │
│ ┌ + 记一件事…（回车存为草案）───────────────┐  │ ┌ 闪念…（回车保存）────┐ │
│ └──────────────────────────────────────────┘  │ └─────────────────────┘ │
│ ▾ 未指派 · 5                                   │ 🔍 搜索                 │
│   [卡] [卡] [卡] …                              │ 📌 下周和 A 公司谈价…    │
│ ▾ 🤖 写作助手 · 进行中 1 · 下次 周五 09:00       │ · 试试把周报交给…       │
│   [事项卡] [事项卡] [自排·例行 每天 08:00]       │ · …                    │
│ ▾ 👥 产品组 · 待验收 1                          │                        │
│   [事项卡 @研究员]                              │                        │
│ ▸ 空闲成员：🤖 翻译 🤖 研究员（点击给他派活）      │ 最近删除                │
└──────────────────────────────────────────────┴────────────────────────┘
```

- 双栏是有意的：「思考」（备忘）和「规划 / 调度」（事项）同屏，备忘可一键转为事项。窄于阈值时折成「事项 / 备忘」两个 tab。
- **按成员**（默认，员工视角）：
  - 第一道为「未指派」，之后是有事的 Bot 和群。Bot 在前，排序依次为：有待验收的、有进行中的、下次时间最近的。
  - 道头显示忙闲：进行中任务数取自 `runningBotIds` / 任务，再加下次排期时间。
  - 没有事的 Bot 收进「空闲成员」条，不占道。点头像即为他新建事项。
- **按时间**：逾期未交付 / 今天 / 明天 / 本周 / 以后 / 未排期。周期事项按下次触发时间归组。
- **事项卡**：标题、执行者徽标、人话时间、状态胶囊、来源徽标（管家）、`blocked_reason` 警示。主操作随状态变化：草案 → 指派 / 立即开始；已排期 → 改期；进行中 → 打开对话；待验收 → 查看结果 / 完成 / 退回。
- **自排卡**（§2.3）：来源徽标、人话时间、`deferredReason` 警示（如「该 Bot 已关闭主动消息」）、取消、打开对话。
- **事项详情抽屉**（点卡打开，在工作台内从右侧滑出，不跳走）：
  - 编辑标题和说明。
  - 执行者选择器：Bot 列表 / 群列表；选群时可选负责 Bot。只列 active Bot 和非只读群，管家可选。
  - 时间选择器：不定 / 立即 / 某时 / 重复。重复用预设：每天 / 工作日 / 每周几 / 每月几号 + 时刻；自定义 cron 属后续增强。实时显示「下次：…」。
  - 执行记录（每次派发 → 结果摘要 + 跳到对话里那条回复）。
  - 底部：完成 / 取消 / 退回草案。
- **派发前提示**：`todos.create` / `update` 返回的 `warnings` 就地显示。
- 拖拽：备忘拖到某员工道 = 转为事项并指派；草案拖道 = 改派（后续增强）。

### 4.3 「需要你处理」与「进行中」（后续增强）

经理最怕「活卡在我这儿而我不知道」。汇总条只读引用现有实体，点条目跳到对应对话里的那张卡：

| 汇总 | 来源 |
| ---- | ---- |
| 需要你处理 | 待决审批（`approvals.list` 全局）、等你回答的任务提问（runs `awaiting_input`）、待你答复的定时提议卡（offer pending）、群里无人认领 |
| 进行中 | 进行中的事项 + 全局活跃任务（需新增不带 conversationId 的 `tasks.active` 变体） |
| 待验收 / 今天 / 草案 | 事项本身 |

由 `workbench.summary` 一次聚合返回，监听相关事件去抖刷新。

### 4.4 备忘栏

- 顶部常驻输入框：回车保存，Shift+回车换行，存完清空并保持焦点，连续记录不打断。
- 列表：置顶在前，其余按更新时间倒序。卡片正文最多显示 6 行，显示相对时间和来源徽标（管家记的）。
- 操作：编辑（原地）、置顶、转为事项（打开事项抽屉并预填：首行作标题，全文作说明）、删除。
- 搜索：本地即时过滤，空态和无结果分别给文案。
- 「最近删除」：可恢复，30 天后启动时清理。
- 全局快捷键（如 Ctrl/Cmd+Shift+M），在任何界面弹出闪念输入（后续增强）。

### 4.5 窄屏（后续增强）

底部 tab 增加「工作台」，变为 5 个 tab。工作台是经理的「首页」，地位等同于对话，不应该藏在对话列表顶部。单栏内用「事项 / 备忘」切换，事项详情走全屏详情层（复用窄屏详情层与返回手势）。

## 5 管家接管

### 5.1 工具（仅管家注册，turn 工具面）

| 工具 | 参数 | 说明 |
| ---- | ---- | ---- |
| `list_todos` | `status?`、`assignee?`、`query?`、`limit?` | 只读；结果包 `untrustedBlock`（标题 / 说明可能来自网页摘录） |
| `create_todo` | `title`、`notes?`、`assignee?`（`{bot}` / `{group, lead_bot?}`）、`when?`（`now` / ISO / cron）、`from_memo?` | 不填执行者和时间即为草案 |
| `update_todo` | `id` + 任意字段；`assignee: null` / `when: null` 为清空 | 改派、改期、退回草案 |
| `close_todo` | `id`、`outcome: 'done' \| 'cancelled'`、`reason?` | 收尾；不提供硬删除 |
| `list_memos` | `query?`、`limit?`、`include_trashed?` | 只读，`untrustedBlock` |
| `create_memo` / `update_memo` | `body` / `id, body?, pinned?` | 「帮我记一下…」 |
| `delete_memo` | `id` | 移入最近删除，可恢复 |

工具注册清单要同步更新：`effects/classify.ts` 的写工具归为 `local`、`list_*` 归为 `none`（`READ_ONLY_TOOLS` 里的工具必须是 `none`，tool-effects 单测强制）；`external/capabilities.ts` 的 `READ_ONLY_TOOLS` 加入 `list_*`，`DESTRUCTIVE_TOOLS` 加入 `close_todo`、`delete_memo`；`settings/context.ts`：`list_*` 读用户写的内容，登记为不可信，写工具登记为可信。`create_todo` / `update_todo` 的 effects 分类参数敏感：`when === 'now'`（让另一个 Bot 立刻动起来）为 `external`，其余 `local`。

落地（W2-butler）：

- 工具在 `tools/workbench-tools.ts`，经 `ResponseToolDeps.workbench = { host, triggerFromUser, touchedExternal }` 注册，仅当 `butler.isButler`、仅对话轮（外部引擎的 turn 不存在，task 面不注册；shared 的能力包不含这些工具）。工具执行处再用 `host.isButler(identity.botId)` 核对调用者（同 `dispatch/butler.ts` 的 `systemRole === 'butler'` 检查）。
- `triggerFromUser` 由 orchestrator 在 run 开始时算定：`settings/context.ts` 的 `triggerFromUser(batch)` 且触发原因 ∈ `SETTING_DIRECT_TRIGGERS`，即 `effectiveMode` 的 `userTriggered` 口径；与设置工具共用同一份 `fromUser`。
- 参数名 snake_case：`assignee` 为 `{ bot_id }` 或 `{ group_id, lead_bot_id? }`；`close_todo.reason` 只回显给管家，不写入事项（事项没有对应字段）。参数是扁平结构：`assignee: { bot_id? , group_id?, lead_bot_id? }` 加 `clear_assignee`，`when` 加 `clear_when`（不用嵌套联合 / null，兼容更多 OpenAI 兼容服务商）。写工具的结果只回 id 与状态，不回显标题 / 执行者名。

### 5.2 权限边界（宿主强制）

判据与设置工具的 `effectiveMode` 一致，看这一轮是不是用户本人触发（`triggerFromUser`），再加一条「本轮是否读过外部内容」：

| 操作 | 用户本人触发，且本轮没读过外部内容 | 用户本人触发，但本轮读过外部内容 | 非本人触发（定时、事件、委派回执、代发） |
| ---- | ---- | ---- | ---- |
| 读取（`list_*`） | 允许 | 允许 | 允许 |
| 记备忘、置顶备忘 | 直接执行 | 直接执行 | 直接执行（可撤回） |
| 改备忘正文（整段覆盖，不可恢复） | 直接执行 | 直接执行 | 拒绝 |
| 建草案（无执行者、无时间）、改草案的标题和说明 | 直接执行 | 直接执行 | 直接执行（无副作用，可撤回） |
| 指派、排期、立即开始、改派、改期 | 直接执行 | 拒绝，要求先向用户复述 | 拒绝，提示「需要用户确认，请在回复里向用户提议」 |
| 收尾（完成 / 取消）、删除备忘 | 直接执行 | 拒绝，同上 | 拒绝，同上 |

**读过外部内容**：本 run 已经调用过会带进外部内容的工具（邮件、网页、附件、连接应用、MCP、历史消息搜索等，口径同设置工具的 `touchedUntrusted`，含触发消息自带附件），或该对话处于 D73 污点期。**工作台自己的 `list_todos` / `list_memos` 不算**（它们在设置的工具分类里仍按不可信处理，但对工作台工具不算污点，否则「列出草案再安排」走不通）。执行时实时判断，读外部内容可以发生在同一轮的工具调用之间。被拒绝的文案：「本轮读取过外部内容（邮件 / 网页 / 附件等），不能直接执行；请向用户复述要做的事（标题、说明、执行者、时间），用户确认后再执行」。

理由：「让别的员工动起来」和「删东西」只在用户当面交代、且管家没被外部内容左右时由管家直接执行。管家自己的晨报、定时整理只能提建议和起草，不会半夜替用户派活；读了邮件 / 网页之后同理，要先把要做的事（含可能混入外部内容的说明）摆给用户过目。被拒绝时，管家在回复里列出建议，用户一句「好，就这么办」就是用户本人触发的下一轮，不必新造审批卡。改备忘正文是整段覆盖且不可恢复，比删除（进最近删除，可恢复）更危险，所以非本人触发的轮只允许改置顶。

**周期事项上的 `update_todo(when:'now')`**：工具语义是「额外执行一次、保留周期」（走 `start`）；要停掉周期用 `close_todo` 或 `clear_when`。界面上「把重复改成立即」的语义是结束周期，由 core 的 `update(when:'now')` 实现；两处刻意不同。

**可见性**：

- 管家的写操作都带 `source='butler'` 标记。工作台卡片显示「管家」徽标，`todos.changed` 让工作台实时刷新。
- 管家私聊里，工具调用照常显示在活动记录中，管家在回复里说明改了什么。
- 备忘可从「最近删除」恢复，事项的「已取消」可 `reopen`。管家犯错都能撤回。

### 5.3 管家的工作台上下文

管家每一轮的系统提示注入一个精简的 `<workbench>` 段，写法对照 `contextSection`，只放计数和要紧条目，不放全文：

```text
<workbench>
草案 5 条（最早 3 天前）；待验收 1 条：「整理竞品报告」（研究员，昨天交付）
进行中 2 条；今天排期 2 条；逾期未交付 0 条
备忘 23 条（最近：今天 10:12「下周和 A 公司谈价…」）
需要细节用 list_todos / list_memos。
</workbench>
```

提示词补充（`BUTLER_RULES`）：

- 用户说「记一下 / 别忘了」→ 记备忘，或建草案。有明确的人和时间才建排期事项。
- 「帮我安排 / 排一下」→ 先看草案和各员工忙闲（`list_todos` + `list_bots`），给出指派方案；用户点头后再落地。
- 事项与委派的区别：用户要求「在这里等结果」用 `delegate_to_bot`；「交给谁去办、回头看」用事项。

### 5.4 员工侧（后续增强）

被指派的 Bot 在自己的 `schedules` 上下文段里能看到「工作台派给你的事项」（标题 + 时间），这样被问到「你周五要干嘛」时答得上来。员工**不能**改事项，状态由宿主根据交付推进。

## 6 决策状态

**已定（2026-10-15，用户确认）**：

1. **派发方式**（§3.4）：到点以「工作台代你发出」的可见消息派给员工，不受主动消息开关、免打扰、每日上限约束。
2. **管家权限边界**（§5.2）：非本人触发的一轮里，管家只能读、记、起草，不能派活、收尾、删除。

**按推荐默认实施（用户未单独表态，可随时改口）**：

3. **待验收需手动完成**（§2.1）：不自动完成；如果嫌多，后续提供「全部标为完成」。
4. **窄屏入口**：底部增加第 5 个 tab「工作台」（后续增强才涉及）。
5. **设置页定时总览**：后续改为跳转工作台（设置里不再重复一份）。

## 非目标

- 不在工作台里聊天、改 Bot 人设、管 Skills / MCP / 连接。
- 不重做调度引擎；Bot 自排定时任务的到点语义不变。
- 不把 stickies 改造成备忘；备忘不进普通 Bot 的上下文。
- 不做多用户 / 云同步、事项依赖关系、甘特图、子任务。
- 普通 Bot 不能操作事项和备忘（只有管家可以）。

## 风险

- **`schedules` 重建 + `bot_id` 可空**：波及面集中在按 Bot 查询的路径（§3.2 已列）。迁移测试覆盖旧行原样保留、索引和 FK 完好。
- **深夜派发**：不受免打扰约束意味着凌晨的事项会准时执行并产生消息。这是用户自己选的时间；界面在选择免打扰时段内的时间时给一行提示即可，不拦截。
- **交付追踪的边界**：steer 合批、群多人响应时，归属可能不准。设计上降级为「停在进行中、可手动完成」，不影响正确性。
- **管家误操作**：靠 §5.2 的触发判据、软删除、`reopen` 与来源徽标兜底。
