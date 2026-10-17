# WP4 · 提示词规则、管家、工作台、设置目录、记忆库与 `group` 残留

> 依赖：WP3 已合入（触发原因与触发段说明已就位）。可与 WP5–WP7 并行（它们不改 core）。分支：`feat/project/wp4-integrations`。
> 先读 [README.md](README.md) §1、§4.1（T1a 表）、§4.3（迁移编号）、§4.10；设计依据 [41 §5.4、§12](../../docs/design/41-project-team.md)。

## 1. 范围

WP1–WP3 让「项目组」在数据与路由上成立。本 WP 把周边的消费者全部对齐，**core 与 shared 里不再有任何「群」的残留**：

- **A**：提示词——`<conversation_info>` 项目分支、负责人 / 成员常驻规则。
- **B**：管家工具与审批——`propose_group → propose_project`（载荷带负责人，卡上可改）、`propose_team → propose_bots`、`suggest_route`、管家提示词。
- **C**：工作台——`assignee_group_id → assignee_project_id`、`TodoAssignee.kind: 'project'`、派给项目组默认 `@` 负责人。
- **D**：设置目录——`group.* → project.*`，新增 `project.goal` / `project.lead`，深链落点 `project-detail`。
- **E**：记忆库迁移——`memory_items.origin` 的 `'group'` → `'project'`。
- **F**：`'group'` 字面量与「群聊 / 群成员 / 群里」措辞的全面清扫（core、shared；renderer 的文案归 WP8）。

不做：界面组件（WP5–WP8）、项目 wiki（WP9–WP10）。

## 2. 开工前核对

```bash
ls packages/core/migrations/main | tail -3      # …0040、0041
ls packages/core/migrations/memory              # 0001、0002
rg -n "'group'|\"group\"" packages -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**' | rg -v "query-gate|settings-catalog/items.ts:[0-9]+:\s+group:"
rg -n "propose_team|propose_group|BUTLER_TEAM_SIZE|proposalType" packages apps -g '!node_modules' -g '!**/dist/**' -l
rg -n "assignee_group_id|kind: 'group'|group_id|groupId" packages apps -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**' -l
rg -n "群聊|群成员|群里|本群|群内|同群|建群|解散群" packages/core/src packages/shared/src -l
```

必读源码：`agent/context/system-prompt.ts`（`SystemPromptInput`、`conversationInfoLines`、`BUTLER_*_RULES`、`buildSystemPrompt` 与 `buildAgentSessionPrompt` 的 `section(...)` 数组）、`dispatch/orchestrator.ts`（`#memberCards`；调用 `buildSystemPrompt` 处约 l.4368–4404；`setupSurface`）、`tools/butler-tools.ts`、`dispatch/butler.ts`、`permissions/approvals.ts`（`butler_proposal` 的 `decide` / `selection` / `routineSelection`）、`workbench/{todo-store,todo-service}.ts`、`tools/workbench-tools.ts`、`shared/src/settings-catalog/{items,types,coverage,mode}.ts`、`settings/{adapters,host}.ts`。

## 3. 步骤

### A. 提示词

1. **shared `BotCard`**（`domain/types.ts` 约 l.187）：增可选 `isLead?: boolean`。orchestrator `#memberCards(conversationId)`：按 `conversation.leadBotId` 给负责人的卡置 `isLead: true`。
2. **`conversationInfoLines(conversation, members, selfBotId)`**（新增第三参）。项目分支输出（缺项则整行省略）：

```text
对话类型：项目组「{title}」
项目目标：{goal}                         ← goal 非空才有
项目负责人：{leadName}（你）｜{leadName}    ← self 是负责人时带「（你）」
成员名片：
- {name}（{id}）：{bio 或「（无简介）」}；职责：{role 或「（未填写）」}{isLead ? ' [负责人]' : ''}
```

   `leadName` 取成员卡里 `isLead` 的那张的名字。单聊分支不变。`buildSystemPrompt` 与 `buildAgentSessionPrompt` 两处调用都传 `selfBotId = input.bot.id`。**项目 wiki 主题段不在本 WP**（WP10）。**不设任何 token 预算**（K15）：这些行不走 `truncateToBudget`。
