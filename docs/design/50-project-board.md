# 50 项目组看板（Board）：梳理思路、指派执行、卡片对话

**状态：已实施（2026-10-26）。** 决策 **D103**；§2 的 Q1–Q9 全部按推荐，**仅 Q4 改口为 `svelte-dnd-action`**（用户 2026-10-26 确认）。执行方案与实施记录见 [todo/project-board/](../../todo/project-board/README.md)（三个阶段均已落地）。

早期阶段的工程原则沿用 [41](41-project-team.md)：**不保证旧数据可用、不做向后兼容；以语义准确、框架坚实为准。**

相关：D92 项目组与模块框架（[41](41-project-team.md) §10）、D90 工作台与事项（[39](39-workbench.md)）、D75 对话轮与任务（[30](30-supervisor-and-tasks.md)）、D80 定时任务（[todo/schedule-nudges.md](../../todo/schedule-nudges.md)）、D9 Wiki 隔离（[05](05-wiki-and-skills.md)）、D93 任务过程页（[42](42-task-run-view.md)）。

> 术语：需求里的「任务组」按「项目组」理解；「计划任务」指 `schedules`（界面叫「定时任务」）。

## 0 摘要

- **本质**：看板是项目组的第三个可用模块（沟通、Wiki 之后）。它先是用户**梳理思路**的工具——单看板、自由分栏、卡片可增删改拖；再往前一步是**指派**——把卡片交给项目里的一位 Bot 成员，配上执行时间或周期，Bot 在**这张卡片专属的一条对话**里与用户讨论、执行、交付。
- **卡片 = 事项（D90）+ 看板侧表**：指派 + 时间 = 一条 `origin='workbench'` 的排期，复用事项的状态机、排期不变式、派发、交付追踪、对账、更新通知；看板只新增「分栏」与「卡片在哪个分栏的第几位」。没有指派的卡是纯思路卡，不带任何状态。
- **分栏与执行状态正交**：分栏是用户的整理，只存位置；执行状态由宿主推进，派生显示在卡面与弹框。41 的 K8（「列 = 事项状态」）因此修正。
- **卡片对话 = 新的隐藏会话类型 `card`**：一条会话 = （卡片, 执行成员）。Bot 的人设、工具、知识不变；项目 wiki / 记忆通过「项目作用域解析」继续按项目口径读写，影响与在项目里工作时一致。换指派 = 新会话，旧会话只读保留。
- **最大的工程量不在看板本身**，而在两处：渲染层聊天组件目前绑定全局 `chat.current`（需先做行为中性的 `ChatSession` 抽取，§11），以及后端「一个会话类型 + 一组项目作用域判断点」（§5.5、§7）。
- **界面**：分栏无背景，整体横向滚动、纵向占满且不滚动、分栏内部纵向滚动、标题与新增钮固定在分栏顶部；卡面只读（点开弹框、整面可拖），弹框内文本与分栏标题始终可编辑（只出光标，保存带防抖）。
- **本期不做**：子任务、标签 / 多成员 / 截止日期 / 清单 / 附件 / 评论、Bot 或负责人写看板、分栏自动化、路径作用域写租约（§16）。

## 1 对原始设计的修正与补充

| # | 原设计 | 发现 | 修正 / 补充 |
|---|---|---|---|
| M1 | 指派给 Bot ＝ 为该 Bot 建计划任务 | 仓库有两条「计划任务」：Bot 自排（`schedule` 工具，`origin='tool'`）与工作台事项排期（`origin='workbench'`）。前者受主动消息开关 / 免打扰 / 每日 5 条约束，到点是隐藏的系统消息，没有交付追踪，Bot 还能自行取消——不适合「用户派的活」 | 走后者：卡片 = 事项。指派 + 时间 = 一条 `workbench` 排期，语义同 D90（用户指令、不受主动消息护栏、`triggerFromUser=false`）。排期仍出现在该 Bot 的 `<schedules>` 与项目详情「定时与监看」，带「工作台」徽标 |
| M2 | 自由分栏 + 状态可追踪 | 41 K8 假设「列 = 状态」，与自由分栏冲突 | 分栏与状态是两条轴（§6.4）；v1 不按状态自动挪卡 |
| M3 | 卡片文本、分栏标题直接 `contenteditable` | 卡面同时要「点击开详情」和「拖拽」，`contenteditable` 吞掉 mousedown（光标 / 选区）与拖拽起手 | 弹框内文本、分栏标题、新建卡片行内编辑照做；**卡面文本只读**（§9.7） |
| M4 | 弹框右侧复用左栏单聊组件 | `MessageList` / `Composer` 等读全局 `chat.current`；弹框打开时 `chat.current` 是项目会话本身；`tasks.openTaskId` 会让主区被任务过程页替换 | 先做 `ChatSession` 抽取（行为中性重构，§11）再嵌入；弹框内点任务卡，在弹框内展示任务过程 |
| M5 | 单独起对话 | `conversations.type` CHECK 只有 `direct` / `project`；单聊「每 Bot 一条」唯一；复用 `direct` 会让 Bot 的普通单聊读到卡片内容（泄漏） | 新增隐藏会话类型 `card`（不叫 `task`，与 D75 任务撞名）；每 （卡片, 执行成员）一条，换指派 = 新会话，旧的只读保留 |
| M6 | 对话对 Bot / 项目记忆、wiki 的影响「保持不变」 | 现有逻辑以 `type === 'project'` 判断项目上下文（wiki 默认 scope、`<project_wiki_topics>`、记忆 origin、反思建议归属、工作目录）；`card` 默认会全部落到「单聊」口径——影响就变了 | 引入单一解析 `projectScopeOf(conversation)`（`card` → 所属项目），把这些判断点收口（§7.2） |
| M7 | （未提）派发回合的审批 | 派发回合 `triggerFromUser=false`，敏感写入出审批卡；卡片对话藏在弹框里，用户在沟通 / Wiki tab 时会漏掉 | 卡面徽标 + 看板 tab 徽标（未读 + 待审批 + 待验收）；弹框内有审批坞；通知点击直达卡片（§9.1） |
| M8 | （未提）并发 | 同一工作目录同时只有一个写任务（D75）；41 §9.2 把「路径作用域写租约」列为看板前置 | 不作前置：每卡独立会话使任务并发按卡计；卡面显示「排队中 · 等写入租约」（读卡片对话的任务 `queueReason`）；路径作用域写租约另立设计（Q6） |
| M9 | 周期设置 | 事项 cron 无频率下限；RPC 无时区参数；周期触发时上一次可能还没交付 | 看板卡 cron 最小间隔 1 小时（宿主守卫；UI 预设本就 ≥ 每天）；时区沿用核心进程时区（界面标出差异）；未交付时派发文本附「上一次执行尚未交付」（§6.2） |
| M10 | 排除用户自己 | 用户不在 `conversation_members`，候选天然不含用户 | 候选 = 项目成员里 active 的 Bot（管家本就不入项目，K9） |
| M11 | 增删改拖 | 卡片带会话、执行记录、排期；删分栏会连带 | 级联与确认见 §6.6 |
| M12 | 不做子任务 | — | 采纳；另明确不做标签 / 多成员 / 截止日期 / 清单 / 附件 / 评论（卡片对话取代评论） |
| M13 | 弹框「上下工具栏 + 中部左右」 | Trello 新卡背同为左详情右「评论与活动」，约 940px 以下上下堆叠 | 采纳；本应用以弹框容器宽度 < 760px 改为「详情 / 对话」两个 tab（沿用工作台阈值） |

## 2 待你确认的决策

2026-10-26 已确认：除 Q4 由推荐的「自研」改为 `svelte-dnd-action` 外，其余均按推荐。表中 Q4 一行为最终决定，其余仍是「推荐 / 备选」的原始记录。

| # | 问题 | 推荐（Q4 为最终决定） | 备选与代价 |
|---|---|---|---|
| Q1 | 卡片的数据模型 | **卡片 = 事项 + 看板侧表**（`board_cards.todo_id` 一对一）。复用状态机 / 排期 / 派发 / 追踪 / 对账 / 更新通知 | 独立 `board_cards` + 镜像事项：文本两处可编辑，需镜像与守卫；全新一套：复制约 1300 行 `TodoService` 及对账 |
| Q2 | 卡片对话的会话形态 | **新隐藏类型 `card`**，需重建 `conversations`（`-- kepcup:foreign-keys=off`，0040 先例） | 复用 Bot 单聊 + thread id：免迁移，但每条上下文读路径（上下文装配、摘要、未读、搜索、邮箱键）都要带 thread，漏一处就泄漏 |
| Q3 | 分栏与状态的关系 | **解耦**（v1）：卡面显示派生状态，不自动挪卡 | 分栏绑定状态 / 按状态自动挪卡：要做「分栏规则」，且无指派的思路卡无法归类 |
| Q4 | 拖拽实现 | **`svelte-dnd-action`（最终决定）**：嵌套区域、自动滚动、触屏、键盘与屏读现成；精确锁定 `0.9.80`，写进 `apps/desktop` 的 `dependencies`；新依赖在设计文档（本文 §9.6、09-tech-stack）里登记，不记 DEVIATIONS | 自研 Pointer Events（沿用侧栏分组重排的写法，零依赖，但二维命中、边缘滚动、键盘、触屏都要自己做）——作为回退方案保留；Pragmatic DnD（需自行拼装 Svelte 适配） |
| Q5 | 卡面文本能否行内编辑 | **卡面只读**，编辑在弹框 | 卡面直接编辑：要放弃整面可拖 / 点击开弹框，或加专门手柄与双击语义，等于给卡面加模式 |
| Q6 | 路径作用域写租约是否作看板前置 | **不作前置**（41 §9.2 的前置要求在此松绑，见 M8） | 先做：同目录多卡并行写；代价是沙箱挂载、影子仓库、检查点都要按范围改，工程量大 |
| Q7 | Bot / 负责人能否写看板 | **本期只有用户写**；留好 `canWriteModule('board')` 缝与摘要段位置 | 本期加负责人写工具：要补读写工具、`untrusted` 包裹、写权限校验与提示词规则 |
| Q8 | 删除卡片 | **硬删 + 确认**（有会话 / 执行记录时确认；纯思路卡直接删） | 归档（可恢复）：多一个 `archived_at`、归档视图与恢复入口 |
| Q9 | 卡片对话的记忆口径 | **视同项目对话**：记忆 `origin='project'`，读取侧同项目口径（含对私聊来源记忆的「不外泄」标注） | 视作私聊：卡片里学到的东西不会在项目沟通里出现，但与「项目内工作」的预期不符 |

