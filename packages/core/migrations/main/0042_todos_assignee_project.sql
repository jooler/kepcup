-- D92 T1a: workbench todos assigned to a "group" are now assigned to a "project".
ALTER TABLE todos RENAME COLUMN assignee_group_id TO assignee_project_id;