3. **`SystemPromptInput`** 增 `projectRole?: 'lead' | 'member'`（仅 `conversation.type === 'project'` 且 `loop === 'turn'` 时由 orchestrator 传；任务面不传）。orchestrator 约 l.4368–4404：`projectRole = bot.id === conv.leadBotId ? 'lead' : 'member'`。
4. **新增常量**（`system-prompt.ts`，写法对照 `BUTLER_BASE_RULES`）与 `section(...)`：在 `conversation_info` 之后、绑定的 `<workdir>` 段之前，**仅当 `projectRole` 存在**时加入 `section('project_lead_rules', …)` 或 `section('project_member_rules', …)`。文字（原样使用，逐行一个数组元素）：

   `PROJECT_LEAD_RULES`：
   ```text
   你是本项目组的负责人。
   - 用户的消息没有 @ 任何人、也没有成员认领时，由你处理。
   - 先理解项目目标与用户意图，再决定：自己回答，或在回复中 @ 合适的成员并写清交付物与期望；成员能独立完成的事不要自己做。
   - 收到成员的汇报后，向用户汇总结论与产出位置。
   - 需要用户拍板的事直接问用户，不要替用户决定。
   - 你的权力限于本项目组：不能新建 Bot，不能改别的项目，不能改其他 Bot 的设置。
   ```
   `PROJECT_MEMBER_RULES`（`{lead}` 为负责人名字，**运行时代入**，所以做成函数 `projectMemberRules(leadName)`）：
   ```text
   你是本项目组的成员，负责人是 {lead}。
   - 被用户或负责人 @、被续接、被转给你时，直接回应用户。
   - 完成负责人交办的事后，@ 负责人汇报结论与产出位置。
   - 归属不清、超出你职责的事，先问负责人，不要自行扩大范围。
   ```
   规则按 (Bot, 对话) 在 run 构建时拼装，**不写进 Bot Profile，不用 `system_role`**。`task` loop 与外部智能体任务会话**不注入**这两段（任务不能 `@` 成员）。
5. `memory/my-state.ts` 约 l.48：`conversation.type === 'project' ? (conversation.title ?? '项目组') : '与用户的单聊'`。

### B. 管家与审批

1. **工具改名与载荷**（`tools/butler-tools.ts`、`dispatch/butler.ts`、`permissions/approvals.ts`、`shared/domain/types.ts`、`tools/{index,setup-tools}.ts`、`settings/context.ts`、`agent/effects/classify.ts`、`agent/context/system-prompt.ts` 的管家规则文本）：
   - `propose_team` → `propose_bots`（参数、行为、`proposalType` 取值 `'bots'`；`BUTLER_TEAM_SIZE_MIN/MAX` → `PROPOSE_BOTS_MIN/MAX`，值仍 3 / 5）。
   - `propose_group` → `propose_project`，参数 `{ title, goal, lead_bot_id, member_bot_ids, reason? }`（snake_case，**扁平**）；`member_bot_ids` 含负责人、至少 2 个、**不得含管家**；`lead_bot_id` 必须在 `member_bot_ids` 里；提交前在工具层校验（失败以工具结果返回，不抛）。载荷 `proposalType: 'project'`，字段 `{ title, goal, leadBotId, memberBotIds, reason }`。
   - `propose_bot` 不变。`suggest_route` 的 `route: 'group'` → `'project'`（`conversation_id` 的说明改为「已有项目组的会话 id」；没有合适的项目组就用 `propose_project`）；`domain/messages.ts` 约 l.113 的路由建议 kind 同步。
   - `proposedBotSchema` 的描述文字里「群聊里据此判断…」改为「项目组里据此判断…」。
2. **卡上可改负责人**：`approvals.decide` 的 input（`shared/rpc/methods.ts`）增可选 `leadBotId: z.string().optional()`；`permissions/approvals.ts` 的 `decide` 对 `butler_proposal` + `proposalType==='project'` 校验：若提供，必须 ∈ 该载荷 `memberBotIds`（否则 `INVALID_INPUT`）；对其它 kind / 类型提供它 → `INVALID_INPUT`；值写入 `decision_json`。仿照 `routineSelection` 的传递路径（`rg -n "routineSelection" packages apps`）。`ButlerHost` 的决定回调（约 l.243–286 `#onDecided`）`#createProject` 用 `decision.leadBotId ?? proposal.leadBotId` 调 `projects.create({ title, goal, leadBotId, memberBotIds })`（**删除 WP1 里的临时 `memberBotIds[0]`**）。`describeButlerProposal`：`提议建项目组「{title}」`。
3. **管家提示词**（`BUTLER_*_RULES`，约 l.123–176）：工具名改新名；「群」措辞改「项目组」；补一条「管家本身不加入项目组；建项目组时负责人与成员都从领域 Bot 里选」。
4. **renderer 的审批卡与路由卡只做编译修复**（`ApprovalCard.svelte` 的 `proposalType === 'group'` 分支改 `'project'`，显示字段暂按原样 + 多显示一行负责人名；**可改负责人的下拉与文案归 WP8**；`RouteCard` 的 `route.openGroup` key 改名归 WP8；`permissions.svelte.ts` 的 decide 入参类型跟随 shared）。

### C. 工作台

1. **迁移** `packages/core/migrations/main/0042_todos_assignee_project.sql`：

```sql
-- D92 T1a: workbench todos assigned to a "group" are now assigned to a "project".
ALTER TABLE todos RENAME COLUMN assignee_group_id TO assignee_project_id;
```

   更新写死的版本号（`create-core.test.ts` main `41 → 42`；其余用 `mainVersionsAfter` 的不用改）。
