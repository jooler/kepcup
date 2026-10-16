-- D91 能力目录与按需挂载（design 40 §4.1）：任务声明要用的外部能力（`start_task.capabilities`，
-- 目录里的能力 id 如 `app:github` / `mcp:{serverId}`）。JSON 数组；非任务 run 与未声明的任务为 NULL。
-- 任务启动时只解析、只挂这些能力的工具；重试沿用行上已存的声明。
ALTER TABLE runs ADD COLUMN task_capabilities TEXT;
