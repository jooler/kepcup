# 工作台（Workbench）：事项统筹 + 备忘 + 管家接管

> 状态：**已定稿，P0 实施中**（2026-10-15 重写并经用户确认 §8；旧版「按 Bot 列定时任务 + 备忘 tab」整体作废）。实施编排与记录见 §12。
> 决策编号：拟 **D90**（合入前以 `docs/design/README.md` 实况为准；当前最新 D89）。设计正文定稿后落 `docs/design/39-workbench.md`。
> 早期阶段：不做向后兼容、不迁旧数据；以当前代码逻辑正确为准。

## 1. 用户视角与目标

**心智模型**：每个 Bot 是用户的一名员工，群是一个项目组，管家是用户的助理。用户需要一个**不进任何对话**也能统筹全局的地方：

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

原则：

- **一套计时引擎**：定时继续用 `schedules`（计时、错过补发、唤醒都复用），工作台不另造调度器。
- **派活是用户的指令，不是 Bot 的主动行为**：到点后以「工作台代你发出」的**可见消息**派给员工，单聊 / 群聊都走现有的用户消息路由（见 §4.4）。
- **事项归用户所有**：Bot 被删、对话被删，事项不跟着消失，而是退回草案等你改派。

## 2. 现状（2026-10-15 读代码）

| 区域 | 现状 | 对本设计的影响 |
| ---- | ---- | ---- |
| 主区 | `App.svelte` 宽屏恒为 `ChatsArea`；`shell.svelte.ts` 注释「主界面只有对话一个视图」；设置 / 扩展中心是弹框 | 需新增主视图切换 |
| 左栏 | `AppSidebar.svelte`：管家行由 `isButlerConversation` 筛出，固定在分组之上（l.802 起）；点行 = `chat.select(id)`，全仓 13 个调用点 + 启动恢复上次对话 | 工作台入口放管家之上；主视图切换必须收口到一处 |
| 窄屏 | `NarrowShell` 底部 tab：对话 / 通讯录 / 扩展 / 我 | 见 §5.5 |
| 定时任务 | `schedules`（0011 + 0022）：`bot_id`、`conversation_id` 均 NOT NULL；`origin ∈ {tool,offer,proposal,commitment}`；无用户侧 create RPC | 事项定时复用此表，需重建（§4.3） |
| 定时触发 | `#fire` → `evaluateGuard`（主动消息开关 / 免打扰 / 每日上限 5）→ `deliverScheduleToBot`：写 internal `schedule_fired`，**直投该 Bot 邮箱，绕过群路由** | 用户派的活不应受「主动消息」护栏约束；群也不该被绕过——所以事项走另一条派发路径 |
| 定时结果归属 | 定时轮回复与其派生任务的结果带 `scheduleId`（`orchestrator.ts` `#scheduleSourceOf`） | 「派发 → 交付」的追踪可照搬此链路 |
| 群路由 | `GroupTurnCoordinator`：有 @ / 回复 → 按目标顺序；无目标 → 全员 triage（`respond`/`not_mine`/`no_action`），无人认领发 `group_no_claim`。群**没有**负责人角色 | 派给群 = 在群里发一条消息，可选 @ 一位负责 Bot |
| 待处理实体 | 定时任务、提议卡（offer）、任务（runs `loop_type='task'`，`tasks.active` 需 conversationId）、委派、承诺（各 Bot memory.db）、盯梢（watches）、审批（`approvals.list` 可全局） | 工作台汇总时只读引用，不复制 |
| 管家工具 | turn 工具面 `butlerTools`（`tools/index.ts` l.1050）；`propose_*` / `suggest_route` / `inspect_bot_assets` / `propose_handover`；**没有**任何工具能给别的 Bot 建定时任务 | 新增事项 / 备忘工具，仅管家注册 |
| 写权限分级 | 设置工具 `effectiveMode`（`settings-catalog/mode.ts`）：`triggerFromUser` 为假（定时、事件、代发消息）一律升级为出卡确认 | 管家事项工具照搬「是否用户本人触发」这一判据（§6.2） |
| 上下文注入 | `ScheduleService.contextSection` / `WatchService.contextSection` → 系统提示里的分段 | 管家 `<workbench>` 段、员工的「工作台派给你的事」同此模式 |
| 备忘 | 不存在；`stickies` 是对话内辅助阅读便签（绑对话、浮在消息上） | 新建 `memos`，与 stickies 无关 |

## 3. 概念与状态

### 3.1 事项（todo）

一件要做的事。字段：标题（必填）、说明（可空，派发时给执行者看）、执行者（空 / Bot / 群[+可选负责 Bot]）、时间（空 / 立即 / 某时 / 周期）、来源（用户 / 管家）、可选来源备忘。

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
- **待验收不自动完成**：Bot 说做完了，不等于你认可。用户点「完成」，或告诉管家「这件算完成」。「退回」= 在原对话里追加一条追问并回到进行中（P1）。
- **退回草案的原因**会记在 `blocked_reason` 里显示，例如「负责 Bot 已删除」「群已解散」「群里无人认领」，等你改派。

### 3.2 执行者的语义

| 执行者 | 派发到哪 | 谁响应 |
| ---- | ---- | ---- |
| Bot | 该 Bot 私聊（`openDirect`，幂等；私聊不存在则建并发布会话事件） | 该 Bot |
| 群 | 该群 | 指定了负责 Bot → 消息带 @，走显式目标；未指定 → 走 triage，谁认领谁做 |
| 管家 | 管家私聊 | 管家（可以把事项交给管家本人去办，它再自行委派） |

暂不支持「我自己」作为执行者（到点提醒用户本人）。列为 P2（§9）。

### 3.3 与现有「Bot 自己的安排」的关系

Bot 通过 `schedule` 工具、提议卡、例行事项、承诺建的定时任务，是**员工自己的安排**，不是你派的活。