## 3 现状（代码对照）

| 方面 | 现状 |
|---|---|
| 模块框架 | `PROJECT_MODULES` 里 `board` 为 `status:'planned'`、`write:'lead'`（`packages/shared/src/domain/project-modules.ts`）；`ProjectTabs` 只渲染 `available`；`ProjectView` 对非 chat / wiki / settings 回落 `ModulePlaceholder`；`shell.openProjectModule` 忽略 `planned`。注册表顺序为 chat、wiki、board，与 41 §11.2 示意图的「沟通 看板 Wiki」不一致 |
| 事项（D90） | `todos` / `todo_runs` + `TodoService`：状态机 `draft → scheduled → in_progress → delivered → done`（另 `cancelled`）；「有时间 ⇔ 存在 active schedule 或 `pending_when`（未指派先定时间）」「active schedule 一定有执行者」；派发 = 目标对话里一条可见用户消息（`textContent.origin='workbench'` + `todoId` / `todoRunId`）；交付追踪、对账、事项更新通知（10 秒去抖）；**全局、无项目作用域、无排序**；已关闭 7 天后默认不出列表 |
| 计划任务 | `schedules`：`once` / `cron`；`createForTodo` 不走 Bot 成员 / 主动消息护栏；`reschedule` 原地改期；到点 `#fireWorkbench → dispatchScheduled`；错过补发（`catchUpMissed`）；改派 = 取消旧排期在新对话重建 |
| 时间界面 | `WhenPicker` + `when-presets.ts` + `describe.ts`：不定 / 立即 / 某时 / 重复（每天 / 工作日 / 每周几 / 每月几号 + 时刻），纯逻辑已有单测 |
| 会话 | `conversations.type ∈ {direct, project}`（CHECK）；单聊唯一索引每 Bot 一条未只读；`conversations.list` 无类型过滤；每次消息 / run 变化发 `conversation.updated`，渲染层盲 upsert 进侧栏 |
| 聊天 UI | `ChatView` → `MessageList` / `Composer` / `ChatMessageRow` 等读 `chat.current`；已按 conversationId 键控的：`composerDrafts`、`permissions.approvals`、`ApprovalDock`、`ProjectTurnStatusLine`、`tasks.byId` |
| 提示词与项目口径 | 提示词按 (Bot, 对话) 在 run 构建时拼装；`<conversation_info>` 对非 `direct` 一律渲染成项目组；`<project_wiki_topics>`、wiki 工具默认 scope（`wiki.projectContext`）、反思建议的 wiki 归属、记忆 origin、`warnPrivateOrigin`、`<my_state>` 标签都以会话类型判断 |
| 会话邮箱与并发 | 邮箱键 `(botId, conversationId)`——卡片对话与该 Bot 的单聊并行互不阻塞；任务并发 3/会话、8/全局；同 cwd 写任务串行（`等写入租约`） |
| 拖拽 | 仓库**尚无 DnD 库**（本期引入 `svelte-dnd-action`，Q4）；侧栏分组重排是手写 Pointer Events（`sidebar-sections.ts` 纯逻辑 + 4px 阈值 + 边缘自动滚动 + 插入线 + 右键「上移 / 下移」键盘替代），看板不沿用它；HTML5 拖放只用于 Composer 文件拖入 |
| 行内编辑 | `MemoCard`（`contenteditable="plaintext-only"`、450ms 防抖、`onDestroy` 补存、写 `textContent` 避免光标跳、IME 判断）；`AutoSaveField`（IME 挂起、失败只在草稿未变时回滚、`dispose` 补提交） |
| UI 组件 | 无 popover / card / scroll-area；`Dialog` 无尺寸变体且基类带 `sm:max-w-sm`，覆盖宽度必须写 `sm:max-w-*`；已有手写轻量弹层（`ProjectMembersMenu`） |

## 4 联网调研结论

| 议题 | 结论 | 对本设计的影响 |
|---|---|---|
| Trello 卡背 | 新卡背为左详情、右「评论与活动」，约 940px 以下上下堆叠，底部栏可折叠右栏 | 弹框左右布局，窄容器改 tab（§9.8） |
| 卡片排序 | 用「间隔式 position」（取两邻居中点）一次移动只写一行；浮点同一缝隙约 40–50 次插入后失效，需在间隙过小时整栏重排；移动传**锚点**由服务端算位置，比传下标 / 整列表对乱序与并发更稳 | `position REAL` + 重排；`move` 入参 `beforeCardId`（§5.4） |
| 分栏 / 状态 | 「列是卡片的状态字段」与「列自己拥有有序列表」是两个真相源，混用会不一致 | 采纳：分栏只存位置，状态另一条轴（Q3） |
| 拖拽体验 | 键盘路径与非拖拽移动入口、屏读播报、边缘自动滚动、乐观更新 + 失败回滚；触屏长按起拖 | §9.6：库自带键盘 / 屏读 / 触屏延迟起拖 / 自动滚动，另保留右键菜单作非拖拽入口 |
| 拖拽库 | `svelte-dnd-action` 支持 Svelte 5（`onconsider` / `onfinalize`）、嵌套区域、触屏、自动滚动，a11y 为 beta；0.9.58 对 `$state` 条目有坑；Pragmatic DnD 是 Jira / Trello 底层，框架无关，需自行拼装 | **采用 `svelte-dnd-action`**（Q4），源码核对结论见 §9.6 |
| AI 代理看板 | 业界做法一致：卡片 = 任务 + 代理指派 + 卡内会话线程；代理**不自行关闭自己的活**，人验收才算完；被阻塞要有显眼标记并直达线程（buzzboard、AgentCenter、Akievo、Vibe Kanban） | 与 D90「待验收不自动完成」一致；卡面「需要你处理」徽标直达弹框 |
| `contenteditable` 自动保存 | 输入防抖；IME 组合期间不保存、blur 推迟到 `compositionend`；编辑中不重写 DOM；`plaintext-only` 粘贴去格式；换行规整只在保存模型里做 | §9.7 |
| 极简看板 | Linear 改版强调降噪、对齐、低 chrome、中性色，而不是突出的分栏底色 | 分栏无背景、描边卡片、层次靠留白 |

调研来源见文末附录。

## 5 概念与数据模型

### 5.1 术语

| 概念 | 界面 | 代码 | 备注 |
|---|---|---|---|
| 看板 | 看板 | 模块 `board`（`PROJECT_MODULES`） | 每个项目组一块，不做多看板 |
| 分栏 | 分栏 | `board_columns`，`BoardColumn` | 标题由用户起 |
| 卡片 | 卡片 | `board_cards` + `todos`，`BoardCard` | 卡片 id = 事项 id |
| 执行成员 | 执行成员 | 事项的 `assignee`（项目组 + 覆盖 Bot） | 项目成员里的 active Bot |
| 卡片对话 | （弹框右侧对话） | `conversations.type='card'` | 隐藏，不进侧栏 / 搜索 / 通讯录 |

### 5.2 卡片 = 事项 + 看板侧表（Q1）

```sql
-- main 迁移（编号以开工时目录实况顺延，当前最新为 0049）
CREATE TABLE board_columns (
  id          TEXT PRIMARY KEY,                                        -- bcol_...
  project_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  position    REAL NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX board_columns_project ON board_columns(project_id, position);

CREATE TABLE board_cards (
  todo_id     TEXT PRIMARY KEY REFERENCES todos(id) ON DELETE CASCADE, -- 卡片 id = 事项 id
  project_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  column_id   TEXT NOT NULL REFERENCES board_columns(id),              -- NO ACTION：删栏由 service 先处理卡片
  position    REAL NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX board_cards_column  ON board_cards(column_id, position);
CREATE INDEX board_cards_project ON board_cards(project_id);
```

- **文本**：卡片只有一个文本（≤ 4000 字）。存进 `todos.notes`；`todos.title` 是**派生**的首行（首个非空行，去多余空白，≤ 120 字，超出截断加 `…`），由 shared 的 `deriveCardTitle` 统一计算，列表 / 通知 / 会话标题用它。卡片文本不允许为空（清空不保存，失焦回退）。
- **`todos` 不加列**。侧表行存在 = 这是一张看板卡片；事项上不再冗余 `project_id`。`TodoEntry` 增只读的 `board: { projectId, columnId } | null`。
- **无指派的卡 = 纯思路卡**：事项状态恒为 `draft`、无排期、无会话，界面不显示任何状态。
- **事项文本守卫**：`TodoService.update` 对看板事项的 `title` / `notes` 只接受 `actor='board'`；工作台抽屉与管家的 `update_todo` 改文字返回 `BOARD_MANAGED`（「请在看板里修改」）。避免两处可编辑同一文本。
- **级联**：删项目会话 → FK 级联掉分栏与侧表行，但**事项与卡片对话不会被 FK 带走**，必须由 `lifecycle.deleteConversation(project)` 先调 `board.onProjectDeleting`：逐张卡删除卡片对话（走 `lifecycle.deleteConversation`，不依赖 FK，否则漏 `runs.db` / FTS / 文件清理）、`todos.purge`。删卡同理（§6.6）。

