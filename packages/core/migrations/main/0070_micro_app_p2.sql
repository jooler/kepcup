-- 微应用 P2（D112，设计 55 §4.3 / §8.5 / §9.4 / §10 / §12.3）：
-- 多文件包、结构化集合、上下文摘要、运行时诊断、能力审计。全部 micro_app_* 前缀，
-- 随 widgets 行级联删除（外键）；诊断另按天 / 版本修剪。

CREATE TABLE micro_app_files (
  widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  version   INTEGER NOT NULL,
  path      TEXT NOT NULL,
  mime      TEXT NOT NULL,
  bytes     INTEGER NOT NULL,
  content   BLOB NOT NULL,
  PRIMARY KEY (widget_id, version, path)
);

CREATE TABLE micro_app_collections (
  widget_id  TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  id         TEXT NOT NULL,
  doc_json   TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (widget_id, name, id)
);

-- context.update 的结构化摘要（55 §8.5）：last-wins，不进消息列表；
-- 注入模型上下文时包 <untrusted source="micro-app-context">。
CREATE TABLE micro_app_context (
  widget_id      TEXT PRIMARY KEY REFERENCES widgets(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  version        INTEGER NOT NULL,
  headline       TEXT NOT NULL,
  data_json      TEXT NOT NULL DEFAULT '{}',
  updated_at     INTEGER NOT NULL
);
CREATE INDEX micro_app_context_conversation ON micro_app_context(conversation_id);

-- 运行时诊断（55 §9.4）：只记 code / 阶段 / 位置 / 次数，不记 message 与任何内容。
CREATE TABLE micro_app_diagnostics (
  widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  version   INTEGER NOT NULL,
  day       TEXT NOT NULL,            -- YYYY-MM-DD（本地时区）
  phase     TEXT NOT NULL,            -- prepare | run | stream
  code      TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '', -- 栈顶帧（文件:行:列）或方法名，≤200 字
  count     INTEGER NOT NULL DEFAULT 0,
  first_at  INTEGER NOT NULL,
  last_at   INTEGER NOT NULL,
  PRIMARY KEY (widget_id, version, day, phase, code)
);

-- 能力审计（55 §12.3）：只记能力与结果，不记内容。
CREATE TABLE micro_app_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  widget_id   TEXT NOT NULL,
  version     INTEGER NOT NULL,
  instance_id TEXT NOT NULL DEFAULT '',
  capability  TEXT NOT NULL,
  outcome     TEXT NOT NULL,          -- ok | denied | error | revoked
  duration_ms INTEGER NOT NULL DEFAULT 0,
  at          INTEGER NOT NULL
);
CREATE INDEX micro_app_audit_widget ON micro_app_audit(widget_id, at);
