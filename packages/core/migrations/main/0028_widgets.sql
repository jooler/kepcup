-- Bot 自制交互组件（D81，docs/design/32-bot-widgets.md）：Bot 在任务里交付的
-- 单文件 HTML 组件。卡片消息只存描述符（widgetId + version），HTML 只在这里。
-- 删除级联：会话删除 → conversation_id FK 级联只清 scope='conversation' 的组件
-- （scope='bot' 的行 conversation_id 为 NULL、不受引用约束影响，跨对话存活）；
-- Bot 删除 → bots 行改占位、bot_id 的 FK 不会触发，由 lifecycle.deleteBot 经
-- WidgetService.deleteForBot 显式清除。widget_docs 是能力桥（P1）的每组件
-- 命名空间 KV，先随本迁移建表。
CREATE TABLE widgets (
  id              TEXT PRIMARY KEY,       -- wgt_...
  bot_id          TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL DEFAULT 'conversation' CHECK (scope IN ('conversation', 'bot')),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  latest_version  INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX widgets_bot ON widgets(bot_id);
CREATE INDEX widgets_conversation ON widgets(conversation_id);

CREATE TABLE widget_versions (
  widget_id      TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  html           TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  created_by_run TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (widget_id, version)
);

CREATE TABLE widget_docs (
  widget_id  TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (widget_id, key)
);
