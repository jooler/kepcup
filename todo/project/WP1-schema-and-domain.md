# WP1 · 契约、迁移与领域层（`group → project`、必有负责人）

> 依赖：WP0-2 已合入。后续：WP2、WP5、WP6、WP9。分支：`feat/project/wp1-schema`。
> 这是 T1a 的地基（对应工作台的 W0）：shared 契约 + 两个迁移 + 迁移运行器的 FK 关闭模式 + `ProjectsService` + 生命周期 + RPC + 删除 D60 后端 + 让 renderer 与测试**重新编译通过**。
> 先读 [README.md](README.md) §1、§4（全部固定契约）；设计依据 [41 §4–§5、§12.4–§12.5](../../docs/design/41-project-team.md)。

## 1. 目标与范围

做：
1. 迁移运行器支持「FK 关闭」模式（重建被 12 张表引用的 `conversations` 必须）。
2. 迁移 `0039`、`0040`。
3. shared：`conversationType`、`Conversation`、`projects.*` RPC、`ProjectMember`、常量、`project-modules.ts`、`project-title.ts`、错误码；删除 D60 相关契约。
4. core：`ConversationsService` 映射、新 `ProjectsService`、`LifecycleService`（负责人守卫）、RPC 绑定、`start.ts` 装配、删除 D60 四问后端。
5. **编译驱动的机械改名**：全仓 `conversation.type === 'group'` → `'project'`；用到 `GroupsService` / `groups.*` 的地方改用 `ProjectsService` / `projects.*`。
6. renderer：**最小编译修复**（类型、RPC 名、删 D60 卡片），行为保持；真正的界面改造归 WP5–WP7。
7. testkit 与测试：统一的建项目辅助；迁移 / 服务 / 生命周期 / RPC 的新增测试。

不做（留给后续 WP，**不要提前做**）：路由行为改动（WP3，`GroupTurnCoordinator` 保持原样，仅编译修复）、协作回合（WP2）、提示词新规则 / 管家工具改名 / 工作台 / 设置目录改名 / 记忆库 origin 迁移（WP4）、界面改造（WP5–WP7）。

## 2. 开工前核对

```bash
ls packages/core/migrations/main | tail -2     # 应是 0037_workbench.sql、0038_workdirs_rename.sql
rg -n "workdirs" packages/core/migrations/main/0038_workdirs_rename.sql
rg -c "type === 'group'|type !== 'group'" packages/core/src | awk -F: '{n+=$2} END{print n}'   # 调研时约 29
rg -l "type === 'group'|type !== 'group'" apps/desktop/src/renderer/src | wc -l                 # 调研时 17
```

必读源码：`packages/core/src/infra/migrate.ts`、`infra/db.ts`、`migrations/main/0018_task_events.sql`（头部注释讲清了「迁移在 FK 开启下执行、不能 DROP 被引用的父表」）、`0037_workbench.sql`（重建 `schedules` 的写法）、`domain/groups.ts`、`domain/conversations.ts`、`domain/lifecycle.ts`、`rpc/bindings.ts`（`groups.*` 与 `conversationView`）、`dispatch/orchestrator.ts` 中 D60 四问（搜 `beginGroupSetup`）。

## 3. 步骤

### 步骤 1：迁移运行器支持 FK 关闭模式

**为什么**：`conversations` 是 12 张子表的父表（`messages`、`attachments`、`conversation_members`、`grants`、`chains`、`schedules`、`watches`、`stickies`、`app_tool_grants`、`widgets`、`bot_handovers` 等，均 `ON DELETE CASCADE`）。迁移在 `foreign_keys=ON` 的事务里执行，`PRAGMA foreign_keys` 在事务内是空操作；此时 `DROP TABLE conversations` 会**级联删光所有子表数据**。SQLite 官方的重建流程（12 步）要求先关 FK。所以运行器要支持「该文件在 FK 关闭下执行」。

**改动** `packages/core/src/infra/migrate.ts` 的 `runMigrations`：

- 指令：迁移文件的**第一行**恰好是 `-- kepcup:foreign-keys=off`（去掉首尾空白后比较）。
- 有指令的文件：事务**之外**先 `db.pragma('foreign_keys = OFF')`；事务内 `db.exec(sql)` → `const violations = db.pragma('foreign_key_check') as unknown[]`，非空则 `throw new Error('foreign_key_check failed: ' + JSON.stringify(violations.slice(0, 5)))` → `db.pragma(\`user_version = ${file.version}\`)`；`finally` 里无论成败都 `db.pragma('foreign_keys = ON')`。
- 无指令的文件：行为**完全不变**。
- 失败仍包成 `AppError('MIGRATION_FAILED', …)`（保持现有格式）。

