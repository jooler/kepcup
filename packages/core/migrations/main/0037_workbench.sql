-- 工作台（D90，docs/design/39-workbench.md；todo/workbench.md §4.1 / §4.2）。
--
-- 1) 新表 todos / todo_runs / memos。
-- 2) schedules 重建：SQLite 改不了 CHECK、放宽不了 NOT NULL，按 0021 的写法
--    建新表 → 拷数据 → 删旧 → 改名 → 重建索引。改动：
--      - bot_id 放宽为可空（仅「派给群、未指定负责 Bot」的事项排期行为空，CHECK 保证）；
--      - origin CHECK 增 'workbench'；
--      - 增 todo_id（指向事项，事项删除时置空）与索引。
--    没有任何表以外键指向 schedules（对话 / 消息 / run 只存 id），重建安全；
--    schedules 自身对 conversations 的外键按原样保留。
--
-- 编号：撰写时 main 最新为 0036；合入 main 时按实况重编。

CREATE TABLE todos (
  id                TEXT PRIMARY KEY,                -- todo_...
  title             TEXT NOT NULL,                   -- <= 120 字
  notes             TEXT NOT NULL DEFAULT '',        -- <= 4000 字；派发时给执行者
  assignee_bot_id   TEXT,                            -- Bot 执行者；群执行者时 = 可选的负责 Bot
  assignee_group_id TEXT,                            -- 群执行者；不设 FK（与 todo_runs.conversation_id 一致）：删群时由 TodoService / 对账退回草案并写「群已解散」，FK 置空会把「群 + 负责 Bot」静默读成 Bot 执行者
  status            TEXT NOT NULL CHECK (status IN
                      ('draft', 'scheduled', 'in_progress', 'delivered', 'done', 'cancelled')),
  source            TEXT NOT NULL CHECK (source IN ('user', 'butler')),
  memo_id           TEXT,                            -- 由哪条备忘转来（不设 FK，备忘清理不影响）
  blocked_reason    TEXT,                            -- 退回草案的原因（展示用）
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER,                         -- done / cancelled 时间
  scheduled_by      TEXT CHECK (scheduled_by IN ('user', 'butler'))  -- 最后一次设置该事项排期的操作者；到点派发据此标注「管家代你安排」
);
CREATE INDEX todos_status ON todos(status, updated_at DESC);

CREATE TABLE todo_runs (                              -- 每次派发一条（单次事项通常只有一条）
  id                TEXT PRIMARY KEY,                -- tdr_...
  todo_id           TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  conversation_id   TEXT NOT NULL,                   -- 派到的对话（不设 FK：对话删了记录仍可读）
  message_id        TEXT,                            -- 派发消息
  status            TEXT NOT NULL CHECK (status IN ('dispatched', 'delivered', 'unclaimed', 'failed')),
  result_message_id TEXT,                            -- 交付的那条回复
  dispatched_at     INTEGER NOT NULL,
  settled_at        INTEGER
);
CREATE INDEX todo_runs_todo ON todo_runs(todo_id, dispatched_at DESC);

CREATE TABLE memos (
  id         TEXT PRIMARY KEY,                       -- memo_...
  body       TEXT NOT NULL,                          -- <= 10000 字，纯文本
  pinned     INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL CHECK (source IN ('user', 'butler')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                                 -- 非空 = 在「最近删除」
);
CREATE INDEX memos_live ON memos(deleted_at, pinned DESC, updated_at DESC);

CREATE TABLE schedules_new (
  id              TEXT PRIMARY KEY,       -- sch_...
  bot_id          TEXT,                   -- 可空：事项排期且群未指定负责 Bot
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
  created_at      INTEGER NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  origin          TEXT NOT NULL DEFAULT 'tool'
                    CHECK (origin IN ('tool', 'offer', 'proposal', 'commitment', 'workbench')),
  todo_id         TEXT REFERENCES todos(id) ON DELETE SET NULL,
  -- bot_id 只有事项排期可以为空；todo_id 只会出现在事项排期上（单向：事项硬删会把它置空）。
  CHECK (bot_id IS NOT NULL OR origin = 'workbench'),
  CHECK (todo_id IS NULL OR origin = 'workbench')
);

INSERT INTO schedules_new (id, bot_id, conversation_id, kind, run_at, cron, timezone, note, commitment_id, status, next_fire_at, last_fired_at, created_at, title, origin)
  SELECT id, bot_id, conversation_id, kind, run_at, cron, timezone, note, commitment_id, status, next_fire_at, last_fired_at, created_at, title, origin FROM schedules;

DROP TABLE schedules;
ALTER TABLE schedules_new RENAME TO schedules;

CREATE INDEX schedules_next ON schedules(status, next_fire_at);
CREATE INDEX schedules_todo ON schedules(todo_id);
