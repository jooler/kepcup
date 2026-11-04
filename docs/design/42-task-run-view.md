# 42 任务详情页（执行报告 + 执行过程）

对话中的任务卡可以打开独立的任务详情页：顶部是折叠的「执行过程」（按 Agent 消息列表的形式展示 `run_steps`），下方直接展示该任务的**执行报告**（终态条目原文）。2026-11 修订：执行报告只在这里阅读，对话里不再转发原文（[30 §6.1](30-supervisor-and-tasks.md)），已完成的任务卡入口文案改为「任务已完成，点击查看执行报告」。

## 入口与层级

- 任务卡卡面（按钮、链接、输入控件以外）点击打开任务详情页；卡底入口是同一入口，也是键盘入口（Enter / Space）：已完成的任务显示「任务已完成，点击查看执行报告」，其余状态显示「查看执行过程 ›」。拖选卡片文字不会触发打开。
- 打开后主区的当前对话组件保留在 DOM 中，以 `display: none` 隐藏；任务执行过程页占用同一主区。右栏随对话组件一起隐藏。
- 顶部返回按钮或 Esc 返回对话，焦点回到触发入口（卡底按钮）。任务详情页**按会话记忆**：切换会话（`chat.select`）只切到目标会话自己的页面（它没有打开任务页时显示消息列表），离开的会话保留原页面，切回来原地恢复、不再回到消息列表。显式返回（返回按钮 / Esc）才丢弃该会话的记忆；关闭会话（`chat.close`，含删除会话 / 删除 Bot）一并丢弃。窄屏返回列表（`chat.leaveCurrent`）与主区卸载（切工作台、窄屏换 tab、宽窄切换）只退出可见层、不丢弃记忆，重新进入该会话时恢复。除显式返回外都不回焦。

实现位置：

- `apps/desktop/src/renderer/src/lib/stores/tasks.svelte.ts`：`openTaskId` / `openDetail(taskId, trigger, conversationId)` / `enterConversation(conversationId)` / `forgetConversation(conversationId)` / `closeDetail({ restoreFocus })`（按会话记忆的执行过程页）。
- `apps/desktop/src/renderer/src/lib/features/chats/ChatsArea.svelte`：对话子树 `display: none` 与 `TaskRunView` 的条件渲染。
- `apps/desktop/src/renderer/src/lib/features/tasks/TaskCard.svelte`：卡片点击与卡底入口按钮（已完成任务的文案见上）。

## 顶部信息

标题行：任务名（来自 `TaskView.title`）与状态徽标（排队中 / 进行中 / 已完成 / 失败 / 已取消 / 已中断）。左侧是返回按钮。

metadata 行按可用字段展示：

- 所属 Bot 名称（项目组内为任务归属的 Bot）。
- 开始时间（未启动时用创建时间）。
- 用时：进行中每秒刷新，结束后固定为 `endedAt - startedAt`（未启动时从 `createdAt` 算起）。
- 执行根：工作目录（`cwdKind='workdir'`）或工作区（`cwdKind='workspace'`）。
- 写任务 / 只读任务（`TaskView.writes`）。
- 任务 id。
- 声明的外部能力 id（`TaskView.capabilities`，非空时）。

标题下方另有一条状态提示，按优先级显示：排队原因（`queueReason`）、等待用户回答（`awaitingInput`）、失败 / 中断错误（`error`）、取消原因（`cancelReason`）、最近进度（`lastProgress`）。没有内容时不渲染。

## 执行计划（D93）

内置 pi 任务可以调用 `update_plan`（[43-task-loop-harness.md](43-task-loop-harness.md)）。有计划的执行过程页在顶部信息右侧显示绿色「任务清单」按钮，清单内容放在点击展开的浮层里（不再占正文顶部的固定区块）：

- 数据来源是 `runs.steps` 里最后一个 `tool_call.toolName === 'update_plan'` 的 `args.plan`，不新增 RPC 或数据库字段；
- 按钮显示「任务清单」与完成进度（`已完成 / 总数`）；窄屏只留图标与进度，把宽度让给标题；
- 浮层宽度 20rem、右对齐按钮、内容超过 60vh 时内部滚动；每项按 `completed` / `in_progress` / `pending` 显示状态，长条目换行显示，有 `explanation` 时在末尾补一段说明；
- 浮层用 bits-ui Popover（portal 到 body，不会被 header 裁切），内容只读、不参与键盘焦点；
- 任务运行中随现有事件 / 轮询刷新，浮层打开时内容跟着更新；没有计划时不渲染任何入口；
- 任务卡卡面不新增字段：`update_plan` 的 progress 事件已让卡面最近进度显示「计划 x/y：…」。

