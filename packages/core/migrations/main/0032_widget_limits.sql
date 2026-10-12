-- Bot 自制交互组件审查修复（D81，docs/design/32-bot-widgets.md §3 / §6）。
--
-- size_bytes：版本 HTML 的 UTF-8 字节数，写入时由 WidgetService 记录。管理列表与
-- 每 Bot 字节配额只读这一列，不再为取体积把最多 2MB 的 html 读出来
-- （length(cast(html as blob)) 会物化整段文本）。存量行在这里一次性回填。
ALTER TABLE widget_versions ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE widget_versions SET size_bytes = length(cast(html as blob));

-- queries_reviewed_at：含查询模板的版本被用户在审查态展开过 SQL 全文（widgets.ui.source）
-- 的时间。core 的 open 对「有模板但未展开过」的版本拒绝加载（WIDGET_REVIEW_REQUIRED），
-- 预审由 core 强制，而不只是渲染端的按钮门控。存量行保持 NULL：已确认过的含查询
-- 卡片需要再展开一次源码（安全方向的一次性代价）。无模板的版本不看这一列。
ALTER TABLE widget_versions ADD COLUMN queries_reviewed_at INTEGER;
