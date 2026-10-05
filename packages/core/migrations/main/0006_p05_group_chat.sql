-- P05 group chat (docs/dev/03-data-model.md "chains", verbatim).
CREATE TABLE chains (
  id              TEXT PRIMARY KEY,       -- chn_...
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_batch_id   TEXT NOT NULL,
  max_depth_seen  INTEGER NOT NULL,
  tokens_used     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX chains_by_conversation ON chains(conversation_id);