外部智能体任务的原生 `plan` 更新当前仍映射为 `progress` 行（见 `外部智能体引擎` 的 `plan → progress`），不进入本计划区；如需统一结构，后续在 ACP 事件映射里归一化。

## 审批卡（权限请求）

任务执行中触发权限请求时，卡片照常进入对话输入坞上方的 ApprovalDock；但执行过程页打开期间原对话以 `display:none` 隐藏，任务停在 `waiting_approval` 时用户在页内毫无感知。因此执行过程页在时间线下方固定渲染同一会话的 ApprovalDock（`task-run-approvals`）：

- 卡片与对话完全同源（`permissions` store 的 pending 列表），可直接在页内批准 / 拒绝，任务随之继续；没有待审批时不渲染，页面布局不变。
- 会话取 `TaskView.conversationId`，任务视图未读到时回退当前会话（`approvalConversationIdOf`；详情页只属于打开它的会话，切到别的会话时不会渲染）。
- 打开详情页时补拉一次会话审批（`permissions.reloadApprovals`，只并入审批记录、不动右栏数据），覆盖连接中断期间错过的事件。
- 焦点与键盘：打开详情页时已有待审批卡、或新卡到达时，焦点交给队首卡片（与对话一致；此时返回键不抢焦点）；卡片聚焦时 Esc 先被卡片消费（拒绝），不会误退详情页。

## 任务提问卡（ask_user）

任务用 `ask_user` 提问时，提问卡是会话里的一条 `task_question` 系统事件消息（不在 `run_steps` 里）；执行过程页打开期间对话被隐藏，提问同样会在页内消失。与审批卡同一思路，执行过程页在时间线下方（审批条之上）固定渲染该任务未答的提问卡（`task-run-question`）：

- 数据源是当前会话 session 的 messages（主页面回退 `chat.main`，卡片弹层是弹层自己的 ChatSession），经 `pendingTaskQuestionOf(messages, taskId)` 取该任务绑定、`content.answer` 尚未回写的最新一条；`message.created` / `message.updated` 事件保持与对话同源实时。
- 卡片复用对话里的 `TaskQuestionCard`，点选 / 多选 / 表单回答直接注入任务（`tasks.answer`），答完卡带上 `answer`，提问条随之收起；没有未答提问或任务已终态（提问作废，时间线里有终态说明）时不渲染。
- core 保证一个任务同时最多一个未答问题（上一个没答时 `ask_user` 直接拒绝），提问条至多一张卡。

## 执行报告

数据源是 `TaskView.result`（`tasks.get` / `task.updated` 下发，取自该任务的私有终态条目）：`{ text, status }`，未结算为 null。渲染在正文下部、执行过程折叠区之下：

- 有非空文本时显示「执行报告」区块，正文按 Markdown 渲染（`Markdown.svelte`）。
- 运行中 / 未结算没有报告，不渲染该区块。
- 报告正文不进 Bot 上下文；对话轮只依据触发段里的私有结果条目写高度总结。

## 执行过程

执行过程整体折叠在「执行过程」标题行下（`task-run-process`）：

- 运行中的任务默认展开——实时进度就是主内容；已结算的任务默认折叠，页面一打开先看到执行报告。展开状态在首次读到任务视图时定格，之后不随终态翻转（正在看运行中任务的人不会在结算时被打断），用户可随时点标题行展开 / 收起。
- 数据源是 `runs.steps` RPC（`RunStep[]`），按 `seq` 升序渲染。步骤到列表条目的映射：

| `RunStep.type` | 展示 |
|---|---|
| `assistant` | 助手说明，Markdown 渲染；`thinking` 非空时在正文上方折叠成一行「思考」；空文本但有思考的轮次也保留；`errorMessage` 以错误行附在文本后 |
| `tool_call` | 工具调用行；与相同 `toolCallId` 的 `tool_result` 合并为一项 |
| `tool_result` | 合并到对应调用；没有匹配调用的结果单独成一项 |
| `progress` | 有意义的进度（计划 / 上下文压缩 / 子任务），灰色单行；工具执行状态（「正在执行命令 …」）只走状态行，不展示 |
| `steer` | 右对齐的「追加指令」气泡 |
| `system` | 灰色系统行 |
| `request` | 不展示（模型请求载荷） |

思考内容：

- 内置 pi 的思考块与外部智能体的 `agent_thought_chunk` 都写入该轮 `assistant` 步骤的 `thinking` 字段（与文本一起落库；子代理的思考不落库）。
- 折叠态只显示一行「思考」，点开显示原始推理文本（灰字、保留换行）；默认折叠，避免长推理淹没对话。

工具调用卡：