2. **shared**：`todoAssigneeSchema` 的 `group` 分支 → `{ kind: 'project', projectId: string, leadBotId: string | null }`（`leadBotId` 现在是**覆盖项**：`null` = 用项目负责人）；`TodoEntry.leadBotName` 语义为**实际生效**的负责 Bot 名（`leadBotId ?? project.leadBotId` 对应的名字）。工作台 RPC 的 zod 同步。
3. **core**：`workbench/todo-store.ts`（`assignee_group_id` → `assignee_project_id`；`rowToAssignee` 的 `kind: 'project'`；`listByAssigneeGroup` → `listByAssigneeProject`）；`workbench/todo-service.ts`：所有 `kind: 'group'` / `conversationId` / `assigneeGroupId` → `'project'` / `projectId`；派发目标校验 `conversation.type !== 'project'`（约 l.1128–1146）；**派发时的负责 Bot**：`leadBotId = assignee.leadBotId ?? conversation.leadBotId`（项目必有负责人，所以派给项目组**总是带结构化 `@`**，不再走路由）；`#executorProblem` / 对账 / `onConversationDeleting` 里的文案与键名；`BLOCKED_UNCLAIMED = '群里无人认领'` → `'项目里无人回应'`，同文件里其它含「群」的 `blocked_reason` 文案（如「群已解散」「群已只读」「负责 Bot 已移出群」）改为「项目组已解散」「项目组已只读」「负责 Bot 已移出项目组」（`rg -n "群" packages/core/src/workbench`）。
4. **管家工作台工具**（`tools/workbench-tools.ts`）：`assigneeSchema` 的 `group_id` → `project_id`（`{ bot_id?, project_id?, lead_bot_id? }`）；`parseAssignee` → `{ kind: 'project', projectId, leadBotId }`；约 l.134 的 `unclaimed: '群里无人认领'` → `'项目里无人回应'`；描述文字里的「群」改「项目组」。
5. **orchestrator** `dispatchWorkbenchMessage` 的参数 `leadBotId`：调用方已解析好（见 3），函数本身不改。
6. **renderer 工作台**（**只做编译修复与 key / 文案改名**，不改交互）：`features/workbench/{assignee-sections,workbench-model,TodoDrawer,TodoCard,TodoLane,todo-form,todo-actions,MemberAvatar,describe}.ts|svelte` 里的 `kind: 'group'` / `conversationId` / `group` 变量 → `'project'` / `projectId`；`TodoDrawer` 的「负责 Bot」选择器：默认显示「项目负责人（{name}）」，可覆盖；i18n 的 `workbench.error.groupReadOnly`、`workbench.error.targetGone`、`workbench.lane.group`、`workbench.self.fromGroup`、`workbench.drawer.leadNone`、`workbench.run.unclaimed`、`schedules.workbenchGroup`：key 中的 `group` → `project`，文案「群」→「项目组」。

### D. 设置目录

1. **`shared/src/settings-catalog/items.ts`**（约 l.648–703）：
   - `group.title` → `project.title`：`scope: 'project'`，`card: 'project-title'`，store `projects.update`（改 `title`）；
   - `group.members` → `project.members`：`scope: 'project'`，`card: 'project-members'`，store 方法 `projects.addMembers` / `projects.removeMember`；
   - **新增** `project.goal`：字段 `goal`（长文本），`card: 'project-goal'`，store `projects.update`（改 `goal`）；
   - **新增** `project.lead`：字段 `botId`（单选，选项 = 本项目成员），`card: 'project-lead'`，store `projects.setLead`；
   - 四项 `maxMode` 均为 `'confirm'`（更换负责人改变路由与权力，不宜 direct）；`deepLink: { surface: 'project-detail', section: <见下>, anchor: '<id 同名锚点>' }`：`title` / `goal` → `section: 'overview'`、`anchor: 'project-title'` / `'project-goal'`；`members` / `lead` → `section: 'members'`、`anchor: 'project-members'` / `'project-lead'`。
   - 目录里 `project.protect-rules` / `project.ports`（WP0-2 已改名 `workdir.*`）不动。