**测试**（新增 `packages/core/test/unit/migrate-fk-off.test.ts`，用临时目录里的合成迁移文件 + 内存库，参照现有 `migrate.test.ts`）：
1. 带指令的迁移可以 `DROP` 一个被子表引用的父表而**不级联删子表行**，结束后子表行仍在；
2. 迁移结束后 `PRAGMA foreign_keys` 为 `1`（不论成功还是失败）；
3. 带指令的迁移里制造外键违例 → 抛 `MIGRATION_FAILED`，`user_version` 不前进，事务回滚；
4. 不带指令的迁移仍在 FK 开启下运行（`PRAGMA foreign_keys` 在迁移内为 `1`）。

### 步骤 2：迁移 0039、0040

**先核对表结构**（不要凭记忆）：

```bash
rg -n "messages_fts" packages/core/migrations/main/*.sql           # 确认 FTS 表的列名是 conversation_id
rg -n "system_role|status" packages/core/migrations/main/0016_butler_and_delegation.sql packages/core/migrations/main/0001*.sql | head
```

`packages/core/migrations/main/0039_project_prepare.sql`：

```sql
-- D92 T1a: prepare legacy group conversations for the 'project' type.
-- A project needs a lead. Groups with no active non-butler member (and D60 "creating" leftovers)
-- cannot be converted and are removed here; foreign_keys is ON, so child rows cascade.
DELETE FROM messages_fts WHERE conversation_id IN (
  SELECT c.id FROM conversations c
   WHERE c.type = 'group'
     AND (c.setup_state IS NOT NULL
          OR NOT EXISTS (
               SELECT 1 FROM conversation_members m JOIN bots b ON b.id = m.bot_id
                WHERE m.conversation_id = c.id AND b.status = 'active' AND COALESCE(b.system_role, '') <> 'butler')));

DELETE FROM conversations
 WHERE type = 'group'
   AND (setup_state IS NOT NULL
        OR NOT EXISTS (
             SELECT 1 FROM conversation_members m JOIN bots b ON b.id = m.bot_id
              WHERE m.conversation_id = conversations.id AND b.status = 'active' AND COALESCE(b.system_role, '') <> 'butler'));
```

> 若 `messages_fts` 的列名与上不符，按实况改；若该表不含 `conversation_id`，删掉第一条语句并在实施记录说明。**没有 FK 的表**（`approvals`、`agent_sessions`、`delegations`、`jobs`、`usage_ledger`、`run_changes`、`todo_runs`）会留下指向已删会话的孤儿行：这是开发库的遗留数据，**预期且接受**，不要为此写清理 SQL。

`packages/core/migrations/main/0040_project_conversations.sql`（**第一行必须是指令**）：

```sql
-- kepcup:foreign-keys=off
-- D92 T1a: conversations.type 'group' -> 'project'; mandatory lead; description -> goal; drop setup_state.
CREATE TABLE conversations_new (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('direct', 'project')),
  title            TEXT,
  goal             TEXT,
  direct_bot_id    TEXT REFERENCES bots(id),
  lead_bot_id      TEXT REFERENCES bots(id),
  workdir_id       TEXT,
  read_only        INTEGER NOT NULL DEFAULT 0,
  summary          TEXT,
  summary_upto_seq INTEGER NOT NULL DEFAULT 0,
  last_seq         INTEGER NOT NULL DEFAULT 0,
  last_read_seq    INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER,
  created_at       INTEGER NOT NULL,
  CHECK ((type = 'project') = (lead_bot_id IS NOT NULL))
);

INSERT INTO conversations_new
  (id, type, title, goal, direct_bot_id, lead_bot_id, workdir_id, read_only, summary,
   summary_upto_seq, last_seq, last_read_seq, last_message_at, created_at)
SELECT c.id,
       CASE c.type WHEN 'group' THEN 'project' ELSE c.type END,
       c.title,
       c.description,
       c.direct_bot_id,
       CASE WHEN c.type = 'group' THEN (
         SELECT m.bot_id FROM conversation_members m JOIN bots b ON b.id = m.bot_id
          WHERE m.conversation_id = c.id AND b.status = 'active' AND COALESCE(b.system_role, '') <> 'butler'
          ORDER BY m.joined_at, m.bot_id LIMIT 1) END,
       c.workdir_id, c.read_only, c.summary,
       c.summary_upto_seq, c.last_seq, c.last_read_seq, c.last_message_at, c.created_at
  FROM conversations c;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE UNIQUE INDEX conversations_one_direct_per_bot
  ON conversations(direct_bot_id) WHERE type = 'direct' AND read_only = 0;

-- The butler is no longer a project participant (D92 K9): drop legacy memberships.
DELETE FROM conversation_members
 WHERE conversation_id IN (SELECT id FROM conversations WHERE type = 'project')
   AND bot_id IN (SELECT id FROM bots WHERE system_role = 'butler');
```

