-- 邮件通道（D84，docs/design/35-mail-channel.md）：IMAP/SMTP 账号与 Bot 绑定。
-- 正文不落库。密钥在 secrets，名 mail:{id}:password。
-- last_uid：INBOX 已处理的最大 UID。首次连上时记成当时的水位，不把历史邮件当新信。
-- listen：运行中的收信方式（idle / poll）；暂停或尚未连上时为空。
CREATE TABLE mail_accounts (
  id                TEXT PRIMARY KEY,
  address           TEXT NOT NULL,
  label             TEXT NOT NULL,
  provider          TEXT NOT NULL,
  imap_host         TEXT NOT NULL,
  imap_port         INTEGER NOT NULL,
  imap_secure       TEXT NOT NULL,
  smtp_host         TEXT NOT NULL,
  smtp_port         INTEGER NOT NULL,
  smtp_secure       TEXT NOT NULL,
  username          TEXT NOT NULL,
  mode              TEXT NOT NULL DEFAULT 'auto'
                    CHECK (mode IN ('auto', 'poll_only')),
  poll_interval_sec INTEGER NOT NULL DEFAULT 300,
  status            TEXT NOT NULL DEFAULT 'idle'
                    CHECK (status IN ('idle', 'running', 'paused', 'error')),
  listen            TEXT CHECK (listen IN ('idle', 'poll')),
  last_uid          INTEGER,
  unseen_count      INTEGER,
  last_error        TEXT,
  last_ok_at        INTEGER,
  failure_streak    INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);

-- 同一邮箱可绑多个 Bot。alerts_paused：该绑定的唤醒被风暴暂停（游标仍前进）。
-- alert_times_json：最近唤醒时间（毫秒），用于滚动 1 小时上限。
CREATE TABLE mail_account_bots (
  account_id        TEXT NOT NULL REFERENCES mail_accounts(id),
  bot_id            TEXT NOT NULL,
  alerts_paused     INTEGER NOT NULL DEFAULT 0,
  alert_times_json  TEXT NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (account_id, bot_id)
);
CREATE INDEX mail_account_bots_bot ON mail_account_bots(bot_id);

-- approvals.kind 增加 mail_send。SQLite 不能改 CHECK，按 0027 重建。
CREATE TABLE approvals_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'profile_change',
                    'skill_preset', 'mcp_tool', 'butler_proposal',
                    'agent_tool', 'egress', 'mail_send')),
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
