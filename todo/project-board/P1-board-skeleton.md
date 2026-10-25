# P1 · 看板骨架：契约、迁移、`BoardService`、看板 UI、拖拽、行内编辑

> 设计 WP：**WP1 + WP3**。依赖：无（从当前集成分支拉出）。分支：`feat/board/p1-skeleton`。
> 先读 [README.md](README.md) §1、§4（固定契约）；设计依据 [docs/design/50-project-board.md](../../docs/design/50-project-board.md) §5（数据）、§8（权限）、§9（界面，尤其 §9.2–§9.7）、§10（RPC）。

## 1. 目标

交付一块**可用的单看板**（梳理思路的工具）：项目组出现「看板」tab；分栏与卡片可增删改拖；卡片文本与分栏标题可行内编辑（防抖保存）；点击卡片打开一个**最小弹框**（只能编辑文本）；分栏无背景、整体横向滚动、纵向占满且不滚动、分栏内部纵向滚动。

**本阶段还没有执行能力**：不能指派、不能设时间、没有卡片对话。但数据契约（`BoardCard` 的执行字段）按完整形状定义，避免后续阶段改契约。

## 2. 范围

| 包含 | 不包含（后续阶段） |
|---|---|
| shared 契约、`deriveCardTitle`、注册表翻转 | `card` 会话类型与迁移（P2） |
| 迁移：`board_columns`、`board_cards` | 指派 / 排期 / 派发 / 交付追踪（P2） |
| `BoardService`：分栏 / 卡片 CRUD、排序、播种、上限、级联（项目删除） | `ChatSession`、卡片对话（P2 / P3） |
| `TodoService` 看板缝：守卫 `BOARD_MANAGED`、`todos.list` / 管家 / `<workbench>` 排除看板事项 | 成员移出 / Bot 删除的看板钩子（P2） |
| RPC + `board.changed` | 完整弹框、徽标、通知（P3） |
| 看板 UI、`svelte-dnd-action` 拖拽、`InlineEditable`、最小 `CardDialog` | |

## 3. 开工前核对

```bash
git status --short && git log --oneline -3
ls packages/core/migrations/main | tail -3                                   # 确认最新迁移编号（写作时 0049）
rg -n "0049" packages apps --glob '!**/migrations/**' --glob '!node_modules' --glob '!**/dist/**' | head   # 迁移版本列表（0042 时漏过，见 git log 748d63dd）
rg -n "canWriteModule|canManageEntry" packages | head                        # 权限缝
rg -n "purge\\(" packages/core/src/workbench/todo-service.ts                  # 删除事项的入口
rg -n "onConversationDeleting" packages/core/src                              # 项目删除时的事项钩子
rg -n "workbench\\.svelte|useWorkbenchData" apps/desktop/src/renderer/src/lib/features/workbench | head   # store 订阅范式
```

必读：`packages/shared/src/domain/project-modules.ts`、`packages/core/src/workbench/{todo-service,todo-store,context}.ts`、`packages/core/src/domain/lifecycle.ts`（`deleteConversation` 约 l.208–325）、`packages/core/src/rpc/bindings.ts`（wiki 与 todos 的注册写法）、`apps/desktop/src/renderer/src/lib/features/project/{ProjectView,ProjectTabs,ProjectWikiView}.svelte`、`project-tabs.ts`、`stores/shell.svelte.ts`、`features/workbench/{workbench.svelte.ts,MemoCard.svelte}`、`features/project/autosave-field.svelte.ts`、`features/sidebar/AppSidebar.svelte`（菜单样式）、`components/ui/{dialog,dropdown-menu}`。

## 4. 步骤

### 步骤 0：依赖与可行性核对

1. `pnpm --filter @kepcup/desktop add --save-exact svelte-dnd-action@0.9.80`。核对：`git diff --stat` 只有 `apps/desktop/package.json` 与 `pnpm-lock.yaml`；`package.json` 里是 `dependencies` 且版本无 `^`；锁文件只新增该包条目。
2. **类型**：Svelte 5 模板里 `onconsider` / `onfinalize` 需要类型声明。先写一个最小 `.svelte` 探针（用完删除）验证 `pnpm --filter @kepcup/desktop typecheck` 是否报未知属性；报错则在 renderer 加类型扩展文件（`apps/desktop/src/renderer/src/lib/` 下的 `.d.ts`，对 `svelte/elements` 的 `HTMLAttributes` 用库导出的 `DndZoneAttributes` 做模块扩展），并在实施记录写明做法。
3. **构建**：`pnpm --filter @kepcup/desktop build` 与 `pnpm --filter @kepcup/desktop build:web` 都能通过（库的 `svelte` 导出条件走 vite-plugin-svelte）。
4. 写 `features/board/dnd-setup.ts`：`configureBoardDnd()` 内调用 `setKeyboardDragTrigger('space')`（全局设置，让 Enter 不被库截获）与 `setAriaStrings({...})`（文案走 i18n，见步骤 13）；`BoardView` 挂载时调用。**核对点**：整个 renderer 此前没有其它 dnd 区域，全局设置无副作用。

