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
| runs | `0009_tool_effects.sql` | D78（borrowings W2）：新表 `tool_effects`；`runs` 增索引 `runs_by_parent` |
| main | `0021_delegation_intent.sql` | D71 修订（borrowings W6）：`delegations` 重建（status 增 `awaiting_tasks`，增 `intent`、`task_ids_json`，增索引 `delegations_status`） |
| main | `0022_schedule_title_origin.sql` | D80：`schedules` 增 `title`、`origin` |
| main | `0023_watches.sql` | D79（borrowings W7）：新表 `watches` |
| main | `0024_app_connections.sql` | D73 P0：新表 `app_connections`（含部分唯一索引）、`oauth_clients`；D73 后续迁移（P2 起）顺延取号 |
| main | `0025_app_tools.sql` | D73 P1：新表 `app_connection_tools`（工具定义锁定）、`app_tool_grants`（写工具持续授权）；`app_connections` 增 `baseline_pending`（测试用 `mainVersionsAfter()` 取「某版本之后的全部 main 迁移」，新增迁移不必改老测试） |
| main | `0026_egress_approval.sql` | D73 P2：`approvals` 重建（kind 增 `egress`，带全现有 kind）、新表 `app_taint`（污点状态） |

  D73（连接应用）原预留的 main `0018`–`0020` 因此顺延；main `0021`、runs `0009` 又被 borrowings W6 / W2 占用，main `0022` / `0023` 又被 D80 / W7 占用，D73 从 main 的下一个空号起编号（不改 runs 库，以目录实况为准）。

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

外部智能体（D72，design/28）在同一设置 JSON 中增加：`agents`（目录 id → `{enabled, installedVersion?, source: 'managed'|'system', loadUserConfig}`，本机启用状态；P1 只用 `enabled`）、`customAgents`（自定义目录条目，预留，本期不读取）、`experimental.externalAgents`（实验开关，默认 `false`；关时 RPC 拒绝把 Bot 设为外部 Agent）、`backgroundAgentId?`（P6：无内置模型时后台 loop 选用的 Agent；缺省 / '' = 自动——只用该 Bot 自己的 Agent，不换用别家；画像整理 / 群聊摘要只在明确指定时运行）、`backgroundTasks`（P6：`{agentEnabled=true（false = 后台任务不用 Agent，照旧跳过）, agentSkillAuthoring=false, groupMentionOnly=true（经 Agent 的群聊判断需用户关掉此项）}`；`settings.update` 部分 patch 合并）。均在设置 JSON 行内，无迁移。Agent 并发不另设字段，沿用 `providerConcurrency['agent:{id}']`。

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
  id                TEXT PRIMARY KEY,     -- conv_...
  type              TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  title             TEXT,                 -- 群聊名称；单聊为空（显示 Bot 名称）
  description       TEXT,                 -- 群定位（本群主要处理什么事务，19/D60）；单聊为空
  direct_bot_id     TEXT REFERENCES bots(id),
  project_id        TEXT,                 -- P04 起使用
  read_only         INTEGER NOT NULL DEFAULT 0,
  setup_state       TEXT,                 -- 'creating' = 群创建问答进行中（19/D60）
  summary           TEXT,                 -- 滚动摘要
  summary_upto_seq  INTEGER NOT NULL DEFAULT 0,
  last_seq          INTEGER NOT NULL DEFAULT 0,
  last_read_seq     INTEGER NOT NULL DEFAULT 0,
  last_message_at   INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX conversations_one_direct_per_bot
  ON conversations(direct_bot_id) WHERE type = 'direct' AND read_only = 0;
