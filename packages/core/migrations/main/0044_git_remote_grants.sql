-- git 远程操作的持续授权（docs/design/13-permissions.md git_remote 持久授权）：
-- 写工具持续授权（app_tool_grants，D73 P1）的同形结构，键为 (Bot, 操作, 远端)。
--   conversation_id NULL = 对该 Bot 总是允许；非 NULL = 仅在该对话内一直允许。
--   只覆盖 push / pull / fetch 且后续参数不带选项（--force / --delete 等一律弹卡，fail closed）。
--   撤销 = 写 revoked_at（保留行作审计）；对话删除时随外键级联；Bot 删除 / 被移出群时由 core
--   撤销（bot_id 不设外键：删除 Bot 保留占位行）。
CREATE TABLE git_remote_grants (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  operation       TEXT NOT NULL,
  remote          TEXT NOT NULL,
  approval_id     TEXT,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);
CREATE INDEX git_remote_grants_live
  ON git_remote_grants(bot_id, operation, remote) WHERE revoked_at IS NULL;
CREATE INDEX git_remote_grants_conversation
  ON git_remote_grants(conversation_id) WHERE conversation_id IS NOT NULL;
