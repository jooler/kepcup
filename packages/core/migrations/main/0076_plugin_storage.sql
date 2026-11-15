-- 插件运行时 KV（D125 P2，docs/design/61-plugin-runtime-platform.md §4 host.storage /
-- §3.3 配额）：每插件一张小 KV，值必须是 JSON 兼容数据（敏感数据走 secrets）。
--
-- 新表（非重建先例）：无外键——builtin 只读目录插件不在 plugins 表，加 FK 会让它们的
-- storage 写入直接失败（与 DEV-112 的实例面同根边界）；卸载 / 回滚由注册表 teardown
-- 钩子调用能力桥 clearStorage 清理，配额（10MB/插件）由能力桥写前聚合校验。
CREATE TABLE plugin_storage (
  plugin_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