### 5.3 分栏

- 首次打开看板时若**没有任何分栏**，由渲染层把按当前语言本地化的默认标题（「待办 / 进行中 / 已完成」）经 `board.get` 的 `seedTitles` 传入，核心在同一事务内播种（核心没有 i18n，不自己决定语言；不传 `seedTitles` 则返回空看板）。播种后**至少保留一个分栏**（最后一栏不可删），所以「没有分栏」总是「未初始化」，不需要额外标记。
- 上限：每项目 20 栏、500 张卡（`BOARD_MAX_COLUMNS` / `BOARD_MAX_CARDS`），常量放 shared。这个量级不需要虚拟列表（调研里的虚拟化针对千级卡片）。
- 删除分栏：空栏直接删；非空栏必须带 `deleteCards:true`（界面确认框写明卡片数与「其中 N 张已指派」），连带删除其卡片（§6.6）。

### 5.4 排序

- `position REAL`，相邻间隔 1024；落点 = 两邻居中点，首位 = 首张 / 2，末位 = 末张 + 1024。
- 当相邻间隔 < 1e-3 时，服务端把**该栏**（或该项目的分栏）整体重排为 1024 步长，同一事务内完成，并在响应里带回被重排的行，客户端整体替换。
- 移动 RPC 传**锚点**（`beforeCardId` / `beforeColumnId`，`null` = 放到末尾），服务端算位置；客户端不传下标、不传整列表。新建卡片默认放在分栏**顶部**（新增钮在分栏顶部）。

### 5.5 卡片对话：新会话类型 `card`（Q2）

```sql
-- 重建 conversations（首行 -- kepcup:foreign-keys=off，写法同 0040）
type  CHECK (type IN ('direct', 'project', 'card'))
parent_project_id TEXT REFERENCES conversations(id) ON DELETE CASCADE   -- card 的所属项目
card_todo_id      TEXT                                                  -- 卡片（事项）id，无 FK：删除由 service 驱动
CHECK ((type = 'card') = (parent_project_id IS NOT NULL AND card_todo_id IS NOT NULL
                          AND direct_bot_id IS NOT NULL))               -- card 必带所属项目 / 卡片 / 执行成员
CREATE UNIQUE INDEX conversations_one_open_per_card
  ON conversations(card_todo_id) WHERE type = 'card' AND read_only = 0; -- 每张卡片至多一条在用对话
```

- **一条会话 = （卡片, 执行成员）**。`direct_bot_id` = 执行成员。指派时 `ensureCardConversation`：该卡片已有同一 Bot 的会话 → 复用（必要时取消只读）；否则新建，并把卡片上其他在用的会话设为 `read_only`。取消指派 / 成员被移出 / Bot 被删 → 会话只读保留（与「被删 Bot 的单聊」同一处理）。
- **隐藏**：`listVisible` / `list` 排除 `card`；`conversation.updated` 事件的渲染层 upsert 也显式忽略 `card`（防止它进侧栏）；全局搜索、通讯录、分享目标、移交适配器都按 `type='direct'` 查询，天然排除（实施时逐项核对，见 §14 清单）。
- **会话标题** = 卡片派生标题（卡片文本变更时同步），仅用于通知与执行记录。
- **工作目录**：不复制，经 `projectScopeOf` 解析到所属项目的 `workdir_id`（§7.2），避免与项目切换目录不同步。
- **单聊类行为**：`card` 与 `direct` 一样走「用户消息 → 直聊投递闸口 → 邮箱 `(botId, conversationId)`」，不经项目路由 / 负责人网关 / 协作回合。差异：委派（`delegate_to_bot`）、开箱引导、管家规则不适用。
- **不做的备选**：`type='direct'` + `scope` 列（免重建，但所有按 `direct` 枚举的路径会泄漏卡片会话）；`project` 子项目（强制负责人 / 路由 / 熔断 / 项目 wiki 目录，且进侧栏）。

### 5.6 不变式

1. 卡片文本非空；分栏标题非空（≤ 60 字）；每项目至少一个分栏。
2. 有时间 ⇒ 必有执行成员（沿用 D90；看板里「时间」就是「执行时间」，没有截止日期概念）。
3. 看板事项的执行成员恒为 `{ kind:'project', projectId, leadBotId: botId }`，`botId` 必须是该项目 active 成员且非管家；项目只读时不可指派 / 排期。
4. 看板事项的目标对话恒为其卡片对话，派发不 `@`、不走项目路由。
5. 每张卡片至多一条在用卡片对话。
6. 执行成员离开（移出项目、Bot 被删）⇒ 指派清空、卡片回 `draft` 并写 `blocked_reason`、会话只读；**不**降级为「项目负责人执行」（这是通用事项的 `#dropExecutor` 行为，看板事项要改）。

## 6 执行：指派、时间、派发、状态

### 6.1 指派

- 上工具栏右侧的执行成员头像是入口：点开成员列表（项目成员里 active 的 Bot，负责人带标，另有「未指派」项）。用户不是成员，天然被排除。
- `board.cards.assign { cardId, botId | null }` →
  1. 校验成员 / active / 非管家 / 项目可写（沿用 `#validateAssignee`，`warnings` 就地显示，如「该 Bot 未配置模型」）；
  2. `ensureCardConversation(card, bot)`；
  3. `TodoService.update({ assignee: { kind:'project', projectId, leadBotId: botId } })`。若已有排期，按现有「改派」流程：取消旧排期（旧会话里的回执卡显示「已改派」），在新会话重建。
- **锁**：沿用事项规则——进行中 / 待验收 / 已关闭的卡片不能换人或改时间（成员头像菜单置灰并提示「执行中不能更换，请先取消执行」；已关闭的先「重新打开」）。
- 指派后**不自动执行**：已指派、没有时间 = 「待开始」，用户可以先在卡片对话里和 Bot 讨论思路，再点「开始执行」或设时间。

### 6.2 时间与周期（与 Bot 计划任务对齐）

- 沿用 D90 的 `when` 口径：`'now'`（立即）/ ISO 8601（某时，单次）/ cron（周期）/ `null`（清除）。界面直接复用 `WhenPicker` + `when-presets.ts` + `describe.ts`：不定 / 立即 / 某时 / 重复（每天、工作日、每周几、每月几号 + 时刻），实时显示「下次：…」。
- 一条排期 = 一行 `schedules`：`origin='workbench'`、`todo_id` = 卡片 id、`conversation_id` = **卡片对话**（于是回执卡「工作台安排：「标题」· 周五 09:00」落在卡片线程里、Bot 在该会话的 `<schedules>` 里看到「工作台派给你的」、卡片对话删除时排期随 FK 级联）。到点：`#fireWorkbench → dispatchScheduled`，不受主动消息开关 / 免打扰 / 每日上限约束（用户的指令，D90 §3.4）；错过补发、延迟标注沿用。
- **看板专属守卫**（宿主，不靠 UI）：cron 最小间隔 1 小时（`BOARD_CRON_MIN_INTERVAL_MS`），更密的拒绝；ISO 时间不得在过去（`validateWhen` 已有）。
- **时区**：事项 RPC 没有时区参数，cron 以核心进程时区计算；界面时间预设按本机时区编译。两者同机一致；若不一致（将来 headless），`describeScheduleWhen` 已能标出时区差异，沿用。
- **周期触发时上一次未交付**：每次触发是新的 `todo_runs`，派发文本末尾由宿主附「（上一次执行尚未交付）」；不跳过、不去重。同一 Bot 在该会话的邮箱串行处理；任务并发上限按卡（3）计。
- **深夜派发**：与 D90 一致，不拦截。免打扰时段记在 Bot 画像的 `behavior.quiet_hours`，不在设置目录里，时间弹层不在选中时预判；排期 RPC 返回的说明用 toast 显示。过密的 cron（`BOARD_CRON_TOO_FREQUENT`）在时间弹层里就地显示。

### 6.3 派发到卡片对话

- `TodoService.#targetOf`：看板事项返回 `{ conversationId: cardConversationId, leadBotId: null }`（不 `@`，卡片对话是单 Bot 会话）。`#dispatch` 追加的仍是 D90 的可见用户消息（`origin:'workbench'` + `todoId` / `todoRunId`），文本为 `【看板】{卡片文本}`（取代 `【工作台】标题 + 说明` 的拼法，避免首行重复）；`parseDispatchText` 与 `DispatchCard` 增识别该前缀，卡片线程里渲染成「任务派发」卡（不带「在工作台查看」链接）。
- 交付追踪、失败 / 取消回写、事项更新通知**原样复用**：卡片文本编辑（带 `actor='board'`）在进行中时触发 10 秒去抖的「事项更新」消息，进入同一条卡片线程。
- 项目里不再有「无人回应 / `unclaimed`」：卡片对话只有一位 Bot，失败 / 取消走 `failed`。

### 6.4 状态：派生显示（Q3）

分栏位置不影响状态，状态不影响分栏位置。卡面与弹框显示的状态由事项 / 执行记录 / 卡片对话的任务派生（复用 `effectiveStatus` / `blockedNotice`）：

| 条件 | 显示 | 色调 |
|---|---|---|
| 无指派 | 不显示 | — |
| `draft` + 已指派 | 待开始 | 中性 |
| `scheduled` | 已排期 · 下次 {时间} | sky |
| `in_progress` 且卡片对话有排队中的任务 | 排队中 · {原因，如「等写入租约」} | amber |
| `in_progress` | 执行中 | emerald |
| `delivered` | **待验收** | amber（需要你处理） |
| `done` | 已完成 | 中性，卡面整体降到 70% 不透明度 |
| `cancelled`（有过派发记录显示「已停止」） | 已取消 / 已停止 | 中性 |
| `draft` + `blocked_reason` | ⚠ {原因，如「执行成员已移出项目组」} | amber |
| 另加：卡片对话有待审批 / 任务在等用户回答 | 「待审批」「等你回答」徽标 | amber |

