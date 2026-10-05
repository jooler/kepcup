-- 对话工作路径与群创建（docs/design/19-work-path-and-group-setup.md，D59/D60）：
-- conversations 增群定位描述（description，注入群聊上下文）与创建流程状态
-- （setup_state='creating'，群创建问答进行中，Bot 不被唤醒）。
ALTER TABLE conversations ADD COLUMN description TEXT;
ALTER TABLE conversations ADD COLUMN setup_state TEXT;
