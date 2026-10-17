-- D92 T0-1: D75 "workdir" (a task's execution root directory) is renamed "cwd".
ALTER TABLE runs RENAME COLUMN task_workdir TO task_cwd;
