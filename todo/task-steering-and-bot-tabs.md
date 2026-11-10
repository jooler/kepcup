# 任务直注与 Bot 详情三栏 — 执行方案（D115/D116/D117）

> 设计：[docs/design/56-task-steering-and-bot-detail-tabs.md](../docs/design/56-task-steering-and-bot-detail-tabs.md)（D115–D117，以设计为准）。本文只规定**怎么做、怎么验收**。
> 状态：**代码已完成并全量收口**（2026-11-06，全量 7891 通过 / 0 失败；待真机验收）。

## 0. 先读什么

1. [docs/design/56-task-steering-and-bot-detail-tabs.md](../docs/design/56-task-steering-and-bot-detail-tabs.md)（权威设计）
2. [docs/design/30-supervisor-and-tasks.md](../docs/design/30-supervisor-and-tasks.md) §4.1（inject_task 契约与 D115 修订块）、§6.3
3. 现有代码：`packages/core/src/dispatch/tasks.ts`（`inject()` L777、`cancelById()` L883）、`packages/core/src/widgets/service.ts`（`cardOf()` L605、`publish()` L883）、`apps/desktop/src/renderer/src/lib/features/right-panel/RightPanel.svelte`、`features/tasks/TaskRunView.svelte`
4. [docs/dev/README.md](../docs/dev/README.md)、[docs/dev/05-testing.md](../docs/dev/05-testing.md#开发中如何跑测试)

## 硬约束

- **不改 `inject_task` 任何语义**：`injectById` 必须复用 `TaskHost.inject()`，状态分支（等问即回答 / steer / 入简报 / queued）与条目写入路径零改动。
- **不做组件双运行时**：iframe 运行时（WidgetRuntime / WidgetViewer）不动；直运行只经 `widgets.runCard` + 虚拟卡片登记表。审查门（`WIDGET_REVIEW_REQUIRED`）不得绕过。
- **右栏深链不回归**：`shell.rightPanelTabRequest`（'skills'/'schedules'）与 `shell.botPanelAnchor` 的落点行为不变（归位详情 tab 再下钻）；换 Bot 重置 tab。
- i18n 键 zh-CN / en-US 双语同步；新增交互元素全部带 `data-testid`。
- 改了 shared 契约 → 收口全量 `pnpm test` 一次（仅一次）。

## 1. 波次

| 波次 | 内容 | 依赖 |
|---|---|---|
| W0 | shared 契约：`tasks.inject` / `tasks.listByBot` / `widgets.runCard` 三组 schema + 契约 map 与方法列表登记 | — |
| W1 | core tasks：`TaskHost.injectById` / `listByBotViews`、`runs.listTasksByBotRecent`、bindings | W0 |
| W2 | core widgets：`runCard` + 虚拟卡片登记表 + `cardOf()` 虚拟分支、binding | W0 |
| W3 | 渲染层注入坞：`tasks` store `inject()`、`TaskInjectDock.svelte`、`TaskRunView` 接线、i18n | W1 |
| W4 | `RightPanel` 三 tab 重构 + `BotMenu` 瘦身（组件组移除） | — |
| W5 | `BotWidgetsTab.svelte`（卡片 + 直运行 + 「…」菜单 + 详情下钻）+ i18n | W2、W4 |
| W6 | `BotTasksPanel.svelte`（任务列表 + tab 进行中徽标）+ i18n | W1、W4 |
| W7 | 测试收口（定向 + 全量一次）+ PROGRESS.md | 全部 |

## 2. 各波次范围与验收

### W0 shared 契约
- `packages/shared/src/rpc/methods.ts`：
  - `tasksInjectInputSchema = { taskId, text: 1..TASK_INSTRUCTION_MAX_CHARS }`；`tasksInjectOutputSchema = { delivery: 'delivered'|'queued' }`。
  - `tasksListByBotInputSchema = { botId, limit?: 1..200 默认 100 }`；output `{ tasks: TaskView[] }`。
  - `widgetsRunCardInputSchema = { botId, widgetId, conversationId? }`；output `{ messageId, card: widgetCardSchema }`。
  - 契约 map（`'tasks.active'` 邻近、`'widgets.publish'` 邻近）与 app 方法列表三处登记。
- 验收：`pnpm --filter @kepcup/shared build` 通过。

### W1 core tasks
- `TaskHost.injectById(taskId, text)`：run 行缺失 / 非 task loop / `botId|conversationId` 为 null → `NOT_FOUND`；终态 → `RUN_ALREADY_FINISHED`；否则组装 identity 调 `inject()` 返回 `{delivery}`。
- `TaskHost.listByBotViews(botId, limit)`；`RunsRepo.listTasksByBotRecent(botId, limit)`（desc 查询，仿 `listByBotInConversation`）。
- bindings：`'tasks.inject'`、`'tasks.listByBot'`（`bindings.ts`，tasks.answer 邻近）。
- 验收：`node scripts/run-tests.mjs run packages/core/test/integration/tasks.test.ts`——新增断言：运行中任务 `injectById` → steer 步骤 + 条目；等问任务 → 问题卡回写回答；终态 → `RUN_ALREADY_FINISHED`；`listByBotViews` 跨对话返回该 Bot 全部任务且倒序。

### W2 core widgets
- `WidgetService.runCard({botId, widgetId, conversationId?})`：组件存在且属于该 Bot；scope='bot' 必传 conversationId、scope='conversation' 用自己的会话；latest_version 列投影（仿 `publish()`）+ `microAppCardFields` 构建卡；登记表键 `bot-widget:{widgetId}:{conversationId|none}` 幂等覆盖；返回 `{ messageId, card }`。
- `cardOf()` 先查登记表（命中返回 `{ id, conversationId }` 轻量消息形态）；`open/source/poster` 等不经修改即可用。
- binding：`'widgets.runCard'`（`widgets-ui-bindings.ts`）。
- 验收：widgets 服务集成测试——runCard 后 `open(虚拟 id)` 成功、带未审查查询模板抛 `WIDGET_REVIEW_REQUIRED`、`source(虚拟 id)` 审查后可 open、`prepareReply` 落 anchor 会话。

### W3 注入坞
- `lib/stores/tasks.svelte.ts`：`inject(taskId, text)` → `core.call('tasks.inject')`，返回 delivery（仿 `answer()`）。
- 新 `features/tasks/TaskInjectDock.svelte`：仅非终态渲染；Textarea（maxlength 8000）+ 发送钮；Enter 发送 / Shift+Enter 换行；awaiting_input 提示行；delivered → success toast、queued → warning toast、异常 → error toast；testid `task-run-inject` / `task-run-inject-input` / `task-run-inject-send`。
- `TaskRunView.svelte` 在提问卡条、审批条之后接线。
- i18n：`task.run.injectPlaceholder / injectSend / injectHintAwaiting / injectQueued / injectSent`。
- 验收：`node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/features/tasks/task-run-view.test.ts apps/desktop/src/renderer/src/lib/features/tasks/stores/tasks.svelte.test.ts`——源码契约锁注入坞接线、store action 分支。

### W4 RightPanel 三 tab
- `RightPanel.svelte`：`tab: 'detail'|'widgets'|'tasks'`（默认 'detail'）；头部资料卡下手写 tab 条（不用 `components/ui/tabs`）；`PanelDetail` 去掉 `widget` kind；换 Bot / 深链归位详情 tab；testid `right-panel-tab-{detail,widgets,tasks}`。
- `BotMenu.svelte`：移除组件动态组、widgets 拉取与 `onOpenWidget` prop。
- 验收：desktop typecheck + 相关组件测试；既有 e2e（bot-detail-back、schedules 深链）不回归。

### W5 组件 tab
- 新 `BotWidgetsTab.svelte`：`widgets.list` 卡片（Blocks 图标 + 标题 + v 版本 + 底部说明 section + 右上「…」下拉：发到当前对话 / 详情与管理 / 删除〔对话框确认〕）；点卡 → `widgets.runCard` → `widgetViewer.show()`；「详情与管理」→ tab 内下钻 `BotWidgetDetail`。
- 验收：组件测试 + e2e 冒烟（开 tab、运行组件覆盖层出现）。

### W6 任务 tab
- 新 `BotTasksPanel.svelte`：`tasks.listByBot` + `task.updated`（按 botId 过滤）续期；进行中 / 已完成分组行（状态徽标、标题、时间、写/只读、queueReason / 等输入提示）；点击 `tasks.openDetail(task.taskId, trigger, task.conversationId ?? undefined)`；空态。
- tab 触发器进行中数徽标。
- 验收：组件测试；e2e 冒烟（任务 tab 列表出现、点击进详情页）。

### W7 收口
- 定向：core tasks / widgets 集成、desktop tasks / right-panel 相关测试。
- typecheck：`pnpm --filter @kepcup/shared build && pnpm --filter @kepcup/core typecheck && pnpm --filter @kepcup/desktop typecheck`；eslint 干净。
- 全量 `pnpm test` **一次**（shared 契约变更）。
- PROGRESS.md 顶部表加行 + 文末记录小节。

## 3. 实施记录

- **W0–W2（2026-11-06）**：shared 契约三组 RPC（`tasks.inject` / `tasks.listByBot` /
  `widgets.runCard`）+ 契约 map 与 `APP_METHODS` 登记；core `TaskHost.injectById` /
  `listByBotViews`、`runs.listTasksByBotRecent`、`WidgetService.runCard` + 虚拟卡片
  登记表（`cardOf()` 虚拟分支，`open()` 改从 `cardOf` 的新返回形态取 messageId /
  conversationId）。定向：`widgets-service.test.ts` 53 例全绿（新增 runCard 两例）、
  `tasks.test.ts` 18 例全绿（新增 D115/D116 三例：直注 delivered + 条目 + 无对话消息、
  终态拒绝、跨对话倒序 + limit + 跨 Bot 隔离）。
- **W3–W6（2026-11-06）**：`tasks` store `inject()`；`TaskInjectDock.svelte`（Enter 发送 /
  awaiting 提示 / queued 未送达警示）接入 TaskRunView 最后一位；`RightPanel` 三 tab 重构
  （手写 pill tab，`PanelDetail` 去 widget kind，组件详情下钻移入组件 tab，深链归位详情
  tab）；`BotMenu` 移除组件组与 widgets 拉取；新 `BotWidgetsTab`（卡片直运行 + 底部说明
  section + 「…」下拉：发卡 / 详情与管理 / 删除对话框）与 `BotTasksPanel`（进行中 / 已完成
  分组，行点击 `openDetail`）；共享 `botTasks` store（`task.updated` 按 botId 续期，原位
  替换不打破倒序）；i18n zh/en 同步。定向：task-run-view（源码契约锁注入坞）/
  tasks.svelte store / bot-tasks store 测试全绿；desktop svelte-check 0 error；eslint 干净。
- **W7（2026-11-06）**：e2e `tasks.spec.ts` 新增「注入坞直注 → steer 气泡 → 三 tab 冒烟」
  全绿（连同既有 3 例共 4 例）；`schedules` / `bot-profile-autosave` / `narrow-layout`
  右栏敏感套件 6 例全绿。**踩坑记录**：e2e 首跑注入报「内部错误」——electron 主进程
  经 `externalizeDepsPlugin` 外置加载 `@kepcup/core` 的 **dist 产物**，dist 未重建导致新
  RPC 不存在；`pnpm --filter @kepcup/core build` 后重跑即绿（core 集成测试直接引源码，
  所以定向测试掩盖了这一点）。改 mock 脚本时注意 `llm.script()` 是整体替换，未消费的
  步骤要放进同一脚本。全量收口时 settings-catalog 覆盖扫描暴露三 tab 未入扫描：
  `scanSettingsUi` 把 RightPanel 的 `PANEL_TABS` 并入 `botPanelTabs`，排除表登记
  detail / widgets / tasks（替换原 widget 条目）后恢复。全量 `pnpm test`（shared 契约
  变更，一次）：**7891 通过 / 0 失败 / 48 跳过**；shared / core / desktop typecheck
  0 error、eslint 干净。验收状态见 [PROGRESS.md](../docs/dev/PROGRESS.md)。

## 5. 实测修正轮（2026-11-06，用户拍板精简）

- **组件 tab**：metadata 上卡、「…」下拉只留删除（对话框确认）、BotWidgetDetail 下线
  （微应用管理段无入口；发卡走 `widget_publish` 工具，RPC 保留）；孤立 i18n 键清理。
- **任务详情页只占中间对话区**：ChatsArea 收拢为「中间区三视图」snippet（对话 / 委派
  详情 / 任务详情），右栏常驻；42 / 27 §3.1 §3.2 / 56 §2 同步修订。
- **tab 条**：横向居中 + 图标（Info / Blocks / ListTodo）。
- **验证**：svelte-check 0 error、eslint 干净、定向单测 45 例全绿、e2e tasks 4 例（右栏
  可见断言）+ narrow-layout 2 例 + bot-profile-autosave 1 例全绿；无 shared 契约改动，
  未再跑全量。

## 6. 独立审查轮（2026-11-06）

两个独立子代理（core/契约、渲染层）并行审查，结论：无 P0、两 P1 + 五 P2，全部修复：
core `delete`/`deleteForBot` 摘除虚拟卡登记（P1）、覆盖层形态下任务 tab 行点击先收起
BotDetailOverlay（P1）、botTasks 换 Bot 清空 + upsert 合并（P1 + P2）、runCard anchor
会话存在校验与报错口径（P2）、回归测试补齐（删后 open / 审查门虚拟卡 / 错误码断言 /
injectById NOT_FOUND）、queued 中性文案（P2，56 §1.2 同步）、任务 tab 点击重拉（P2）、
注释与 shorthand 还原（P2）。验证：core 定向 73 例 + desktop 定向 45 例全绿，typecheck
0 error、eslint 干净，e2e 10 例全绿。

## 4. 偏差

（无）