### 步骤 1：shared 契约（WP1）

1. `packages/shared/src/board.ts`：`deriveCardTitle(text)`——取首个非空行（兼容 `\r\n`）；行内连续空白折叠成单个空格并去首尾空白；长度（按**码点**，不拆代理对）超过 120 时取前 119 个码点加 `…`；全空白返回 `''`（调用方负责拒绝空文本）。
2. `packages/shared/src/domain/board.ts`：zod 的 `boardColumnSchema`（`id, projectId, title, position, createdAt`）、`boardCardSchema`（形状见 README §4.2，执行字段完整定义）、`boardSummarySchema`（`unread, pendingApprovals, delivered`）。`todoEntrySchema` 增只读 `board`（`{ projectId, columnId } | null`，默认 `null`）。常量按 README §4.2 放 `constants.ts`。
3. 注册表：`PROJECT_MODULES` 里 `board` → `status:'available'`，顺序改为 `chat, board, wiki, okr, calendar`。
4. RPC：在 `rpc/methods.ts` 为 README §4.2 列出的 `board.*`（不含 `reject`）写入 / 出参 schema，登记到 `rpcMethodSchemas` **并加进 `APP_METHODS`**（漏登记会导致不在 `APP_RPC_METHODS` 里）；事件 `board.changed` 登记到 `rpcEventSchemas`。`board.get` 入参含 `seedTitles?: string[]`。
5. `pnpm --filter @kepcup/shared run build`，`pnpm --filter @kepcup/shared typecheck`。

**测试**：新增 `packages/shared/test/unit/board.test.ts`（`deriveCardTitle`：多行 / 前导空行 / CRLF / 超长 / emoji 不被截断成乱码 / 全空白；schema 往返；`APP_RPC_METHODS` 包含全部 `board.*` 方法；事件 schema）；改 `project-modules.test.ts`（`board` 为 `available`、顺序）。

### 步骤 2：迁移与排序纯函数

1. 新迁移 `packages/core/migrations/main/00NN_project_board.sql`（编号接最新）：README §4.1 的两表与三索引。`board_cards.column_id` **不写 `ON DELETE`**（NO ACTION，删栏由 service 先处理卡片；项目级联删除时语句末尾统一检查，不会冲突）。
2. 更新所有「迁移版本列表」（核对命令见 §3 第 3 条）。
3. `packages/core/src/board/positions.ts`：`positionBetween(before?, after?)`（两空 → `STEP`；无前 → `after/2`；无后 → `before + STEP`；否则中点）、`needsRenumber(before, after)`（间隔 `< BOARD_POSITION_MIN_GAP` 或中点与任一邻居相等）、`renumber(ids)`（`STEP * (i + 1)`）。

**测试**：迁移测试（位置仿现有迁移测试，`rg -n "conversation_archive|0045" packages/core/test`）：表 / 索引 / FK 存在；删项目会话级联掉两表；`position` 为 REAL。`board-positions.test.ts`：首 / 末 / 中间插入；连续 60 次同缝插入必然触发重排且顺序保持。

### 步骤 3：`BoardStore` / `BoardService`（WP1）

文件 `packages/core/src/board/{board-store,board-service,index}.ts`，在 `start.ts` 装配为 `services.board`。所有写方法先过：项目存在且 `type='project'`、项目非只读（否则 `BOARD_PROJECT_READ_ONLY`）、`canWriteModule('board', actor)`（actor 为用户；先读 `project-modules.ts` 里 actor 的形状）。写成功后 `publish('board.changed', { projectId, cardId?, columnId? })`。

