# 56 任务直注与 Bot 详情三栏

Bot 拉起的任务（D75）本质是一个 coding-agent session，但用户对它的掌控通道是间接的：自由文本只能发回对话、由 Bot 决定 `inject_task` 转交（不支持 steering 的外部 Agent 还会排队「未送达」），对任务列表也没有集中的视图。本篇补齐「掌控感」：用户在任务详情页直接插话；Bot 详情栏升级为三 tab（详情 / 组件 / 任务），任务 tab 集中列出该 Bot 拉起的所有任务并可直接打开；组件 tab 卡片化、点击直接运行组件本体。

决策：D115（任务直注）、D116（Bot 详情三栏 + 任务列表）、D117（组件直接运行）。执行方案与实施记录见 [todo/task-steering-and-bot-tabs.md](../../todo/task-steering-and-bot-tabs.md)。**已实施**（2026-11-06）。

相关：D75（任务机制，本文不改其任何语义，只加用户入口）、[30](30-supervisor-and-tasks.md) §4.1 / §6.3（用户直注入口修订；「Bot 详情栏进行中任务数」就此落实）、[42](42-task-run-view.md)（任务详情页新增注入坞）、[32](32-bot-widgets.md)（Bot 详情「组件」入口从菜单行升级为 tab 卡片直运行）、[12](12-ui-layout.md)（右栏结构）。

## 决策

- **D115 任务直注**：任务详情页对**非终态**任务提供注入坞（输入框 + 发送），经新 RPC `tasks.inject`（`{taskId, text ≤ TASK_INSTRUCTION_MAX_CHARS}` → `{delivery}`）直达 `TaskHost`。core 新增 `injectById(taskId, text)`：从 run 行取 `botId / conversationId` 组装 identity 后复用既有 `inject()`——等问即回答、运行中即 steer、未启动并入简报、外部 Agent 不支持返回 `queued`，全部语义零改动；注入条目照旧写 Bot 私有 `task_event`（Bot 因此感知用户插话）。终态任务抛 `RUN_ALREADY_FINISHED`（UI 隐藏注入坞）。用户直接注入是 `runs.cancel`（`cancelById`，userInitiated）之外第二个绕过对话轮的用户任务入口，不产生对话消息。
- **D116 Bot 详情三栏**：右栏 Bot 详情在头部资料卡下设三个 tab——**详情**（默认；原二级菜单，组件条目移出）、**组件**（D117）、**任务**；tab 条手写（`components/ui/tabs` 的 bits-ui `data-state` 与样式变体不匹配，沿用 ProjectTabs 的取向）。任务 tab 经新 RPC `tasks.listByBot`（`{botId, limit ≤ 200}` → `TaskView[]`，created_at 倒序，跨对话全集）列出该 Bot 拉起的所有任务，分「进行中 / 已完成」两组；行点击经既有 `tasks.openDetail` 打开任务详情页（归属其它对话的任务同样可开，详情页已有 homeSession 归属映射）；tab 触发器显示进行中数量。这落实 30 §6.3 的「Bot 详情栏进行中任务数」与「执行记录页」的任务部分（对话轮分列不在本期）。用户手动创建任务（在 Bot 名下新建 session）本期不做，待需求验证后再议。
- **D117 组件直接运行**：组件 tab 的条目是**组件卡片**（无分组标题；底部说明 section 展示 `description`；右上「…」下拉：发到当前对话 / 详情与管理 / 删除）。点击卡片**直接运行组件本体**——新 RPC `widgets.runCard`（`{botId, widgetId, conversationId?}` → `{messageId, card}`）：core 以 publish 同款列投影构建卡片描述符（**不落消息行**），存入内存**虚拟卡片登记表**（合成 id `bot-widget:{widgetId}:{conversationId|none}`），`cardOf()` 先查登记表。于是既有链路全部在无消息卡场景下自然工作：`open`（挂载 / 审查门 / 生效版本）、`source`（查看源码审查）、`poster`、`storage`（命名空间 = widgetId）、`query`（版本模板）、`reply`（落 anchor 对话）与新窗口打开（载荷 `{messageId, card}`，窗口内再解析走登记表）。iframe 运行时（WidgetRuntime / WidgetViewer）零改动——不做双运行时。scope='bot' 的组件 anchor 到当前对话（回复落进去）；scope='conversation' 的组件 anchor 到它自己的对话。