2. **`types.ts`**：`settingSurfaceSchema`：`'group-dialog'` → `'project-detail'`（`'project-dialog'` 在 WP0-2 已变 `'workdir-dialog'`）；`CARD_KEYS`：`'group-title'`/`'group-members'` → `'project-title'`/`'project-members'`，新增 `'project-goal'`/`'project-lead'`；`scope` 枚举的 `'group'` → `'project'`（与 WP0-2 的 `'workdir'` 并存，二者语义不同）；注释里「群设置对话框」改写为「项目详情页（内容区页面，不是对话框）」。
3. **`coverage.ts`**：`DIALOG_SURFACE_SECTIONS` 里去掉 `group-dialog`；新增常量 `PROJECT_DETAIL_SECTIONS = ['overview', 'members', 'grants', 'schedules', 'danger'] as const`（与 README §4.11 的 `ProjectSettingsSection` 一致，shared 与 renderer 共用一份）；覆盖测试里「`project-detail` 的 section 必须属于 `PROJECT_DETAIL_SECTIONS`」代替原来「对话框固定 section 名」的断言；`{ kind: 'action', id: 'groups.delete', … }` → `{ kind: 'action', id: 'projects.delete', reason: '删除项目组：破坏性动作（项目详情页「危险区」内）' }`。**锚点自检**：`PENDING_DESKTOP_ANCHORS` 机制会扫渲染层源码找 `data-settings-anchor`；本 WP 先把 `project-title` / `project-goal` / `project-members` / `project-lead` 四个锚点**登记到 `PENDING_DESKTOP_ANCHORS`**，WP7 在详情页里补上真正的 `data-settings-anchor` 后再删掉（测试会检查「列在 pending 里的锚点确实还不存在」，所以 WP7 必须同步删）。
4. **`mode.ts`**：上下文字段 `isGroup` 在 WP1 已改 `isProject`；兜底规则的文案「群聊中只能出卡，不能直接修改」→「项目组中只能出卡，不能直接修改」。`SETTING_DIRECT_TRIGGERS` **不变**。
5. **core adapters**（`settings/adapters.ts` 约 l.1446–1514）：`groupConversation()` → `projectConversation()`（拒绝非 project：`INVALID_INPUT`「该会话不是项目组」）；`groupTitleAdapter` → `projectTitleAdapter`（读 title；写 `projects.update`）；`groupMembersAdapter` → `projectMembersAdapter`（提议 = 现有成员 ∪ 提议的 Bot，沿用 `proposal`；**排除管家**）；**新增** `projectGoalAdapter`（读脱敏当前值；提议写 `goal`；`goal` 属用户文本，按文本字段处理）、`projectLeadAdapter`（读：当前负责人名；`values.botId` 必须是成员 / 非管家）；注册表 id 同步（约 l.1943）。`settings/host.ts`：`item.scope === 'project'` 需要 `conversationId`。
6. **renderer 设置卡**（只做编译修复）：`features/settings-card/card-components.ts`、`SettingCardEmbed.svelte` 里 `'group-title'` / `'group-members'` 指向的组件在 WP7 才有（`ProjectMembersEditor` 等）。**本 WP 的临时处理**：把这四个卡键都映射到现有的 `GroupSettingsDialog` 嵌入模式并只保证编译（`project-goal` / `project-lead` 暂映射为「在项目详情里修改」的链接卡 `link` 兜底，设置目录规定「没有内嵌组件的条目兜底 link」），在代码上方加注释 `// WP7 replaces these with ProjectMembersEditor / ProjectSettingsPage embeds`，并登记到实施记录。`card-components.test.ts`（自检卡键与组件映射）同步调整，使其通过。

### E. 记忆库迁移

1. `packages/core/migrations/memory/0003_origin_project.sql`（重建 `memory_items`；FTS 表 `memory_fts` 以 `item_id` 非外部内容引用，**不受影响**；向量表由代码按维度创建，同样不受影响）：

```sql
-- D92 T1a: memory_items.origin 'group' -> 'project'.
CREATE TABLE memory_items_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'fact', 'preference', 'commitment', 'feedback', 'episode', 'lesson', 'self_note')),
  content         TEXT NOT NULL,
  subject         TEXT,
  source          TEXT NOT NULL CHECK (source IN ('explicit', 'inferred')),
  evidence_json   TEXT NOT NULL,
  origin          TEXT NOT NULL CHECK (origin IN ('private', 'project')),
  origin_conversation_id TEXT,
  confidence      REAL NOT NULL,
  sensitivity     TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
  private_to_bot  INTEGER NOT NULL DEFAULT 0,
  due_at          INTEGER,
  valid_until     INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retracted', 'void')),
  supersedes      TEXT,
  last_used_at    INTEGER,
  use_count       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
INSERT INTO memory_items_new
  (id, kind, content, subject, source, evidence_json, origin, origin_conversation_id, confidence, sensitivity,
   private_to_bot, due_at, valid_until, status, supersedes, last_used_at, use_count, created_at, updated_at)
SELECT id, kind, content, subject, source, evidence_json,
       CASE origin WHEN 'group' THEN 'project' ELSE origin END,
       origin_conversation_id, confidence, sensitivity,
       private_to_bot, due_at, valid_until, status, supersedes, last_used_at, use_count, created_at, updated_at
  FROM memory_items;
DROP TABLE memory_items;
ALTER TABLE memory_items_new RENAME TO memory_items;
CREATE INDEX memory_active ON memory_items(status, kind);
```

   开工前先核对 0001 的列清单与本 SQL 一致（调研时一致），并确认没有后续迁移改过 `memory_items`（调研时 0002 只是 wiki_fts）。该 SQL 已用 SQLite 验证过：旧 `'group'` 行变 `'project'`，`private` 保留，FTS 行保留。
