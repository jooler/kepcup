-- Bot 分类（bot.kind）：初始化访谈中由对话 LLM 根据用户回答设置。
-- 内置分类是稳定 id（见 shared/domain/bot-kind.ts）：coding / writing / data /
-- marketing / research / design / operations / life / general；内置都不合适时
-- 允许一个短的自定义分类。NULL = 未分类（旧行、管家提议、模板导入等非访谈
-- 路径无需回填；消费方回退到画像关键词判断）。
ALTER TABLE bots ADD COLUMN kind TEXT;
