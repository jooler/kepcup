-- 对话轮与任务分治（D75，docs/design/30-supervisor-and-tasks.md §3.4）：任务
-- 就是 runs 行（loop_type = 'task'），不另建 tasks 表。loop_type 无 CHECK，
-- 只加列。任务的 submitted 用现有状态 queued 表示。
ALTER TABLE runs ADD COLUMN task_title TEXT;            -- start_task 给出的标题（卡片与 <tasks> 段）
ALTER TABLE runs ADD COLUMN task_writes INTEGER;        -- 1 = 写任务（租约与网关裁决），0 = 只读；非任务为 NULL
ALTER TABLE runs ADD COLUMN task_workdir TEXT;          -- 解析后的工作目录
ALTER TABLE runs ADD COLUMN origin_run_id TEXT;         -- 派出它的对话轮
ALTER TABLE runs ADD COLUMN result_consumed_at INTEGER; -- §3.2 消费标记：触发批含其结果条目的对话轮到达终态时写入
ALTER TABLE runs ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0; -- §2.4.6 running 下等待用户输入
CREATE INDEX runs_by_conv_loop_status ON runs(conversation_id, loop_type, status);
