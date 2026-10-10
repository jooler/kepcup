-- 辅助阅读便签（渲染层在消息里选中文本钉出，浮在对话容器上层，类 mac
-- stickies）。conversation 作用域只在来源对话显示；global 作用域在所有
-- 对话显示且共享位置与层号。pos_x/pos_y 为对话容器内的左上角（px），
-- NULL = 尚未放置（渲染层取默认落点后回写）。z 是点击置顶的单调层号，
-- 值大者在上。删除对话时随 conversations 行 FK 级联删除（含 global：
-- 来源对话是便签的所有者）。
CREATE TABLE stickies (
  id              TEXT PRIMARY KEY,       -- stc_...
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL CHECK (scope IN ('conversation', 'global')),
  text            TEXT NOT NULL,
  pos_x           INTEGER,
  pos_y           INTEGER,
  z               INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX stickies_conversation ON stickies(conversation_id);