- `get(projectId, seedTitles?)`：无分栏且 `seedTitles` 非空时，**同一事务内**按序播种（去空白、1–60 字、至多 20 个）；返回按 `position` 排好的 `columns` 与 `cards`（卡片投影：join `todos` 取 `notes`、`status`、`blockedReason`、`source`、`createdAt` / `updatedAt`；执行字段本阶段恒为默认值）。
- 分栏：`createColumn(projectId, title, beforeColumnId?)`（上限 `BOARD_MAX_COLUMNS`，超限 `BOARD_LIMIT_COLUMNS`）、`updateColumn(columnId, title)`、`moveColumn(columnId, beforeColumnId | null)`（锚点；必要时整体重排并返回整张 `columns`）、`deleteColumn(columnId, deleteCards?)`（最后一栏 `BOARD_LAST_COLUMN`；非空且未带 `deleteCards:true` → `BOARD_COLUMN_NOT_EMPTY`；带则逐张走 `deleteCard`）。
- 卡片：`createCard(projectId, columnId, text, beforeCardId?)`——文本 trim 后为空 `BOARD_TEXT_EMPTY`、超 `BOARD_CARD_TEXT_MAX_CHARS` 拒绝、项目卡片数超 `BOARD_MAX_CARDS` 为 `BOARD_LIMIT_CARDS`；**同一事务**建事项（`draft`、`source:'user'`、`title = deriveCardTitle(text)`、`notes = text`、`actor:'board'`）+ `board_cards` 行；默认放在目标分栏**顶部**。`updateCard(cardId, text)`：同样校验，更新 `notes` 与派生 `title`。`moveCard(cardId, columnId, beforeCardId | null)`：目标分栏须属同一项目；`positionBetween` + 必要时整栏重排，返回 `{ card, renumbered? }`；落回原位幂等不发事件。`deleteCard(cardId)`：本阶段为 `todos.purge`（FK 级联带走侧表行）；删除确认由界面负责（`needsDeleteConfirm`，步骤 10）。
- `onProjectDeleting(projectId)`：purge 该项目全部看板事项（侧表行与分栏随会话 FK 级联）。

**测试**：`packages/core/test/integration/board-service.test.ts`（真实库、临时目录）：播种（含重复调用不重复播种、不带 `seedTitles` 返回空）；各上限；创建默认顶部与 `beforeCardId` 定位；同缝连续插入触发整栏重排后顺序稳定；跨项目移动被拒；删非空栏的两条分支；最后一栏不可删；只读项目的全部写被拒；文本空 / 超长；删项目后事项与侧表 / 分栏全部清空。

### 步骤 4：`TodoService` 看板缝（WP1，P1 范围）

只做「别让看板事项污染既有事项体验」所需的最小缝，**以 `board_cards` 侧表行是否存在为唯一开关**（给 `TodoService` 注入只读查询 `isBoardCard(todoId)` / 取 `projectId, columnId`；`BoardStore` 不依赖任何服务，避免循环依赖）：

1. `TodoEntry.board` 在 `list` / `get` 的投影里填充。
2. `todos.list` 默认**排除**看板事项（RPC 契约不变）；管家 `list_todos` 同样排除；`workbench/context.ts` 的 `<workbench>` 计数排除。
3. 所有改动类入口（`update` / `start` / `complete` / `cancel` / `reopen` / `purge` 及管家工具 `update_todo` / `close_todo`）对看板事项：`actor !== 'board'` 一律抛 `BOARD_MANAGED`（「请在看板里修改」）。
4. 看板事项的变更不再广播 `todos.changed`（改发 `board.changed`），避免工作台无意义重拉；**由你判断**实现方式，写进实施记录。
5. `reconcile` 对看板事项照常运行（本阶段它们都是无指派的 `draft`，不会有动作）。

**测试**：`packages/core/test/integration/board-todo-seams.test.ts`：看板事项不出现在 `todos.list` / 管家 `list_todos` / `<workbench>` 摘要；经 `actor` 非 `'board'` 的 `update` / `complete` / `purge` 与 `update_todo` / `close_todo` 都得到 `BOARD_MANAGED`；普通事项行为不变（既有 `workbench-service.test.ts`、`workbench-tools.test.ts`、`workbench-stores.test.ts` 原样通过）。

### 步骤 5：生命周期钩子

在 `domain/lifecycle.ts` 的 `deleteConversation`（项目分支）里、删除会话行**之前**调用 `board.onProjectDeleting`（位置参照 `workbench.onConversationDeleting`）。同步 `docs/dev/03-data-model.md`：新增两表说明与「删除级联」表的两行（项目会话 → 分栏 / 侧表 CASCADE；事项由 `onProjectDeleting` 显式清理，不依赖 FK）。

