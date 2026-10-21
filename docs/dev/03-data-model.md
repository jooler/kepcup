# 03 数据模型

设计依据：[design/11-storage.md](../design/11-storage.md)、[design/04-memory.md](../design/04-memory.md)、[design/01-conversation.md](../design/01-conversation.md)。

## 通用规则

- 引擎：better-sqlite3-multiple-ciphers；每个库使用 ChaCha20-Poly1305 加密，密钥由主密钥经 HKDF 派生（`info` 分别为 `db:main`、`db:runs`、`db:memory:<botId>`）。
- 每个库打开后依次执行：设置加密参数 → `PRAGMA journal_mode=WAL` → `PRAGMA busy_timeout=5000` → `PRAGMA foreign_keys=ON` → `PRAGMA temp_store=MEMORY`。
- 加密参数的具体写法（`PRAGMA cipher` / `PRAGMA key` 的语法）**需验证**，以该库文档为准，封装在 `infra/db.ts` 中。
- 时间字段为 UTC 毫秒整数，列名以 `_at` 结尾。
- JSON 字段为 `TEXT`，列名以 `_json` 结尾，读写时用 zod 校验。
- 布尔字段为 `INTEGER`（0 / 1）。
- 外键只在同一个库内声明；跨库引用（例如 `runs.bot_id`）只存 id，由应用逻辑维护一致性。

### 迁移

- 每个库一个目录：`packages/core/migrations/{main,runs,memory}/NNNN_描述.sql`，编号从 `0001` 开始。
- 用 `PRAGMA user_version` 记录已执行到的编号；启动时按顺序执行未执行的迁移，每个迁移一个事务。
- **已合并的迁移文件不得修改**，只能新增。
- 每个阶段新增的表写在该阶段自己的迁移文件中。下文每张表标注了引入阶段。
- **编号连续**：`infra/migrate.ts` 对缺号报错，新迁移取各目录的下一个号（以目录实况为准）。D75 占用了 main `0018`–`0020`、runs `0006`–`0008`：

| 库 | 迁移 | 内容 |
|---|---|---|
| main | `0018_task_events.sql` | `messages` 重建（`kind` 增 `task_event`，增 `owner_bot_id` / `task_id`，终态条目唯一索引），`attachments` 随之重建 |
| main | `0019_agent_sessions_per_task.sql` | `agent_sessions` 重建：增 `task_id`（`''` = 非任务 run），唯一键改四元组；D72 期旧行清空 |
| main | `0020_usage_turn_loop_type.sql` | `usage_ledger.loop_type` 的 `'response'` → `'turn'` |
| runs | `0006_tasks.sql` | `runs` 增任务列与 `(conversation_id, loop_type, status)` 索引 |
| runs | `0007_turn_loop_type.sql` | `runs.loop_type` 的 `'response'` → `'turn'` |
| runs | `0008_turn_trigger.sql` | `runs` 增 `trigger_parts_json`、`retry_of_run_id` |
| runs | `0009_tool_effects.sql` | D78：新表 `tool_effects`；`runs` 增索引 `runs_by_parent` |
| runs | `0010_tool_effects_approval_idx.sql` | D78：`tool_effects` 增部分索引 `tool_effects_by_approval`（`approval_id IS NOT NULL`） |
| main | `0021_delegation_intent.sql` | D71：`delegations` 重建（status 增 `awaiting_tasks`，增 `intent`、`task_ids_json`，增索引 `delegations_status`） |
| main | `0022_schedule_title_origin.sql` | D80：`schedules` 增 `title`、`origin` |
| main | `0023_watches.sql` | D79：新表 `watches` |
| main | `0024_stickies.sql` | 辅助阅读便签：新表 `stickies` |
| main | `0025_app_connections.sql` | D73 P0：新表 `app_connections`（含部分唯一索引）、`oauth_clients` |
| main | `0026_app_tools.sql` | D73 P1：新表 `app_connection_tools`（工具定义锁定）、`app_tool_grants`（写工具持续授权）；`app_connections` 增 `baseline_pending`（测试用 `mainVersionsAfter()` 取「某版本之后的全部 main 迁移」，新增迁移不必改老测试） |
| main | `0027_egress_approval.sql` | D73 P2：`approvals` 重建（kind 增 `egress`，带全现有 kind）、新表 `app_taint`（污点状态） |
| main | `0028_widgets.sql` | D81：新表 `widgets` / `widget_versions` / `widget_docs`（Bot 自制交互组件） |
| main | `0029_widget_queries.sql` | D81 P2：新表 `widget_queries`（命名只读查询模板）+ `widget_versions.queries_sha256` 列 |
| main | `0036_bot_handover.sql` | D88 P0：新表 `bot_handovers` / `bot_handover_items`；`approvals` 重建（kind 增 `bot_handover`，带全现有 kind）。D87 在另一分支同占 0035，后合入的一方按 main 实况重排 |
| main | `0037_workbench.sql` | D90：新表 `todos` / `todo_runs` / `memos`；`schedules` 重建（`bot_id` 可空、`origin` 增 `workbench`、增 `todo_id` 外键与索引 `schedules_todo`） |
| runs | `0013_task_cwd.sql` | D92 T0（WP0-1）：`runs` 的任务执行根目录列改名 `task_cwd` |
| main | `0038_workdirs_rename.sql` | D92 T0（WP0-2）：目录表改名 `workdirs`，`conversations` / `run_changes` 的目录列改名 `workdir_id` |
| main | `0039_project_prepare.sql` | D92 T1a（WP1）：在 FK 开启下删除无法转换的旧群（含 `messages_fts` 行；子表经 FK 级联） |
| main | `0040_project_conversations.sql` | D92 T1a（WP1）：重建 `conversations`（首行 `-- kepcup:foreign-keys=off` 指令，运行器支持见 `infra/migrate.ts`）——`type` 取值 `direct | project`、增 `lead_bot_id`、`description` 改名 `goal`、删 `setup_state`；旧群纯 SQL 转换（负责人取入群最早的非管家成员，无合格成员的删除）；删除项目会话里的管家成员行 |
| main | `0041_episodes.sql` | D92 T1a（WP2）：删连锁表，建 `episodes`（协作回合） |
| runs | `0014_episode_columns.sql` | D92 T1a（WP2）：`runs` 的连锁列改名 `episode_id` / `episode_hop` |
| main | `0042_todos_assignee_project.sql` | D92 T1a（WP4）：`todos` 的项目执行者列改名 `assignee_project_id` |
| memory | `0003_origin_project.sql` | D92 T1a（WP4）：重建 `memory_items`，`origin` 取值 `('private','project')`，旧值转换 |
| main | `0043_egress_allow.sql` | D73 P2 后续：新表 `egress_allows`（egress 卡对话级放行：「本对话内一直允许」/ bash「本对话内相同命令」） |
| main | `0046_memo_sort_at.sql` | 备忘列表排序键独立：`memos` 增 `sort_at`（0046 增列，回填 `created_at`），索引 `memos_live` 改为按 `sort_at` 排序 —— 改正文不再把卡片顶到最前 |

  D73（连接应用）从 main 的下一个空号起编号（不改 runs 库，以目录实况为准）；迁移运行器支持首行 `-- kepcup:foreign-keys=off` 指令（D92 T1a WP1：重建被大量引用的枢纽表时先关 FK）。

### 全文检索与中文

SQLite FTS5 默认分词器不会切分中文（一整句中文会被当成一个词）。统一做法：

- 写入 FTS 表之前，用 `Intl.Segmenter('zh', { granularity: 'word' })` 把文本切分成以空格分隔的词，存入 FTS 列（分词器使用 `unicode61`）。
- 查询时对查询文本做同样的切分，再组装 FTS 查询。
- 分词逻辑统一放在 `infra/text-segment.ts`，所有 FTS 写入与查询都必须经过它。

## main.db

### settings（P00）

```sql
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

已知键：`providers`（厂商与自定义接口配置，不含 key）、`models.default_main`、`models.default_light`、`provider_concurrency`、`unattended`（无人值守模式状态）、`notifications`、`embedding`、`webSearch`（联网检索供应商，P18：`{provider: 'tavily'|'brave'|'bocha'|null}`；key 不在此处，存 secrets）。

连接应用（D73）在同一设置 JSON 中增加 `apps`（core 自有；`settings.update` 入参只开放 P2 的 `developerMode` / `taintGuard` 两个字段的部分 patch，其余字段 core 独占）：`apps.toolLockBaselineDone`（存量 MCP server 的工具锁定基线已建立，默认 `false`，只作用一次；读取容错）。P2 再加 `apps.developerMode`（开发者模式，默认 `false`；经 `settings.update` 的 `apps` 部分 patch 写）与 `apps.taintGuard`（污点外发控制总开关，默认 `true`；同一入口写，设置「无人值守」分区的开关）。MCP server 条目（`settings.mcpServers[]`）P2 增可选 `source`（`{kind:'mcpb', name, version, sha256}`，MCPB 包安装生成；`name` / `version` 受正则约束，不含路径分隔符）与 `tier`（`'developer'`，MCPB 非目录安装；见 `mcp/policy.ts isDeveloperTier`），MCPB 的 `sensitive` `user_config` 存 `secrets` 表 `mcp:{serverId}:env:{KEY}`，设置里的 env 值只留占位符 `secret:env:KEY`。P3 再加 `apps.directorySync`（签名目录索引同步开关，默认 `true`；同一入口写；关闭 → 远端目录条目立即清空，只用打包快照）。签名目录索引的本地缓存不在数据库里，而在数据目录 `cache/directory/`（`index.json`、`index.json.sig`、`state.json`；`state.json` 记最后接受的索引的 `generatedAt`、字节 sha256、`keyId`、ETag 与最近成功时间，是防回滚棘轮，缓存被清也不会放过更旧的索引；缓存启动时重新验签）。

外部智能体（D72，design/28）在同一设置 JSON 中增加：`agents`（目录 id → `{enabled, installedVersion?, source: 'managed'|'system', loadUserConfig}`，本机启用状态；P1 只用 `enabled`）、`customAgents`（自定义目录条目，预留，本期不读取）、`experimental.externalAgents`（实验开关，默认 `false`；关时 RPC 拒绝把 Bot 设为外部 Agent）、`backgroundAgentId?`（P6：无内置模型时后台 loop 选用的 Agent；缺省 / '' = 自动——只用该 Bot 自己的 Agent，不换用别家；画像整理 / 项目组对话摘要只在明确指定时运行）、`backgroundTasks`（P6：`{agentEnabled=true（false = 后台任务不用 Agent，照旧跳过）, agentSkillAuthoring=false, projectMentionOnly=true（经 Agent 的项目组路由判断需用户关掉此项；D92 T1a WP8 由 groupMentionOnly 改名，无迁移，旧 JSON 缺省值被 `.default(true)` 吸收）}`；`settings.update` 部分 patch 合并）。均在设置 JSON 行内，无迁移。Agent 并发不另设字段，沿用 `providerConcurrency['agent:{id}']`。

MCP 与浏览器资料同在设置 JSON：`mcpServers`（D65，server 列表；每项 `id` 受 `MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` 约束〔D91 后续：字母 / 数字开头，其后字母、数字、`.` `_` `-`，1–64 个字符；写路径〔`settings.update`、`SettingsService.update`〕不合规直接拒绝，读路径 `SettingsService.get()` 逐条校验、丢弃不合规条目并 warn，不让一条坏数据拖垮整份设置，无迁移；它会拼进工具名 `mcp_{id}_{tool}`、能力 id `mcp:{id}`、`custom:{id}` 连接 id 与 secrets 键〕，每项可带逐工具策略 `toolPolicies?: Record<toolName, {approval?: 'auto'|'ask', enabled?}>`），D91 起每项还可带用途说明 `description?: string`（≤200 字符，扩展中心「MCP」表单填写；进系统提示 `<capabilities>` 目录行〔经 `oneLine` 清洗〕，缺省时目录行写固定缺省文案；只进提示词、不参与任何权限判断；无迁移）、`browserProfiles`（D77，共享浏览器资料 `[{id: 'bpf_…', name, createdAt}]`，缺省 `[]`；只经 `browserProfiles.*` RPC 写，`settings.update` 不接受）。Bot 运行配置 `browser_profile`（`''` = 私有；指向不存在的资料按私有处理）。均无迁移。

### secrets（P01）

```sql
CREATE TABLE secrets (
  id          TEXT PRIMARY KEY,           -- sec_...
  name        TEXT NOT NULL UNIQUE,       -- 例如 provider:openai
  ciphertext  BLOB NOT NULL,              -- AES-256-GCM，附加认证数据为 id
  iv          BLOB NOT NULL,
  tag         BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

### bots（P01）

```sql
CREATE TABLE bots (
  id            TEXT PRIMARY KEY,         -- bot_...
  name          TEXT NOT NULL,
  avatar        TEXT,                     -- 数据目录内的相对路径或内置头像标识
  bio           TEXT NOT NULL DEFAULT '',
  profile_json  TEXT NOT NULL,            -- 完整 Profile，结构见 design/03-bot.md
  status        TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
```

- 通讯录即 `status = 'active'` 的 Bot。
- `profile_json.runtime.agent`（D72，无迁移）：`{id, model, effort, permission: 'read_only'|'workspace'|'ask', capabilities: string[]|null}`。`id = ''` = 内置 pi 引擎（默认，其余字段忽略）；非空 = 由智能体目录中该 Agent 驱动，`model` / `effort` 为空表示 Agent 默认，`capabilities = null` 表示跟随能力包默认值。P3 起运行时按 `permission` 生效（Windows 下 `workspace` 降为 `ask`，见 04-agent-runtime「P3 落地要点」）。
- 后续列（增量迁移）：`setup_state TEXT`（0012，对话式新建访谈中 = `'interviewing'`）；`system_role TEXT`（0016，D70）——系统角色，目前只有 `'butler'`（管家），`bots_one_active_butler` partial unique index 保证至多一个 active 管家。**与 Profile 内 `role.{expertise,responsibilities}` 无关。** 管家不可删除（`lifecycle.deleteBot` 在任何级联前拒绝，`BOT_UNDELETABLE`）。
- 删除 Bot 后保留这一行作为 id 占位：清空 `name`、`bio`、`avatar`、`profile_json`（写入 `{}`），`status = 'deleted'`。界面对已删除 Bot 显示其 id。

### conversations（P01）

```sql
CREATE TABLE conversations (
  id               TEXT PRIMARY KEY,      -- conv_...
  type             TEXT NOT NULL CHECK (type IN ('direct', 'project')),
  title            TEXT,                  -- 项目组名称；单聊为空（显示 Bot 名称）
  goal             TEXT,                  -- 项目目标（0040，原 description）；direct 恒 NULL，非空才注入 <conversation_info>
  direct_bot_id    TEXT REFERENCES bots(id),
  lead_bot_id      TEXT REFERENCES bots(id),  -- 项目负责人（0040）；direct 恒 NULL，project 恒非空（CHECK 保证）
  workdir_id       TEXT,                  -- P04 起使用（0038 改名），无 FK
  read_only        INTEGER NOT NULL DEFAULT 0,
  archived_at      INTEGER,               -- 0045：非空 = 已从对话列表移除（归档）；数据全留，通讯录里可恢复
  summary          TEXT,                  -- 滚动摘要
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

- 0040 重建（`conversations` 是 12 张子表的父表，迁移运行器以 `-- kepcup:foreign-keys=off` 首行指令在 FK 关闭下重建，见「迁移」一节）：`description` 改名 `goal`、删 `setup_state`（D60 对话内创建流程已删除，见 [design/19](../design/19-work-path-and-group-setup.md)）；旧群转 `project` 并按入群顺序取最早的非管家成员为负责人，无合格成员的连子表删除；项目会话里的管家成员行删除（D92 K9：管家不是项目参与者）。
- 负责人必须是成员、active、非管家：`CHECK` 管不了成员关系，由 `ProjectsService`（`domain/projects.ts`）在创建（`projects.create`）、更换（`projects.setLead`）、移出（`projects.removeMember`，负责人被拒「请先更换负责人」）时校验；删除领导项目组的 Bot 在 `lifecycle.deleteBot` 任何级联前被拒（`PROJECT_LEAD_REQUIRED`）。
- **归档（0045）**：`archived_at` 非空 = 该会话已从对话列表移除。软删：消息、执行记录、附件、workspace、项目 wiki 目录全部保留；会话仍在通讯录里（`conversations.all` 名册），可随时恢复（`conversations.archive` / `conversations.unarchive`）。对话列表（`conversations.list`）不含归档会话。恢复归档的直聊 = 继续原对话（同 id，历史延续）：`ConversationsService.openDirect` 命中已归档的直聊时先恢复它，不新开对话实例。

删除对话是**物理删除**（连同级联数据）；对话 id 为 ULID，不会复用。项目组没有独立聚合：项目 id = 其根会话 id（`conv_…`），模块数据以它为键。物理删除的入口只有项目详情页「危险区」与管家聊天；其余「从对话列表移除」都是归档（可恢复）。

### conversation_members（P01）

```sql
CREATE TABLE conversation_members (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id           TEXT NOT NULL REFERENCES bots(id),
  joined_at        INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, bot_id)
);
```

单聊也写入一行成员记录，统一成员查询逻辑。

### messages（P01；D75 迁移 0018 重建：增 task_event、owner_bot_id、task_id）

```sql
CREATE TABLE messages (
  id               TEXT PRIMARY KEY,      -- msg_...
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  sender_type      TEXT NOT NULL CHECK (sender_type IN ('user', 'bot', 'system')),
  sender_bot_id    TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('text', 'system_event', 'card', 'task_event')),
  content_json     TEXT NOT NULL,         -- text: { text, origin?, ... }；card: { cardType, approvalId? ... }；system_event: { event, ... }；task_event: { taskId, phase, text, ... }
  reply_to         TEXT,
  mentions_json    TEXT NOT NULL DEFAULT '[]',   -- 被 @ 的 bot id 列表（结构化，不从文本解析）
  batch_id         TEXT,                  -- 同一次发出的一批用户消息共享
  run_id           TEXT,                  -- Bot 消息所属的执行
  status           TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'recalled', 'edited')),
  edited_at        INTEGER,
  created_at       INTEGER NOT NULL,
  owner_bot_id     TEXT,                  -- 0018：NULL = 对话共享；非空 = 仅该 Bot 可见（目前只用于 task_event）
  task_id          TEXT,                  -- 0018：所属任务（run id）：task_event、任务卡、任务问题卡；其余为 NULL
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_conv_seq ON messages(conversation_id, seq);
CREATE INDEX messages_conv_owner_seq ON messages(conversation_id, owner_bot_id, seq);  -- 0018
CREATE INDEX messages_task ON messages(task_id);                                       -- 0018
-- 0018：每个任务至多一条终态条目（design/30 §3.2 幂等写入与启动修复）
CREATE UNIQUE INDEX messages_task_terminal ON messages(task_id)
  WHERE kind = 'task_event' AND json_extract(content_json, '$.phase') IN ('result', 'failure');

