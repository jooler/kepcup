-- D105 计算机操控（docs/design/52 §5）：approvals.kind 增加 computer_control。
-- 设计文档写「无 DB 迁移」指不加新表；kind 的 CHECK 是封闭枚举，新 kind 必须重建
-- approvals（SQLite 不能改 CHECK，按 0031/0036 的标准流程）。
CREATE TABLE approvals_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'profile_change',
                    'skill_preset', 'mcp_tool', 'butler_proposal',
                    'agent_tool', 'egress', 'mail_send', 'bot_handover',
                    'computer_control')),
  bot_id          TEXT,
  conversation_id TEXT,
  run_id          TEXT,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'failed')),
  decision_json   TEXT,
  auto_approved   INTEGER NOT NULL DEFAULT 0,
  message_id      TEXT,
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);
INSERT INTO approvals_new (id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, message_id, created_at, decided_at)
  SELECT id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, message_id, created_at, decided_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
CREATE INDEX approvals_pending ON approvals(status, conversation_id);
