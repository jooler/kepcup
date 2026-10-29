-- Project plugin overlays (D105, todo/plugin-platform README §4.2):
-- membership is additive authorization INSIDE this project's conversations/tasks only
-- (a member bot's effective set = its own plugin_ids ∪ this table's rows).

CREATE TABLE project_plugins (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  plugin_id       TEXT NOT NULL,
  PRIMARY KEY (conversation_id, plugin_id)
);
