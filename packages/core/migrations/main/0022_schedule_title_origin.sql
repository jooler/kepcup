-- 定时任务的自然引导（D80，todo/schedule-nudges.md §3.1）。
--
-- 1) title：给用户看的短名（回执卡 / 提议卡 / 触发消息标签 / 面板）；note
--    仍是到点时给 Bot 的指令。旧行为空串，展示回退到 note 截断。
-- 2) origin：tool（Bot 调 schedule）| offer（用户在提议卡上点了设置）|
--    proposal（管家提议的例行事项）| commitment（承诺联动）。旧行带
--    commitment_id 的回填 commitment，其余 tool。
--
-- 编号：2026-10-09 与 D73 负责会话确认，D73 不再预留，本迁移占 0022。
ALTER TABLE schedules ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE schedules ADD COLUMN origin TEXT NOT NULL DEFAULT 'tool'
  CHECK (origin IN ('tool', 'offer', 'proposal', 'commitment'));
UPDATE schedules SET origin = 'commitment' WHERE commitment_id IS NOT NULL;
