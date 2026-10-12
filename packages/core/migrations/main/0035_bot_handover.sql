-- Bot 资产移交（D88，docs/design/37-bot-asset-handover.md §5.1）。
-- 迁移号暂定：D87 在另一分支也占 0035，合入第二个的一方按 main 实况重排。
--
-- bot_handovers：一次移交提议及其执行状态。新建目标在建好后回填 to_bot_id
-- （new_bot_json 是提议里的新 Bot 字段）。plan_json 是提交时的移交卡 payload 快照。
-- 对话物理删除时级联删除；Bot 删除不删（Bot 行是占位行，id 不复用，记录留作历史）。
CREATE TABLE bot_handovers (
  id               TEXT PRIMARY KEY,           -- hnd_...
  approval_id      TEXT,
  proposer_bot_id  TEXT NOT NULL,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_bot_id      TEXT NOT NULL,
  to_bot_id        TEXT,
  new_bot_json     TEXT,
  status           TEXT NOT NULL CHECK (status IN (
                     'proposed', 'applying', 'completed', 'partial', 'failed', 'denied', 'cancelled')),
  plan_json        TEXT NOT NULL,
  -- 结果已通知发起方的时间（NULL = 还没通知：崩溃在结算与通知之间时，启动恢复补发）。
  notified_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX bot_handovers_approval ON bot_handovers(approval_id);
CREATE INDEX bot_handovers_status ON bot_handovers(status);

-- 每项资产一行，(handover_id, key) 是幂等键：执行前查状态，done 跳过。
-- asset_type 不设 CHECK：后续期的适配器（watch / skill / memory / wiki / widget）与
-- 宿主内部条目（responsibilities / note）共用此表。
CREATE TABLE bot_handover_items (
  handover_id  TEXT NOT NULL REFERENCES bot_handovers(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  asset_type   TEXT NOT NULL,
  action       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  error        TEXT,
  result_json  TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (handover_id, key)
);

-- approvals.kind 增加 bot_handover。SQLite 不能改 CHECK，按 0031 重建。
CREATE TABLE approvals_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'access', 'unsandboxed', 'command', 'git_remote',
                    'environment', 'skill_import', 'profile_change',
                    'skill_preset', 'mcp_tool', 'butler_proposal',
                    'agent_tool', 'egress', 'mail_send', 'bot_handover')),
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