**测试**：`board-service.test.ts` 里已覆盖「删项目后清空」；再加一条走真实 `lifecycle.deleteConversation` 的用例。

### 步骤 6：RPC 与事件

`rpc/bindings.ts` 用 `method(inputSchema, outputSchema, handler)` 注册全部 `board.*`（`board.cards.assign / schedule / start / complete / cancel / reopen / conversation` 与 `board.summary` **本阶段先不注册**，留给 P2；契约已在步骤 1 定义好）。错误码按 README §4.2。**测试**：`packages/core/test/integration/board-rpc.test.ts`（仿 `wiki-rpc.test.ts`）：每个方法的入参校验、成功路径、错误码、`board.changed` 的发布与载荷。

### 步骤 7：外壳接入（项目 tab）

- `ProjectView.svelte`：增 `{:else if view === 'board'}` → 新建 `features/project/ProjectBoardView.svelte`（薄壳，`data-testid="project-board-view"`，根 `h-full min-h-0 overflow-hidden`，里面放 `BoardView`）；`ModulePlaceholder` 保留给 okr / calendar。
- 同步测试：`project-tabs.test.ts`（tab 为 `['chat','board','wiki']`，labelKey 同步；「planned 不进 tab 行」的断言去掉 board）、`stores/shell-project.svelte.test.ts`（board 可切换；改用 okr / calendar 验证「planned 被忽略」）、`apps/desktop/test/e2e/project-shell.spec.ts`（board 从「应为 0」的断言里移出，其余不变）。
- 切 tab 会卸载看板：滚动位置与 `openCardId` 存 store（步骤 8），编辑草稿靠卸载补存（步骤 9）。

### 步骤 8：渲染层 store `board.svelte.ts`

单例 `board`，仿 `workbench.svelte.ts`：`attach(projectId)` / `detach()`（挂载计数；订阅 `board.changed`，仅当前项目；200ms 去抖、1s 上限整体重拉；序号丢弃迟到响应）。状态：`columns`（每栏含 `cards`）、`loading`、`error`、`openCardId`、`dragging`（拖动期间延后应用事件，`finalize` 后补一次拉取）。方法（均**乐观更新**，失败回滚并 `toast.error(errorText(code, …))`）：`load()`（首次拉取传 `seedTitles` = 当前语言的 `board.defaultColumns.*`）、`createColumn` / `renameColumn` / `moveColumn` / `deleteColumn`、`createCard` / `updateCardText` / `moveCard` / `deleteCard`、`openCard(id)` / `closeCard()`。`chat.select()` 的收口处（与 `projectView` 重置同处）调用 `board.closeCard()`。

**测试**：`features/board/board.svelte.test.ts`（`desktop-svelte` 项目，mock `core`，仿 `workbench.svelte.test.ts`）：播种触发条件；乐观更新与回滚；迟到响应被丢弃；拖动期间事件延后；`closeCard` 随 `select()`。

### 步骤 9：`InlineEditable`（弹框文本、分栏标题、新建卡片共用）

按设计 50 §9.7 的规则表实现：组件 `InlineEditable.svelte`（`contenteditable="plaintext-only"`，无边框 / 背景 / 阴影变化，只有光标；外部值变化仅在**未聚焦且无未保存改动**时写回 DOM，直接写 `textContent` 并保留 `MemoCard` 的 `eslint-disable` 理由注释）+ 保存调度类 `inline-editable.svelte.ts`（防抖、IME 组合期间不调度且 blur 推迟到 `compositionend`、`flush` 立即提交、`dispose` 卸载补存、失败只在草稿未再变化时回滚、空值不保存并在 blur 时回退、飞行期间新输入再来一轮）——**参照 `autosave-field.svelte.ts` 的结构**，不要复制其行内字符串假设。props：`value`、`onSave(text): Promise<boolean>`、`multiline`、`maxLength`、`placeholder`（空时 CSS 占位，不改变布局）、`delayMs`（卡片文本 600、分栏标题 400）、`ariaLabel`、`testid`。单行：Enter = 失焦并提交，粘贴换行替换为空格，超长截断；多行：Enter 换行、`white-space: pre-wrap`，保存时才规整换行与 `\u00a0`。Esc：多行不拦截（交给弹框）；单行还原并失焦且 `preventDefault()`（遵守 `features/shell/escape-layers.ts` 契约）。