2. TS：`memory/store.ts` 的 `origin: 'private' | 'group'`（两处约 l.57、l.103）→ `'private' | 'project'`；`memory/service.ts`（约 l.411、l.486）写入值改 `'project'`，**删除 WP1 留下的 `stored value stays 'group'` 注释**；`memory/retrieve.ts` / `service.ts` 里按 `origin === 'group'` 的判断（`rg -n "'group'" packages/core/src/memory`）全改。
3. **测试**：新增 `test/unit/memory-origin-migration.test.ts`：建到 memory 版本 2 → 插入 `origin='group'` 与 `'private'` 的条目与 FTS 行 → 应用 0003 → 断言取值、FTS 行、索引 `memory_active`、`CHECK` 拒绝 `'group'`；`memory-retrieval.test.ts`（约 11 处）、`memory-lifecycle.test.ts` 等里的 `'group'` 取值改 `'project'`；检查是否有测试写死 memory 迁移数量（`rg -n "migrations/memory|memory.*user_version" packages/core/test`）。

### F. `group` 字面量与措辞清扫

```bash
rg -n "'group'|\"group\"" packages -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**'
rg -n "GROUP_MENTION_PREFIX|groupMentionToken|'group:'" packages apps -g '!node_modules' -g '!**/dist/**'
rg -n "群聊|群成员|群里|本群|群内|同群|建群|解散群|群定位" packages/core/src packages/shared/src
```

- 第一条命令的剩余项**只允许**：`widgets/query-gate.ts` 的 SQL 关键字、设置目录条目里的 `group:` 分类字段（`'models'` / `'search'` …，那是另一个含义）。其它（`setupSurface: 'group'`（`orchestrator.ts` 约 l.4127、`setup-tools.ts` 约 l.199、`tools/index.ts` 约 l.144）、`route: 'group'`、`proposalType: 'group'`、assignee `kind: 'group'` 等）逐一改 `'project'`。
- **跨项目 `@` 引用的 mention token**（`packages/shared/src/domain/types.ts` 约 l.1190–1200）：`GROUP_MENTION_PREFIX = 'group:'` → `PROJECT_MENTION_PREFIX = 'project:'`；`groupMentionToken` → `projectMentionToken`；`parseMentionToken` 返回 `{ kind: 'bot' | 'project'; id }`。使用处：`core/src/agent/context/conversation.ts`（约 l.269、l.392，含 AI 文本渲染时补的「（群聊）」图例 → 「（项目组）」）、`core/src/dispatch/orchestrator.ts`、`core/test/unit/context-assembly.test.ts`，以及渲染层 `features/chats/composer-text.ts`（`buildMentionTargets` 里 `kind: 'group'` → `'project'`）与 `composer-text.test.ts`、`composer-editor.test.ts`（本 WP 只做这些渲染层文件的**编译与测试修复**；`composer.mentionGroup` 文案归 WP8）。已存在于旧消息里的 `group:` token 不迁移（早期阶段，无兼容负担）。
- 第二条命令：发给 **LLM** 的文本（系统提示规则、工具描述、工具返回文案、系统消息）里指「群聊 / 群」的，改为「项目组」；指「项目组里的沟通」的，用「沟通」。已知位置：`tools/index.ts` 的 `send_message` 描述（「`@` 其他 Bot 只能在群聊」）、任务工具描述（「任务不能 `@` 群成员」）、`dispatch/delegation.ts`（同群降级 D4 `@` 的提示）、`dispatch/butler.ts` 的返回文案、`domain/lifecycle.ts` 与 `approvals.ts` 的用户可见文案、`dispatch/orchestrator.ts` 的系统消息。**渲染层的文案归 WP8**。
- 注释与测试描述里的「群」也一并改（不改会让后续读代码的人困惑，但不是验收硬指标）。

## 4. 测试

**改写**：`test/integration/butler.test.ts`、`butler-team.test.ts`（→ `butler-bots.test.ts`）、`butler-route.test.ts`、`unit/butler-delegation-migration.test.ts`、`handover.test.ts`（约 l.208 的工具名）里的工具名、载荷、文案；`workbench-service.test.ts`、`workbench-stores.test.ts`、`workbench-tools.test.ts`、`workbench.test.ts`、`workbench-update.test.ts` 里的 assignee 形状与文案；`packages/shared/test/unit/settings-catalog.test.ts`（约 l.71–74 的条目 id 列表、约 l.288 的 `itemIdsForServiceMethod('groups.rename')` → `'projects.update'`，现在对应 `project.title` **与** `project.goal` 两项，断言改成它们）、`settings-mode.test.ts`（约 l.415 的 `item('group.title')` → `'project.title'`）、`settings-catalog-host.test.ts`；`apps/desktop` 的 `card-components.test.ts`、`setting-card-model.test.ts`、`workbench-model.test.ts`、`assignee-sections.test.ts`、`todo-form.test.ts`。

