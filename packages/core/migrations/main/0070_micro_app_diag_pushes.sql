-- 微应用 P2 审查修复（D112，55 §9.4 / Q9）：
-- 1) 诊断推送去重持久化：同 (widget, version, code, day) 当天至多一条系统消息，
--    core 重启 / 标记溢出清空后仍成立（P2 审查 P1-3）；同时用它统计每微应用每天
--    的推送条数上限（审查 P2-1：轮换 code 不能刷屏来源会话）。
CREATE TABLE micro_app_diag_pushes (
  widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  version   INTEGER NOT NULL,
  code      TEXT NOT NULL,
  day       TEXT NOT NULL,            -- YYYY-MM-DD（本地时区）
  pushed_at INTEGER NOT NULL,
  PRIMARY KEY (widget_id, version, code, day)
);
-- 2) micro_app_audit 补外键级联（审查 P2-2）：与 0069 头注「随 widgets 行级联删除」
--    对齐。SQLite 不能对既有表补约束，重建并迁移存量行。
CREATE TABLE micro_app_audit_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  widget_id   TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  instance_id TEXT NOT NULL DEFAULT '',
  capability  TEXT NOT NULL,
  outcome     TEXT NOT NULL,          -- ok | denied | error | revoked
  duration_ms INTEGER NOT NULL DEFAULT 0,
  at          INTEGER NOT NULL
);
INSERT INTO micro_app_audit_new (widget_id, version, instance_id, capability, outcome, duration_ms, at)
  SELECT widget_id, version, instance_id, capability, outcome, duration_ms, at FROM micro_app_audit;
DROP TABLE micro_app_audit;
ALTER TABLE micro_app_audit_new RENAME TO micro_app_audit;
CREATE INDEX micro_app_audit_widget ON micro_app_audit(widget_id, at);
