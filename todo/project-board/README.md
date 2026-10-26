# 项目组看板（Board）实施编排 · 总览

> 状态：**已实施**（2026-10-26。设计 [docs/design/50-project-board.md](../../docs/design/50-project-board.md)，决策 **D103**；Q1–Q9 按推荐，仅 Q4 改为 `svelte-dnd-action`）。
> 本目录是给**执行智能体**的任务书，分**三个阶段**，每阶段一份。**先读本文件，再读你被分配的那一阶段。**
> 早期阶段：不做向后兼容、不迁旧数据；一切以语义准确、逻辑正确为准。

| 阶段 | 文件 | 设计里的 WP | 交付 |
|---|---|---|---|
| 阶段一 | [P1-board-skeleton.md](P1-board-skeleton.md) | WP1 + WP3 | 可用的单看板（思路工具）：分栏 / 卡片增删改拖、行内编辑、最小卡片弹框（编辑文本）；没有执行能力 |
| 阶段二 | [P2-card-conversation.md](P2-card-conversation.md) | WP0 + WP2 | `ChatSession` 抽取（渲染层，行为中性）+ `card` 会话 + 项目作用域 + 指派 / 排期 / 派发后端；无新入口，集成测试验证 |
| 阶段三 | [P3-card-dialog.md](P3-card-dialog.md) | WP4 + WP5 | 完整卡片弹框（对话、执行成员、时间、状态）、徽标、通知深链、`schedules.list` 聚合卡片排期（小改）、e2e、文档同步 |

## 0. 一句话目标

在项目组里新增「看板」模块：用户梳理思路（单看板、自由分栏、卡片增删改拖），并可把卡片指派给项目里的一位 Bot 成员、配上执行时间 / 周期；每张已指派的卡片有一条专属的**卡片对话**（隐藏会话类型 `card`），用于与执行成员讨论、执行、交付与追踪。卡片 = D90 事项 + 看板侧表；分栏与执行状态正交。

## 1. 给执行智能体的规则（必读，违反任何一条都会返工）

### 1.1 阅读顺序