**新增**：
1. `test/unit/system-prompt-project.test.ts`：`<conversation_info>` 项目分支的完整文本（含目标、负责人行带 / 不带「（你）」、成员卡 `[负责人]` 标记、无目标时省略）；`projectRole` 为 `'lead'` / `'member'` / 缺省时分别注入 `project_lead_rules` / `project_member_rules`（含负责人名字代入）/ 都不注入；单聊与任务面不注入；规则段位置在 `conversation_info` 之后、`<workdir>` 之前。
2. `test/integration/butler-project.test.ts`：`propose_project`（负责人不在成员里 / 含管家 / 成员 < 2 → 工具失败结果；成功 → 审批卡）；用户批准且**改了负责人**（`approvals.decide` 带 `leadBotId`）→ 建出的项目负责人是改后的；`leadBotId` 不在载荷成员里 → 错误；`propose_bots` 行为与原 `propose_team` 一致（数量 3–5）；`suggest_route` 的 `'project'`。
3. `test/integration/workbench-project.test.ts`：事项指派给项目组、不指定负责 Bot → 派发消息带对**项目负责人**的结构化 `@`，**不经路由**（没有 `continuation` / `routing_gate` run）；指定了覆盖项 → `@` 覆盖项；覆盖项不是成员 → 校验失败；项目组被删 / 变只读 → 事项退回草案、`blocked_reason` 为「项目组已解散」等新文案；`todos` 迁移 `0042` 测试（列改名且值保留）。
4. `test/unit/settings-adapters-project.test.ts`：`project.title` / `project.goal` / `project.members` / `project.lead` 的读与提议；`project.lead` 对非成员 / 管家拒绝；`effectiveMode` 对四项均不会是 `direct`；对非 project 会话拒绝。
5. `test/unit/memory-origin-migration.test.ts`（E.3）。

## 5. 验证

```bash
pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/shared typecheck
pnpm --filter @kepcup/core run build && pnpm --filter @kepcup/core typecheck
pnpm --filter @kepcup/desktop typecheck && pnpm lint
node scripts/run-tests.mjs run packages/core/test/unit/system-prompt-project.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/butler-project.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/workbench-project.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/settings-adapters-project.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/memory-origin-migration.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/butler.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/workbench.test.ts
node scripts/run-tests.mjs run packages/shared
node scripts/run-tests.mjs run --project desktop
node scripts/run-tests.mjs run packages/core/test/integration/create-core.test.ts
```

本 WP 改了 shared 契约与两类迁移，结束前**跑一次全量**，失败集合不超出基线。

## 6. 验收清单

- [ ] 自检（全部为空，允许项见 F）：

```bash
rg -n "propose_team|propose_group|BUTLER_TEAM_SIZE|assignee_group_id|listByAssigneeGroup|group_id|group-title|group-members|group-dialog|groups\.delete|isGroup" packages apps -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**'
rg -n "memory.*'group'|origin.*'group'" packages/core/src
rg -n "GROUP_MENTION_PREFIX|groupMentionToken|'group:'" packages apps -g '!node_modules' -g '!**/dist/**'
```

- [ ] `<conversation_info>` 与两段规则符合 §3.A；任务面与单聊不受影响。
- [ ] `propose_project` / `propose_bots` / `suggest_route('project')` 生效；卡上可改负责人（`approvals.decide.leadBotId`）；`#createProject` 不再有临时负责人。
- [ ] 工作台：指派给项目组默认 `@` 负责人，覆盖项可选，文案全为「项目组」；`0042` 迁移与测试通过。
- [ ] 设置目录：`project.title` / `.goal` / `.members` / `.lead` 四项，深链落点 `project-detail`，覆盖测试通过；四个锚点已登记到 `PENDING_DESKTOP_ANCHORS`（WP7 删）。
- [ ] 记忆库迁移 `0003` 与测试通过；`origin` 取值全仓为 `'private' | 'project'`。
- [ ] 发给 LLM 的文本里不再有「群聊 / 群成员」；全量失败集合不超出基线。
- [ ] 实施记录已填（含渲染层的临时处理清单：设置卡临时映射、审批卡只做编译修复）。

## 7. 陷阱

- `project.lead` / `project.goal` 的 `maxMode` 是 `confirm`，不是 `direct`：Bot 改负责人 / 项目目标必须出卡让用户确认（目标会注入全员提示词，被污染影响面大）。
- 规则段要**按 (Bot, 对话) 拼装**；不要把它们写进 Bot Profile，也不要新增 `system_role`。
- 项目 wiki 相关的一句规则（`wiki_enqueue scope=project`）**不要**在这个 WP 写进规则文字：对应参数在 WP10 才存在，提前写会让模型调用不存在的参数。WP10 会补进这两段规则。
- `settingSurface` 的 `'project-detail'` 不是对话框：不要给它套 `DIALOG_SURFACE_SECTIONS`（那是对话框固定 section 名），用 `PROJECT_DETAIL_SECTIONS`。
- 记忆库迁移改的是**每个 Bot 的 `memory.db`**，在各库首次打开时执行；测试里要用 `memory` 迁移目录单独跑，不是 main。
- 设置目录的 `group:` 分类字段（`'models'` / `'search'` …）与「群」无关，**不要改**。

## 8. 实施记录

- 状态：已完成。
- 分支：`feat/project/migration`（延续 WP0–WP3 / WP9 的集成分支；未另开 `feat/project/wp4-integrations`，与 WP1–WP3 先例一致）。
- 提交：
  - `e7013fa` `feat(shared,core,desktop)!: finish the project-team integrations — prompts, butler tools, workbench, settings catalog, memory origin (D92 T1a WP4)`（本 WP 全部代码与测试合成一个功能提交——改名 / 契约 / 行为互相耦合，无法拆出「每个提交可独立构建」的多个提交，与 WP3 接续先例一致）；
  - `748d63d` `fix(core): bump the two migration-version lists that 0042 invalidated`（收口全量发现的两处漏改版本号断言）；
  - 实施记录与文档提交（`docs(todo,dev): record WP4 implementation and progress`）。