CREATE VIRTUAL TABLE messages_fts USING fts5(
  segmented_text, message_id UNINDEXED, conversation_id UNINDEXED, tokenize = 'unicode61'
);
```

- 撤回：`status = 'recalled'`，清空正文，从 `messages_fts` 删除；Bot 不可见。
- 编辑：更新正文与 `edited_at`，`status = 'edited'`，同步更新 `messages_fts`。
- 私有任务条目（D75，[design/30](../design/30-supervisor-and-tasks.md) §2.4）：`kind = 'task_event'`、`sender_type = 'system'`、`owner_bot_id` = 任务所属 Bot，内容 `{ taskId, phase: brief | inject | cancel | question | result | failure, text, sourceMessageIds?, status?, error?, delivery?, questionMessageId?, title?, writes?, continuesTaskId?, capabilities?, deliveries? }`（`capabilities`〔D91〕：brief 条目带的任务声明能力 id，任务卡 / `<tasks>` 段可见；`deliveries`：终态条目被投递给对话轮的次数，宿主用 `json_set` 计数，达到 `TASK_REDELIVER_MAX_ATTEMPTS` 放弃，审查批 E）。写入走 `MessagesService.appendTaskEvent`：终态 phase（`result` / `failure`）撞唯一索引不报错，返回已存条目（`created: false`）。正文照常写 `messages_fts`（FTS 表结构不变，按视角过滤在查询时 join `messages.owner_bot_id`）。用户可见读路径（`isVisibleToUser` / `listVisible`）排除 `task_event` 与 `owner_bot_id` 非空的行。
- 任务发出的可见中间说明：`text` 消息，`content_json` 带 `origin: 'task'` + `taskId`（照 D71 `origin: 'delegation'` 的先例，免加列）；`forward_task_result` 原文转发的结果是同形的 Bot 消息（`run_id` = 发起转发的对话轮，用以判定「已转发过」）。
- 组件回传（D87 P4 L3）：用户在组件卡上确认后经 `widgets.ui.reply` 发出的用户消息，`text` 消息的 `content_json` 带 `origin: 'widget'` + `widgetId` + `widgetVersion`（同样免加列）；上下文发送者渲染为「用户（经组件 … 发出）」，正文包 `<untrusted source="widget">`；记忆与反思把它当「非用户本人的话」（同委派代发）。
- 工作台派发（D90）：到点或「立即开始」时宿主在目标对话里追加的用户消息，`text` 消息的 `content_json` 带 `origin: 'workbench'` + `todoId` + `todoRunId`（免加列）；界面渲染为派发卡；操作者是管家时另加「（管家代你安排）」（`viaButler`），`source='butler'`（内容由管家起草或改写过）的事项另带 `butlerDrafted`，两者都让记忆与反思不把它当用户原话、执行者上下文按不可信包裹（同委派代发）。
- 任务卡（D75 W3）：共享的 `card` 行，`content_json = { cardType: 'task', runId: <任务 id> }`，`task_id` = 任务；`start_task` 与失败任务的重试各写一张。上下文中渲染为一行状态（[design/30](../design/30-supervisor-and-tasks.md) §4.3）。
- MCP Apps 卡（D73 P3，`cardType: 'mcp_app'`）：共享的 `card` 行，`content_json = { cardType: 'mcp_app', appUi: {…} }`，`appUi` 是描述符（server id、`ui://` URI、工具名、脱敏并截断后的入参 / 结果，入参 ≤ 16 KiB、结果 ≤ 64 KiB 字符，超出丢弃并标记 truncated），**不含 HTML 与令牌**；页面 HTML 只在 core 内存里的一次性资源（128 位随机 id，≤ 64 条、30 分钟滑动 TTL），不落库。上下文中渲染为一行固定文案。
- 展示卡（D87 P4 L1，`cardType: 'present'`）：`sender_type = 'system'` 的 `card` 行（`run_id` = 发出它的对话轮或任务），`content_json = { cardType: 'present', present: { kind, title, data, botId? } }`，`data` 是 Bot 给的 JSON（按 kind 的 schema 校验，≤64KB），`botId` 是发卡的 Bot；上下文按 kind 回放成紧凑文字（≤1200 字），标明发卡的 Bot、数据包 `<untrusted>`。
- 任务问题卡（`ask_user`）：共享的 `system_event` 行，`event = 'task_question'`，`content_json` 带 `text`（问题）、`options`、`taskBotId`（提问任务所属的 Bot；上下文渲染为「Bot（任务 t）向用户提问」并包 `<untrusted>`），回答后写入 `answer`（超时为「（超时未回答）」，提问失败作废为「（提问没有成功，问题作废）」）；`task_id` 与 `run_id` = 任务。
- 问题卡的多选 / 表单（D87 P4 L2）：同一行的 `content_json` 另带 `questionMode`（`single` / `multi` / `form`，缺省视为 `single`，存量卡不变）与 `questionFields`（表单字段 `{name, label, type, options?, required}`，≤8 个）；回答后 `answer` 是卡上显示的可读一行（≤500 字），交给任务的结构化 JSON 只进任务的私有条目。
- 结果放弃提示：共享的 `system_event` 行，`event = 'task_result_undelivered'`，`task_id` / `run_id` = 任务；用户可见，Bot 上下文渲染为固定文案（不含任务标题）。
- 设置卡（D89，无迁移）：共享的 `system_event` 行，`event = 'setting_card'`，`sender_type = 'system'`，`run_id` = 出卡的 run；`content_json = { event, text, setting }`，`setting` 为 `SettingCardContent`：`botId`、`runId`、`itemId`（设置目录条目 id）、`mode`（`direct` / `confirm` / `form` / `user-only` / `link`）、`target{botId?, conversationId?, workdirId}`、`proposed`（user-only / link 恒 null）、`before`（出卡时的当前值，也是 `settings.items.apply` 的 `expected`）、`beforeText` / `proposedText`、`reason`、`modeReason?`、`state`（`pending` / `applied` / `dismissed` / `superseded` / `expired` / `reverted`）、`applied?`（direct 回执卡 = 新值，撤销用）、`undoUntil?`（回执 24 小时撤销窗口）、`decidedAt?`。状态写回同 `schedule_offer`：core 用 `json_set` 改 `$.setting` 与 `$.text` 并发 `message.updated`；防刷屏（每 run ≤3 张、拒绝退避）直接对 `run_id` / `$.setting.botId` / `$.setting.itemId` / `$.setting.state` 做 json_extract 查询，不另建表。上下文渲染为一行系统消息，值与理由包 `<untrusted>`。
- 设置卡落定通知（D89）：共享的 `system_event` 行，`event = 'setting_card_resolved'`，`internal = true`（用户界面不显示），`content_json` 带 `text`（给 Bot 的人话）与 `settingResolved{cardMessageId, itemId, outcome: 'applied' | 'dismissed', before, after}`；用户应用 / 不用了时写一次，唤醒出卡 Bot 的对话轮；superseded / expired / reverted 与撤销不写。
- `MessagesService` 的读法（D75 W1-B）：`listForBot(conversationId, botId)`（共享行 + 该 Bot 的私有行，Bot 上下文）、`listShared`（只共享行：任务的对话层、摘要）、`search(…, viewerBotId)`（FTS join `messages` 按 owner 过滤）、`around`（前后各 N 条可见行）、`unsummarized`（只摘共享行）、`countVisibleAfter`（未读只数用户可见行）；`terminalTaskEvent(taskId)` / `taskEvents(taskId)` 只查 `kind = 'task_event'`。私有行推进对话的 `last_seq`，不推进 `last_message_at`。
- 0018 重建方式：`messages` 被 `attachments.message_id`（`ON DELETE CASCADE`）引用，迁移又在 `foreign_keys=ON` 的事务内执行，直接 `DROP TABLE messages` 会级联删光附件；因此 `attachments` 一并重建（先建两张新表并复制，先删旧 `attachments` 再删旧 `messages`，再改名——外键开启时改名会同步改写引用）。表结构与本节 / 下节一致。

### attachments（P01；D75 迁移 0018 随 messages 重建，结构不变）

```sql
CREATE TABLE attachments (
  id               TEXT PRIMARY KEY,      -- att_...
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       TEXT REFERENCES messages(id) ON DELETE CASCADE,
  file_name        TEXT NOT NULL,
  mime             TEXT NOT NULL,
  size             INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  rel_path         TEXT NOT NULL,         -- 相对 conversations/{id}/attachments/
  created_at       INTEGER NOT NULL
);
```

D86（直发）语义：`draft_id` 列已删除（main 0030，待发送队列下线）；附件以 `messages.send` 的 `attachmentIds` 同事务转正（校验归属对话且无主）；`attachments.detach` 仅允许移除未随消息发出的上传（行与文件一起删）。未绑定消息的附件（message_id 为空）创建超过 7 天仍未发出视为遗弃：main 0033 一次性清理存量行，core 启动时 `AttachmentsService.sweepOrphans()` 回收过期行与无任何行引用（且 mtime 超过 24h 宽限）的附件文件。

### jobs（P01）

持久化的后台任务队列。

```sql
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,            -- conversation_summary | reflection | memory_consolidation | profile_curation
                                          -- | wiki_ingest | wiki_lint | wiki_remove_source | skill_authoring | schedule_fire | watch_alert
                                          -- | mail_alert | handover_copy（D88 P2）...
  bot_id        TEXT,
  conversation_id TEXT,
  payload_json  TEXT NOT NULL,
  priority      INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  run_after     INTEGER NOT NULL,
  dedupe_key    TEXT,                     -- 同一 key 只保留一个 pending 任务
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_error    TEXT
);
CREATE INDEX jobs_pending ON jobs(status, run_after, priority);
CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE status = 'pending';
```

