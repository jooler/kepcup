-- P02: audit trail for tool side effects (docs/dev/03-data-model.md "audit_log").
CREATE TABLE audit_log (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  bot_id          TEXT,
  conversation_id TEXT,
  action          TEXT NOT NULL,          -- exec | fs_write
  detail_json     TEXT NOT NULL,          -- redacted before insert
  created_at      INTEGER NOT NULL
);
CREATE INDEX audit_log_by_conv ON audit_log(conversation_id, created_at);
CREATE INDEX audit_log_by_bot ON audit_log(bot_id, created_at);