- 它们**不**转成事项，避免两份状态。
- 工作台在该员工的分道里**并列展示**，带来源标签（自排 / 例行 / 承诺 / 提议），可取消、可跳到对话。
- 它们的到点行为保持不变，仍受主动消息护栏约束。

这样「集中展示」覆盖全部待处理的事，而所有权和语义仍然清楚：**事项 = 你派的活；自排 = 员工自己的日程**。

### 3.4 备忘（memo）

纯文本闪念，一条一段。不绑对话，不进任何 Bot 的上下文。唯一例外：**管家可通过工具读写**（需求 3）。

可置顶，可「转为事项」（新事项记 `memo_id`，备忘保留并显示「已转事项」）。删除进「最近删除」，30 天后清理。管家也能删，因此必须可恢复。

## 4. 数据、服务与派发

### 4.1 新表（main 库迁移；撰写时最新 `0036`，合入时按 main 实况重编）

```sql
CREATE TABLE todos (
  id                TEXT PRIMARY KEY,                -- todo_
  title             TEXT NOT NULL,                   -- ≤ 120 字
  notes             TEXT NOT NULL DEFAULT '',        -- ≤ 4000 字；派发时给执行者
  assignee_bot_id   TEXT,                            -- Bot 执行者；群执行者时 = 可选的负责 Bot
  assignee_group_id TEXT,                            -- 群执行者；不设 FK（见 §12.4：FK 置空会把群事项读成 Bot 执行者）
  status            TEXT NOT NULL CHECK (status IN
                      ('draft','scheduled','in_progress','delivered','done','cancelled')),
  source            TEXT NOT NULL CHECK (source IN ('user','butler')),
  memo_id           TEXT,                            -- 由哪条备忘转来（不设 FK，备忘清理不影响）
  blocked_reason    TEXT,                            -- 退回草案的原因（展示用）
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER                          -- done / cancelled 时间
);
CREATE INDEX todos_status ON todos(status, updated_at DESC);

CREATE TABLE todo_runs (                              -- 每次派发一条（单次事项通常只有一条）
  id                TEXT PRIMARY KEY,                -- tdr_
  todo_id           TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  conversation_id   TEXT NOT NULL,                   -- 派到的对话（不设 FK：对话删了记录仍可读）
  message_id        TEXT,                            -- 派发消息
  status            TEXT NOT NULL CHECK (status IN ('dispatched','delivered','unclaimed','failed')),
  result_message_id TEXT,                            -- 交付的那条回复
  dispatched_at     INTEGER NOT NULL,
  settled_at        INTEGER
);
CREATE INDEX todo_runs_todo ON todo_runs(todo_id, dispatched_at DESC);

CREATE TABLE memos (
  id         TEXT PRIMARY KEY,                       -- memo_
  body       TEXT NOT NULL,                          -- ≤ 10000 字，纯文本
  pinned     INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL CHECK (source IN ('user','butler')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                                 -- 非空 = 在「最近删除」
);
CREATE INDEX memos_live ON memos(deleted_at, pinned DESC, updated_at DESC);
```

- 执行者编码：Bot 执行者 = `assignee_bot_id` 非空、`assignee_group_id` 空；群执行者 = `assignee_group_id` 非空（`assignee_bot_id` 可选，作负责 Bot）；都空 = 未指派。
- 检索：备忘 / 事项量级在千条以内，P0 用 `LIKE`。超过再上 FTS（P2）。

### 4.2 `schedules` 重建

SQLite 改不了 CHECK，也放宽不了 NOT NULL，所以按 0021 的重建写法：建新表 → 拷数据 → 删旧 → 改名 → 重建索引。改动如下：

- `origin` CHECK 增 `'workbench'`。
- 增 `todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL`。
- `bot_id` 放宽为可空。仅「派给群、未指定负责 Bot」的事项行为空，其余来源仍必填（service 层校验）。

`bot_id` 可空的波及面要逐一过一遍。凡按 Bot 查的都要能跳过空值：`listActiveForBot`、`contextSection`、`cancelForBotInConversation`、`prepareBotDeletion`、`fireabilityWarnings` / `#deferredReason`、移交适配器 `handover/adapters/schedule.ts`、`SchedulesPanel` 的 `botName`。

### 4.3 TodoService（core 新服务）

职责：事项 CRUD 与状态机、指派校验、排期（调 ScheduleService）、派发、交付追踪、对账。

- **排期**：`ScheduleService.createForTodo({ todoId, botId|null, conversationId, when })`，`origin='workbench'`。
  - 时间校验沿用 `validateWhen`。
  - 不走 `#assertFireable` 的 Bot 成员检查（群无负责 Bot 时没有 botId）。改由 TodoService 校验：Bot active、群未只读、负责 Bot 是群成员。
  - 目标对话里照常插回执卡，文案为「工作台安排：「标题」· 周五 09:00」，状态随 schedule 回写，复用 `#syncCards`。
- **改期**：新增 `ScheduleService.reschedule(id, when)`，原地更新 `run_at` / `cron` / `next_fire_at` 并回写回执卡。不走「取消 + 重建」，避免时间线堆两张卡。
- **改派**：取消旧 schedule（回执卡显示「已改派」）后在新对话重建。
- **到点**：`#fire` 遇 `origin='workbench'` 时，不走 `evaluateGuard`，也不写 internal `schedule_fired`，改调 `todos.dispatch(todoId, { scheduleId, fireAt })`。`next_fire_at` / 单次置 done 的推进照旧。错过补发沿用 `catchUpMissed`，派发消息注明「原定 X，延迟派发」。
- **立即开始**：直接 `dispatch`，不建 schedule。
- **对账**（启动时 + `schedules.changed`）：
  - 状态为 `scheduled` 却没有 active schedule → 退回 `draft`，写入原因。
  - 执行者 Bot 已删 / 群已删 → 退回 `draft`。
  - 不依赖各删除路径都记得调钩子：conversations 的 FK 级联会绕过 service，对账才是兜底。