```

- `description` 与 `setup_state` 为 19/D60 增量（迁移 `0014_conversation_setup.sql`）：`description` 注入群聊 `<conversation_info>`；`setup_state='creating'` 的群输入禁用、成员作答即写行、完成（`finalizeSetup`）时与 title/description 一起生效。
- 放弃创建 = 物理删除该对话，走既有删除级联（此时仅有消息与成员行）。

删除对话是**物理删除**（连同级联数据）；对话 id 为 ULID，不会复用。

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
- 私有任务条目（D75，[design/30](../design/30-supervisor-and-tasks.md) §2.4）：`kind = 'task_event'`、`sender_type = 'system'`、`owner_bot_id` = 任务所属 Bot，内容 `{ taskId, phase: brief | inject | cancel | question | result | failure, text, sourceMessageIds?, status?, error?, delivery?, questionMessageId?, title?, writes?, continuesTaskId?, deliveries? }`（`deliveries`：终态条目被投递给对话轮的次数，宿主用 `json_set` 计数，达到 `TASK_REDELIVER_MAX_ATTEMPTS` 放弃，审查批 E）。写入走 `MessagesService.appendTaskEvent`：终态 phase（`result` / `failure`）撞唯一索引不报错，返回已存条目（`created: false`）。正文照常写 `messages_fts`（FTS 表结构不变，按视角过滤在查询时 join `messages.owner_bot_id`）。用户可见读路径（`isVisibleToUser` / `listVisible`）排除 `task_event` 与 `owner_bot_id` 非空的行。
- 任务发出的可见中间说明：`text` 消息，`content_json` 带 `origin: 'task'` + `taskId`（照 D71 `origin: 'delegation'` 的先例，免加列）；`forward_task_result` 原文转发的结果是同形的 Bot 消息（`run_id` = 发起转发的对话轮，用以判定「已转发过」）。
- 任务卡（D75 W3）：共享的 `card` 行，`content_json = { cardType: 'task', runId: <任务 id> }`，`task_id` = 任务；`start_task` 与失败任务的重试各写一张。上下文中渲染为一行状态（[design/30](../design/30-supervisor-and-tasks.md) §4.3）。
- MCP Apps 卡（D73 P3，`cardType: 'mcp_app'`）：共享的 `card` 行，`content_json = { cardType: 'mcp_app', appUi: {…} }`，`appUi` 是描述符（server id、`ui://` URI、工具名、脱敏并截断后的入参 / 结果，入参 ≤ 16 KiB、结果 ≤ 64 KiB 字符，超出丢弃并标记 truncated），**不含 HTML 与令牌**；页面 HTML 只在 core 内存里的一次性资源（128 位随机 id，≤ 64 条、30 分钟滑动 TTL），不落库。上下文中渲染为一行固定文案。
- 任务问题卡（`ask_user`）：共享的 `system_event` 行，`event = 'task_question'`，`content_json` 带 `text`（问题）、`options`、`taskBotId`（提问任务所属的 Bot；上下文渲染为「Bot（任务 t）向用户提问」并包 `<untrusted>`），回答后写入 `answer`（超时为「（超时未回答）」，提问失败作废为「（提问没有成功，问题作废）」）；`task_id` 与 `run_id` = 任务。
- 结果放弃提示：共享的 `system_event` 行，`event = 'task_result_undelivered'`，`task_id` / `run_id` = 任务；用户可见，Bot 上下文渲染为固定文案（不含任务标题）。
- `MessagesService` 的读法（D75 W1-B）：`listForBot(conversationId, botId)`（共享行 + 该 Bot 的私有行，Bot 上下文）、`listShared`（只共享行：任务的对话层、摘要）、`search(…, viewerBotId)`（FTS join `messages` 按 owner 过滤）、`around`（前后各 N 条可见行）、`unsummarized`（只摘共享行）、`countVisibleAfter`（未读只数用户可见行）；`terminalTaskEvent(taskId)` / `taskEvents(taskId)` 只查 `kind = 'task_event'`。私有行推进对话的 `last_seq`，不推进 `last_message_at`。
- 0018 重建方式：`messages` 被 `attachments.message_id`（`ON DELETE CASCADE`）引用，迁移又在 `foreign_keys=ON` 的事务内执行，直接 `DROP TABLE messages` 会级联删光附件；因此 `attachments` 一并重建（先建两张新表并复制，先删旧 `attachments` 再删旧 `messages`，再改名——外键开启时改名会同步改写引用）。表结构与本节 / 下节一致。

### attachments（P01；D75 迁移 0018 随 messages 重建，结构不变）