## 1 任务直注（D115）

### 1.1 入口与可见性

- 注入坞固定在任务详情页最底部（提问卡、审批条之下，最后一位），仅非终态任务渲染（`isActiveTask`：submitted / running，含等待审批 / 等租约 / 等提问的运行中形态）。
- 任务在等提问（`awaiting_input`）时注入坞照常可用，且显示提示行「任务在等你回答：发送的内容将作为回答」——与提问卡并存，自由文本走注入（`inject()` 内部转 `#resolveQuestion`），结构化选项走提问卡。
- 文本上限 `TASK_INSTRUCTION_MAX_CHARS`（8000）；Enter 发送、Shift+Enter 换行。
- **输入组件直接复用对话的 `Composer`**（用户要求「直接复用 Bot 对话组件中的输入组件」，不再自带 Textarea）：`<Composer injectTaskId={taskId}>` 的注入模式，上下文隔离判定收敛在 `features/chats/composer-inject.ts` 的纯函数里。
  - 不进会话：不读 `chatSession` 的 replyTo / 协作 presence / 共享草稿 / 撤回回填 / `composerInsertion`，不注册 `@` 提及与「选择文件」动作项；草稿用独立键 `task:<taskId>`（与 `conversationId` 同库不同键，互不串台），任务切换靠 `{#key taskId}` 重挂载（编辑器扩展集在挂载时确定）。
  - 右侧按钮位：录音胶囊 > 空输入的语音键 > 发送键。输入为空显示语音键（点击采集→转写填入）；有内容显示发送键；`asr` 能力未就绪时不显示语音键，直接给发送键且空输入时禁用。**不提供语音对话模式**（Speech 入口 / 播报 / barge-in 在注入模式下不渲染）。
  - `+` 附件键保留但禁用：`tasks.inject` 只收文本，附件无处可放，悬停说明「追加指令暂不支持附件」（要支持需先扩 RPC 与 TaskHost）。
  - 文本上限仍为 `TASK_INSTRUCTION_MAX_CHARS`，由编辑器层 `CharacterCount({ limit })` 拦截（等价旧 Textarea 的 `maxlength`）；Enter 发送、Shift+Enter 换行、IME 组字不抢 Enter、发送中防重入、失败回填均沿用 Composer 既有实现。

### 1.2 结果反馈

- `delivery='delivered'`：toast「已追加到任务」；运行中任务的时间线随即出现右对齐「追加指令」气泡（既有 steer 行），未启动的任务并入简报（启动后可见）。
- `delivery='queued'`：toast 警示「未送达：这条指令将在任务结束后生效」。queued 有两种成因（外部 Agent 拒绝 steer / 任务已在收尾），`task_event` 条目只存二值 delivery、渲染端无法区分，故用中性文案（两种成因下「任务结束后生效」都成立；任务卡注入行的「未送达」是既有口径，不动）。
- 失败（任务刚好结算等）toast 错误原文。

### 1.3 RPC

- `tasks.inject`：input `{ taskId, text (1..8000) }`，output `{ delivery: 'delivered' | 'queued' }`。binding 调 `orchestrator.tasks.injectById(taskId, text)`。任务不存在 / 非 task loop / 无 Bot 上下文 → `NOT_FOUND`；终态 → `RUN_ALREADY_FINISHED`。
- `tasks.listByBot`（D116）：input `{ botId, limit? (默认 100，≤200) }`，output `{ tasks: TaskView[] }`。domain 新增 `listTasksByBotRecent(botId, limit)`（`loop_type='task' and bot_id=?`，created_at desc）；`TaskHost.listByBotViews` 逐行 `view()`。

## 2 Bot 详情三栏（D116）

