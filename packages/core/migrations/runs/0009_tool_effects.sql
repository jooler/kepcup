-- 外部副作用台账（W2，todo/borrowings-from-personal-agents.md；D78，D67 durable
-- journal 的第一步）：有外部副作用的工具调用「执行前写、结束后结」，崩溃 / 中断 /
-- 重试时据此回答「哪些动作可能已经发生了」。只记账、不续跑。
-- effect_key = runId:tool:sha256(stableJson(脱敏参数))[:16]:occurrence；
-- summary 已脱敏、≤200 字；approval_id 指向 main.approvals.id（跨库，无外键）。
-- 启动恢复把 executing 行改为 uncertain（进程已不在，结果未知）。
CREATE TABLE tool_effects (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id  TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  effect_key    TEXT NOT NULL,
  args_hash     TEXT NOT NULL,
  summary       TEXT NOT NULL,
  approval_id   TEXT,
  status        TEXT NOT NULL CHECK (status IN (
                  'intended', 'executing', 'completed', 'failed', 'uncertain', 'denied')),
  receipt_json  TEXT,
  created_at    INTEGER NOT NULL,
  settled_at    INTEGER,
  UNIQUE (run_id, tool_call_id)
);
CREATE INDEX tool_effects_by_run ON tool_effects(run_id, created_at);
CREATE INDEX tool_effects_by_key ON tool_effects(effect_key);
-- effects.list 沿续接链收集 SubAgent 子 run（ToolEffectsStore.chainRunIds 按
-- parent_run_id 查）。
CREATE INDEX IF NOT EXISTS runs_by_parent ON runs(parent_run_id);
