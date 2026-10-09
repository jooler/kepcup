-- 委派 intent + 跟随任务（D71 修订，todo/borrowings-from-personal-agents.md W6；
-- DEV-012 方案二按 2026-10-09 用户决定改为「各任务结果摘要拼接」）。
--
-- 1) status 新增 'awaiting_tasks'：B 的委派对话轮已结束、正在等它在该轮
--    派出的任务（runs.origin_run_id = run_id）结算。SQLite 不能修改 CHECK
--    约束，按 0016 的写法重建 delegations（无外键指向它，重建安全；对话 /
--    消息 / run 只存 id）。
-- 2) intent：'request' | 'question' | 'fyi'（不加 CHECK，由 zod 校验）。旧行
--    一律 'request'——在途的旧委派 task_ids_json 为空，照旧取对话轮回复。
-- 3) task_ids_json：跟随中的任务 id（JSON 数组；顺着续接链更新为最新一环）。
CREATE TABLE delegations_new (
  id                    TEXT PRIMARY KEY,       -- dlg_...
  from_bot_id           TEXT NOT NULL,
  to_bot_id             TEXT NOT NULL,
  from_conversation_id  TEXT NOT NULL,
  to_conversation_id    TEXT,                   -- B 私聊；投递时解析
  task_text             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
                          'submitted', 'working', 'awaiting_tasks',
                          'completed', 'failed', 'cancelled')),
  depth                 INTEGER NOT NULL DEFAULT 1,
  from_run_id           TEXT,                   -- A 发起委派的 run
  sent_message_id       TEXT,                   -- A 侧发出卡
  to_message_id         TEXT,                   -- B 侧代发用户消息（「查看原文」）
  run_id                TEXT,                   -- B 侧响应 run（投递时回填）
  result_excerpt        TEXT,
  result_message_id     TEXT,                   -- B 的终回复消息
  result_card_id        TEXT,                   -- A 侧结果卡
  error_text            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  intent                TEXT NOT NULL DEFAULT 'request',
  task_ids_json         TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO delegations_new (id, from_bot_id, to_bot_id, from_conversation_id, to_conversation_id, task_text, status, depth, from_run_id, sent_message_id, to_message_id, run_id, result_excerpt, result_message_id, result_card_id, error_text, created_at, updated_at)
  SELECT id, from_bot_id, to_bot_id, from_conversation_id, to_conversation_id, task_text, status, depth, from_run_id, sent_message_id, to_message_id, run_id, result_excerpt, result_message_id, result_card_id, error_text, created_at, updated_at FROM delegations;

DROP TABLE delegations;
ALTER TABLE delegations_new RENAME TO delegations;

CREATE INDEX delegations_to_bot_status ON delegations(to_bot_id, status);
CREATE INDEX delegations_run ON delegations(run_id);
CREATE INDEX delegations_from_conversation ON delegations(from_conversation_id);
CREATE INDEX delegations_status ON delegations(status);