周期卡自身停在 `scheduled`，最近一次执行另显示（沿用 `effectiveStatus`）。

**弹框下栏的主操作**（沿用事项状态机，转移表不变）：

| 状态 | 主操作 | 其他 |
|---|---|---|
| 已指派未开始 | 开始执行（立即派发） | 设时间 → 已排期 |
| 已排期 | 改期 | 周期卡「立即执行一次」（`start`，保留周期）、清除时间 |
| 进行中 | — （在对话里沟通） | 取消执行 |
| 待验收 | **验收完成** | 退回追问（P1，见下）、取消 |
| 已完成 / 已取消 | 重新打开（回 `draft`） | — |

**退回追问（P1）**：D90 状态机允许 `delivered → in_progress`，但服务没有对应方法。新增 `board.cards.reject { cardId, note }`：宿主在卡片对话追加一条带新 `todoRunId` 的追问消息（`followUp` 标记），事项回到进行中并投递给 Bot；弹框用一个小弹层收集追问文字（不借用 Composer，避免再耦合）。没有它也不影响 P0：用户直接在对话里继续问，卡片停在「待验收」直到点「验收完成」。

**不自动完成**：Bot 说做完了不等于验收（D90 #6，业界做法一致）。

### 6.5 并发与写租约（Q6）

- 卡片对话各自独立：任务并发上限按卡（`TASK_CONCURRENCY_PER_CONVERSATION=3`）、全局 8；Bot 的单聊与各卡片对话并行（邮箱键含会话）。
- 同一工作目录同时仍只有一个写任务（D75）。多张卡同时派给不同 Bot 写同一目录会串行：任务停在 `queued`，`queueReason`=「等写入租约（任务 … 持有）」。**因为每卡一条会话，卡片对话的任务就是这张卡的任务**，卡面据此显示「排队中 · 等写入租约」，不需要新增事项 ↔ 任务的关联。
- 只读任务不取租约；写任务持租约到结束（默认最长 240 分钟）。用户需要并行写同一仓库时，这是已知限制，由路径作用域写租约（独立设计）解决（Q6）。

### 6.6 生命周期与级联

| 事件 | 处理 |
|---|---|
| 新建卡片 | 事务内：建事项（`draft`，`actor='board'`）+ 侧表行；不建会话 |
| 编辑卡片文本 | `todos.update`（`actor='board'`）+ 同步卡片对话标题；进行中触发事项更新通知 |
| 取消指派 | 清空指派 → 事项回 `draft`、排期取消（回执卡显示已取消）、卡片对话只读保留 |
| 换指派 | 旧会话只读、新会话（或复用同一 Bot 的旧会话）、排期在新会话重建 |
| 执行成员被移出项目 / Bot 被删 | 对账：指派清空、`draft` + `blocked_reason`、会话只读（§5.6 #6）；`lifecycle` 的移出 / 删 Bot 路径补调看板钩子 |
| 项目负责人变更 | 无影响（看板事项不依赖负责人） |
| 删除卡片 | 有会话 / 执行记录：确认框；否则直接删。流程：取消排期 → 删除其全部卡片对话（`lifecycle.deleteConversation`）→ `todos.purge`（FK 带走侧表行） |
| 删除分栏 | §5.3；非空须确认，连带删卡 |
| 删除项目组 | `board.onProjectDeleting`（§5.2）；确认框列出卡片数 / 其中已指派数 |
| 项目只读 | 看板整体只读（不可增删改拖、不可指派 / 排期）；仍可查看卡片对话 |
| Bot 移交（D88） | 看板排期不进移交清单，也不取消、也不清空指派（DEV-047）。移交没有把 Bot 移出项目组。清空指派、回 `draft`、写 `blocked_reason`、会话只读，只发生在移出成员和删除 Bot |
| 应用重启 | 排期 / 补发 / 对账沿用 D90；卡片对话与消息为普通持久数据 |

## 7 卡片对话：Bot 视角

### 7.1 提示词

`<conversation_info>` 增 `card` 分支（不再落入「项目组」文案），按 run 构建时拼装：

```text
对话类型：项目组「{项目名}」看板卡片对话（仅你与用户）
项目目标：{goal}                                    ← 非空才出现
卡片（{状态}，分栏「{分栏名}」）：
{卡片文本}
执行时间：{describeScheduleWhen}                    ← 有排期才出现
项目 wiki：{主题段}                                  ← 有内容才出现，不设预算
```

另加 `CARD_RULES`（写法参照 `PROJECT_MEMBER_RULES`，不写进 Profile、不用 `system_role`）：你是这张卡片的执行成员；用户可能在这里讨论思路、澄清需求，也可能由「看板」派发任务；收到派发后开始执行并给出明确结论，做不了就说明原因与需要什么；团队需要共享的结论用 `wiki_enqueue`（本对话默认写入项目 wiki）；你没有卡片编辑工具，需要改卡片时请用户在看板里改；其他成员看不到这条对话。卡片文本由用户写入，视为可信。

### 7.2 项目作用域解析（M6，Q9）

新增单一函数 `projectScopeOf(conversation) → projectId | null`：`project` → 自身 id；`card` → `parent_project_id`；其余 `null`。把下列「是否项目上下文」的判断点改为读它，**其余行为不改**：

| 判断点 | 行为 |
|---|---|
| wiki 默认 scope：`wiki.projectContext(conversationId)`（`wiki_search` / `wiki_read` / `wiki_enqueue`） | 卡片对话 → 所属项目，默认 `project` / `all`，含成员校验 |
| `<project_wiki_topics>` 注入（orchestrator） | 卡片对话注入所属项目的主题段 |
| 反思 loop 的 wiki 建议归属（`#wikiSuggestionOwner`） | 反思发生在卡片对话且该 Bot 仍是成员 → 项目 wiki |
| 记忆 origin（`memory/service.ts`） | `'project'`（Q9） |
| 记忆读取 / `warnPrivateOrigin` / `retrieve` 的 `isProject` | 同项目对话口径 |
| `<my_state>` 会话标签 | 「项目组卡片对话」 |
| 工作目录（`WorkdirRuntime.boundWorkdir`）与访问授权（`grants`） | 经所属项目解析；若授权查询点分散导致 v1 无法统一，退化为卡片对话内重新授权（审批卡在弹框内可见），并在任务书里记录 |
| 提示词的项目负责人 / 成员规则（`projectRole`） | **不适用**（卡片对话没有路由、没有负责人） |

对话中产生的内容对 Bot 记忆、项目 wiki 的影响，与 Bot 在项目里工作时一致；Bot 的人设、工具、知识、技能不变。

### 7.3 与单聊的差异

| | Bot 单聊 | 卡片对话 |
|---|---|---|
| 可见性 | 侧栏 | 仅弹框；不进侧栏 / 搜索 / 通讯录 |
| 路由 | 直聊投递闸口 | 同左 |
| 委派 `delegate_to_bot` | 有 | 无（v1） |
| 开箱引导 / 管家规则 | 按 Bot | 不适用 |
| 项目口径（wiki / 记忆 / 目录） | 否 | 是（§7.2） |
| 并行 | — | 与该 Bot 单聊、其他卡片对话并行 |

## 8 权限

- 读权限恒为项目组全员；`PROJECT_MODULES.board.write='lead'`（用户恒可写）。本期**只有用户**经界面写，RPC 调用方即用户；`BoardService` 的写方法统一过 `canWriteModule('board', actor)`，为将来负责人写入留缝（Q7）。
- **卡片对话仅用户与该 Bot 可见**，其他成员看不到（同 D9 / 单聊隔离）；对其他成员公开的只有卡片文本、分栏、指派与派生状态。
- Bot 不能改卡片、分栏、指派、时间；事项 / 管家工具对看板事项只读（`list_todos` 默认排除看板事项；`update_todo` / `close_todo` 返回 `BOARD_MANAGED`）。
- 派发回合 `triggerFromUser=false`：敏感写入仍出审批卡（用户可能不在场）；无人值守模式的自动批准规则不变。

## 9 界面

### 9.1 外壳集成

- 注册表翻转 `board` 为 `available`，顺序调整为 `chat, board, wiki, okr, calendar`（与 41 §11.2 示意图一致；`project-modules.test.ts` 逐字锁定，随改）。`shell.projectView` 联合类型已含 `'board'`；`ProjectView` 增 `{:else if view === 'board'}` → `ProjectBoardView`（薄壳，仿 `ProjectWikiView`）。
- **切 tab 会卸载看板**（只有沟通保持挂载）：看板状态存 store（`features/board/board.svelte.ts`，沿用工作台「挂载计数 + 订阅 + 200ms 去抖 / 1s 上限整体重拉 + 迟到响应序号丢弃」），滚动位置与打开的卡片 id 也进 store；编辑中的草稿靠卸载补存（§9.7）。`chat.select()` 收口时一并关闭弹框（同 `projectView` 重置不变式）。
- **徽标**：看板 tab 显示「未读 + 待审批 + 待验收」之和（读 `board.summary`，项目外壳挂载期间随卡片会话的 `message.created` / 审批 / `board.changed` / `todos.changed` 去抖刷新；实现仿 `project-chat-badge.ts`）。未读与待审批计当前打开的卡片会话；执行成员离开后，弹框仍能打开最近一条只读对话并标已读，这一条也计入。更早的只读历史没有入口，不计，避免留下清不掉的数字。卡面用同一条会话的 `unreadCount`；弹框标已读会同时清掉卡面和 tab。用户在沟通 / Wiki tab 时不会漏掉卡片里的审批。
- **通知 / 深链**：卡片对话的审批与回复通知，点击跳到「该项目 → 看板 → 打开该卡片」（不是 `showConversation`，后者会选中隐藏会话）。项目沟通里的 `DispatchCard` 不涉及（看板事项不派到沟通）。

