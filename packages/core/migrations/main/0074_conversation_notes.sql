-- 对话便签（右栏 Bot 详情「便签」tab）：用户手动记录协作中值得留存的信息
-- （启动命令、测试账号等），只在 Bot 与用户的私聊里提供入口。纯用户数据：
-- 不进入 Bot 上下文，也没有对应工具。删除对话时随 conversations 行 FK 级联删除。
CREATE TABLE conversation_notes (
  id              TEXT PRIMARY KEY,       -- note_...
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX conversation_notes_conversation ON conversation_notes(conversation_id, created_at);
