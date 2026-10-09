-- 连接应用（D73 P1，docs/design/29-connected-apps.md §8.2 / §12）：工具定义锁定与持续授权。
--
-- app_connection_tools：每个 MCP server 连接（目录连接 conn_xxx，或自定义 server 的
-- custom:{serverId}——含无 OAuth 的 stdio / headers server，其行 server_url 可为 NULL）
-- 的工具清单与「已批准定义」。
--   approved_hash NULL = 待复核（新工具）；current_hash != approved_hash = 定义变化待复核；
--   二者都不暴露给模型。风险档 risk 由 W5 分级器 + 目录 toolPolicy 计算后落库，
--   user_policy 是逐工具策略 JSON（与 W5 mcpToolPolicy 同形：{approval?, enabled?}），
--   NULL = 按风险档默认；definition_json 是最近一次 tools/list 的完整定义（供复核 diff 的“新”）；
--   approved_definition_json 是批准当时的定义快照（复核 diff 的“旧”；从未批准为 NULL）。
--   连接行删除时级联删除（目录连接重连时重新复核）。
CREATE TABLE app_connection_tools (
  connection_id   TEXT NOT NULL REFERENCES app_connections(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  approved_hash   TEXT,
  current_hash    TEXT NOT NULL,
  risk            TEXT NOT NULL,
  user_policy     TEXT,
  definition_json TEXT NOT NULL,
  approved_definition_json TEXT,
  PRIMARY KEY (connection_id, tool_name)
);

-- app_tool_grants：写工具的持续授权，键为 (Bot, 连接, 工具)。
--   conversation_id NULL = 对该 Bot 总是允许；非 NULL = 仅在该对话内一直允许。
--   撤销 = 写 revoked_at（保留行作审计）；对话删除时随外键级联；Bot 删除 / 被移出群时
--   由 core 撤销（bot_id 不设外键：删除 Bot 保留占位行）。
CREATE TABLE app_tool_grants (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL,
  connection_id   TEXT NOT NULL REFERENCES app_connections(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  approval_id     TEXT,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);
CREATE INDEX app_tool_grants_live
  ON app_tool_grants(bot_id, connection_id, tool_name) WHERE revoked_at IS NULL;
CREATE INDEX app_tool_grants_conversation
  ON app_tool_grants(conversation_id) WHERE conversation_id IS NOT NULL;

-- 存量基线（设计 29 §12 / 执行方案 §5.5）：升级前已存在的自定义 server 的连接行标记为
-- 「首次拉取到的工具直接批准」，之后清零；只作用一次（settings.apps.toolLockBaselineDone）。
ALTER TABLE app_connections ADD COLUMN baseline_pending INTEGER NOT NULL DEFAULT 0;
