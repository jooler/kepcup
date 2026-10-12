-- 回收被遗弃的未绑定附件行（D86 待发送队列下线的善后）。
--
-- 0030 直接 DROP 了 drafts 与 attachments.draft_id，队列里尚未发送的消息所挂的附件
-- 行（message_id IS NULL）因此失去唯一的归属者，磁盘上的文件也随之成为孤儿；此前
-- 也没有任何路径回收 message_id IS NULL 的附件（输入框 chip 被遗弃、应用被关闭等）。
--
-- 正在使用的未绑定附件 = 输入框里已上传、尚未发出的 chip，它们可以跨重启保留，
-- 所以不能一刀切：只删创建超过 7 天的（与 core 启动时 AttachmentsService.sweepOrphans
-- 的 UNBOUND_ATTACHMENT_TTL_MS 同值）。已绑定消息的附件（message_id 非空）永不触碰。
-- 这里只删行；对应的磁盘文件由启动时的 sweepOrphans 回收（SQL 迁移碰不到文件系统，
-- 且那一步按「无任何行引用」判定，同样不会误删仍在使用的文件）。
--
-- created_at 为毫秒。0030 已执行过的库里无法再区分「队列遗留」与「普通 chip」，
-- 按年龄统一处理是唯一不会误伤的判据。
DELETE FROM attachments
  WHERE message_id IS NULL
    AND created_at < (CAST(strftime('%s', 'now') AS INTEGER) - 7 * 24 * 3600) * 1000;