- **D88 移交**：移交适配器搬 schedule 时带上 `todo_id`，TodoService 把 `assignee_bot_id` 改到接收方。

### 4.4 派发：工作台代你发出

派发 = 宿主在目标对话里追加一条**可见消息**，然后按用户消息路由。消息构成如下：

- `senderType='user'`，`textContent.origin='workbench'`，带 `todoId` / `todoRunId`。
- 正文为 `【工作台】标题` + 说明。管家建的事项另加「（管家代你安排）」。
- 群里指定了负责 Bot 时，加结构化 @。
- 界面上渲染成「派发卡」而不是普通气泡：标题、说明、「在工作台查看」。

路由：

- 私聊走直聊投递闸口（`#deliverDirectThroughGate`）。
- 群走 `GroupTurnCoordinator`：有 @ 走显式目标，无 @ 走 triage。

为什么这样做：

- **不受主动消息护栏约束**：派活是用户的指令。Bot 关了主动消息、正处免打扰、今天发够 5 条，都不该让你排的活静默不执行。时间是你选的，即使在深夜，你也是知情的。
- **群语义自然成立**：群里本来就没有负责人，事项派给群和你在群里发一句话等价，谁认领由现有 triage 决定。
- **时间线可审计**：员工私聊里能看到「老板什么时候交代了什么」。

几条约束：

- **不算用户本人触发**：与 D71 委派代发相同，`triggerFromUser=false`。执行者在这一轮里做敏感设置写入，仍按「非本人」出卡确认。到点时用户未必在场，不能借派发消息绕过确认。
- **记忆证据**：`source='butler'` 的事项派发消息不算用户原话。反思不能把它当用户偏好的证据，对齐 D71 的处理。
- **执行者提示**：系统提示加一条规则：「工作台派发的事项：做完给出明确结论；做不了说明原因与需要什么。」便于用户验收。

### 4.5 交付追踪

照搬 `#scheduleSourceOf` 的链路，泛化出「事项来源」：

- 批次里含 `origin='workbench'` 的消息，或任务的 `origin_run_id` 的触发里含它 → 这一轮属于该 `todoRunId`。
- 该轮结算时出了可见回复，且同链路没有未结算任务（`runs.origin_run_id` = 该轮且非终态）→ `todo_runs.status='delivered'`，`result_message_id` = 该回复，事项进入 `delivered`。
- 回复带「📋 标题」标签，对照现有「⏰ 标题」。
- 群：一轮结束仍无人响应、出现 `group_no_claim` → `unclaimed`，事项退回草案，原因为「群里无人认领」。多个 Bot 响应时，以最后结算者为准，所有回复都挂在执行记录下。
- 兜底：如果执行者正在跑，消息会被 steer 进当前 run，归属可能落到别的批次。追踪失败时事项停在「进行中」，用户可手动标完成。追踪是增强，不是正确性前提。

### 4.6 RPC 与事件（shared 契约）

| 方法 | 说明 |
| ---- | ---- |
| `todos.list` | `{ statuses?, assignee?, query?, includeClosedDays? }` → `TodoEntry[]`（含执行者名、下次时间、人话时间、最近一次执行记录、`blocked_reason`）；默认不含 7 天前关闭的 |
| `todos.get` | `{ id }` → 事项 + 全部执行记录 |
| `todos.create` | `{ title, notes?, assignee?, when?, memoId? }`；`when`：省略 = 不定时，`'now'` = 立即派发，ISO / cron 与 `createFromWhen` 同口径；返回 `{ todo, warnings }` |
| `todos.update` | `{ id, title?, notes?, assignee?: … \| null, when?: … \| null }`；`null` = 清空（清执行者会连带清排期，退回草案） |
| `todos.start` | `{ id }` 立即派发（需已有执行者） |
| `todos.complete` / `todos.cancel` / `todos.reopen` | 状态迁移；`reopen` 用于从 done / cancelled 恢复为草案 |
| `memos.list` | `{ query?, trashed? }` |
| `memos.create` / `memos.update` / `memos.delete` / `memos.restore` | `delete` = 移入最近删除；`update` 支持 `pinned` |
| `workbench.summary`（P1） | 需要你处理 / 进行中 / 待验收 / 今天的计数与条目（§5.3） |

事件：`todos.changed`、`memos.changed`（管家在后台改了，工作台要实时跟上）。`schedules.changed` 保留。

## 5. 界面

### 5.1 入口与主视图

- 左栏「工作台」条目放在管家之上，图标 `LayoutDashboard`，`data-testid="workbench-nav"`。折叠态只显示图标。徽标 = 待验收 + 需要你处理的数量（P1）。
- 新增 `shell.mainView: 'chats' | 'workbench'`，`App.svelte` 按它渲染 `WorkbenchView` 或 `ChatsArea`。
- **收口不变式**：只在 `chat.select()` 内部置 `mainView='chats'`，所有跳转（侧栏、搜索、通知、深链、卡片跳转）自然回到对话，不逐点修改。点「工作台」只改 `mainView`，**不清** `chat.currentId`，草稿、已读、右栏状态都不受影响。
- 侧栏对话行的选中高亮改为派生：`mainView==='chats' && id===currentId`。工作台打开时没有对话高亮。
- 启动默认进对话（保持现状）。`mainView` 不持久化。

### 5.2 工作台布局（宽屏）

