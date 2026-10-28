-- Plugin instances & plugin config (D105, todo/plugin-platform README §4.2).
-- plugin_instances: user-created capability units (邮箱账号 first — mail lands P3);
-- sensitive values live in secrets, config_json holds the non-sensitive rest.
-- plugins.config_json: non-sensitive plugin-level config (manifest config.fields).

CREATE TABLE plugin_instances (
  id          TEXT PRIMARY KEY,                       -- 'pli_…'
  plugin_id   TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('mail','mcp')),
  title       TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

ALTER TABLE plugins ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
