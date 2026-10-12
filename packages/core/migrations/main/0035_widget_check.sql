-- Bot 组件制作流程（D87，docs/design/32-bot-widgets.md §11.12）：交付版本的自检状态。
--
-- check_status：legacy（D87 之前的存量版本，卡片不显示徽标）/ passed（检查全绿且审查无
-- P0/P1）/ issues（无阻断项但有已知问题）/ unverified（没有经过运行验证）。制作 loop 的
-- 交付步骤凭检查回执写入；widget_publish 发出的卡沿用该版本的状态。
-- check_summary_json：检查摘要（GATE / 审查轮数、已知问题 ≤5 条、craftId；不含源码），
-- 存量行为空串。自检只是质量闸——不改变按版本人工确认（§8 第 8 条）。
ALTER TABLE widget_versions ADD COLUMN check_status TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE widget_versions ADD COLUMN check_summary_json TEXT NOT NULL DEFAULT '';
