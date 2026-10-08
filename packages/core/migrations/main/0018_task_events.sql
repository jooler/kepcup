-- 对话轮与任务分治（D75，docs/design/30-supervisor-and-tasks.md §2.4.2 / §3.2）。
--
-- 1) messages 重建：kind CHECK 增 'task_event'（Bot 与任务之间的私有往返
--    条目），新增 owner_bot_id（NULL = 对话共享；非空 = 仅该 Bot 可见，只用于
--    task_event）与 task_id（仅 task_event 填）。
--
-- SQLite 不能修改 CHECK 约束，只能重建。与 0010 / 0015–0017 重建 approvals
-- 不同，messages 被 attachments.message_id（ON DELETE CASCADE）引用，而迁移在
-- foreign_keys=ON 的事务内执行（infra/db.ts、infra/migrate.ts；事务内无法关闭
-- 外键）：直接 DROP TABLE messages 会经隐式 DELETE 级联删光 attachments。
-- 因此 attachments 一并重建，次序固定为：
--   a. 建 messages_new 并复制；
--   b. 建 attachments_new（外键指向 messages_new）并复制；
--   c. 先删旧 attachments（无表引用它），再删旧 messages（此时已无子表引用，
--      隐式 DELETE 不级联到任何表）；
--   d. messages_new 改名为 messages——foreign_keys=ON 时 SQLite 会把
--      attachments_new 的 REFERENCES messages_new 同步改写为 messages；
--   e. attachments_new 改名为 attachments，重建两表的索引。
-- messages_fts 是独立的 fts5 表（message_id 只是 UNINDEXED 列，由
-- domain/messages.ts 在应用层同步），消息 id 不变，FTS 行无需改动。
CREATE TABLE messages_new (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  sender_type      TEXT NOT NULL CHECK (sender_type IN ('user', 'bot', 'system')),
  sender_bot_id    TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('text', 'system_event', 'card', 'task_event')),
  content_json     TEXT NOT NULL,
  reply_to         TEXT,
  mentions_json    TEXT NOT NULL DEFAULT '[]',
  batch_id         TEXT,
  run_id           TEXT,
  status           TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'recalled', 'edited')),
  edited_at        INTEGER,
  created_at       INTEGER NOT NULL,
  owner_bot_id     TEXT,
  task_id          TEXT,
  UNIQUE (conversation_id, seq)
);

INSERT INTO messages_new (id, conversation_id, seq, sender_type, sender_bot_id, kind, content_json, reply_to, mentions_json, batch_id, run_id, status, edited_at, created_at)
  SELECT id, conversation_id, seq, sender_type, sender_bot_id, kind, content_json, reply_to, mentions_json, batch_id, run_id, status, edited_at, created_at FROM messages;

CREATE TABLE attachments_new (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       TEXT REFERENCES messages_new(id) ON DELETE CASCADE,
  draft_id         TEXT,
  file_name        TEXT NOT NULL,
  mime             TEXT NOT NULL,
  size             INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  rel_path         TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);

INSERT INTO attachments_new (id, conversation_id, message_id, draft_id, file_name, mime, size, sha256, rel_path, created_at)
  SELECT id, conversation_id, message_id, draft_id, file_name, mime, size, sha256, rel_path, created_at FROM attachments;

DROP TABLE attachments;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
ALTER TABLE attachments_new RENAME TO attachments;

CREATE INDEX messages_conv_seq ON messages(conversation_id, seq);

-- 2) 按 Bot 视角读（W1-B：owner_bot_id IS NULL OR owner_bot_id = X，按 seq）
--    与按任务查条目。
CREATE INDEX messages_conv_owner_seq ON messages(conversation_id, owner_bot_id, seq);
CREATE INDEX messages_task ON messages(task_id);

-- 3) 每个任务至多一条终态条目（result / failure）：§3.2 「先写终态条目再写
--    任务终态」的幂等写入与启动修复都靠它。
CREATE UNIQUE INDEX messages_task_terminal ON messages(task_id)
  WHERE kind = 'task_event' AND json_extract(content_json, '$.phase') IN ('result', 'failure');
