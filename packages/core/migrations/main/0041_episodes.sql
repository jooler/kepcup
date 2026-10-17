-- D92 T1a: Bot-to-Bot @ chains become collaboration episodes (no token budget, no hard depth; circuit breaker instead).
DROP TABLE chains;

CREATE TABLE episodes (
  id              TEXT PRIMARY KEY,                       -- epi_...
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_batch_id   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
  hops            INTEGER NOT NULL DEFAULT 0,             -- Bot 发起的触发总数
  pair_hops_json  TEXT NOT NULL DEFAULT '{}',             -- { "botA|botB": n }，键为字典序排序后的无序对
  pending_json    TEXT NOT NULL DEFAULT '[]',             -- 熔断时未投递的触发：[{ toBotId, fromBotId, messageId, hop }]
  paused_at       INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX episodes_by_conversation ON episodes(conversation_id, created_at);
