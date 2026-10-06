-- 管家 Bot 与跨 Bot 委派（D70 / D71，docs/design/27-butler-and-delegation.md）。
--
-- 1) bots.system_role：系统角色（目前只有 'butler'），与 Profile 内的
--    role.{expertise,responsibilities} 人设字段无关。partial unique index
--    保证至多一个 active 管家（并发 ensureButler 靠它兜底）。
ALTER TABLE bots ADD COLUMN system_role TEXT;
CREATE UNIQUE INDEX bots_one_active_butler
  ON bots(system_role) WHERE system_role = 'butler' AND status = 'active';

-- 2) delegations：A→B 委派行。对话 / 消息 / run 只存 id——对话删除时委派行
--    保留并由 lifecycle 终态化（不靠 FK 级联）；run 在 runs.db，跨库本来就
--    只能存 id。
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
  to_message_id         TEXT,                   -- B 侧代发用户消息（「查看原文」）
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

-- 3) approvals.kind 新增 'butler_proposal'（管家组队 / 建 Bot / 建群审批卡）。
--    SQLite 不能修改 CHECK 约束，按 0010 / 0015 的标准流程重建 approvals
--    （无被引用外键，重建安全）。kind 列表以 0015 为准全部带上。
CREATE TABLE approvals_new (
  id              TEXT PRIMARY KEY,       -- apr_...
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'profile_change',
                    'skill_preset', 'mcp_tool', 'butler_proposal')),
  bot_id          TEXT,
  conversation_id TEXT,
  run_id          TEXT,
  payload_json    TEXT NOT NULL,          -- 各类请求的内容（路径、命令、原因……）
  status          TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'failed')),
  decision_json   TEXT,                   -- 例如 { duration: 'once' | 'conversation' } / { error: '…' } / { selection: [...] }
  auto_approved   INTEGER NOT NULL DEFAULT 0,  -- 无人值守模式自动批准
  message_id      TEXT,                   -- 对话中的卡片消息
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);

INSERT INTO approvals_new (id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, message_id, created_at, decided_at)
  SELECT id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, message_id, created_at, decided_at FROM approvals;

DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;

CREATE INDEX approvals_pending ON approvals(status, conversation_id);
