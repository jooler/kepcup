# 42 任务执行过程页

对话中的任务卡可以打开独立的执行过程页，按 Agent 消息列表的形式展示该任务的执行记录（`run_steps`）。

## 入口与层级

- 任务卡卡面（按钮、链接、输入控件以外）点击打开任务执行过程页；卡底的「查看执行过程 ›」按钮是同一入口，也是键盘入口（Enter / Space）。拖选卡片文字不会触发打开。
- 打开后主区的当前对话组件保留在 DOM 中，以 `display: none` 隐藏；任务执行过程页占用同一主区。右栏随对话组件一起隐藏。
- 顶部返回按钮或 Esc 返回对话，焦点回到触发入口（「查看执行过程」按钮）。切换会话（`chat.select`）、窄屏返回列表（`chat.leaveCurrent`）、关闭会话（`chat.close`）以及主区卸载（切工作台、窄屏换 tab、宽窄切换）都会关闭执行过程页，但不回焦。

实现位置：

- `apps/desktop/src/renderer/src/lib/stores/tasks.svelte.ts`：`openTaskId` / `openDetail(taskId, trigger)` / `closeDetail({ restoreFocus })`。
- `apps/desktop/src/renderer/src/lib/features/chats/ChatsArea.svelte`：对话子树 `display: none` 与 `TaskRunView` 的条件渲染。
- `apps/desktop/src/renderer/src/lib/features/tasks/TaskCard.svelte`：卡片点击与「查看执行过程」按钮入口。

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

## 消息列表

数据源是 `runs.steps` RPC（`RunStep[]`），按 `seq` 升序渲染。步骤到列表条目的映射：

| `RunStep.type` | 展示 |
|---|---|
| `assistant` | 助手说明，Markdown 渲染；空文本跳过；`errorMessage` 以错误行附在文本后 |
| `tool_call` | 工具调用行；与相同 `toolCallId` 的 `tool_result` 合并为一项 |
| `tool_result` | 合并到对应调用；没有匹配调用的结果单独成一项 |
| `progress` | 灰色单行进度，带圆点 |
| `steer` | 右对齐的「追加指令」气泡 |
| `system` | 灰色系统行 |
| `request` | 不展示（模型请求载荷） |

工具调用行：

- 折叠态显示工具名、一行摘要、结果首行预览与状态（执行中 / 完成 / 失败）。摘要优先用外部智能体的 `title`；否则按工具取参数：`bash` / `powershell` 用 `command`，`read` / `write` / `edit` 用 `path`，`ls` / `find` / `grep` 用 `path` / `pattern`，`browser_*` 用 `url` / `selector` / `ref` / `text` / `key`，`ask_user` 用 `question`，`send_message` 用 `text`，`capability_call` 用 `name` / `tool`；都不命中时取第一个字符串参数。
- 展开态显示格式化的参数 JSON 与完整结果文本（结果区最高 320px，内部滚动）；无输出、无返回、错误码分别标注。
- 失败的调用默认展开；用户手动折叠后保持手动状态。
- 同一次调用在运行中没有结果时显示「执行中」；任务已结束仍没有结果时显示为无结果。

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
| `apps/desktop/src/renderer/src/lib/features/tasks/TaskRunView.svelte` | 执行过程页外壳、顶部 metadata、步骤读取与实时刷新、时间线渲染 |
| `apps/desktop/src/renderer/src/lib/features/tasks/TaskRunToolCard.svelte` | 工具调用行（摘要、状态、参数 / 结果展开） |
| `apps/desktop/src/renderer/src/lib/features/tasks/task-run-view.ts` | 纯展示逻辑：步骤合并、工具摘要、参数格式化、用时格式化 |
| `apps/desktop/src/renderer/src/lib/features/tasks/task-run-view.test.ts` | 上述逻辑的单测 |

i18n 文案在 `apps/desktop/src/renderer/src/lib/i18n/locales/zh-CN.ts` 的 `task.run.*`。
