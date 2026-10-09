-- 确定性监看（W7，D79；todo/borrowings-from-personal-agents.md W7）：「盯着某个
-- 网页，变了才叫我」。检查不花 LLM，条件边沿触发才唤醒 Bot 一个对话轮。
--
-- source_json：本轮仅 {kind:'web_page', url, selector?}（kind 为后期传感器来源留口）。
-- condition_json：{kind:'changed'} | {kind:'contains'|'not_contains', text}
--                 | {kind:'number_below'|'number_above', selector?, value}。
-- last_text：上一版页面行（≤ WATCH_STORED_TEXT_MAX_CHARS），用于下一次的增删改摘要。
-- alert_times_json：最近 24 小时内的提醒时间（毫秒时间戳 JSON 数组，≤ WATCH_MAX_ALERTS_PER_DAY
--                   项）；超过上限的那次边沿不唤醒，改为暂停（「提醒过于频繁」）。恢复时清空。
-- version：CAS——每次写入 +1，检查结果只在版本未变时落库。
CREATE TABLE watches (
  id              TEXT PRIMARY KEY,       -- wat_...
  bot_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_json     TEXT NOT NULL,
  condition_json  TEXT NOT NULL,
  interval_sec    INTEGER NOT NULL CHECK (interval_sec >= 300),
  status          TEXT NOT NULL CHECK (status IN ('active', 'paused', 'stopped')),
  last_hash       TEXT,
  last_quiet_hash TEXT,
  last_text       TEXT,
  last_matched    INTEGER NOT NULL DEFAULT 0,
  alert_seq       INTEGER NOT NULL DEFAULT 0,
  alert_times_json TEXT NOT NULL DEFAULT '[]',
  failures        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_checked_at INTEGER,
  next_check_at   INTEGER NOT NULL,
  version         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX watches_due ON watches(status, next_check_at);
CREATE INDEX watches_conversation ON watches(conversation_id);
CREATE INDEX watches_bot ON watches(bot_id, status);
