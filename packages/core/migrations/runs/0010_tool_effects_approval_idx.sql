-- W4 审批回执（todo/borrowings-from-personal-agents.md W4 复查后修正）：审批卡按
-- approval_id 反查台账行（ToolEffectsStore.forApprovals，批量；approval.created /
-- resolved 事件每次一条）。部分索引：大多数台账行没有审批。
CREATE INDEX IF NOT EXISTS tool_effects_by_approval
  ON tool_effects(approval_id) WHERE approval_id IS NOT NULL;