- **`workdir_id` 保持无 FK**（与原 `project_id` 一致）。
- 列清单必须与你核对出的 `conversations` 现状一致：`ALTER`/`PRAGMA table_info(conversations)` 在 0039 之后的库上跑一遍对照；若有遗漏列（调研时没有），补进去。
- 重建流程是 SQLite 官方 12 步：FK 关闭 → 建新表 → 复制 → `DROP` 旧表 → `RENAME` 新表 → 重建索引；子表里 `REFERENCES conversations(id)` 的文本不变，会自然指向新表。运行器会在事务内做 `foreign_key_check`。

**迁移测试**（新增 `packages/core/test/unit/project-conversations-migration.test.ts`，参照 `workbench-migration.test.ts` 的升级写法：先建到 38）：
1. 准备数据：butler + 2 个普通 active Bot + 1 个 `status` 非 active 的 Bot；会话：1 个单聊；1 个有成员的旧群（成员入群顺序：butler 最早、Bot A、Bot B；`description` 非空）；1 个 `setup_state='creating'` 的旧群；1 个没有任何合格成员的旧群；给保留与待删的会话都挂上 `messages`（含 `messages_fts` 行）、`grants`、`schedules`、`chains` 子表行。
2. 应用 0039、0040 后断言：单聊原样保留（`type='direct'`、`lead_bot_id` 为 NULL）；有成员的旧群变 `type='project'`，`lead_bot_id` = **入群最早的非管家 active 成员（Bot A）**，`goal` = 旧 `description`，butler 的成员行被删除，其余成员行保留；两个不可转换的旧群及其子表行、`messages_fts` 行都已消失；保留会话的子表行**全部还在**（行数与迁移前一致）；`PRAGMA foreign_key_check` 为空；`PRAGMA foreign_keys` 为 1。
3. `CHECK` 生效：插入 `type='project'` 且无 `lead_bot_id` 被拒；插入 `type='direct'` 且有 `lead_bot_id` 被拒。
4. 唯一索引 `conversations_one_direct_per_bot` 仍有效（同一 Bot 两个未只读单聊被拒）。

**更新写死的版本号断言**：`create-core.test.ts` main `toBe(38)` → `toBe(40)`；`workbench-migration.test.ts` 的 `toEqual([37, 38])` → `[37, 38, 39, 40]`（以实况为准）。

### 步骤 3：shared 契约（`packages/shared/src`）

逐项（名字以 README §4 为准）：

1. **`domain/types.ts`**：
   - `conversationTypeSchema = z.enum(['direct','project'])`；
   - `conversationSchema`：**删除** `setupState`；`description` → `goal: z.string().nullable().optional()`；**新增** `leadBotId: z.string().nullable().optional()`；
   - `GROUP_MEMBER_PREVIEW_MAX` → `PROJECT_MEMBER_PREVIEW_MAX`（定义在此文件，约 l.763）；
   - `systemEventContentSchema`：**删除** `step`（D60 的 `group_setup_question` 步骤字段）；
   - 搜 `group_setup_question` / `GROUP_SETUP`，相关类型 / 注释一并清理。
