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

外部智能体（D72，design/28）在同一设置 JSON 中增加：`agents`（目录 id → `{enabled, installedVersion?, source: 'managed'|'system', loadUserConfig}`，本机启用状态；P1 只用 `enabled`）、`customAgents`（自定义目录条目，预留，本期不读取）、`experimental.externalAgents`（实验开关，默认 `false`；关时 RPC 拒绝把 Bot 设为外部 Agent）、`backgroundAgentId?`（P6：无内置模型时后台 loop 选用的 Agent）。Agent 并发不另设字段，沿用 `providerConcurrency['agent:{id}']`。

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

### messages（P01）

```sql
CREATE TABLE messages (
  id               TEXT PRIMARY KEY,      -- msg_...
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  sender_type      TEXT NOT NULL CHECK (sender_type IN ('user', 'bot', 'system')),
  sender_bot_id    TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('text', 'system_event', 'card')),
  content_json     TEXT NOT NULL,         -- text: { text }；card: { cardType, approvalId? ... }；system_event: { event, ... }
  reply_to         TEXT,
  mentions_json    TEXT NOT NULL DEFAULT '[]',   -- 被 @ 的 bot id 列表（结构化，不从文本解析）
  batch_id         TEXT,                  -- 同一次发出的一批用户消息共享
  run_id           TEXT,                  -- Bot 消息所属的执行
  status           TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'recalled', 'edited')),
  edited_at        INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_conv_seq ON messages(conversation_id, seq);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  segmented_text, message_id UNINDEXED, conversation_id UNINDEXED, tokenize = 'unicode61'
);
```

- 撤回：`status = 'recalled'`，清空正文，从 `messages_fts` 删除；Bot 不可见。
- 编辑：更新正文与 `edited_at`，`status = 'edited'`，同步更新 `messages_fts`。

### attachments（P01）

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
                                          -- | wiki_ingest | wiki_lint | skill_authoring | schedule_fire ...
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
  loop_type       TEXT NOT NULL,
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

### approvals（P03；P08 审查修复 BR-P08-004 增补终态 failed；D72 迁移 0017 增 agent_tool）

