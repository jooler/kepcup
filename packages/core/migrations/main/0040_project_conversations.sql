-- kepcup:foreign-keys=off
-- D92 T1a: conversations.type 'group' -> 'project'; mandatory lead; description -> goal; drop setup_state.
CREATE TABLE conversations_new (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('direct', 'project')),
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
  CHECK ((type = 'project') = (lead_bot_id IS NOT NULL))
);

INSERT INTO conversations_new
  (id, type, title, goal, direct_bot_id, lead_bot_id, workdir_id, read_only, summary,
   summary_upto_seq, last_seq, last_read_seq, last_message_at, created_at)
SELECT c.id,
       CASE c.type WHEN 'group' THEN 'project' ELSE c.type END,
       c.title,
       c.description,
       c.direct_bot_id,
       CASE WHEN c.type = 'group' THEN (
         SELECT m.bot_id FROM conversation_members m JOIN bots b ON b.id = m.bot_id
          WHERE m.conversation_id = c.id AND b.status = 'active' AND COALESCE(b.system_role, '') <> 'butler'
          ORDER BY m.joined_at, m.bot_id LIMIT 1) END,
       c.workdir_id, c.read_only, c.summary,
       c.summary_upto_seq, c.last_seq, c.last_read_seq, c.last_message_at, c.created_at
  FROM conversations c;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE UNIQUE INDEX conversations_one_direct_per_bot
  ON conversations(direct_bot_id) WHERE type = 'direct' AND read_only = 0;

-- The butler is no longer a project participant (D92 K9): drop legacy memberships.
DELETE FROM conversation_members
 WHERE conversation_id IN (SELECT id FROM conversations WHERE type = 'project')
   AND bot_id IN (SELECT id FROM bots WHERE system_role = 'butler');