- **接续说明**：本 WP 由执行智能体接续前一位代理留下的未提交半成品完成（工作区 25 个文件 + 同内容 stash 快照 `WP4 leftover snapshot`）。核对结论：
  - **保留（核对与任务书 / §4 契约一致，质量合格）**：shared 契约（`BotCard.isLead`、载荷 `'bots'|'bot'|'project'` + `leadBotId`、`todoAssignee` project 分支、`memoryOrigin`、`PROJECT_MENTION_PREFIX`、常量 `PROPOSE_BOTS_MIN/MAX`、`approvalsDecideInputSchema.leadBotId`、设置目录四条目 / `project-detail` surface / `PROJECT_DETAIL_SECTIONS` / `PENDING_DESKTOP_ANCHORS` 四锚点、`EXCLUDED_SETTING_LOCATIONS` 的 `group-*` 临时锚点排除、`projects.delete` 排除理由）、core 的 `<conversation_info>` 项目分支与规则段、`#memberCards` 负责人标记、`propose_bots` / `propose_project` / `suggest_route` 工具层、`butler.ts` 的管家成员校验与路由卡文案、memory 四文件、两个迁移 SQL（与 §4.3 / §3.E 的字面 SQL 一致）、shared 单测改写、`my-state.ts`。
  - **修正的偏差**：① `system-prompt.ts` 的 `SystemPromptInput.projectRole` JSDoc 缩进坏行 → 修复；② `butler.ts` `#createBots` 的载荷类型仍写 `'team' | 'bot'` → 改 `'bots' | 'bot'`（半成品漏改，typecheck 报错）；③ `#createProject` 已按 WP 删除了 WP1 的 `memberBotIds[0]` 临时负责人 ✓（核对项）。
  - **补齐的缺口**（半成品未覆盖的全部实现面）：工作台三件（`todo-store.ts` 列名 / `rowToAssignee` / `listByAssigneeProject`、`todo-service.ts` 的 project assignee / 生效负责人解析（`assignee.leadBotId ?? conversation.leadBotId`，派给项目组总是带结构化 @）/ `BLOCKED_*` 新文案 / `toEntry` 的实际生效 `leadBotName`、`workbench-tools.ts` 的 `project_id` 入参）、`approvals.decide` 的 `leadBotId` 校验与 `decision_json` 写入 + RPC 绑定传参、settings 四适配器（`projectTitle/Goal/Members/Lead`，含管家排除与负责人成员校验）与 `start.ts` 的 `projects.setLead` 装配、`settings/host.ts` 与 `mode.ts` 规则代号 `'group' → 'project'`、`tools/{index,setup-tools}.ts`、`classify.ts`、`settings/context.ts`、handover 适配器与委派 / 污点 / llm-router 等的「群」文案清扫（core / shared src 的「群」字样清零）、`propose_team` 在 `domain/butler.ts` Profile 模板与 `BUTLER_SETUP_RULES` 的残留、renderer 全部编译修复（审批卡 project 分支 + 只读负责人行、工作台 9 文件、设置卡四键映射、composer-text / MessageBody / Composer / RouteCard / permissions store、i18n 七个 key 改名 + 三个新 key）、`tool-labels.ts`、既有测试改写（butler-team 改名 butler-bots、workbench 四件、context-assembly、memory、handover、delegation-host、create-core 42、workbench-migration 42、settings 三件、desktop 九件）与五个新测试文件。
- **临时处理清单**（渲染层，WP5–WP8 重写）：
  - 设置卡：`project-title` / `project-members` / `project-goal` / `project-lead` 四键都映射到现有 `GroupSettingsDialog` 嵌入模式（goal / lead 暂落成员段），`cardEmbeddable` 四键都要求 `conversationId`，代码处有 `// WP7 replaces these…` 注释；`deep-link.ts` 的 `project-detail` 动作暂调 `sidebarDialogs.openGroupSettings`（WP7 换 `shell.openProjectSettings`）；`GroupSettingsDialog` 的 `data-settings-anchor="group-title"/"group-members"` **保留旧名**（改名会撞 `PENDING_DESKTOP_ANCHORS`「锚点尚不存在」断言，WP7 删对话框时一并处理）。
  - 审批卡（`ApprovalCard.svelte`）：只做编译修复——`proposalType === 'project'` 分支渲染 title / goal / 只读负责人行（新 i18n key `approvals.butlerGroupLead`）/ 成员 / reason；卡上改负责人的下拉与文案归 WP8；`approval-butler-group-*` testid 与 `butlerGroup*` i18n key 名未改（WP8）。`RouteCard` 的 kind 分支改 `'project'`（保持功能可用），`route.openGroup` key 名归 WP8。
  - 工作台：`TodoDrawer` 的负责 Bot 选择器默认显示「项目负责人（{name}）」（新 key `workbench.drawer.leadProjectDefault`，NONE 项文案 `leadProjectOption`）；`workbench-model.ts` 的 `groupLaneId → projectLaneId`、`groupMembers → projectMembers`、道 kind `'project'`、key 前缀 `project:`；`MemberAvatar` kind `'project'`（仍引 `GroupAvatarStack`，WP6 改名）；`SelfScheduleCard` / `ScheduleReceipt` 的 testid 顺手改 `*-project`（不在 WP8 清单内的小项）。
