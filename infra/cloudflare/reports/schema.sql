-- KepCup AI 内容举报（Microsoft Store 11.16，方案 todo/ai-content-reporting.md §7.3）。
-- Cloudflare D1 (SQLite)。Apply with:
--   npx wrangler d1 execute kepcup-reports --remote --file=./schema.sql
-- 表 / 索引 / 列名与 core 侧迁移（§6.1 report_outbox 等）字段对齐，不要自行改名。
-- 全新库一次执行即可；与 registry/schema.sql 一样使用 IF NOT EXISTS（新库幂等）。

-- 一条已受理的举报。完整结构化 payload 在 payload_json（TEXT，≤128 KiB）；
-- 常用 triage 字段（bot / 模型 / 正文）提升成列，便于 §11.3 的 SQL 直接检索。
CREATE TABLE IF NOT EXISTS reports (
  id              TEXT PRIMARY KEY,             -- rep_...（客户端幂等 id，重试不变）
  client_id       TEXT NOT NULL,                -- localStorage 稳定 id，不是账号
  -- 去重（§5.5）：按 (client_id, hash, bucket) 时间桶窗口；bucket = floor(serverNow / 窗口)，
  -- content 24h、payload 90 天（wrangler.jsonc vars REPORT_*_DEDUPE_MS）。同一桶内重复
  -- 在 §7.4 第 8 步预检丢弃，这里的两条 UNIQUE 是并发兜底（INSERT OR IGNORE 判重）。
  -- 窗口改小 / 设 0（永久去重）只需改 vars：bucket 由服务端时间计算，schema 不变。
  content_hash    TEXT NOT NULL,                -- sha256 小写 hex（§5.4）
  content_bucket  INTEGER NOT NULL,
  payload_hash    TEXT NOT NULL,
  payload_bucket  INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','triaged','actioned','dismissed')),
  bot_id          TEXT,
  bot_name        TEXT,
  model_provider  TEXT,                         -- bot.runtime.model 首段（"openai/gpt-5.1" → "openai"）
  model_id        TEXT,                         -- bot.runtime.model 其余部分
  message_kind    TEXT NOT NULL,                -- 'text' | 'card'
  -- 清洗后的正文（text）或卡片 JSON（card）；便于 SQL 直接 triage，完整结构在 payload_json。
  message_text    TEXT NOT NULL,
  app_version     TEXT,                         -- client.appVersion
  platform        TEXT,                         -- client.platform
  source_kind     TEXT NOT NULL,                -- 'local' | 'team'
  received_at     INTEGER NOT NULL,             -- 服务端受理时间（ms）；保留期按它算
  -- 原始 IP 不落库：CF-Connecting-IP 经 IP_HASH_SALT HMAC-SHA256 后存这里，仅用于限流。
  ip_hash         TEXT,
  payload_json    TEXT NOT NULL,                -- 原样收到的完整 payload（含正文，静态加密）
  note            TEXT,                         -- admin 处置备注（PATCH 写入）
  updated_at      INTEGER,                      -- admin 最后一次 PATCH 时刻
  UNIQUE (client_id, content_hash, content_bucket),
  UNIQUE (client_id, payload_hash, payload_bucket)
);
CREATE INDEX IF NOT EXISTS reports_received ON reports(received_at DESC);
CREATE INDEX IF NOT EXISTS reports_status   ON reports(status, received_at DESC);
CREATE INDEX IF NOT EXISTS reports_client   ON reports(client_id, received_at DESC);

-- 客户端限流（§7.5）：受理成功才写；条件 upsert（src/db.ts，SQL 与方案逐字一致）
-- 保证「去重先于限流」的重复点击不推进 last_at。保留期：cron 删除 last_at <
-- now-24h 的行（限流窗口 1 分钟，1 天的旧行毫无用处；§7.3 注释口径为 1 天）。
CREATE TABLE IF NOT EXISTS report_rate (
  client_id  TEXT PRIMARY KEY,
  last_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS report_rate_age ON report_rate(last_at);

-- IP 粗限流：固定 1 小时窗口计数（REPORT_IP_LIMIT / REPORT_IP_WINDOW_MS）。
-- 只存 HMAC(ip_hash)，永不存原始 IP（§8）。
CREATE TABLE IF NOT EXISTS report_ip_rate (
  ip_hash       TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,               -- floor(now / window) * window（ms）
  count         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS report_ip_rate_age ON report_ip_rate(window_start);

-- PoW 单次使用表（反滥用任务 5A）：challenge_id = sha256(完整 challenge 字符串)。
-- INSERT OR IGNORE 判重；changes=0 且已存 report_id === 本次 reportId → 放行
-- （崩溃重发幂等），否则 challenge_reused（防预解算池重放）。
-- 清理：cron 删 used_at < now-1d 的行（challenge TTL 只有 10 分钟，1 天绰绰有余）。
CREATE TABLE IF NOT EXISTS report_pow_used (
  challenge_id  TEXT PRIMARY KEY,
  report_id     TEXT NOT NULL,
  used_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS report_pow_used_age ON report_pow_used(used_at);

-- 全局日上限（反滥用任务 5A）：按 UTC 日期计数的受理总数（REPORT_DAILY_LIMIT，
-- 默认 2000；超过 → 429 + Retry-After 至次日 UTC）。去重先于计数：duplicate
-- 不占额度。day 用 'YYYY-MM-DD'，字典序即时间序；cron 删 day < now-7d 的行。
CREATE TABLE IF NOT EXISTS report_daily (
  day    TEXT PRIMARY KEY,
  count  INTEGER NOT NULL DEFAULT 0
);