2. **`constants.ts`**：删除 `GROUP_SETUP_QUESTION_EVENT`、`GROUP_SETUP_STEPS`；`GROUP_TITLE_MAX`（定义在 `domain/group-title.ts`）→ `PROJECT_TITLE_MAX`；新增 `PROJECT_GOAL_MAX_CHARS = 4000`（其余新常量归 WP2 / WP3，**本 WP 不加**）。
3. **`domain/group-title.ts` → `domain/project-title.ts`**（`git mv`）：`groupTitleFromMemberNames` → `projectTitleFromMemberNames`（逻辑不变：名字用「, 」拼接，超过 `PROJECT_TITLE_MAX` 时丢掉放不下的名字）；同名测试文件改名；`index.ts` 导出同步。
4. **`domain/project-modules.ts`**（新增，按 README §4.13 原样）：`PROJECT_MODULE_IDS`、`ProjectModuleId`、`ProjectModuleWrite`、`ProjectModuleDescriptor`、`PROJECT_MODULES`、`ProjectActor`、`canWriteModule`、`canManageEntry`；从 `index.ts` 导出。
5. **`errors.ts`**：新增错误码 `PROJECT_LEAD_REQUIRED`。
6. **`rpc/methods.ts`**：
   - 删除 `groups.*` 全部（`create`、`setup.start/answer/cancel`、`rename`、`addMembers`、`removeMember`、`redistribute`）及其 schema；
   - 新增 `projects.create`、`projects.setLead`、`projects.update`、`projects.addMembers`、`projects.removeMember`（input / output 见 README §4.5；`projectsCreateInputSchema` 的 `memberBotIds` 要求 `min(2)` 且用 `.superRefine` 校验包含 `leadBotId`；`title` 为 `min(1).max(PROJECT_TITLE_MAX)`；`goal` 为 `max(PROJECT_GOAL_MAX_CHARS)`；`projectsUpdateInputSchema` 用 `.refine` 要求 `title` 与 `goal` 至少一项）；
   - `groupMemberSchema` / `GroupMember` → `projectMemberSchema` / `ProjectMember`；
   - `botsDeletionPreviewOutputSchema` 新增 `ledProjects: z.array(z.object({ id: z.string(), title: z.string().nullable() }))`；
   - 更新注册表（约 l.1977 与导出列表约 l.2405）。
7. **不要**在本 WP 改：`triggerReasonSchema`、`runSchema` 的 chain 字段、`groupTurnPayloadSchema`（`group.turn`）、`butler_proposal` 载荷、`todoAssigneeSchema`——分别归 WP2 / WP3 / WP4。
8. **shared 测试**：新增 `packages/shared/test/unit/project-modules.test.ts`（`actor × module` 全表：`canWriteModule` 五个模块 × 三种 actor；`canManageEntry`：用户 / 负责人恒真，成员仅对自己创建的 `bot` 来源为真，对 `user` 来源与他人 Bot 来源为假；`wiki` 为 `'owner'`，`board` / `okr` / `calendar` 为 `'lead'`，`chat` 为 `'members'`）；`project-title.test.ts`（由 `group-title` 测试改名，断言不变）；`conversationSchema` 解析含 `leadBotId`、不含 `setupState`；`projectsCreateInputSchema` 拒绝 `memberBotIds` 不含 lead / 少于 2 个。

### 步骤 4：core 领域层

1. **`domain/conversations.ts`**：
   - `ConversationRow` 与 `conversationRowToConversation`：列 `goal`、`lead_bot_id`（映射 `goal`、`leadBotId`，direct 为 `null`）；删除 `setup_state` / `setupState`；类型联合 `'direct' | 'project'`；
   - 删除 `setSetupState` 与 `CONVERSATION_SETUP_CREATING`；
   - `setProject`（WP0-2 后叫 `setWorkdir`）保持；
   - 所有 `select` 列清单与 `insert` 同步新列。
2. **`domain/groups.ts` → 删除**；新建 **`domain/projects.ts`**（WP0-2 把原 `projects.ts` 改成了 `workdirs.ts`，此文件名已空出）。`ProjectsService`：

