-- BR-P08-004（P08 审查修复）：审批新增终态 failed——批准后的落位动作失败时
-- （当前仅 skill_import：Bot 已删 / 对话已删 / 同名冲突 / 库目录异常），卡片
-- 不能停留在 approved 造成「已成功」的假象。SQLite 不能修改 CHECK 约束，
-- 按标准流程重建表（approvals 无被引用外键，重建安全）。

CREATE TABLE approvals_new (
  id              TEXT PRIMARY KEY,       -- apr_...
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'profile_change')),
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

INSERT INTO approvals_new (id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, message_id, created_at, decided_at)
  SELECT id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, message_id, created_at, decided_at FROM approvals;

DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;

CREATE INDEX approvals_pending ON approvals(status, conversation_id);
