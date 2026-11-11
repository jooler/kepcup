-- 任务失败自动重试（TASK_AUTO_RETRY_DELAYS_MS）：失败任务的已重试次数与
-- 下次重试时刻持久化在 run 行上，应用重启后退避计划照常推进。等待重试的
-- 任务状态回到 `queued`；`task_retry_attempts` 是已执行的自动重试次数。
ALTER TABLE runs ADD COLUMN task_retry_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN task_retry_at INTEGER;
