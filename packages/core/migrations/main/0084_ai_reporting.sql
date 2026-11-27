-- AI 生成内容举报（Microsoft Store 11.16，todo/ai-content-reporting.md §6.1）。
--
-- report_outbox：本机发送队列。👍/👎 举报经 ReportService 构建 payload 后入队，
-- 后台按 1 条/分钟/client 发往 reports.kepcup.com；关应用不丢，启动自动续发
--（sending → pending 崩溃恢复）。去重用「时间桶」：content_bucket /
-- payload_bucket = floor(now / 窗口)（内容 24h、整份 payload 90 天，窗口常量在
-- @kepcup/shared），两张唯一索引 (client_id, hash, bucket) 由 INSERT OR IGNORE
-- 判重，并发安全；不做全局去重（不同 client 互不影响）。sent / failed 行保留
--（用户自己的库，量很小），不做清理。不建 FK 到 messages：团队来源消息不在
-- 本机 messages 表；本机/团队同 id 不会混淆（举报 payload 带 source）。
--
-- message_reactions：消息 emoji feedback（§5.6 / §6.6）。只存本机 main.db，不进
-- 消息内容、不进 Bot 上下文、不参与团队同步；scope（'local' / 'team:<hash>'）
-- 隔离本机与团队会话 id。每条 (scope, message_id, client_id) 最多一个 emoji。
-- emoji 白名单（MESSAGE_REACTION_EMOJIS）由服务层校验；消息删除 / 撤回不级联
-- 清理 reaction（本期保留）。

CREATE TABLE report_outbox (
  id               TEXT PRIMARY KEY,              -- rep_...
  client_id        TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  content_bucket   INTEGER NOT NULL,
  payload_hash     TEXT NOT NULL,
  payload_bucket   INTEGER NOT NULL,
  payload_json     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  sent_at          INTEGER
);
CREATE UNIQUE INDEX report_outbox_content
  ON report_outbox(client_id, content_hash, content_bucket);
CREATE UNIQUE INDEX report_outbox_payload
  ON report_outbox(client_id, payload_hash, payload_bucket);
CREATE INDEX report_outbox_due
  ON report_outbox(status, next_attempt_at);
CREATE INDEX report_outbox_client_due
  ON report_outbox(client_id, next_attempt_at);

CREATE TABLE message_reactions (
  scope            TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  client_id        TEXT NOT NULL,
  emoji            TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (scope, message_id, client_id)
);
CREATE INDEX message_reactions_conv
  ON message_reactions(scope, conversation_id);