- `wiki_ingest`（D92 T1b WP9 起 payload 带 `owner: { kind: 'bot', botId } | { kind: 'project', projectId }`）：项目 wiki 的入库 job `conversation_id` = 项目 id、`bot_id` = **执行者**（成员入库记该成员名下，用户添加的与体检以负责人身份）；去重键 `wiki_ingest:{ownerKey}:{sourceType}:{ref…}`（`wikiOwnerKey` 形态）。
- `wiki_remove_source`（D92 T1b WP10，无迁移：`type` 没有 CHECK）：删除项目 wiki 来源的异步 job——不调用任何模型（不占模型路由、`JOB_PURPOSES` 不登记，不受预算延后），`payload = { owner, sourceId, actor: { role: 'user'|'lead'|'member', botId? } }`，`bot_id` = 项目负责人（仅记账），去重键 `wiki_remove_source:{ownerKey}:{sourceId}`；ACL / NOT_FOUND / NOT_SUPPORTED 终结为 `done` 不重试（入队时已快败一次，执行时再校验）。
- `handover_copy`（D88 P2，无迁移：`type` 没有 CHECK）：一次 Bot 资产移交的后台阶段（Wiki 页、Bot 级组件复制），`dedupe_key = handover_copy:{handoverId}`，`payload = {handoverId}`，`bot_id` / `conversation_id` 为 NULL（不受每日后台预算推迟，也不随某个 Bot / 对话被取消——作业自己按 Bot 是否还在跳过）。宿主保证同一移交最多一个 pending / running 作业；后台阶段暂时失败时作业抛 `JobRetryLaterError`，jobs runner 照常记一次失败并把 `run_after` 推后（30 秒 × 已用次数，`JobsService.postpone`），末次失败时条目记失败并结算；作业多次中断而 `failed` 时不再重登，其条目记失败。

启动时把 `running` 改回 `pending`（`attempts + 1`）；超过 3 次标记为 `failed`。

### usage_ledger（P01）

```sql
CREATE TABLE usage_ledger (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  bot_id          TEXT,
  conversation_id TEXT,
  loop_type       TEXT NOT NULL,         -- 与 runs.loop_type 同值（turn / task / subagent / triage / …；main 0020 已把旧的 response 改为 turn）；另有两个只出现在账本里的值：memory（记忆向量化 / 重排）、voice_input（语音输入转写，不计入后台预算）
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX usage_by_bot_day ON usage_ledger(bot_id, created_at);
```

媒体调用（`MediaService`：embed / rerank / 图片理解 / 语音转写与合成 / 图片与视频生成）成功后各记一行：一次调用一行，`provider` = 厂商 id，`model` = 实际模型 id，token 为 0（适配器暂不上报）、`cost_usd` 为 NULL；次数按行统计，`usage.summary` 的 `calls` 即行数。无所属 run 的调用（记忆、语音输入）`run_id` 取 `media_` 前缀的合成 id。连通性测试（`testCapability`）不记账。

### audit_log（P02）

```sql
CREATE TABLE audit_log (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  bot_id          TEXT,
  conversation_id TEXT,
  action          TEXT NOT NULL,          -- exec | exec_unsandboxed | fs_write | grant_used | approval_auto ...
  detail_json     TEXT NOT NULL,          -- 已脱敏
  created_at      INTEGER NOT NULL
);
```

### approvals（P03；P08 审查修复 BR-P08-004 增补终态 failed；D72 迁移 0017 增 agent_tool；D73 迁移 0027 增 egress；D84 迁移 0031 增 mail_send；D88 迁移 0036 增 bot_handover）

```sql
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,       -- apr_...
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'skill_preset',
                    'profile_change', 'mcp_tool', 'butler_proposal',
                    'agent_tool', 'egress', 'mail_send', 'bot_handover')),
  bot_id          TEXT,
  conversation_id TEXT,
  run_id          TEXT,
  payload_json    TEXT NOT NULL,          -- 各类请求的内容（路径、命令、原因……）
  status          TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'failed')),
  decision_json   TEXT,                   -- 例如 { duration: 'once' | 'conversation' } / { error: '…' }
  auto_approved   INTEGER NOT NULL DEFAULT 0,  -- 无人值守模式自动批准
  message_id      TEXT,                   -- 卡片消息（中途权限卡的内存态通知不写 messages 表，此列为空）
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);
CREATE INDEX approvals_pending ON approvals(status, conversation_id);
```

`skill_preset`（P19/D63）：payload `{presetId, name, displayName, summary, version, missingDeps}`——`install_skill` 的预置轻授权卡；`skill_import` 既有 payload（P08）不变，工具路径复用同一 kind（阻塞审批）。无人值守模式下两者同属自动批准类。

`butler_proposal`（D70，迁移 0016 重建表加入 CHECK）：payload 以 `proposalType: 'bots' | 'bot' | 'project'` 区分（见 `butlerProposalPayloadSchema`；D92 T1a WP4 起取值改名，`project` 分支字段 `{ title, goal, leadBotId, memberBotIds, reason }`——`propose_project` 的载荷带负责人）；非阻塞提交、管家 run 结束不取消、**无人值守不自动批准**；`decision_json` 可带 `selection`（用户保留的条目下标）与 `leadBotId`（审批卡上改过的负责人，改过才写）。

`agent_tool`（D72 P3，迁移 `0017_external_agents.sql` 重建表加入 CHECK）：外部智能体原生工具的权限请求（ACP `session/request_permission` 经权限桥分级后需要用户确认的部分）。payload 见 `agentToolApprovalPayloadSchema`：`{agentId, agentName, title, kind: 'read'|'write'|'execute'|'other'|'config', toolKind, access?, locations[]（已解析绝对路径）, command?, cwd, options[]（Agent 提供的选项，仅展示 / 审计）, durations, reason, sensitive, exemptDirs, workdirPath?, configHash}`。路径类（read / write）`durations` 含 `conversation`，批准后按 `decision_json.duration` 记 grants（与 access 同语义）；命令 / 其他只有「仅这一次」（`approvals.decide` 把越权的 conversation 降为 once）。子类型 `kind: 'config'`：workdir 内 Agent 侧配置文件（Provider 的 `agentSideConfigFiles`）首次运行前的确认，批准后按（对话、Bot、Agent、workdir 路径、配置内容哈希 `configHash`）记住，无人值守的自动批准不算（`approvedAgentConfigs` 以 `json_extract(payload_json,'$.kind')='config'` 定向查询）。无人值守：自动批准并审计，但并入数据目录底线——`command` 文本或 `locations` 触及数据目录（`exemptDirs`＝本 run 的 workspace 与技能目录除外）则自动拒绝（`agentToolTouchesDataDir`：相对 token 按 `cwd` 解析，cwd 本身也检查）；`kind:'other'` 与无 locations 的 write 一律自动拒绝（`agentToolUnattendedRefusal`）。

`egress`（D73 P2，迁移 `0027_egress_approval.sql` 重建表加入 CHECK）：污点期间（见 `app_taint`）外发通道的逐次确认，payload `{channel: 'web_fetch'|'web_search'|'browser'|'app_tool'|'mcp_tool'|'bash'|'git_remote'|'watch', target, summary, taintedSince?, durations?}`——`target` 是外发内容全文（URL / 查询词 / 命令 / 工具名 + 参数 JSON，脱敏后最多 `EGRESS_TARGET_MAX_CHARS`），卡片完整展示；时长缺省只有 `once`，payload 可带 `durations`（网关写入）：`['once','conversation']` 或 bash 通道的 `['once','command','conversation']`（D73 P2 后续，见 `egress_allows`）。选 `conversation` = 本对话的污点窗口内所有外发不再确认；选 `command` = 本对话内**完全相同**的 bash 命令不再确认；`decide()` 仍把未提供的时长（含 `bot`）降为 once。放行的有效期不超过批准时刻的污点窗口：污点被新的读取续期（`mark`）即清空该对话的放行并重新出卡。网关 `egressCheck` 发起：应用 / 自定义 MCP 非只读且 `openWorldHint !== false` 的工具（持续授权与 `auto` 策略在污点期间不起作用：本会免卡的调用改弹 `egress` 卡；本来就要弹 `mcp_tool` 卡的调用不叠第二张——该卡 payload 带 `tainted: true` / `taintedSince` 并展示完整参数 `argsFull`）、`web_fetch` / `web_search`、浏览器 `browser_open` 与点击按钮 / 链接 / 按 Enter、沙箱 `bash`（Bot `network_policy === 'open'`）、`watch_create`（网页监看，创建时与之后每个间隔都会用 Bot 的浏览器资料访问该 URL）；ACP 权限桥对 fetch 类与 agent 沙箱内自动放行的命令也发该卡。`git_remote`、确认模式的 `command` 卡与上述 `mcp_tool` 卡不新增 kind，payload 带 `tainted: true`（`git_remote` / `mcp_tool` 另带 `taintedSince`），卡片附加提示（这几类不受对话级放行影响，仍按各自的卡语义）。对话轮 / 子代理不等待审批（D75）：非无人值守时直接失败并引导 `start_task`（已有对话级放行时直接放行，不受此限）。无人值守按 D41 自动批准，另写审计 `egress_tainted`（`{approvalId, kind, channel, target(≤1000), approved, via}`），Bot 详情经 RPC `apps.egressSummary` 汇总（被对话级放行免卡的调用不再产生该审批与审计）。

`bot_handover`（D88，迁移 `0036_bot_handover.sql` 重建表加入 CHECK）：Bot 资产移交卡，payload 见 `botHandoverPayloadSchema`：`{handoverId, fromBotId, fromBotName, target: {kind:'existing', botId, botName} | {kind:'new', bot: {…propose_bot 字段, model, modelLabel}}, items[{key, assetType, action, label, detail, warnings[], blocked?, marks[]（P1：`external_import` / `sensitive`）, defaultSelected（P1：敏感记忆为 false）}], responsibilities?{to?, from?, toBefore, fromBefore}, handoverNote, note}`——展示字段在提交时由 core 快照（渲染端不再查询）。非阻塞提交、发起 run 结束不取消、**无人值守不自动批准**；`decision_json` 可带 `handoverSelection`（用户保留的条目 key，含职责改写的保留 key `resp:to` / `resp:from`，只能是卡上可勾选的；一项不留且不新建 = 拒绝；不带时按卡上的默认勾选 `defaultHandoverKeys`，敏感记忆不在其中）。执行结果部分未完成 / 失败时卡片落 `failed`（`{error}` 列出原因），执行进度在 `bot_handovers` / `bot_handover_items`。

> 新增 kind 必须重建 approvals 表（SQLite 不能改 CHECK），且要把**现有全部 kind** 带上（0010 → 0015 曾漏过 `skill_preset`）。

> `failed`：批准后的落位动作失败时的终态（当前仅 skill_import：Bot 已删/同名冲突/库目录异常），decision_json 记 `{ error: 原因 }`——卡片不得停留在 approved 造成「已成功」假象（迁移 `0010_p08_approval_failed.sql`）。

### grants（P03）

```sql
CREATE TABLE grants (
  id              TEXT PRIMARY KEY,       -- grt_...
  bot_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,          -- realpath
  access          TEXT NOT NULL CHECK (access IN ('read', 'write')),
  duration        TEXT NOT NULL CHECK (duration IN ('once', 'conversation')),
  run_id          TEXT,                   -- duration = once 时绑定的执行
  approval_id     TEXT,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);
CREATE INDEX grants_active ON grants(conversation_id, bot_id) WHERE revoked_at IS NULL;
```

### command_allowlist（P03）

```sql
CREATE TABLE command_allowlist (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL CHECK (platform IN ('posix', 'windows')),
  pattern     TEXT NOT NULL,              -- 命令前缀，例如 "git status"
  builtin     INTEGER NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
```

### workdirs（P04）

```sql
CREATE TABLE workdirs (
  id                  TEXT PRIMARY KEY,   -- wkd_...（0038 起；`prj_` 前缀随之停用）
  path                TEXT NOT NULL UNIQUE,  -- realpath
  name                TEXT NOT NULL,
  protect_rules_json  TEXT NOT NULL,      -- { denyRead: string[], denyWrite: string[] }（glob）
  allowed_ports_json  TEXT,               -- null 表示不限
  status              TEXT NOT NULL CHECK (status IN ('available', 'missing')),
  created_at          INTEGER NOT NULL,
  last_used_at        INTEGER NOT NULL
);
```

### run_changes（P04）

```sql
CREATE TABLE run_changes (
  run_id          TEXT PRIMARY KEY,
  workdir_id      TEXT NOT NULL REFERENCES workdirs(id) ON DELETE CASCADE,
  conversation_id TEXT,
  before_oid      TEXT NOT NULL,          -- 影子仓库中的提交
  after_oid       TEXT,
  files_json      TEXT,                   -- [{ path, change: 'added'|'modified'|'deleted', beforeOid?, afterOid?, interleaved? }]
  reverted_at     INTEGER,
  created_at      INTEGER NOT NULL
);
```

- 一个 run 多次持有租约（D75 审查批 E：被强制收回后不钉住的执行再次写入）时记录**累积**：`before_oid` 是第一个窗口前、`after_oid` 是最后一个窗口后；跨窗口的文件带各自的 `beforeOid`（run 第一次改它之前）/ `afterOid`（run 最后一次改它之后），净改动按两端内容重算；别人在 run 的两个窗口之间改过的文件标 `interleaved`，回退时按冲突处理。回退按文件恢复 `beforeOid ?? before_oid`、冲突检测比对 `afterOid ?? after_oid`；diff 按文件取各自区间。重新记录已回退的 run 时清空 `reverted_at`。

### episodes（协作回合，D92 T1a，main 0041）

