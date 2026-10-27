-- Plugin system (D104, docs/design/51-plugin-system.md §7).
-- Built-in plugins are read-only app resources and never get a row here.
-- plugin_items is the projection ledger: uninstall / rollback / conflict checks read it.

CREATE TABLE plugins (
  id             TEXT PRIMARY KEY,                       -- 'io.github.alice/doc-tools'
  version        TEXT NOT NULL,
  origin         TEXT NOT NULL CHECK (origin IN ('marketplace','local')),
  tier           TEXT NOT NULL CHECK (tier IN ('verified','community','developer')),
  state          TEXT NOT NULL CHECK (state IN ('installing','installed','uninstalling')),
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  package_sha256 TEXT NOT NULL,
  marketplace    TEXT,                                   -- source endpoint; marketplace origin only
  dir            TEXT NOT NULL,                          -- relative to {home}/plugins: '{ns}/{name}@{version}'
  installed_at   INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK ((origin = 'marketplace') = (marketplace IS NOT NULL)),
  CHECK ((origin = 'local') = (tier = 'developer'))
);

CREATE TABLE plugin_items (
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('skill','connector','mcp','mail','disabled_connection')),
  ref       TEXT NOT NULL,                               -- skill name / connector slug / server id / template id / connection id
  PRIMARY KEY (plugin_id, kind, ref)
);
CREATE INDEX plugin_items_ref ON plugin_items(kind, ref);
