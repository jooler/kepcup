-- P07 记忆与用户画像：共享用户画像（docs/dev/03-data-model.md，原文迁移）
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
