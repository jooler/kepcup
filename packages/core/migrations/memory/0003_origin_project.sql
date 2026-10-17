-- D92 T1a: memory_items.origin 'group' -> 'project'.
CREATE TABLE memory_items_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'fact', 'preference', 'commitment', 'feedback', 'episode', 'lesson', 'self_note')),
  content         TEXT NOT NULL,
  subject         TEXT,
  source          TEXT NOT NULL CHECK (source IN ('explicit', 'inferred')),
  evidence_json   TEXT NOT NULL,
  origin          TEXT NOT NULL CHECK (origin IN ('private', 'project')),
  origin_conversation_id TEXT,
  confidence      REAL NOT NULL,
  sensitivity     TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
  private_to_bot  INTEGER NOT NULL DEFAULT 0,
  due_at          INTEGER,
  valid_until     INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retracted', 'void')),
  supersedes      TEXT,
  last_used_at    INTEGER,
  use_count       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
INSERT INTO memory_items_new
  (id, kind, content, subject, source, evidence_json, origin, origin_conversation_id, confidence, sensitivity,
   private_to_bot, due_at, valid_until, status, supersedes, last_used_at, use_count, created_at, updated_at)
SELECT id, kind, content, subject, source, evidence_json,
       CASE origin WHEN 'group' THEN 'project' ELSE origin END,
       origin_conversation_id, confidence, sensitivity,
       private_to_bot, due_at, valid_until, status, supersedes, last_used_at, use_count, created_at, updated_at
  FROM memory_items;
DROP TABLE memory_items;
ALTER TABLE memory_items_new RENAME TO memory_items;
CREATE INDEX memory_active ON memory_items(status, kind);
