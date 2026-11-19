-- kepcup:foreign-keys=off
-- Team-server principal seams (62.11 C3 / C5, docs/design/62-team-server/11-core-seams.md):
-- conversations gains owner_principal_id (nullable; NULL = single-user status quo) and
-- the 'dm' type (no bot, no lead; participants live in conversation_principals), plus
-- two companion tables for conversation participants and per-principal read state.
--
-- Rebuild matches the table at head: 0067's columns, CHECKs and indexes. 'dm' joins
-- the type CHECK (dm rows satisfy every other CHECK by keeping lead_bot_id,
-- from_bot_id, to_bot_id, parent_project_id and card_todo_id NULL). Old rows copy
-- through with owner_principal_id NULL (selected as a literal so replaying from a
-- pre-0077 database works, same as 0067's NULL, NULL for the bot_direct columns).
-- About 26 child tables reference conversations(id), so the rebuild needs the
-- foreign-keys=off directive (SQLite's 12-step flow; no triggers exist on this
-- table). The direct-chat unique index keeps its name so by-name assertions and
-- code keep working; only its key changes to (bot, owner).
CREATE TABLE conversations_new (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('direct', 'dm', 'project', 'card', 'bot_direct')),
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
  owner_principal_id TEXT,
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
   parent_project_id, card_todo_id, from_bot_id, to_bot_id, owner_principal_id)
SELECT id, type, title, goal, direct_bot_id, lead_bot_id, workdir_id, read_only, summary,
       summary_upto_seq, last_seq, last_read_seq, last_message_at, created_at, archived_at,
       parent_project_id, card_todo_id, from_bot_id, to_bot_id, NULL
  FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

-- Same name and WHERE as 0067; the key now scopes one direct chat per (bot, owner),
-- with the NULL owner collapsing to '' so single-user uniqueness is unchanged.
CREATE UNIQUE INDEX conversations_one_direct_per_bot
  ON conversations(direct_bot_id, ifnull(owner_principal_id, '')) WHERE type = 'direct' AND read_only = 0;

CREATE INDEX conversations_archived
  ON conversations(archived_at) WHERE archived_at IS NOT NULL;

CREATE UNIQUE INDEX conversations_one_open_per_card
  ON conversations(card_todo_id) WHERE type = 'card' AND read_only = 0;

-- Human participants (principals) of dm and project conversations. Bots keep living
-- in conversation_members; removal writes left_at, the row stays for audit trails.
CREATE TABLE conversation_principals (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  principal_id    TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('member', 'lead')),
  joined_at       INTEGER NOT NULL,
  left_at         INTEGER,
  PRIMARY KEY (conversation_id, principal_id)
);

CREATE INDEX conversation_principals_by_principal ON conversation_principals(principal_id);

-- Per-principal read state (C5): written only for callers with a principal; the
-- single-user path keeps using conversations.last_read_seq.
CREATE TABLE conversation_reads (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  principal_id    TEXT NOT NULL,
  last_read_seq   INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, principal_id)
);
