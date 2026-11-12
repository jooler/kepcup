-- D123: declared task write domains (`start_task.writes` as a glob array).
-- JSON string[]; NULL = undeclared (interpreted through task_writes).
ALTER TABLE runs ADD COLUMN task_write_domains TEXT;