- **连续**的工具调用合并成一张卡（助手说明、追加指令、有意义的进度、系统行会打断分组）；组标题显示调用数量与失败数量，运行中带 spinner。
- 工具执行期间的自动提示（`ToolContext.progress`，如「正在执行命令 …」「正在编辑 …」）只更新状态行（`run.progress` / `lastProgress`），不写入 `run_steps`；旧 run 里残留的这类 `progress` 步骤在读取时间线时按「正在」前缀隐藏，因此不会打断工具分组。
- 组内每行是「动词 + 操作目标」（`toolRowDisplay`）：
  - 外部智能体优先用自带的 `title`（如 `Edited types.ts`、`Read a.ts (50-99)`），按第一个空格拆成动词（降低亮度）与目标（正常亮度）；
  - 内置 pi 工具归一化：`read` → 读取 + `path`；`write` → 写入 + `path`（+新增行数）；`edit` → 编辑 + `path`（+新增 / 删除行数）；`ls` / `find` / `grep` → 列出 / 查找 / 搜索 + 路径或 pattern；`bash` / `powershell` → 执行 + 完整命令（等宽）；`browser_*` 按动作映射打开 / 点击 / 输入等；`ask_user` / `send_message` / `update_plan` / `capability_call` 各有固定动词；其余工具用工具名 + 摘要。
  - 文件编辑的 `+新增 / −删除` 行数：内置 `edit` 从 `args.edits[].oldText/newText` 按行做 LCS 计算，`write` 按内容行数计新增；外部智能体从 ACP `tool_call_update` 的 diff 内容计算并随 `tool_result.diffStats` 落库。目标文字保持高亮度，动词减半，增删行数用绿 / 红小字。
- 点行展开该次调用的独立卡片：上方是原始命令（shell 工具取完整 `command`，其余工具回退为格式化参数；hover 时右上角出现复制按钮），下方直接展示完整结果（最高 320px，内部滚动）；无输出、无返回、错误码分别标注。
- 失败的调用默认展开；用户手动折叠后保持手动状态。分组整体可折叠，默认展开。

其他状态：

- 首次读取中显示加载行；读取失败、任务不存在（且没有步骤）、或还没有任何步骤时显示对应空态。任务视图缺失但步骤已读取时仍展示时间线，标题回退为「任务 id」。
- 任务进行中时，列表末尾显示「实时更新」行；终态后不显示。
- 列表接近底部时跟随新步骤滚动；用户上滚后停止跟随，回到底部后恢复。

## 实时更新

- 事件：本任务的 `run.progress`、`run.status` 与 `task.updated` 到达后，防抖 180ms 重读 `runs.steps`。
- 轮询：任务处于 `submitted` / `running` 时每 1.2s 重读一次；进入终态后停止，终态事件仍会触发最后一次读取。
- 只读取当前打开任务的步骤；任务视图继续由 `tasks.byId` 缓存更新。

## 布局

- 宽屏：执行过程页占满原对话区（含原本右栏的位置），内容区居中，最大宽度与消息列表一致（`max-w-3xl`）。
- 窄屏：沿用窄屏详情层——占满详情区、不渲染底部 tab 栏；macOS 下顶栏为红绿灯留出左侧空间。
- 顶部为拖动区（`app-drag`），返回按钮等交互元素为 `app-no-drag`。

## 代码位置

| 文件 | 内容 |
|---|---|
| `apps/desktop/src/renderer/src/lib/features/tasks/TaskRunView.svelte` | 执行过程页外壳、顶部 metadata、步骤读取与实时刷新、时间线渲染、提问卡条、审批卡条 |
| `apps/desktop/src/renderer/src/lib/features/tasks/TaskPlanPanel.svelte` | D93 计划入口：右上角绿色「任务清单」按钮 + 浮层（`update_plan` 的最新计划；完成计数、只读清单） |
| `apps/desktop/src/renderer/src/lib/features/tasks/TaskRunToolGroup.svelte` | 连续工具调用的分组卡：标题计数、单行命令条目、逐条展开 |
| `apps/desktop/src/renderer/src/lib/features/tasks/TaskRunToolCard.svelte` | 展开后的单次调用卡：原始命令 + hover 复制按钮 + 结果 |
| `apps/desktop/src/renderer/src/lib/features/tasks/task-run-view.ts` | 纯展示逻辑：步骤合并、连续工具分组、思考 / 工具摘要、参数格式化、用时格式化、审批条会话回退、待答提问卡筛选 |
| `apps/desktop/src/renderer/src/lib/features/tasks/task-run-view.test.ts` | 上述逻辑的单测 |

i18n 文案在 `apps/desktop/src/renderer/src/lib/i18n/locales/zh-CN.ts` 的 `task.run.*`。