**测试**：`inline-editable.svelte.test.ts`（调度类，仿 `autosave-field.svelte.test.ts`）：防抖合并；组合期间不提交；blur 在组合中推迟；空值不保存与回退；`dispose` 补存；失败保留草稿；飞行期间新输入再来一轮。组件级行为（光标 / 无视觉变化）在 e2e。

### 步骤 10：看板视图与组件

遵循设计 50 §9.2–§9.5、§9.9。**高度链**：`ProjectBoardView` 根 `h-full min-h-0 overflow-hidden` → 轨道 `flex min-h-0 flex-1 gap-6 overflow-x-auto overflow-y-hidden px-6 pt-4 pb-4`（**唯一**横向滚动容器）→ 分栏 `flex h-full w-72 shrink-0 flex-col` → 头部 `shrink-0`、卡片区 `min-h-16 min-h-0 flex-1 overflow-y-auto`（分栏内唯一纵向滚动区）。页面本身不纵向滚动。

- `BoardView.svelte`：`attach` / `detach`、渲染分栏区域与 `AddColumn`、空态（理论上不出现：至少一栏）。
- `BoardColumn.svelte`：**无背景无描边**；头部：grip 手柄（悬停显示，`use:dragHandle`）、标题（`InlineEditable` 单行，≤ 60）、计数（`text-xs text-muted-foreground`）、`＋`、`⋯` 菜单（悬停显示，位置预留避免抖动）：左移 / 右移 / 删除分栏；右键标题行同菜单。`NewCardComposer` 渲染在头部与卡片区之间（**区域之外**，固定不滚动）。
- `BoardCard.svelte`：根元素就是拖拽区域的直接子元素；`rounded-lg border bg-card p-3 text-sm`，hover `bg-accent/40`，`role="button" tabindex="0"`；正文只读 `line-clamp-6 whitespace-pre-wrap break-words`；页脚由 `board-model.ts` 的 `cardFooter(card)` 决定，**无指派时为 `null`**（本阶段恒无页脚）；点击 / Enter 打开弹框（`board.openCard`）；右键菜单：移到分栏 ▸、上移 / 下移、删除。`aria-label` = 卡片首行。
- `NewCardComposer.svelte`：与普通卡同外观的空白行内卡，聚焦出现光标；Enter 提交（`Shift+Enter` 换行）、失焦有内容则提交 / 空则撤销、Esc 撤销；提交后卡出现在卡片区顶部、卡片区滚回顶部，并可连续新建。
- `AddColumn.svelte`：轨道末尾的幽灵项；新增后滚动到可见并聚焦标题。
- `board-model.ts`（纯逻辑 + 单测）：`cardFooter(card)`、`needsDeleteConfirm(card)`（`conversationId !== null || todo.assignee !== null || todo.lastRun !== null` 为真才确认；本阶段恒为假，P2 / P3 自动生效）、`columnCounts`、`moveTargets(columns, card)`（右键菜单的目标分栏列表）。
- **删除分栏**：空栏直接删；非空栏弹小 `Dialog`（`sm:max-w-sm`，**必须带 `sm:` 前缀**，否则被基类压住）写明卡片数，确认后 `deleteColumn(columnId, true)`。
- 样式只用 token；层次靠描边与留白；窄屏最小宽 375 靠横向滚动（分栏仍 `w-72`）。

### 步骤 11：拖拽（`svelte-dnd-action`）

严格按设计 50 §9.6 的结构与对策表实现：外层分栏区域 `use:dragHandleZone`（`type:'column'`）、每栏卡片区 `use:dndzone`（`type:'card'`，`delayTouchStart:true`）；`dropTargetStyle:{}`；`flipDurationMs:150`（`prefers-reduced-motion` 时 0）；items 用 `$state.raw` + 整体替换。要点：

