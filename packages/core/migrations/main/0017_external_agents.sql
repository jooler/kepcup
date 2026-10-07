-- 外部智能体引擎（D72，docs/design/28-external-agents-acp.md）。
--
-- 1) approvals.kind 新增 'agent_tool'（外部智能体原生工具的权限请求，以及
--    子类型 config：project 内 Agent 侧配置文件的首次运行确认）。SQLite 不能
--    修改 CHECK 约束，按 0010 / 0015 / 0016 的标准流程重建 approvals（无被
--    引用外键，重建安全）。kind 列表以 0016 为准全部带上。
CREATE TABLE approvals_new (
  id              TEXT PRIMARY KEY,       -- apr_...
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'profile_change',
                    'skill_preset', 'mcp_tool', 'butler_proposal',
                    'agent_tool')),
  bot_id          TEXT,
  conversation_id TEXT,
  run_id          TEXT,
  payload_json    TEXT NOT NULL,          -- 各类请求的内容（路径、命令、原因……）
  status          TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'failed')),
  decision_json   TEXT,                   -- 例如 { duration: 'once' | 'conversation' } / { error: '…' } / { selection: [...] }
  auto_approved   INTEGER NOT NULL DEFAULT 0,  -- 无人值守模式自动批准
  message_id      TEXT,                   -- 对话中的卡片消息
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);

INSERT INTO approvals_new (id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, message_id, created_at, decided_at)
  SELECT id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, message_id, created_at, decided_at FROM approvals;

DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;

CREATE INDEX approvals_pending ON approvals(status, conversation_id);

-- 2) agent_sessions：外部智能体会话复用（P5 使用，本迁移一并建表）。每个
--    (Bot, 对话, Agent) 至多一条；fingerprint 覆盖会话级参数（提示词、能力
--    集合、桥 server 名、档位……），变化即新建会话。只存 id，不设外键 /
--    CASCADE：对话 / Bot 删除时由 lifecycle 清理。
CREATE TABLE agent_sessions (
  id                TEXT PRIMARY KEY,     -- ags_...
  bot_id            TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  agent_id          TEXT NOT NULL,        -- 目录 id（如 claude-acp）
  agent_session_id  TEXT NOT NULL,        -- Agent 侧 sessionId
  fingerprint       TEXT NOT NULL,
  last_run_id       TEXT,
  last_used_at      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX agent_sessions_key ON agent_sessions(bot_id, conversation_id, agent_id);
