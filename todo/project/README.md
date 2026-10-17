# 项目组（Project）实施编排 · 总览

> 状态：**已定稿，待实施**（设计 [docs/design/41-project-team.md](../../docs/design/41-project-team.md)，决策 **D92**；2026-10-17 与用户逐项确认，决策表 K1–K18）。
> 本目录是给**执行智能体**的任务书：每个工作包（WP）是一份可独立交付的说明。**先读本文件，再读你被分配的那个 WP。**
> 早期阶段：不做向后兼容、不迁旧数据、允许大规模改名与重构；一切以语义准确、逻辑正确为准。

## 0. 一句话目标

把「群聊」升级为「**项目组**」：一个目标 + 一位必有的**负责人** + 若干成员 + 一组协作模块（沟通 / 看板 / Wiki / OKR / 日历）+ 一个共享**工作目录**。本期交付：改名、项目组核心（数据模型、路由、协作回合、界面外壳）、项目 wiki；看板 / 日历 / OKR 下期。

## 1. 给执行智能体的规则（必读，违反任何一条都会返工）

### 1.1 阅读顺序

1. 本文件（尤其 §4「固定契约」）。
2. 你的 WP 文件。
3. WP 里「必读」列出的设计文档章节与源码文件。
4. [AGENTS.md](../../AGENTS.md)、[docs/dev/01-conventions.md](../../docs/dev/01-conventions.md)、[docs/dev/05-testing.md](../../docs/dev/05-testing.md#开发中如何跑测试)。

### 1.2 不得自行决定的事（名字、形状、数值都以 §4 为准）

- **所有标识符名称**（表名、列名、类型名、RPC 方法名、事件名、触发原因、常量名、工具名、i18n key、`data-testid`、文件名）以本文件 §4 为准，**一个字母都不要改**。§4 没有写到的新名字，按相邻已有命名风格取，并在你的 WP 末尾「实施记录」里登记。
- **行为**以 WP 与设计文档 41 为准。WP 与 41 冲突 → **以 WP 为准**（WP 是更晚、更具体的版本），同时在 DEVIATIONS 记一条。
- 旧设计文档（01 / 02 / 05 / 08 / 12 / 19 / 27 / 30 / 38 / 39 等）里与本项目冲突的描述**已过时**，文件顶部已加「D92 修订」提示；以提示和 41 为准。

### 1.3 你有自由度的地方

- 函数内部实现、私有辅助函数命名、测试夹具写法。
- 文件内的代码组织（遵循相邻代码风格）。
- WP 里写「由你核对 / 由你判断」的地方——但必须在实施记录写下你的判断依据。

### 1.4 测试规则（AGENTS.md 的具体化）

- **迭代中只跑相关测试**：`node scripts/run-tests.mjs run <测试文件或目录>`（可加 `-t "用例名"`）；单包：`pnpm --filter @kepcup/core test`（`shared` 同理）；desktop 单测：`node scripts/run-tests.mjs run --project desktop`。
- 类型检查：`pnpm --filter @kepcup/shared typecheck`、`pnpm --filter @kepcup/core typecheck`、`pnpm --filter @kepcup/desktop typecheck`。**改了 shared 之后，core 与 desktop 读的是 shared 的编译产物**：先 `pnpm --filter @kepcup/shared run build`，改了 core 之后 desktop 要先 `pnpm --filter @kepcup/core run build`（根目录 `pnpm typecheck` 已按序做这两步）。
- e2e：`pnpm build` 之后 `pnpm --filter @kepcup/desktop test:e2e test/e2e/<spec>.spec.ts`。
- **全量 `pnpm test` 只在两种情况跑一次**：WP 收口（你的 WP 写了「收口跑全量」）；改了 shared 契约 / 迁移 / testkit。**不要连续多轮全量**，偶发失败只单跑该文件复核。**不要改动前先跑全量建基线**——基线已在 [docs/dev/05-testing.md](../../docs/dev/05-testing.md) 与 PROGRESS.md 记录；你只需保证**失败集合不超出基线**。
- 每个 WP 都要**新增**它要求的测试；不能只靠已有测试通过。
- 新增依赖：不允许（见 01-conventions「依赖管理」）。

### 1.5 提交与分支

- Conventional Commits：`feat(core): …`、`refactor(shared): …`、`test(…)`、`docs(…)`。**每个提交必须可构建**（至少 `typecheck` 通过）。
- 一个 WP 一个分支：`feat/project/<wp>`（例 `feat/project/wp1-schema`），从你依赖的 WP 的合入点拉出。**不 push，不合入 main**，合入由用户确认。
- 纯改名（WP0-1 / WP0-2）**必须是独立提交，提交里不夹带任何行为改动**。
- WP 末尾的「实施记录」在最后一个提交里更新。

### 1.6 遇到偏差怎么办

- 设计 / WP 与代码现实冲突（例如某函数已不存在、某假设不成立）→ **停止相关部分**，在 [docs/dev/DEVIATIONS.md](../../docs/dev/DEVIATIONS.md) 按模板新增一条（编号接 DEV-030 之后递增），继续不受影响的部分，最后在 WP「实施记录」写明。
- 需要新增 WP 没列出的**大型**依赖 → 同上，等待人工决定。
- 不要为了让测试通过而放宽断言、跳过用例、删除用例（WP 明确要求删除的除外）。

### 1.7 全局「不要做」

- 不要编辑**历史迁移 SQL**（`packages/core/migrations/**/00NN_*.sql` 已存在的文件）。改动只能通过**新增**迁移。
- 不要给 `docs/design/`、`docs/dev/` 以外的位置新建文档；不要新建 README。
- 不要使用 `group` 一词给新代码命名（项目组一律 `project`）；也**不要对 `group` 做全局查找替换**（§4.1 末尾列了不能动的）。
- 不要在日志、错误信息、RPC 返回里放敏感数据（见 01-conventions「日志」）。
- 不要引入向后兼容分支、旧名别名、`@deprecated` 导出、「兼容旧数据」的读取代码。
- 不要在渲染层组件里硬编码中文，文案进 `apps/desktop/src/renderer/src/lib/i18n/locales/zh-CN.ts`。
- 代码、标识符、注释用英文；文档用中文（01-conventions）。

### 1.8 代码规范摘要

zod 校验所有边界输入；时间用 `infra/clock`，UTC 毫秒整数；路径先 `realpath`；工具失败以工具结果返回不抛出；错误用 `AppError(code, message, details?)`；依赖注入、无全局单例（`start.ts` 装配）；`packages/shared` 不依赖 core / Electron；renderer 只经 `lib/rpc` 调 core。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| T0：行为中性的纯改名（`workdir→cwd`、目录 `project→workdir`） | 看板 / 日历 / OKR 的实现（下期） |
| T1a：项目组核心（`group→project`、必有负责人、路由、协作回合与熔断、界面外壳、详情页、文案与 e2e） | 路径作用域写租约（下期看板的前置设计） |
| T1b：项目 wiki | Bot 提示词各段预算的全局移除（单独评估，K15） |
| 文档同步 | 多频道、项目归档、worktree、页面手工编辑 |

## 3. 工作包总览

| WP | 文件 | 内容 | 依赖 | 可并行 | 收口跑全量 |
|---|---|---|---|---|---|
| WP0-1 | [WP0-1-cwd-rename.md](WP0-1-cwd-rename.md) | D75 `workdir → cwd`（纯改名） | — | 否 | 是 |
| WP0-2 | [WP0-2-workdir-rename.md](WP0-2-workdir-rename.md) | 目录 `project → workdir`（纯改名） | WP0-1 | 否 | 是 |
| WP1 | [WP1-schema-and-domain.md](WP1-schema-and-domain.md) | shared 契约 + 迁移（含运行器 FK 关闭模式）+ `ProjectsService` + 生命周期 + RPC + 删除 D60 后端 | WP0-2 | 否 | 是 |
| WP2 | [WP2-episodes.md](WP2-episodes.md) | `chain → episode`、任务唤醒继承、熔断与暂停卡（后端） | WP1 | 与 UI 链（WP5 → WP6 → WP7）、WP9 并行 | 是 |
| WP3 | [WP3-routing.md](WP3-routing.md) | `ProjectTurnCoordinator`：续接判断、负责人网关、静默路由、必答与兜底 | WP2 | 与 UI 链、WP9 并行 | 是 |
| WP4 | [WP4-prompt-and-integrations.md](WP4-prompt-and-integrations.md) | 提示词规则、管家工具、工作台、设置目录、记忆库迁移、`'group'` 残留 | WP3 | 与 WP5 / WP6 并行；**WP7 必须等它** | 是 |
| WP5 | [WP5-ui-create.md](WP5-ui-create.md) | 双轮创建 | WP1 | 与 WP2–WP4、WP9 并行 | 否 |
| WP6 | [WP6-ui-shell.md](WP6-ui-shell.md) | 两行顶栏、模块 tab、成员头像堆叠、撤右栏、窄屏、侧栏 | **WP5**（二者都改 `ChatView` / `ChatsArea` / `NarrowShell` / `AppSidebar`，不得并行） | 与 WP2–WP4、WP9 并行 | 否 |
| WP7 | [WP7-ui-settings-page.md](WP7-ui-settings-page.md) | 项目详情页、`ProjectMembersEditor`、设置卡内嵌与深链、删 Bot 阻止 UI | **WP6、WP4**（设置卡文件 WP4 先做过临时处理） | 与 WP9 并行 | 否 |
| WP8 | [WP8-ui-copy-e2e.md](WP8-ui-copy-e2e.md) | 文案改名、协作暂停卡 UI、e2e 重写 | WP3、WP5–WP7 | 否 | **是（T1a 收口）** |
| WP9 | [WP9-wiki-core.md](WP9-wiki-core.md) | 项目 wiki 后端：owner 泛化、项目级索引、来源台账、ACL、维护身份 | WP1 | 与 core 链（WP2–WP4）、UI 链并行（与 WP4 同改 `lifecycle.ts` 时后合入者解决冲突） | 是 |
| WP10 | [WP10-wiki-surface.md](WP10-wiki-surface.md) | 项目 wiki 的工具 / RPC / 提示词 / Wiki tab / 删除确认框 | WP9、WP6、WP4、WP7 | 否 | **是（T1b 收口）** |
| WP11 | [WP11-docs-sync.md](WP11-docs-sync.md) | 设计与开发文档同步、PROGRESS | 全部 | 否 | 否 |

依赖图：

```text
WP0-1 → WP0-2 → WP1 ─┬→ WP2 → WP3 → WP4 ──────────────┐
                     │                                  ├→ WP7 ─→ WP8 → (T1a 收口)
                     ├→ WP5 → WP6 ──────────────────────┘     │
                     │                                         └→ WP10（还需 WP9）→ (T1b 收口) → WP11
                     └→ WP9 ───────────────────────────────────┘
```

并行规则：
- 同一时间修改同一模块的 WP 不要并行。**core 链 WP2 → WP3 → WP4 顺序做**（都改 `dispatch/`）；**UI 链 WP5 → WP6 → WP7 顺序做**（都改 `ChatView` / `ChatsArea` / `NarrowShell` / `AppSidebar` / `chat.svelte.ts`）；WP7 还要等 WP4（设置卡文件）。
- 两条链与 **WP9（wiki 后端）** 可以并行；WP8 要等 WP3、WP4、WP7；WP10 要等 WP9、WP6、WP4、WP7。
- 并行的 WP 合入前先 `rebase` 到最新集成分支。**多 WP 共改的文件**：`apps/desktop/src/renderer/src/lib/i18n/locales/zh-CN.ts`、`stores/chat.svelte.ts`、`packages/shared/src/domain/types.ts`、`packages/shared/src/rpc/methods.ts`、`packages/shared/src/constants.ts`、`packages/core/src/dispatch/orchestrator.ts`、`packages/core/src/start.ts`、`packages/core/src/domain/lifecycle.ts`。冲突时**两边都保留**，然后重跑 typecheck 与你这个 WP 的测试；改动同一个 i18n key 的两个 WP 以 README §4 / 各 WP 表里写的文案为准。

## 4. 固定契约（所有 WP 共用，名字不得改动）

### 4.1 改名对照

**T0-1（WP0-1）：D75「任务执行根目录」`workdir → cwd`**

| 旧 | 新 |
|---|---|
| 列 `runs.task_workdir` | `runs.task_cwd` |
| TS 字段 `taskWorkdir`（`Run`、`RunsService` 入参与行映射、`TaskView`、`runSchema`） | `taskCwd` |
| `resolveWorkdir`、`#describeTaskWorkdir`、`describeWorkdir`、`agentWorkdir` | `resolveCwd`、`#describeTaskCwd`、`describeCwd`、`agentCwd` |
| `TaskView.workdirKind` | `cwdKind` |
| `start_task` 工具参数 `workdir` | `cwd`（取值 `'workspace' \| 'project'` 本步不变） |
| `<task_brief workdir="…">` 属性、`RunSpec.workdir` | `cwd="…"`、`RunSpec.cwd` |
| **不改**：es-git `repo.workdir()`、Lima `--workdir`、`workDir`（Agent 探测目录）、`agent-spike` 脚本、DEVIATIONS / PROGRESS 里指 git 工作树的 `workdir` 字样 | |

**T0-2（WP0-2）：D28 共享目录 `project → workdir`**

| 旧 | 新 |
|---|---|
| 表 `projects` | `workdirs` |
| 列 `conversations.project_id`、`run_changes.project_id` | `workdir_id` |
| ID 前缀 `prj_`（`ids.ts` 键 `prj`） | `wkd_`（键 `wkd`） |
| shared：`Project`、`projectSchema`、`projectProtectRulesSchema`、`projectStatusSchema` | `Workdir`、`workdirSchema`、`workdirProtectRulesSchema`、`workdirStatusSchema` |
| `Conversation.projectId`、`RunChange.projectId`、设置卡目标 `projectId` | `workdirId` |
| 常量 `PROJECT_CONTEXT_TOKEN_BUDGET`、`PROJECT_CONTEXT_MAX_ENTRIES`、`PROJECT_DEFAULT_PROTECT_RULES`、`PROJECTS_RECENT_LIMIT` | `WORKDIR_CONTEXT_TOKEN_BUDGET`、`WORKDIR_CONTEXT_MAX_ENTRIES`、`WORKDIR_DEFAULT_PROTECT_RULES`、`WORKDIRS_RECENT_LIMIT` |
| RPC `projects.list/get/select/unbind/update/remove/diff/revert/revokeLease` 及其 zod schema 名 `projectsXxx…` | `workdirs.*`、`workdirsXxx…` |
| 事件 `project.updated`、`project.removed` | `workdir.updated`、`workdir.removed` |
| 错误码 `PROJECT_MISSING`、`PROJECT_SWITCH_BLOCKED` | `WORKDIR_MISSING`、`WORKDIR_SWITCH_BLOCKED` |
| 目录 `packages/core/src/project/`；`domain/projects.ts`（`ProjectsService`）；`ProjectRuntime` | `src/workdir/`；`domain/workdirs.ts`（`WorkdirsService`）；`WorkdirRuntime` |
| 工具 `acquire_project_write` | `acquire_workdir_write` |
| 提示词标签 `<project>`、`buildProjectSection`、`PROJECT_SECTION_BUDGET` | `<workdir>`、`buildWorkdirSection`、`WORKDIR_SECTION_BUDGET` |
| `projectCheckpointsPath` 与磁盘路径 `projects/{id}/checkpoints.git` | `workdirCheckpointsPath` 与 `workdirs/{id}/checkpoints.git` |
| `start_task.cwd` 取值、`TaskView.cwdKind` 取值 `'project'` | `'workdir'` |
| 内联设置 `kind: 'project'`（选目录那一种） | `kind: 'workdir'` |
| 设置目录条目 `project.protect-rules`、`project.ports`；`scope: 'project'`；`surface: 'project-dialog'` | `workdir.protect-rules`、`workdir.ports`；`scope: 'workdir'`；`surface: 'workdir-dialog'` |
| renderer：`features/projects/` → `features/workdirs/`；`stores/projects.svelte.ts` → `workdirs.svelte.ts`；`ProjectSelector` → `WorkdirSelector`；`ProjectSettingsDialog` → `WorkdirSettingsDialog`（`RunChangesCard` / `DiffDialog` / `run-changes.ts` 名字不变，随目录移动） | |
| i18n：`projects.*`（20 个）、`chats.errorCode.PROJECT_*`、`settingCard.project.*` | `workdirs.*`、`chats.errorCode.WORKDIR_*`、`settingCard.workdir.*` |
| `data-testid`：`project-selector` / `-trigger` / `-name`、`project-switch-blocked-hint`、`project-picker-dialog` / `-list`、`project-option`、`project-pick-new`、`project-settings` / `-embedded` / `-dialog`、`project-card-deny-read` / `-deny-write` / `-ports` / `-ack` / `-save`、`project-deny-read-input`、`project-deny-write-input`、`project-ports-input`、`project-remove`、`project-save` | 前缀 `project-` → `workdir-` |
| 测试文件：`projects.test.ts`、`project-lease-windows.test.ts`、`project-lease.test.ts`、`project-rules.test.ts`、`projects.spec.ts` | `workdirs.test.ts`、`workdir-lease-windows.test.ts`、`workdir-lease.test.ts`、`workdir-rules.test.ts`、`workdirs.spec.ts` |
| 文档：`docs/design/08-project.md`（当前规格）→ `08-workdir.md`（含全仓链接）；`docs/dev/phases/P04-project.md` 是历史文档，**不改名** | |
| **不改**：`apps.catalog.category.project`（SaaS 连接器分类「项目」）、`apps/desktop/resources/connectors/catalog.json` 的 `category: "project"`、`test/fixtures/connectors/*.tools.json` 里 Linear / Notion 的 `projectId`、`vitest.config.ts` 的 `projects:`、`--project` 测试参数、`OPENCODE_DISABLE_PROJECT_CONFIG`、`@typescript-eslint/project-service` | |

**T1a（WP1 起）：`group → project`、`chain → episode`**

| 旧 | 新 |
|---|---|
| `conversations.type` 取值 `'group'` | `'project'`（`conversationTypeSchema = z.enum(['direct','project'])`） |
| `conversations.description`、`Conversation.description` | `goal` |
| `conversations.setup_state`、`Conversation.setupState` | **删除** |
| （新）`conversations.lead_bot_id`、`Conversation.leadBotId` | 见 §4.3 |
| 类 `GroupsService`（`domain/groups.ts`） | `ProjectsService`（`domain/projects.ts`；此名在 WP0-2 后已空出） |
| RPC `groups.create/addMembers/removeMember` | `projects.create/addMembers/removeMember` |
| RPC `groups.rename` | 并入 `projects.update` |
| RPC `groups.setup.start/answer/cancel`、`groups.redistribute` | **删除** |
| 新 RPC | `projects.setLead`、`projects.update`、`episodes.get/resume/stop` |
| `GroupTurnCoordinator`（`dispatch/group-turn.ts`）、`GroupTurnDeps`、`GroupRoundEnd` | `ProjectTurnCoordinator`（`dispatch/project-turn.ts`）、`ProjectTurnDeps`、`ProjectRoundEnd` |
| 事件 `group.turn`；阶段 `triaging` | `project.turn`；`routing` |
| `GroupMember`（RPC 成员视图） | `ProjectMember` |
| `GROUP_TITLE_MAX`、`GROUP_MEMBER_PREVIEW_MAX`、`group-title.ts`、`groupTitleFromMemberNames` | `PROJECT_TITLE_MAX`、`PROJECT_MEMBER_PREVIEW_MAX`、`project-title.ts`、`projectTitleFromMemberNames` |
| `GROUP_SETUP_QUESTION_EVENT`、`GROUP_SETUP_STEPS`、`GROUP_SETUP_QUESTIONS`、事件名 `group_setup_question` / `group_created` / `group_no_claim` | **删除** |
| `lifecycle.removeGroupMember`、`groupConversationIdsOf`、`onGroupMemberRemoved` | `removeProjectMember`、`projectConversationIdsOf`、`onProjectMemberRemoved` |
| `isGroup`（设置模式上下文、记忆检索等） | `isProject` |
| 管家工具 `propose_group`；`propose_team` | `propose_project`；`propose_bots`（`propose_bot` 不变） |
| 审批载荷 `proposalType: 'team' \| 'bot' \| 'group'` | `'bots' \| 'bot' \| 'project'` |
| `BUTLER_TEAM_SIZE_MIN/MAX` | `PROPOSE_BOTS_MIN/MAX` |
| `suggest_route` 的 `route: 'group'` | `'project'` |
| `todos.assignee_group_id`；`TodoAssignee.kind: 'group'`（`conversationId`） | `assignee_project_id`；`kind: 'project'`（`projectId`） |
| 管家工作台工具参数 `group_id` | `project_id` |
| 设置目录 `group.title` / `group.members`；`scope: 'group'`；`surface: 'group-dialog'`；卡 `group-title` / `group-members` | `project.title` / `project.members`；`scope: 'project'`；`surface: 'project-detail'`；卡 `project-title` / `project-members`；**新增** `project.goal`（卡 `project-goal`）、`project.lead`（卡 `project-lead`） |
| `chains` 表、`ChainsService`（`dispatch/chains.ts`）、`runs.chain_id` / `chain_depth`、`TriggerBatch.chain`、`ID_PREFIXES.chn` | `episodes` 表、`EpisodesService`（`dispatch/episodes.ts`）、`runs.episode_id` / `episode_hop`、`TriggerBatch.episode`、`ID_PREFIXES.epi` |
| renderer：`GroupComposeBar` / `group-compose.ts` / `GroupAvatarStack` / `group-avatar-layout.ts` / `GroupTurnStatusLine`；store 的 `composingGroup` 等 | `ProjectComposeBar` / `project-compose.ts` / `ProjectAvatarStack` / `project-avatar-layout.ts` / `ProjectTurnStatusLine`；`composingProject` 等（§4.11） |
| renderer 删除：`GroupInfo.svelte`、`GroupSettingsDialog.svelte`、`GroupSetupCard.svelte` | 由 `ProjectSettingsPage` / `ProjectMembersEditor`（WP7）取代 |
| i18n 前缀 `group.*`、`groupSetup.*`、`groupCompose.*` | `project.*`、（`groupSetup.*` 删除）、`projectCompose.*` |
| `data-testid` `group-*`（见 WP8 清单） | `project-*`（§4.12） |
| 测试：`group-chat.test.ts`、`group-chat.spec.ts`、`group-compose.spec.ts`、`group-compose.test.ts`、`group-avatar-layout.test.ts`、`helpers/create-group.ts`、`group-members.test.ts` | `project-chat.test.ts`、`project-chat.spec.ts`、`project-compose.spec.ts`、`project-compose.test.ts`、`project-avatar-layout.test.ts`、`helpers/create-project.ts`（`createProjectViaUi`）、`project-members.test.ts` |
| **不改（别的含义的 `group`）** | UI 库 `*-group` 组件（`dropdown-menu-group`、`sidebar-group`、`resizable-pane-group`、`avatar-group`、`select-group` 等）；侧栏「对话分组」（`sidebar-sections`、`section-header-*`）；设置目录条目的 `group` 分类字段（`'models'` / `'search'` …）；`tier-grouping`、`connections-group`；`widgets/query-gate.ts` 里 SQL 关键字 `'group'`；`apps.tier.communityGroup`；`contacts.engineGroup*`；`profile-groups` |

### 4.2 ID 前缀（`packages/shared/src/ids.ts` 的 `ID_PREFIXES`）

- 删除：`prj`（WP0-2）、`chn`（WP2）。
- 新增：`wkd: 'wkd_'`（工作目录，WP0-2）、`epi: 'epi_'`（协作回合，WP2）。
- `docs/dev/01-conventions.md` 的 ID 表同步（WP11 统一做，WP 内可顺手做）。
- 项目 id = 其根会话 id（`conv_…`），**没有** `prj_` 的新用法。
- 项目 wiki 的来源资产 id：`ast_` + 内容 sha256 前 24 位十六进制（D85 约定，不是 ULID，不进 `ID_PREFIXES`）。

### 4.3 数据库最终形态

**迁移编号**（撰写时 main 最新 `0037`、runs 最新 `0012`、memory 最新 `0002`；开工时以 `ls packages/core/migrations/{main,runs,memory}` 为准，编号**必须连续**；若已被占用，整体顺延并在各 WP 记录）：

| 迁移 | WP | 内容 |
|---|---|---|
| runs `0013_task_cwd.sql` | WP0-1 | `ALTER TABLE runs RENAME COLUMN task_workdir TO task_cwd;` |
| main `0038_workdirs_rename.sql` | WP0-2 | `ALTER TABLE projects RENAME TO workdirs;` `ALTER TABLE conversations RENAME COLUMN project_id TO workdir_id;` `ALTER TABLE run_changes RENAME COLUMN project_id TO workdir_id;` |
| main `0039_project_prepare.sql` | WP1 | 在 FK **开启**下删除无法转换的旧群（含其 `messages_fts` 行；子表经 FK 级联） |
| main `0040_project_conversations.sql` | WP1 | 重建 `conversations`（**首行 FK 关闭指令**，运行器支持见 WP1）：`type` 取值 `project`、`lead_bot_id`、`goal`、删 `setup_state`；旧群转换；删项目会话里的管家成员行 |
| main `0041_episodes.sql` | WP2 | `DROP TABLE chains` + `CREATE TABLE episodes` |
| runs `0014_episode_columns.sql` | WP2 | `RENAME COLUMN chain_id TO episode_id; RENAME COLUMN chain_depth TO episode_hop` |
| main `0042_todos_assignee_project.sql` | WP4 | `ALTER TABLE todos RENAME COLUMN assignee_group_id TO assignee_project_id;` |
| memory `0003_origin_project.sql` | WP4 | 重建 `memory_items`：`origin` 取值 `('private','project')`，旧值 `'group'` → `'project'` |

> 顺序：main 按 0038 → 0042 依次合入；WP2 / WP4 的迁移在各自 WP 内**按上表编号**新增，不得抢号。写死版本号的测试（`create-core.test.ts` 等）在每个新增迁移的 WP 里同步更新（见各 WP）。

**`conversations` 最终 DDL（0040 之后）**

```sql
CREATE TABLE conversations (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('direct', 'project')),
  title            TEXT,
  goal             TEXT,                                  -- 项目目标（原 description）；direct 恒 NULL
  direct_bot_id    TEXT REFERENCES bots(id),
  lead_bot_id      TEXT REFERENCES bots(id),              -- 项目负责人；direct 恒 NULL，project 恒非空
  workdir_id       TEXT,                                  -- 工作目录（无 FK，与原 project_id 一致）
  read_only        INTEGER NOT NULL DEFAULT 0,
  summary          TEXT,
  summary_upto_seq INTEGER NOT NULL DEFAULT 0,
  last_seq         INTEGER NOT NULL DEFAULT 0,
  last_read_seq    INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER,
  created_at       INTEGER NOT NULL,
  CHECK ((type = 'project') = (lead_bot_id IS NOT NULL))
);
CREATE UNIQUE INDEX conversations_one_direct_per_bot
  ON conversations(direct_bot_id) WHERE type = 'direct' AND read_only = 0;
```

**`episodes`（main）**

```sql
CREATE TABLE episodes (
  id              TEXT PRIMARY KEY,                       -- epi_...
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_batch_id   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
  hops            INTEGER NOT NULL DEFAULT 0,             -- Bot 发起的触发总数
  pair_hops_json  TEXT NOT NULL DEFAULT '{}',             -- { "botA|botB": n }，键为字典序排序后的无序对
  pending_json    TEXT NOT NULL DEFAULT '[]',             -- 熔断时未投递的触发：[{ toBotId, fromBotId, messageId, hop }]
  paused_at       INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX episodes_by_conversation ON episodes(conversation_id, created_at);
```

### 4.4 shared 类型（`packages/shared/src/domain/types.ts`）

- `conversationTypeSchema = z.enum(['direct', 'project'])`。
- `conversationSchema`：删 `setupState`；`description` → `goal: z.string().nullable().optional()`；新增 `leadBotId: z.string().nullable().optional()`（单聊为 null / 缺省）；`projectId`（T0-2 后已是 `workdirId`）不变。
- `episodeStatusSchema = z.enum(['active','paused','stopped'])`；`episodeSchema = z.object({ id, conversationId, status, hops: z.number(), pausedAt: z.number().nullable(), pendingCount: z.number(), createdAt: z.number() })`。
- `systemEventContentSchema` 新增可选 `episodeId: z.string().optional()`（协作暂停卡）。
- `runSchema`：`chainId`/`chainDepth` → `episodeId`/`episodeHop`（均 `nullable`）。
- `triggerReasonSchema`：见 §4.7。
- 审批载荷 `butlerProposalPayloadSchema`：`proposalType` 取 `'bots' | 'bot' | 'project'`；`project` 分支字段 `{ title, goal, leadBotId, memberBotIds, reason }`。
- `todoAssigneeSchema` 的 `group` 分支 → `{ kind: 'project', projectId: string, leadBotId: string | null }`。
- 新增模块注册表见 §4.13（放 `packages/shared/src/domain/project-modules.ts`，并从 `index.ts` 导出）。
- 删除：`group_setup_question` 相关的 `step` 字段（`systemEventContentSchema.step`）。

### 4.5 RPC 契约（`packages/shared/src/rpc/methods.ts`）

| 方法 | input | output |
|---|---|---|
| `projects.create` | `{ title: string(1..PROJECT_TITLE_MAX), goal?: string(≤PROJECT_GOAL_MAX_CHARS), leadBotId: string, memberBotIds: string[](min 2，须含 leadBotId) }` | `{ conversation: Conversation }` |
| `projects.setLead` | `{ conversationId: string, botId: string }` | `{ conversation: Conversation }` |
| `projects.update` | `{ conversationId: string, title?: string, goal?: string \| null }`（至少一项） | `{ conversation: Conversation }` |
| `projects.addMembers` | `{ conversationId: string, botIds: string[] }` | 同现有 `conversationsMembersOutputSchema` |
| `projects.removeMember` | `{ conversationId: string, botId: string }` | `okOutput` |
| `episodes.get` | `{ id: string }` | `{ episode: Episode }` |
| `episodes.resume` | `{ id: string }` | `{ episode: Episode }` |
| `episodes.stop` | `{ id: string }` | `{ episode: Episode }` |

- `conversations.members` 等其余 conversations RPC 不变（输出里的类型名 `GroupMember` → `ProjectMember`）。
- **删除**：`groups.*` 全部；`wiki.*` 的新形态见 WP10。

### 4.6 事件（`packages/shared/src/rpc/events.ts`）

- `group.turn` → `project.turn`，载荷 `{ conversationId, batchId: string|null, phase: 'routing'|'running'|'idle', currentBotId: string|null, queue: string[], pendingBatches: number }`。
- 新增 `episode.updated: { episode: Episode }`。
- `conversation.updated`、`message.created` 等不变。

### 4.7 触发原因（`triggerReasonSchema`，最终集合）

```text
direct, mention, reply, bot_mention, continuation, routing_gate, routed, routed_also, lead_fallback,
scheduled, event, background, delegation, task, watch, mail
```

- 删除 `broadcast`、`chain`；`chain` 的语义（另一个 Bot `@` 了你）改名 `bot_mention`。
- `continuation`：上一位回话者续接；`routing_gate`：**仅用于负责人网关那次轻量调用对应的 `triage` 类 run 的 `trigger_reason`**，不会作为投递给 Bot 的触发；`routed`：负责人网关静默转给成员（该轮**首个**目标，必答）；`routed_also`：同一次路由的其余目标（可 `skip_reply`）；`lead_fallback`：负责人兜底（必答）。
- 用户在等待回复（调度优先级 0，`USER_FACING_REASONS`）：`direct, mention, reply, continuation, routed, routed_also, lead_fallback, delegation, task`；`bot_mention` 保持优先级 1。
- 必答集合 `MUST_REPLY_REASONS = ['routed', 'lead_fallback']`（放 shared 常量，WP3 使用：该轮工具面摘掉 `skip_reply`）。
- 同步点：shared `triggerReasonSchema`、`scheduler/mailbox.ts` 的 `TriggerReason` 联合与 `USER_FACING_REASONS`、`orchestrator.ts` 的 `downgradeLabel`、`agent/context/conversation.ts` 的触发段提示、`settings-catalog/mode.ts` 的 `SETTING_DIRECT_TRIGGERS`（**不要**把新原因加进去：路由 / 续接 / 兜底触发的轮是否算「用户本人触发」，见 WP3 §「triggerFromUser」）。

### 4.8 常量（`packages/shared/src/constants.ts`）

| 常量 | 值 | 说明 |
|---|---|---|
| `PROJECT_TITLE_MAX` | 100 | 原 `GROUP_TITLE_MAX` |
| `PROJECT_MEMBER_PREVIEW_MAX` | 9 | 原 `GROUP_MEMBER_PREVIEW_MAX` |
| `PROJECT_GOAL_MAX_CHARS` | 4000 | 项目目标长度上限 |
| `ROUTING_CONTINUATION_WINDOW_MS` | `30 * 60_000` | 「上一位回话者」的连续窗口 |
| `ROUTING_CONTINUATION_MIN_CONFIDENCE` | `0.6` | 续接判断的认领阈值（初值，待实测） |
| `ROUTING_ROUTE_TARGETS_MAX` | 3 | 网关 `route` 的目标数上限 |
| `EPISODE_HOP_BREAKER` | 12 | 一个回合内 Bot 发起的触发**最多放行 12 次**，第 13 次被暂停（熔断） |
| `EPISODE_PINGPONG_BREAKER` | 8 | 同一无序 Bot 对之间**最多放行 8 次**触发（约 4 个来回），第 9 次被暂停 |
| `PROPOSE_BOTS_MIN` / `PROPOSE_BOTS_MAX` | 3 / 5 | 原 `BUTLER_TEAM_SIZE_MIN/MAX` |
| `MUST_REPLY_REASONS` | `['routed','lead_fallback']` | §4.7 |

- **删除**：`BOT_CHAIN_MAX_DEPTH`、`BOT_CHAIN_TOKEN_BUDGET`、`GROUP_SETUP_QUESTION_EVENT`、`GROUP_SETUP_STEPS`。**保留**：`TRIAGE_TIMEOUT_MS`、`TRIAGE_RECENT_MESSAGES`、`AGENT_TRIAGE_TIMEOUT_MS`、`TASK_TOKEN_BUDGET`、`SUBAGENT_TOKEN_BUDGET`、`BACKGROUND_DAILY_BUDGET_DEFAULT`。
- `AGENT_TURN_BUDGET_TOKENS` 的注释里提到「chain budget」，随之改写（它现在只是 Agent 引擎零用量行的记账值）。
- 所有新常量同步登记到 `docs/dev/01-conventions.md` 的常量表（WP11）。

### 4.9 系统消息事件名（`system_event.event`，均**非** internal）

| event | 文案（`text`） | 用途 |
|---|---|---|
| `project_lead_changed` | `负责人已更换为 {name}` | 更换负责人（Bot 可见） |
| `project_member_joined` | `{name} 已加入项目组` ；绑定了工作目录时为 `{name} 已加入项目组，获得工作目录「{label}」的读写权限` | 加成员 |
| `episode_paused` | `协作已自动往返 {n} 次，已暂停` | 熔断暂停卡（带 `episodeId`） |

- 删除：`group_created`、`group_no_claim`、`group_setup_question`。
- 前三个**不要**加进 `INTERNAL_SYSTEM_EVENTS`（用户要看见）。
- 另有一个 **internal** 事件 `episode_stopped`（`用户已停止本次协作（不再继续 Bot 之间的往返）`，WP2 加入 `INTERNAL_SYSTEM_EVENTS`）：只进 Bot 的上下文，用户不可见。

### 4.10 工具名与参数

| 工具 | 注册范围 | 参数 |
|---|---|---|
| `propose_project` | 仅管家 | `{ title: string, goal: string, lead_bot_id: string, member_bot_ids: string[], reason?: string }`（`member_bot_ids` 含负责人，≥2，**不得含管家**） |
| `propose_bots` | 仅管家 | 与原 `propose_team` 完全相同的参数 |
| `suggest_route` | 仅管家 | `route: 'bot' \| 'project' \| 'delegate'`，其余同前 |
| `wiki_search` | 所有 Bot | `{ query: string, limit?: number, scope?: 'mine' \| 'project' \| 'all' }`（WP10；`project` / `all` 仅在项目对话里有效，默认 `all`） |
| `wiki_read` | 所有 Bot | `{ path: string, scope?: 'mine' \| 'project' }`（默认 `mine`；`wiki_search` 的结果带 scope，原样传回） |
| `wiki_enqueue` | 所有 Bot | `{ source_type, ref, note, scope?: 'mine' \| 'project' }`（默认 `mine`） |
| `wiki_remove_source` | 所有 Bot（仅项目对话） | `{ source_id: string }`（`ast_…`） |

### 4.11 渲染层状态契约（`apps/desktop/src/renderer/src/lib/stores/`）

`chat.svelte.ts`：

- 状态：`composingProject: boolean`、`composePhase: 'lead' | 'members'`、`composeLeadId: string | null`、`composeMemberIds: string[]`（**不含**负责人）。
- 方法：`beginProjectCompose()`、`cancelProjectCompose()`、`selectComposeLead(botId)`（置 `composeLeadId`、`composePhase='members'`）、`backToLeadPhase()`（清 `composeLeadId`，`composePhase='lead'`；`composeMemberIds` 保留）、`addComposeMember(botId)`、`removeComposeMember(botId)`、`commitProjectCompose()`（调 `projects.create`，`memberBotIds = [composeLeadId, ...composeMemberIds]`）。
- 原 `composingGroup`、`beginGroupCompose`、`cancelGroupCompose`、`commitGroupCompose`、`createGroupViaSetup`、`answerGroupSetup`、`cancelGroupSetup`、`redistribute`、`renameGroup`、`addGroupMembers`、`removeGroupMember` 对应改名或删除：`renameProject`（→ `projects.update`）、`updateProjectGoal`、`setProjectLead`、`addProjectMembers`、`removeProjectMember`；其余删除。

`shell.svelte.ts`：

- `type ProjectView = 'chat' | 'wiki' | 'board' | 'okr' | 'calendar' | 'settings'`；`projectView = $state<ProjectView>('chat')`；`projectSettingsSection = $state<ProjectSettingsSection>('overview')`。`ProjectSettingsSection` 取自 shared 的常量 `PROJECT_DETAIL_SECTIONS = ['overview', 'members', 'grants', 'schedules', 'danger'] as const`（WP4 加在 `settings-catalog/coverage.ts` 并从 shared 导出，设置目录的 `project-detail` 深链与渲染层共用这一份）。
- **注意**：`shell` 上原有的 `openProjectSettings` / `projectSettingsRequest`（打开 D28 目录设置对话框）在 WP0-2 已改名为 `openWorkdirSettings` / `workdirSettingsRequest`；新的 `openProjectSettings(section?)` 是项目详情页，二者不是一回事。
- 方法：`openProjectModule(id: ModuleId)`、`openProjectSettings(section?: ProjectSettingsSection)`。
- `chat.select()` 内部把 `projectView` 重置为 `'chat'`（与 `mainView` 的「收口不变式」同一处）。
- `rightPanelCollapsed` 等右栏状态保留给单聊。

### 4.12 `data-testid`（新增 / 更名；e2e 与组件必须一致）

- 创建：`project-compose-view`、`project-compose`、`project-compose-phase`（`data-phase="lead"|"members"`）、`project-compose-chip-<botId>`、`project-compose-lead-chip`、`project-compose-remove-<botId>`、`project-compose-input`、`project-compose-cancel`、`project-compose-menu`、`project-compose-option-<botId>`、`project-compose-hint`；入口 `start-chat-create-project`。
- 顶栏：`project-header`、`project-title`、`project-tabs`、`project-tab-<moduleId>`（`chat|wiki|board|okr|calendar`，`data-disabled`）、`project-tab-badge-chat`、`project-members-trigger`、`project-members-menu`、`project-member-row-<botId>`、`project-member-add`、`project-settings-button`。
- 内容：`project-view`（`data-view="chat|wiki|…|settings"`）、`project-module-placeholder`。
- 详情页：`project-settings-page`、`project-settings-nav-<section>`、`project-settings-section-<section>`（`<section>` ∈ `PROJECT_DETAIL_SECTIONS`）、`project-title-input`、`project-title-save`、`project-goal-input`、`project-goal-save`、`project-workdir`（容器）、`project-lead-badge`、`project-member-list`、`project-member-row-<botId>`（与顶栏弹层的行同名规则，各在自己的容器内）、`project-make-lead-<botId>`、`project-member-remove-<botId>`、`project-member-detail`、`project-grants-list`、`project-grants-empty`、`project-grant-revoke-<grantId>`、`project-schedules`、`project-watches`、`project-delete-begin`、`project-delete-confirm-box`、`project-delete-confirm`。
- 设置卡内嵌：`project-card-embedded`、`project-card-title`、`project-card-title-save`、`project-card-goal`、`project-card-goal-save`、`project-card-lead-<botId>`、`project-card-lead-save`、`project-card-member-<botId>`、`project-card-will-add`、`project-card-will-remove`、`project-card-members-save`。
- `data-settings-anchor`：`project-title`、`project-goal`、`project-members`、`project-lead`（设置目录深链用）。
- 路由状态：`project-turn-status`、`project-turn-queue`、`project-turn-single`（原 `group-turn-*`）。
- 协作暂停卡：`episode-paused-card`、`episode-resume`、`episode-stop`。
- 头像堆叠：`project-avatar-stack`（原 `group-avatar-stack`，`ProjectAvatarStack.svelte` 内两处）。
- wiki 相关 testid（`wiki-sources-panel`、`wiki-source-add-*`、`project-wiki-view` 等）由 WP10 自己定义并在其中列全，不在此重复。
- 沿用不变：`new-chat-button`、`right-panel-toggle`（仅单聊）、`chat-view`、`composer-dock`、`context-project-settings`（侧栏右键「项目详情」，替代 `context-group-settings`）。

### 4.13 模块注册表（`packages/shared/src/domain/project-modules.ts`）

```ts
export const PROJECT_MODULE_IDS = ['chat', 'wiki', 'board', 'okr', 'calendar'] as const;
export type ProjectModuleId = (typeof PROJECT_MODULE_IDS)[number];

export type ProjectModuleWrite = 'members' | 'lead' | 'owner';

export interface ProjectModuleDescriptor {
  id: ProjectModuleId;
  status: 'available' | 'planned';
  /** 'members' 全员可写；'lead' 仅负责人；'owner' 条目级：创建者，或负责人 / 用户。用户恒可写。读权限恒为项目组全员。 */
  write: ProjectModuleWrite;
}

export const PROJECT_MODULES: readonly ProjectModuleDescriptor[] = [
  { id: 'chat', status: 'available', write: 'members' },
  { id: 'wiki', status: 'available', write: 'owner' },
  { id: 'board', status: 'planned', write: 'lead' },
  { id: 'okr', status: 'planned', write: 'lead' },
  { id: 'calendar', status: 'planned', write: 'lead' },
];

export type ProjectActor = 'user' | 'lead' | 'member';

export function canWriteModule(moduleId: ProjectModuleId, actor: ProjectActor): boolean;

export function canManageEntry(
  moduleId: ProjectModuleId,
  actor: ProjectActor,
  createdBy: { kind: 'user' | 'bot'; id?: string },
  actorBotId?: string,
): boolean;
```

- `canWriteModule`：`user` 恒 `true`；`lead`：`write ∈ {'members','lead','owner'}` 均 `true`；`member`：仅 `write === 'members'` 为 `true`（`'owner'` 模块的成员写入由 `canManageEntry` 条目级判定，模块级返回 `false`）。
- `canManageEntry`（仅对 `write === 'owner'` 的模块有意义，其余模块返回 `canWriteModule`）：`user` / `lead` → `true`；`member` → 仅当 `createdBy.kind === 'bot' && createdBy.id === actorBotId`。
- 文案走 i18n：`project.module.<id>`（见 WP6）。
- 表驱动单测（WP1）：`actor × module` 全表 + `canManageEntry` 全表。

### 4.14 存储路径（应用数据目录）

- 项目数据根：`<home>/projects/{projectId}/`（`projectId` = 根会话 id）。**WP0-2 之后**原 `<home>/projects/` 下的检查点目录已改到 `<home>/workdirs/`，此路径空出。
- 项目 wiki：`projects/{id}/wiki/`（git）、`projects/{id}/wiki-store/`、`projects/{id}/wiki.db`（加密 sqlite，仅 `wiki_fts`）。`infra/paths.ts` 新增 `projectRoot` / `projectWikiRoot` / `projectWikiStoreRoot` / `projectWikiDbPath`（WP9）。

## 5. 全局完成定义（T1a / T1b 各自收口时）

1. `pnpm typecheck`、`pnpm lint` 通过。
2. `pnpm test` 全量：失败集合不超出 [05-testing.md](../../docs/dev/05-testing.md) / PROGRESS.md 记录的基线（沙箱 / skills / wiki-url / workspace-tools 等环境项）。
3. 本 WP 要求的新增测试全部存在且通过；被删除的功能对应的测试已删除。
4. `rg` 自检无残留：见各 WP「验收清单」里的命令。
5. e2e：T1a 收口时 `group-*` 相关与新增 project e2e 全绿（WP8）。
6. 文档：WP11 完成。

## 6. 验证命令速查

```bash
# 类型检查（顺序很重要）
pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/shared typecheck
pnpm --filter @kepcup/core run build && pnpm --filter @kepcup/core typecheck
pnpm --filter @kepcup/desktop typecheck

# 定向测试
node scripts/run-tests.mjs run packages/core/test/unit/<file>.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/<file>.test.ts -t "用例名片段"
node scripts/run-tests.mjs run --project desktop

# e2e（先构建）
pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/<spec>.spec.ts

# 残留自检模板
rg -n "<旧名>" packages apps scripts docs todo -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**'
```

## 7. 进度记录

（每个 WP 完成后在此追加一行：WP、分支、提交范围、测试结果摘要、偏差编号。详细记录写在各 WP 末尾「实施记录」。）

| WP | 状态 | 分支 / 提交 | 测试结果 | 偏差 |
|---|---|---|---|---|
| WP0-1 | 已完成 | `feat/project/migration`：`120374f`（改名+迁移+测试）、`2cd4df4`（文档）、实施记录提交 | typecheck 三包通过；定向测试（迁移 / 任务 / 外部智能体 / 权限桥等 30 文件）全绿；全量 5303 通过 / 2 失败（`tool-effects-migration` 断言按列名映射修正后复跑通过；`skills-authoring` 为基线环境项，单跑通过），不超基线 | 无（未新增 DEVIATIONS） |
| WP0-2 | 已完成 | `feat/project/migration`：`f162702`（改名+迁移 0038+测试）、`32472fe`（文档）、实施记录提交 | typecheck 三包 + lint 通过；定向（迁移 / workdirs / lease / rules / shared / desktop / 改动集 / contract / 集成 / e2e 3 spec）全绿；全量 5304 通过 / 2 失败（`public-skills-migration` 为 0038 需补回拨脚本，修正后单跑通过；`permission-bridge` 1 例负载偶发，单跑通过），不超基线 | 无（未新增 DEVIATIONS） |
| WP1 | 已完成（阶段审查修订已合入） | `feat/project/migration`：`8926bd7`（运行器 FK 关闭 + 0039/0040 + 迁移测试）、`ea36bf8`（shared 契约 + ProjectsService + 生命周期 + RPC + 删 D60 后端 + renderer 最小修复 + testkit/测试）、实施记录提交、审查提交（`isGroup → isProject` 补全 + 提交历史重排使每个提交可构建，见 WP1 实施记录「审查修订」） | typecheck 三包 + lint 通过；定向全绿（migrate-fk-off 4、project-conversations-migration 3、projects-service 18、lifecycle-project-lead 5、projects-rpc 7、project-chat 22+1 skip、create-core main=40、shared 337、desktop 767、core unit 2725、integration 919）；全量 5356 通过 / 0 失败 / 24 skip（含 project-chat 的 redistribute `it.skip`），不超基线 | 无（未新增 DEVIATIONS） |
| WP2 | 已完成 | `feat/project/migration`：`d724a07`（迁移 0041/0014 + shared 契约 + `EpisodesService` + 唤醒继承 + 熔断/暂停/继续/停止 + RPC/事件 + 测试）、实施记录与文档提交 | typecheck 三包 + lint 通过；定向全绿（episodes-migration 2、episodes-service 12、episodes-inheritance 2、episodes-breaker 2、episodes-rpc 3、supervisor-turn 22、project-chat 20 过 1 skip、tasks-review-fixes-e、create-core、shared 337 等）；全量 5371 通过 / 2 失败（`public-skills-migration`、`tool-effects-migration` 为 0041/0014 需同步的迁移形态测试，修复后单跑通过）/ 24 skip，不超基线 | 无（未新增 DEVIATIONS） |
| WP3 | 已完成 | `feat/project/migration`：`dcdaeaa`（feat(shared,core,desktop)! 路由重写 + 契约 + 测试，接续前代理半成品合成一个可构建提交，见 WP3 实施记录）、实施记录与文档提交 | typecheck 三包 + lint 通过；定向全绿（project-turn 15、lead-gate 8、messages-last-replier 5、trigger-hints 3、response-tools-must-reply 2、project-routing 9、project-chat 16、workbench 25、workbench-update 39、task-timeline-visibility、shared 337、desktop 767 等）；全量 5413 通过 / 0 失败 / 23 skip，不超基线 | DEV-031 |
| WP4 | 已完成 | `feat/project/migration`：`e7013fa`（feat(shared,core,desktop)! 提示词规则 / 管家工具与审批 / 工作台 / 设置目录 / 记忆库迁移 / `'group'` 残留清扫，接续前代理半成品合成一个可构建提交，见 WP4 实施记录）、`748d63d`（两处写死版本号断言修正）、实施记录提交 | typecheck 三包 + lint 通过；定向全绿（shared 338、desktop 767、butler-project 5、workbench-project 5、system-prompt-project 10、settings-adapters-project 8、memory-origin-migration 2、workbench-service 116 / workbench 25 / workbench-update 13 / butler-bots 9 等改写套件）；全量 5475 通过 / 2 失败（均为半成品漏改的迁移版本号断言，`748d63d` 修复后单跑通过）/ 23 skip，不超基线 | DEV-033 |
| WP5 | 未开始 | | | |
| WP6 | 未开始 | | | |
| WP7 | 未开始 | | | |
| WP8 | 未开始 | | | |
| WP9 | 已完成 | `feat/project/wp9-wiki-core`：`a32afff`（steps 1-2：shared WikiOwner、paths、WikiIndexStore/Manager、台账 assets、jobs lastDoneAtFor + 4 个单测）、`ab58b5f`（steps 3-7：wiki 服务 owner 泛化 + 台账/removeSource ACL、ingest/maintenance/lint、lifecycle、start 装配、RPC/事件 breaking、renderer 最小修复 + 3 个新集成测试 + 既有测试改写）、实施记录提交（接续前代理半成品收口，见 WP9 实施记录） | typecheck 三包 + lint 通过；定向全绿（wiki 单测 8 文件 59 例、integration wiki 21 / wiki-url 3 / handover-p2 7 / wiki-project 9 / wiki-remove-source 3 / wiki-project-lifecycle 3 等、desktop 767）；全量 5406 通过 / 2 失败（均为漏改的旧形态测试文件，修复后单跑通过）/ 24 skip，不超基线 | DEV-032 |
| WP10 | 未开始 | | | |
| WP11 | 未开始 | | | |