```text
┌ 工作台 ───────────────────────────────────────────────────────────────┐
│ [需要你处理 2] [进行中 3] [待验收 1] [今天 4] [草案 5]   ← 汇总条，点击即筛选（P1）│
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
  - 没有事的 Bot 收进「空闲成员」条，不占道。经理想知道谁有空，点头像即为他新建事项。
- **按时间**：逾期未交付 / 今天 / 明天 / 本周 / 以后 / 未排期。周期事项按下次触发时间归组。
- **事项卡**：标题、执行者徽标、人话时间（复用 `describeScheduleWhen`）、状态胶囊、来源徽标（管家）、`blocked_reason` 警示。主操作随状态变化：
  - 草案：指派 / 立即开始
  - 已排期：改期
  - 进行中：打开对话
  - 待验收：查看结果 / 完成 / 退回
- **自排卡**（§3.3）：来源徽标、人话时间、`deferredReason` 警示（如「该 Bot 已关闭主动消息」）、取消、打开对话。
- **事项详情抽屉**（点卡打开，在工作台内从右侧滑出，不跳走）：
  - 编辑标题和说明。
  - 执行者选择器：Bot 列表 / 群列表；选群时可选负责 Bot。只列 active Bot 和非只读群，管家可选。
  - 时间选择器：不定 / 立即 / 某时 / 重复。重复用预设：每天 / 工作日 / 每周几 / 每月几号 + 时刻；自定义 cron 放 P1。实时显示「下次：…」。
  - 执行记录（每次派发 → 结果摘要 + 跳到对话里那条回复）。
  - 底部：完成 / 取消 / 退回草案。
- **派发前提示**：`todos.create` / `update` 返回的 `warnings` 就地显示，例如「该 Bot 未配置模型」「群已只读」。主动消息相关的警告对事项不再出现（§4.4）。
- 拖拽：备忘拖到某员工道 = 转为事项并指派；草案拖道 = 改派（P1）。

### 5.3 「需要你处理」与「进行中」（P1）

经理最怕「活卡在我这儿而我不知道」。汇总条只读引用现有实体，点条目跳到对应对话里的那张卡：

| 汇总 | 来源 |
| ---- | ---- |
| 需要你处理 | 待决审批（`approvals.list` 全局）、等你回答的任务提问（runs `awaiting_input`）、待你答复的定时提议卡（offer pending）、群里无人认领 |
| 进行中 | 进行中的事项 + 全局活跃任务（需新增不带 conversationId 的 `tasks.active` 变体） |
| 待验收 / 今天 / 草案 | 事项本身 |

由 `workbench.summary` 一次聚合返回，监听相关事件去抖刷新。

### 5.4 备忘栏

- 顶部常驻输入框：回车保存，Shift+回车换行，存完清空并保持焦点，连续记录不打断。
- 列表：置顶在前，其余按更新时间倒序。卡片正文最多显示 6 行，显示相对时间和来源徽标（管家记的）。
- 操作：编辑（原地）、置顶、转为事项（打开事项抽屉并预填：首行作标题，全文作说明）、删除。
- 搜索：本地即时过滤，空态和无结果分别给文案。
- 「最近删除」：可恢复，30 天后启动时清理。
- 全局快捷键（如 Ctrl/Cmd+Shift+M），在任何界面弹出闪念输入（P1）。

### 5.5 窄屏（P1）

底部 tab 增加「工作台」，变为 5 个 tab。工作台是经理的「首页」，地位等同于对话，不应该藏在对话列表顶部。单栏内用「事项 / 备忘」切换，事项详情走全屏详情层（复用窄屏详情层与返回手势）。

## 6. 管家接管

### 6.1 工具（仅管家注册，turn 工具面）

| 工具 | 参数 | 说明 |
| ---- | ---- | ---- |
| `list_todos` | `status?`、`assignee?`、`query?`、`limit?` | 只读；结果包 `untrustedBlock`（标题 / 说明可能来自网页摘录） |
| `create_todo` | `title`、`notes?`、`assignee?`（`{bot}` / `{group, lead_bot?}`）、`when?`（`now` / ISO / cron）、`from_memo?` | 不填执行者和时间即为草案 |
| `update_todo` | `id` + 任意字段；`assignee: null` / `when: null` 为清空 | 改派、改期、退回草案 |
| `close_todo` | `id`、`outcome: 'done' \| 'cancelled'`、`reason?` | 收尾；不提供硬删除 |
| `list_memos` | `query?`、`limit?`、`include_trashed?` | 只读，`untrustedBlock` |
| `create_memo` / `update_memo` | `body` / `id, body?, pinned?` | 「帮我记一下…」 |
| `delete_memo` | `id` | 移入最近删除，可恢复 |

工具注册清单要同步更新：`effects/classify.ts` 全部归为 `local`；`external/capabilities.ts` 的 `READ_ONLY_TOOLS` 加入 `list_*`，`DESTRUCTIVE_TOOLS` 加入 `close_todo`、`delete_memo`。

### 6.2 权限边界（宿主强制）

判据与设置工具的 `effectiveMode` 一致，看这一轮是不是用户本人触发（`triggerFromUser`）：

| 操作 | 用户本人触发的一轮 | 非本人触发（定时、事件、委派回执、代发） |
| ---- | ---- | ---- |
| 读取（`list_*`） | ✅ | ✅ |
| 记备忘、建草案（无执行者、无时间） | ✅ 直接执行 | ✅ 直接执行（无副作用，可撤回） |
| 指派、排期、立即开始、改派、改期 | ✅ 直接执行 | ❌ 拒绝，提示「需要用户确认，请在回复里向用户提议」 |
| 收尾（完成 / 取消）、删除备忘 | ✅ 直接执行 | ❌ 同上 |

理由：「让别的员工动起来」和「删东西」只在用户当面交代时由管家直接执行。管家自己的晨报、定时整理只能提建议和起草，不会半夜替你派活。被拒绝时，管家在回复里列出建议，用户一句「好，就这么办」就是用户本人触发的下一轮，不必新造审批卡。

**可见性**：

- 管家的写操作都带 `source='butler'` 标记。工作台卡片显示「管家」徽标，`todos.changed` 让工作台实时刷新。
- 管家私聊里，工具调用照常显示在活动记录中，管家在回复里说明改了什么。
- 备忘可从「最近删除」恢复，事项的「已取消」可 `reopen`。管家犯错都能撤回。

### 6.3 管家的工作台上下文

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

### 6.4 员工侧（P1）

被指派的 Bot 在自己的 `schedules` 上下文段里能看到「工作台派给你的事项」（标题 + 时间），这样被问到「你周五要干嘛」时答得上来。员工**不能**改事项，状态由宿主根据交付推进。

## 7. 实施阶段

### P0：事项闭环 + 备忘 + 管家工具（宽屏）

- [ ] 设计正文 `docs/design/39-workbench.md` + README 决策 D90（编号以合入时为准）
- [ ] 迁移：`todos` / `todo_runs` / `memos` 新表；`schedules` 重建（`origin` 加 `workbench`、加 `todo_id`、`bot_id` 可空）
- [ ] shared：类型、schema、RPC 契约、事件；`scheduleOriginSchema` 加 `'workbench'`；`textContent.origin` 加 `'workbench'` + `todoId`
- [ ] core：
  - TodoService：CRUD、状态机、校验、对账
  - ScheduleService：`createForTodo` / `reschedule`；`#fire` 增加 workbench 分支；处理 `bot_id` 可空的波及点（§4.2）
  - 派发：私聊闸口 / 群协调器
  - MemoService（含最近删除清理）
  - RPC 绑定