```ts
export interface ProjectMember { bot: Bot; joinedAt: number }
export interface ProjectsDeps {
  db: SqliteDatabase;
  clock: Clock;
  conversations: ConversationsService;
  bots: BotsService;
  /** Removal cascade (workspace / grants / approvals / runs) lives in lifecycle. */
  removeMemberCascade(conversationId: string, botId: string): Promise<void>;
  publishConversation(conversationId: string): void;
  /** Visible (non-internal) system message in the conversation; Bots see it in context. */
  appendSystemEvent(input: { conversationId: string; event: string; text: string }): void;
  /** Label of the conversation's bound workdir (for the "member joined" message), or null. */
  workdirLabelOf(conversationId: string): string | null;
}
class ProjectsService {
  create(input: { title: string; goal?: string | null; leadBotId: string; memberBotIds: string[] }): Conversation;
  setLead(conversationId: string, botId: string): Conversation;
  update(conversationId: string, patch: { title?: string; goal?: string | null }): Conversation;
  addMembers(conversationId: string, botIds: string[]): ProjectMember[];
  removeMember(conversationId: string, botId: string): Promise<void>;
  members(conversationId: string): ProjectMember[];
  memberPreviews(conversationId: string, limit?: number): Array<{ id: string; name: string; avatar: string | null }>;
  leadOf(conversationId: string): string | null;
  ledProjectsOf(botId: string): Array<{ id: string; title: string | null }>;
}
```

   行为（错误统一 `AppError`，文案为用户可见中文）：
   - **`create`**：`title` trim 后非空（`INVALID_INPUT`「项目组名称不能为空」）；`memberBotIds` 去重后 ≥ 2（「项目组至少需要 2 个成员（含负责人）」）；`leadBotId` 必须在 `memberBotIds` 里（「负责人必须是项目成员」）；每个 Bot 必须存在且 `status==='active'`（`NOT_FOUND`「Bot {id} 不存在或已删除」）；**任何成员（含负责人）是管家 → `INVALID_INPUT`「管家不能加入项目组」**；`goal` trim，空串存 `NULL`；事务里插 `conversations`（`type='project'`、`lead_bot_id`）与 `conversation_members`；`publishConversation`。**不写任何系统消息**。
   - **`setLead`**：会话必须是 project（`INVALID_INPUT`「该会话不是项目组」）；`botId` 必须是**成员**、active、非管家；与当前负责人相同则原样返回（不发消息）；`update conversations set lead_bot_id = ?`；`appendSystemEvent({ event: 'project_lead_changed', text: '负责人已更换为 {name}' })`（`name` 取 `bot.profile.identity.name || bot.name`）；`publishConversation`。
   - **`update`**：title / goal 校验同上（`goal` 超长抛 `INVALID_INPUT`）；`publishConversation`。
   - **`addMembers`**：拒绝管家；对**新加入**的每个成员 `appendSystemEvent({ event: 'project_member_joined', text })`，`text` 在会话绑定了工作目录时为 `{name} 已加入项目组，获得工作目录「{label}」的读写权限`，否则 `{name} 已加入项目组`；已是成员的跳过；`publishConversation`。
   - **`removeMember`**：成员必须存在（`NOT_FOUND`「该 Bot 不是项目成员」）；**若是负责人 → `AppError('PROJECT_LEAD_REQUIRED', '请先更换项目负责人')`**；否则走 `removeMemberCascade` 并 `publishConversation`。**不加成员数下限校验**（沿用现状）。
   - `members` / `memberPreviews`：沿用原实现（按 `joined_at, bot_id` 排序，预览前 `PROJECT_MEMBER_PREVIEW_MAX` 个）。
   - `ledProjectsOf(botId)`：`select id, title from conversations where type='project' and lead_bot_id = ? order by created_at`。
3. **`start.ts` 装配**（约 l.1081 的 `GroupsService` 构造处）：改为 `ProjectsService`；`appendSystemEvent` 用 `messages.append({ conversationId, senderType: 'system', kind: 'system_event', … })` 并 `events.emit('message.created', …)`——**参照 `workdir/service.ts` 的 `#systemMessage` 的写法与发布方式**，不要自创；`workdirLabelOf` 用 `workdirs` 服务按 `conversations.workdirId` 取名称（无则 `null`）。
4. **删除 D60 四问后端**：
   - `dispatch/orchestrator.ts`：`beginGroupSetup`、`answerGroupSetup`、`#appendGroupSetupCard`、`#groupSetupCurrentStep`、`#groupSetupCardSeq`、`#groupSetupAnswerText`（约 l.1309–1438）及所有调用；`group_created` 系统消息；
   - `tools/setup-tools.ts`：`GROUP_SETUP_QUESTIONS`（约 l.51–56）；
   - `domain/messages.ts`：约 l.108–109 的 `step` 处理；
   - `rpc/bindings.ts`：`groups.setup.*` 三个处理器（约 l.806–824）；
   - 测试：`test/integration/setup-path-gate.test.ts` 里 D60 的块（约 l.182–301）整段删除，其余保留。