### 9.2 看板布局与滚动不变式

```text
┌ 项目名                                            (头像堆叠)  ⚙ ┐ ← 现有顶栏
│ [沟通]  [看板 ●]  [Wiki]                                         │
├──────────────────────────────────────────────────────────────────┤
│ 待办 3            ＋ │ 进行中 2          ＋ │ 已完成 5        ＋ │ ＋ 添加分栏
│                      │                      │                    │
│ ┌──────────────────┐ │ ┌──────────────────┐ │ ┌────────────────┐ │
│ │ 调研竞品定价，…   │ │ │ 整理 Q4 报告      │ │ │ …              │ │
│ └──────────────────┘ │ │ ◉研究员 · 执行中  │ │ └────────────────┘ │
│ ┌──────────────────┐ │ │ 🕘 每周一 09:00   │ │       ↑ 分栏内部纵向滚动
│ │ …                │ │ └──────────────────┘ │                    │
│ └──────────────────┘ │                      │      ← 整体横向滚动 →
└──────────────────────────────────────────────────────────────────┘
```

高度链（`ProjectView` 的内容区是 `relative min-h-0 flex-1`，给足高度但不带 `overflow-hidden`，看板根自己负责）：

- 看板根：`h-full min-h-0 overflow-hidden`，内含**唯一**的横向滚动轨道 `flex min-h-0 flex-1 gap-6 overflow-x-auto overflow-y-hidden px-6 pt-4 pb-4`（页面本身不纵向滚动）；轨道里依次是「分栏拖拽区域」与「＋ 添加分栏」（结构见 §9.6）。
- 分栏：`flex h-full w-72 shrink-0 flex-col`；**头部 `shrink-0`**（标题、计数、新增钮、悬停才出现的拖动手柄与菜单，均预留位置避免布局抖动）；**卡片区 `min-h-0 flex-1 overflow-y-auto`**，是分栏内唯一的纵向滚动区。
- 轨道末尾是「＋ 添加分栏」幽灵项（在拖拽区域之外）；新增后滚动到可见并聚焦标题。
- 空分栏的卡片区保留 `min-h-16`，仍可落入；拖拽经过时由「影子项」占位（没有背景，落点必须靠线框表达，见 §9.6）。
- 窄屏最小宽约 375：分栏仍 `w-72`，靠横向滚动；可选 `scroll-snap-type: x proximity`（P1）。

### 9.3 分栏

- **无背景、无描边**，靠 `gap-6` 与标题区分；标题 `text-sm font-medium`，计数 `text-xs text-muted-foreground`。
- 标题是始终可编辑的 div（§9.7，单行，≤ 60 字）：点击出光标即可改，外观不变。
- 拖动手柄：标题左侧的 grip 图标（悬停显示，`cursor-grab`），标题文字区域**不参与**拖动；`⋯` 菜单（悬停显示）：左移 / 右移、删除分栏。右键标题行同菜单。
- 新增钮 `＋` 在头部右侧，固定不滚动。

### 9.4 卡面

极简：沿用现有卡片惯例 `rounded-lg border bg-card p-3 text-sm`，hover `bg-accent/40`，`role="button" tabindex="0"`（Enter / Space 打开）。

- 正文：卡片文本，最多 6 行（`line-clamp-6`，同备忘卡），`whitespace-pre-wrap break-words`，**只读**。
- 页脚仅在有内容时出现一行 `text-xs text-muted-foreground`：执行成员头像（`size-4`，`animated={false}`）· 派生状态词（§6.4，带色点）· 时间（时钟图标 + 人话，如「每周一 09:00」）。纯思路卡没有页脚。
- 徽标（amber）：未读点、「待审批」、「等你回答」、`blocked_reason` 警示。已完成 70% 不透明度。
- 卡面没有按钮：点击 / Enter = 打开弹框；拖动 = 整面起拖（库的起拖阈值 3px）；Space = 键盘起拖（§9.6）；右键菜单：移到分栏 ▸、上移 / 下移、删除。

### 9.5 新建卡片

分栏头部 `＋` → 在该栏**顶部**（分栏头部下方、卡片区上方，固定不随卡片区滚动，原因见 §9.6）出现一张空白行内卡（和普通卡同外观，只是正文区聚焦出现光标），不进入「表单模式」：

- Enter 提交（`Shift+Enter` 换行）；失焦时有内容则提交、空则撤销；Esc 撤销；提交后保持连续新建的焦点链（连续按 `＋` / 继续输入）。
- 提交才调用 `board.cards.create`；空文本永不落库；提交后该卡出现在卡片区顶部，卡片区滚回顶部。

### 9.6 拖拽（Q4：`svelte-dnd-action`）

采用 `svelte-dnd-action`（MIT、无传递依赖、纯 Svelte action，不需要额外构建配置）。

**依赖登记**

- `apps/desktop/package.json` 的 `dependencies` 加 `"svelte-dnd-action": "0.9.80"`，**精确锁定**（仓库规则不用 `^` / `~`），与 `bits-ui`、`svelte-sonner` 等渲染层库同处。命令：`pnpm --filter @kepcup/desktop add --save-exact svelte-dnd-action@0.9.80`。
- 兼容性（已拉取 0.9.80 核对）：peer `svelte >=3.23.0 || ^5.0.0-next.0`，本仓库 `svelte 5.57.1` 满足；包内无安装脚本，不动 `pnpm-workspace.yaml` 的 `allowBuilds`；0.9.80 发布于 2026-10-05，已超过 pnpm 默认的最小发布时长。
- 文档登记：[09-tech-stack.md](09-tech-stack.md) 前端表与 [dev/01-conventions.md](../dev/01-conventions.md) 技术栈表各加一行。因此它不属于 `docs/dev/README.md` 所说「文档未列出的新依赖」，无需记 DEVIATIONS。

**结构（嵌套区域，Svelte 5 写法 `onconsider` / `onfinalize`）**

```svelte
<!-- 轨道：唯一的横向滚动容器（库会自动滚它）；「＋ 添加分栏」在区域之外 -->
<div class="flex min-h-0 flex-1 gap-6 overflow-x-auto overflow-y-hidden px-6 pt-4 pb-4">
  <div class="flex h-full gap-6"
       use:dragHandleZone={{ items: columns, type: 'column', flipDurationMs, dropTargetStyle: {} }}
       onconsider={onColumnsConsider} onfinalize={onColumnsFinalize}>
    {#each columns as column (column.id)}
      <section class="flex h-full w-72 shrink-0 flex-col" aria-label={column.title}>
        <header> <span use:dragHandle aria-label="…" /> <InlineEditable … /> 计数 ＋ ⋯ </header>
        {#if composingIn === column.id}<NewCardComposer … />{/if}          <!-- 区域之外 -->
        <div class="min-h-16 min-h-0 flex-1 overflow-y-auto"
             use:dndzone={{ items: column.cards, type: 'card', flipDurationMs, delayTouchStart: true, dropTargetStyle: {} }}
             onconsider={…} onfinalize={…}>
          {#each column.cards as card (card.id)}<BoardCard {card} />{/each}
        </div>
      </section>
    {/each}
  </div>
  <AddColumn />
</div>
```

**库的约束与我们的对策**（已读 0.9.80 源码核对）

| 约束 / 行为 | 对策 |
|---|---|
| 区域容器**只能**含由 `items` 渲染出的子元素；每项须有唯一 `id`，`each` 以 `id` 为 key | 「＋ 添加分栏」与「新建卡片行内卡」放在区域容器**外**：行内卡固定在分栏头部与卡片区之间（不随卡片区滚动），提交后卡进卡片区顶部并把卡片区滚回顶部（§9.5 的「顶部」即此处） |
| 两级区域用 `type` 隔离 | 分栏 `type:'column'`、卡片 `type:'card'`，互不串 |
| `consider` 期间区域 items 里带**影子项**（`isDndShadowItem` 标记，`id` 为 `SHADOW_PLACEHOLDER_ITEM_ID`） | 渲染层容忍影子项（不渲染依赖真实数据的控件）；**`consider` 只更新本地 items，绝不发 RPC** |
| 起拖阈值 3px，未超阈值仍是普通 click | 点击 = 开弹框保持不变；拖动结束后可能有落在别处的 click，`finalize` 后 120ms 内忽略卡片 click（兜底） |
| 不在 `contenteditable` / 输入元素上起拖（源码对 `e.target.isContentEditable` 直接放行） | 分栏标题、新建卡片的行内编辑与拖动天然不冲突；分栏仍用 `dragHandleZone`，**只能**经头部 grip 起拖（库把分栏区域的 `zoneItemTabIndex` 强制为 `-1`） |
| 键盘起拖默认 Space **和 Enter**，Enter 会被库截获 | 全局 `setKeyboardDragTrigger('space')`：Enter 不再被截获，保持「打开弹框」；Space 起拖 / 放下，方向键移动（上下 = 同栏，左右 = 相邻分栏），Esc 退出；来自 `button` / `a` / `contenteditable` 子元素的按键库不处理 |
| 屏读播报 | 区域与每一项设 `aria-label`（分栏标题、卡片首行）；`setAriaStrings` 提供中文播报文案 |
| 自动滚动：对区域的**所有可滚动祖先**（computed `overflow` 含 `auto` / `scroll`）在指针靠近边缘时滚动 | 横向 = 轨道容器，纵向 = 当前分栏卡片区；二者必须是 `overflow-x-auto` / `overflow-y-auto`（§9.2 的高度链已满足）；e2e 覆盖「拖到边缘会滚动」 |
| 触屏易把滚动误判为拖动 | 卡片区域 `delayTouchStart: true`（80ms）；触屏 **v1 即可用**（原 P1 项取消） |
| 默认给目标区域画黄色 outline | `dropTargetStyle: {}` 关闭；落点只靠影子项表达 |
| 库不处理**指针**拖动中的 Esc | 指针拖动的取消 = 松手在任何区域之外（`DROPPED_OUTSIDE_OF_ANY`，列表还原）；键盘拖动 Esc 退出；不为此另写 |
| `dragHandleZone` 内部用模块级 store | 同一时刻只有一次拖动，无影响；区域随看板视图卸载而销毁 |
| Svelte 5：0.9.58 对 `$state` 条目有坑 | 用 0.9.80；传给区域的 items 仍用 `$state.raw` + 整体替换（直接赋值 `e.detail.items`），不传深层 `$state` 代理 |
| TS：Svelte 5 模板里的 `onconsider` / `onfinalize` 需要类型声明 | 库导出 `DndZoneAttributes`；若 `svelte-check` 报未知属性，在 renderer 的 `.d.ts` 里对 `svelte/elements` 的 `HTMLAttributes` 做模块扩展 |