```sql
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,       -- apr_...
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'skill_preset',
                    'profile_change', 'mcp_tool', 'butler_proposal',
                    'agent_tool')),
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
  files_json      TEXT,                   -- [{ path, change: 'added'|'modified'|'deleted' }]
  reverted_at     INTEGER,
  created_at      INTEGER NOT NULL
);
```

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
  created_at      INTEGER NOT NULL
);
CREATE INDEX schedules_next ON schedules(status, next_fire_at);
```

### delegations（D71）

```sql
CREATE TABLE delegations (
  id                    TEXT PRIMARY KEY,       -- dlg_...
  from_bot_id           TEXT NOT NULL,
  to_bot_id             TEXT NOT NULL,
  from_conversation_id  TEXT NOT NULL,
  to_conversation_id    TEXT,                   -- B 私聊；投递时解析
  task_text             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
                          'submitted', 'working', 'completed', 'failed', 'cancelled')),
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
  updated_at            INTEGER NOT NULL
);
CREATE INDEX delegations_to_bot_status ON delegations(to_bot_id, status);
CREATE INDEX delegations_run ON delegations(run_id);
CREATE INDEX delegations_from_conversation ON delegations(from_conversation_id);
```

- 对话 / 消息 / run 只存 id，不加外键：对话删除时委派行保留，由 `lifecycle` 终态化（见删除级联表）。
- `submitted` = 行已写、尚未向 B 投递（等 B 邮箱空闲 / 免打扰结束）；`working` = 代发消息已落 B 私聊、`run_id` 已回填。

### agent_sessions（D72，迁移 0017；P5 起使用）

```sql
CREATE TABLE agent_sessions (
  id                TEXT PRIMARY KEY,     -- ags_...
  bot_id            TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  agent_id          TEXT NOT NULL,        -- 目录 id（如 claude-acp）
  agent_session_id  TEXT NOT NULL,        -- Agent 侧 ACP sessionId
  fingerprint       TEXT NOT NULL,        -- 会话级参数指纹（提示词 / 能力集合 / 桥名 / 档位…），变化即新建
  last_run_id       TEXT,
  last_used_at      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX agent_sessions_key ON agent_sessions(bot_id, conversation_id, agent_id);
```

- 外部智能体会话复用（design 28 §7）：每个 (Bot, 对话, Agent) 至多一行。只存 id、无外键 / CASCADE。
- P3 只建表、尚无写入方；P5 接入会话复用时须同时把「删除对话 / 删除 Bot / 停用或卸载 Agent」的清理接入 `lifecycle`（下方删除级联表）。

## runs.db

### runs（P01）

```sql
CREATE TABLE runs (
  id                   TEXT PRIMARY KEY,  -- run_...
  bot_id               TEXT,
  conversation_id      TEXT,
  loop_type            TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
                         'queued', 'running', 'waiting_approval', 'waiting_lease',
                         'completed', 'failed', 'cancelled', 'interrupted')),
  trigger_reason       TEXT,              -- direct | mention | broadcast | reply | chain | scheduled | event | background
  trigger_message_ids_json TEXT NOT NULL DEFAULT '[]',
  chain_id             TEXT,
  chain_depth          INTEGER,
  provider             TEXT,
  model                TEXT,
  output_message_ids_json TEXT NOT NULL DEFAULT '[]',
  summary              TEXT,
  continued_from_run_ids_json TEXT,    -- 续接来源 run id 列表（Loop 续接，design/02）；null＝无续接
  error_json           TEXT,           -- {message, setup?}：setup 为结构化的「设置前置需求」（design/18），仅因缺设置失败时非空
  parent_run_id        TEXT,           -- 0004：SubAgent 子 run 的委派方 run（D66/D67）；其余为 null
  engine               TEXT NOT NULL DEFAULT 'builtin', -- 0005：执行引擎 'builtin' | 'agent:{id}'（D72）
  agent_session_id     TEXT,           -- 0005：外部 Agent 侧的 ACP sessionId；内置引擎为 null
  created_at           INTEGER NOT NULL,
  started_at           INTEGER,
  ended_at             INTEGER
);
CREATE INDEX runs_by_conv ON runs(conversation_id, created_at);
CREATE INDEX runs_by_bot ON runs(bot_id, created_at);
```

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
| 该对话的 jobs | 取消 | P01 |
| 所有 Bot 在该对话的 workspace 目录 | 删除 | P02 |
| 该对话的 approvals（待确认的先取消）、grants | 删除 | P03 |
| agent_sessions（外部智能体会话行；Agent 自己目录里的 transcript 不清理） | 删除 | D72 P5（P3 仅建表） |
| run_changes | 删除（project 文件与影子仓库不动） | P04 |
| chains | 删除 | P05 |
| 各 Bot 记忆中 `origin_conversation_id` 为该对话的承诺 | 置为 `void` | P07 |
| schedules | 删除 | P10 |
| 以该对话为 A 侧或 B 侧的活动委派（`submitted` / `working`） | 落 `cancelled`（B 有活动 run 的先中止）；行保留 | D71 |
| Wiki 中从该对话入库的资料 | **保留** | — |

### 删除 Bot

管家（D70，`system_role = 'butler'`）不可删除：`lifecycle.deleteBot` 在任何级联前拒绝。

| 数据 | 处理 | 阶段 |
|---|---|---|
| 该 Bot 所有正在执行、排队的执行 | 取消 | P01 |
| bots 行 | 改为占位（见 bots 表说明） | P01 |
| 单聊对话 | `read_only = 1`，清空其待发送队列 | P01 |
| 群成员关系 | 删除成员行（历史消息保留，发送者显示为 id） | P05 |
| 该 Bot 的执行记录 | 删除 | P01 |
| `bots/{id}/` 整个目录（workspace、maintenance、memory.db、wiki、skills） | 删除 | P01 起，随各阶段补充 |
| 该 Bot 的浏览器会话分区 `$KEPCUP_HOME/browser/Partitions/bot-{id}`（Cookie/localStorage/缓存等全部会话数据） | 删除（`browser.clearBotData`：关闭页面 → 清分区存储 → 删分区目录，并 tombstone 该 Bot） | P11 |
| 该 Bot 的 approvals（待确认的先取消）、grants | 删除 | P03 |
| 该 Bot 的 agent_sessions | 删除 | D72 P5（P3 仅建表） |
| 该 Bot 在 skill_library 中引用的版本 | 移除 bot_skills 行；不再被任何 Bot **或 public_skills** 引用的库版本回收（公共技能不随单个 Bot 删除） | P08 |
| schedules、jobs | 删除 / 取消 | P10 |
| 以该 Bot 为 A 或 B 的活动委派（`submitted` / `working`） | 落 `cancelled`（B 有活动 run 的先中止）；行保留 | D71 |
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
| 该 Bot 在此群正在执行、排队的执行 | 取消 | P05 |
| 成员行 | 删除 | P05 |
| 该 Bot 在此群的 workspace | 删除 | P05 |
| 该 Bot 在此群的 grants、待确认 approvals | 撤销 / 取消 | P05 |
| 该 Bot 在此群做出的承诺 | 置为 `void` | P07 |
| 该 Bot 在此群的 schedules | 取消 | P10 |

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