1. 本文件（尤其 §4「固定契约」）。
2. 你的阶段文件。
3. 阶段文件里「必读」列出的设计章节与源码。
4. [AGENTS.md](../../AGENTS.md)、[docs/dev/01-conventions.md](../../docs/dev/01-conventions.md)、[docs/dev/05-testing.md](../../docs/dev/05-testing.md#开发中如何跑测试)。
5. 相关既有任务书的体例与做法（可参考，不是依据）：[todo/project/](../project/README.md)。

### 1.2 不得自行决定的事

- **所有标识符名称**（表名、列名、索引名、类型名、RPC 方法名、事件名、错误码、常量名、文件名、`data-testid`、i18n key 前缀）以 §4 为准，**一个字母都不要改**。§4 没写到的新名字，按相邻已有命名风格取，并在你阶段末尾「实施记录」登记。
- **行为**以阶段文件与设计 50 为准。阶段文件与 50 冲突 → 以阶段文件为准（更晚、更具体），同时在 [DEVIATIONS](../../docs/dev/DEVIATIONS.md) 记一条（编号接当前最大编号递增）。
- 设计 50 §2 的九项决策已定，**不要重新讨论**；尤其：卡片 = 事项 + 侧表（Q1）、新会话类型 `card`（Q2）、分栏与状态解耦（Q3）、`svelte-dnd-action`（Q4）、卡面只读（Q5）、不做路径作用域写租约（Q6）、本期只有用户写看板（Q7）、硬删 + 确认（Q8）、卡片对话视同项目口径（Q9）。

### 1.3 你有自由度的地方

- 函数内部实现、私有辅助函数命名、测试夹具写法、文件内代码组织（遵循相邻代码风格）。
- 阶段文件里写「由你核对 / 由你判断」的地方——必须在实施记录写下判断依据。

### 1.4 测试规则（AGENTS.md 的具体化）

- **迭代中只跑相关测试**：`node scripts/run-tests.mjs run <测试文件或目录>`（可加 `-t "用例名"`）；单包 `pnpm --filter @kepcup/<包> test`；desktop 单测 `node scripts/run-tests.mjs run --project desktop`。
- 类型检查：`pnpm --filter @kepcup/shared|core|desktop typecheck`。**改了 shared 之后先 `pnpm --filter @kepcup/shared run build`**；改了 core 之后 desktop 要先 `pnpm --filter @kepcup/core run build`（根目录 `pnpm typecheck` 已按序做）。
- e2e：`pnpm build` 之后 `pnpm --filter @kepcup/desktop test:e2e test/e2e/<spec>.spec.ts`。
- `*.svelte.test.ts` 跑在 `desktop-svelte` 项目（无 DOM，不能挂组件）；组件级行为靠 e2e。
- **全量 `pnpm test` 每阶段收口跑一次**（三个阶段都改了 shared 契约 / 迁移 / 夹具）；**不要连续多轮全量**，偶发失败只单跑该文件复核；**改动前不重跑全量建基线**，引用 [05-testing.md](../../docs/dev/05-testing.md) 与 PROGRESS.md 已记录的基线，保证失败集合不超出基线。
- 每个阶段都要**新增**它要求的测试；不能只靠已有测试通过。
- 新增依赖：**只允许** `svelte-dnd-action@0.9.80`（精确锁定，见 §4.5），其余一律不允许。

### 1.5 提交与分支

- Conventional Commits：`feat(board): …`、`refactor(chat): …`、`test(board): …`、`docs(board): …`。**每个提交必须可构建**（至少 `typecheck` 通过）。
- 一个阶段一个分支：`feat/board/p1-skeleton`、`feat/board/p2-card-conversation`、`feat/board/p3-card-dialog`；后一阶段从前一阶段合入点拉出。**不 push，不合入 main**，合入由用户确认。
- 阶段二里的 `ChatSession` 抽取（WP0）**必须是独立提交序列，不夹带任何行为改动**（见 P2 §A）。
- 阶段末尾的「实施记录」在最后一个提交里更新。

### 1.6 遇到偏差怎么办

- 设计 / 阶段文件与代码现实冲突（函数已不存在、假设不成立）→ **停止相关部分**，在 DEVIATIONS 按模板新增一条，继续不受影响的部分，最后写进「实施记录」。
- `svelte-dnd-action` 出现无法绕过的问题 → 同上记 DEVIATIONS，**等待人工决定**是否启用设计 50 §9.6 的回退方案（自研 Pointer Events）；不要自行换方案。
- 不要为让测试通过而放宽断言、跳过或删除用例（阶段明确要求删除的除外）。

### 1.7 全局「不要做」

- 不要编辑**历史迁移 SQL**（已存在的 `packages/core/migrations/**/00NN_*.sql`）；只能新增。编号以开工时目录实况顺延（写作时 main 最新为 `0049`）。
- 不要把「卡片对话」叫 `task`（与 D75 任务撞名）；会话类型是 `card`。
- 不要给 `todos` 表加列；卡片身份靠 `board_cards` 侧表行。
- 不要在 `consider`（拖动中）里发 RPC；只在 `finalize` 里提交。
- 不要在渲染层硬编码中文，文案进 `zh-CN.ts` 与 `en-US.ts`，**两份键顺序必须一致**（`locales.test.ts` 强制，英文不得含中文，占位符一致）。
- 不要在日志、错误信息、RPC 返回里放敏感数据。
- 不要引入向后兼容分支、旧名别名、`@deprecated` 导出。
- 代码、标识符、注释用英文；文档用中文。

### 1.8 代码规范摘要

zod 校验所有边界输入；时间用 `infra/clock`，UTC 毫秒整数；工具失败以工具结果返回不抛出；错误用 `AppError(code, message, details?)`（错误文案走 `chats.errorCode.<CODE>`）；依赖注入、无全局单例（`start.ts` 装配）；`packages/shared` 不依赖 core / Electron；renderer 只经 `lib/rpc` 调 core；Svelte 5 runes；滚动 / 高度链用 `min-h-0` + `overflow-*`，不用魔法数字。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| 单看板：分栏 / 卡片增删改拖、行内编辑、卡片弹框 | 子任务；标签、多成员、截止日期、清单、附件、评论 |
| 指派给项目成员 Bot、执行时间 / 周期（`workbench` 排期）、派发、交付追踪 | Bot / 负责人写看板（读写工具）、分栏自动化、归档 |
| 卡片对话（`card` 会话）+ 项目作用域解析 + `ChatSession` 抽取 | 路径作用域写租约、多看板、卡片复制 / 模板 |
| 看板 tab 徽标、通知深链、窄屏可用、e2e、文档同步 | P1 backlog（见 §5） |

## 3. 阶段依赖

```text
P1 看板骨架（WP1 + WP3）──→ P2 卡片对话与执行（WP0 + WP2）──→ P3 卡片弹框与收口（WP4 + WP5）
                              ↑
              WP0（ChatSession 抽取）与 P1 互相独立；人手允许时可在 P1 期间并行开工，但按「一阶段一分支」
              仍落在 P2 分支里合入
```

- **P2 的后端部分依赖 P1**（`board_cards` / `BoardService` / `TodoService` 看板缝）；**WP0 不依赖 P1**。
- **P3 依赖 P2 全部**（对话区要 `ChatSession`，执行区要 P2 的后端）。
- 多阶段共改的文件：`apps/desktop/src/renderer/src/lib/i18n/locales/{zh-CN,en-US}.ts`、`packages/shared/src/domain/types.ts`、`packages/shared/src/rpc/{methods,events}.ts`、`packages/shared/src/constants.ts`、`packages/core/src/rpc/bindings.ts`、`packages/core/src/start.ts`、`packages/core/src/domain/lifecycle.ts`、`packages/core/src/workbench/todo-service.ts`。冲突时两边都保留，重跑 typecheck 与本阶段测试。

## 4. 固定契约（所有阶段共用，名字不得改动）

### 4.1 数据

| 项 | 名称 |
|---|---|
| 分栏表 | `board_columns`：`id`（前缀 `bcol_`）、`project_id`（FK `conversations` CASCADE）、`title`（1–60 字）、`position REAL`、`created_at` |
| 卡片侧表 | `board_cards`：`todo_id`（PK，FK `todos` CASCADE，**卡片 id = 事项 id**）、`project_id`（FK `conversations` CASCADE）、`column_id`（FK `board_columns`，NO ACTION）、`position REAL`、`created_at` |
| 索引 | `board_columns_project(project_id, position)`、`board_cards_column(column_id, position)`、`board_cards_project(project_id)` |
| 迁移（P1） | `00NN_project_board.sql`：仅上述两表与索引 |
| 迁移（P2） | `00NN_card_conversations.sql`：重建 `conversations`（首行 `-- kepcup:foreign-keys=off`，写法同 `0040_project_conversations.sql`）：`type` CHECK 增 `'card'`；新列 `parent_project_id`（FK 自身 CASCADE）、`card_todo_id`（无 FK）；`CHECK ((type = 'card') = (parent_project_id IS NOT NULL AND card_todo_id IS NOT NULL AND direct_bot_id IS NOT NULL))`；唯一索引 `conversations_one_open_per_card ON conversations(card_todo_id) WHERE type = 'card' AND read_only = 0` |
| 卡片文本 | 存 `todos.notes`（≤ 4000 字）；`todos.title` = `deriveCardTitle(text)`（派生缓存，≤ 120 字） |
| 看板事项的执行成员 | 恒为 `{ kind: 'project', projectId, leadBotId: botId }` |

### 4.2 shared

| 项 | 名称 / 形状 |
|---|---|
| 文件 | `packages/shared/src/domain/board.ts`（zod：`boardColumnSchema`、`boardCardSchema`、`boardSummarySchema`，类型 `BoardColumn`、`BoardCard`、`BoardSummary`）；`packages/shared/src/board.ts`（纯函数 `deriveCardTitle(text: string): string`）；均从 `packages/shared/src/index.ts` 导出 |
| 常量（`constants.ts`） | `BOARD_MAX_COLUMNS = 20`、`BOARD_MAX_CARDS = 500`、`BOARD_CARD_TEXT_MAX_CHARS = 4000`、`BOARD_COLUMN_TITLE_MAX_CHARS = 60`、`BOARD_POSITION_STEP = 1024`、`BOARD_POSITION_MIN_GAP = 1e-3`、`BOARD_CRON_MIN_INTERVAL_MS = 3_600_000` |
| `BoardCard` | `{ id, projectId, columnId, position, text, createdAt, updatedAt, todo: { status, blockedReason, source, assignee: { botId, name } \| null, schedule, lastRun }, conversationId: string \| null, unreadCount: number, pendingApprovals: number, task: { running, queued, queueReason } \| null }`；**P1 就按完整形状定义**，P1 里执行相关字段恒为 `assignee:null`、`conversationId:null`、`0`、`0`、`null` |
| `TodoEntry` | 增只读 `board: { projectId, columnId } \| null` |
| 会话类型（P2） | `conversationTypeSchema` 增 `'card'`；`conversationSchema` 增 `parentProjectId: string \| null`、`cardTodoId: string \| null` |
| 注册表 | `PROJECT_MODULES` 里 `board` → `status:'available'`；顺序 `chat, board, wiki, okr, calendar`（`project-modules.test.ts` 同步） |
| 错误码 | `BOARD_MANAGED`、`BOARD_LIMIT_COLUMNS`、`BOARD_LIMIT_CARDS`、`BOARD_LAST_COLUMN`、`BOARD_COLUMN_NOT_EMPTY`、`BOARD_TEXT_EMPTY`、`BOARD_CRON_TOO_FREQUENT`、`BOARD_PROJECT_READ_ONLY`、`BOARD_ASSIGNEE_INVALID`、`BOARD_LOCKED`（事项现有错误码能表达的情形沿用，不新增） |

**RPC**（登记到 `rpcMethodSchemas` **和** `APP_METHODS`）与**事件**——形状见设计 50 §10：

`board.get { projectId, seedTitles? }`、`board.summary { projectId }`、`board.columns.create / update / move / delete`、`board.cards.create / update / move / assign / schedule / start / complete / cancel / reopen / delete / conversation`；`board.cards.reject` 属 P1 backlog，**本次不做**。事件 `board.changed { projectId, cardId?, columnId? }`。

### 4.3 core

| 项 | 名称 |
|---|---|
| 目录 | `packages/core/src/board/`：`positions.ts`（纯函数 `positionBetween`、`needsRenumber`、`renumber`）、`board-store.ts`、`board-service.ts`（`BoardService`）、`index.ts` |
| 服务装配 | `start.ts` 里 `services.board`；RPC 在 `rpc/bindings.ts` 用 `method(input, output, handler)` 注册 |
| 钩子 | `board.onProjectDeleting(projectId)`、`board.onMemberRemoved(projectId, botId)`（P2）、`board.onBotDeleting(botId)`（P2）；在 `domain/lifecycle.ts` 对应路径调用 |
| 项目作用域（P2） | `packages/core/src/domain/project-scope.ts`：`projectScopeOf(conversation): string \| null`（`project` → 自身 id；`card` → `parentProjectId`；其余 `null`） |
| 看板事项开关 | 「是否存在 `board_cards` 侧表行」是 `TodoService` 看板特例的**唯一**开关；`actor` 取 `'board'` 表示经看板写入 |
| 派发文本 | 看板事项：`【看板】{卡片文本}`；周期卡上一次未交付时末尾附 `（上一次执行尚未交付）` |
| 提示词（P2） | `<conversation_info>` 增 `card` 分支；`CARD_RULES` 常量（`system-prompt.ts`，写法参照 `PROJECT_MEMBER_RULES`） |

### 4.4 renderer

| 项 | 名称 |
|---|---|
| 目录 | `apps/desktop/src/renderer/src/lib/features/board/` |
| P1 文件 | `BoardView.svelte`、`BoardColumn.svelte`、`BoardCard.svelte`、`NewCardComposer.svelte`、`AddColumn.svelte`、`CardDialog.svelte`（P1 为最小版）、`InlineEditable.svelte`、`inline-editable.svelte.ts`（保存调度类，仿 `AutoSaveField`）、`board.svelte.ts`（store，导出单例 `board`）、`board-model.ts`、`board-dnd.ts`、`dnd-setup.ts`；`features/project/ProjectBoardView.svelte` |
| P2 文件 | `stores/chat-session.svelte.ts`（`ChatSession`）、`getChatSession()` / `setChatSession()`（context 助手，同文件或 `features/chats/chat-session-context.ts`） |
| P3 文件 | `CardChat.svelte`、`CardExecutorMenu.svelte`、`CardWhenPopover.svelte`、`CardRuns.svelte`、`CardStatusBar.svelte` |
| store | `board` 单例：`attach()` / `detach()`（挂载计数 + `board.changed` 订阅 + 200ms 去抖 / 1s 上限整体重拉 + 迟到响应序号丢弃，仿 `workbench.svelte.ts`）；`openCardId`；拖动期间延后应用事件 |
| i18n 前缀 | `board.*`；`project.module.board` 已存在 |
| testid | `project-board-view`、`board-view`、`board-column`（`data-column-id`）、`board-column-title`、`board-column-handle`、`board-column-add-card`、`board-column-menu`、`board-add-column`、`board-card`（`data-card-id`）、`board-card-composer`、`board-card-status`、`board-card-assignee`、`board-card-time`、`board-card-unread`、`board-dialog`、`board-dialog-text`、`board-dialog-executor`、`board-dialog-chat`、`board-dialog-when`、`board-dialog-status`、`board-dialog-action`、`board-dialog-runs`、`board-dialog-close` |
| 拖拽 | 分栏：`dragHandleZone` + `dragHandle`，`type:'column'`；卡片：`dndzone`，`type:'card'`、`delayTouchStart:true`；两者 `dropTargetStyle:{}`、`flipDurationMs:150`（`prefers-reduced-motion` 时 0）；全局 `setKeyboardDragTrigger('space')`（在 `dnd-setup.ts`） |

### 4.5 依赖

```bash
pnpm --filter @kepcup/desktop add --save-exact svelte-dnd-action@0.9.80
```

- 写进 `apps/desktop/package.json` 的 **`dependencies`**，版本精确 `0.9.80`（不要 `^`）；MIT；无传递依赖、无安装脚本（不动 `allowBuilds`）；peer `svelte >=3.23.0 || ^5.0.0-next.0`，满足本仓库 `svelte 5.57.1`。
- 文档已登记：`docs/design/09-tech-stack.md`、`docs/dev/01-conventions.md`（本任务书编制时已加）；不记 DEVIATIONS。

## 5. P1 backlog（本次不做，三阶段收口后另排）

退回追问（`board.cards.reject`）；工作台联动（已指派的看板事项在工作台显示「看板」徽标并跳到卡片）；历史执行成员对话（只读查看）；`<project_board>` 摘要段进项目提示词。更后：Bot / 负责人写看板、分栏自动化、归档、路径作用域写租约、标签 / 截止日期。
