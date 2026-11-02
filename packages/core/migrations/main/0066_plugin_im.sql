-- kepcup:foreign-keys=off
-- IM 通道（D107，docs/design/54-im-channel.md）：`im` 加入实例能力类型。
-- 两个既有表的 kind CHECK 需要重建表扩枚举（im_alert / im_forward 的作业类型是
-- runs 库的 job_type 文本列，无需迁移）；新表 im_accounts / im_account_bots 与
-- mail 同配方——账号挂插件实例（卸载级联），绑定多对多且带 D111 转发开关。
--
-- plugin_items 重建：与 0053 表头一致（主键 (plugin_id, kind, ref) + ref 索引），
-- 只扩 kind CHECK。
CREATE TABLE plugin_items_new (
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('skill','connector','mcp','mail','im','disabled_connection')),
  ref       TEXT NOT NULL,
  PRIMARY KEY (plugin_id, kind, ref)
);
INSERT INTO plugin_items_new (plugin_id, kind, ref) SELECT plugin_id, kind, ref FROM plugin_items;
DROP TABLE plugin_items;
ALTER TABLE plugin_items_new RENAME TO plugin_items;
CREATE INDEX plugin_items_ref ON plugin_items(kind, ref);

-- plugin_instances 重建：与 0056 表头一致（无附加索引 / 触发器），只扩 kind CHECK。
CREATE TABLE plugin_instances_new (
  id          TEXT PRIMARY KEY,                       -- 'pli_…'
  plugin_id   TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('mail','mcp','im')),
  title       TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
INSERT INTO plugin_instances_new (id, plugin_id, kind, title, config_json, created_at, updated_at)
  SELECT id, plugin_id, kind, title, config_json, created_at, updated_at FROM plugin_instances;
DROP TABLE plugin_instances;
ALTER TABLE plugin_instances_new RENAME TO plugin_instances;

-- IM 账号（54 §3）：一个实例 = 一个 IM 账号。config_json 只放非敏感会话元数据
-- （ilink_bot_id、登录时间、getUpdates 游标）；bot_token 在实例 secrets。
CREATE TABLE im_accounts (
  id               TEXT PRIMARY KEY,                    -- 'ima_…'
  instance_id      TEXT NOT NULL REFERENCES plugin_instances(id) ON DELETE CASCADE,
  transport        TEXT NOT NULL CHECK (transport IN ('ilink','wecom-app','telegram-bot','webhook')),
  api_base         TEXT NOT NULL,
  label            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('connecting','ready','paused','auth_failed','error')),
  last_error       TEXT,
  last_inbound_at  INTEGER,
  last_outbound_at INTEGER,
  config_json      TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX im_accounts_instance ON im_accounts(instance_id);

-- 绑定（多对多）+ D111「同步消息到此微信」转发开关：绑定即入站，勾选才出站，
-- 永不自动取消；forward_updated_at 供排障。alerts_paused / alert_times_json 同
-- mail 的风暴护栏口径。bot_id 不挂 FK（同 0031 mail_account_bots）：Bot 删除时
-- 由服务层清绑定（与 mail 同一路径）。
CREATE TABLE im_account_bots (
  account_id          TEXT NOT NULL REFERENCES im_accounts(id) ON DELETE CASCADE,
  bot_id              TEXT NOT NULL,
  forward_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (forward_enabled IN (0,1)),
  forward_updated_at  INTEGER,
  alerts_paused       INTEGER NOT NULL DEFAULT 0 CHECK (alerts_paused IN (0,1)),
  alert_times_json    TEXT NOT NULL DEFAULT '[]',
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (account_id, bot_id)
);
CREATE INDEX im_account_bots_bot ON im_account_bots(bot_id);
