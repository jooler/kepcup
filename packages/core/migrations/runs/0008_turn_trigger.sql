-- D75 W2 审查 L3 / L6（docs/design/30-supervisor-and-tasks.md §3.2 / §2.1）：
-- trigger_parts_json：对话轮的触发批按来源分段（合并批的各段 reason /
--   extraAttributes / 消息 id，JSON 数组）。重试失败的对话轮时按段重建触发批，
--   不再压成一个 reason；NULL = 旧行或单段批（按 trigger_reason +
--   trigger_message_ids_json 重建）。
-- retry_of_run_id：重试出来的对话轮指向被重试的那一轮。它派出的任务与被
--   重试的那一轮（及其更早的重试链）派出的同名任务视为同一个，不重复派出。
ALTER TABLE runs ADD COLUMN trigger_parts_json TEXT;
ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT;
