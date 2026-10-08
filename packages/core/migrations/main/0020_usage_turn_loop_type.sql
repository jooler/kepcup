-- D75 W2 审查 H1（docs/design/30-supervisor-and-tasks.md §2.1）：loop_type
-- 'response' 已改名 'turn'（runs 0007 只改了 runs.db）。main.db 里存 loop_type
-- 的只有 usage_ledger：旧行仍是 'response' 会让 usage.summary 的输出校验失败，
-- 也会被每日后台预算（usage/budget.ts，排除 'turn' / 'task'）当成后台用量。
UPDATE usage_ledger SET loop_type = 'turn' WHERE loop_type = 'response';
