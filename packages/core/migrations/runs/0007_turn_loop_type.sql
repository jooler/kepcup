-- D75 W2（docs/design/30-supervisor-and-tasks.md §2.1 / §10.2）：loop_type
-- 'response' 改名为 'turn'（对话轮），不保留别名。只改既有行的取值，让旧库
-- 的执行记录仍能通过 runs.list 的输出校验。
UPDATE runs SET loop_type = 'turn' WHERE loop_type = 'response';