**提交语义**（纯函数 `board-dnd.ts`，单测）

- 卡片：只在 `info.trigger === DROPPED_INTO_ZONE` 的区域（目标区域；同栏重排也是它）里提交：取 `info.id` 在 `e.detail.items` 中的下标，其后第一个非影子项的 id 即 `beforeCardId`（没有 = `null`）→ `board.cards.move { cardId, columnId, beforeCardId }`。`DROPPED_INTO_ANOTHER`（来源区域）只更新本地；`DROPPED_OUTSIDE_OF_ANY` 回滚。分栏同理 → `board.columns.move`。
- 落回原位不发请求。
- 乐观：`finalize` 先把本地列表写回 store，再发 RPC；失败回滚并 toast；同缝重排的返回行整体替换（§5.4）。`board.changed` 事件在拖动进行中（`consider` 到 `finalize` 之间）延后应用。
- 键盘每挪一步触发一次 `finalize`：RPC 串行排队并合并为「最后一次位置」，避免连发。

**视觉**（极简、无背景）：影子项用 `[data-is-dnd-shadow-item-internal]` 选择器统一为「同尺寸、虚线描边、无填充」；被拖起的浮层副本（`#dnd-action-dragged-el`）加 `shadow-md opacity-90`；`flipDurationMs` 取 150，`prefers-reduced-motion` 时取 0。

**非拖拽入口**：右键菜单「移到分栏 ▸」「上移 / 下移」、分栏 `⋯` 菜单的「左移 / 右移」继续保留（不依赖库，屏读与键盘用户的第二条路）。

**回退方案**：若 `svelte-dnd-action` 在「嵌套区域 + 两个滚动容器 + Svelte 5」下出现无法绕过的问题，回退自研 Pointer Events（沿用侧栏分组重排的写法）；`board-dnd.ts` 的「落点 → 锚点」纯函数与 store 的乐观更新可原样复用。

### 9.7 行内编辑规范（弹框文本、分栏标题、新建卡片共用）

实现为一个共用的 `InlineEditable`（`contenteditable="plaintext-only"`），防抖与 IME 复用 `AutoSaveField` 的思路（`MemoCard` 先例）。

| 规则 | 说明 |
|---|---|
| **编辑时 UI 无变化** | 无边框 / 背景 / 阴影变化，无「编辑态」切换，只有光标（`caret-color`）；点击内容区即出光标 |
| 保存 | 输入防抖 600ms（分栏标题 400ms）；失焦、关闭弹框、切 tab / 卸载时**立即补存**；保存飞行中的新输入保证再来一轮 |
| IME | 组合期间（`compositionstart` … `compositionend`、`isComposing`、`keyCode===229`）不调度、blur 推迟到组合结束再保存 |
| DOM 回写 | 编辑中（聚焦或有未保存改动）**不**用服务端值重写 DOM；未聚焦时才同步外部变化；直接写 `textContent` 避免 Svelte 重绘打断光标（`MemoCard` 同法） |
| 空值 | 卡片文本 / 分栏标题清空：不保存，失焦回退到上次保存值 |
| 单行 | 分栏标题：Enter = 失焦并保存；粘贴里的换行替换为空格；`maxLength` 截断 |
| 多行 | 卡片文本：Enter 换行，`white-space: pre-wrap`；保存时才规整换行与 `\u00a0`，不动实时 DOM |
| Esc | 弹框内的文本：不拦截（交给弹框关闭）；分栏标题：还原并失焦，且 `preventDefault()`（遵守 `escape-layers` 契约） |
| 失败 | toast，保留草稿，不在用户还在输入时回滚 |
| 多处更新 | `board.changed` 带来的更新，在聚焦且有未保存改动时忽略；保存回包为准 |

### 9.8 卡片详情弹框

```text
┌───────────────────────────────────────────────────────────────────────┐
│ 任务详情                                                  (◉研究员) ✕ │ ← 上工具栏
├───────────────────────────────┬───────────────────────────────────────┤
│ ┌───────────────────────────┐ │ ┌─ 消息列表（复用单聊 MessageList）───┐ │
│ │ 调研竞品定价，输出一页对比表│ │ │  【看板】调研竞品定价…（派发卡）    │ │
│ │ （始终可编辑，只出光标，    │ │ │  研究员：已查到 3 家…               │ │
│ │  内容变化自动保存）         │ │ │  ┄ 审批卡 / 状态行（复用）          │ │
│ └───────────────────────────┘ │ ├─ Composer（复用）───────────────────┤ │
│ 执行记录                       │ │ 就这张卡片与 研究员 沟通…           │ │
│  · 10-25 09:00  已交付  ›      │ └─────────────────────────────────────┘ │
│  · 10-18 09:00  已交付  ›      │                                         │
├───────────────────────────────┴───────────────────────────────────────┤
│ 🕘 每周一 09:00 ▾   ● 待验收   下次 11-01 09:00   创建 10-20      [验收完成] │ ← 下工具栏
└───────────────────────────────────────────────────────────────────────┘
```

- **容器**：`Dialog`，`sm:max-w-5xl`（必须带 `sm:` 前缀，否则被基类 `sm:max-w-sm` 压住）、高度 `min(80vh, 720px)`、`gap-0 overflow-hidden p-0`，自带关闭钮（`showCloseButton={false}` 自绘，同 `TodoDrawer`）。三段结构：上下工具栏 `shrink-0 border-b / border-t px-4 py-3`，中部 `min-h-0 flex-1`，左右两栏**各自**纵向滚动。
- **上工具栏**：左「任务详情」`text-sm font-medium`；右侧执行成员头像（点开 §6.1 的成员菜单；无指派显示虚线圆形「＋」）+ 关闭。
- **左栏上方**：文本卡片（`InlineEditable`，多行，同卡面字号），始终可编辑。左栏下方：**执行记录**（`todo_runs`：派发时间、状态、「›」跳到对话里那条结果消息），无记录时不渲染。
- **右栏**：卡片对话（§11 的 `ChatSession(cardConversationId)`）——消息列表、审批坞、状态行、Composer、只读横幅都是单聊现有组件。未指派且没有可打开的对话：居中一行说明「指派一位成员后，可在这里就这张卡片与 TA 沟通」。用户主动取消指派走这行空态（会话只读保留，不在弹框里重开）。执行成员被移出或 Bot 被删（`blocked_reason`）：右栏重开最近一条只读卡片对话，沿用只读横幅，不把它显示成可写对话；更早的执行成员对话仍不能切换。已指派未发过消息：Composer 占位「就这张卡片与 {名字} 沟通…」。弹框内点任务卡，在右栏显示 `TaskRunView`（带返回），不替换主区。Esc 时审批卡和输入框先消费，打开的任务过程页先回到对话，然后才关弹框。
- **详情字段**（metadata，同时是入口）：状态（`deriveCardStatus`；未指派但先定了时间显示「待指派 · 时间」）、执行者菜单、执行时间（`CardWhenPopover`：菜单「现在 / 某时 / 重复」，点开后两项切到对应字段；「现在」需要先有执行者）、「下次」、创建时间；主操作（§6.4 表）跟在状态行右侧。时间不再要求先指派：未指派先定的时间停在 `pendingWhen`，指派后自动落成排期。
- **窄容器**（弹框宽 < 760px）：中部改为「详情 / 对话」两个 tab，tab 上带未读点。
- **焦点与键盘**：打开时焦点在弹框容器（不抢文本光标）；Esc 关闭（输入框与审批卡内 Esc 先被它们消费）；关闭前补存文本。
- **弹框外**：沿用 `inert` 处理背景。

### 9.9 样式约定（对齐现有应用，走极简）

- 颜色只用 token（`bg-card`、`text-muted-foreground`、`border`、`bg-accent/40`），状态色沿用 `TodoCard` 的 `{sky|emerald|amber}-500/10 + 700/400` 配色；层次靠描边与留白，不用阴影（浮层副本、弹层除外）。
- 字号 `text-sm`（正文）/ `text-xs`（次要）；头像 `size-4`（卡面）/ `size-5`（成员菜单）/ `size-6`（弹框顶栏）。
- 可点元素 `cursor-pointer`；按钮用现有 `Button` 变体（`ghost` 图标钮 `size="icon-sm"`、主操作 `size="sm"`）。
- 所有文案走 i18n（`board.*`，`zh-CN` 与 `en-US` 键顺序必须一致，`locales.test.ts` 强制）。

## 10 RPC 与事件

shared 契约（先 `pnpm --filter @kepcup/shared build`）；方法同时登记到 `rpcMethodSchemas` 与 `APP_METHODS`。

