-- 任务单一状态通知（对话内不堆进度气泡）：只持久化最近一条过程说明；
-- 任务成功交付后清空；取消 / 失败 / 中断保留，便于用户与 Bot 看到停在何处。
ALTER TABLE runs ADD COLUMN last_progress TEXT;
