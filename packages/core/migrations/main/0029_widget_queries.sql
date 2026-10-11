-- Bot 自制交互组件 P2（D81，docs/design/32-bot-widgets.md §6）：命名只读查询模板。
-- 模板随版本登记（版本 = HTML + 查询的完整快照，只增不改，旧卡永远用旧模板）；
-- 运行时组件只能按名字调用本版本登记的模板，core prepare 后校验 readonly 且要求
-- 首关键词为 SELECT/WITH（pragma / attach 即使 stmt.readonly=true 也进不来），运行时
-- 输入只有参数、没有 SQL——免审批的唯一理由是 SQL 在 widget_create / widget_update
-- 时随版本被人工预审（审查态「查看源码」可见全文）。
CREATE TABLE widget_queries (
  widget_id  TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  sql        TEXT NOT NULL,
  PRIMARY KEY (widget_id, version, name)
);

-- 审查指纹必须覆盖查询模板：渲染端的按版本确认记忆以「html sha256 + 查询摘要」为
-- 指纹——HTML 不变、仅 queries 变化的新版本同样要求重新确认。旧版本行缺省空串。
ALTER TABLE widget_versions ADD COLUMN queries_sha256 TEXT NOT NULL DEFAULT '';
