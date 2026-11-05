-- 微应用用量记账（D112，设计 55 §4.3 / §8.3）：按微应用 / 日；归属 Bot 由 widgets.bot_id
-- 决定（跨该 Bot 全部微应用聚合出「每 Bot 每日」预算）。只记数量，不记内容。

CREATE TABLE micro_app_usage (
  widget_id TEXT NOT NULL,
  day       TEXT NOT NULL,           -- YYYY-MM-DD（本地时区）
  ai_calls  INTEGER NOT NULL DEFAULT 0,
  ai_tokens INTEGER NOT NULL DEFAULT 0,
  asr_ms    INTEGER NOT NULL DEFAULT 0,
  tts_chars INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (widget_id, day)
);