- [ ] 交付追踪（§4.5）：`todo_runs` 进入 delivered / unclaimed；回复打「📋 标题」标签
- [ ] 管家工具 7 个 + 权限边界 + `<workbench>` 段 + `BUTLER_RULES` 补充 + 工具注册清单同步
- [ ] renderer：
  - `shell.mainView` 与 `chat.select` 收口
  - 左栏入口
  - `WorkbenchView`：按成员视图、快速新建、事项卡、详情抽屉（时间预设）、自排卡、空闲成员条
  - 备忘栏（含最近删除）
  - 派发卡 / 回执卡的 `workbench` 渲染
- [ ] 测试（先定向、后全量，见 AGENTS.md）：
  - 状态机迁移表驱动测试
  - 派发不受护栏约束（主动消息关闭仍派发）
  - 群派发走 triage / @
  - 无人认领退回草案
  - 删 Bot / 删对话后对账退回草案
  - 移交带走 `todo_id`
  - 管家工具在非本人触发轮里拒绝写操作
  - 备忘软删与恢复
  - 迁移重建后保留旧行
- [ ] e2e：入口切换且不丢对话草稿；记闪念 → 转事项 → 指派 Bot + 立即开始 → 私聊出现派发卡 → 交付后进入待验收 → 完成

### P1：现状感知 + 体验

- [ ] `workbench.summary` + 汇总条（需要你处理 / 进行中 / 待验收 / 今天 / 草案）+ 左栏徽标；全局 `tasks.active`
- [ ] 按时间视图；拖拽转事项 / 改派
- [ ] 「退回」= 原对话追问并回到进行中
- [ ] 窄屏第 5 个 tab
- [ ] 闪念全局快捷键
- [ ] 员工侧上下文（§6.4）
- [ ] 自定义 cron；盯梢（watches）在员工道内只读展示
- [ ] 设置页「定时任务」总览改为跳转工作台（设置里不再重复一份）

### P2：可选增强（本期不排期）

- [ ] 执行者「我自己」：到点在管家私聊出确定性提醒卡 + 系统通知，不调模型
- [ ] 截止时间（与执行时间分开），逾期高亮
- [ ] 管家晨报 / 周回顾例行（读工作台，只提建议，遵守 §6.2）
- [ ] 备忘 `#标签`、FTS
- [ ] 事项活动日志（谁在何时改了什么，含管家）

## 8. 决策状态

**已定（2026-10-15，用户确认）**：

1. **派发方式**（§4.4）：到点以「工作台代你发出」的可见消息派给员工，不受主动消息开关、免打扰、每日上限约束。
2. **管家权限边界**（§6.2）：非本人触发的一轮里，管家只能读、记、起草，不能派活、收尾、删除。

**按推荐默认实施（用户未单独表态，可随时改口）**：

3. **待验收需手动完成**（§3.1）：不自动完成；如果嫌多，P1 提供「全部标为完成」。影响 P0。
4. **窄屏入口**：底部增加第 5 个 tab「工作台」。P1 才涉及。
5. **设置页定时总览**：P1 改为跳转工作台。

## 9. 非目标（本期）

- 不在工作台里聊天、改 Bot 人设、管 Skills / MCP / 连接。
- 不重做调度引擎；Bot 自排定时任务的到点语义不变。
- 不把 stickies 改造成备忘；备忘不进普通 Bot 的上下文。
- 不做多用户 / 云同步、事项依赖关系、甘特图、子任务。
- 普通 Bot 不能操作事项和备忘（只有管家可以）。

## 10. 风险

- **`schedules` 重建 + `bot_id` 可空**：波及面集中在按 Bot 查询的路径（§4.2 已列）。迁移测试要覆盖旧行原样保留、索引和 FK 完好。
- **深夜派发**：不受免打扰约束意味着凌晨的事项会准时执行并产生消息。这是用户自己选的时间。界面在选择免打扰时段内的时间时给一行提示即可，不拦截。
- **交付追踪的边界**：steer 合批、群多人响应时，归属可能不准。设计上降级为「停在进行中、可手动完成」，不影响正确性。
- **管家误操作**：靠 §6.2 的触发判据、软删除、`reopen` 与来源徽标兜底。
- **并发会话**：本仓库有多会话并行开发，迁移号以合入时 main 实况为准重编。