- tab 条在头部资料卡（头像 / 名称 / 简介，点按直编不变）之下，**横向居中**，每项带图标（详情 = Info、组件 = Blocks、任务 = ListTodo）；三个 tab 共用下钻状态机：**详情** tab 承载原 `PanelDetail`（去掉 `widget` kind，配置条目 / 记忆 / Skills / Wiki / 授权 / 定时 / 监看的下钻行为不变，含 `EgressSummary`）；**组件** tab 无下钻（2026-11-06 精简，见 §3.2）；**任务** tab 无下钻（点击任务开主区详情页，右栏不动）。
- 深链兼容：`shell.rightPanelTabRequest`（'skills' / 'schedules'）与 `shell.botPanelAnchor`（设置卡锚点）一律归位**详情** tab 再下钻；换 Bot 时 tab 回默认。
- 任务列表行：状态徽标（复用 `task.state.*` 文案与配色）、标题（空标题回退任务 id）、创建时间、写 / 只读标记；进行中的行内联 `queueReason` / 等输入提示。`task.updated` 事件按 `botId` 过滤续期，tab 激活时重拉。
- 任务详情页的占位（D116 修订）：任务详情与委派详情视图同属**中间对话区视图**——只替换对话区（中间 pane），**右栏保持可见**；窄屏仍是全屏详情层（42 号「布局」同步修订）。

## 3 组件直接运行（D117）

### 3.1 core：虚拟卡片登记表

- `runCard({botId, widgetId, conversationId?})`：组件必须存在且属于该 Bot；scope='bot' 时 `conversationId` 必传（anchor = 发卡落点），scope='conversation' 时用组件自己的会话；生效版本解析与 publish 同款（latest_version 列投影 + `microAppCardFields`）。登记表以合成 id 为键（同键幂等覆盖），返回 `{ messageId, card }`。
- `cardOf(messageId)`：先查登记表（命中返回轻量 `{ id, conversationId }` 形态的消息），未命中走原消息卡路径。core 重启即失效，渲染端每次点击现调 `runCard` 再展示，天然自愈。
- 审查门不变：带未审查查询模板的版本 `open` 照抛 `WIDGET_REVIEW_REQUIRED`，渲染端「查看源码」走 `source(虚拟 id)` 完成审查后重试。

### 3.2 渲染端：组件卡片

- 卡片：标题行（Blocks 图标 + 标题 + scope 徽标）+ **metadata 行**（`v{version}` · 版本数 · 体积 · 更新时间 · 查询模板数〔>0 时〕· 自检状态——2026-11-06 精简：原组件详情页的信息行移到卡片上）+ 底部说明 section（`description`，空则整段不渲染）+ 右上「…」下拉菜单。
- 点击卡片主体 → `widgets.runCard` → `widgetViewer.show(messageId, card, conversationId)`（既有全局组件覆盖层，切会话自动关闭）。
- 「…」下拉只留**删除**（对话框确认后 `widgets.delete`；2026-11-06 精简：原「发到当前对话」「详情与管理」移除——组件详情页 `BotWidgetDetail` 仅比卡片多 metadata 与微应用管理段，随精简下线；发卡仍可由 Bot 经 `widget_publish` 工具发起，`widgets.publish` RPC 保留）。

## 4 实现位置

- 契约：`packages/shared/src/rpc/methods.ts`（tasksInject / tasksListByBot / widgetsRunCard 三组 schema 与登记）。
- core：`packages/core/src/dispatch/tasks.ts`（injectById / listByBotViews）、`packages/core/src/domain/runs.ts`（listTasksByBotRecent）、`packages/core/src/widgets/service.ts`（runCard + 虚拟登记表）、`packages/core/src/rpc/bindings.ts` 与 `packages/core/src/rpc/widgets-ui-bindings.ts`。
- 渲染层：`apps/desktop/src/renderer/src/lib/features/tasks/TaskRunView.svelte` + 新 `TaskInjectDock.svelte`、`lib/stores/tasks.svelte.ts`；`lib/features/right-panel/RightPanel.svelte`（tab 重构）、`BotMenu.svelte`（移除组件组）、新 `BotWidgetsTab.svelte`、新 `BotTasksPanel.svelte`。
- 文案：`lib/i18n/locales/zh-CN.ts` 与 `en-US.ts`（`task.run.inject*`、`rightPanel.tab*` 与任务列表键、`widgetsTab` 卡片键）。
