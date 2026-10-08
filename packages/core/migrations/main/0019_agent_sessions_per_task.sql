-- 外部智能体会话按任务分（D75，docs/design/30-supervisor-and-tasks.md §8.5）。
--
-- D72 的 agent_sessions 每个 (Bot, 对话, Agent) 至多一行，只适合串行 run；
-- 任务并行后两个外部 Agent 任务会抢同一行（upsert 互相覆盖、指纹复用串会话、
-- 已见记录与桥 token 串用）。改为每个任务独占一行：唯一键加 task_id。
--
-- task_id：'' = 非任务 run 的会话（D72 期的响应 run；SQLite 唯一索引把 NULL
-- 视为互不相同，用 '' 才能让这类行仍按三元组唯一）；非空 = 该任务的会话。
-- continues_task_id 接续时把旧行的 task_id 改为新任务（继承会话）。
--
-- 项目早期不保留旧行（设计 30 §8.5「迁移」）：直接重建，下次 run 新建会话。
-- 表无外键、无被引用，重建安全。
DROP TABLE agent_sessions;

CREATE TABLE agent_sessions (
  id                TEXT PRIMARY KEY,     -- ags_...
  bot_id            TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  agent_id          TEXT NOT NULL,        -- 目录 id（如 claude-acp）
  task_id           TEXT NOT NULL DEFAULT '',  -- 任务 run id；'' = 非任务 run
  agent_session_id  TEXT NOT NULL,        -- Agent 侧 sessionId
  fingerprint       TEXT NOT NULL,
  last_run_id       TEXT,
  last_used_at      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX agent_sessions_key ON agent_sessions(bot_id, conversation_id, agent_id, task_id);