| 方法 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `board.get` | `{ projectId, seedTitles? }` | `{ columns, cards }` | 无分栏且带 `seedTitles` 时同事务播种 |
| `board.summary` | `{ projectId }` | `{ unread, pendingApprovals, delivered }` | tab 徽标 |
| `board.columns.create` | `{ projectId, title, beforeColumnId? }` | `{ column }` | |
| `board.columns.update` | `{ columnId, title }` | `{ column }` | |
| `board.columns.move` | `{ columnId, beforeColumnId }` | `{ columns }` | `null` = 末尾；必要时整体重排 |
| `board.columns.delete` | `{ columnId, deleteCards? }` | `{}` | 非空须 `deleteCards:true`；最后一栏拒绝 |
| `board.cards.create` | `{ projectId, columnId, text, beforeCardId? }` | `{ card }` | 默认放顶部 |
| `board.cards.update` | `{ cardId, text }` | `{ card }` | 触发事项更新通知（进行中） |
| `board.cards.move` | `{ cardId, columnId, beforeCardId }` | `{ card, renumbered? }` | |
| `board.cards.assign` | `{ cardId, botId }` | `{ card, warnings }` | `null` = 取消指派；`ensureCardConversation` |
| `board.cards.schedule` | `{ cardId, when }` | `{ card, warnings }` | `'now'` / ISO / cron / `null` |
| `board.cards.start` / `complete` / `cancel` / `reopen` | `{ cardId }` | `{ card }` | 沿用事项转移 |
| `board.cards.reject`（P1） | `{ cardId, note }` | `{ card }` | 退回追问 |
| `board.cards.delete` | `{ cardId }` | `{}` | §6.6 |
| `board.cards.conversation` | `{ cardId }` | `{ conversationId }` | 已指派而缺会话时补建（幂等） |

```ts
BoardCard = {
  id, projectId, columnId, position, text, createdAt, updatedAt,
  todo: { status, blockedReason, source, assignee: { botId, name } | null,
          schedule: TodoEntry['schedule'], lastRun: TodoRun | null },
  conversationId: string | null,                    // 当前执行成员的卡片对话
  unreadCount: number, pendingApprovals: number,
  task: { running: number, queued: number, queueReason: string | null, awaitingInput: boolean } | null,
}
```

事件：新增 `board.changed { projectId, cardId?, columnId? }`；复用 `todos.changed`、`message.created`、`run.status`、审批事件（仅当 `conversationId` 属于某张卡片时，store 去抖刷新该卡片投影）。`conversations.list` / `conversations.all` 不返回 `card`；也**不**新增通用的「打开卡片对话」RPC——卡片对话只经 `board.cards.conversation` 取得，其读写仍走既有的 `messages.*` / `runs.*` / `tasks.*`（按 conversationId）。

## 11 渲染层：`ChatSession` 抽取（前置重构，行为中性）

**目标**：`chat.svelte.ts` 里属于「当前会话」的状态（消息、`activeRuns`、`failedRun`、`hasEarlier`、`members`）与按「当前」路由的事件处理，抽成以 `conversationId` 为键的 `ChatSession`；`chat` 持有 `main`（即现在的 current），组件经 context 取 session。

1. **抽 `ChatSession`**：加载（`conversations.get` + `messages.list` + `runs.list` + `tasks.loadActive` + `permissions.reloadApprovals`）、事件路由（`message.created` / `message.updated`、`run.status` / `run.progress`、`bot.updated` 按 conversationId 分发）、`replyTo`、`gateForSend(session)`、`markRead(session)`、`loadEarlier`、`retryRun`。
2. **`chat.select()`** 只做「导航副作用 + `main.open(id)`」（`shell.showChats`、`saveLastConversationId`、`projectView` 重置、`tasks.closeDetail`、`cancelProjectCompose`、`#startSparseInterview`），加载交给 session；弹框**不**调 `select()`。
3. **组件改读 `getChatSession()`**（默认 `chat.main`）：`MessageList`、`Composer`、`ChatMessageRow`、`MessageBody`、`TaskCard`、`settings-card` 三件（`SettingCard` / `SettingSetupBody` / `open-deep-link`）、`ScheduleCard` / `ScheduleReceipt`、`BotWidgetCard`、`WidgetViewer`、`FileViewer`。`ChatView` 里的横幅（只读、确认模式、失败重试）抽成可复用片段。
4. **任务过程页**：`tasks.openTaskId` 改为 session 级 `openTask`；主区读 main 的，弹框读卡片会话的；`tasks.loadActive` 与 `permissions.loadForConversation` 不再用「单个当前会话」的全局槽位。
5. **门禁与类型**：`chat/send-gate.ts`、`chat/conversation-bot.ts`、`ChatView` 里的 `!== 'direct'` 改为「单 Bot 会话（`direct` 或 `card`）」判断。
6. **防泄漏**：`chat.#upsertConversation` / `contacts` 对 `conversation.updated` 忽略 `card`。

**验收**：零可见变化；既有 chat / project-shell / approvals / group 相关单测与 e2e 全绿。已按 conversationId 键控、可原样复用的：`composerDrafts`、`permissions.approvals` + `ApprovalDock`、`ProjectTurnStatusLine`、`tasks.byId`。

## 12 分期与任务拆分

范围分级：**P0** = 本期必须；**P1** = 本期尾部或紧随；**P2** = 之后。

| 级别 | 内容 |
|---|---|
| P0 | 分栏 / 卡片增删改拖、行内编辑、指派、时间 / 周期、卡片对话、状态追踪、审批 / 未读徽标、级联、窄屏可用 |
| P1 | 退回追问；工作台联动（已指派的看板事项在工作台显示「看板」徽标并跳到卡片，P0 期间 `todos.list` 默认排除看板事项）；历史执行成员对话（只读查看）；`<project_board>` 摘要段进项目提示词（触屏拖拽由 `svelte-dnd-action` 的 `delayTouchStart` 在 P0 即提供） |
| P2 | Bot / 负责人写看板（读写工具、`untrusted` 包裹）；分栏自动化（分栏绑定状态）；归档；路径作用域写租约；标签 / 截止日期等 |

| WP | 内容 | 依赖 | 体量 |
|---|---|---|---|
| WP0 | `ChatSession` 抽取（§11）——渲染层，行为中性 | — | 大 |
| WP1 | shared 契约（域类型、RPC、事件、`BOARD_*` 常量、`deriveCardTitle`、注册表翻转 + 顺序）；迁移（仅看板表；`conversations` 重建归 WP2）；`BoardStore` / `BoardService`（分栏 / 卡片 / 排序 / 播种 / 级联）；RPC；`lifecycle` 钩子；`TodoService` 缝（`BOARD_MANAGED` 守卫、`list` / 摘要排除看板事项、`TodoEntry.board`） | — | 中 |
| WP2 | 卡片对话与执行接线：迁移（`conversations` 重建，`foreign-keys=off`）；`ConversationsService.openCard` + 列表 / 事件过滤；`projectScopeOf` 收口（§7.2）；`<conversation_info>` card 分支 + `CARD_RULES`；`#targetOf` / `#dropExecutor` / `#validateAssignee` / 派发文本 / 交付追踪 / 对账适配；指派、排期、start / complete / cancel / reopen；cron 下限守卫 | WP1 | 大 |
| WP3 | 看板 UI：外壳接入、`BoardView` / `BoardColumn` / `BoardCard`、`InlineEditable`、新建卡片、拖拽（引入 `svelte-dnd-action@0.9.80`；嵌套区域 + `board-dnd.ts` 纯函数）、store（乐观更新 + 序号丢弃） | WP1 | 中 |
| WP4 | 卡片弹框：三段式、成员菜单、时间弹层、对话区（接 `ChatSession`）、状态操作、执行记录、窄容器 tab | WP0、WP2、WP3 | 中 |
| WP5 | 集成与收口：tab 徽标（`board.summary`）、通知 / 深链、文案、e2e、文档同步 | WP4 | 小 |

**执行阶段**（每阶段一份执行方案，见 [todo/project-board/](../../todo/project-board/README.md)；每阶段收口跑一次全量）：

| 阶段 | 内容 | 包含 WP | 交付 |
|---|---|---|---|
| 阶段一 | 看板骨架：契约、迁移、`BoardService`、看板 UI、拖拽、行内编辑（还没有执行能力） | WP1、WP3 | 可用的单看板（梳理思路工具） |
| 阶段二 | 卡片对话与执行：`ChatSession` 抽取、`card` 会话、项目作用域、指派 / 排期 / 派发接线 | WP0、WP2 | 后端与渲染层基础就绪（无新入口，集成测试验证） |
| 阶段三 | 卡片弹框与收口：详情弹框、对话区、徽标、通知、e2e、文档 | WP4、WP5 | 完整功能 |

依赖：WP0 与 WP1 互相独立，可并行；WP3 只依赖 WP1（不含执行能力时即可联调看板本身）；最大两块是 WP0 与 WP2。每个 WP 一份任务书（`todo/project-board/`），WP0 单独成提交并先跑聊天相关回归。

## 13 测试方案

先定向后全量（[AGENTS.md](../../AGENTS.md)）。改了 shared 契约与迁移，收口跑**一次**全量。

