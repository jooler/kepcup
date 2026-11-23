-- D140（todo/agent-autonomy-and-parallel-tasks.md §3.2）：grants.duration 增 'task'
-- （「本任务内允许」，有效期到该 run 终态，见 grantDurationSchema）；approvals.kind 增
-- 'worktree_apply'（worktree 任务结算后的「应用到工作目录」卡，非阻塞、留对话）。
-- 两处 CHECK 都是封闭枚举，SQLite 不能改 CHECK，按 0031/0036/0062 的标准流程重建。
-- 列与索引不变，旧行原样保留。

-- 1) grants 重建：duration CHECK 增 task
CREATE TABLE grants_new (
  id              TEXT PRIMARY KEY,       -- grt_...
  bot_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,          -- realpath
  access          TEXT NOT NULL CHECK (access IN ('read', 'write')),
  duration        TEXT NOT NULL CHECK (duration IN ('once', 'task', 'conversation')),
  run_id          TEXT,                   -- duration = once / task 时绑定的执行
  approval_id     TEXT,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);
INSERT INTO grants_new (id, bot_id, conversation_id, path, access, duration, run_id, approval_id, created_at, revoked_at)
  SELECT id, bot_id, conversation_id, path, access, duration, run_id, approval_id, created_at, revoked_at FROM grants;
DROP TABLE grants;
ALTER TABLE grants_new RENAME TO grants;
CREATE INDEX grants_active ON grants(conversation_id, bot_id) WHERE revoked_at IS NULL;

-- 2) approvals 重建：kind CHECK 增 worktree_apply（带全部既有 kind，照 0062 的列与索引）
CREATE TABLE approvals_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'profile_change',
                    'skill_preset', 'mcp_tool', 'butler_proposal',
                    'agent_tool', 'egress', 'mail_send', 'bot_handover',
                    'computer_control', 'worktree_apply')),
  bot_id          TEXT,
  conversation_id TEXT,
  run_id          TEXT,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'failed')),
  decision_json   TEXT,
  auto_approved   INTEGER NOT NULL DEFAULT 0,
  message_id      TEXT,
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);
INSERT INTO approvals_new (id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, message_id, created_at, decided_at)
  SELECT id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, message_id, created_at, decided_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
CREATE INDEX approvals_pending ON approvals(status, conversation_id);
