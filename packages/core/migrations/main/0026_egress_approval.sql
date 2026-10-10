-- 污点外发控制（D73 P2，docs/design/29-connected-apps.md §8.3 / §12）。
--
-- 1) approvals.kind 新增 'egress'（污点期间 web_fetch / web_search / 浏览器 / 应用与自定义
--    MCP 写工具 / 沙箱 bash / git 远程等外发通道的逐次确认）。SQLite 不能修改 CHECK 约束，
--    按 0010 / 0015 / 0016 / 0017 的标准流程重建 approvals（无被引用外键，重建安全）。
--    kind 列表以 0017 为准（含 agent_tool）；0018–0025 没有再重建过 approvals。
CREATE TABLE approvals_new (
  id              TEXT PRIMARY KEY,       -- apr_...
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'profile_change',
                    'skill_preset', 'mcp_tool', 'butler_proposal',
                    'agent_tool', 'egress')),
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

-- 2) app_taint：某 Bot 在某对话里读取过连接应用数据后进入「污点」状态，24 小时（每次成功读取
--    续期）。按 (Bot, 对话) 计而不按 run 计——runs.retry 的新 run、该对话后续的对话轮与
--    任务都处于同一状态。只存 id，不设外键 / CASCADE：对话删除 / Bot 删除（仅其私聊的行）
--    由 domain/lifecycle.ts 清理，其余行到期后由 sweepExpired 回收。
CREATE TABLE app_taint (
  bot_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  first_at        INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (bot_id, conversation_id)
);
CREATE INDEX app_taint_expires ON app_taint(expires_at);