| 层 | 用例 |
|---|---|
| shared | `deriveCardTitle`（首个非空行、截断、空白）；`PROJECT_MODULES` 顺序与状态；RPC / 事件契约与 `APP_RPC_METHODS` 包含断言；`canWriteModule('board', …)` 表驱动 |
| 迁移 | `conversations` 重建后三类型 CHECK（`card` 缺所属项目 / 卡片 / Bot 被拒）；唯一索引每卡至多一条在用；既有 direct / project 行原样保留；看板表 FK 与级联 |
| core 看板 | 播种默认栏、最后一栏不可删；分栏 / 卡片移动的锚点与整体重排（间隙耗尽）；文本空值 / 超长；删栏带卡须确认；上限 |
| core 执行 | 指派建会话 + 排期落在卡片对话；换指派（旧只读 / 新建 / 复用同 Bot）；锁（进行中不可换人）；cron 下限；派发文本 `【看板】`、追加「上一次未交付」；交付追踪 / 失败 / 取消；成员被移出 / Bot 被删 → 指派清空 + 只读；项目只读；文本编辑触发事项更新通知；`BOARD_MANAGED` 守卫；`todos.list` / 管家摘要排除看板事项 |
| core 级联 | 删卡 / 删栏 / 删项目：卡片对话、排期、`runs.db`、FTS、事项、侧表行全部清理，不依赖 FK |
| 项目作用域 | `projectScopeOf` 全表；卡片对话下 wiki 默认 scope、`<project_wiki_topics>`、记忆 origin、反思建议归属、工作目录；`<conversation_info>` card 分支快照；卡片对话不进 `conversations.list` / 事件 |
| 渲染纯逻辑 | `board-dnd.ts`（`consider` / `finalize` 载荷 → `{ columnId, beforeCardId }` 锚点、影子项过滤、无变化判断、触发类型分流）、`board-model.ts`（状态派生、投影）、`InlineEditable` 的保存调度（防抖 / IME / 空值 / 卸载补存，仿 `autosave-field.svelte.test.ts`）、`project-tabs` 顺序与 `shell-project` |
| e2e `project-board.spec.ts` | ①播种、新建 / 改名 / 删除分栏；②新建卡片（Enter / 失焦 / Esc）；③弹框改文本，防抖后重开仍在；④拖卡片（同栏 / 跨栏）与分栏重排（经头部 grip），刷新后顺序保持；拖动结束不会误开弹框、普通点击仍开弹框；Space 键盘起拖移动、Enter 仍开弹框；拖到边缘时轨道 / 分栏卡片区自动滚动；⑤**布局不变式**：页面不纵向滚动、分栏头部固定、分栏内纵向滚动、轨道横向滚动；⑥指派 + 时间 → 排期出现在项目详情「定时与监看」；⑦卡片对话收发（mock LLM）、与该 Bot 单聊互不串；⑧审批出现在弹框与 tab 徽标；⑨换指派得到新会话、旧会话只读；⑩删卡 / 删项目级联；⑪窄屏（容器 < 760 → tab） |
| 回归 | 单聊 / 项目沟通 / 工作台 / 设置卡 / 记忆 / wiki 既有用例；`project-shell.spec.ts` 里把 board 从「应为 0」的断言移出 |

## 14 对现有文档与代码的影响（定稿时同步）

| 位置 | 改动 |
|---|---|
| [41](41-project-team.md) | §10.1 注册表 `board` 状态 / 顺序；§10.3 看板行指向本文并**修正 K8**（「列 = 状态」→ 自由分栏 + 派生状态）；§9.2 / §17.9 注明路径作用域写租约不再是看板前置；已先加一句指针 |
| [39](39-workbench.md) | 非目标里的「不做看板视图」改指本文；事项增「看板事项」概念（`TodoEntry.board`、`BOARD_MANAGED`、`list` 默认排除）；§4.2 抽屉对看板事项的处理 |
| [12](12-ui-layout.md) | 项目组外壳加看板 tab 与弹框；卡片对话不进侧栏 |
| [01](01-conversation.md) | 会话类型增 `card`（隐藏、仅弹框） |
| [04](04-memory.md) / [05](05-wiki-and-skills.md) | 项目作用域解析（`card` 视同项目）；wiki 默认 scope 注明 |
| [30](30-supervisor-and-tasks.md) | 卡片对话作为任务的会话；`queueReason` 在卡面显示 |
| [09-tech-stack](09-tech-stack.md) / [dev/01-conventions](../dev/01-conventions.md) | 前端依赖表加 `svelte-dnd-action`（看板拖拽，Q4；精确锁定 0.9.80） |
| README | 索引行与决策记录（D103，已登记） |
| dev/03-data-model | `board_columns`、`board_cards`、`conversations` 新列 / 类型、删除级联表 |
| 代码核对清单 | 凡按 `type === 'direct'` / `directBotId` / `type === 'project'` 判断的位置逐处过一遍：`orchestrator`（投递分支、setup 答复、wiki 主题注入、`projectRole`）、`system-prompt`、`wiki-tools` / `wiki.projectContext`、`jobs-runner`、`memory/service.ts` / `retrieve.ts` / `my-state.ts`、`delegation`、`share/service`、`handover/adapters`、`lifecycle`（Bot 删除 / 成员移出 / 会话删除）、`contacts` / `chat` 的 upsert、`send-gate.ts` / `conversation-bot.ts` |

## 15 风险与取舍

1. **`ChatSession` 抽取波及面大**（十余个组件 + 事件路由）。对策：WP0 单独提交、行为中性、先跑聊天 / 项目 / 审批相关回归；不与看板功能混在同一提交。
2. **`conversations` 枢纽表重建**：同 41 §17.2，按 0040 写法并加迁移测试。
3. **项目口径判断点分散**：漏改一处 = 卡片对话在那一处按「单聊」表现（wiki 落到个人库、记忆 origin 为 private）。对策：`projectScopeOf` 收口 + §13「项目作用域」专测 + §14 代码核对清单。
4. **事项服务被复用而非新写**：看板事项带来的特例（`#targetOf`、`#dropExecutor`、`BOARD_MANAGED`、`list` 过滤）都在 `TodoService` 内，要保证不改变既有事项行为；对策：特例以「是否存在侧表行」为唯一开关，既有工作台测试原样通过。
5. **隐藏会话泄漏进侧栏**：`conversation.updated` 事件是盲 upsert，且审批通知曾调用 `showConversation`。对策：核心侧列表过滤 + 渲染层 upsert 显式忽略 `card` + 通知按类型改走卡片深链（§9.1）。
6. **审批被漏**：派发回合永远不是用户触发，必然有审批；用户在沟通 / Wiki tab 时只能靠徽标发现。对策：看板 tab 徽标 + 卡面徽标 + 通知；无人值守模式规则不变。
7. **写租约串行**：多卡同时写同一目录会排队，已用「排队中 · 等写入租约」可视化；根治靠路径作用域写租约（独立设计，Q6）。
8. **第三方 DnD 库的适配风险**：`svelte-dnd-action` 的影子项与 Svelte 响应式、嵌套区域、两个滚动容器、`$state` 条目、点击与拖动共存、Enter / Space 键位。对策：§9.6 的逐条对策（已读 0.9.80 源码核对）；items 用 `$state.raw`；`consider` 不发 RPC；`setKeyboardDragTrigger('space')`；拖动结束后短暂忽略 click；e2e 覆盖点击 / 拖动 / 键盘 / 边缘滚动；单一维护者的库——精确锁定版本，升级单独评估；回退为自研 Pointer Events（`board-dnd.ts` 与 store 乐观更新可复用）。
9. **`position` 浮点耗尽**：间隙 < 1e-3 即整栏重排，同事务完成；单测覆盖连续同缝插入。
10. **周期卡堆积**：上一次未交付时下一次照发，邮箱串行、任务按卡限流；对策：派发文本带「上一次未交付」，Bot 自行判断；卡面显示「执行中 / 待验收」。
11. **单聊口径的记忆泄漏 vs 项目口径的外溢**（Q9）：卡片里讨论的内容会以 `origin='project'` 进入 Bot 记忆，之后可在项目沟通里被用到。这是「项目内工作」的预期语义；若你希望隔离，改为 `private` 即可（只改 `projectScopeOf` 里记忆一条）。
12. **D88 移交 / Bot 删除对看板排期的处理**依赖现有适配器行为，实施时先核对（§6.6）。

## 16 非目标

子任务；标签、多成员、截止日期、清单、附件、评论；多看板；卡片复制 / 模板；跨项目视图（工作台已承担）；Bot 或负责人写看板（P2）；分栏自动化与按状态自动挪卡（P2）；归档（P2）；路径作用域写租约（独立设计）；卡面行内编辑（Q5）；多用户 / 云同步；看板内的全文搜索 / 筛选（P2）。

## 附录：调研来源

- Trello 新卡背（左详情右评论与活动，约 940px 堆叠）：[Atlassian Support · New card back](https://support.atlassian.com/trello/docs/new-card-back/)、[社区讨论](https://community.atlassian.com/forums/Trello-questions/Trello-Cards-changed-Comments-on-right-side-instead-of/qaq-p/3040684)
- 排序：[Trello: ordering that survives dragging](https://theoven.app/docs/projects/trello/ordering/)、[Design Trello or Jira: Frontend System Design](https://completefrontend.com/system-design/problems/trello-jira)、[Design a drag-and-drop reorderable list](https://completefrontend.com/system-design/problems/drag-drop-list)、[Worked scenario: Design a Kanban board](https://academy.aniui.dev/courses/system-design/design-a-kanban-board)
- 拖拽体验与状态：[Drag and Drop in React: Kanban Boards and Sortable Lists](https://21st.dev/blog/react-kanban-drag-drop-components)
- 拖拽库：[svelte-dnd-action](https://github.com/isaacHagoel/svelte-dnd-action/)（[npm](https://www.npmjs.com/package/svelte-dnd-action)、[release notes](https://github.com/isaacHagoel/svelte-dnd-action/blob/master/release-notes.md)）、[Pragmatic drag and drop](https://atlassian.design/components/pragmatic-drag-and-drop/comparison)
- AI 代理看板：[buzzboard](https://github.com/oloapiu/buzzboard)（代理不自行关闭自己的活）、[AgentCenter](https://www.jagodana.com/work/agentcenter)、[Akievo](https://akievo.com/agent-workspace)、[Vibe Kanban Workspaces](https://vibekanban.com/docs/workspaces)
- `contenteditable`：[MDN · contenteditable](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/contenteditable)、[W3C ContentEditable](https://w3c.github.io/contentEditable/)、[IME composition and the commit boundary](https://bblog-theta.vercel.app/en/knowledge/browser/ime-composition-commit-boundary)、[contenteditable scenarios](https://contenteditable.realerror.com/scenarios/)
- 极简看板：[How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui)
