-- P03 授权与确认体系（docs/dev/03-data-model.md "approvals" / "grants" / "command_allowlist"）

CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,       -- apr_...
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'profile_change')),
  bot_id          TEXT,
  conversation_id TEXT,
  run_id          TEXT,
  payload_json    TEXT NOT NULL,          -- 各类请求的内容（路径、命令、原因……）
  status          TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  decision_json   TEXT,                   -- 例如 { duration: 'once' | 'conversation' }
  auto_approved   INTEGER NOT NULL DEFAULT 0,  -- 无人值守模式自动批准
  message_id      TEXT,                   -- 对话中的卡片消息
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);
CREATE INDEX approvals_pending ON approvals(status, conversation_id);

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

CREATE TABLE command_allowlist (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL CHECK (platform IN ('posix', 'windows')),
  pattern     TEXT NOT NULL,              -- 命令前缀，例如 "git status"
  builtin     INTEGER NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
