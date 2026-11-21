-- Composer drafts per principal (62.11 C5): the single row per conversation
-- becomes one row per (conversation, principal key). Single-user callers keep
-- the empty key, so their behaviour is unchanged. Rebuild matches 0072's
-- shape plus the new NOT NULL key column; old rows copy through with the
-- default '' (the copy does not list principal_key, so replaying from a
-- pre-0079 database works too). The table has no inbound foreign keys, so a
-- plain rebuild is enough.
CREATE TABLE composer_drafts_new (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  principal_key    TEXT NOT NULL DEFAULT '',
  doc_json         TEXT NOT NULL,
  mentions_json    TEXT NOT NULL DEFAULT '[]',
  reply_to         TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  version          INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, principal_key)
);

INSERT INTO composer_drafts_new
  (conversation_id, doc_json, mentions_json, reply_to, attachments_json, version, updated_at)
SELECT conversation_id, doc_json, mentions_json, reply_to, attachments_json, version, updated_at
  FROM composer_drafts;

DROP TABLE composer_drafts;
ALTER TABLE composer_drafts_new RENAME TO composer_drafts;
