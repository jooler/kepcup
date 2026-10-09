-- 连接应用（D73 P0，docs/design/29-connected-apps.md §12）：应用连接表。
--
-- 一行 = 一个账号对一个 Connector（目录应用或自定义 MCP server）的授权。
-- 自定义 MCP server 的连接 id 与 connector_id 同为 'custom:{serverId}'（每个自定义
-- server 唯一一行）；自定义行断开时**不删除**（status 置 'not_connected'），只随
-- mcp.removeServer 删除。
--
-- 令牌等机密不在此表：access / refresh token 与 OAuth 客户端 id / secret 逐值存
-- secrets 表（conn:{id}:access|refresh、oauth:client:{issuerHash}:id|secret，见
-- core/apps/token-vault.ts）。这里只放非机密元数据（token_expires_at、scopes、
-- discovery_json、issuer）。
-- status 取值由 zod（appConnectionStatusSchema）校验，不加 CHECK，便于状态机演进。
CREATE TABLE app_connections (
  id               TEXT PRIMARY KEY,         -- conn_xxx；自定义 server 为 custom:{serverId}
  connector_id     TEXT NOT NULL,            -- 目录清单 name；自定义为 custom:{serverId}
  connector_ver    TEXT,                     -- 自定义应用为 NULL
  label            TEXT NOT NULL,            -- 账号显示名（可改）
  account_sub      TEXT,                     -- 账号稳定标识（id_token sub 等），用于去重
  server_url       TEXT,                     -- stdio 自定义 server 为 NULL
  issuer           TEXT,                     -- 授权服务器 issuer
  scopes           TEXT NOT NULL DEFAULT '', -- 已授予 scope，空格分隔
  token_expires_at INTEGER,                  -- access token 到期（epoch ms，非机密）
  discovery_json   TEXT,                     -- 发现结果缓存（OAuthServerInfo）
  status           TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_used_at     INTEGER
);

-- 同一 Connector 下同一账号只保留一个连接（account_sub 未知时不参与去重）。
CREATE UNIQUE INDEX app_connections_account
  ON app_connections(connector_id, account_sub) WHERE account_sub IS NOT NULL;
CREATE INDEX app_connections_connector ON app_connections(connector_id);

-- OAuth 客户端的非机密元数据，按 issuer 一行（跨该 issuer 的所有连接共享）。
-- client id / secret 本身仍逐值存 secrets（oauth:client:{issuer_hash}:id|secret）；
-- 这里只记来源与已登记的 redirect_uris：
--   source = 'dcr'（运行时动态注册，最后一个引用它的连接断开后清除）、
--            'manual'（用户手填）、'preregistered'（随应用发布的预注册客户端）；
--   redirect_uris = JSON 数组，DCR 时据此在打开浏览器前预判本次回调端口是否已登记。
-- CIMD 客户端的 client_id 是常量，不落此表。
CREATE TABLE oauth_clients (
  issuer_hash   TEXT PRIMARY KEY,            -- sha256(issuer) hex 前 24 位
  issuer        TEXT NOT NULL,
  source        TEXT NOT NULL,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
