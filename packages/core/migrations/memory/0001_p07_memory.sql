-- P07 每个 Bot 的私有记忆库（docs/dev/03-data-model.md "memory.db"，原文迁移）。
-- memory_vec（vec0）在向量模型就绪后按维度由代码创建（维度动态，见 meta 表）。
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
