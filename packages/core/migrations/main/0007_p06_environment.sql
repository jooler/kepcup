-- P06 environment manager (docs/dev/03-data-model.md "env_installs", verbatim).
CREATE TABLE env_installs (
  id           TEXT PRIMARY KEY,
  item         TEXT NOT NULL,             -- 例如 python、node、git、uv、embedding-model
  version      TEXT NOT NULL,
  rel_path     TEXT NOT NULL,             -- 相对 toolchains/
  size_bytes   INTEGER,
  status       TEXT NOT NULL CHECK (status IN ('installing', 'installed', 'failed', 'removed')),
  requested_by TEXT,                      -- bot id
  approval_id  TEXT,
  installed_at INTEGER,
  last_used_at INTEGER
);