- **`consider` 只更新本地 items，不发 RPC**；`finalize` 才提交。
- `board-dnd.ts`（纯函数 + 单测）：`isShadow(item)`、`stripShadow(items)`、`anchorFromFinalize({ items, droppedId, info })` → `{ kind:'commit', beforeId: string | null } | { kind:'ignore' }`（只在 `info.trigger === DROPPED_INTO_ZONE` 的区域提交，取 `droppedId` 之后第一个非影子项为锚点；`DROPPED_INTO_ANOTHER` 与 `DROPPED_OUTSIDE_OF_ANY` 忽略 / 回滚）、`isNoopMove(prev, next)`、`createClickGuard(ms = 120)`（`finalize` 后短暂忽略卡片 click）。
- 键盘每挪一步触发一次 `finalize`：RPC **串行排队并合并为最后一次位置**。
- 影子项样式：`[data-is-dnd-shadow-item-internal]` 统一为「同尺寸、虚线描边、无填充」（写在 `BoardView` 的 `<style>` 里，用 `:global` 限定在看板根下）；浮层副本（`#dnd-action-dragged-el`）加 `shadow-md opacity-90`。
- 区域容器里**不放**额外子元素（`AddColumn` 与 `NewCardComposer` 都在区域之外）。
- `configureBoardDnd()` 在 `BoardView` 挂载时调用（步骤 0 第 4 条）；`setAriaStrings` 的文案走 i18n，区域与每项设 `aria-label`。
- 保留右键菜单与 `⋯` 菜单作为非拖拽入口（设计 §9.6「非拖拽入口」）。

**核对点（写进实施记录）**：点击不误触发拖动；拖动结束不会误开弹框；Enter 开弹框 / Space 起拖；在 `contenteditable` 上 mousedown 不起拖；边缘自动滚动横向与纵向都生效（轨道与卡片区的 computed `overflow` 含 `auto`）。

### 步骤 12：最小卡片弹框 `CardDialog.svelte`

`Dialog`（宽度 `sm:max-w-xl`，**带 `sm:` 前缀**；P3 会加宽并重排）：顶部「任务详情」+ 关闭钮（自绘，`showCloseButton={false}`，仿 `TodoDrawer`）；正文一个 `InlineEditable`（多行，600ms，≤ `BOARD_CARD_TEXT_MAX_CHARS`）绑定 `board.updateCardText`；关闭前补存；Esc 关闭（`InlineEditable` 多行不拦截 Esc）；打开时焦点在弹框容器、不抢光标。testid：`board-dialog`、`board-dialog-text`、`board-dialog-close`。由 `board.openCardId` 驱动，在 `BoardView` 里渲染。

### 步骤 13：i18n

`zh-CN.ts` 与 `en-US.ts` 同步新增（键顺序一致；下表为中文原文，英文由你翻译且不得含中文）：

| key | 文案 |
|---|---|
| `board.defaultColumns.todo` / `.doing` / `.done` | 待办 / 进行中 / 已完成 |
| `board.addColumn` | 添加分栏 |
| `board.column.titlePlaceholder` | 分栏标题 |
| `board.column.addCard` | 新增卡片 |
| `board.column.handle` | 拖动分栏 |
| `board.column.menu.moveLeft` / `.moveRight` / `.delete` | 左移 / 右移 / 删除分栏 |
| `board.column.deleteDialog.title` | 删除分栏「{title}」？ |
| `board.column.deleteDialog.body` | 该分栏下的 {count} 张卡片会一并删除，无法恢复。 |
| `board.column.deleteDialog.confirm` / `.cancel` | 删除 / 取消 |
| `board.card.placeholder` | 写点什么… |
| `board.card.menu.moveTo` / `.moveUp` / `.moveDown` / `.delete` | 移到分栏 / 上移 / 下移 / 删除卡片 |
| `board.dialog.title` | 任务详情 |
| `board.dialog.close` | 关闭 |
| `board.error.saveFailed` | 保存失败 |
| `board.error.moveFailed` | 移动失败，已还原 |
| `board.dnd.*` | `setAriaStrings` 用的播报文案（起拖 / 移到第 N 位 / 放下），由你按库的 `AriaStrings` 形状补齐 |
| `chats.errorCode.BOARD_*` | 各错误码的用户可读文案（README §4.2 的新增错误码逐个补） |

### 步骤 14：e2e

新增 `apps/desktop/test/e2e/project-board.spec.ts`（辅助用 `helpers/create-project.ts`，仿 `project-wiki.spec.ts`）：①首次打开播种三栏；新建 / 改名 / 删除分栏（含非空栏确认）；②新建卡片（Enter / 失焦 / Esc；空文本不落库）；③弹框改文本，防抖后关闭重开仍在；卡面无行内编辑（点击开弹框）；④拖卡片（同栏 / 跨栏）与分栏重排（经头部 grip），**重载后顺序保持**；拖动结束不误开弹框、普通点击仍开弹框；Space 键盘起拖 / Enter 开弹框；拖到边缘时轨道与卡片区自动滚动；⑤**布局不变式**：页面不纵向滚动、分栏头部固定、分栏内纵向滚动（造够卡片）、轨道横向滚动（造够分栏）；⑥项目沟通与看板切 tab 往返，沟通草稿仍在；⑦窄屏（宽 375）可横向滚动且可操作。

