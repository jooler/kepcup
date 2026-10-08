# 30 对话轮与任务（Supervisor + Tasks）

今天 Bot 的一次响应既是**对话轮次**又是**执行单元**：用户发消息 → 起一个 loop → loop 既干活又说话 → loop 结束才算这一轮结束。由此派生三个问题：

1. **对话被执行阻塞**。长任务期间 Bot 不是「在忙」，而是「不在」——它的唯一 loop 正在跑工具，用户说什么都只能作为注入塞进那个 loop，由那个 loop 顺手处理。
2. **新指令只有一种处理方式**。`mailbox.deliver` 对运行中的 loop 一律 steer（`packages/core/src/scheduler/mailbox.ts` `deliver`），Bot 没有机会决定「这该打断当前任务」「这是另一件事，并行做」「这要等当前任务结束」。
3. **并行能力几乎没有**。每个（Bot, 对话）同时最多一个 loop，这是 workspace 不冲突的保证（[02-execution.md](02-execution.md#并发每个bot--对话一个串行队列)），但也是并行的上限。

本文把这两个角色拆开：**对话轮（supervisor turn）负责沟通与调度，任务（task）负责执行**。决策：D75。设计上这是对 D66（SubAgent）、D71（委派）、D72（外部引擎）三套机制的**归并与化简**，不是第四套机制。

执行方案待编（`todo/supervisor-and-tasks.md`）。**尚未实现**。

相关：D2（执行中注入，本文修订）、D5（群聊顺序响应，本文修订）、D29/D30（写入租约与检查点，本文扩展）、D37（授权有效期，本文收紧）、D48/D54/D55（Bot 发消息、中间说明、状态行）、D49/D67（中断与 durable，本文改适用对象）、D56（Loop 续接，本文修订）、D58（对话内设置）、D66（SubAgent，本文降级其定位）、D70/D71（管家与跨 Bot 委派，本文照搬其状态机与回贴范式）、D72（外部智能体引擎，本文化简其让渡面）、[01-conversation.md](01-conversation.md)「消息原则」（内部事务，本文扩展为按 Bot 归属的私有条目）。

## 决策

- **D75 对话轮与任务分治**：
  1. **两层 loop，寿命差一个数量级**。**对话轮**（`loop_type='turn'`）由消息 / 定时 / 事件触发，秒级，发完消息立即结算；**任务**（`loop_type='task'`）由对话轮显式派出，分钟到小时级，多条可并行。对话轮**永不等待任务**——任务结算是一个事件，事件唤醒下一个对话轮。
  2. **职责切分即权限切分**：**写操作与长时工作只发生在任务里，对话轮只读**。对话轮的工具面 = 对话核心 + 只读上下文查询 + 任务管理 + 异步托管动作（委派、定时、Wiki 入库、管家提议）；任务的工具面 = 现有完整工具面。由此对话轮不需要写租约、不需要沙箱升级、不需要命令审批，跑得勤也不危险。
  3. **串行的是对话轮，不是执行**。每个（Bot, 对话）同时最多一个对话轮（mailbox 不变，D2 的「执行中收到新消息」语义由「无条件注入当前 loop」改为「进入下一个对话轮，由 Bot 决定」）；任务在对话轮之外，受对话级与全局并发封顶。
  4. **路由决策是枚举化的工具调用**，不是自由文本：`start_task` / `inject_task` / `cancel_task` / `list_tasks`，宿主逐项校验归属与配额。「重新执行」= `cancel_task` + `start_task({continues_task_id})`，不设独立原语。
  5. **写互斥用租约，不用物理隔离**：同一 workdir 同时最多一个写任务（写租约扩到 workspace），只读任务不限并发。**git worktree 隔离明确不做**（§9.1 四条理由），任务模型只留 `workdir` 这一个口子，日后换隔离策略不动执行模型。
  6. **可靠性的全部是「任务必有结算」**：任务先落盘再启动；终态与私有结果条目**同一事务**写入——结果条目本身就是持久化的结算通知；唤醒对话轮按 at-least-once 投递，对话轮终态时标记消费，启动对账 + reaper 补投未消费的结果（宁可重复一次，不可静默丢失）。拆分后最严重的用户可见故障不是慢，而是沉默——整个状态机围绕消除沉默设计。
  7. **消息所有权：进度直达，结果经对话轮转述**。任务的中间说明（过程叙事）直接进对话，带任务归属；任务的最终结果**不直接发给用户**，而是写入 Bot 的私有时间线（§2.4）并唤醒对话轮，由对话轮结合历史决定怎么告诉用户——转述、`forward_task_result` 原文转发，或连同下一步一起说。正式交付永远只从对话轮这一个出口出，不需要「不要复述」之类的补救指令。**对话轮被唤醒是宿主确定性判断**（§3.3）。
  8. **路由必须留痕**：`start_task` / `inject_task` / `cancel_task` 在对话中生成并重绘任务卡。无声路由是禁止的——用户发出的指令去了哪里，必须看得见。
  9. **对 D72 的化简**：**对话轮固定走内置引擎，外部 Agent 只作任务引擎**。`runtime.agent` 的语义从「Bot 的引擎」变为「Bot 的任务引擎」。人设 / 记忆 / 路由 / 审批 / 群聊 / 委派 / 提示词逐轮刷新不再让渡；「`delegate_task` 不提供」这条让渡消失（并行由宿主任务层提供，不依赖 Agent 自身支持）。无内置模型的用户按 §8.4 两级降级，并显式承认那是降级。
  10. **深度 1**：任务不能再派任务（同 D71 单跳理由——链式结算是真正难的部分）。任务内部照常可用 D66 `delegate_task` 或外部 Agent 自带的子代理。
  11. **Bot 私有时间线（UX / GX）= 同一张消息表上的一层归属**：Bot 与任务之间的往返（交代、追加、取消、提问、结果、失败）作为 `kind='task_event'` 的消息写进对话本身的消息表，带 `owner_bot_id`——只进该 Bot 的上下文，不进用户可见流，也不进群里其他 Bot 的上下文。Bot 看到的历史 = 对话可见消息 ∪ 自己的私有往返，按 `seq` 天然交错成一条时间线：单聊即 UX，群聊即 GX，**不另建列表**。任务内部的工具调用与模型往返仍只在 `run_steps`。现有内部事务（wiki / 环境 / 技能 / 调度 / 凭据）保持对话共享，不改归属。



## 1 现状与归并关系



### 1.1 已有的零件

拆分所需的机制大部分已经存在，只是被摆成了另一个形状：


| 本文需要                    | 现有实现                                                                   | 位置                                                                     |
| ----------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 对话轮串行器                  | 每（Bot, 对话）一个 mailbox，同时最多一个 loop                                       | `packages/core/src/scheduler/mailbox.ts`                               |
| 向运行中执行体注入               | `RunHandle.steer()`；落不下时缓冲 `#pendingSteers`                            | `packages/core/src/dispatch/orchestrator.ts` `#steerRunningRun`        |
| 任务注册表 / 并发计数 / abort 入口 | `SubagentHost`（对话级后台子 run 锚点、`runningCount`、`abortForConversation`）    | `packages/core/src/agent/subagent.ts` `SubagentHost`                   |
| 结算后回注对话                 | 后台子 run settle → `onFollowUp` → `#injectDelegateFollowUp`              | `packages/core/src/dispatch/orchestrator.ts` `#injectDelegateFollowUp` |
| 任务状态机 + settle 钩子 + 结果卡      | D71 委派：`submitted/working/completed/failed/cancelled` + `onRunSettled` | `packages/core/src/dispatch/delegation.ts`                             |
| 执行体 = 可审计单元             | `runs` 表（`loop_type` / `engine` / `continued_from_run_ids`）            | `packages/core/src/domain/runs.ts`                                     |
| 写互斥 + 排队 + 前后快照         | `ensureWriteLease` / `waiting_lease` / 影子仓库检查点                         | `packages/core/src/project/service.ts`                                 |
| 任务过程回放                  | D56 的 `buildRunDigest`                                                 | `packages/core/src/agent/context/continuation.ts`                      |
| Bot 私有时间线的形状           | 同一张消息表两条读路径：Bot 上下文读 `list()`（含内部事务），用户 UI 读 `listVisible()`，内部事务不推 `message.created` | `packages/core/src/domain/messages.ts` `isVisibleToUser` / `listVisible`；orchestrator `#appendSystemMessage` |


**结论：这是重新接线，不是新栈。** 真正新增的只有「对话轮」这一层薄的、只读的、枚举化决策的 loop，以及任务层的结算对账。

### 1.2 与 D66 / D71 的定位关系


|     | D66 `delegate_task`   | D71 `delegate_to_bot`   | D75 任务             |
| --- | --------------------- | ----------------------- | ------------------ |
| 执行者 | 同 Bot 的减配子 run（只读研究集） | 另一个联系人 Bot 的完整对话轮       | 同 Bot 的完整执行体       |
| 发起者 | 执行中的 loop（任务内部）       | 对话轮                     | 对话轮                |
| 消息  | 不写用户消息                | B 私聊出现代发消息              | 中间说明直达本对话；结果进 Bot 私有时间线 |
| 回传  | 压缩结论进父 loop           | 截断原文贴回 A 为卡 + follow-up | 私有结果条目 → 对话轮转述 / 原文转发 |
| 并发  | 后台 / fan-out，对话级封顶    | 异步单跳                    | 对话级封顶，1 写 N 读      |


**D66 降级为「任务内部的嵌套子代理」**：它的三种模式（前台 / 后台 / fan-out）仍然有用——任务内部「只要结论、材料很长」的子问题照旧——但「后台委派 + 对话级锚点 + follow-up 注入」这一组职责**移交任务层**，不再由 `delegate_task` 承担（否则有两套对话级并发计数与两套结算路径）。实现期把 `SubagentHost` 提升为 `TaskHost`，`delegate_task` 的后台模式退回「父任务内的并行分支」。

**D71 不变**：它本来就是异步 + 结果卡 + 禁止复述的范式，本文照搬其**状态机与 settle 钩子**；「禁止复述」不沿用——D75 的任务结果经对话轮转述，天然只有一个出口（§6.1）。`delegate_to_bot` / `cancel_delegation` / `propose_`* / `suggest_route` / `list_bots` 全部归入**对话轮**工具面——它们正是「立即返回、宿主干活」的那一类。

## 2 两层模型



### 2.1 对话轮（supervisor turn）


| 项           | 规定                                               |
| ----------- | ------------------------------------------------ |
| `loop_type` | `'turn'`（替代今天的 `'response'`）                     |
| 触发          | 用户消息批、`@` / 回复、群聊判断通过、定时、事件、D71 委派、任务结果 / 失败条目（§2.4）、设置完成续跑 |
| 并发          | 每（Bot, 对话）同时最多一个（mailbox 不变）；调度优先级沿用今天的响应 run 规则 |
| 引擎          | **固定内置 pi**（§8.4 降级除外）                           |
| 轮次上限        | `TURN_MAX_TURNS`（建议 8）——对话轮不该出现长工具链；超限按失败结算并提示   |
| 可写          | 消息；任务（派出 / 注入 / 取消）；记忆候选、Wiki 入库请求、定时任务（异步托管动作）  |
| 不可写         | 文件、命令、浏览器、媒体生成、技能安装、环境安装——一律经任务                  |
| 结束          | 最终回复自动发送（D48 不变）；无话可说时 `skip_reply`              |


**工具面**：


| 组        | 工具                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 对话核心     | `send_message`、`skip_reply`、`forward_task_result`（原文转发任务结果，§6.1）                                                         |
| 只读查询     | `search_messages`、`get_messages_around`、`get_attachment`、`list_my_runs`、`get_run`、workspace / project 只读读取（read / ls / grep / find）             |
| 任务管理     | `start_task`、`inject_task`、`cancel_task`、`list_tasks`                                                                                           |
| 异步托管动作   | `delegate_to_bot`、`cancel_delegation`、定时任务、Wiki 入库请求、记忆候选；管家另有 `propose_bot` / `propose_team` / `propose_group` / `suggest_route` / `list_bots` |
| 轻量检索（可选） | `web_search` / `web_fetch`，按 Bot 配置开关；计入 `TURN_MAX_TURNS`                                                                                       |


对话轮只读这条**在执行期校验**，不只靠不注册工具：与 D71 单跳同理——注册期摘除是让模型少看到无用工具的优化，工具网关按 `loop_type='turn'` 硬拒一切写路径才是保障。

### 2.2 任务（task）


| 项           | 规定                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `loop_type` | `'task'`                                                                                                             |
| 触发          | 对话轮的 `start_task`（唯一入口）                                                                                              |
| 并发          | 对话级 `TASK_CONCURRENCY_PER_CONVERSATION`（建议 3）、全局 `TASK_CONCURRENCY_GLOBAL`；单个对话轮最多起 `TASK_START_MAX_PER_TURN`（建议 2）个 |
| 引擎          | 内置 pi 或该 Bot 配置的外部 Agent（§8）                                                                                         |
| 工具面         | 现有完整响应工具面（文件、命令、浏览器、媒体、MCP、连接应用、技能、`delegate_task`、交互执行、`send_message`）                                              |
| 可写          | 消息（中间说明，直达可见流）；私有时间线（最终结果 / 失败 / 提问条目，§2.4）；`workdir` 内文件、授权范围内的其他路径 |
| 寿命          | 默认 ephemeral（D49）；可标 durable（D67）——长任务才是 journal 的真实适用对象                                                             |
| 上限          | `TASK_MAX_WALL_MS`、`TASK_TOKEN_BUDGET`（外部 Agent 按轮数 / 时长折算）                                                          |
| 深度          | 1：任务内不得 `start_task`（执行期按 `loop_type` 校验）                                                                            |




### 2.3 一次完整的交互

```text
用户：把这个项目的测试补全
  → 对话轮 #1（内置引擎，几秒）
      start_task({ title:'补全测试', instruction:…, source_message_ids:[m_101], writes:true })
          → task A（submitted → running）；私有时间线记「你→任务 A（交代）」
      最终回复：「好，我开始补测试了，大概要一会儿」                      → 可见消息
    对话轮 #1 结算。Bot 此刻空闲，可接收新消息。

用户：顺便看一下 README 有没有过期的地方
  → 对话轮 #2
      <tasks> 段里看到 task A 正在跑
      判断：这是另一件事，且只读 → start_task({ title:'检查 README', writes:false })  → task B（并行）
      最终回复：「README 我另起一条看，补测试那边继续」                  → 可见消息（路由留痕）
    对话轮 #2 结算。

task A 的中间说明「先跑一遍现有测试，看看覆盖率」               → 可见消息（带任务归属，直达）
task B 完成 → 私有时间线记「任务 B→你（结果）」（与终态同一事务）→ 唤醒对话轮
  → 对话轮 #3（触发 = 这条结果条目）
      结合时间线：用户问的是「过期的地方」，结果列了 3 处
      forward_task_result(B) + 最终回复：「README 有 3 处过期，详情如上；要我顺手改掉吗？」

用户：算了，测试先别补了，先把 CI 修好
  → 对话轮 #4
      判断：与 task A 冲突 → cancel_task(A, '用户改变主意') + start_task({ title:'修 CI', writes:true })
      最终回复：「补测试我停了（改动可回退），转去修 CI」                 → 可见消息
```

### 2.4 上下文与输入：Bot 私有时间线

把 Bot 当成一个真人 X：X 记得自己和用户 U 说过什么（UX），也记得自己交代过任务什么、任务回了什么；在群 G 里，X 另有一份（GX）。X 收到新消息时，结合这份历史决定直接回复、派活、追加还是取消。本节规定这份历史怎么存、怎么读。

**结论：不另建列表。** UX / GX 就是对话消息表在「Bot X」视角下的读法：

```text
UX / GX(X) = 对话中对用户可见的消息（用户发言、Bot 回复、任务进度、卡片）
           ∪ 归属 X 的私有条目（X 与任务之间的往返）
           按 seq 排序
```

**现有机制已经是这个形状**：消息表本来就有两条读路径——用户 UI 走 `listVisible()`（内部事务在 SQL 层排除），`#appendSystemMessage` 对 `internal` 消息不推 `message.created`；Bot 读上下文走 `list()`，内部事务照常进入（[01-conversation.md](01-conversation.md)「消息原则」，`packages/core/src/domain/messages.ts` `isVisibleToUser`）。本节只把「只给 Bot 看」从「不给用户看、所有 Bot 都看」细化为「只给某一个 Bot 看」。

一张表、一个 `seq` 的好处是具体的：用户的话、Bot 的回复、Bot 交代任务的话、任务交回的结果天然按真实发生顺序交错，不需要合并两份列表；最近窗口、token 预算、`search_messages`、`get_messages_around`、对话删除级联全部复用。

#### 2.4.1 写入什么

| 条目 | 方向 | 写入时机 | 内容 |
|---|---|---|---|
| 交代（`brief`） | X → 任务 | `start_task` 写 `submitted` 行的同一事务 | 标题、`instruction`、`source_message_ids`、`writes`、`continues_task_id` |
| 追加（`inject`） | X → 任务 | `inject_task` | 文本、`source_message_ids`、`delivered` / `queued` |
| 取消（`cancel`） | X → 任务 | `cancel_task` | 理由、已产生改动的摘要 |
| 提问（`question`） | 任务 → X | 任务需要用户输入（提问、凭据、setup） | 问题、对应可见问题卡的消息 id |
| 结果（`result`） | 任务 → X | 任务 `completed`，与终态**同一事务** | 最终结果全文（`skip_reply` 时为空） |
| 失败（`failure`） | 任务 → X | 任务 `failed` / `cancelled` / `interrupted`，与终态同一事务 | 状态、错误、最后几步的摘要（`buildRunDigest`） |

**不写入**：任务内部的工具调用与模型往返——那是过程，留在 `run_steps`，需要时经 `get_run` 查；任务的中间说明——它直达可见流（§6.1），本来就在时间线里。

#### 2.4.2 数据模型

- `messages` 增列 `owner_bot_id TEXT NULL`：`NULL` = 对话共享（现有全部行）；非空 = 仅该 Bot 可见。
- `messages.kind` 增 `'task_event'`（表级 CHECK 需重建表，早期阶段可接受）。内容 `{ taskId, phase: 'brief'|'inject'|'cancel'|'question'|'result'|'failure', text, sourceMessageIds?, status?, error? }`，`sender_type='system'`。
- 可见的任务进度消息：`textContentSchema` 增 `origin: 'task'` + `taskId`（照 D71 `origin: 'delegation'` 的先例落 `content_json`，免加列）。
- **范围**：`owner_bot_id` 只用于 `task_event`。现有内部事务（wiki / 环境 / 技能 / 调度 / 凭据）保持对话共享、不迁移——它们多数影响群共享的 project / 环境，不是某个 Bot 的思考过程。

#### 2.4.3 读取：按视角的统一读法，所有读路径都走它

| 视角 | 规则 |
|---|---|
| 用户（UI 列表、实时推送、未读数、会话预览） | `owner_bot_id IS NULL` 且非内部事务；`task_event` 一律不推送 `message.created` |
| Bot X（上下文、触发、工具查询） | `owner_bot_id IS NULL OR owner_bot_id = X` |

必须覆盖的读路径：上下文构建（`list` → `listForBot`）、`search_messages`（FTS 表加 `owner_bot_id` UNINDEXED 列，查询时过滤）、`get_messages_around`、外部 Agent 会话增量（`buildConversationDelta`）、群聊判断输入、反思输入、会话列表预览与未读数。**任何一处漏掉都是 Bot 间泄露**——群里 Y 用 `search_messages` 就能搜出 X 与任务的往返。因此加一组契约测试：构造多 Bot 群对话，断言每条私有条目在 owner 以外的所有视角、所有读路径下都不可见。

**对话滚动摘要只摘共享行**（`owner_bot_id IS NULL`）：摘要是对话级的一份、群里所有 Bot 共用，摘进私有条目就等于泄露。私有条目滑出最近窗口后，历史任务的事实由任务登记（`list_tasks` / `get_run`）与反思记忆承担（§12 第 3 点）。

#### 2.4.4 渲染

Bot X 的上下文里，三类与任务相关的行分别渲染为：

```text
[m_201 | 10:02 | 你→任务 t_7f3a（交代）] 补全测试：为 src/parser 补单测，覆盖率到 80%…
[m_215 | 10:15 | 你（任务 t_7f3a）] 先跑一遍现有测试，看看覆盖率          ← 可见的任务进度
[m_240 | 10:40 | 任务 t_7f3a→你（结果）] 新增 14 个用例，覆盖率 62% → 83%…
```

- 最近窗口里的任务进度与较早的结果条目按 `TASK_EVENT_CONTEXT_MAX_CHARS` 截断，全文用 `get_messages_around` 取——否则一份长报告加几条进度就能把用户的话挤出最近窗口（30 条 / 4000 token）。
- **触发本轮的结果条目全文进触发段**（受硬顶约束，§12 第 6 点）：对话轮要据此转述，不能只看截断版。

#### 2.4.5 任务看到什么

任务不读 X 的完整时间线，只读与自己相关的部分：

- **系统层**：人设、画像、记忆、Wiki 目录、Skills、project / workspace 信息——与对话轮同源；
- **对话层**：共享行（摘要 + 最近窗口），**不含**其他任务的私有往返（任务之间互不干扰；需要别的任务的结论，由对话轮写进交代）；
- **简报**：本任务的交代条目——`instruction` 加上 `source_message_ids` 指向的**用户原消息原文**，附件与图片（D61）原样带入。`instruction` 是对话轮的转述，转述会丢细节，原文兜底；
- 本任务后续的追加条目同样带原文；`continues_task_id` 时按 D56 预算回放来源任务的过程（§7.1）。

#### 2.4.6 任务向用户提问

- 任务写一条私有 `question` 条目 + 一张可见问题卡（绑定 `task_id`），任务在 `running` 下标 `awaiting_input`，`<tasks>` 段可见。
- 用户点选卡上的选项 → 答案**直接注入该任务**，不经对话轮（与审批卡同理）。
- 用户用自由文本回答 → 进对话轮，对话轮从 `<tasks>` 看到哪个任务在等输入，用 `inject_task` 转交（带 `source_message_ids`）。

## 3 任务状态机与「必有结算」



### 3.1 状态

照搬 D71 语义，不另造一套：

```text
submitted   行已落盘，尚未启动（等写租约 / 等并发额度 / 等 Agent 进程）
  → running
      → completed    正常结束（结果已写入私有时间线；skip_reply 时结果为空）
      → failed       执行失败（含结构化 setup 失败，D58）
      → cancelled    对话轮 cancel_task / 用户在卡片上取消 / 关对话 / 删 Bot
      → interrupted  进程退出或崩溃（D49）
```

- **先落盘再启动**：`start_task` 工具在返回 task_id 之前就写入 `submitted` 行。崩在工具返回之前 = 没有任务；崩在之后 = 有一行 `submitted`，重启后重新排队（它还没开始，重排是安全的）。不存在「幽灵任务」这个中间态。
- `submitted` 的任务对用户与模型都可见（任务卡 + `<tasks>` 段），显示排队原因。
- 终态不可逆。任务的终态是**事实来源**，对话中的卡片与 UI 列表都是它的投影。



### 3.2 结算通知（可靠性核心）

**不变量：每个进入终态的任务，其结果至少被对话轮消费一次；宁可重复一次，不可静默丢失。**

拆分前「loop 结束 ⇒ 必有消息」是天然成立的，用户不可能被静默忽略。拆分后这个保证必须显式构造。私有时间线（§2.4）让构造变得简单：**结果条目本身就是持久化的通知**，不需要另一张通知表或「已通知」标记。

- **写**：任务终态与私有 `result` / `failure` 条目在**同一事务**写入。不存在「终态已写、通知没落盘」的窗口。
- **投**：事务提交后，把该条目作为触发批交给该（Bot, 对话）的 mailbox（`TriggerBatch.reason='task'`）。条目是一条真实消息，`mailbox.deliver` 对空批的直接返回不会吞掉它。对话轮运行中到达的条目进待投队列，release 时合并为下一轮的一个批——多个任务同时结算只唤醒一轮。
- **消费**：触发批里含该条目的对话轮到达终态（含 `skip_reply` 与 `failed`）时，宿主写任务行的 `result_consumed_at`。
- **对账**：启动时与 reaper 周期（`TASK_SETTLE_SWEEP_MS`）扫描「终态 AND `result_consumed_at IS NULL`」且应唤醒（§3.3）的任务，重新投递其结果条目。

| 故障 | 处置 |
|---|---|
| 终态事务提交后、投递前崩溃 | 对账补投（条目已在库里） |
| 对话轮消费途中崩溃 | `result_consumed_at` 仍为空 → 对账补投；对话轮可能已说过一部分，重复一次可接受 |
| 任务在对话轮运行期间结算 | 进待投队列，release 时排空（**不是**丢弃——今天 `#steerRunningRun` 已在处理同类问题：steer 落在 `agent_end` 之后会静默消失） |
| 任务挂死（Agent 无响应、工具卡住） | reaper 扫描 `running` 超 `TASK_MAX_WALL_MS` → 强制 `failed`，同事务写 `failure` 条目 |
| 免打扰时段 | 任务结果**不停放**：任务由用户发起，交付结果不是主动消息（`deliverEventToBot` 的 quiet-hours 停放不适用） |

实现次序固定为：**终态 + 结果条目同事务 → 投递 → 对话轮终态时标记消费**。语义是 at-least-once；重复消费时对话轮从时间线看得到自己已经转述过（上一条回复就在那里），通常只会得到「没有新话要说」。反过来（先标记再投递）会把丢失变成沉默，禁止。

### 3.3 唤醒条件（宿主确定性判断，不是模型判断）

| 情况 | 唤醒对话轮 |
|---|---|
| 任务 `completed` 且结果非空 | **是**——结果要经对话轮转述（§6.1） |
| 任务 `failed` / `interrupted` | 是 |
| 任务 `cancelled`（对话轮 `cancel_task` 或用户在卡片上取消） | 否——取消是本轮或用户的决定，卡片已转终态；`failure` 条目照写，直接标记消费 |
| 任务 `cancelled`（关对话 / 删 Bot / 移出群） | 否——没有可唤醒的对象 |
| 任务写入 `question` | 否——可见问题卡已出现，用户的回答才触发下一步（§2.4.6） |
| 任务 `completed` 且结果为空（`skip_reply`） | 否，直接标记消费 |

成本：每个产出结果的任务多一次对话轮（「对话轮 + 任务 + 转述轮」三次调用），这是「正式交付统一出口」的代价，已接受。缓解有两条：同一时刻结算的多个任务合并成一轮；长结果用 `forward_task_result` 原文转发，对话轮只生成衔接语，不重新生成全文（§6.1）。

### 3.4 落盘

任务就是 `runs` 行（`loop_type='task'`），不另建 `tasks` 表——否则 run 的状态、步骤、用量、引擎、续接来源要在两处维护。新增列：


| 列                     | 用途                                           |
| --------------------- | -------------------------------------------- |
| `task_title`          | 卡片与 `<tasks>` 段的标题（由 `start_task` 给出）        |
| `task_writes`         | 是否写任务（决定租约与网关裁决）                             |
| `task_workdir`        | 工作目录（`workspace` / `project` / 任务私有子目录的解析结果） |
| `origin_run_id`       | 派出它的对话轮                                      |
| `result_consumed_at` | §3.2 的消费标记：触发批含其结果条目的对话轮到达终态时写入 |


`continued_from_run_ids` 复用（`start_task({continues_task_id})` 的回放来源）。

## 4 路由：对话轮的决策面



### 4.1 工具契约


| 工具            | 参数                                                                       | 宿主校验                                                                   | 返回                                                        |
| ------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `start_task`  | `title`、`instruction`、`source_message_ids`、`writes`、`workdir?`、`continues_task_id?`、`engine?` | 本轮起数未超 `TASK_START_MAX_PER_TURN`；对话级并发未满；`source_message_ids` 属于本对话；`loop_type='turn'`（任务内调用一律拒绝） | `task_id` + 初始状态（`running` 或 `submitted` 及排队原因） |
| `inject_task` | `task_id`、`text`、`source_message_ids?` | task 属于本（Bot, 对话）且在 `running` | `delivered`（已注入当前轮）/ `queued`（Agent 不支持 steering，任务结束后生效） |
| `cancel_task` | `task_id`、`reason`                                                       | 同上，允许 `submitted` / `running`                                          | 取消确认 + 已产生改动的摘要                                           |
| `list_tasks`  | —                                                                        | —                                                                      | 进行中 + 窗口内已结算的任务（id、标题、状态、启动时间、最近进度行、是否可注入）                |
| `forward_task_result` | `task_id` | task 属于本（Bot, 对话）、已 `completed`、结果非空、未转发过 | 已发出的可见消息 id（Bot 身份、带任务归属，正文 = 结果条目全文） |


路由决策集合保持前四个；`forward_task_result` 是转述动作，不是路由（§6.1）。「重新执行」= `cancel_task` 然后 `start_task({continues_task_id})`：宿主按 D56 预算把被取消任务的 `run_steps` 回放进新任务上下文（读过哪些文件、试过什么、为什么停），避免重新踩坑。不设 `restart` 原语——它会要求「取消与启动原子化」，而取消在外部 Agent 上有不可忽略的时延（§8.3）。

### 4.2 `<tasks>` 上下文段

对话轮的上下文在现有分层（系统 / 对话 / 续接 / 触发，[02-execution.md](02-execution.md#上下文注入)）之外插入一段，确定性生成、零额外模型调用：

```text
<tasks>
  [t_7f3a] 补全测试        running   启动 12 分钟前   最近：正在运行 pnpm test   可注入：是
  [t_91cc] 检查 README     submitted 排队中（等写入租约：t_7f3a 持有）
  [t_a210] 部署预览环境     running   等待用户输入（问题卡 m_388）
</tasks>
```

只列**进行中与排队**的任务——它们的状态是可变的，时间线里的条目是不可变的历史。已结算任务的交代与结果已经作为条目躺在时间线里（§2.4），不重复列。模型不必每轮先调 `list_tasks`；`list_tasks` 保留给需要更多细节的场景。

### 4.3 路由留痕（强制）


| 动作            | 对话中的呈现                                                  |
| ------------- | ------------------------------------------------------- |
| `start_task`  | 任务卡（`kind='card'`）：标题、状态、进度行、取消按钮；随 `task.updated` 事件重绘 |
| `inject_task` | 卡片上追加一行「已把新指令转给此任务」（含被转的指令摘要）                           |
| `cancel_task` | 卡片转 `cancelled`，附改动摘要与回退入口（D30 检查点）                     |
| 任务结算          | 卡片转终态；`completed` 的结果由对话轮转述，或经 `forward_task_result` 原文发出 |


卡片的上下文渲染要补一行（状态 + 摘要，不含全文）——`renderOptions.renderCard` 目前对非 `run_changes` 的卡一律按 `approvalId` 查审批，不扩展会把任务卡渲染成「（审批记录已清理）」，这与 D71 委派卡遇到的是同一个坑。

**无声路由是禁止的。** 用户发出的新指令究竟进了哪条任务、还是另起了一条，必须在对话里看得见；否则这套机制比今天的无条件注入更让人不安。

## 5 并发与写互斥



### 5.1 规则

- **只读任务**：不取租约，受对话级与全局并发封顶。
- **写任务**：启动前取 `workdir` 根的写租约，**整个任务持有**（与 D72 外部 Agent 的 `pin` 语义一致）；取不到就停在 `submitted`，在卡片与 `<tasks>` 段中显示排队原因。
- **同一 workdir 同时最多一个写任务**，跨对话生效（D29 的语义不变，只是把适用面从 project 扩到 workspace）。
- 工具网关对 `task_writes=false` 的任务**硬拒写路径**（执行期校验，不只靠不注册工具）。



### 5.2 租约要扩到 workspace

今天 `#leaseTarget` 只认 project：不涉及 project 的路径直接抛「该路径不涉及 project，无需写入租约」（`packages/core/src/project/service.ts` `#leaseTarget`）。串行 mailbox 一直在替它兜底——自由对话里同一时刻只有一个 loop，所以 workspace 没有并发写。拆分后这个兜底消失，必须补：

- 新增租约键 `ws:{botId}:{conversationId}`，对应 `bots/{botId}/workspaces/{conversationId}/`。
- `waiting_lease` 状态、`lease.waiting` 事件、排队 UI 全部复用。
- workspace 没有影子仓库检查点（那是 project 的能力），所以 workspace 写任务被取消时只能给出「改了哪些文件」，**不提供整次回退**——这一点要在取消卡上如实说明，不要假装有回退。



### 5.3 为什么不是物理隔离

并行写同一目录的「正确」解法看起来是给每个任务一份独立工作区（worktree / CoW 克隆 / 拷贝）。本文**不走这条路**，理由见 §9.1。租约方案的取舍是明确的：

- 代价：两个写任务不能真并行，第二个排队。
- 收益：零新概念、不碰用户的 git、检查点与回退语义不变、三平台行为一致、没有归并步骤要设计。

而且**并行需求的大头本来是只读的**——研究、分析、读代码、review、查资料。D66 把后台子 agent 定成只读研究集不是偷懒，是同一个判断。先把「只读无限并行 + 写串行」做扎实，并行能力的收益已经拿到大部分。

## 6 消息、群聊与界面



### 6.1 谁是 Bot 的嘴

折中方案：**进度直达，结果经对话轮转述**。

| 出口 | 内容 | 规则 |
|---|---|---|
| 对话轮回复 | 「我开始处理 X 了」「这个我直接答你」「README 有 3 处过期，要改吗？」 | D48 不变；任务结果的正式交付只从这里出 |
| 任务中间说明 | 过程叙事（D54） | **直达可见流**，带任务归属（`origin: 'task'`）；护栏沿用（每任务直聊 8 条 / 群聊 4 条、单条 2000 字符截断） |
| 任务最终结果 | 这件事的交付物 | **不直接发给用户**：写入私有时间线 → 唤醒对话轮 → 对话轮结合历史决定转述、原文转发，或连同下一步一起说 |

**为什么结果要经对话轮**：对话轮是唯一看得到全局的一层——它知道用户这期间又说了什么、别的任务在干什么、这份结果是否回答了用户真正问的问题。结果直接发出，用户会看到两个声音（任务的交付 + 对话轮的衔接），必须靠「不要复述」这类事后补救指令压住重复；经对话轮转述则天然只有一个出口，不需要补救。

**为什么进度不经对话轮**：进度的价值在实时；每条进度都过一次对话轮，长任务会多出成倍的模型调用与延迟，换来的只是措辞统一。

**原文转发**：长报告、代码清单、表格这类结果，让对话轮重新生成既费输出 token 又可能失真。对话轮调用 `forward_task_result(task_id)`，宿主把结果条目全文作为一条可见消息发出（Bot 身份、带任务归属），对话轮的最终回复只写衔接（「详情如上，要我顺手改掉吗？」）。转不转发由对话轮决定，宿主不替它判断。

### 6.2 群聊

- 群轮次（D5「按顺序执行，后执行者能看到前者回复并可放弃」）在**对话轮**终态推进，不等任务。
- 取舍要显式记录：Bot A 的对话轮说完「我去查一下」就让位给 Bot B，此时 A 的任务还没出结果，B 看到的只是 A 的表态而非结论。这弱化了 D5 的「看到前者回复」语义。本文接受这个弱化——替代方案是群轮次等任务，那等于把阻塞搬回群聊。
- 任务不参与群轮次，不充当群成员（与 D66 / D71 一致）。
- **GX**：群里每个 Bot 的私有往返只进它自己的上下文（§2.4）；其他 Bot 看到的是它的任务进度与对话轮的转述——与真人在群里说「我去查一下」→「查到了，是这样」一致。



### 6.3 界面

- 对话内：任务卡（状态 + 进度行 + 取消）。
- 状态行（D55）：从「本对话唯一 run 的活动」变为「进行中任务的活动」；多任务时显示条数与最近活动，点击展开任务列表。
- Bot 详情栏 / 对话头部：进行中任务数。
- 执行记录页：任务与对话轮分列（`loop_type` 已有），任务详情显示 `origin_run_id` 与 `continues_task_id` 的链路。



## 7 对既有机制的影响



### 7.1 D56 Loop 续接：从「默认自动」改为「显式派活」

续接机制解决的是「上一轮的过程性上下文不进新 loop」。拆分后这个问题变形了：

- **对话轮之间**：对话轮只读、只沟通，过程性上下文都在任务里，对话层上下文（摘要 + 最近消息）+ `<tasks>` 段已经够用 → **自动续接（L1 窗口 + L2 仲裁）对对话轮关闭**。省掉每轮的回放预算与最坏 10s 的仲裁延迟。
- **任务之间**：改为**显式**——`start_task({continues_task_id})` 时按 D56 预算回放来源任务的 `run_steps`。任务是被派出来的，派活的时候就知道要不要接着上一条，不需要模型猜。
- 对话轮与任务的往返已作为私有条目留在时间线里（§2.4）：对话轮知道上次交代过什么、拿回了什么，这是它不再需要自动续接的另一半原因。
- `continued_from_run_ids` 落盘与反思去重注记不变。

这是对 D56 的实质修订，方向是让系统更可预测：回放只在被明确要求时发生。

### 7.2 反思与记忆（D-memory）

- 反思的主要输入 = **任务**的过程记录 + 该任务的私有往返（交代、追加、结果）+ 派出它的对话轮（用户原话在那里）。反思 job 在任务结算时登记；读私有条目时只读 owner Bot 自己的。
- 纯对话轮（没派活，例如闲聊里透露了偏好）仍需产生记忆：按去抖窗口登记，不是每轮一次——拆分后对话轮数量显著增加，逐轮反思会把后台队列压垮。
- D71 的既有约束不变：`origin=delegation` 的代发消息不作为用户证据。



### 7.3 授权与审批（D37 收紧）

- 对话轮只读 → 基本不触发审批。这是拆分的直接收益：**任务在等审批时，用户仍可以和 Bot 正常说话**。
- 审批卡仍绑任务 run。阻塞审批阻塞任务，不阻塞对话。
- **D37「仅这一次」的语义收紧**：今天 once-grant 随 run 结束才过期（`grants.expireForRun`），在 2 分钟的 run 里近似「一次」，在 3 小时的任务里就变成「整个任务一直允许」。改为：「仅这一次」= **单次工具调用**；需要整任务有效的用「本对话内一直允许」。另给一次性授权加绝对时限 `GRANT_ABSOLUTE_TTL_MS` 兜底。
- 无人值守（D41/D53）语义不变。



### 7.4 崩溃与恢复（D49/D67）


| 对象  | 规则                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------- |
| 对话轮 | ephemeral，崩溃 → `interrupted`，不自动恢复，重启后提示一次                                                                     |
| 任务  | 默认 ephemeral（同上）；可标 durable（D67 journal + 工具 replay）——**D67 的适用对象由「响应 run」改为「任务」**，这比原来更贴切：需要 journal 的本来就是长任务 |


启动恢复次序：

1. `running` 的对话轮与任务 → `interrupted`；被中断的任务**同一事务**写 `failure` 条目（§3.2）；
2. 释放写租约、取消挂起审批、撤销会话 token；
3. `submitted` 的任务重新排队；
4. 对账扫描「终态 AND `result_consumed_at IS NULL`」且应唤醒的任务，补投其结果 / 失败条目。



### 7.5 D58 对话内设置

- 任务因缺配置失败（结构化 `setup`）→ 设置卡在对话中呈现 → 完成后**重试该任务**（而不是重跑整个对话轮）。
- 对话轮自身因无可用模型失败的路径不变（无内置模型见 §8.4）。



## 8 外部智能体引擎（D72 的化简与约束）



### 8.1 对话轮固定内置，外部 Agent 作任务引擎

D72 现有的框架是「换掉 Bot 的整个 loop」，代价写在它的让渡表里（[28-external-agents-acp.md](28-external-agents-acp.md#1-可行性结论)）。拆分后外部 Agent 只负责「做事」，这更合身：


| D72 原让渡                    | D75 下                                                  |
| -------------------------- | ------------------------------------------------------ |
| `delegate_task`（D66）不提供    | **消失**：并行由宿主任务层提供，不依赖 Agent 自身能力                       |
| 每次请求前刷新系统提示词 → 降级为每 run 一次 | **仅任务内降级**；对话轮（人设 / 画像 / 记忆 / Wiki 目录 / Skills 注入）逐轮刷新 |
| durable 恢复不提供              | 不变（外部 Agent 任务一律 ephemeral）                            |
| 文件 / 命令工具让渡给 Agent 自身沙箱    | 不变（这是外部引擎的固有代价）                                        |
| 费用核算降级                     | 不变                                                     |
| 无 API key 用户的后台 loop       | 见 §8.4                                                 |


`runtime.agent` 的语义随之改变：从「这个 Bot 的引擎」变为「这个 Bot 的**任务引擎**」。设置界面文案与 D72 P4 的入口需同步。

### 8.2 provider 能力决定降级方式

外部 Agent 之间差异很大，任务层必须按 `provider.features` 分别处置，不能假装一致：


| 能力                                                              | 支持           | 不支持时                                                                                                             |
| --------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| steering（`_session/steering` + `idleBehavior:'promptRequired'`） | Claude、Codex | `inject_task` 返回 `queued`（沿用现有 pending steer，任务结束后生效）；对话轮据此可改用 `cancel_task` + `start_task({continues_task_id})` |
| 同进程并行会话（`features.parallelSessions`，D72 已加，按适配器源码实证取值） | 见 D72 适配矩阵「并行会话」列 | 该 Agent 在**全局**（跨 Bot、跨对话）只能有一个进行中的 prompt：`agent:{id}` 并发钳为 1，任务排队；不参与后台任务。注意「每会话同时只有一个 prompt」是所有 ACP Agent 的共性，按任务分会话（§8.5）后不再构成限制，真正的约束是同一进程能否同时服务多个会话 |
| 会话复用（`resume` / `load`）                                         | 见 D72 适配矩阵   | `cancel + restart` 只能新建会话                                                                                        |


`ExternalAgentEngine.steer()` 已在 D72 P5 落地（`_session/steering`，被拒 / 出错经 `onSteerRejected` 交还；prompt 发出前到达的消息并入下一个 prompt）。不支持 steering 的 Provider 同步返回 `false`，任务层据此走 `queued` 分支；异步拒绝走 `onSteerRejected`，任务层要把它映射为同一个 `queued` 结果。

### 8.3 取消与重启不是廉价操作

外部 Agent 的冷启动有实测代价（DeepSeek Harness npx 冷启约 77s / 约 760MB；Antigravity 安装体积约 1 GB，见 D72 适配矩阵）。因此：

- `cancel_task` → `session/cancel`，**不杀进程**；进程按 `AGENT_IDLE_SHUTDOWN_MS` 自行空闲退出。
- `start_task({continues_task_id})`：**新任务继承被取消 / 已结算任务的会话行**（§8.5）——旧任务释放后把该行的 `task_id` 改为新任务，指纹一致才复用，不一致或旧任务仍在释放则新建会话；不再是「按（Bot, 对话, Agent）找唯一会话」。
- 取消有时延，所以不提供「取消与启动原子化」的 `restart` 原语（§4.1）：新任务取租约时旧任务可能还在释放，排队语义已经正确处理了这个窗口。



### 8.4 没有内置模型的用户（D72 的原始动机）

这类用户拿不到通用 `base_url` / `api_key`，跑不了内置 pi 对话轮。两级降级，**明确是降级而非等价**：

1. **用** `backgroundAgentId` **的** `complete()` **跑对话轮**（D72 P6 的一次性精简会话）：对话轮的决策是结构化的、短的，适合这条路；代价是每轮一次会话冷启。
2. **关闭路由判断**：退化为「永远一个任务，新指令排队到任务结束」——等价于今天的行为，不多不少。

同一降级链也适用于群聊判断、摘要、反思等后台 loop（D72 P6 已有安排）。

### 8.5 外部 Agent 会话按任务分（修订 D72 的会话复用）

D72 P5 的会话复用是为**串行 run** 设计的：`agent_sessions` 唯一索引为 `(bot_id, conversation_id, agent_id)`（main 迁移 0017），设计 28 §7 规定「每个（Bot, 对话, Agent）至多一个会话」，`sessionKey = bot:conv:agent`（orchestrator 两处构造），桥 token、已见消息记录、保留会话匹配都挂在这个键上。D72 本身安全——邮箱保证同一（Bot, 对话）同时只有一个响应 run，后台 run 用一次性键（`bg:` / `complete:`）不进 `agent_sessions`。但任务并行后两个外部 Agent 任务会抢同一行：`AgentSessionsStore.upsert` 的 `on conflict (bot_id, conversation_id, agent_id)` 会让任务 B 覆盖任务 A 的行，`get(bot, conv, agent)` 的指纹复用会把任务 B 的增量塞进任务 A 的会话，已见记录与桥 token 也会串。因此：

- **键加任务**：`agent_sessions` 增加 `task_id`，唯一索引改为 `(bot_id, conversation_id, agent_id, task_id)`；`sessionKey = bot:conv:agent:task`。每个任务独占自己的会话、桥 token（`issueSessionToken` / `bindRun` / `revoke` 按新键）与已见记录（已按行 id 存，不变）。
- **不用并行槽位会话池**：池化会让不同任务的上下文在同一会话里接力，增量与已见记录失去「同一条任务谱系」的含义；只有 `continues_task_id` 这种显式接续才值得复用。
- **继承**：`start_task({continues_task_id})` 在旧任务释放后（D72 的「占有后才 await / 忙碌会话不可复用」已保证不会与旧任务并用）把旧行的 `task_id` 改为新任务（单条 `UPDATE … WHERE task_id = 旧`，失败即新建）；指纹不一致照旧新建。
- **生命周期**：任务结算后会话行保留 `CONTINUATION_WINDOW_MS` 供接续，超时由 reaper `session/close` + 删行；删除对话 / Bot / 移出群的级联已按行遍历（`listByConversation` / `listByBot` 逐行 `session/delete` + 删行），一对话多行无需改；进程崩溃仍保留行、下次 resume / load。
- **并发**：任务并发 = `min(TASK_CONCURRENCY_*, agent:{id} 并发)`；`agent:{id}` 并发缺省由 `features.parallelSessions` 决定（不支持 → 1，见 §8.2）。后台任务仍占 `agent:{id}` 槽位并为对话保留一个。
- **迁移**：项目早期不保留旧行（D72 期的行直接清空，下次新建会话）；迁移号与 D73（预留 main 0018–0020）协调。
- **改动面**：迁移、`domain/agent-sessions.ts`（`upsert` 冲突键、`get` 按任务）、orchestrator 两处 `sessionKey` 与 `#agentRunSetup` / `#recordAgentSession`、engine 的保留会话匹配与 `discardSession`、`mcp-bridge` 的 token 键、`lifecycle.ts`；估 **+0.5–1 周，计入 T5**。

## 9 非目标



### 9.1 git worktree 任务隔离（明确不做）

「每个任务一个 worktree」看起来能根治并行写。它确实把**物理竞争**转成**merge 冲突**（冲突变得可见、可审查、可延后），但在 KepCup 的具体约束下当不了默认方案，四条理由按严重性排列：

1. **它要写用户的** `.git`**，而这条底线已经画过并付过实现代价。** `git worktree add` 会在用户仓库的 `.git/worktrees/` 下建目录、建 ref/分支，并在新目录写 gitlink。而 [08-project.md](08-project.md#权限与保护) 规定 `.git/config`、`.git/hooks` 沙箱内不可写，`git init` / `git remote add` 这类改写 git 配置的操作必须由核心服务在沙箱外代为执行且**每次用户确认**（D31）；`packages/core/src/project/checkpoints.ts` 的影子仓库为了不往项目里写一个 gitlink，专门绕了 `noDotgitDir` + `core.worktree` 的弯，注释写明「Nothing is ever written inside the project itself」。worktree 不是加个功能，是推翻这条不变量。
2. **整套路径门禁锚在单个** `project.path` **上。** 沙箱读写挂载（`sandbox/policy.ts`）、网关路径判定、租约目标（`#leaseTarget`）、`protectRules` / `denyRead` 的 glob 拼接、bash 的 cwd——全部从 `boundProject(conversationId)` 的单一路径推导。worktree 在另一个路径，对这套栈来说就是「project 之外」：没有写挂载、没有租约、`denyRead` **规则不匹配**。最后一条是安全问题而非功能缺失：用户给 `.env` 配的 deny-read 在 worktree 副本上静默失效。要支持就得把「project = 一个路径」改造成「project = 一个身份 + 一组路径」，逐处改、逐处补测试，漏一处是一个洞。
3. **检查点与回退 UX 对不上。** 影子仓库是一个 project 一个、`core.worktree` 指向 `project.path`、per-project mutex 串行；`run_changes` 存影子仓库的 commit oid；改动摘要卡片 / 查看 diff / 整次回退都挂在 project 上。worktree 里的改动不进这套——用户看不见也退不了。要么每个 worktree 一个影子仓库（那「整次回退」退什么？worktree？归并结果？归并前的 project？），要么 worktree 任务没有检查点。
4. **新 worktree 开箱即废。** worktree 只有被跟踪的文件：`node_modules`、`.env`、本地配置、构建产物一个都没有，任务第一步就是 `pnpm install`（分钟级或直接失败），测试因缺 `.env` 跑不起来。更要紧的是 worktree 从某个 commit 起，**用户工作区里未提交的改动不在里面**——而「照着现在这个状态继续改」恰恰是最常见的请求。

次级问题：干扰用户自己的 git（分支已在别处 checkout 则 checkout 不了；崩溃后残留 `.git/worktrees` 需要 prune / reaper）；归并必须成为一等公民（谁解冲突、冲突时任务算成功还是失败、归并失败后 worktree 留还是删）。

**留的口子**：任务模型里有 `task_workdir`。日后若确实需要物理隔离，按「独立子目录 → worktree」的顺序作**独立决策**推进，只换 workdir 提供者 + 加一个归并步骤，不动执行模型。

### 9.2 CoW 目录克隆（不作为架构依赖）

`cp --reflink=auto` / APFS clonefile 能瞬时复制包含 `node_modules` 与未跟踪文件的完整工作区，且不碰 `.git`——比 worktree 更贴合需求。但它依赖文件系统：macOS APFS 原生支持，Linux 要 btrfs / XFS（ext4 不支持，WSL2 默认即 ext4），Windows NTFS 不支持。三平台一致性拿不到，因此只能作为**锦上添花的优化**，不能作为架构依赖。

### 9.3 其他

- 真·并行写同一目录（§5.3）。
- 任务依赖图、任务树面板、任务间通信（D66 已否决过同类）。
- 任务再派任务（深度 > 1）：需要链式结算语义，与 D71 单跳同理，超出本期。
- 对话轮跑外部 Agent（§8.4 的降级除外）。
- 把任务做成群成员或独立联系人——那是 D70 / D71 的事。
- 自动续接对话轮（§7.1）。



## 10 影响与修订清单



### 10.1 设计文档


| 文档                                                         | 需要的改动                                                                                                                                                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [02-execution.md](02-execution.md)                         | **实现期整篇重写**（本文为准）：「每一次响应都是一个独立 loop」整句替换；「并发：每个 Bot + 对话一个串行队列」改为「对话轮串行、任务并行」，并移除「串行队列是 workspace 不冲突的真正保证」这一论断（改由租约承担）；Loop 类型表新增 `turn` / `task`；「Bot 如何发消息」补任务出口（进度直达、结果经对话轮转述）；「上下文注入」加 `<tasks>` 段与私有时间线；「Loop 续接」按 §7.1 改写。本期先加修订指针 |
| [23-mcp-and-subagent.md](23-mcp-and-subagent.md)           | D66 定位修订：`delegate_task` 降为「任务内的嵌套子代理」；后台模式与 fan-out 的对话级锚点、并发计数、follow-up 结算职责移交任务层                                                                                                                                 |
| [27-butler-and-delegation.md](27-butler-and-delegation.md) | D70/D71 本身不变；补一句：`delegate_to_bot` / `cancel_delegation` / `propose_*` / `suggest_route` / `list_bots` 属于**对话轮**工具面；§3.5 投递闸门的「B 邮箱空闲」判定对象是 B 的对话轮                                                                   |
| [28-external-agents-acp.md](28-external-agents-acp.md)     | §1 让渡表三行修订（§8.1）；`runtime.agent` 语义改为任务引擎；P5 的 steering / 并发条目与任务层对齐；§7「每个（Bot, 对话, Agent）至多一个会话」改为按任务分会话 + `continues_task_id` 继承（§8.5）；`features.parallelSessions` 已在 D72 落地，任务层沿用；P6 的后台 loop 降级链补对话轮 |
| [24-durable-execution.md](24-durable-execution.md)         | D67 适用对象由「响应 run」改为「任务」                                                                                                                                                                                              |
| [04-memory.md](04-memory.md)                               | 反思登记时机（§7.2）                                                                                                                                                                                                         |
| [13-permissions.md](13-permissions.md)                     | D37「仅这一次」收紧为单次工具调用 + 绝对时限（§7.3）                                                                                                                                                                                      |
| [12-ui-layout.md](12-ui-layout.md)                         | 任务卡、任务列表、状态行语义（§6.3）                                                                                                                                                                                                 |
| [08-project.md](08-project.md)                             | D29 写租约适用面扩到 workspace（§5.2）                                                                                                                                                                                         |
| [01-conversation.md](01-conversation.md) | 「消息原则」扩展：`task_event` 私有条目（`owner_bot_id`）只进 owner Bot 的上下文；现有内部事务保持对话共享；所有读路径按视角过滤，对话摘要只摘共享行（§2.4） |


| `docs/dev/*` | 实现期同步：`02-architecture.md` 的接口块（`AgentEngine` / `RunSpec` / 新增 `TaskHost`）、`03-data-model.md` 的 `runs` 表与 `loop_type` 枚举、`04-agent-runtime.md` 的 loop 规范与提示词分段（新增对话轮版与 `<tasks>` 段）、`05-testing.md` 的任务层用例（结算对账、租约排队、只读任务拒写）；`DEVIATIONS.md` 记录实现偏差 |

### 10.2 代码（指路，不是改动清单）


| 位置                                                | 性质                                                                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/scheduler/mailbox.ts`          | **不变**——它正好就是对话轮串行器；`deliver` 的 steer 分支改为「交给下一个对话轮」                                                                                                                                           |
| `packages/core/src/dispatch/orchestrator.ts`      | `#startResponseRun` / `#executeResponseRun` 拆为 `#startTurn` / `#executeTurn` + 新的 `dispatch/tasks.ts`；`#steerRunningRun` 的目标从「本对话唯一的 run」变为「指定 task」                                           |
| `packages/core/src/agent/subagent.ts`             | `SubagentHost` 提升为 `TaskHost`（注册表 / 并发 / abort 入口已经是对的形状）；`delegate_task` 的后台模式退回父任务内的并行分支                                                                                                     |
| `packages/core/src/dispatch/delegation.ts`        | 状态机、settle 钩子、结果卡的**参照实现**（禁止复述 follow-up 不沿用） |
| `packages/core/src/project/service.ts`            | `#leaseTarget` 支持 workspace 键                                                                                                                                                                  |
| `packages/core/src/agent/external/engine.ts`      | `steer()`（D72 P5，已落地）的异步拒绝映射为 `queued`；保留会话匹配与 `discardSession` 按任务键（§8.5）；`features.parallelSessions`（D72 已加）决定 `agent:{id}` 并发 |
| `agent_sessions`（main 迁移）+ `domain/agent-sessions.ts` + `mcp-bridge.ts` + `domain/lifecycle.ts` | 加 `task_id`、唯一索引与 `upsert` 冲突键含任务；`sessionKey` / 桥 token 按任务键（删除级联已逐行处理，§8.5） |
| `packages/core/src/agent/context/continuation.ts` | 自动续接对对话轮关闭；`buildRunDigest` 改由 `start_task({continues_task_id})` 调用                                                                                                                            |
| runs 迁移                                           | `loop_type` 枚举（`response` → `turn`，新增 `task`）+ §3.4 新列                                                                                                                                         |
| main 迁移（`messages`） | 增 `owner_bot_id`；`kind` 增 `task_event`（重建表）；`messages_fts` 增 `owner_bot_id` UNINDEXED 列 |
| `packages/core/src/domain/messages.ts` | `list` → `listForBot(conversationId, botId)`；`listVisible` / `search` / `around` / `unsummarized` / 预览与未读按视角过滤；新增 `appendTaskEvent`（可在外部事务内调用，供终态同事务写入） |
| `packages/core/src/agent/context/conversation.ts` | `renderMessageLine` 增 `task_event` 与 `origin: 'task'` 分支；任务行截断；触发段全文 |
| `packages/core/src/tools/index.ts` | `search_messages` / `get_messages_around` 按 Bot 视角；对话轮新增 `forward_task_result` |
| `packages/core/src/agent/loops/conversation-summary.ts` | 只摘共享行 |
| shared types | `textContentSchema.origin` 增 `'task'`（+ `taskId`）；`messageKindSchema` 增 `task_event`；`TriggerBatch.reason` 增 `'task'` |
| shared constants                                  | `TURN_MAX_TURNS`、`TASK_CONCURRENCY_PER_CONVERSATION`、`TASK_CONCURRENCY_GLOBAL`、`TASK_START_MAX_PER_TURN`、`TASK_MAX_WALL_MS`、`TASK_TOKEN_BUDGET`、`TASK_SETTLE_SWEEP_MS`、`TASK_EVENT_CONTEXT_MAX_CHARS`、`GRANT_ABSOLUTE_TTL_MS` |


项目处在早期开发阶段，不需要向后兼容、不需要迁移旧数据，因此 `loop_type='response'` 直接改名而不保留别名。

## 11 实施顺序


| 阶段           | 内容                                                                       | 为什么在这个位置                 |
| ------------ | ------------------------------------------------------------------------ | ------------------------ |
| **T1 地基**    | `runs` 迁移、`messages` 迁移（`owner_bot_id` / `task_event`）、任务状态机、`submitted` 先落盘、终态 + 结果条目同事务、`result_consumed_at` 消费标记、启动对账、reaper | 可靠性先行：先保证「任务必有结算」，再谈谁来决策 |
| **T2 对话轮**   | `loop_type='turn'`、精简提示词、只读工具面（执行期校验）、`<tasks>` 段、四个任务管理工具 + `forward_task_result`；**按 Bot 视角的统一读法 + 多 Bot 泄露契约测试**、`task_event` 渲染、任务简报带原文（私有时间线约 +0.5–1 周，分摊在 T1/T2） | 有了地基才有可派的任务 |
| **T3 写互斥**   | 租约扩到 workspace、并发封顶、网关对只读任务硬拒写                                           | 并行开闸前必须先有互斥              |
| **T4 消息与界面** | 任务进度的归属标记与截断渲染、结果转述链路与条件唤醒、问题卡直注任务、任务卡 + `task.updated` 事件、状态行改造 | 用户可见面，依赖 T1–T3 的状态 |
| **T5 外部引擎**  | 外部 Agent 作任务引擎、**按任务分会话 + `continues_task_id` 继承（§8.5，+0.5–1 周）**、按 `features.parallelSessions` 定并发、steering 异步拒绝 → `queued`、§8.4 降级链    | 依赖 D72 P5；在宿主侧语义稳定后接     |
| **T6 文档与清理** | 02 整篇重写、D56/D66/D67/D37/D72 修订落字、`DEVIATIONS.md` 记录实现偏差                  | 收口                       |


每阶段的验收口径与改动清单在执行方案（`todo/supervisor-and-tasks.md`）中展开。

## 12 开放决策点

1. **对话轮是否允许** `web_search` **/** `web_fetch`：允许则「我先查一下再答你」不必起任务，体验更顺；但对话轮的时间预算会被不可控的网络调用撑开。倾向：允许，但计入 `TURN_MAX_TURNS` 且单轮最多一次。
2. **纯对话轮的反思去抖窗口取值**：对话轮数量显著增加后，逐轮反思不可行；窗口太长则偏好类记忆捕捉变慢。
3. **私有条目是否进入摘要**：本稿规定对话摘要只摘共享行，私有往返滑出最近窗口后靠任务登记与反思记忆。若长对话里对话轮频繁需要回看早期任务的往返，再考虑按（Bot, 对话）维护一份私有摘要。
4. **任务私有子目录（**`workspaces/{conv}/tasks/{id}/`**）是否在 T3 就提供**，还是等到确有并行写需求再加。倾向：先不提供，租约排队已经正确。
5. **对话轮的模型档位**：固定主模型，还是允许 Bot 配置为轻量模型（路由判断对模型要求不高，但对话轮要以 Bot 的人设说话）。倾向：主模型——它是对用户说话的那一层。
6. **`TASK_EVENT_CONTEXT_MAX_CHARS` 取值与触发段全文的硬顶**：超长结果（整份报告）进触发段也要有上限，超过时触发段给开头 + 摘要，并提示对话轮用 `forward_task_result` 原文转发。
