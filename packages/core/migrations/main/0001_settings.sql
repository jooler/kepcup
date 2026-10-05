-- Application settings, keyed JSON values (docs/dev/03-data-model.md "settings").
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
