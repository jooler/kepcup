-- macOS Share Extension 分享接收（D94，docs/design/44-macos-share-extension.md §5.3）。
--
-- 一行 = 一个分享批次（扩展生成的 shr_ id）。id 是幂等键：同一个 id 重复消费
-- 不会发第二条消息。
--   state            received（已发现完整目录，未提交）/ processing（正在落附件发消息）
--                    / done（消息已提交）/ failed_target（目标失效，等用户重选）
--                    / failed（hash 不符、磁盘错误等）
--   target_kind      bot（Bot 私聊）/ project（项目组；target_id 是项目根会话 id）
--   conversation_id  目标解析成功后写入；失败目标为 NULL
--   message_id       提交后的消息 id
--   attempts         消费 / 重试次数
-- 会话或消息被删时外键置 NULL：失败 intake 的文件按 TTL 或用户删除清理，不因
-- 会话删除而阻塞。
CREATE TABLE share_intakes (
  id              TEXT PRIMARY KEY,
  state           TEXT NOT NULL CHECK (state IN
                    ('received','processing','done','failed_target','failed')),
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('bot','project')),
  target_id       TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  error_message   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX share_intakes_pending
  ON share_intakes(state, updated_at);