5. **编译驱动的机械改名（core）**：
   - `type === 'group'` / `!== 'group'` → `'project'`，共约 29 处，清单（调研时）：`agent/context/system-prompt.ts`、`dispatch/{orchestrator,butler,delegation,handover,chains}.ts`、`domain/{conversations,messages}.ts`、`memory/{service,my-state,store}.ts`、`workbench/{todo-store,todo-service}.ts`、`tools/{workbench-tools,butler-tools,setup-tools,index}.ts`、`settings/{adapters,host}.ts`、`rpc/bindings.ts`。**排除** `widgets/query-gate.ts` 里 SQL 关键字 `'group'`。
   - 注意 `memory/store.ts` 的 `origin: 'private' | 'group'` 是**持久化的记忆库取值**：**本 WP 不改它**（WP4 有记忆库迁移）。`memory/service.ts` 里 `origin: conversation?.type === 'project' ? 'group' : 'private'` 只改比较、**写入值保持 `'group'`**，并在该行上方加一行注释 `// stored value stays 'group' until WP4 migrates memory.db`。
   - `groups` 依赖注入名 → `projects`（`OrchestratorDeps`、`ButlerHost` deps、`settings` deps 等）；`butler.ts` 的 `#createGroup` 现在要给 `projects.create` 一个 `leadBotId`：**本 WP 暂取 `proposal.memberBotIds[0]`**，加注释 `// WP4: the proposal will carry an explicit lead_bot_id`。
   - `settings/adapters.ts` 的 `groupTitleAdapter`（调 `deps.groups.rename`）→ 改调 `deps.projects.update(conversationId, { title })`；`groupMembersAdapter` 保持逻辑，仅改类型 / 名称依赖。**设置目录条目的 id / scope / surface 改名归 WP4**，本 WP 不动。
   - `dispatch/chains.ts` 里 `conversation.type !== 'group'` → `'project'`（WP2 会整体替换该文件）。
   - 原 `lifecycle.removeGroupMember` → `removeProjectMember`；`groupConversationIdsOf` → `projectConversationIdsOf`；`onGroupMemberRemoved`（`LifecycleDeps` / `memory/service.ts` / `start.ts`）→ `onProjectMemberRemoved`；`agentSessions.onGroupMemberRemoved` → `onProjectMemberRemoved`。
   - 其余带 `group` 的标识符（`isGroup` 等）：`settings/mode.ts` 的 `isGroup` 上下文字段、`memory/retrieve.ts` 的 `isGroup` → `isProject`（纯改名，含测试 `settings-mode.test.ts`、`memory-retrieval.test.ts`）。**`GroupTurnCoordinator` / `GroupRoundEnd` / `group-turn.ts` / `group.turn` 事件 / `triaging` 阶段不改**（WP3）。

### 步骤 5：生命周期与 RPC

1. **`domain/lifecycle.ts`**：
   - `deleteBot(botId)`：在管家守卫之后、**任何级联之前**：先取 `led = projects.ledProjectsOf(botId)`；`led.length > 0` 时抛 `AppError('PROJECT_LEAD_REQUIRED', message, { projects: led })`，其中 `message` 为「该 Bot 是 {n} 个项目组的负责人，请先更换：{项目名用「、」连接，无标题用 id}」。`bots.markDeleted` 作为后盾也加同样的检查（与管家守卫并列）。
   - `deletionPreview(botId)`：返回里增 `ledProjects: led`。
   - `removeProjectMember`：不需要再判断负责人（已由 `ProjectsService.removeMember` 拦在入口）；但保持它被 `bots.delete` 的群成员清理路径调用时的行为不变。
2. **`rpc/bindings.ts`**：
   - 新增 `projects.create` / `setLead` / `update` / `addMembers` / `removeMember` 处理器，返回值用 `conversationView(...)` 包装（`create` / `setLead` / `update`），`addMembers` 返回成员列表；
   - `conversationView`（约 l.334–352）：`memberPreviews` 的条件改为 `type === 'project'`；
   - 删除 `groups.*` 全部；`bots.deletionPreview` 返回新字段。

### 步骤 6：renderer 最小编译修复（**行为保持**，不做界面改造）

目标只是让 `pnpm --filter @kepcup/desktop typecheck` 与 desktop 单测通过、现有创建 / 查看群的流程仍可用。

```bash
rg -n "type === 'group'|type !== 'group'" apps/desktop/src          # 17 个文件，全部改 'project'
rg -n "setupState|\.description|groups\.|GroupSetup|answerGroupSetup|cancelGroupSetup|createGroupViaSetup|redistribute" apps/desktop/src
```

