-- P01 single-chat loop tables (docs/dev/03-data-model.md, tables marked P01).
CREATE TABLE secrets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,
  tag         BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE bots (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  avatar        TEXT,
  bio           TEXT NOT NULL DEFAULT '',
  profile_json  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE TABLE conversations (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  title             TEXT,
  direct_bot_id     TEXT REFERENCES bots(id),
  project_id        TEXT,
  read_only         INTEGER NOT NULL DEFAULT 0,
  summary           TEXT,
  summary_upto_seq  INTEGER NOT NULL DEFAULT 0,
  last_seq          INTEGER NOT NULL DEFAULT 0,
  last_read_seq     INTEGER NOT NULL DEFAULT 0,
  last_message_at   INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX conversations_one_direct_per_bot
  ON conversations(direct_bot_id) WHERE type = 'direct' AND read_only = 0;

CREATE TABLE conversation_members (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id           TEXT NOT NULL REFERENCES bots(id),
  joined_at        INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, bot_id)
);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  sender_type      TEXT NOT NULL CHECK (sender_type IN ('user', 'bot', 'system')),
  sender_bot_id    TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('text', 'system_event', 'card')),
  content_json     TEXT NOT NULL,
  reply_to         TEXT,
  mentions_json    TEXT NOT NULL DEFAULT '[]',
  batch_id         TEXT,
  run_id           TEXT,
  status           TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'recalled', 'edited')),
  edited_at        INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_conv_seq ON messages(conversation_id, seq);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  segmented_text, message_id UNINDEXED, conversation_id UNINDEXED, tokenize = 'unicode61'
);

CREATE TABLE attachments (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       TEXT REFERENCES messages(id) ON DELETE CASCADE,
  draft_id         TEXT,
  file_name        TEXT NOT NULL,
  mime             TEXT NOT NULL,
  size             INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  rel_path         TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE drafts (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  text             TEXT NOT NULL,
  mentions_json    TEXT NOT NULL DEFAULT '[]',
  reply_to         TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  bot_id        TEXT,
  conversation_id TEXT,
  payload_json  TEXT NOT NULL,
  priority      INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  run_after     INTEGER NOT NULL,
  dedupe_key    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_error    TEXT
);
CREATE INDEX jobs_pending ON jobs(status, run_after, priority);
CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE status = 'pending';

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
