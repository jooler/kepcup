-- kepcup:foreign-keys=off
-- D113 (D71 v2): per-delegation bot-to-bot exchange conversations.
-- `type` gains 'bot_direct' (A's task message + B's replies, single turn per
-- delegation, never in the sidebar); the new columns carry both participants.
-- Rebuild matches the table at head: 0051's columns, CHECKs and both indexes
-- (the 0040-era project/lead CHECK and the 0045 archived_at column included).
-- No triggers exist on this table. Old rows copy through with the new columns
-- NULL. delegations gains the nullable link column (no rebuild: 0021's shape
-- plus ADD COLUMN, and the table deliberately has no foreign keys).
CREATE TABLE conversations_new (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('direct', 'project', 'card', 'bot_direct')),
  title            TEXT,
  goal             TEXT,
  direct_bot_id    TEXT REFERENCES bots(id),
  lead_bot_id      TEXT REFERENCES bots(id),
  workdir_id       TEXT,
  read_only        INTEGER NOT NULL DEFAULT 0,
  summary          TEXT,
  summary_upto_seq INTEGER NOT NULL DEFAULT 0,
  last_seq         INTEGER NOT NULL DEFAULT 0,
  last_read_seq    INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER,
  created_at       INTEGER NOT NULL,
  archived_at      INTEGER,
  parent_project_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  card_todo_id     TEXT,
  from_bot_id      TEXT REFERENCES bots(id),
  to_bot_id        TEXT REFERENCES bots(id),
  CHECK ((type = 'project') = (lead_bot_id IS NOT NULL)),
  CHECK ((type = 'card') = (parent_project_id IS NOT NULL AND card_todo_id IS NOT NULL AND direct_bot_id IS NOT NULL)),
  -- Non-card rows cannot store either 0051 column. The equality CHECK alone
  -- still allows a project row (direct_bot_id NULL) to set both.
  CHECK ((type = 'card') OR (parent_project_id IS NULL AND card_todo_id IS NULL)),
  CHECK ((type = 'bot_direct') = (from_bot_id IS NOT NULL AND to_bot_id IS NOT NULL)),
  -- Non-bot_direct rows cannot store either new column (same stricter form
  -- as the card CHECK above).
  CHECK ((type = 'bot_direct') OR (from_bot_id IS NULL AND to_bot_id IS NULL))
);

INSERT INTO conversations_new
  (id, type, title, goal, direct_bot_id, lead_bot_id, workdir_id, read_only, summary,
   summary_upto_seq, last_seq, last_read_seq, last_message_at, created_at, archived_at,
   parent_project_id, card_todo_id, from_bot_id, to_bot_id)
SELECT id, type, title, goal, direct_bot_id, lead_bot_id, workdir_id, read_only, summary,
       summary_upto_seq, last_seq, last_read_seq, last_message_at, created_at, archived_at,
       parent_project_id, card_todo_id, NULL, NULL
  FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE UNIQUE INDEX conversations_one_direct_per_bot
  ON conversations(direct_bot_id) WHERE type = 'direct' AND read_only = 0;

CREATE INDEX conversations_archived
  ON conversations(archived_at) WHERE archived_at IS NOT NULL;

CREATE UNIQUE INDEX conversations_one_open_per_card
  ON conversations(card_todo_id) WHERE type = 'card' AND read_only = 0;

ALTER TABLE delegations ADD COLUMN exchange_conversation_id TEXT;