- `chat.svelte.ts`：`groups.create` → `projects.create`，入参增 `leadBotId`（**本 WP 临时取 `composeMemberIds[0]`**，加注释 `// WP5 replaces this with the two-round lead selection`）；`groups.rename` → `projects.update({ title })`；`groups.addMembers` / `removeMember` → `projects.*`；**store 方法同步改成 README §4.11 的名字**：`renameGroup` → `renameProject`、`addGroupMembers` → `addProjectMembers`、`removeGroupMember` → `removeProjectMember`（`updateProjectGoal`、`setProjectLead` 由 WP7 新增）；删除 `answerGroupSetup`、`cancelGroupSetup`、与 D60 相关的 store 代码；`redistribute` 已无后端，**删除**该函数及 `MessageBubble.svelte` 里「点选 Bot 重新分发」的 UI 分支（`group_no_claim` 事件本 WP 仍在后端产生，渲染层对它只显示文字、不再可点击；WP3 删除事件本身）。
- `MessageBubble.svelte`：删除 `group_setup_question` → `GroupSetupCard` 分支；**删除文件** `GroupSetupCard.svelte`；`ChatView.svelte` 里 `creating` / `groupSetup.*` 相关（`setupState`）整块删除；`i18n` 里 `groupSetup.*` 全部删除（`MessageKey` 类型检查会指出遗漏）。
- `Conversation.description` 的读取改 `goal`；`GroupInfo.svelte` 里若显示 / 编辑 `description`，同步改字段名（界面不改）。
- 成员视图类型 `GroupMemberView` 等跟随 shared 的 `ProjectMember` 改名即可（**组件文件名不改**，WP6 / WP7 处理）。
- 设置卡 `group-title` / `group-members` 的 RPC 调用改走 `projects.*`（`applySettingItem` 走的是设置目录的 store.methods，WP4 才改目录；若目录里的 `store.methods` 写的是 `groups.rename` 等字符串，**本 WP 先改成 `projects.update` / `projects.addMembers` / `projects.removeMember`**，否则运行时会找不到方法；`coverage` / 目录测试里的方法名断言同步）。

### 步骤 7：testkit 与测试

1. **testkit**（`packages/testkit/src/helpers.ts`，约 l.181–244）：`makeGroup` → `makeProject({ title, memberBotIds, leadBotId? })`（`leadBotId` 缺省取 `memberBotIds[0]`，调 `projects.create`）；`GroupDraft` → `ProjectDraft`；`sendDrafts` / `listMembers` / `sendBatch` 保持名字与行为，类型跟随。
2. **统一的 SQL 辅助**：新增 `packages/core/test/support/projects.ts`：`insertProjectConversation(db, { id, title?, leadBotId, memberBotIds? })`，插入 `type='project'`、`lead_bot_id`，并为 `memberBotIds`（默认含 lead）插 `conversation_members`。所有直接用 SQL 插 `'group'` 会话的测试都改用它或补 `lead_bot_id`（新 `CHECK` 要求）。调研时涉及：`workbench-service.test.ts`（26 处）、`workbench-stores.test.ts`（14）、`settings-catalog-host.test.ts`、`messages-visible.test.ts`、`workbench-migration.test.ts`、`watches-migration.test.ts`、`task-events-migration.test.ts`、`taint-egress.test.ts`、`reap-unbound-attachments-migration.test.ts`、`messages-viewer.test.ts`、`messages-task-events.test.ts`、`media-delivery.test.ts`、`delegation-host.test.ts`、`attachments-sweep.test.ts`、`app-tools-migration.test.ts`、`app-tool-grants.test.ts`、`app-tool-gateway.test.ts`、`app-tier.test.ts`（用 `rg -l "insert into conversations" packages/core/test` 复核）。**迁移类测试**（建到旧版本再升级）里插的是旧库的 `'group'` 行，应当保留 `'group'`（它们模拟旧库）——只有「迁移后」才跑的断言改。
3. 所有 `makeGroup(` / `groups.create` 调用（约 40 个测试文件，`rg -l "makeGroup|groups\.create" packages apps`）改 `makeProject(` / `projects.create`。
4. `test/integration/group-chat.test.ts` → `project-chat.test.ts`（`git mv` + 改名 + 用 `makeProject`）；**测试内容（含三层深度、token 预算、triage、redistribute）本 WP 保持不动**，WP2 / WP3 会重写它们；若其中的 `groups.redistribute` 用例因 RPC 已删而无法运行，**本 WP 将该用例标 `it.skip` 并在 `skip` 上方注释 `// removed in WP3`**（这是本项目唯一允许的跳过，WP3 必须删除它）。
5. **新增测试**：
   - `test/unit/projects-service.test.ts`：`create`（正常；缺 lead / lead 不在成员里 / 成员 < 2 / 含管家 / 含非 active Bot / 空标题 → 对应错误；`goal` 空串存 NULL）；`setLead`（成功并写 `project_lead_changed` 系统消息与 `publishConversation`；非成员 / 管家 / 非 project 会话 → 错误；同一人 → 不发消息）；`update`；`addMembers`（新成员写 `project_member_joined`，绑定工作目录时文案含目录名；已是成员不重复；管家被拒）；`removeMember`（负责人 → `PROJECT_LEAD_REQUIRED`；普通成员正常）；`ledProjectsOf`。
   - `test/unit/lifecycle-project-lead.test.ts`（或并入现有 lifecycle 测试）：`deleteBot` 对负责人抛 `PROJECT_LEAD_REQUIRED` 且**没有任何级联发生**；更换负责人后可删；`deletionPreview().ledProjects`。
   - `test/integration/projects-rpc.test.ts`：经 RPC 走 `projects.create`（返回 `leadBotId`、`type==='project'`）、`setLead`、`update`、`addMembers`、`removeMember`（对负责人返回错误码）、`conversations.list` 里项目带 `leadBotId` 与 `memberPreviews`、`bots.deletionPreview` 的 `ledProjects`。
   - 迁移测试（步骤 1、2）。