## 11. 验收口径

1. 左栏管家上方有「工作台」，点击后主区切换。从工作台点任意对话 / 搜索结果 / 通知都能回到对话，原对话草稿不丢。
2. 记一条闪念，转为事项，指派给 Bot 并「立即开始」：该 Bot 私聊出现派发卡并开始执行；交付后事项进入待验收，可跳到结果，标完成后关闭。
3. 同一事项改为指派给群且不指定负责 Bot：群内走 triage。没有 Bot 认领时，事项退回草案，显示「群里无人认领」。
4. 定时 / 周期事项在 Bot 关闭主动消息时仍按时派发；Bot 自排的定时任务仍受护栏约束（行为不变）。
5. 删除执行者 Bot 后，其事项退回草案并显示原因；D88 移交后，事项执行者随之变更。
6. 对管家说「把草案里的竞品分析交给研究员，周五早上 9 点做」，工作台实时出现排期；管家自己的定时轮尝试派活时被拒绝，改为提建议。
7. 备忘增删改、置顶、搜索、最近删除恢复可用；管家可记、查、改、删备忘，删除可恢复。
8. 相关单测 / e2e 通过；typecheck、lint 干净。

## 12. 实施编排（P0）

### 12.1 分支与 worktree

- 集成分支 `t/wb`，worktree `/home/jyy/wt/kepcup-wb`（从 main 拉出）。W0 直接在这里做。
- 并行工作流各自开 worktree `/home/jyy/wt/kepcup-wb-<ws>`，分支 `t/wb-<ws>`，从 `t/wb` 拉出。完成后由协调会话合入 `t/wb`。
- 合入 `main` 须经用户确认；不 push。
- 测试规则见 AGENTS.md（先定向、后全量），容器运行见 `docs/dev/05-testing.md`「本机容器运行」。判定标准是「失败集合不超出基线」。

### 12.2 波次

| 波次 | 工作流 | 范围 | 依赖 |
| ---- | ---- | ---- | ---- |
| 0 | **W0 契约** | 迁移、shared 类型 / RPC / 事件 / 常量、core 存储层（store）、`bot_id` 可空的编译期波及修补、设计文档 39 + README D90 + `docs/dev/03-data-model.md` | — |
| 1 | **W1-core** | TodoService / MemoService、ScheduleService 改造（§4.3）、派发（§4.4）、交付追踪（§4.5）、对账、移交适配、RPC 绑定与 `start.ts` 装配、执行者提示规则 | W0 |
| 1 | **W1-ui** | §5 P0 全部界面（主视图收口、入口、按成员视图、事项卡与详情抽屉、自排卡、空闲成员条、备忘栏、派发卡 / 回执卡渲染、i18n），渲染端单测 | W0（只依赖 shared 契约，与 W1-core 并行） |
| 2 | **W2-butler** | §6.1–§6.3：7 个工具、权限边界、`<workbench>` 段、`BUTLER_RULES`、工具注册清单 | W1-core 合入后 |
| 3 | **W3 收口** | e2e（§7 P0 最后一条）、全量回归、文档同步（PROGRESS、本节记录） | 全部 |

每批合入 `t/wb` 后安排一次独立审查（审查者不是作者），修复后再进入下一波。

### 12.3 W0 契约（后续工作流按此编码，名称不得自行改动）

**迁移**：一个文件 `packages/core/migrations/main/0037_workbench.sql`（合入 main 时按实况重编）。

- 新表 `todos` / `todo_runs` / `memos`，按 §4.1 原样建。
- `schedules` 重建，参照 `0021` 的写法：`bot_id` 改为可空；`origin` CHECK 加 `'workbench'`；增 `todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL`；增 `CHECK (bot_id IS NOT NULL OR origin = 'workbench')` 与单向 `CHECK (todo_id IS NULL OR origin = 'workbench')`。保留全部列、数据、索引、外键；增加索引 `schedules(todo_id)`。

**shared 类型**（`packages/shared/src/domain/types.ts`）：

- `todoStatusSchema = z.enum(['draft','scheduled','in_progress','delivered','done','cancelled'])`
- `todoSourceSchema = z.enum(['user','butler'])`
- `todoAssigneeSchema = z.discriminatedUnion('kind', [{ kind:'bot', botId }, { kind:'group', conversationId, leadBotId: string|null }])`
- `todoSchema`：`{ id, title, notes, assignee: todoAssigneeSchema.nullable(), status, source, memoId: string|null, blockedReason: string|null, createdAt, updatedAt, closedAt: number|null }`
- `todoRunStatusSchema = z.enum(['dispatched','delivered','unclaimed','failed'])`
- `todoRunSchema`：`{ id, todoId, conversationId, messageId: string|null, status, resultMessageId: string|null, dispatchedAt, settledAt: number|null }`
- `todoEntrySchema = todoSchema.extend({ assigneeName: string|null, leadBotName: string|null, schedule: { id, kind, runAt, cron, timezone, nextFireAt } | null, lastRun: todoRunSchema.nullable() })`
- `memoSchema`：`{ id, body, pinned: boolean, source: todoSourceSchema, createdAt, updatedAt, deletedAt: number|null }`
- `scheduleOriginSchema` 加 `'workbench'`；`scheduleSchema.botId` 改为 `z.string().nullable()`；增 `todoId: z.string().nullable()`。
- `textContentSchema.origin`（现为 `['delegation','task','widget']`）加 `'workbench'`；增可选 `todoId`、`todoRunId`。
- 常量（`packages/shared/src/constants.ts`）：`TODO_TITLE_MAX_CHARS = 120`、`TODO_NOTES_MAX_CHARS = 4000`、`MEMO_BODY_MAX_CHARS = 10_000`、`MEMO_TRASH_RETENTION_MS = 30 天`、`TODO_CLOSED_VISIBLE_MS = 7 天`。

