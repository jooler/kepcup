-- 污点外发的对话级放行（D73 P2 后续：egress 卡的「本对话内一直允许」与 bash 通道的
-- 「本对话内相同命令」）。用户在 `egress` 卡上选择更长时长时由网关写入；`scope` 为
-- 'all'（本对话所有外发通道）或 'cmd:<sha256(命令原文)>'（仅沙箱命令通道的同一命令）。
-- 有效期 `expires_at` 取批准时刻的污点窗口到期时间：应用数据再次读取（污点置位 / 续期，
-- TaintService.mark）会清掉该对话的全部放行并重新出卡，放行不会越过任何一个污点窗口。只存 id，不设外键：对话删除由
-- domain/lifecycle.ts 经 TaintService.deleteForConversation 一并清理，其余由
-- sweepExpired 回收。
CREATE TABLE egress_allows (
  conversation_id TEXT NOT NULL,
  scope           TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, scope)
);
CREATE INDEX egress_allows_expires ON egress_allows(expires_at);
