-- D92 T0-2: the D28 "Project" (a user-chosen directory bound to a conversation) is renamed "workdir".
ALTER TABLE projects RENAME TO workdirs;
ALTER TABLE conversations RENAME COLUMN project_id TO workdir_id;
ALTER TABLE run_changes RENAME COLUMN project_id TO workdir_id;