Bot 间 `@` 触发的因果树（设计见 [design/41 §7](../design/41-project-team.md#7-协作回合与熔断)）；服务在 `dispatch/episodes.ts`（`EpisodesService`）。

```sql
CREATE TABLE episodes (
  id              TEXT PRIMARY KEY,       -- epi_...
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_batch_id   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
  hops            INTEGER NOT NULL DEFAULT 0,   -- Bot 发起的触发总数（熔断阈值 EPISODE_HOP_BREAKER = 12）
  pair_hops_json  TEXT NOT NULL DEFAULT '{}',   -- { "botA|botB": n }，键为字典序排序后的无序对（EPISODE_PINGPONG_BREAKER = 8）
  pending_json    TEXT NOT NULL DEFAULT '[]',   -- 熔断时未投递的触发：[{ toBotId, fromBotId, messageId, hop }]，resume 补投、stop 丢弃
  paused_at       INTEGER,                      -- 熔断时间；NULL = 正常
  created_at      INTEGER NOT NULL
);
CREATE INDEX episodes_by_conversation ON episodes(conversation_id, created_at);
```

- 懒创建：新的用户消息在该轮**首次 Bot 发起 `@`** 时才建行（发起 run 记为根、hop 0）；没有 `@` 就没有回合行。任务结算唤醒的对话轮在**唤醒时**按任务起源轮（`origin_run_id`）解析并继承回合（起源轮没有回合则不绑定）；任务与子代理 run 自身不绑定回合。
- `resume` 投递 `pending_json` 并清零计数（补投沿用记录的 hop）；`stop` 丢弃 pending 并向相关 Bot 发 internal 系统消息 `episode_stopped`。熔断时对话里出协作暂停卡（`episode_paused`，带 `episodeId`），无人值守不自动继续；应用重启后 pending 随回合行保留。RPC `episodes.get / resume / stop`，事件 `episode.updated`。

### env_installs（P06）

```sql
CREATE TABLE env_installs (
  id           TEXT PRIMARY KEY,
  item         TEXT NOT NULL,             -- 例如 python、node、git、uv、embedding-model
  version      TEXT NOT NULL,
  rel_path     TEXT NOT NULL,             -- 相对 toolchains/
  size_bytes   INTEGER,
  status       TEXT NOT NULL CHECK (status IN ('installing', 'installed', 'failed', 'removed')),
  requested_by TEXT,                      -- bot id
  approval_id  TEXT,
  installed_at INTEGER,
  last_used_at INTEGER
);
```

### profile_items、profile_card（P07）

```sql
CREATE TABLE profile_items (
  id             TEXT PRIMARY KEY,        -- prf_...
  category       TEXT NOT NULL CHECK (category IN (
                   'basic', 'communication', 'work', 'interests', 'boundaries', 'recent')),
  content        TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('explicit', 'inferred')),
  evidence_json  TEXT NOT NULL,           -- [{ messageId, conversationId }]
  contributed_by TEXT,                    -- bot id
  confidence     REAL NOT NULL,
  valid_until    INTEGER,
  status         TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retracted')),
  supersedes     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE VIRTUAL TABLE profile_fts USING fts5(segmented_text, item_id UNINDEXED, tokenize = 'unicode61');

CREATE TABLE profile_card (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  content      TEXT NOT NULL,
  compiled_at  INTEGER NOT NULL
);
```

画像条目只有 `normal` 敏感度的内容；敏感信息不进入共享画像（design/04-memory.md）。

### profile_proposals（P07）

```sql
CREATE TABLE profile_proposals (
  id            TEXT PRIMARY KEY,
  bot_id        TEXT,                     -- 提出的 Bot
  op            TEXT NOT NULL CHECK (op IN ('add', 'retract')),
  target_item_id TEXT,                    -- op = retract 时
  payload_json  TEXT NOT NULL,            -- 反思输出中的 profileProposals 单项
  status        TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
  result_json   TEXT,                     -- 整理结果（对应的操作与原因）
  created_at    INTEGER NOT NULL,
  processed_at  INTEGER
);
CREATE INDEX profile_proposals_pending ON profile_proposals(status, created_at);
```

### skill_library、bot_skills（P08）

```sql
CREATE TABLE skill_library (
  id           TEXT PRIMARY KEY,          -- skl_...
  name         TEXT NOT NULL,
  source_url   TEXT NOT NULL,
  commit_oid   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  rel_path     TEXT NOT NULL,             -- skills-library/{name}@{hash}
  scan_json    TEXT NOT NULL,             -- 兼容性、权限声明、依赖、风险
  imported_at  INTEGER NOT NULL,
  UNIQUE (name, content_hash)
);

CREATE TABLE bot_skills (
  bot_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('builtin', 'imported', 'authored')),
  library_id   TEXT REFERENCES skill_library(id),   -- imported 时
  status       TEXT NOT NULL CHECK (status IN ('draft', 'active', 'disabled', 'incompatible')),
  status_reason TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (bot_id, name)
);

-- 公共技能（P08 增量）：技能市场安装为公共技能，一次安装所有 Bot 发现并
-- 调用；引用计数与 bot_skills 共同决定库版本的回收。
CREATE TABLE public_skills (
  name          TEXT PRIMARY KEY,
  library_id    TEXT NOT NULL REFERENCES skill_library(id),
  status        TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'incompatible')),
  status_reason TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

同名遮蔽规则：某 Bot 拥有私有同名技能（bot_skills 有行，任意状态）时，公共版本对该 Bot 隐藏（列表、提示词、可读目录均不见）；其他 Bot 不受影响。

D88 移交复制技能（P1，`SkillsService.copyForHandover`，无迁移）：导入的给接手方加一行 `bot_skills`，指向同一 `library_id`（引用计数照常，不重新克隆、不走 `skill_import` 审批）；自写的把目录复制进接手方的 `bots/{id}/skills/{name}/` 并在其仓库提交「从 {A} 复制 {name}」，再加 authored 行。两种都照搬 `status` / `status_reason`（停用的复制后仍停用）；接手方已有同名私有行时不复制。

### schedules（P10；D90 迁移 0037 重建）

```sql
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,       -- sch_...
  bot_id          TEXT,                   -- D90（main 0037）起可空（口径保留）；派给项目组的事项排期时若能解析到负责人则记该 Bot，派发时再取生效负责人（执行者覆盖项优先，缺省项目负责人）
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('once', 'cron')),
  run_at          INTEGER,                -- once
  cron            TEXT,                   -- cron 表达式
  timezone        TEXT NOT NULL,
  note            TEXT NOT NULL,
  commitment_id   TEXT,                   -- 对应 memory.db 中的承诺条目
  status          TEXT NOT NULL CHECK (status IN ('active', 'done', 'cancelled')),
  next_fire_at    INTEGER,
  last_fired_at   INTEGER,
  created_at      INTEGER NOT NULL,
  -- D80（main 0022）：
  title           TEXT NOT NULL DEFAULT '',     -- 给用户看的短名；空 = 展示回退到 note 截断
  origin          TEXT NOT NULL DEFAULT 'tool'
                  CHECK (origin IN ('tool', 'offer', 'proposal', 'commitment', 'workbench')),
  -- D90（main 0037）：
  todo_id         TEXT REFERENCES todos(id) ON DELETE SET NULL,  -- origin = 'workbench' 时指向事项
  CHECK (bot_id IS NOT NULL OR origin = 'workbench'),
  CHECK (todo_id IS NULL OR origin = 'workbench')   -- 单向：事项硬删会把 todo_id 置空
);
CREATE INDEX schedules_next ON schedules(status, next_fire_at);
CREATE INDEX schedules_todo ON schedules(todo_id);
```

0037 按 0021 的写法重建本表（建新表 → 拷数据 → 删旧 → 改名 → 重建索引；SQLite 改不了 CHECK、放宽不了 NOT NULL），旧行原样保留；没有其他表以外键指向 `schedules`。`origin = 'workbench'` 的行到点不走主动消息护栏，由 TodoService 派发（见 [design 39](../design/39-workbench.md) §3.3）；时间只存在 schedule 上，事项表不重复存。凡按 `bot_id` 查的路径对空值天然不命中（`bot_id = ?` 比较），需要 Bot 的逻辑要显式判空。

D80 的回执卡（`schedule_created`）与提议卡（`schedule_offer`）是 messages 里的 system_event，内容 JSON 带 `schedule` 快照 / `offer`（`status`：pending / accepted / declined / superseded / expired），不另建表；拒绝退避按 `offer.decidedAt` 在 7 天窗口内计数。D88 移交定时任务时（`ScheduleService.transferTo`，一个事务）：在 B 的对话里按原字段重建一行并出新回执卡，原行 `cancelled`，原回执卡快照写入 `schedule.handedOverTo = {botId, name}`、文案改为「已移交给 {B}」。交接记录也是 system_event：`bot_handover`（B 私聊）/ `bot_handed_over`（A 私聊），内容带 `handover: {handoverId, fromBotId, fromBotName, toBotId, toBotName, items[]（移交与职责改写）, kept[]（共享 / 复制，移交方仍保留）, note}`。移交时已排队的 `schedule_fire:{旧 id}:*` 作业在同一事务里改投新任务，接手方的新回执卡也在该事务里写入。

### watches（D79，main 0023）

确定性监看：宿主按 `next_check_at` 用 Bot 的后台页检查网页，条件边沿触发才唤醒 Bot（[design/02 §网页监看](../design/02-execution.md#网页监看d79)）。

```sql
CREATE TABLE watches (
  id              TEXT PRIMARY KEY,       -- wat_...
  bot_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_json     TEXT NOT NULL,          -- {kind:'web_page', url, selector?}（zod 只接受 web_page）
  condition_json  TEXT NOT NULL,          -- {kind:'changed'} | {kind:'contains'|'not_contains', text}
                                          -- | {kind:'number_below'|'number_above', selector?, value}
  interval_sec    INTEGER NOT NULL CHECK (interval_sec >= 300),
  status          TEXT NOT NULL CHECK (status IN ('active', 'paused', 'stopped')),
  last_hash       TEXT,                   -- 上次成功检查的页面行 sha256
  last_quiet_hash TEXT,                   -- 同上，去掉相对时间后（changed 比较它）
  last_text       TEXT,                   -- 上一版页面行（≤ WATCH_STORED_TEXT_MAX_CHARS），下次的增删改摘要用
  last_matched    INTEGER NOT NULL DEFAULT 0,   -- 上次条件值（边沿触发）
  alert_seq       INTEGER NOT NULL DEFAULT 0,   -- 已提醒次数（幂等键的一部分）
  alert_times_json TEXT NOT NULL DEFAULT '[]',  -- 最近 24 小时的提醒时间（ms JSON 数组；提醒上限，恢复时清空）
  failures        INTEGER NOT NULL DEFAULT 0,   -- 连续失败次数（成功清零，≥5 暂停）
  last_error      TEXT,
  last_checked_at INTEGER,
  next_check_at   INTEGER NOT NULL,
  version         INTEGER NOT NULL DEFAULT 0,   -- CAS：每次写 +1
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX watches_due ON watches(status, next_check_at);
CREATE INDEX watches_conversation ON watches(conversation_id);
CREATE INDEX watches_bot ON watches(bot_id, status);
```

- `alert_times_json` 支撑 `WATCH_MAX_ALERTS_PER_DAY` 滚动 24 小时提醒上限：超出的边沿不唤醒，同一事务改 `paused` + 暂停卡。
- 读行时 `source_json` / `condition_json` 用 zod `safeParse`：解析不了的行在列表 / 上下文里跳过并记日志；到期查询遇到它时直接改 `paused`（`last_error` 说明记录损坏），避免永远到期、空转 worker；删除级联按 SQL 一并删除。
- 边沿提醒与 `alert_seq + 1` 在同一事务里登记 `watch_alert` 作业（`jobs.dedupe_key = watch:{id}:{seq}:{hash}`）；提醒卡与暂停卡是 messages 里的 card（`cardType: 'watch'`，内容带 `watchId` / `watchEvent`（created / alert / paused）/ `watchSeq` / `watchKey` / `watchSummary`，暂停卡另带 `watchPauseReason`（`failures` / `too_frequent`）与 `watchFailures`（暂停时的连续失败次数）），不另建表；唤醒 Bot 的是内部 system_event `watch_alert`（文本以「监看提醒（{id}，第 {seq} 次）」开头，作业重跑据此判断唤醒是否已记录）。
- D88 移交（P1，`WatchService.transferTo`，无迁移）：同一行就地改 `bot_id` / `conversation_id`（`version + 1`，CAS），`last_text` / `last_matched` / `alert_seq` 原样保留，接手方不会把已提醒过的状态再提醒一次；`last_hash` / `last_quiet_hash` 在两边浏览器资料相同时保留，不同时清空（接手方第一次检查只建基线，不因换了资料误报「页面变化」）；私聊里的改到接手方私聊（同一事务在那里补一张 `created` 卡），项目组里的留在原项目组；排队中的 `watch_alert` 作业（`dedupe_key like 'watch:{id}:%'`）同一事务改到接手方名下。原对话里的旧卡因 `conversation_id` 不同而显示「已移交给 {B}」。
- `stopped` 行保留（不出现在列表里）；删除对话 / Bot、移出项目组时删除。

### stickies（辅助阅读便签，main 0024）

渲染层在消息里选中文本钉出的可拖拽便签（类 mac stickies，浮在对话容器上层）：`conversation` 作用域只在来源对话显示，`global` 作用域在所有对话显示且共享位置与层号。

```sql
CREATE TABLE stickies (
  id              TEXT PRIMARY KEY,       -- stc_...
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL CHECK (scope IN ('conversation', 'global')),
  text            TEXT NOT NULL,          -- 钉住的选中文本（≤ STICKIE_TEXT_MAX_CHARS）
  pos_x           INTEGER,                -- 对话容器内的左上角（px）
  pos_y           INTEGER,                -- NULL = 尚未放置（渲染层取默认落点后回写）
  z               INTEGER NOT NULL,       -- 点击置顶的单调层号，值大者在上
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX stickies_conversation ON stickies(conversation_id);
```

- 渲染层乐观更新即时上屏，经 `stickies.create / update / delete` 异步落库；拖拽中的高频位置更新只在本地，拖拽结束才落库。
- `z` 由渲染层发牌（单调递增），启动水合时接到库中最大层号之后。
- 删除对话时随 `conversations` 行 FK 级联删除（含 `global`：来源对话是所有者）。

### todos / todo_runs / memos（工作台，D90，迁移 0037）

设计见 [design 39](../design/39-workbench.md)。事项（`todos`）是用户派的活；备忘（`memos`）是闪念，不绑对话、不进任何 Bot 的上下文（管家工具除外）。

```sql
CREATE TABLE todos (
  id                TEXT PRIMARY KEY,                -- todo_...
  title             TEXT NOT NULL,                   -- <= 120 字（TODO_TITLE_MAX_CHARS）
  notes             TEXT NOT NULL DEFAULT '',        -- <= 4000 字（TODO_NOTES_MAX_CHARS）；派发时给执行者
  assignee_bot_id     TEXT,                          -- Bot 执行者；项目组执行者时 = 可选的覆盖负责 Bot
  assignee_project_id TEXT,                          -- 项目组执行者（0042 改名）；不设 FK（删项目组由 TodoService / 对账处理）
  status            TEXT NOT NULL CHECK (status IN
                      ('draft', 'scheduled', 'in_progress', 'delivered', 'done', 'cancelled')),
  source            TEXT NOT NULL CHECK (source IN ('user', 'butler')),   -- 内容出处：管家创建，或管家改写过标题 / 说明
  memo_id           TEXT,                            -- 由哪条备忘转来（不设 FK，备忘清理不影响）
  blocked_reason    TEXT,                            -- 退回草案的原因（展示用）
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER,                         -- done / cancelled 时间
  scheduled_by      TEXT CHECK (scheduled_by IN ('user', 'butler'))  -- 最后一次设置该事项排期的操作者（到点派发据此标注「管家代你安排」）；不进 shared 的 Todo
);
CREATE INDEX todos_status ON todos(status, updated_at DESC);

CREATE TABLE todo_runs (                              -- 每次派发一条（单次事项通常只有一条）
  id                TEXT PRIMARY KEY,                -- tdr_...
  todo_id           TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  conversation_id   TEXT NOT NULL,                   -- 派到的对话（不设 FK：对话删了记录仍可读）
  message_id        TEXT,                            -- 派发消息
  status            TEXT NOT NULL CHECK (status IN ('dispatched', 'delivered', 'unclaimed', 'failed')),
  result_message_id TEXT,                            -- 交付的那条回复
  dispatched_at     INTEGER NOT NULL,
  settled_at        INTEGER
);
CREATE INDEX todo_runs_todo ON todo_runs(todo_id, dispatched_at DESC);

CREATE TABLE memos (
  id         TEXT PRIMARY KEY,                       -- memo_...
  body       TEXT NOT NULL,                          -- <= 10000 字（MEMO_BODY_MAX_CHARS），纯文本
  pinned     INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL CHECK (source IN ('user', 'butler')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,                      -- 最后修改时间（卡片上的相对时间用它）
  sort_at    INTEGER NOT NULL,                      -- 列表排序键（0046）：创建时间，只随置顶变化刷新
  deleted_at INTEGER                                 -- 非空 = 在「最近删除」
);
CREATE INDEX memos_live ON memos(deleted_at, pinned DESC, sort_at DESC);
```

- **执行者编码**：Bot 执行者 = `assignee_bot_id` 非空、`assignee_project_id` 空；项目组执行者 = `assignee_project_id` 非空（`assignee_bot_id` 可选，作覆盖的负责 Bot）；都空 = 未指派。shared 层表示为 `TodoAssignee`（`{kind:'bot', botId}` / `{kind:'project', projectId, leadBotId}` / `null`；`leadBotId` 记指派时解析的负责人，派发时按会话现状取生效负责人 `assignee.leadBotId ?? conversation.leadBotId`）。`assignee_bot_id` 与 `assignee_project_id` 都不设 FK：Bot 行是占位行、id 不复用；项目组若用 `ON DELETE SET NULL`，删除后「项目组 + 负责 Bot」会被读成 Bot 执行者、「项目组已解散」的原因也丢了，所以由 TodoService（`lifecycle.deleteConversation` 的显式钩子）与对账处理。
- **不变式**：有时间 ⇒ 必有执行者；有排期 ⇔ 存在 `schedules.todo_id` 指向该事项的 active 行。时间只存在 schedule 上。
- **状态**：`draft → scheduled → in_progress → delivered → done`，任意未结束状态可 `cancelled`；`done` / `cancelled` 经 `reopen` 回 `draft`。`blocked_reason` 只在退回草案时写（「负责 Bot 已删除」「项目组已解散」「项目里无人回应」……）。
- **执行记录**：`todo_runs` 一次派发一条；周期事项每次触发各一条。`conversation_id` 不设 FK，对话删了记录仍可读；`message_id` / `result_message_id` 只存 id。
- **备忘**：删除是软删（`deleted_at`），`MEMO_TRASH_RETENTION_MS`（30 天）后在启动时 `MemoStore.purgeTrashed(before)` 物理清理；`memos_live` 同时服务「最近删除」。`todos.memo_id` 不设 FK，备忘清理不影响事项。
- **备忘排序**（0046）：列表按 `pinned desc, sort_at desc, id desc`。`sort_at` 是排序键，创建时取创建时间，**只有置顶状态变化才刷新**（置顶卡提到置顶组最前）；改正文只动 `updated_at`（卡片上的相对时间、管家上下文里的「最近备忘」），**卡片不换位**。软删 / 恢复不动 `sort_at`，恢复后回到原位。
- 检索用 `LIKE`（量级千条以内）。
- 存储层：`core/src/workbench/todo-store.ts`、`memo-store.ts`（纯持久化；状态机、校验、排期、派发在 TodoService / MemoService）。

### widgets（Bot 自制交互组件，D81，main 0028）

Bot 在任务里用 `widget_craft`（D87 制作 loop，凭检查回执经 `WidgetService.create` / `update` 落库）交付的单文件 HTML 组件（[design/32](../design/32-bot-widgets.md)）：卡片消息只存描述符（`cardContentSchema.widget`），HTML 只在这里；版本只增不改，旧卡永远指向旧版本。

```sql
CREATE TABLE widgets (
  id              TEXT PRIMARY KEY,       -- wgt_...
  bot_id          TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL DEFAULT 'conversation' CHECK (scope IN ('conversation', 'bot')),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  latest_version  INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX widgets_bot ON widgets(bot_id);
CREATE INDEX widgets_conversation ON widgets(conversation_id);

CREATE TABLE widget_versions (
  widget_id      TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  html           TEXT NOT NULL,           -- ≤ BOT_WIDGET_HTML_MAX_BYTES（2MB）
  sha256         TEXT NOT NULL,           -- 渲染端按它记忆用户确认（同版本只确认一次）
  queries_sha256 TEXT NOT NULL DEFAULT '', -- 0029：该版本查询模板摘要（确认指纹含它）
  size_bytes     INTEGER NOT NULL DEFAULT 0, -- 0032：HTML 的 UTF-8 字节数（列表与配额只读它）
  queries_reviewed_at INTEGER,             -- 0032：含模板的版本被展开审查 SQL 的时间（open 强制预审）
  check_status   TEXT NOT NULL DEFAULT 'legacy', -- 0035（D87）：legacy / passed / issues / unverified
  check_summary_json TEXT NOT NULL DEFAULT '',   -- 0035：检查摘要（轮数、已知问题 ≤5、craftId；不含源码）
  created_by_run TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (widget_id, version)
);

-- 0029（P2）：命名只读查询模板，随版本登记（版本 = HTML + 查询的完整快照）。
CREATE TABLE widget_queries (
  widget_id  TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  name       TEXT NOT NULL,               -- 组件内 kepcup.query(name, params) 的名字
  sql        TEXT NOT NULL,               -- 单条只读 SELECT（交付时 prepare + 只读门槛预审）
  PRIMARY KEY (widget_id, version, name)
);

CREATE TABLE widget_docs (
  widget_id  TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (widget_id, key)
);
```

- `scope='conversation'` 的组件 `conversation_id` 非空，删除对话时 FK 级联清除；`scope='bot'` 的组件 `conversation_id` 为 NULL（不受会话删除影响，跨对话存活）。删除 Bot 时 bots 行改占位、`bot_id` 的 FK 不触发，由 `lifecycle.deleteBot` 经 `WidgetService.deleteForBot` 显式清除该 Bot 四表（见删除级联表）；管理界面删除走 `widgets.delete` → `WidgetService.delete`（级联相同，另摘除在途内存资源）。
- `widget_docs` 是能力桥的每组件命名空间 KV（P1 起由 `widgets.ui.storage` 写入：值存 JSON 文本，配额单值 256KB / 总量 1MB / 1000 键，见设计 32 §6）；组件删除时随 widgets 行级联清除。
- `widget_queries`（P2）是能力桥查询的模板表：由交付时的 `queries` 清单写入（D87 起来自制作草稿的 `queries.json`；每版本全量快照，≤20 条）；运行时 `widgets.ui.query` 按卡片钉住的版本取模板执行（旧卡用旧模板），SQL 在交付时被人工预审（审查态「查看源码」可见全文），运行时输入只有参数。
- 服务层在 `core/src/widgets/service.ts`；HTML 与 SQL 永不进模型上下文（卡片在 `renderCard` 只渲染一行固定文案）。
- D88 移交复制（P2，`WidgetService.copyForHandover`，无迁移）：只有 `scope='bot'` 的组件可复制（会话级随所在对话，不移交）。一个事务里给接手方插入新 `widgets` 行（新 id、仍为 Bot 级、`conversation_id` NULL、`latest_version` 照搬），`widget_versions` 全部行按原样复制（`html` / `sha256` / `queries_sha256` / `size_bytes` / `created_by_run` / `created_at` / `queries_reviewed_at` / `check_status` / `check_summary_json`），`widget_queries`、`widget_docs` 全部复制；不发卡。接手方已有同名组件、组件数或字节配额超限时不复制。渲染端的加载确认按「HTML sha256 + 查询摘要」记在本机（不分组件 / Bot），副本摘要不变，所以原版已确认的版本在接手方那里同样免确认。幂等判据：接手方名下同名、版本序列（版本号 + 两项摘要）完全相同的 Bot 级组件。
- `check_status` / `check_summary_json`（0035，D87）：制作 loop 交付时凭检查回执写入，卡片描述符同步带 `checkStatus` / `knownIssues`（审查态徽标，`legacy` 不显示）；`widget_publish` 发的卡沿用版本的状态。自检只是质量闸，不改变按版本人工确认。制作草稿不在库里：`bots/{botId}/widget-drafts/{craftId}/`（文件，交付即删，未交付保留 7 天，Bot 删除随 `bots/{id}` 目录删除）。

### delegations（D71，main 0016；0021 重建）

```sql
CREATE TABLE delegations (
  id                    TEXT PRIMARY KEY,       -- dlg_...
  from_bot_id           TEXT NOT NULL,
  to_bot_id             TEXT NOT NULL,
  from_conversation_id  TEXT NOT NULL,
  to_conversation_id    TEXT,                   -- B 私聊；投递时解析
  task_text             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
                          'submitted', 'working', 'awaiting_tasks',
                          'completed', 'failed', 'cancelled')),
  depth                 INTEGER NOT NULL DEFAULT 1,
  from_run_id           TEXT,                   -- A 发起委派的 run
  sent_message_id       TEXT,                   -- A 侧发出卡
  to_message_id         TEXT,                   -- B 侧代发用户消息
  run_id                TEXT,                   -- B 侧响应 run（投递时回填）
  result_excerpt        TEXT,
  result_message_id     TEXT,                   -- B 的终回复消息
  result_card_id        TEXT,                   -- A 侧结果卡
  error_text            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  intent                TEXT NOT NULL DEFAULT 'request',  -- request | question | fyi（zod 校验，无 CHECK）
  task_ids_json         TEXT NOT NULL DEFAULT '[]'        -- 跟随中的任务 id（续接链最新一环）
);
CREATE INDEX delegations_to_bot_status ON delegations(to_bot_id, status);
CREATE INDEX delegations_run ON delegations(run_id);
CREATE INDEX delegations_from_conversation ON delegations(from_conversation_id);
CREATE INDEX delegations_status ON delegations(status);
```

- 对话 / 消息 / run 只存 id，不加外键：对话删除时委派行保留，由 `lifecycle` 终态化（见删除级联表）。
- `submitted` = 行已写、尚未向 B 投递（等 B 邮箱空闲 / 免打扰结束）；`working` = 代发消息已落 B 私聊、`run_id` 已回填。
- `awaiting_tasks` = `request` 的委派轮结束时派出了任务（runs.db `origin_run_id` = `run_id`），等这些任务（`task_ids_json`，顺着续接链更新）结算，结果取各任务结果摘要拼接；`fyi` 投递即 `completed`（`result_excerpt` / `result_card_id` 为空）。

### app_connections（D73 P0，迁移 0025）

连接应用（[design/29](../design/29-connected-apps.md) §12）：一行 = 一个账号对一个 Connector（目录应用或自定义 MCP server）的授权。

```sql
CREATE TABLE app_connections (
  id               TEXT PRIMARY KEY,         -- conn_...；自定义 server 为 custom:{serverId}
  connector_id     TEXT NOT NULL,            -- 目录清单 name；自定义为 custom:{serverId}
  connector_ver    TEXT,                     -- 自定义应用为 NULL
  label            TEXT NOT NULL,            -- 账号显示名（可改）
  account_sub      TEXT,                     -- 账号稳定标识（id_token sub 等），用于去重
  server_url       TEXT,                     -- stdio 自定义 server 为 NULL
  issuer           TEXT,                     -- 授权服务器 issuer
  scopes           TEXT NOT NULL DEFAULT '', -- 已授予 scope，空格分隔
  token_expires_at INTEGER,                  -- access token 到期（epoch ms，非机密）
  discovery_json   TEXT,                     -- OAuthServerInfo 缓存
  status           TEXT NOT NULL,            -- appConnectionStatusSchema，由 zod 校验，无 CHECK
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_used_at     INTEGER
);
CREATE UNIQUE INDEX app_connections_account
  ON app_connections(connector_id, account_sub) WHERE account_sub IS NOT NULL;
CREATE INDEX app_connections_connector ON app_connections(connector_id);
```

- **令牌不在此表**：access / refresh token 与 OAuth 客户端 id / secret **逐值**存 `secrets` 表（每个机密一个名称，`redact()` 按整值匹配，JSON 打包会让令牌逃过脱敏）：`conn:{connectionId}:access`、`conn:{connectionId}:refresh`、`oauth:client:{issuerHash}:id` / `:secret`（`issuerHash` = sha256(issuer) hex 前 24 位；同 issuer 的连接共享客户端）。读写经 `core/apps/token-vault.ts`，行的 CRUD 经 `core/apps/connection-store.ts`。
- 非机密元数据（`token_expires_at`、`scopes`、`issuer`、`discovery_json`）在行内。
- 同一迁移还建 `oauth_clients`（按 issuer 一行，跨连接共享，设计 29 §12 未列、P0 实现需要）：

```sql
CREATE TABLE oauth_clients (
  issuer_hash   TEXT PRIMARY KEY,            -- sha256(issuer) hex 前 24 位
  issuer        TEXT NOT NULL,
  source        TEXT NOT NULL,               -- 'dcr' | 'manual' | 'preregistered'
  redirect_uris TEXT NOT NULL DEFAULT '[]',  -- JSON 数组：已登记的回调地址（DCR 端口预判用）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

  client id / secret 仍逐值存 secrets；该表只记来源与已登记 `redirect_uris`，使「客户端是否来自 DCR（最后一个引用方断开后清除）」与打开浏览器前的回调端口预判不必读机密。CIMD 客户端的 `client_id` 是常量，不落表。
- 自定义 MCP server 的连接 `id = connector_id = custom:{serverId}`，每个 server 至多一行；断开**不删行**（`status = 'not_connected'`，清令牌），只随 `mcp.removeServer` 删除。`apps.connections.list` 默认不返回 `custom:` 行。
- P1（迁移 0026）追加列 `baseline_pending INTEGER NOT NULL DEFAULT 0`（见下节）。非 OAuth 的自定义 server 也建 `custom:{serverId}` 行承载工具锁定：`server_url` 可为 NULL（stdio），`status = 'connected'`（无需授权；`apps.connections.list` 默认不返回 `custom:` 行）。

### app_connection_tools / app_tool_grants（D73 P1，迁移 0026）

**工具定义锁定**（[design/29](../design/29-connected-apps.md) §8.2；`core/apps/tool-lock.ts`、纯函数在 `core/apps/policy.ts`）：对**所有** MCP server 生效。承载行是 `app_connections`（目录连接 `conn_…`；自定义 server `custom:{serverId}`）。

```sql
CREATE TABLE app_connection_tools (
  connection_id   TEXT NOT NULL REFERENCES app_connections(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  approved_hash   TEXT,                      -- NULL = 待复核（新工具）
  current_hash    TEXT NOT NULL,             -- 最近一次 tools/list 的定义哈希
  risk            TEXT NOT NULL,             -- W5 分级器 + 目录 toolPolicy 叠加（只能调高）
  user_policy     TEXT,                      -- 逐工具策略 JSON，与 W5 mcpToolPolicy 同形 {approval?, enabled?}；NULL = 按风险档默认
  definition_json TEXT NOT NULL,             -- 最近一次的完整定义（复核 diff 的“新”）
  approved_definition_json TEXT,             -- 批准当时的定义快照（复核 diff 的“旧”）；从未批准 = NULL
  PRIMARY KEY (connection_id, tool_name)
);
CREATE TABLE app_tool_grants (
  id              TEXT PRIMARY KEY,          -- atg_...
  bot_id          TEXT NOT NULL,             -- 无外键：删除 Bot 保留占位行，由 core 撤销
  connection_id   TEXT NOT NULL REFERENCES app_connections(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE, -- NULL = 对该 Bot 总是允许
  approval_id     TEXT,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER                    -- 撤销 = 写时间戳，行保留作审计
);
CREATE INDEX app_tool_grants_live
  ON app_tool_grants(bot_id, connection_id, tool_name) WHERE revoked_at IS NULL;
CREATE INDEX app_tool_grants_conversation
  ON app_tool_grants(conversation_id) WHERE conversation_id IS NOT NULL;
ALTER TABLE app_connections ADD COLUMN baseline_pending INTEGER NOT NULL DEFAULT 0;
```

- **哈希**：`{name, title, description, inputSchema, annotations}` 键排序的规范化 JSON → sha256 hex（`toolDefinitionHash`）。
- **状态机**：刷新（`tools/list`、`list_changed` 之后的重拉）时，新工具 `approved_hash = NULL`、定义变化 `current_hash ≠ approved_hash`——二者**不暴露**给模型（`buildMcpTools` / `resolveMcpToolEntries` 的 `toolFilter`，调用时网关再核一次），连接 `connected → tools_changed` 并发 `apps.connection_status`（带待复核计数 `tools`）；消失的工具直接删行；复核批准 = `approved_hash := current_hash`，无待复核后 `tools_changed → connected`（`expired` / `needs_scope` 等更紧迫的状态不被覆盖）。
- **存量基线**（只作用一次）：core 启动时 `settings.apps.toolLockBaselineDone` 不为真 → 为当时已存在的每个自定义 server 建 `custom:` 行并置 `baseline_pending = 1`，其首次拉取到的工具直接批准（之后清零），随后置位该标记。之后新加的 server：设置页「测试」成功后 `approveAfterTest`，保存即批准；未批准前工具不暴露。`settings.apps` 是 core 自有键（不在 `settings.update` 入参里，`{...current, ...patch}` 的浅合并保证它不被渲染端的 patch 抹掉）。
- **授权**：`app_tool_grants` 以 (Bot, 连接, 工具) 为键；`conversation_id` 为空 = 对该 Bot 总是允许，非空 = 仅在该对话内。现有 `grants` 表按路径设计，不复用。清理见下方删除级联表。

### app_taint（D73 P2，迁移 0027）

污点状态（[design/29](../design/29-connected-apps.md) §8.3 / §12；`core/apps/taint.ts` 的 `TaintService`）：某 Bot 在某对话里**成功读取过目录应用（`conn_…`）的工具结果**后置位，之后 24 小时（`APP_TAINT_TTL_MS`）内该 (Bot, 对话) 的外发通道降级为逐次确认（`egress` 审批）。每次成功读取续期（`first_at` 在未过期时保持，过期后重新开始）；按 (Bot, 对话) 计而不按 run 计，`runs.retry`、后续对话轮与任务共用同一行。自定义 MCP 工具**不是来源**（只是通道）。`settings.apps.taintGuard`（默认 true，设置「无人值守 / 高级」）关闭时仍置位、只是不再拦截。

对话级外发放行（D73 P2 后续，同服务的 `allowEgress` / `egressAllowed`）：用户在 `egress` 卡上选了更长时长（`conversation` / bash 的 `command`）时由网关写入；按**对话**计（与污点判定同级，项目组共享），`scope` 为 `'all'` 或 `'cmd:<sha256(命令原文)>'`。网关 `egressCheck` 在出卡前查它，命中（未过期）即直接放行；`mark`（新的应用读取）与对话删除（`deleteForConversation`）清行，`sweepExpired` 回收过期行。

```sql
CREATE TABLE egress_allows (
  conversation_id TEXT NOT NULL,
  scope           TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, scope)
);
CREATE INDEX egress_allows_expires ON egress_allows(expires_at);
```

```sql
CREATE TABLE app_taint (
  bot_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  first_at        INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (bot_id, conversation_id)
);
CREATE INDEX app_taint_expires ON app_taint(expires_at);
```

不设外键 / CASCADE：对话删除时 `domain/lifecycle.ts` 删掉该对话的全部行，Bot 删除时只删它自己私聊里的行（项目组里的行保留到过期——其他成员读到过它的输出）；其余遗留行由 `sweepExpired()`（启动时与每次置位时）清理。

**判定粒度与跨 Bot 传递**：外发拦截按**对话**判定（`TaintService.guard` = 该对话里任一 Bot 的行未过期）——项目组里 Bot B 读到 Bot A 的输出时不能把污点「洗掉」；私聊只有一个 Bot，与按 (Bot, 对话) 等价。跨对话的交接由 `TaintService.inherit` 传递：委派投递（`delegations` 转 `working`）把 A 对话的污点带到 B 的私聊，B 的结果贴回（转 `completed`，非 `fyi`）再把 B 私聊的污点带回 A 的对话；继承保留来源的 `first_at`，`expires_at` 取较晚者（不因传递而延长）。接线在 `DelegationsService.onMoved`（`start.ts`）。

### bot_handovers / bot_handover_items（D88，迁移 0036）

```sql
CREATE TABLE bot_handovers (
  id               TEXT PRIMARY KEY,           -- hnd_...
  approval_id      TEXT,                       -- 移交卡（approvals.kind = 'bot_handover'）
  proposer_bot_id  TEXT NOT NULL,              -- 发起方（P0 恒为管家）
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_bot_id      TEXT NOT NULL,
  to_bot_id        TEXT,                       -- 新建目标建好后回填（与建 Bot 同一事务）
  new_bot_json     TEXT,                       -- 新建目标的字段（同 propose_bot + model）
  status           TEXT NOT NULL CHECK (status IN (
                     'proposed', 'applying', 'completed', 'partial', 'failed', 'denied', 'cancelled')),
  plan_json        TEXT NOT NULL,              -- 提交时的移交卡 payload 快照
  notified_at      INTEGER,                    -- 结果已通知发起方（NULL = 未通知，启动恢复补发）
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX bot_handovers_approval ON bot_handovers(approval_id);
CREATE INDEX bot_handovers_status ON bot_handovers(status);

CREATE TABLE bot_handover_items (
  handover_id  TEXT NOT NULL REFERENCES bot_handovers(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,      -- 资产 key（mail:… / app:… / mcp:… / model:… / schedule:…）或宿主条目
  asset_type   TEXT NOT NULL,      -- 无 CHECK：后续期的适配器与宿主条目共用
  action       TEXT NOT NULL,      -- move / share / copy；宿主条目为 create / rewrite / write
  status       TEXT NOT NULL CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  error        TEXT,               -- skipped / failed 的原因
  result_json  TEXT,               -- 如重建后的定时任务 id、改投的提醒数
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (handover_id, key)
);
```

- 批准时在一个事务里写入被勾选的条目（`pending`）并把移交置为 `applying`；宿主条目：`bot:new`（新建目标）、`resp:to` / `resp:from`（职责改写）、`note:handover`（两侧交接说明）。
- `(handover_id, key)` 是幂等键：执行前查状态，`done` 跳过；启动时 `applying` 的移交继续剩余 `pending` 项，`proposed` 而卡片已被启动恢复取消的落 `cancelled`。
- 结算：全部 done → `completed`；一项都没做成 → `failed`；其余 → `partial`（跳过与失败都算未完成）。
- 删除级联：对话物理删除时随 FK 删除；Bot 删除不删（Bot 行是占位行、id 不复用，记录留作历史；对应的待确认卡由「删除 Bot 取消其 approvals」处理，执行中的条目重新校验时因 Bot 已删除而跳过）。
- P2 后台条目（`wiki:*`、`widget:*`）：确认后的同步阶段不执行，阶段 2–6 之后登记一个 `handover_copy` 作业；作业结束前移交保持 `applying`，交接说明（`note:handover`）与结算在作业完成后才做。`result_json` 约定：`copiedCount`（Wiki 页数 / 组件版本数）、`skippedPaths`（接手方已有同路径、内容不同而没覆盖的页）、Wiki 另有 `missingPaths` / `bytes` / `rawConflicts` / `commit`，组件另有 `widgetId`（副本 id）。执行视图（`handovers.get` / `handover.updated`）把前两项带给卡片，另由宿主算出 `retire`（全部完成、没有跳过的页与原件冲突、接手方仍在、来源仍在且不是管家、来源名下已没有邮箱 / 连接应用 / MCP / 定时任务 / 网页监看时 = `{botId, botName, remaining: {memory, wikiPages, skills, widgets}}`，否则 null）。

### agent_sessions（D72，迁移 0017；D75 迁移 0019 重建为按任务分）

```sql
CREATE TABLE agent_sessions (
  id                TEXT PRIMARY KEY,     -- ags_...
  bot_id            TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  agent_id          TEXT NOT NULL,        -- 目录 id（如 claude-acp）
  task_id           TEXT NOT NULL DEFAULT '',  -- 0019：任务 run id；'' = 非任务 run 的会话
  agent_session_id  TEXT NOT NULL,        -- Agent 侧 ACP sessionId
  fingerprint       TEXT NOT NULL,        -- 会话级参数指纹（提示词 / 能力集合 / 桥名 / 档位…），变化即新建
  last_run_id       TEXT,
  last_used_at      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX agent_sessions_key ON agent_sessions(bot_id, conversation_id, agent_id, task_id);  -- 0019
```

- 外部智能体会话按任务分（D75，[design/30](../design/30-supervisor-and-tasks.md) §8.5）：唯一键是四元组 `(bot_id, conversation_id, agent_id, task_id)`；`task_id = ''` 是哨兵值——SQLite 唯一索引把 NULL 视为互不相同，用 `''` 才能让非任务 run 的行仍按三元组唯一。每个任务独占自己的行；`continues_task_id` 接续时 `AgentSessionsStore.inheritTask` 单条 `UPDATE` 把旧任务的行改挂新任务（旧任务的执行须已结束）。任务行的会话 / 桥键 = `bot:conv:agent:task:{行 id}`，随行而不随任务 id（DEV-010）；非任务行为 `bot:conv:agent`。只存 id、无外键 / CASCADE。
- 结算后的任务会话行保留 `CONTINUATION_WINDOW_MS`（自 `last_used_at` 起），之后 reaper（`TaskHost.sweep` 的 `onSweep`）`session/close` 并删行。
- 写入方（P5）：orchestrator 在 Agent 会话建立后 upsert（`AgentSessionsStore`，`domain/agent-sessions.ts`），run 结束 `touch(last_run_id, last_used_at)`；复用窗口从 `last_used_at` 起算。宿主 MCP 桥的 server 名由行 id 派生（`kepcup_` + sha256(id) 前 8 位），不另存列——换会话即换行 id。
- 删除对话 / 删除 Bot / 移出项目组经 `lifecycle` 清理（下方删除级联表）；停用 / 卸载 Agent 不删行：进程随之停止，保留的会话随进程失效，下次启用后按窗口与指纹 resume / load 或新建。

## runs.db

### runs（P01）

```sql
CREATE TABLE runs (
  id                   TEXT PRIMARY KEY,  -- run_...
  bot_id               TEXT,
  conversation_id      TEXT,
  loop_type            TEXT NOT NULL,     -- turn | task | subagent | triage | reflection | …（无 CHECK；0007 把 response 改为 turn）
  status               TEXT NOT NULL CHECK (status IN (
                         'queued', 'running', 'waiting_approval', 'waiting_lease',
                         'completed', 'failed', 'cancelled', 'interrupted')),
  trigger_reason       TEXT,              -- direct | mention | reply | bot_mention | continuation | routing_gate | routed | routed_also | lead_fallback | scheduled | event | background | delegation | task | watch | mail（D92 T1a 起：无 broadcast / chain；routing_gate 只写在负责人网关的轻量调用 run 上）
  trigger_message_ids_json TEXT NOT NULL DEFAULT '[]',
  episode_id           TEXT,              -- 0014（D92 T1a）：所属协作回合（main.db episodes，跨库只存 id）
  episode_hop          INTEGER,           -- 0014（D92 T1a）：回合内的 Bot 发起触发层数
  provider             TEXT,
  model                TEXT,
  output_message_ids_json TEXT NOT NULL DEFAULT '[]',
  summary              TEXT,
  continued_from_run_ids_json TEXT,    -- 续接来源 run id 列表（Loop 续接，design/02）；null＝无续接
  error_json           TEXT,           -- {message, setup?, reason?, dismissed?}：setup 为结构化的「设置前置需求」（design/18），仅因缺设置失败时非空；reason 为机器可读原因（`Run.errorReason`：`permission_revoked`、`browser_profile_changed`、`uncertain_repeat_timeout`）；dismissed 为用户已关闭失败横幅（`Run.failureDismissed`），刷新后不再恢复
  parent_run_id        TEXT,           -- 0004：SubAgent 子 run 的委派方 run（D66/D67）；其余为 null
  engine               TEXT NOT NULL DEFAULT 'builtin', -- 0005：执行引擎 'builtin' | 'agent:{id}'（D72）
  agent_session_id     TEXT,           -- 0005：外部 Agent 侧的 ACP sessionId；内置引擎为 null
  task_title           TEXT,           -- 0006（D75）：任务标题；以下任务列在非任务 run 上为 null / 0
  task_writes          INTEGER,        -- 0006：1 = 写任务，0 = 只读任务
  task_cwd             TEXT,           -- 0006（runs 0013 改名）：解析后的任务执行根目录
  origin_run_id        TEXT,           -- 0006：派出该任务的对话轮
  result_consumed_at   INTEGER,        -- 0006：任务结果被对话轮消费的时间（design/30 §3.2）
  awaiting_input       INTEGER NOT NULL DEFAULT 0, -- 0006：running 下等待用户输入（design/30 §2.4.6）
  trigger_parts_json   TEXT,           -- 0008：对话轮触发批的各来源段 [{reason, messageIds, extraAttributes?}]；NULL = 旧行或单段批
  retry_of_run_id      TEXT,           -- 0008：重试出来的对话轮指向被重试的那一轮
  task_capabilities    TEXT,           -- runs 0012（D91）：任务声明的外部能力 id 的 JSON 数组（`["app:github","mcp:notes"]`）；非任务 run 与未声明的任务为 NULL
  created_at           INTEGER NOT NULL,
  started_at           INTEGER,
  ended_at             INTEGER
);
CREATE INDEX runs_by_conv ON runs(conversation_id, created_at);
CREATE INDEX runs_by_bot ON runs(bot_id, created_at);
CREATE INDEX runs_by_conv_loop_status ON runs(conversation_id, loop_type, status);  -- 0006
CREATE INDEX runs_by_parent ON runs(parent_run_id);  -- 0009：台账沿续接链收集子代理子 run
```

- 任务（D75，[design/30](../design/30-supervisor-and-tasks.md) §3.4）就是 `loop_type = 'task'` 的 runs 行，不另建表；任务的 submitted 用现有状态 `queued` 表示；对话轮为 `loop_type = 'turn'`。`continued_from_run_ids_json` 复用为 `start_task({continues_task_id})` 的回放来源。查询入口：`RunsService.listTasks` / `listNonTerminalTasks` / `listUnconsumedTerminalTasks`（终态且 `result_consumed_at IS NULL`）。外部智能体 Bot 的任务在创建时就记 `engine` / `provider = 'agent:{id}'`（门禁未过、引擎未启动就失败的任务也显示正确的引擎）。
- 任务声明的能力（D91，runs 迁移 0012，[design/40](../design/40-capability-mounting.md) §4）：`task_capabilities` 是 `start_task.capabilities` 校验、去重后的能力 id（`app:{connectorSlug}` / `mcp:{serverId}`）JSON 数组，空数组存 NULL。`continues_task_id` 的新任务存「被接续任务的能力 ∪ 本次声明」；`runs.retry` 沿用行上的值；宿主自己派的任务（design 30 §8.4 降级）不写。任务启动时与当前能力目录求交后才决定挂什么，所以这里只是「声明」，不保证都挂上了。`Run.taskCapabilities: string[] | null` 经 `Run` / `TaskView.capabilities` 暴露给渲染层。
- 对话轮：`trigger_parts_json` 让重试按来源段重建合并批（各段保留自己的 reason 与属性，`RunsService.triggerPartsOf`）；`runs.setTrigger` 在对话轮开始执行、吸收缓冲批后更新触发记录（吸收了回合批时一并写 `episode_id` / `episode_hop`，取更深 hop——审查批 E / M1；任务结算唤醒的轮次在唤醒时按起源轮解析继承回合，`retry_of` 重建的批沿用原回合绑定）。`retry_of_run_id`（`RunsService.retryOfRunId`）：重试出来的对话轮派出的任务，与被重试那一轮（及更早的重试链）派出的同名任务视为同一个，不重复派出。
- 外部 Agent 的 run（D72）：`provider = 'agent:{id}'`、`model` 为伪 ref `agent:{id}/{model|default}`（调度器并发键随之落到 `agent:{id}`）、`engine = 'agent:{id}'`；`run_steps` 的事件形状与内置引擎逐字段一致（续接、反思、中间说明都读它）。

### run_steps（P01）

```sql
CREATE TABLE run_steps (
  id          TEXT PRIMARY KEY,           -- stp_...
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN (
                'request', 'assistant', 'tool_call', 'tool_result', 'steer', 'progress', 'system')),
  payload_json TEXT NOT NULL,             -- 已脱敏
  created_at  INTEGER NOT NULL,
  UNIQUE (run_id, seq)
);
```

`request` 类型记录每次发给模型的完整上下文（“模型看到的一切都在日志里”），便于排查；写入前脱敏。

- 浏览器敏感输入（D77）：`browser_type` 声明 `sensitive` 或命中密码框时，tool_call 步骤的 `text` 写成 `«redacted:N chars»`（执行中才发现的密码框经 `RunsService.replaceStepPayload` 改写已落盘的那条 tool_call），该值登记为本 run 的敏感值，之后落盘的各类步骤里出现的原文替换为 `«redacted»`（`agent/step-persistence.ts` 的按工具参数脱敏表）。浏览器动作的 tool_result payload 带 `outcome`（`not_started` / `completed` / `uncertain`）；台账结为 uncertain 而工具未给出结局的调用，宿主补 `outcome:'uncertain'`。

### tool_effects（D78，runs 0009）

外部副作用台账（[design/24 §10](../design/24-durable-execution.md#10-外部副作用台账d78)）：有外部副作用（`external`）的工具调用执行前写一行、结束后结。只读与本地可撤销的调用不记，沙箱内命令不记。

```sql
CREATE TABLE tool_effects (
  id            TEXT PRIMARY KEY,                -- eff_...
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id  TEXT NOT NULL,                   -- 同一 run 内重复的 id 存为 id#2、id#3…
  tool_name     TEXT NOT NULL,
  effect_key    TEXT NOT NULL,                   -- runId:tool:args_hash[:16]:occurrence
  args_hash     TEXT NOT NULL,                   -- 脱敏后规范化参数 JSON 的 sha256
  summary       TEXT NOT NULL,                   -- 已脱敏、≤200 字
  approval_id   TEXT,                            -- main.approvals.id（跨库，无外键）
  status        TEXT NOT NULL CHECK (status IN (
                  'intended', 'executing', 'completed', 'failed', 'uncertain', 'denied')),
  receipt_json  TEXT,                            -- 工具自报回执 {url?, externalId?, note?}（目前只有 MCP 工具填写）
  created_at    INTEGER NOT NULL,
  settled_at    INTEGER,
  UNIQUE (run_id, tool_call_id)
);
CREATE INDEX tool_effects_by_run ON tool_effects(run_id, created_at);
CREATE INDEX tool_effects_by_key ON tool_effects(effect_key);
CREATE INDEX tool_effects_by_approval ON tool_effects(approval_id) WHERE approval_id IS NOT NULL;  -- 0010
```

- 写入：`agent/effects/recorder.ts`（`executeToolSafely` 的可选记录器，内置引擎与外部智能体宿主桥共用）；确认模式下批准的 `bash` 命令只在网关决定沙箱外执行时经 tool-call scope 的 `escalate` 才写行；`request_unsandboxed` 在 `agent/effects/classify.ts` 归 `external`，审批前就写行，被拒结为 `denied`。审批经 `noteApproval` 回填 `approval_id`（只认同一 run、仍在 `executing` / `intended` 的行）。记录器出错只记日志。
- `occurrence` 在写入事务里按（run、工具、`args_hash`）计数。等审批时 `markIntended` 把行在 `executing` ⇄ `intended` 间切换（同一调用已有审批被批准后不再回到 `intended`）。`settle` 只改 `executing` / `intended` / `uncertain` 行。审批去重门拦下的调用（同一任务链已完成）删除其行（`discard`）。
- 恢复：`ToolEffectsStore.markExecutingUncertain()`（启动恢复第 0 步，全表；任务被中断时按 run 列表）：`executing` → `uncertain`，`intended` → `denied`；`settleUnapproved(runIds, approvalIds)` 把审批被取消的 `executing` / `intended` 行结为 `denied`。
- 读取：`listForRun`、`listForRuns`、`chainRunIds(taskId)` / `listForTask(taskId)`（沿 `continued_from_run_ids_json` 向前追溯，并带上各 run 的 `parent_run_id` 子 run）；RPC `effects.list({ taskId })`。审批去重：`sameEffectRows`（同一任务链、同工具同 `args_hash`）、`lastUserAnswerAt`（最近一次成功的 `ask_user` 回答）；审批回执：`forApprovals(ids)`（按 `approval_id` 批量反查）。

## memory.db（每个 Bot 一个，P07 起）

```sql
CREATE TABLE meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL                    -- 例如 embedding_model、embedding_dim
);

CREATE TABLE memory_items (
  id              TEXT PRIMARY KEY,       -- mem_...
  kind            TEXT NOT NULL CHECK (kind IN (
                    'fact', 'preference', 'commitment', 'feedback', 'episode', 'lesson', 'self_note')),
  content         TEXT NOT NULL,
  subject         TEXT,
  source          TEXT NOT NULL CHECK (source IN ('explicit', 'inferred')),
  evidence_json   TEXT NOT NULL,          -- [{ messageId, conversationId, runId }]；D88 移交副本见下
  origin          TEXT NOT NULL CHECK (origin IN ('private', 'project')),  -- 0003（D92 T1a WP4）：原 'group' 值转换
  origin_conversation_id TEXT,
  confidence      REAL NOT NULL,
  sensitivity     TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
  private_to_bot  INTEGER NOT NULL DEFAULT 0,  -- 用户说“只告诉你”
  due_at          INTEGER,                -- commitment 的截止时间
  valid_until     INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retracted', 'void')),
  supersedes      TEXT,
  last_used_at    INTEGER,
  use_count       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX memory_active ON memory_items(status, kind);

CREATE VIRTUAL TABLE memory_fts USING fts5(segmented_text, item_id UNINDEXED, tokenize = 'unicode61');

-- 维度在首次配置向量模型时确定；更换模型时删除并重建该表，重新计算全部向量
-- CREATE VIRTUAL TABLE memory_vec USING vec0(item_rowid INTEGER PRIMARY KEY, embedding float[<dim>]);
```

- `void`：承诺因对话删除或 Bot 被移出项目组而作废；D88 起也包括「承诺随定时任务移交给了别的 Bot」（来源 Bot 的那条置 `void`，不再进 `<my_state>`，联动任务按 `memory.commitment_invalidated` 取消）。
- **D88 移交副本**（P1，无 schema 变更、无迁移）：Bot 资产移交按条复制的记忆写进接手方的库，新 id；kind / content / subject / source / origin / confidence / sensitivity / due_at / valid_until 照搬，`private_to_bot` 恒为 0（`private_to_bot=1` / `self_note` / 非 active / 已过期的条目从不复制），`origin_conversation_id` 置空；`evidence_json` 是来源记录 `[{messageId: null, conversationId: null, runId: null, handoverId, fromBotId, fromItemId}]`（`memoryEvidenceSchema` 的可选字段），既是幂等判据（同一 `handoverId` + `fromItemId` 只写一条），也表明它不是用户对接手方说的话——没有消息 id，不能作为画像提议的证据。随定时任务移交的承诺副本例外：`origin_conversation_id` = 重建任务所在的对话（对话删除 / 移出项目组时照常作废）。写入后 best-effort 入向量（失败由向量重建补齐）。承诺联动的定时任务没移交成时，本次移交写给接手方、没接上任何 active 任务的承诺副本置 `void`（不留孤儿承诺）；`findHandoverCopy` 取 active 优先、其次最新的一条。

### wiki_fts（P09）

```sql
CREATE VIRTUAL TABLE wiki_fts USING fts5(
  segmented_text, page_path UNINDEXED, title UNINDEXED, tokenize = 'unicode61'
);
```

每次 Wiki 维护提交后，按变更的页面增量更新（提交 diff 中被删除的页面同步移除索引行）；界面删除页面走同一条提交通道，`wiki.rollback` 与启动对账则全量重建。

D88 移交复制 Wiki（P2，`WikiService.copyForHandover`，无迁移）：来源 Bot 的维护锁内把选中的页、页面链接到的 `raw/` 原件与 D85 资产（`raw/_assets/{id}.json`、`raw/_derived/{id}/`、仓外 `bots/{id}/wiki-store/{id}/`，`staging/` 除外）快照进暂存目录 `{cacheDir}/handover-staging/{handoverId}/`（与 `bots/` 同一文件系统；仓外目录是符号链接时不跟随；仓外资产硬链接，跨设备时复制；实时状态 `state.json` 总是复制）；再在接手方的维护锁内逐个 rename 进 `bots/{B}/wiki/` 与 `bots/{B}/wiki-store/`——目标已有同路径：字节相同 = 已复制（续跑幂等），不同 = 保留接手方的、在结果里列出（页面不覆盖不改名；原件不覆盖）。只放复制成功的页所引用的原件与已完成（`derived` / `maintained`）的资产，B 那份清单与 `state.json` 的 `sources` 改为移交来源。落盘前把本次要放的页写进 `bots/{B}/wiki-handover/{handoverId}.json`（续跑时其中的页算已复制），移交到终态时与暂存一起删除，启动时清扫残留。一次复制总量上限 `HANDOVER_WIKI_COPY_MAX_BYTES`。然后 log.md 追加一行（每个移交只一行）、树有变化时提交「从 {A} 复制 N 页」；提交之前出错则删掉本次落盘的文件、恢复 log.md 再抛错（不留未提交的文件）。提交之后增量写这些页的 `wiki_fts` 并 `reconcileFtsFor(B)`、给 B 排一次 `wiki_lint`（`dedupe_key = wiki_lint:{B}:handover`），这两步失败只记日志（启动对账兜底）。暂存目录在结束时删除。来源 Bot 的 Wiki 不被修改。**项目 wiki 不在移交范围（D92）。**

### 项目 wiki 的磁盘布局与台账（D92 T1b）

wiki 域按所有者泛化（`WikiOwner = { kind: 'bot', botId } | { kind: 'project', projectId }`，shared 导出）；路径助手在 `infra/paths.ts`：`projectRoot` / `projectWikiRoot` / `projectWikiStoreRoot` / `projectWikiDbPath`。

```text
projects/{projectId}/            # 项目数据根（projectId = 根会话 id）
  wiki/                          # git 仓库，布局同 Bot wiki（SCHEMA/index/log/raw/pages）
    raw/_assets/ast_{24hex}.json # 来源台账（本篇 D85 小节的文本子集 + createdBy）
  wiki-store/                    # 仓外内容存储（本期项目 wiki 只有文本来源，暂只承载目录形态）
  wiki.db                        # 项目级 FTS 库：加密 sqlite，仅 wiki_fts；连接池按项目懒开、删除时先关再删目录
```

- `wiki.db` **不走迁移目录**：DDL 内嵌在 `wiki/index-manager.ts` 并自管 `PRAGMA user_version`（当前 1，`wiki-index-store.test.ts` 保证与 `migrations/memory/0002` 的 `wiki_fts` 形态一致）；启动时对存在库做一次完整性对账，`WikiIndexStore` / `WikiFtsFacade.storeFor(owner)` 按 owner 路由（Bot 的 FTS 仍在其 `memory.db`）。
- **来源台账** `raw/_assets/{assetId}.json`（`wiki/assets.ts` 的 `WikiAssetEntry`，对齐 D85 §3.2 的文本子集）：`{ id: 'ast_'+sha256 前 24 hex, sha256, kind: 'text'|'html', fileName, bytes, storage: 'git', rawRelPath, createdBy: {kind:'user'} | {kind:'bot', id}, sources: [{ type: 'attachment'|'file'|'url'|'text', ref, conversationId, at }], status: 'maintained', createdAt, updatedAt }`。`text` 是用户粘贴文本（仅用户可提交，`ref` 只存正文前 80 字预览，≤ `WIKI_TEXT_SOURCE_MAX_CHARS`）；同一内容重复提交只在 `sources[]` 追加，不重复入库。Bot 个人 wiki 暂不启用台账（`raw/` 来源保持匿名）。
- 互斥：项目 wiki 的维护 / 删除共用单写入队列（互斥键 `project:{id}`）；删除项目组时先排空在途维护（`prepareProjectDeletion`）再删行与目录。

## 删除级联

**每个阶段引入新数据时，必须在该阶段内把清理逻辑接入下表对应的操作，并补充测试。** 清理逻辑集中在 `core/src/domain/lifecycle.ts`。

### 删除对话

| 数据 | 处理 | 阶段 |
|---|---|---|
| messages、messages_fts、attachments（含文件） | 删除 | P01 |
| conversation_members、conversations 行 | 删除 | P01 |
| 该对话的执行（runs、run_steps） | 删除；正在执行的先取消 | P01 |
| 该对话的任务（D75） | 未结束的经 `TaskHost.abortForConversation` 结算为 `cancelled`（不唤醒），随后按上行删除；私有任务条目随 messages 删除 | D75 |
| agent_sessions 中该对话的任务会话行（一对话可有多行） | 同下行，逐行处理 | D75 |
| 该对话的 jobs | 取消 | P01 |
| 所有 Bot 在该对话的 workspace 目录 | 删除 | P02 |
| 该对话的 approvals（待确认的先取消）、grants | 删除 | P03 |
| app_tool_grants 中该对话的行 | 随外键 `ON DELETE CASCADE` 删除 | D73 P1 |
| agent_sessions（外部智能体会话行；尽力 `session/delete`，Agent 自己目录里的 transcript 不清理） | 删除 | D72 P5（`Orchestrator.agentSessionsOnConversationDeleted`） |
| run_changes | 删除（workdir 文件与影子仓库不动） | P04 |
| episodes（协作回合） | 删除（conversations FK 级联） | P05 / D92（main 0041） |
| 各 Bot 记忆中 `origin_conversation_id` 为该对话的承诺 | 置为 `void` | P07 |
| schedules | 删除 | P10 |
| todos 中以该对话为项目组执行者的行 | 删除前由 TodoService 钩子退回 `draft`（原因「项目组已解散」）并清执行者；漏掉时启动 / `schedules.changed` 对账兜底（`assignee_project_id` 无 FK，会话不存在或已只读都算）；`todo_runs` 保留（`conversation_id` 无 FK） | D90 |
| watches | 删除 | D79 |
| stickies（含 global：来源对话是所有者） | 删除（conversations FK 级联） | 便签持久化 |
| 在该对话发起的 bot_handovers / bot_handover_items | 删除（conversations FK 级联；待确认的移交卡先随 approvals 取消） | D88 |
| 该对话的 Bot 自制组件（D81 `widgets`，scope='conversation'） | 删除（conversations FK 级联；scope='bot' 的行跨对话存活） | D81 |
| 以该对话为 A 侧或 B 侧的活动委派（`submitted` / `working`） | 落 `cancelled`（B 有活动 run 的先中止）；行保留 | D71 |
| 项目数据目录 `projects/{id}/`（项目 wiki git、wiki-store、`wiki.db`）与该项目的 wiki job | 删除（`lifecycle.deleteConversation`：先 `prepareProjectDeletion` 排空在途维护，再关 `wiki.db` 连接、`rmSync` 整目录；该会话的 jobs 已取消）；仅项目组会话 | D92 T1b |
| 各 Bot 个人 Wiki 中从该对话入库的资料 | **保留**（项目 wiki 随上一行删除） | — |

### 删除 Bot

管家（D70，`system_role = 'butler'`）不可删除；**项目组负责人不可删除**（D92 T1a，`PROJECT_LEAD_REQUIRED`）：`lifecycle.deleteBot` 在任何级联前拒绝并列出其领导的项目组（渲染层给「去更换」入口，`bots.deletionPreview.ledProjects`）。

| 数据 | 处理 | 阶段 |
|---|---|---|
| 该 Bot 所有正在执行、排队的执行 | 取消（任务经 `TaskHost.abortForBot` 结算为 `cancelled`，不唤醒） | P01 / D75 |
| bots 行 | 改为占位（见 bots 表说明） | P01 |
| 单聊对话 | `read_only = 1` | P01 |
| 项目组成员关系 | 删除成员行（历史消息保留，发送者显示为 id；其项目 wiki 来源保留，见下） | P05 / D92 |
| 该 Bot 的执行记录 | 删除 | P01 |
| `bots/{id}/` 整个目录（workspace、maintenance、memory.db、wiki、skills） | 删除 | P01 起，随各阶段补充 |
| 该 Bot 的浏览器会话分区 `$KEPCUP_HOME/browser/Partitions/bot-{id}`（Cookie/localStorage/缓存等全部会话数据） | 删除（`browser.clearBotData`：关闭页面 → 清分区存储 → 删分区目录，并 tombstone 该 Bot） | P11 |
| 该 Bot 的 approvals（待确认的先取消）、grants | 删除 | P03 |
| 该 Bot 的 agent_sessions（尽力 `session/delete`） | 删除 | D72 P5（`agentSessionsOnBotDeleted`；移出项目组同理 `agentSessionsOnProjectMemberRemoved`） |
| 该 Bot 在 skill_library 中引用的版本 | 移除 bot_skills 行；不再被任何 Bot **或 public_skills** 引用的库版本回收（公共技能不随单个 Bot 删除） | P08 |
| schedules、jobs | 删除 / 取消 | P10 |
| todos 中以该 Bot 为执行者 / 负责 Bot 的行 | **保留**（事项归用户所有）；对账退回 `draft` 并写 `blocked_reason`（「负责 Bot 已删除」）等用户改派；`todo_runs`、`memos` 不受影响 | D90 |
| watches（`watch_alert` 作业随 jobs 取消） | 删除 | D79 |
| mail_account_bots 中该 Bot 的绑定（`mail_accounts` 保留；`mail_alert` 作业随 jobs 取消） | 删除 | D84 |
| 涉及该 Bot 的 bot_handovers（来源 / 目标） | **保留**作历史；未执行的条目执行时因 Bot 已删除而跳过 | D88 |
| 该 Bot 的 widgets / widget_versions / widget_queries / widget_docs（D81） | 删除（`WidgetService.deleteForBot`；bots 行改占位，FK 不触发） | D81 |
| 该 Bot 在各项目 wiki 里的来源 | **保留**（台账 `createdBy` 仍是其 id，界面显示占位 id；仍由用户 / 负责人管理）；其排队中的 wiki job（含 `wiki_remove_source`）随 jobs 取消 | D92 T1b |
| 以该 Bot 为 A 或 B 的活动委派（`submitted` / `working`） | 落 `cancelled`（B 有活动 run 的先中止）；行保留 | D71 |
| 该 Bot 的 app_tool_grants（对话级与 Bot 级） | 撤销（写 `revoked_at`，行保留作审计；`AppToolGrants.revokeForBot`） | D73 P1 |
| 该 Bot 贡献的 profile_items | **保留** | — |
| usage_ledger | **保留**（用量统计） | — |

删除前的弹框需要列出：记忆条数、Wiki 页面数、Skills 数、workspace 数量与占用空间。

> **浏览器分区落点（P11 审查修复 BR-P11-005 时核实）**：浏览器会话数据实际落在
> `$KEPCUP_HOME/browser/Partitions/bot-{id}`（Electron 分区 `persist:bot-{id}`
> 的磁盘布局由 `app.setPath('sessionData', …)` 统一决定，Electron 不支持为单个
> 分区指定任意磁盘路径，故无法按早期设计落位到 `bots/{id}/browser/`）。两个后果：
> ①删除 Bot 的级联除 `bots/{id}/` 整目录外，还须删除对应的分区目录（上表 P11 行，
> `clearBotData` 实现，e2e「删除 Bot 后其浏览器分区数据不存在」覆盖）；②默认
> session（应用自身窗口的会话）的磁盘数据也随之迁到 `$KEPCUP_HOME/browser/`
> 根目录下（`setPath('sessionData')` 是全局的），该目录同时包含应用自身的会话缓存。

### 从项目组中移除 Bot

移除**负责人**被拒绝（D92 T1a）：`projects.removeMember` 与设置卡 `project.members` 同一道校验，提示「请先更换负责人」（`removeProjectMember` / `onProjectMemberRemoved` 钩子）。

| 数据 | 处理 | 阶段 |
|---|---|---|
| 该 Bot 在此项目组正在执行、排队的执行 | 取消（任务经 `TaskHost.abortForBotInConversation` 结算为 `cancelled`，不唤醒） | P05 / D75 |
| 该 Bot 在此项目组的 agent_sessions 行（含各任务的行） | 尽力 `session/delete` 并删除 | D72 P5 / D75 |
| 成员行 | 删除 | P05 |
| 该 Bot 在此项目组的 workspace | 删除 | P05 |
| 该 Bot 在此项目组的 grants、待确认 approvals | 撤销 / 取消 | P05 |
| 该 Bot 在此项目组的 app_tool_grants（Bot 级授权不受影响） | 撤销（`AppToolGrants.revokeForBotInConversation`） | D73 P1 |
| 该 Bot 在此项目组做出的承诺 | 置为 `void` | P07 |
| 该 Bot 在此项目组的 schedules | 取消（含以它为覆盖负责 Bot 的工作台排期；对应事项由对账退回 `draft`） | P10 / D90 |
| 该 Bot 在此项目组的 watches | 删除 | D79 |
| 该 Bot 排队中的项目 wiki 入库 job（`wiki_ingest`） | 取消（`jobs.cancelPendingByBotInConversation`，仅该对话）；**已入库来源保留**（执行者付费已支出） | D92 T1b |

### 撤回消息

| 数据 | 处理 | 阶段 |
|---|---|---|
| 消息正文、messages_fts | 清空 / 删除 | P01 |
| 只以该消息为证据的记忆与画像条目 | 置为 `retracted` | P07 |
| 该消息附件已入 Wiki 的原始资料 | 从 `raw/` 删除，登记 Wiki 体检任务 | P09 |

### 从最近列表移除 Workdir

| 数据 | 处理 | 阶段 |
|---|---|---|
| workdirs 行、run_changes、影子仓库目录 | 删除（workdir 目录中的文件不动） | P04 |
| 绑定了该 workdir 的对话 | `workdir_id` 置空，插入系统消息 | P04 |
