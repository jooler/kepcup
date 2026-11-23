-- D140 worktree 隔离（todo/agent-autonomy-and-parallel-tasks.md §3.6）：workdir 同级
-- .worktree/ 下执行的 git worktree 任务。三列均可空，旧行 = NULL（未隔离）。
-- task_isolation：NULL | 'worktree'（读路径把坏值归一为 NULL）。
-- task_worktree_path：worktree 根；task_worktree_base：创建起点（stash oid / HEAD），
-- 任务结算后「应用到工作目录」以它为三方合并 base。
ALTER TABLE runs ADD COLUMN task_isolation TEXT;
ALTER TABLE runs ADD COLUMN task_worktree_path TEXT;
ALTER TABLE runs ADD COLUMN task_worktree_base TEXT;