```sql
CREATE TABLE attachments (
  id               TEXT PRIMARY KEY,      -- att_...
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       TEXT REFERENCES messages(id) ON DELETE CASCADE,
  draft_id         TEXT,                  -- 仍在待发送队列时
  file_name        TEXT NOT NULL,
  mime             TEXT NOT NULL,
  size             INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  rel_path         TEXT NOT NULL,         -- 相对 conversations/{id}/attachments/
  created_at       INTEGER NOT NULL
);
```

P17（D61）语义增补：`draft_id` 预挂经 `drafts.add` 的 `attachmentIds` 绑定（校验归属对话且无主）；`attachments.detach` 仅允许移除草稿阶段附件（行与文件一起删）；`drafts.remove` 级联清理仍挂在草稿上的附件；flush 时 `attachToMessage` 转正不变。

### drafts（P01）

```sql
CREATE TABLE drafts (
  id               TEXT PRIMARY KEY,      -- drf_...
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  text             TEXT NOT NULL,
  mentions_json    TEXT NOT NULL DEFAULT '[]',
  reply_to         TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
```

### jobs（P01）

持久化的后台任务队列。

```sql
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,            -- conversation_summary | reflection | memory_consolidation | profile_curation
                                          -- | wiki_ingest | wiki_lint | skill_authoring | schedule_fire | watch_alert ...
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

启动时把 `running` 改回 `pending`（`attempts + 1`）；超过 3 次标记为 `failed`。

### usage_ledger（P01）

```sql
CREATE TABLE usage_ledger (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  bot_id          TEXT,
  conversation_id TEXT,
  loop_type       TEXT NOT NULL,         -- 与 runs.loop_type 同值（turn / task / subagent / triage / …；main 0020 已把旧的 response 改为 turn）
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

### approvals（P03；P08 审查修复 BR-P08-004 增补终态 failed；D72 迁移 0017 增 agent_tool；D73 迁移 0026 增 egress）

```sql
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,       -- apr_...
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'skill_preset',
                    'profile_change', 'mcp_tool', 'butler_proposal',
                    'agent_tool', 'egress')),
  bot_id          TEXT,
  conversation_id TEXT,
  run_id          TEXT,
  payload_json    TEXT NOT NULL,          -- 各类请求的内容（路径、命令、原因……）
  status          TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'failed')),
  decision_json   TEXT,                   -- 例如 { duration: 'once' | 'conversation' } / { error: '…' }
  auto_approved   INTEGER NOT NULL DEFAULT 0,  -- 无人值守模式自动批准
  message_id      TEXT,                   -- 对话中的卡片消息
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);
CREATE INDEX approvals_pending ON approvals(status, conversation_id);
```

`skill_preset`（P19/D63）：payload `{presetId, name, displayName, summary, version, missingDeps}`——`install_skill` 的预置轻授权卡；`skill_import` 既有 payload（P08）不变，工具路径复用同一 kind（阻塞审批）。无人值守模式下两者同属自动批准类。

`butler_proposal`（D70，迁移 0016 重建表加入 CHECK）：payload 以 `proposalType: 'team' | 'bot' | 'group'` 区分（见 `butlerProposalPayloadSchema`）；非阻塞提交、管家 run 结束不取消、**无人值守不自动批准**；`decision_json` 可带 `selection`（用户保留的条目下标）。

`agent_tool`（D72 P3，迁移 `0017_external_agents.sql` 重建表加入 CHECK）：外部智能体原生工具的权限请求（ACP `session/request_permission` 经权限桥分级后需要用户确认的部分）。payload 见 `agentToolApprovalPayloadSchema`：`{agentId, agentName, title, kind: 'read'|'write'|'execute'|'other'|'config', toolKind, access?, locations[]（已解析绝对路径）, command?, cwd, options[]（Agent 提供的选项，仅展示 / 审计）, durations, reason, sensitive, exemptDirs, projectPath?, configHash?}`。路径类（read / write）`durations` 含 `conversation`，批准后按 `decision_json.duration` 记 grants（与 access 同语义）；命令 / 其他只有「仅这一次」（`approvals.decide` 把越权的 conversation 降为 once）。子类型 `kind: 'config'`：project 内 Agent 侧配置文件（Provider 的 `agentSideConfigFiles`）首次运行前的确认，批准后按（对话、Bot、Agent、project 路径、配置内容哈希 `configHash`）记住，无人值守的自动批准不算（`approvedAgentConfigs` 以 `json_extract(payload_json,'$.kind')='config'` 定向查询）。无人值守：自动批准并审计，但并入数据目录底线——`command` 文本或 `locations` 触及数据目录（`exemptDirs`＝本 run 的 workspace 与技能目录除外）则自动拒绝（`agentToolTouchesDataDir`：相对 token 按 `cwd` 解析，cwd 本身也检查）；`kind:'other'` 与无 locations 的 write 一律自动拒绝（`agentToolUnattendedRefusal`）。

`egress`（D73 P2，迁移 `0026_egress_approval.sql` 重建表加入 CHECK）：污点期间（见 `app_taint`）外发通道的逐次确认，payload `{channel: 'web_fetch'|'web_search'|'browser'|'app_tool'|'mcp_tool'|'bash'|'git_remote'|'watch', target, summary, taintedSince?}`——`target` 是外发内容全文（URL / 查询词 / 命令 / 工具名 + 参数 JSON，脱敏后最多 `EGRESS_TARGET_MAX_CHARS`），卡片完整展示；时长只有 `once`（`decide()` 把 `conversation` / `bot` 降为 once；payload 不带 `durations`）。网关 `egressCheck` 发起：应用 / 自定义 MCP 非只读且 `openWorldHint !== false` 的工具（持续授权与 `auto` 策略在污点期间不起作用：本会免卡的调用改弹 `egress` 卡；本来就要弹 `mcp_tool` 卡的调用不叠第二张——该卡 payload 带 `tainted: true` / `taintedSince` 并展示完整参数 `argsFull`）、`web_fetch` / `web_search`、浏览器 `browser_open` 与点击按钮 / 链接 / 按 Enter、沙箱 `bash`（Bot `network_policy === 'open'`）、`watch_create`（网页监看，创建时与之后每个间隔都会用 Bot 的浏览器资料访问该 URL）；ACP 权限桥对 fetch 类与 agent 沙箱内自动放行的命令也发该卡。`git_remote`、确认模式的 `command` 卡与上述 `mcp_tool` 卡不新增 kind，payload 带 `tainted: true`（`git_remote` / `mcp_tool` 另带 `taintedSince`），卡片附加提示。对话轮 / 子代理不等待审批（D75）：非无人值守时直接失败并引导 `start_task`。无人值守按 D41 自动批准，另写审计 `egress_tainted`（`{approvalId, kind, channel, target(≤1000), approved, via}`），Bot 详情经 RPC `apps.egressSummary` 汇总。

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

### projects（P04）

```sql
CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,   -- prj_...
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
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT,
  before_oid      TEXT NOT NULL,          -- 影子仓库中的提交
  after_oid       TEXT,
  files_json      TEXT,                   -- [{ path, change: 'added'|'modified'|'deleted', beforeOid?, afterOid?, interleaved? }]
  reverted_at     INTEGER,
  created_at      INTEGER NOT NULL
);
```

- 一个 run 多次持有租约（D75 审查批 E：被强制收回后不钉住的执行再次写入）时记录**累积**：`before_oid` 是第一个窗口前、`after_oid` 是最后一个窗口后；跨窗口的文件带各自的 `beforeOid`（run 第一次改它之前）/ `afterOid`（run 最后一次改它之后），净改动按两端内容重算；别人在 run 的两个窗口之间改过的文件标 `interleaved`，回退时按冲突处理。回退按文件恢复 `beforeOid ?? before_oid`、冲突检测比对 `afterOid ?? after_oid`；diff 按文件取各自区间。重新记录已回退的 run 时清空 `reverted_at`。

### chains（P05）

```sql
CREATE TABLE chains (
  id              TEXT PRIMARY KEY,       -- chn_...
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_batch_id   TEXT NOT NULL,
  max_depth_seen  INTEGER NOT NULL,
  tokens_used     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
```

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

### schedules（P10）

```sql
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,       -- sch_...
  bot_id          TEXT NOT NULL,
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
                  CHECK (origin IN ('tool', 'offer', 'proposal', 'commitment'))
);
CREATE INDEX schedules_next ON schedules(status, next_fire_at);
```

D80 的回执卡（`schedule_created`）与提议卡（`schedule_offer`）是 messages 里的 system_event，内容 JSON 带 `schedule` 快照 / `offer`（`status`：pending / accepted / declined / superseded / expired），不另建表；拒绝退避按 `offer.decidedAt` 在 7 天窗口内计数。

### watches（D79，borrowings W7，main 0023）

确定性监看：宿主按 `next_check_at` 用 Bot 的后台页检查网页，条件边沿触发才唤醒 Bot（[design/02 §网页监看](../design/02-execution.md#网页监看d79)）。

```sql
CREATE TABLE watches (
  id              TEXT PRIMARY KEY,       -- wat_...
  bot_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_json     TEXT NOT NULL,          -- 本轮仅 {kind:'web_page', url, selector?}（zod 只接受 web_page）
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

- 计划稿的列之外增加了 `last_text`（没有上一版文本就做不出增删改摘要）、`last_error` / `last_checked_at`（列表与暂停卡展示）、`alert_times_json`（`WATCH_MAX_ALERTS_PER_DAY` 滚动 24 小时提醒上限：超出的边沿不唤醒，同一事务改 `paused` + 暂停卡）。
- 读行时 `source_json` / `condition_json` 用 zod `safeParse`：解析不了的行在列表 / 上下文里跳过并记日志；到期查询遇到它时直接改 `paused`（`last_error` 说明记录损坏），避免永远到期、空转 worker；删除级联按 SQL 一并删除。
- 边沿提醒与 `alert_seq + 1` 在同一事务里登记 `watch_alert` 作业（`jobs.dedupe_key = watch:{id}:{seq}:{hash}`）；提醒卡与暂停卡是 messages 里的 card（`cardType: 'watch'`，内容带 `watchId` / `watchEvent`（created / alert / paused）/ `watchSeq` / `watchKey` / `watchSummary`，暂停卡另带 `watchPauseReason`（`failures` / `too_frequent`）与 `watchFailures`（暂停时的连续失败次数）），不另建表；唤醒 Bot 的是内部 system_event `watch_alert`（文本以「监看提醒（{id}，第 {seq} 次）」开头，作业重跑据此判断唤醒是否已记录）。
- `stopped` 行保留（不出现在列表里）；删除对话 / Bot、移出群时删除。

### delegations（D71；W6 main 0021 重建）

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
- W6（0021）：`awaiting_tasks` = `request` 的委派轮结束时派出了任务（runs.db `origin_run_id` = `run_id`），等这些任务（`task_ids_json`，顺着续接链更新）结算，结果取各任务结果摘要拼接；`fyi` 投递即 `completed`（`result_excerpt` / `result_card_id` 为空）。

### app_connections（D73 P0，迁移 0024）

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
- P1（迁移 0025）追加列 `baseline_pending INTEGER NOT NULL DEFAULT 0`（见下节）。非 OAuth 的自定义 server 也建 `custom:{serverId}` 行承载工具锁定：`server_url` 可为 NULL（stdio），`status = 'connected'`（无需授权；`apps.connections.list` 默认不返回 `custom:` 行）。

### app_connection_tools / app_tool_grants（D73 P1，迁移 0025）

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

### app_taint（D73 P2，迁移 0026）

污点状态（[design/29](../design/29-connected-apps.md) §8.3 / §12；`core/apps/taint.ts` 的 `TaintService`）：某 Bot 在某对话里**成功读取过目录应用（`conn_…`）的工具结果**后置位，之后 24 小时（`APP_TAINT_TTL_MS`）内该 (Bot, 对话) 的外发通道降级为逐次确认（`egress` 审批）。每次成功读取续期（`first_at` 在未过期时保持，过期后重新开始）；按 (Bot, 对话) 计而不按 run 计，`runs.retry`、后续对话轮与任务共用同一行。自定义 MCP 工具**不是来源**（只是通道）。`settings.apps.taintGuard`（默认 true，设置「无人值守 / 高级」）关闭时仍置位、只是不再拦截。

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

不设外键 / CASCADE：对话删除时 `domain/lifecycle.ts` 删掉该对话的全部行，Bot 删除时只删它自己私聊里的行（群聊里的行保留到过期——群里其他成员读到过它的输出）；其余遗留行由 `sweepExpired()`（启动时与每次置位时）清理。

**判定粒度与跨 Bot 传递**：外发拦截按**对话**判定（`TaintService.guard` = 该对话里任一 Bot 的行未过期）——群聊里 Bot B 读到 Bot A 的输出时不能把污点「洗掉」；私聊只有一个 Bot，与按 (Bot, 对话) 等价。跨对话的交接由 `TaintService.inherit` 传递：委派投递（`delegations` 转 `working`）把 A 对话的污点带到 B 的私聊，B 的结果贴回（转 `completed`，非 `fyi`）再把 B 私聊的污点带回 A 的对话；继承保留来源的 `first_at`，`expires_at` 取较晚者（不因传递而延长）。接线在 `DelegationsService.onMoved`（`start.ts`）。

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
- 删除对话 / 删除 Bot / 移出群经 `lifecycle` 清理（下方删除级联表）；停用 / 卸载 Agent 不删行：进程随之停止，保留的会话随进程失效，下次启用后按窗口与指纹 resume / load 或新建。

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
  trigger_reason       TEXT,              -- direct | mention | broadcast | reply | chain | scheduled | event | background | delegation | task（D75：任务结算唤醒对话轮）
  trigger_message_ids_json TEXT NOT NULL DEFAULT '[]',
  chain_id             TEXT,
  chain_depth          INTEGER,
  provider             TEXT,
  model                TEXT,
  output_message_ids_json TEXT NOT NULL DEFAULT '[]',
  summary              TEXT,
  continued_from_run_ids_json TEXT,    -- 续接来源 run id 列表（Loop 续接，design/02）；null＝无续接
  error_json           TEXT,           -- {message, setup?, reason?}：setup 为结构化的「设置前置需求」（design/18），仅因缺设置失败时非空；reason 为机器可读原因（D78：`permission_revoked`，`Run.errorReason`）
  parent_run_id        TEXT,           -- 0004：SubAgent 子 run 的委派方 run（D66/D67）；其余为 null
  engine               TEXT NOT NULL DEFAULT 'builtin', -- 0005：执行引擎 'builtin' | 'agent:{id}'（D72）
  agent_session_id     TEXT,           -- 0005：外部 Agent 侧的 ACP sessionId；内置引擎为 null
  task_title           TEXT,           -- 0006（D75）：任务标题；以下任务列在非任务 run 上为 null / 0
  task_writes          INTEGER,        -- 0006：1 = 写任务，0 = 只读任务
  task_workdir         TEXT,           -- 0006：解析后的任务工作目录
  origin_run_id        TEXT,           -- 0006：派出该任务的对话轮
  result_consumed_at   INTEGER,        -- 0006：任务结果被对话轮消费的时间（design/30 §3.2）
  awaiting_input       INTEGER NOT NULL DEFAULT 0, -- 0006：running 下等待用户输入（design/30 §2.4.6）
  trigger_parts_json   TEXT,           -- 0008：对话轮触发批的各来源段 [{reason, messageIds, extraAttributes?}]；NULL = 旧行或单段批
  retry_of_run_id      TEXT,           -- 0008：重试出来的对话轮指向被重试的那一轮
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
- 对话轮：`trigger_parts_json` 让重试按来源段重建合并批（各段保留自己的 reason 与属性，`RunsService.triggerPartsOf`）；`runs.setTrigger` 在对话轮开始执行、吸收缓冲批后更新触发记录（吸收了 @ 连锁批时一并写 `chain_id` / `chain_depth`，审查批 E）。`retry_of_run_id`（`RunsService.retryOfRunId`）：重试出来的对话轮派出的任务，与被重试那一轮（及更早的重试链）派出的同名任务视为同一个，不重复派出。
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

- 浏览器敏感输入（D77）：`browser_type` 声明 `sensitive` 或命中密码框时，tool_call 步骤的 `text` 写成 `«redacted:N chars»`（执行中才发现的密码框经 `RunsService.replaceStepPayload` 改写已落盘的那条 tool_call），该值登记为本 run 的敏感值，之后落盘的各类步骤里出现的原文替换为 `«redacted»`（`agent/step-persistence.ts` 的按工具参数脱敏表）。浏览器动作的 tool_result payload 带 `outcome`（`not_started` / `completed` / `uncertain`，旧行没有）；台账结为 uncertain 而工具未给出结局的调用，宿主补 `outcome:'uncertain'`。

### tool_effects（D78，runs 0009）

外部副作用台账（[design/24 §10](../design/24-durable-execution.md#10-第一步外部副作用台账d78已实现)）：有外部副作用（`external`）的工具调用执行前写一行、结束后结。只读与本地可撤销的调用不记，沙箱内命令不记。

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
  receipt_json  TEXT,                            -- 工具自报回执 {url?, externalId?, note?}（目前无工具填写）
  created_at    INTEGER NOT NULL,
  settled_at    INTEGER,
  UNIQUE (run_id, tool_call_id)
);
CREATE INDEX tool_effects_by_run ON tool_effects(run_id, created_at);
CREATE INDEX tool_effects_by_key ON tool_effects(effect_key);
```

- 写入：`agent/effects/recorder.ts`（`executeToolSafely` 的可选记录器，内置引擎与外部智能体宿主桥共用）；确认模式下批准的 `bash` 命令只在网关决定沙箱外执行时经 tool-call scope 的 `escalate` 才写行；`request_unsandboxed` 在 `agent/effects/classify.ts` 归 `external`，审批前就写行，被拒结为 `denied`。审批经 `noteApproval` 回填 `approval_id`（只认同一 run、仍在 `executing` 的行）。记录器出错只记日志。
- `occurrence` 在写入事务里按（run、工具、`args_hash`）计数。`settle` 只改 `executing` / `uncertain` 行；`intended` 预留未用。
- 恢复：`ToolEffectsStore.markExecutingUncertain()`（启动恢复第 0 步，全表；撤销授权中断时按 run 列表）；`settleUnapproved(runIds, approvalIds)` 把审批被取消的 `executing` 行结为 `denied`。
- 读取：`listForRun`、`listForRuns`、`chainRunIds(taskId)` / `listForTask(taskId)`（沿 `continued_from_run_ids_json` 向前追溯，并带上各 run 的 `parent_run_id` 子 run）；RPC `effects.list({ taskId })`。

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
  evidence_json   TEXT NOT NULL,          -- [{ messageId, conversationId, runId }]
  origin          TEXT NOT NULL CHECK (origin IN ('private', 'group')),
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

- `void`：承诺因对话删除或 Bot 被移出群而作废。

### wiki_fts（P09）

```sql
CREATE VIRTUAL TABLE wiki_fts USING fts5(
  segmented_text, page_path UNINDEXED, title UNINDEXED, tokenize = 'unicode61'
);
```

每次 Wiki 维护提交后，按变更的页面增量更新（提交 diff 中被删除的页面同步移除索引行）；界面删除页面走同一条提交通道，`wiki.rollback` 与启动对账则全量重建。

## 删除级联

**每个阶段引入新数据时，必须在该阶段内把清理逻辑接入下表对应的操作，并补充测试。** 清理逻辑集中在 `core/src/domain/lifecycle.ts`。

### 删除对话

| 数据 | 处理 | 阶段 |
|---|---|---|
| messages、messages_fts、attachments（含文件）、drafts | 删除 | P01 |
| conversation_members、conversations 行 | 删除 | P01 |
| 该对话的执行（runs、run_steps） | 删除；正在执行的先取消 | P01 |
| 该对话的任务（D75） | 未结束的经 `TaskHost.abortForConversation` 结算为 `cancelled`（不唤醒），随后按上行删除；私有任务条目随 messages 删除 | D75 |
| agent_sessions 中该对话的任务会话行（一对话可有多行） | 同下行，逐行处理 | D75 |
| 该对话的 jobs | 取消 | P01 |
| 所有 Bot 在该对话的 workspace 目录 | 删除 | P02 |
| 该对话的 approvals（待确认的先取消）、grants | 删除 | P03 |
| app_tool_grants 中该对话的行 | 随外键 `ON DELETE CASCADE` 删除 | D73 P1 |
| agent_sessions（外部智能体会话行；尽力 `session/delete`，Agent 自己目录里的 transcript 不清理） | 删除 | D72 P5（`Orchestrator.agentSessionsOnConversationDeleted`） |
| run_changes | 删除（project 文件与影子仓库不动） | P04 |
| chains | 删除 | P05 |
| 各 Bot 记忆中 `origin_conversation_id` 为该对话的承诺 | 置为 `void` | P07 |
| schedules | 删除 | P10 |
| watches | 删除 | D79 |
| 以该对话为 A 侧或 B 侧的活动委派（`submitted` / `working`） | 落 `cancelled`（B 有活动 run 的先中止）；行保留 | D71 |
| Wiki 中从该对话入库的资料 | **保留** | — |

### 删除 Bot

管家（D70，`system_role = 'butler'`）不可删除：`lifecycle.deleteBot` 在任何级联前拒绝。

| 数据 | 处理 | 阶段 |
|---|---|---|
| 该 Bot 所有正在执行、排队的执行 | 取消（任务经 `TaskHost.abortForBot` 结算为 `cancelled`，不唤醒） | P01 / D75 |
| bots 行 | 改为占位（见 bots 表说明） | P01 |
| 单聊对话 | `read_only = 1`，清空其待发送队列 | P01 |
| 群成员关系 | 删除成员行（历史消息保留，发送者显示为 id） | P05 |
| 该 Bot 的执行记录 | 删除 | P01 |
| `bots/{id}/` 整个目录（workspace、maintenance、memory.db、wiki、skills） | 删除 | P01 起，随各阶段补充 |
| 该 Bot 的浏览器会话分区 `$KEPCUP_HOME/browser/Partitions/bot-{id}`（Cookie/localStorage/缓存等全部会话数据） | 删除（`browser.clearBotData`：关闭页面 → 清分区存储 → 删分区目录，并 tombstone 该 Bot） | P11 |
| 该 Bot 的 approvals（待确认的先取消）、grants | 删除 | P03 |
| 该 Bot 的 agent_sessions（尽力 `session/delete`） | 删除 | D72 P5（`agentSessionsOnBotDeleted`；移出群同理 `agentSessionsOnGroupMemberRemoved`） |
| 该 Bot 在 skill_library 中引用的版本 | 移除 bot_skills 行；不再被任何 Bot **或 public_skills** 引用的库版本回收（公共技能不随单个 Bot 删除） | P08 |
| schedules、jobs | 删除 / 取消 | P10 |
| watches（`watch_alert` 作业随 jobs 取消） | 删除 | D79 |
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

### 从群中移除 Bot

| 数据 | 处理 | 阶段 |
|---|---|---|
| 该 Bot 在此群正在执行、排队的执行 | 取消（任务经 `TaskHost.abortForBotInConversation` 结算为 `cancelled`，不唤醒） | P05 / D75 |
| 该 Bot 在此群的 agent_sessions 行（含各任务的行） | 尽力 `session/delete` 并删除 | D72 P5 / D75 |
| 成员行 | 删除 | P05 |
| 该 Bot 在此群的 workspace | 删除 | P05 |
| 该 Bot 在此群的 grants、待确认 approvals | 撤销 / 取消 | P05 |
| 该 Bot 在此群的 app_tool_grants（Bot 级授权不受影响） | 撤销（`AppToolGrants.revokeForBotInConversation`） | D73 P1 |
| 该 Bot 在此群做出的承诺 | 置为 `void` | P07 |
| 该 Bot 在此群的 schedules | 取消 | P10 |
| 该 Bot 在此群的 watches | 删除 | D79 |

### 撤回消息

| 数据 | 处理 | 阶段 |
|---|---|---|
| 消息正文、messages_fts | 清空 / 删除 | P01 |
| 只以该消息为证据的记忆与画像条目 | 置为 `retracted` | P07 |
| 该消息附件已入 Wiki 的原始资料 | 从 `raw/` 删除，登记 Wiki 体检任务 | P09 |

### 从最近列表移除 Project

| 数据 | 处理 | 阶段 |
|---|---|---|
| projects 行、run_changes、影子仓库目录 | 删除（project 目录中的文件不动） | P04 |
| 绑定了该 project 的对话 | `project_id` 置空，插入系统消息 | P04 |
