-- 对话式新建 Bot（UI 改版）：bots.setup_state 标记「初始化访谈中」的 Bot。
-- 'interviewing' = 系统提示注入访谈指引、setup 专属工具（save_profile /
-- finish_setup）可用；完成访谈后置回 NULL。旧行缺省 NULL，无需回填。
ALTER TABLE bots ADD COLUMN setup_state TEXT;
