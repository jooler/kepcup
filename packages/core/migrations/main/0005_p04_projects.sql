-- P04 Project (docs/dev/03-data-model.md "projects", "run_changes")
CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,   -- prj_...
  path                TEXT NOT NULL UNIQUE,  -- realpath
  name                TEXT NOT NULL,
  protect_rules_json  TEXT NOT NULL,      -- { denyRead: string[], denyWrite: string[] }（glob）
  allowed_ports_json  TEXT,               -- null 表示不限
  status              TEXT NOT NULL CHECK (status IN ('available', 'missing')),
  created_at          INTEGER NOT NULL,
  last_used_at        INTEGER NOT NULL
);

CREATE TABLE run_changes (
  run_id          TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT,
  before_oid      TEXT NOT NULL,          -- 影子仓库中的提交
  after_oid       TEXT,
  files_json      TEXT,                   -- [{ path, change: 'added'|'modified'|'deleted' }]
  reverted_at     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX run_changes_by_conversation ON run_changes(conversation_id);