- 偏差：**DEV-033**（验收 rg#1 的 13 处剩余命中逐一核对为四类：GroupSettingsDialog 锚点、审批卡 testid、linear.tools.json 的外部 API 字段 `isGroup`、0042 迁移夹具的旧列名——均属 WP7/WP8 待办或迁移夹具，core / shared 源码内旧名已清零）。不占编号的执行判断：① `SettingModeRule` 的规则代号 `'group'` 改名 `'project'`（WP D.4 只提文案，但 F 的 `'group'` 字面量清扫要求覆盖它；测试与日志用的内部代号，无外部兼容面）；② `buildSystemPrompt` 在 `projectRole` 之外按 `conversation.type === 'project' && loop === 'turn'` 兜底（WP §4.1 测试要求「单聊与任务面不注入」在构造器侧成立，生产路径本就不传）；③ workbench 派发旧「网关路由 / 兜底」三用例按 C.3「不再走路由」改写为「@ 项目负责人 / 覆盖项 / 空回复 unclaimed」，`workbench-update` 的 M2 改写为「负责人任务挂起时更新通知照发」（网关等待窗在新语义下不存在）；`workbench.test.ts` 旧「未指定负责 Bot → leadBotId 为空」「排期行 bot_id 为空」断言按新契约改为「带生效负责人」。
- 测试结果（定向全绿后收口跑全量）：typecheck 三包 + `pnpm lint` 通过；定向全绿：shared 338、desktop 767、butler.test 4 / butler-bots 9 / butler-route 3 / butler-project 5、workbench 25 / workbench-update 13 / workbench-service 116 / workbench-stores 20 / workbench-tools 34 / workbench-migration / workbench-project 5、project-routing 9 / project-chat、settings-cards + settings-catalog-host 68 / settings-item-writes 34 / settings-adapters-project 8、system-prompt-project 10、memory-origin-migration 2、context-assembly / conversation-events / handover-adapters ±p1 / delegation-host / external-agent-p2 / create-core 等。
  全量 `pnpm test`（收口跑）：**5475 通过 / 2 失败 / 23 skip**，失败集合不超基线——两次运行为同一对「写死版本号」断言（`project-conversations-migration` 期望 `[39,40,41]`、`workdirs-rename-migration` 期望 `[38,…,41]`，半成品漏改且定向清单未覆盖），`748d63d` 修正后两文件单跑通过；第一次运行另有 `environment.test.ts` 一条负载相关的未处理错误日志（该文件第二次运行 14 例全绿，属基线「负载偶发」类，未计失败）。第一次全量的输出被执行管道截断，按「偶发失败单跑复核」惯例以第二次完整日志为准。
- 验收清单核对（§6）：
  - rg#1：DEV-033（13 处四类允许命中，详见该条；core / shared 源码零命中）；rg#2（memory origin）：✅ 空；rg#3（mention token）：✅ 空；
  - `<conversation_info>` 与两段规则符合 §3.A；任务面与单聊不注入：✅（`system-prompt-project` 10 例）；
  - `propose_project` / `propose_bots` / `suggest_route('project')` 生效；卡上改负责人；`#createProject` 无临时负责人：✅（`butler-project` 5 例）；
  - 工作台 @ 生效负责人、覆盖项、新文案、0042：✅（`workbench-project` 5 例 + workbench 六件改写）；
  - 设置目录四项 + `project-detail` 深链 + 四锚点登记 `PENDING_DESKTOP_ANCHORS`：✅（`settings-adapters-project` 8 例 + shared settings-catalog 套件）；
  - 记忆库迁移 0003 与 `origin` 全仓取值：✅（`memory-origin-migration` 2 例，rg#2 空）；
  - 发给 LLM 的文本无「群聊 / 群成员」：✅（core / shared src 的「群」字样仅存「项目组」措辞）；全量失败集合不超基线：✅；
  - 实施记录已填（含渲染层临时处理清单）：✅。
- WP1 登记的归本 WP 遗留：suggest_route `'group'`、butler 载荷 `'group'`、TodoAssignee `'group'`、记忆 origin 存量、提示词文案、`GROUP_MENTION_PREFIX` 替换、butler `#createProject` lead 暂取转正、设置目录 store.methods 临时处理转正——全部在本 WP 完成（`projects.update` / `projects.addMembers`+`removeMember` / `projects.setLead` 已是正式 store 方法，无临时分支残留）。
