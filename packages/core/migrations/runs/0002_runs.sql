-- P01 execution records (docs/dev/03-data-model.md "runs.db").
CREATE TABLE runs (
  id                   TEXT PRIMARY KEY,
  bot_id               TEXT,
  conversation_id      TEXT,
  loop_type            TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
                         'queued', 'running', 'waiting_approval', 'waiting_lease',
                         'completed', 'failed', 'cancelled', 'interrupted')),
  trigger_reason       TEXT,
  trigger_message_ids_json TEXT NOT NULL DEFAULT '[]',
  chain_id             TEXT,
  chain_depth          INTEGER,
  provider             TEXT,
  model                TEXT,
  output_message_ids_json TEXT NOT NULL DEFAULT '[]',
  summary              TEXT,
  error_json           TEXT,
  created_at           INTEGER NOT NULL,
  started_at           INTEGER,
  ended_at             INTEGER
);
CREATE INDEX runs_by_conv ON runs(conversation_id, created_at);
CREATE INDEX runs_by_bot ON runs(bot_id, created_at);

CREATE TABLE run_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN (
                'request', 'assistant', 'tool_call', 'tool_result', 'steer', 'progress', 'system')),
  payload_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (run_id, seq)
);