## 5. 验收标准

- [ ] `svelte-dnd-action` 精确 `0.9.80` 在 `apps/desktop` 的 `dependencies`，锁文件干净，`build` 与 `build:web` 通过，类型检查通过。
- [ ] 看板 tab 可用，顺序为 沟通 / 看板 / Wiki，okr / calendar 仍隐藏。
- [ ] 分栏 / 卡片增删改拖全部可用，**重载后顺序保持**；同缝连续插入不乱序。
- [ ] 卡片文本与分栏标题编辑**只出现光标、无任何视觉变化**；防抖保存；IME 组合不丢字；失焦 / 关闭 / 切 tab 都补存；空值不落库。
- [ ] 布局不变式成立：页面不纵向滚动、分栏头部与新增钮固定、分栏内部纵向滚动、整体横向滚动；分栏无背景。
- [ ] 卡面只读；点击 / Enter 开弹框；Space 键盘拖动；拖动结束不误开弹框。
- [ ] 看板事项不出现在工作台列表、管家工具与 `<workbench>` 摘要；经非看板入口改动返回 `BOARD_MANAGED`；既有工作台测试原样通过。
- [ ] 删项目会话后事项 / 侧表 / 分栏全部清理；`docs/dev/03-data-model.md` 已同步。
- [ ] 所有文案在 `zh-CN` 与 `en-US`，`locales.test.ts` 通过。

## 6. 测试与收口

迭代中只跑相关测试（README §1.4）。收口：

```bash
pnpm --filter @kepcup/shared run build
pnpm typecheck && pnpm lint
node scripts/run-tests.mjs run packages/shared/test/unit/board.test.ts packages/shared/test/unit/project-modules.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/board-service.test.ts packages/core/test/integration/board-todo-seams.test.ts packages/core/test/integration/board-rpc.test.ts
node scripts/run-tests.mjs run --project desktop
pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/project-board.spec.ts test/e2e/project-shell.spec.ts test/e2e/project-chat.spec.ts test/e2e/project-wiki.spec.ts test/e2e/workbench.spec.ts
pnpm test      # 阶段收口跑一次全量；失败集合不得超出基线
```

## 7. 实施记录

本段只记录 **P1 步骤 0–6 的后端切片**（分支 `cursor/board-p1-skeleton-05a0`）。**步骤 7–14 的渲染层没有开始**：没有 `ProjectBoardView` / `BoardView` / 拖拽组件 / `InlineEditable` / `CardDialog` / `dnd-setup.ts` / i18n 文案 / e2e。全量 `pnpm test` 未跑（按定向测试规则，留给阶段收口）。

### 步骤 0

- `svelte-dnd-action@0.9.80` 精确写在 `apps/desktop` 的 `dependencies`（无 `^`）。锁文件只增加该包（peer 为仓库里已有的 svelte，无新的传递依赖）。未改 `allowBuilds`。
- 类型探针：临时 `.svelte` 使用 `use:dndzone` 与 `onconsider` / `onfinalize`，`pnpm --filter @kepcup/desktop typecheck`（svelte-check）**没有**报未知属性。库的 `ActionReturn<Options<T>, DndZoneAttributes<T>>` 已带这两个属性，**不需要**模块扩展 `.d.ts`。探针已删除。
- `pnpm --filter @kepcup/desktop build` 与 `pnpm --filter @kepcup/desktop build:web` 均通过。
- `dnd-setup.ts`（`setKeyboardDragTrigger` / `setAriaStrings`）留到步骤 13 的 i18n，本切片未写。

### TodoService 缝与 `todos.changed`

