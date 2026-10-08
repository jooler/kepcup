# 02 执行模型

> **D75 重写（2026-10-08）**：Bot 的一次响应拆为**对话轮**（沟通与调度，只读，每〔Bot, 对话〕串行）与**任务**（执行，完整工具面，可并行）两层。本文描述已实现的执行模型；拆分的决策与理由见 [30-supervisor-and-tasks.md](30-supervisor-and-tasks.md)，实现细节见 [dev/02-architecture.md](../dev/02-architecture.md) 与 [dev/04-agent-runtime.md](../dev/04-agent-runtime.md)。标「待确认」的条目是实现期的细化，记在 [dev/DEVIATIONS.md](../dev/DEVIATIONS.md)，尚待用户确认。

## 基本原则

- **两层 loop**：对话轮（`loop_type='turn'`）由消息 / 定时 / 事件 / 任务结算触发，秒级，发完回复即结算；任务（`loop_type='task'`）只由对话轮的 `start_task` 派出，分钟到小时级，多条可并行。**对话轮永不等待任务**——任务结算是一个事件，按宿主的确定性条件唤醒下一个对话轮。
- **职责切分即权限切分**：写操作与长时工作只发生在任务里；对话轮只读，执行期由工具网关硬拒一切写路径（`RUN_READ_ONLY`），不只靠不注册工具。只读任务（`task_writes=false`）同样硬拒写。
- 对话记录与执行过程分离：过程存入执行记录（Run / `run_steps`），只有 Bot 发出的消息进入对话；Bot 与自己任务之间的往返作为**私有条目**进对话消息表，只给该 Bot 看（见「上下文注入」）。
- 工作目录：对话轮与任务都在该 Bot 专属于该对话的 workspace（`{bot_id}/workspaces/{conversation_id}/`）与绑定的 project 范围内工作；任务的工作目录（`task_workdir`）在派出时确定：缺省为绑定且可用的 project，否则 workspace，也可由 `start_task({workdir})` 指定。
- Loop 框架使用 pi（[09-tech-stack.md](09-tech-stack.md#agent-looppi)）。**对话轮固定走内置引擎**（Bot 的内置主模型）；任务走 Bot 配置的引擎——内置 pi，或外部智能体（D72，`runtime.agent` 即 Bot 的**任务引擎**，见 [28-external-agents-acp.md](28-external-agents-acp.md)）。

## 对话轮与任务

| 项 | 对话轮（turn） | 任务（task） |
|---|---|---|
| 触发 | 用户消息批、`@` / 回复、群聊判断通过、定时、事件、D71 委派、任务结果 / 失败条目、设置完成后重试 | 对话轮的 `start_task`（唯一入口）；失败任务经设置卡重试时由宿主派出接续任务 |
| 串行 / 并发 | 每（Bot, 对话）同时最多一个（mailbox） | 对话级 `TASK_CONCURRENCY_PER_CONVERSATION`（3）、全局 `TASK_CONCURRENCY_GLOBAL`（8）、单个对话轮最多派 `TASK_START_MAX_PER_TURN`（2）个；同一 workdir 同时最多一个写任务 |
| 引擎 | 固定内置（无内置模型时见「无内置模型的 Bot」） | 内置 pi 或该 Bot 的外部智能体 |
| 轮数 / 时限 | `TURN_MAX_TURNS`（8）；用完仍未回复按 `failed` 结算并提示「较长的工作应派成任务」 | `RUN_MAX_TURNS`（60）；`TASK_MAX_WALL_MS`（4 小时，等用户回答问题卡的时间不计入）与 `TASK_TOKEN_BUDGET`（2M）超限由 reaper 强制 `failed` |
| 工具面 | 对话核心 + 只读查询 + 任务管理 + 异步托管动作（[dev/04](../dev/04-agent-runtime.md#工具目录)） | 完整工具面，去掉任务管理、跨 Bot 委派与管家提议；多一个 `ask_user` |
| 最终文本 | 自动作为可见消息发出（D48） | 写入私有 `result` 条目，**不直接发给用户** |
| 深度 | — | 1：任务内 `start_task` 一律拒绝 |

一次完整交互：用户消息 → 对话轮派任务并回复「我去做了」→ 对话轮结算，Bot 立即可以接收新消息 → 任务的中间说明直达对话 → 任务结束写结果条目 → 唤醒新的对话轮 → 对话轮转述结果（或 `forward_task_result` 原文转发）。示例见 [30 §2.3](30-supervisor-and-tasks.md#23-一次完整的交互)。

## 路由：对话轮的决策面

新消息到达时由**下一个对话轮**决定怎么处理（D2 修订），决策是枚举化的工具调用，宿主逐项校验归属与配额：

| 工具 | 作用 | 要点 |
|---|---|---|
| `start_task` | 派出任务：`title`、`instruction`、`source_message_ids`、`writes`、`workdir?`、`continues_task_id?` | 先写 runs 行（`queued` = submitted）与私有 `brief` 条目、再按配额启动；返回 `running` 或 `submitted` + 排队原因；超过本轮起数报 `TASK_LIMIT_REACHED` |
| `inject_task` | 把新指令转给进行中 / 排队中的任务 | 已在跑：经 steering 注入（`delivered`）；尚未启动：并入简报；引擎收不下（外部智能体不支持或异步拒绝 steering、执行已收尾）：条目记为 `queued`（「未送达」），对话轮可改为取消后接续重做 |
| `cancel_task` | 取消 submitted / running 的任务 | 写 `cancel` 条目后当场结算为 `cancelled`；不唤醒对话轮 |
| `list_tasks` | 进行中 + `TASK_LIST_SETTLED_WINDOW_MS`（24 小时）内已结算的任务 | 平时不必调用，`<tasks>` 段已列出进行中的任务 |
| `forward_task_result` | 把已完成任务的结果原文作为可见消息发出（Bot 身份，`origin:'task'`） | 每个任务只能转发一次；不是路由，是转述动作 |

- 「重新执行」= `cancel_task` + `start_task({continues_task_id})`，不设原子的 `restart`（取消在外部智能体上有时延）。
- **路由必须留痕**：派出的任务在对话中有一张任务卡（`kind='card'`，`cardType='task'`），注入、取消、结算都会重绘它（`task.updated`）；对话轮的平台规则要求在回复里说明把消息交给了哪条任务。
- 任务需要用户拍板时调用 `ask_user`：对话中出现绑定该任务的问题卡，任务在 `running` 下标 `awaiting_input` 并阻塞等待；用户点选卡上的选项直接注入该任务（`tasks.answer`，不经对话轮）；用户用自由文本回答时由对话轮从 `<tasks>` 段看到「等待用户输入」，用 `inject_task` 转交——对一个正在等问题的任务，注入即回答（带上用户原消息）。等待期间任务让出调度名额（写租约保留；拿回名额之前都不计入任务时限），等待中被取消的任务直接收尾、不再排队拿名额，超过 `TASK_QUESTION_TTL_MS`（24 小时）未答则任务收到「用户未回答」并按自己的判断继续。问题与选项是任务的模型输出：在所有 Bot 的上下文里标明是哪个 Bot 的任务在问，并包在 `<untrusted>` 里。

## 并发与调度

### Mailbox：串行的是对话轮

- 每个「Bot + 对话」一个 mailbox，同一时刻最多一个对话轮。空闲时 `deliver` 新建对话轮（runs 行 `queued`）并提交调度器。
- **对话轮运行中到达的批不再 steer 进对话轮**，而是缓冲；对话轮结算、mailbox 释放时，缓冲的批合并为**一个**批，启动下一个对话轮。合并后每个来源批保留自己的 `reason` 与属性（触发段里各占一个 `<trigger>`），同一条消息只出现一次、取最新内容。多个任务同时结算因此只唤醒一轮。
- **对话轮开始执行时吸收缓冲**：对话轮从创建到真正开始执行之间可能排在调度器里；开始执行时（先让出一个微任务，使同一时刻的投递先落进缓冲）它把 mailbox 里已缓冲、能与它同轮的批并入自己的触发，并重新读取每条触发消息（取最新编辑、去掉已撤回的、去掉已被消费的任务结果），同步更新 runs 行的触发记录（`trigger_parts_json`；吸收了 @ 连锁批时连同连锁绑定，层数上限照常生效）。不能同轮的批留到下一轮：D71 委派批独占一轮（委派结果就是那一轮的最终回复），不同 @ 连锁的批不同轮（审查批 E），带用户消息的未绑定批也不与连锁批同轮（最终审查 L-5）。此后上下文同步构建，它的上下文里不会出现「下一轮的触发」。
- 不做防抖：用户通过待发送队列自行决定何时发出，一批消息发出即投递（[01-conversation.md](01-conversation.md#输入与待发送队列)）。
- workspace 的并发写不再由串行 mailbox 兜底，改由写入租约承担（下文）。

### 写互斥：租约，而不是物理隔离

- 只读任务不取租约、不限 workdir 并发（仍受上述配额封顶）。
- 写任务启动前取 workdir 根的写租约并**整个任务持有**（`ensureWriteLease(…, { pin: true })`）；租约键对 project 是项目根，对 workspace 是 `ws:{botId}:{conversationId}`（D29 扩到 workspace，[08-project.md](08-project.md#并发写入租约)）。
- 同一 workdir 的第二个写任务在**任务层**排队（跨对话生效）：停在 submitted，卡片与 `<tasks>` 段显示「等写入租约（任务 … 持有）」，持有方任务结束或被取消后才启动。它不去申请租约，因此「强制收回」对这种排队不起作用，只对租约层的等待（被非任务持有者挡住）出现（见 DEV-015）。对一个持有租约的写任务点强制收回，它就失去写权限：之后的写入以「写入租约已被用户收回」失败，不会悄悄重新取得租约（[30 §5.1](30-supervisor-and-tasks.md#51-规则)）。
- workspace 没有影子仓库检查点：workspace 写任务被取消时只列出它的文件工具写过的文件，不提供整次回退；project 写任务照常有改动摘要与整次回退（D30）。
- git worktree / CoW 隔离明确不做（[30 §9](30-supervisor-and-tasks.md#9-非目标)）。

### 调度器与名额

调度器按厂商限制模型调用并发（默认 4，可在设置中调整），后台 loop 全局并发 2；同优先级先进先出，运行中的作业不被抢占。

| 作业 | 优先级 | 调度键 / 厂商 |
|---|---|---|
| 用户触发的对话轮（任一来源批为 direct / mention / reply / broadcast / delegation / task） | 0 | mailbox 键；内置主模型的厂商 |
| 群聊判断 | 0 | — |
| 定时、事件、连锁触发的对话轮 | 1 | 同上 |
| 只读任务 | 1 | `task:{id}`；Bot 的任务引擎（外部智能体为 `agent:{id}`） |
| 写任务（已持有租约） | 0（`leaseHeld`） | 同上 |
| 后台 loop | 2 | — |

名额规则（内置厂商，上限 N）：

- **为回复留一个名额**：N > 1 时，只读任务只在占用 < N−1 时启动；已持租约的写任务在占用 < N 且任务合计占用 < N−1 时启动（它挡着等同一租约的其他写入者，不能被回复饿死，但任务合计仍不拿走最后一个名额）。N = 1 时不预留。
- **借用（M3）**：当该厂商被占满、且所有占用都是任务时，一个优先级 0 的回复可以借 1 个名额——配置上限 N 在全被任务占用时实际可到 N+1。任务跑几小时且不可抢占，借用保证回复不被饿死。
- **外部智能体（`agent:{id}`）**：上限取 Agent 的并发（`features.parallelSessions` 不支持即恒为 1）。对话轮从不跑在 Agent 上，所以 Agent 的名额全归任务：**不为回复预留、回复也不借用**（上限是进程能同时服务的会话数，不是可借的额度）。TaskHost 另按 `agent:{id}` 封顶**启动**：超出的任务停在 submitted（「等智能体并发额度」），不占任务名额、不持租约。后台 loop 在 Agent 上限 > 1 时仍为非后台工作留一个。唯一还会落在 `agent:*` 上的优先级 0 作业是经 Agent 的群聊判断：其超时从**提交**起算，到时按「仅 @ / 回复响应」放行并撤出队列（见 DEV-014）。
- **等租约时让出名额**：作业内的 run 排队等写租约时把调度名额让出，取得租约后先于排队作业拿回名额（`SlotYieldingLeaseService` + `Scheduler.yieldSlotWhile`）。持名额者从不等租约，持租约者只等会前进的作业，二者不会形成持有并等待的死锁。

## 任务的结算

### 状态

任务就是 `loop_type='task'` 的 runs 行，submitted 用现有状态 `queued` 表示：

```text
queued（submitted：等并发额度 / 等写入租约 / 等智能体并发额度）
  → running（可带 awaiting_input）
      → completed    结果已写入私有时间线（skip_reply 时结果为空）
      → failed       执行失败（含结构化 setup 失败、超时 / 超预算被强制结束）
      → cancelled    cancel_task / 用户在卡片上取消 / 关对话 / 删 Bot / 移出群 / 更新闸门
      → interrupted  进程退出或崩溃
```

### 「必有结算」

不变量：**每个进入终态的任务，其结果至少被对话轮消费一次；宁可重复一次，不可静默丢失。**

1. **先落盘再启动**：`start_task` 返回前已写入 submitted 行与 `brief` 条目。
2. **结算次序**：终态条目（`result` / `failure`，main.db；「每任务至多一条终态条目」唯一索引保证幂等）→ 任务终态（runs.db）→ 唤醒判定 → 投递。两库不能同一事务，次序固定。条目写不进去而对话仍在时，任务保持非终态、由 reaper 重试结算——永远不会出现没有条目的终态任务。
3. **唤醒判定**（宿主确定性判断）：`completed` 且结果非空、`failed`、`interrupted` 唤醒；`cancelled`（无论谁取消）、`completed` 但结果为空不唤醒，直接标记消费；`question` 不唤醒。对话已只读 / 删除、Bot 已停用 / 不在对话中时也直接标记消费。任务结果**不受免打扰停放**——它是用户要的交付，不是主动消息。
4. **投递**：条目作为 `reason='task'` 的触发批交给该（Bot, 对话）的 mailbox；对话轮运行中则缓冲，release 时合并。
5. **消费**：触发批里带着该条目的对话轮**处理了这次触发**（引擎已启动、无内置模型的降级路由已执行，或因缺设置失败而设置卡完成后会以同一触发重试）**且**终态为 `completed` 或 `failed`（含 `skip_reply`）时，宿主写任务行的 `result_consumed_at`。启动前被取消、Bot 停用 / 对话只读而放弃、被用户或更新闸门取消、中断的对话轮**不消费**（见 DEV-014）。代价：用户取消正在转述结果的对话轮后，结果会在补投窗口后再出现一次。
6. **对账**：启动时与 reaper（每 `TASK_SETTLE_SWEEP_MS`，60 秒）扫描「终态且未消费」的任务重新投递；已投递但 `TASK_REDELIVER_AFTER_MS`（10 分钟）后仍未被消费的同样重投；Bot 已持有的结果不重投、不计数：正在执行或已创建还排在调度器里的对话轮触发里带着的，以及缓冲在 mailbox 里等下一轮的；投递次数只算真正交给 mailbox 的投递。一个结果至多投递 `TASK_REDELIVER_MAX_ATTEMPTS`（5）次，之后标记消费并在对话里发一条用户可见的提示（明示放弃，不是沉默）。重复消费时对话轮从时间线看得到自己已经说过，通常只会得到「没有新话要说」。

### Reaper

`TaskHost.sweep()` 每 `TASK_SETTLE_SWEEP_MS` 一次：重试写条目失败的结算；超过 `TASK_QUESTION_TTL_MS` 的未答问题按「用户未回答」解除；`running` 超过 `TASK_MAX_WALL_MS`（扣除等问题回答的时间）或用量超过 `TASK_TOKEN_BUDGET` 的任务先写 `failure` 条目再强制 `failed`；已结算但执行体超过 `TASK_SETTLE_SWEEP_MS` 仍未退场的执行被驱逐（释放名额与写租约，外部智能体会话仍视为在用，不被接续继承）；再做对账；最后清理超过 `CONTINUATION_WINDOW_MS` 未用的任务外部智能体会话（`session/close` + 删行）。宿主主动停下的任务（取消、超时、删除）当场结算，但其执行在退场前仍占名额与写入目标。

## 执行记录（Run）

```text
Run
  id
  bot_id
  conversation_id
  loop_type             -- turn | task | subagent | triage | reflection | ...
  trigger_message_ids[]
  trigger_reason        -- direct | mention | broadcast | reply | chain | scheduled | event | delegation | task
  trigger_parts         -- 对话轮合并批的各来源段（重试按段重建）
  retry_of_run_id       -- 重试出来的对话轮指向被重试的那一轮
  status
  steps                 -- 工具调用与中间过程
  output_message_ids[]
  summary
  continued_from_run_ids[]  -- 任务：continues_task_id 的回放来源
  task_title / task_writes / task_workdir / origin_run_id / result_consumed_at / awaiting_input  -- 任务列
```

- 每次 loop 结束都会留下执行记录。表结构见 [dev/03-data-model.md](../dev/03-data-model.md#runsp01)。
- 重试失败的对话轮按存下的各来源段重建触发批；它派出的任务与被重试那一轮（及更早的重试链）派出的同名任务视为同一个，不重复派出。
- 失败的任务（典型是缺设置）不进 mailbox 重试：设置卡完成后宿主派出一个接续它的新任务（同一简报、原消息与追加指令，`continues_task_id` 指向原任务）。

## 崩溃与恢复

对话轮与任务一律 ephemeral（D49）：不自动续跑。启动恢复次序：

1. **修复任务**（先于整批中断）：非终态任务已有终态条目的，按条目补成对应终态；已有 `cancel` 条目的补成 `cancelled`；已启动、无条目的先写 `failure` 条目再标 `interrupted`；submitted 的保留待重排。
2. 其余非终态 run（对话轮等）标 `interrupted` 并在对话中提示一次；待确认审批取消；写租约与会话 token 本在内存中，随进程消失。
3. D71 委派恢复。
4. 重排 submitted 任务，再对账补投未消费的结果 / 失败条目——被中断的任务因此唤醒一个对话轮，由它告诉用户。

D67（durable journal 与工具 replay，[24-durable-execution.md](24-durable-execution.md)）的适用对象改为**任务**；目前任务一律 ephemeral。

## Loop 续接

D56 的自动续接（30 分钟窗口直接回放 + 24 小时内轻量模型仲裁）**已移除**：

- **对话轮之间不续接**：对话轮只读、只沟通，过程性上下文都在任务里；对话层上下文 + `<tasks>` 段 + 私有时间线里的交代与结果已经够用。
- **任务之间显式续接**：`start_task({continues_task_id})` 把来源任务的 `run_steps` 按 `CONTINUATION_REPLAY_TOKEN_BUDGET` 回放进新任务（`<continuation>` 段：读过哪些文件、试过什么、为什么停）。来源任务必须已结束；新任务记 `continued_from_run_ids`，反思据此不重复提取旧任务的事实。外部智能体任务另继承来源任务的会话行（[28 §7](28-external-agents-acp.md)）。

## Bot 如何发消息

正式交付只从对话轮这一个出口出；进度直达。

| 出口 | 内容 | 规则 |
|---|---|---|
| 对话轮的最终回复 | 「我开始处理了」「这个直接答你」、任务结果的转述 | 自动作为可见消息发出；为空时不发送（D48） |
| 任务的中间说明 | 带工具调用的回复里的说明文字（D54） | 直达可见流，带任务归属（`origin:'task'` + `taskId`）；护栏：每 run 直聊 8 条 / 群聊 4 条，单条 2000 字符截断 |
| 任务的最终文本 | 这件事的交付物 | 写入私有 `result` 条目，唤醒对话轮；由对话轮转述、`forward_task_result` 原文转发，或连同下一步一起说 |
| `send_message` | @ 其他成员、发附件、主动分多条 | 对话轮与任务都可用；任务不能 @ 群成员（无 `mention_bot_ids`） |

- 不需要回复时调用 `skip_reply` 结束执行；在任务里等于「没有需要交回的结果」（空结果，不唤醒）。
- @ 其他 Bot 只能通过 `send_message` 的结构化参数；文本中的「@名字」不触发任何 Bot。
- 执行记录保留全部过程；Bot 需要知道某次执行做了什么时用 `list_my_runs` / `get_run`（只看自己的执行）。

## 缺设置的中断与重试（inline setup）

[18-inline-setup.md](18-inline-setup.md)：

- 对话轮开头检查内置模型（Bot 指定 → 全局默认）：没有时以结构化 `setup={kind:'main-model'}` 失败，设置卡完成后以同一触发重试该对话轮（Bot 配了外部智能体的，见下节降级）。
- 任务开头检查任务引擎：外部智能体门禁不过 → `setup={kind:'agent', …}`；能力模型缺失（如图像生成）→ 工具返回 `SETUP_REQUIRED`，任务以 `capability-model` setup 失败。失败条目照常唤醒对话轮；设置卡完成后**重试该任务**（派出接续任务），而不是重跑整个对话轮。

## 无内置模型的 Bot

只配了外部智能体、没有内置模型的 Bot 跑不了对话轮。目前只实现**第 2 级降级**（见 DEV-011）：对话轮不调模型，宿主确定性路由——结果条目原文转发、失败 / 中断发一条简短说明；新消息注入进行中的任务（注入未送达时另起任务），没有进行中的任务就派一个（写权限随 Agent 档位）。没有「直接回答」「取消」这类判断，路由留痕只靠任务卡。第 1 级（用 Agent 的 `complete()` 跑对话轮）未实现。

## Loop 类型

| Loop | 触发 | 可写入 | 优先级 |
|---|---|---|---|
| 对话轮 | 用户消息、定时、事件、委派、任务结算 | 消息；任务（派出 / 注入 / 取消）；记忆候选、Wiki 入库请求、定时任务、技能生成请求等异步托管动作；**不可写文件、不可执行命令** | 0 / 1 |
| 任务 | 对话轮 `start_task` | 消息（中间说明）；私有时间线（结果 / 失败 / 提问）；写任务：workdir 内文件与授权范围内的其他路径 | 写任务 0，只读任务 1 |
| SubAgent 子代理 | 任务内调用 `delegate_task`（前台 / 后台分支 / fan-out） | 不写用户消息；只读研究工具；过程落执行记录（`loop_type='subagent'`） | 随父任务 |
| 群聊判断 | 群消息未 @ 任何 Bot | 不写，仅返回判断结果 | 0 |
| 反思 | 对话轮或任务 `completed` 后 | 本 Bot 记忆、用户画像提案 | 2 |
| 记忆整理 | 每天 | 本 Bot 记忆 | 2 |
| 画像整理（全局唯一） | 收到画像提案、定期 | 共享用户画像 | 2 |
| Wiki 维护 | 入库队列、定期体检 | 本 Bot Wiki | 2 |
| 技能生成 | 反思建议、`create_skill` | 本 Bot Skills（草稿） | 2 |

- 后台 loop 的工作目录为 `bots/{id}/maintenance/{loop_type}/`，与 `workspaces/` 分属不同命名空间。
- 后台 loop 永远不阻塞对话轮。

## 上下文注入

每个对话轮与任务按四层注入（实现细则见 [dev/04](../dev/04-agent-runtime.md#上下文组装)）：

| 层 | 对话轮 | 任务 |
|---|---|---|
| 系统层 | 对话轮版 `<platform_rules>` + 人设、画像、记忆、我的状态、对话类型 / 群成员、project、workspace、Wiki 目录、Skills | 任务版 `<platform_rules>`，其余同源 |
| 对话层 | 滚动摘要 + 最近消息，**含本 Bot 的私有任务条目**，按 `seq` 交错 | 滚动摘要 + 最近消息，**只含共享行**（不含任何任务的私有往返） |
| 续接 / 任务段 | `<tasks>`：本对话进行中与排队中的任务（标题、状态、读写、派出时间、排队原因、等待用户输入、最近进度、可否注入），确定性生成 | `continues_task_id` 时的 `<continuation>` |
| 触发层 | 每个来源批一个 `<trigger reason="…">`；任务结果条目全文进触发段（硬顶 `TASK_TRIGGER_RESULT_MAX_CHARS`，超过给开头并提示用 `forward_task_result`） | `<task_brief>`：标题、`instruction`、`source_message_ids` 指向的**用户原消息原文**（附件与图片照触发批方式带入）、启动前收到的追加指令 |

- **Bot 私有时间线**：Bot 与任务之间的往返（交代 / 追加 / 取消 / 提问 / 结果 / 失败）记为 `kind='task_event'`、带 `owner_bot_id` 的消息，只进 owner Bot 的上下文，不进用户可见流，也不进群里其他 Bot 的上下文；单聊即 UX，群聊即 GX，不另建列表。所有读路径按视角过滤，对话摘要只摘共享行（[30 §2.4](30-supervisor-and-tasks.md#24-上下文与输入bot-私有时间线)）。
- 最近窗口里的任务条目与任务进度按 `TASK_EVENT_CONTEXT_MAX_CHARS` 截断，全文用 `get_messages_around` 取。
- 任务卡在上下文中渲染为一行状态（「任务卡 t_…（Bot）「<untrusted>标题</untrusted>」：进行中，…」；标题是模型起的，按数据对待），不含交代或结果全文。
- 记忆相关的注入细则见 [04-memory.md](04-memory.md#注入方式)。

### 对话与执行记录查询工具

| 工具 | 用途 |
|---|---|
| `search_messages` | 按关键词、发送者、时间范围查询消息（按视角：对话轮含自己的私有条目，任务只看共享行） |
| `get_messages_around` | 获取某条消息前后的上下文（同上） |
| `get_attachment` | 获取附件：文本返回内容；其他类型复制到 workspace `.attachments/`（只读 run 也可，宿主代为复制且限定在该目录） |
| `list_my_runs` / `get_run` | 查询自己的对话轮与任务记录 |

## 群聊响应

### 指定响应

- 用户 @ 了某个 Bot，或引用回复了某个 Bot 的消息：由被指定的 Bot 直接响应。

### 未指定时

1. 唤醒群内所有 Bot，各自先做一次**轻量判断**（只看最近几条消息，并带上「最近的对话对象」提示），结果为三种之一：要响应 / 需要有人处理但不归我 / 不需要任何人回应。
2. 判断为「要响应」的 Bot **按顺序执行对话轮**；后执行的 Bot 能看到前者的回复，觉得已被回答可以放弃。**群轮次在对话轮终态推进，不等任务**：Bot A 说完「我去查一下」就让位给 Bot B，B 看到的是 A 的表态而非结论（D5 的有意弱化，[30 §6.2](30-supervisor-and-tasks.md#62-群聊)）。任务不参与群轮次。
3. 所有判断结束（设超时）后，如果没有 Bot 响应，且至少一个 Bot 认为「需要有人处理但不归我」，则在对话中插入一条系统消息，附可点击的 Bot 列表，请用户指定。
4. 对「大家好」「谢谢」这类无需回应的消息，不弹出提示。
5. 按顺序响应的过程中，如果某个 Bot 被删除或移出群，其对话轮与任务中断，跳过它继续下一个。
6. 轮次进行中新发出的批**不再抄送（steer）给正在响应的 Bot**：它们等本轮结束后按 @ / 判断重新分派给相关的 Bot（正在响应的 Bot 在上下文里看得到它们）。

### Bot 之间的触发

- Bot 的发言默认不广播唤醒其他 Bot，只有对话轮明确 @ 另一个 Bot 时才触发；任务不能 @ 群成员。
- 设置最大连锁层数（例如 3 层）和总预算上限，防止无限循环。

## 任务内的嵌套子代理（D66）

`delegate_task` 降级为**任务内部**的嵌套子代理（[23-mcp-and-subagent.md](23-mcp-and-subagent.md)）：任务遇到「只要结论、材料很长」或「多路并行检索」的子问题时委派减配子 run（`loop_type='subagent'`，只读研究工具），结论压缩后回到父任务。

- **前台同步**（默认）：父 loop 阻塞等结论。
- **后台分支**（`mode:"background"`）：立即返回 `child_run_id`，分支在父任务内并行；父 loop 需要结论时调用 `collect_delegate_results` 取回（等待未结束的分支、按委派顺序、每条只交付一次）。结论只回到父任务：不写对话消息、不投递 mailbox、不唤醒新一轮。
- **并行 fan-out**（`tasks: [...]`）：多路并行，有硬顶。
- 生命周期全部挂父 run：父 run 中止级联中止分支；父 run 结束时宿主中止仍在跑的分支并等其 settle（最长 `SUBAGENT_CLOSE_GRACE_MS`），先于释放写租约与任务结算，未取回的结论作废。后台并发封顶 `SUBAGENT_BACKGROUND_CONCURRENCY` 按父 run 计。
- 对话轮与子代理调用 `delegate_task` 在执行期被拒（`NOT_SUPPORTED`）；子代理沿父 run 继承只读规则。对话级的并行由任务层提供，不由 `delegate_task` 提供。

## 跨 Bot 委派（A→B，D71）

`delegate_to_bot` 属于**对话轮**工具面：把事情交给**另一个联系人 Bot**（[27-butler-and-delegation.md](27-butler-and-delegation.md)）。B 私聊出现带「由 A 代你发出」标签的用户代发消息，触发 B 的**对话轮**；B 的投递闸门「邮箱空闲」指 B 没有进行中的对话轮。B 那一轮的最终回复截断后贴回 A 为结果卡。需要动手的委派，B 只能派任务并先回复「我去做」——这句话就是贴回 A 的结果，真正的结果之后出现在 B 的私聊里（见 DEV-012）。同群且 A/B 均在场时降级为 D4 `@`。

## MCP 工具

用户配置的 MCP server 按「应用启用 ∩ Bot 勾选」把工具并入**任务**的工具面（对话轮不提供 MCP 工具）：调用统一走网关审批与审计，结果按 `<untrusted>` + 截断处理，密钥字段级加密。见 [23-mcp-and-subagent.md](23-mcp-and-subagent.md)。

## 主动消息

- 调度器支持两类触发：
  - **时间**：一次性或周期性。Bot 通过 `schedule(when, conversation_id, note)` 创建；带截止时间的承诺自动生成定时任务。
  - **事件**：异步作业完成、Wiki 入库完成、宿主层环境安装完成等，后续可接外部 webhook。
- 触发后以系统事件进入「Bot + 对话」的 mailbox，走正常的对话轮；发不发、发什么、要不要派任务由 Bot 决定。
- 护栏：免打扰时段、每日主动消息上限；用户可以查看并取消所有定时任务。任务结算唤醒的对话轮不受免打扰停放。
- 对话删除时，绑定该对话的定时任务一并取消。
- **错过的定时任务**：电脑休眠或关机期间无法执行；唤醒后补执行，并在触发信息中告知 Bot 迟到了多久，由 Bot 决定是否仍要发送。

## 撤回与编辑

待发送队列中的内容尚未发出，用户可直接修改或删除，不产生任何事件。

已发出消息的撤回和编辑：

| 情况 | 处理 |
|---|---|
| 正在运行的对话轮已读过该消息（编辑） | 编辑后的消息作为 `event`（`message_edited`）缓冲到下一个对话轮 |
| 没有正在运行的对话轮（编辑） | 编辑作为一次新触发，由 Bot 决定是否回应 |
| 触发消息在对话轮开始前被编辑 / 撤回 | 对话轮开始执行时重新读取：取最新内容，撤回的移出触发 |
| 任务已带走原文（简报 / 追加） | 不自动通知任务；需要时由对话轮 `inject_task` / `cancel_task` |

撤回的连锁处理：

- 撤回的消息从 Bot 可见的历史中移除。
- 只以该消息为证据的记忆条目，由整理 loop 撤回。
- 撤回的附件如已入 Wiki，从 `raw/` 删除并重新体检。
