-- 按工具的任务上下文消耗（估算口径）：一次工具调用一行。
-- call_tokens = 工具参数（模型输出侧）；result_tokens = 工具返回内容（输入侧）。
-- 仅记录 loop_type='task'；不是计费 token，不随重发次数放大。
CREATE TABLE tool_usage_ledger (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  bot_id          TEXT,
  conversation_id TEXT,
  loop_type       TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  call_tokens     INTEGER NOT NULL DEFAULT 0,
  result_tokens   INTEGER NOT NULL DEFAULT 0,
  calls           INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);
CREATE INDEX tool_usage_by_day ON tool_usage_ledger(created_at);
