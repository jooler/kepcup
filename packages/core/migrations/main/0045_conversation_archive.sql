-- 会话归档：从对话列表「移除」= 软删（数据全留），通讯录保留条目、可恢复。
--   conversations.archived_at 非空 = 该会话不在对话列表里（消息、执行记录、
--   附件、workspace、项目 wiki 目录全部保留），但仍在通讯录里可恢复。
--   直接删除会话（物理删除）仍是 conversations.delete，入口在项目详情页危险区。
ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
CREATE INDEX conversations_archived
  ON conversations(archived_at) WHERE archived_at IS NOT NULL;