**RPC 契约**（`packages/shared/src/rpc/methods.ts`，入参 / 出参均为 zod schema）：

| 方法 | input | output |
| ---- | ---- | ---- |
| `todos.list` | `{ statuses?: TodoStatus[], query?: string, includeClosed?: boolean }` | `{ todos: TodoEntry[] }` |
| `todos.get` | `{ id }` | `{ todo: TodoEntry, runs: TodoRun[] }` |
| `todos.create` | `{ title, notes?, assignee?: TodoAssignee \| null, when?: string \| null, memoId? }` | `{ todo: TodoEntry, warnings: string[] }` |
| `todos.update` | `{ id, title?, notes?, assignee?: TodoAssignee \| null, when?: string \| null }` | `{ todo: TodoEntry, warnings: string[] }` |
| `todos.start` | `{ id }` | `{ todo: TodoEntry }` |
| `todos.complete` / `todos.cancel` / `todos.reopen` | `{ id }` | `{ todo: TodoEntry }` |
| `memos.list` | `{ query?: string, trashed?: boolean }` | `{ memos: Memo[] }` |
| `memos.create` | `{ body }` | `{ memo: Memo }` |
| `memos.update` | `{ id, body?, pinned? }` | `{ memo: Memo }` |
| `memos.delete` / `memos.restore` | `{ id }` | `{ memo: Memo }` |

`when` 的口径：`'now'` = 立即派发；ISO 8601 = 单次；其它按 cron 解析（同 `createFromWhen`）；`null` = 清空排期；省略 = 不变（create 时即不定时）。

**事件**（`packages/shared/src/rpc/events.ts`）：`todos.changed: { todoId: string }`、`memos.changed: { memoId: string }`。

**core 存储层**（`packages/core/src/workbench/`）：

- `todo-store.ts`：todos / todo_runs 的行映射与增删改查 SQL。
- `memo-store.ts`：含 `purgeTrashed(before)`。
- 单测覆盖行映射、迁移（旧 schedules 行原样保留、新 CHECK 拒绝未知 origin、`bot_id` 可空）。

**W0 落地时对契约的补充**（2026-10-15；均为向后兼容的补全，名称与形状不变）：

- **ID 前缀**（`ids.ts`）：`todo: 'todo_'`、`tdr: 'tdr_'`、`memo: 'memo_'`（备忘用 `memo_`，与记忆条目 `mem_` 区分；`isId('mem', 'memo_…')` 为假）。`docs/dev/01-conventions.md` 的 ID 表与常量表同步。
- **回执卡快照**（`systemEventContentSchema.schedule`，`ScheduleReceiptSnapshot`）：`botId` 改为可空、`origin` 增 `'workbench'`、增可选 `todoId`，否则 §4.3 的「工作台安排」回执卡无法落成同一结构。渲染端 `ScheduleReceipt.svelte` 对空 `botId` 不显示 Bot 名。
- **入参校验**：`title` 为 `min(1).max(TODO_TITLE_MAX_CHARS)`，`notes` 为 `max(TODO_NOTES_MAX_CHARS)`，备忘 `body` 为 `min(1).max(MEMO_BODY_MAX_CHARS)`；`when` 为 `z.string().min(1).nullable()`（`optional` 区分「省略」与 `null`）；`TodoAssignee` 里的 id 为 `min(1)`。
- **存储层多出的方法**：`SchedulesStore.listActiveForTodo`；`TodoStore.listByAssigneeBot` / `listByAssigneeGroup` / `reassignBot`（D88 移交用）/ `listOpenRunsForConversation` / `lastRun` / `listRuns` / `updateRun`；`TodoStore.list` 的 `closedAfter` 过滤（`TODO_CLOSED_VISIBLE_MS` 的落点，由 TodoService 传入）。`MemoStore.softDelete` / `restore` 不改 `updated_at`，恢复后备忘回到原位。

**`bot_id` 可空的编译期波及**：shared 改为可空后，core 与 renderer 的类型错误由 W0 做最小修补（判空跳过，行为不变），让分支能构建。语义改造（§4.2 列表）归 W1-core。

### 12.4 实施记录

（各波次合入后在此追加：提交、测试结果、偏差。）

**W0 契约（2026-10-15，分支 `t/wb`）**

- 提交：`feat(shared,core)` 迁移 0037 + shared 契约 + `bot_id` 可空修补；`feat(core)` TodoStore / MemoStore；`docs` 设计 39 + D90 + 数据模型。
- 迁移 0037 在 main 0036 之后；合入 main 时按实况重编（`workbench-migration.test.ts`、`create-core.test.ts`、`public-skills-migration.test.ts` 里的版本号 / 回放逻辑需同步）。`public-skills-migration` 回放测试原先靠 `alter table schedules drop column title/origin` 回退，0037 之后带外键的 `todo_id` 列删不掉，改为把 schedules 还原成 0011 形态再摘三张新表。
- `bot_id` 可空的最小修补（判空跳过，行为不变）：`schedule/service.ts`（`fireabilityWarnings`、`#afterCreate`、`#fire`、`listEntries`、`#deferredReason`）、`handover/adapters/schedule.ts`（`#isDirectOf`、`#commitment`、`apply`、`isApplied`）、`ScheduleReceipt.svelte`。§4.2 列的语义改造（`contextSection`、`prepareBotDeletion`、`#fire` 的 workbench 分支等）仍归 W1-core；`#fire` 目前遇到空 `botId` 的行按「目标已不存在」取消，W1-core 加 workbench 分支时需先于此判断处理。
- 容器内全量：4824 例，4766 通过、36 失败，均不在 W0 引入：沙箱 / projects / skills / workspace-tools / wiki-url 等基线环境项；runs 库已有 0011（`a608ccd`）而 `create-core`、`task-events-migration`、`tool-effects-migration` 仍断言 10；`response-loop`「interim delivery 上限」、`tasks-review-fixes-e`、`environment`「checksum mismatch」、`external-agent-p3`「write task lease」在 W0 起点 `1d5c392` 同样失败；`agents-service`、`connected-apps-runtime`、`web-tools` 为负载偶发，单跑通过。