## 4. 验证

```bash
pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/shared typecheck
pnpm --filter @kepcup/core run build && pnpm --filter @kepcup/core typecheck
pnpm --filter @kepcup/desktop typecheck && pnpm lint
node scripts/run-tests.mjs run packages/core/test/unit/migrate-fk-off.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/project-conversations-migration.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/projects-service.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/lifecycle-project-lead.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/projects-rpc.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/project-chat.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/create-core.test.ts
node scripts/run-tests.mjs run packages/shared
node scripts/run-tests.mjs run --project desktop
```

收口：改了 shared 契约与迁移，**跑一次全量** `pnpm test`，失败集合不超出基线。**desktop e2e 在本 WP 结束时允许是红的**（创建流程用的是临时负责人、右栏仍是旧的）——不要修 e2e，WP8 统一处理；但 desktop `typecheck` 与单测必须绿。

## 5. 验收清单

- [ ] 迁移运行器支持 `-- kepcup:foreign-keys=off`，4 条运行器测试通过；`0039`、`0040` 与迁移测试通过，`create-core` 版本断言为 main 40。
- [ ] `conversations` 的 `CHECK` 生效；旧群转换结果正确；子表数据无丢失。
- [ ] shared：契约与 §4 一致；`project-modules` 表驱动测试通过；`groups.*` 与 D60 契约已删除。
- [ ] core：`ProjectsService` 全部行为与错误码如上；`deleteBot` 对负责人被拒；`deletionPreview` 有 `ledProjects`；D60 四问后端（orchestrator、setup-tools、messages、bindings、测试）已删除。
- [ ] 自检命令输出为空（允许项见下）：

```bash
rg -n "type === 'group'|type !== 'group'|GroupsService|groups\.(create|rename|addMembers|removeMember|setup|redistribute)" packages apps -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**'
rg -n "setupState|setup_state|GROUP_SETUP|group_setup_question|group_created|GroupSetupCard|createGroupViaSetup" packages apps -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**'
```

  允许项：`widgets/query-gate.ts` 的 SQL 关键字 `'group'`；`memory` 里持久化取值 `'group'`（WP4 迁移）；`project-chat.test.ts` 里那条 `it.skip`（WP3 删）；`GroupTurnCoordinator` 相关名字（WP3 改）。

- [ ] desktop `typecheck`、`lint`、desktop 单测绿；全量失败集合不超出基线。
- [ ] 实施记录已填（含所有临时处理的位置清单：`butler.ts` 临时 lead、`chat.svelte.ts` 临时 lead、`it.skip`、设置目录的 `store.methods` 临时改名）。

## 6. 陷阱

- **不要用无指令的迁移重建 `conversations`**：FK 开启下 `DROP TABLE conversations` 会级联删除全部消息等子表数据。
- 0040 的 `CHECK ((type = 'project') = (lead_bot_id IS NOT NULL))` 要求**所有**建项目的路径都带负责人；测试里直接 SQL 插 `type='project'` 不带 lead 会被拒——这是预期。
- **不要改历史迁移**（含 `0014_conversation_setup.sql` 里的 `setup_state`）。
- `memory_items.origin` 的持久化取值 `'group'` 本 WP**不动**（WP4 迁移）；只改 TS 里对会话类型的比较。
- 不要提前做 WP2 / WP3 / WP4 的事：`ChainsService`、`GroupTurnCoordinator`、提示词规则、设置目录 id 改名都留着。
- 临时处理（临时 lead）必须带注释并登记，否则后续 WP 找不到要替换的位置。
- 改 shared 之后记得 `pnpm --filter @kepcup/shared run build`，否则 core / desktop 读到旧产物。

## 7. 实施记录

（执行智能体在此填写：分支、提交列表、临时处理清单、测试结果、偏差编号。）
