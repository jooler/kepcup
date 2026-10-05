-- P08 Skills (docs/dev/03-data-model.md "skill_library、bot_skills")
CREATE TABLE skill_library (
  id           TEXT PRIMARY KEY,          -- skl_...
  name         TEXT NOT NULL,
  source_url   TEXT NOT NULL,
  commit_oid   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  rel_path     TEXT NOT NULL,             -- skills-library/{name}@{hash}
  scan_json    TEXT NOT NULL,             -- 兼容性、权限声明、依赖、风险
  imported_at  INTEGER NOT NULL,
  UNIQUE (name, content_hash)
);

CREATE TABLE bot_skills (
  bot_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('builtin', 'imported', 'authored')),
  library_id   TEXT REFERENCES skill_library(id),   -- imported 时
  status       TEXT NOT NULL CHECK (status IN ('draft', 'active', 'disabled', 'incompatible')),
  status_reason TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (bot_id, name)
);