**W1-core（2026-10-15，分支 `t/wb-core`）**

- 新增：`workbench/todo-service.ts`（状态机迁移表、CRUD / `when` 口径、执行者校验、排期、派发、交付结算、对账、`purge`）、`workbench/memo-service.ts`；`ScheduleService` 的 `createForTodo` / `reschedule` / `retitle` / `attachWorkbench` 与 `#fireWorkbench`（先于空 `botId` 判断）；orchestrator 的 `dispatchWorkbenchMessage` / `hasTurnModel` / 事项来源与交付追踪；`GroupTurnCoordinator.onRoundEnded`；`todos.*` / `memos.*` 绑定与 `start.ts` 装配（启动先清备忘回收站、再对账、再补发）；`lifecycle` 的 `workbench` 钩子。
- 对 W0 契约的修正（独立审查）：0037 去掉 `todos.assignee_group_id` 的外键（FK 置空会把「群 + 负责 Bot」读成 Bot 执行者）；`schedules` 加 `CHECK (bot_id IS NOT NULL OR origin='workbench')` 与单向 `CHECK (todo_id IS NULL OR origin='workbench')`；`store.insert` 有 `todoId` 时默认 `origin='workbench'`；`todo-store` 的 `closed_at` / `settled_at` 随状态派生；`reassignBot` 只动未关闭事项。
- 追踪的取舍：回复带 `todoId` / `todoRunId` / `todoTitle`；同链路（`origin_run_id`）还有未结算任务则不交付；静默轮次若同对话更早有带标签的回复，则以那条为结果；群里一轮结束无人响应（`group_no_claim`、全员 `no_action`、被派者全部静默且没起任务）→ `unclaimed`。执行者轮失败 / 被取消时的处理见下方「审查修复」第 5 条（已改为退回草案，原偏差作废）。
- 移交：适配器在 `transferTo` 之后通知 TodoService；`schedules.changed` 对账也会让事项跟随排期持有者（崩溃兜底）。没有用 `TodoStore.reassignBot`（它会把该 Bot 的所有事项一起搬走，而移交是按资产条目逐条选的）。

**W1-core 审查修复（2026-10-15）**

1. 合批：`canShareTurn` 让工作台派发批次独占一轮（同 delegation）；`#todoRefsOf*` / `#todoSourceOf` / `#trackTodoDelivery` 改为收集全部 ref、逐个结算（标签取第一个事项的标题）。
2. 派发先把事项推进到 `in_progress` 再路由，路由抛错时回滚；空群等同步走到无人认领的情况因此能正确退回草案。
3. `update({assignee, when:null})` 保留改派后再退回草案。
4. 事务与顺序：`start` / `update(now)` 先派发成功再取消旧排期；改派先建新排期再取消旧排期；纯 DB 多步写入包进 `db.transaction`（路由在事务外）；服务忙时被跳过的对账在最外层操作结束后补跑；`create(when:'now')` 派发失败时事项保留为草案，`blocked_reason` = 「派发失败：原因」，错误照常抛出。
5. 执行者的 run 失败 / 被取消 / 中断：执行记录标 `failed`，事项（须是该事项最新一次派发）退回草案，`blocked_reason` = 「执行失败：原因」或「执行已被取消」，用户可重新开始；失败的记录不再被迟到的回复复活。群里 `GroupRoundEnd` 增 `failed` 结果，失败不再被误报成「群里无人认领」。（取代上文「失败只标 run failed、事项停在进行中」的偏差。）
6. 删私聊 / 删群：停留在 dispatched 的执行记录标 failed；进行中的事项退回草案，原因「对话已删除」（群：「群已解散」）。
7. 管家代写的事项（`viaButler`）：执行者上下文里标题和说明包进 `<untrusted source="butler">`，标明非用户原话、涉及写入 / 外发 / 删除前按非本人指令处理；`WORKBENCH_DISPATCH_RULE` 同步。记忆证据：`MemoryService` 的消息视图（`isProxiedUserText`）把 viaButler 的 workbench、delegation、widget 都当 bot 消息，`hasUserEvidence` 因此不认它们（widget / delegation 原有行为不变）。
8. `update(when:'now')` 与 `start` 的语义**有意不同**：前者是「改成立即执行一次」，周期事项走这条路会结束周期（取消 cron 排期）并派发一次；后者保留周期排期，事项继续停在 `scheduled`。
9. `reschedule` 取消已入队的旧 `schedule_fire` 作业。
10. 执行者在设置访谈中、派发被闸口扣住：`blocked_reason` = 「该 Bot 正在设置中，完成设置后才会处理」，事项保持进行中，create / update 的 warnings 带同一句；交付后清除。
11. `settleDelivered` / `settleUnclaimed` / `settleFailed` 只推进事项**最新**的一次派发；`update` 带上相同执行者不算改动；`reopen` 重新校验执行者，失效则清空并写原因。
12. 对账：`schedules.changed` 只处理 workbench 行、同一 tick 内合并为一次；`onExecutorChanged` 不再重复发布事件；群轮结束的任务检查改为按 `origin_run_id` 精确查询。

本地若跑过 W0 版 0037，需要删库重建（0037 在合入 main 之前被原地修改：去掉 `assignee_group_id` 外键、加两条 CHECK）。

