-- P10 主动消息与调度：定时任务（docs/dev/03-data-model.md，原文迁移）
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,       -- sch_...
  bot_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('once', 'cron')),
  run_at          INTEGER,                -- once
  cron            TEXT,                   -- cron 表达式
  timezone        TEXT NOT NULL,
  note            TEXT NOT NULL,
  commitment_id   TEXT,                   -- 对应 memory.db 中的承诺条目
  status          TEXT NOT NULL CHECK (status IN ('active', 'done', 'cancelled')),
  next_fire_at    INTEGER,
  last_fired_at   INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX schedules_next ON schedules(status, next_fire_at);
