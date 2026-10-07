-- D72 external agent engine (docs/design/28-external-agents-acp.md §7
-- "执行记录"): which engine drove the run ('builtin' | 'agent:{id}') and the
-- agent-side ACP session id (NULL for the built-in engine).
ALTER TABLE runs ADD COLUMN engine TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE runs ADD COLUMN agent_session_id TEXT;
