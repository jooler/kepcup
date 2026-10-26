-- 看板卡片「先定时间、后指派执行者」：schedules 行强依赖 bot + 会话，未指派时
-- 排期无处落。pending_when 只记用户已定的 when（ISO / cron，写入前已校验），
-- todo 停在 draft；指派完成时 TodoService 依据它真正建排期。null = 未设置。
ALTER TABLE todos ADD COLUMN pending_when TEXT;
