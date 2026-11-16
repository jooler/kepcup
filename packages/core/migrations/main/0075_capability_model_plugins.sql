-- kepcup:foreign-keys=off
-- 能力模型插件化（D124，docs/design/60-capability-model-plugins.md §3）：实例能力类型
-- 增 'capability-model'（实例 = 厂商账号，凭据入 secrets，与 mail / mcp / im 同配方）；
-- usage_ledger 增条目维度两列供记账审计（均 nullable 无默认值，旧行读出 NULL）。
--
-- plugin_items 重建：与 0053/0066 表头一致（主键 (plugin_id, kind, ref) + ref 索引），
-- 只扩 kind CHECK。
CREATE TABLE plugin_items_new (
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('skill','connector','mcp','mail','im','capability-model','disabled_connection')),
  ref       TEXT NOT NULL,
  PRIMARY KEY (plugin_id, kind, ref)
);
INSERT INTO plugin_items_new (plugin_id, kind, ref) SELECT plugin_id, kind, ref FROM plugin_items;
DROP TABLE plugin_items;
ALTER TABLE plugin_items_new RENAME TO plugin_items;
CREATE INDEX plugin_items_ref ON plugin_items(kind, ref);

-- plugin_instances 重建：与 0056/0066 表头一致（无附加索引 / 触发器），只扩 kind CHECK。
CREATE TABLE plugin_instances_new (
  id          TEXT PRIMARY KEY,                       -- 'pli_…'
  plugin_id   TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('mail','mcp','im','capability-model')),
  title       TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
INSERT INTO plugin_instances_new (id, plugin_id, kind, title, config_json, created_at, updated_at)
  SELECT id, plugin_id, kind, title, config_json, created_at, updated_at FROM plugin_instances;
DROP TABLE plugin_instances;
ALTER TABLE plugin_instances_new RENAME TO plugin_instances;

-- usage_ledger 扩列（60 §3，决策 9）：一次成功调用记录能力与条目维度，provider 列对
-- 条目调用记插件 id。加列即可（SQLite ADD COLUMN 恒可空），不动既有行。
ALTER TABLE usage_ledger ADD COLUMN capability TEXT;
ALTER TABLE usage_ledger ADD COLUMN model_entry_id TEXT;