- 开关只有 `board_cards` 行。`BoardStore.locationOf` 不依赖任何服务；`TodoService` 注入可选的 `boardCards.locationOf`。`toEntry` 据此填 `TodoEntry.board`（没有侧表行则为 `null`）。
- `todos.list` 在 SQL 里排除 `board_cards.todo_id`（RPC 入参未改）。管家 `list_todos` 走同一个 `list`。`<workbench>` 在 `buildWorkbenchSection` 里再滤掉 `todo.board != null`（`== null` 仍计入旧夹具里未写该字段的事项）。
- `update` / `start` / `complete` / `cancel` / `reopen` / `purge` 在其它校验之前：侧表行存在且 `actor !== 'board'` 抛 `BOARD_MANAGED`。`TodoActor` 增 `'board'`（不写入 `source`，仍是 `'user'`）。管家工具的 `failure()` 把 `BOARD_MANAGED` 原样放到 `errorCode`（原先非 `NOT_FOUND` 一律收成 `INVALID_INPUT`）。
- 建卡：`insertBoardDraft` **不**发事件（此时还没有侧表行，发了会变成 `todos.changed`）。`BoardService` 在同一事务写入侧表后再发 `board.changed`。
- 其它看板事项变更：`#changed` 查到侧表位置就发 `board.changed`，不发 `todos.changed`。`purge` 在删除前记下 `{ projectId, columnId }`，避免级联删掉侧表后误发 `todos.changed`。`reconcile` 仍扫描这些事项（本阶段是无指派的 `draft`，没有动作）。取舍见 DEV-046。
- `scheduled_by` 的 CHECK 只有 `'user' | 'butler'`。P1 看板写入不排期；若 `actor === 'board'` 真的走到 `#schedule`，记成 `'user'`。P2 的排期 RPC 应改这里，不要把 `'board'` 写进该列。

### 权限

`canWriteModule('board', actor)` 的 actor 是 `'user' | 'lead' | 'member'`。用户恒可写；`lead` 在现有实现里也对所有模块返回 true（`write: 'lead'` 挡的是 `member`）。P1 的 RPC 固定传 `'user'`。`member` 拒绝为 `INVALID_INPUT`（没有单独的看板权限错误码，与 wiki 的拒绝方式相同）。只读项目的写（含播种）为 `BOARD_PROJECT_READ_ONLY`。

### 超长文本

卡片正文按码点超过 `BOARD_CARD_TEXT_MAX_CHARS` 时服务抛 `INVALID_INPUT`（错误码表没有「文本过长」）。空文本（trim 后）为 `BOARD_TEXT_EMPTY`。分栏标题 trim 后空或超过 60 个码点为 `INVALID_INPUT`。

### 新增名字（README §4 未列）

- `BoardStore.locationOf`、`placeItem`（`positions.ts`，在 `positionBetween` / `needsRenumber` / `renumber` 之上的落点函数）、`insertBoardDraft`、`updateBoardText`。
- RPC schema 常量沿 `todos*Schema` 的写法：`boardGetInputSchema`、`boardCardIdInputSchema`、`boardEmptyOutputSchema`、`boardChangedPayloadSchema` 等。线上方法名不变。
- 迁移测试文件 `packages/core/test/unit/project-board-migration.test.ts`。
- id 种类 `bcol`（前缀 `bcol_` 已在契约里）。

### 偏差

- DEV-045：不添加 `board.cards.reject`。
- DEV-046：看板事项不广播 `todos.changed`。

### 尚未做、会挡住 UI 切片的点

- 注册表已把 `board` 标为 `available` 且顺序为 `chat, board, wiki, okr, calendar`。`project-tabs.test.ts`、`shell-project.svelte.test.ts`、`project-shell.spec.ts` 仍按「board 是 planned」断言，要等步骤 7 一起改。本切片没跑这些测试。
- `board.summary` 与 `board.cards.assign / schedule / start / complete / cancel / reopen / conversation` 只有 shared schema 和 `APP_METHODS` 登记，**没有**绑到 `rpc/bindings.ts`。直接调用会当未知方法失败。
- 卡片投影的执行字段恒为 `assignee: null`、`conversationId: null`、`unreadCount: 0`、`pendingApprovals: 0`、`task: null`。
- 同一张卡的文本更新会发两次相同的 `board.changed`（`TodoService.#changed` 一次，`BoardService` 再一次）。渲染层去抖可以吸收；若步骤 8 要严格计次，应只保留一处。
- 错误码的 `chats.errorCode.BOARD_*` 文案属于步骤 13，本切片未写。
- 删项目：`lifecycle.deleteConversation` 在删会话行之前、紧挨 `workbench.onConversationDeleting` 调用 `board.onProjectDeleting`（仅 `type === 'project'`）。钩子失败走 `#cascade`，记日志、不中断删除（与工作台钩子相同）。
