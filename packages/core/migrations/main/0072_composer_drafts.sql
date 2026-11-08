-- 多客户端共享草稿（D120，docs/design/57-multi-client-collaboration.md §4.2）：
-- 每会话一行最新快照；编辑者租约只在内存，core 重启后由首个 claim 重建。
-- version 每次服务端接受的更新 +1，0 = 空草稿。
CREATE TABLE composer_drafts (
  conversation_id  TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  doc_json         TEXT NOT NULL,
  mentions_json    TEXT NOT NULL DEFAULT '[]',
  reply_to         TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  version          INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);
