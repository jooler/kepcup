-- 待发送队列下线（直发，docs/design/01-conversation.md 输入与发送）：
-- drafts 表整体废弃；附件不再有草稿预挂阶段，attachments.draft_id 一并删除。
DROP TABLE drafts;
ALTER TABLE attachments DROP COLUMN draft_id;
