/**
 * D1 statement wrappers (todo/ai-content-reporting.md §7.3 / §7.5). All SQL lives
 * here so the schema contract is greppable in one place; the dedupe/rate statements
 * mirror the §6.1 core migration column-for-column. `changes` from INSERT OR IGNORE /
 * conditional upserts is the concurrency-safe signal (0 = ignored / not applied).
 */

import type {
  ClientRateRow,
  D1Like,
  IpRateRow,
  ReportRow,
  WorkerConfig,
} from './types';

/** §7.5 逐字一致（仅把 60000 换成绑定参数）：changes===0 即限流。 */
export const CLIENT_RATE_UPSERT_SQL = `INSERT INTO report_rate (client_id, last_at) VALUES (?, ?)
  ON CONFLICT(client_id) DO UPDATE SET last_at = excluded.last_at
  WHERE excluded.last_at - report_rate.last_at >= ?`;

const INSERT_REPORT_SQL = `INSERT OR IGNORE INTO reports (
  id, client_id, content_hash, content_bucket, payload_hash, payload_bucket,
  status, bot_id, bot_name, model_provider, model_id, message_kind, message_text,
  app_version, platform, source_kind, received_at, ip_hash, payload_json, note, updated_at
) VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`;

const IP_RATE_UPSERT_SQL = `INSERT INTO report_ip_rate (ip_hash, window_start, count) VALUES (?, ?, 1)
  ON CONFLICT(ip_hash) DO UPDATE SET
    window_start = excluded.window_start,
    count = CASE WHEN report_ip_rate.window_start = excluded.window_start
                 THEN report_ip_rate.count + 1 ELSE 1 END`;

export interface NewReportRow {
  id: string;
  clientId: string;
  contentHash: string;
  contentBucket: number;
  payloadHash: string;
  payloadBucket: number;
  botId: string | null;
  botName: string | null;
  modelProvider: string | null;
  modelId: string | null;
  messageKind: string;
  messageText: string;
  appVersion: string | null;
  platform: string | null;
  sourceKind: string;
  receivedAt: number;
  ipHash: string | null;
  payloadJson: string;
}

// ------------------------------------------------------------------ reports

export async function insertReport(db: D1Like, row: NewReportRow): Promise<number> {
  const result = await db
    .prepare(INSERT_REPORT_SQL)
    .bind(
      row.id,
      row.clientId,
      row.contentHash,
      row.contentBucket,
      row.payloadHash,
      row.payloadBucket,
      row.botId,
      row.botName,
      row.modelProvider,
      row.modelId,
      row.messageKind,
      row.messageText,
      row.appVersion,
      row.platform,
      row.sourceKind,
      row.receivedAt,
      row.ipHash,
      row.payloadJson,
    )
    .run();
  return result.meta?.changes ?? 0;
}

export async function findById(db: D1Like, id: string): Promise<ReportRow | null> {
  return db
    .prepare('SELECT * FROM reports WHERE id = ?')
    .bind(id)
    .first<ReportRow>();
}

export async function findContentDuplicate(
  db: D1Like,
  clientId: string,
  contentHash: string,
  contentBucket: number,
): Promise<{ id: string } | null> {
  return db
    .prepare(
      'SELECT id FROM reports WHERE client_id = ? AND content_hash = ? AND content_bucket = ? LIMIT 1',
    )
    .bind(clientId, contentHash, contentBucket)
    .first<{ id: string }>();
}

export async function findPayloadDuplicate(
  db: D1Like,
  clientId: string,
  payloadHash: string,
  payloadBucket: number,
): Promise<{ id: string } | null> {
  return db
    .prepare(
      'SELECT id FROM reports WHERE client_id = ? AND payload_hash = ? AND payload_bucket = ? LIMIT 1',
    )
    .bind(clientId, payloadHash, payloadBucket)
    .first<{ id: string }>();
}

export interface ReportListParams {
  status: string;
  limit: number;
  /**
   * Keyset pagination cursor: only rows sorting strictly AFTER the cursor under
   * `ORDER BY received_at DESC, id DESC`. The id tiebreak keeps same-millisecond
   * rows from being dropped between pages.
   */
  before: { receivedAt: number; id: string | null } | null;
  clientId: string | null;
}

/** Summary columns only — payload_json stays out of list responses (§7.6). */
const LIST_COLUMNS =
  'id, status, bot_id, bot_name, model_provider, model_id, message_kind, message_text, ' +
  'app_version, platform, source_kind, received_at';

export async function listReports(db: D1Like, params: ReportListParams): Promise<ReportRow[]> {
  const where = ['status = ?'];
  const binds: unknown[] = [params.status];
  if (params.clientId !== null) {
    where.push('client_id = ?');
    binds.push(params.clientId);
  }
  if (params.before !== null) {
    if (params.before.id === null) {
      // Bare-timestamp cursor (backward compatible): rows older than the instant.
      where.push('received_at < ?');
      binds.push(params.before.receivedAt);
    } else {
      // Tuple comparison against (received_at DESC, id DESC).
      where.push('(received_at < ? OR (received_at = ? AND id < ?))');
      binds.push(params.before.receivedAt, params.before.receivedAt, params.before.id);
    }
  }
  // +1 look-ahead so the caller knows whether a nextBefore exists.
  binds.push(params.limit + 1);
  const sql =
    `SELECT ${LIST_COLUMNS} FROM reports WHERE ${where.join(' AND ')} ` +
    'ORDER BY received_at DESC, id DESC LIMIT ?';
  return db.prepare(sql).bind(...binds).all<ReportRow>().then((r) => r.results);
}

export async function updateReport(
  db: D1Like,
  id: string,
  status: string,
  /** undefined = leave the stored note untouched; null clears it. */
  note: string | null | undefined,
  now: number,
): Promise<number> {
  const result =
    note === undefined
      ? await db
          .prepare('UPDATE reports SET status = ?, updated_at = ? WHERE id = ?')
          .bind(status, now, id)
          .run()
      : await db
          .prepare('UPDATE reports SET status = ?, note = ?, updated_at = ? WHERE id = ?')
          .bind(status, note, now, id)
          .run();
  return result.meta?.changes ?? 0;
}

export async function deleteClientData(
  db: D1Like,
  clientId: string,
): Promise<{ reports: number; rateRows: number }> {
  const reports = await db
    .prepare('DELETE FROM reports WHERE client_id = ?')
    .bind(clientId)
    .run();
  const rate = await db
    .prepare('DELETE FROM report_rate WHERE client_id = ?')
    .bind(clientId)
    .run();
  return {
    reports: reports.meta?.changes ?? 0,
    rateRows: rate.meta?.changes ?? 0,
  };
}

export interface ReportStats {
  byStatus: Record<string, number>;
  last7Days: number;
}

export async function stats(db: D1Like, last7DaysCutoff: number): Promise<ReportStats> {
  const byStatusRows = await db
    .prepare('SELECT status, COUNT(*) AS n FROM reports GROUP BY status')
    .all<{ status: string; n: number }>();
  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM reports WHERE received_at >= ?')
    .bind(last7DaysCutoff)
    .first<{ n: number }>();
  const byStatus: Record<string, number> = {};
  for (const row of byStatusRows.results) byStatus[row.status] = row.n;
  return { byStatus, last7Days: recent?.n ?? 0 };
}

// ------------------------------------------------------------------ rate limiting

export async function upsertClientRate(
  db: D1Like,
  clientId: string,
  lastAt: number,
  limitMs: number,
): Promise<number> {
  const result = await db
    .prepare(CLIENT_RATE_UPSERT_SQL)
    .bind(clientId, lastAt, limitMs)
    .run();
  return result.meta?.changes ?? 0;
}

export async function getClientRate(db: D1Like, clientId: string): Promise<ClientRateRow | null> {
  return db
    .prepare('SELECT client_id, last_at FROM report_rate WHERE client_id = ?')
    .bind(clientId)
    .first<ClientRateRow>();
}

/** One statement: window rotation and increment are atomic (§7.5). */
export async function upsertIpRate(
  db: D1Like,
  ipHash: string,
  windowStart: number,
): Promise<void> {
  await db.prepare(IP_RATE_UPSERT_SQL).bind(ipHash, windowStart).run();
}

export async function getIpRate(db: D1Like, ipHash: string): Promise<IpRateRow | null> {
  return db
    .prepare('SELECT ip_hash, window_start, count FROM report_ip_rate WHERE ip_hash = ?')
    .bind(ipHash)
    .first<IpRateRow>();
}

// ------------------------------------------------------------------ cron cleanup

export interface CleanupCounts {
  reports: number;
  clientRate: number;
  ipRate: number;
}

/** Cron (§7.3): retention for reports, stale rate rows. Windows come from config. */
export async function runCleanup(
  db: D1Like,
  config: Pick<WorkerConfig, 'retentionDays' | 'ipWindowMs'>,
  now: number,
): Promise<CleanupCounts> {
  const reportCutoff = now - config.retentionDays * 86_400_000;
  const rateCutoff = now - 86_400_000; // 限流窗口才 1 分钟，1 天前的 last_at 无用
  const ipCutoff = now - config.ipWindowMs;
  const reports = await db
    .prepare('DELETE FROM reports WHERE received_at < ?')
    .bind(reportCutoff)
    .run();
  const clientRate = await db
    .prepare('DELETE FROM report_rate WHERE last_at < ?')
    .bind(rateCutoff)
    .run();
  const ipRate = await db
    .prepare('DELETE FROM report_ip_rate WHERE window_start < ?')
    .bind(ipCutoff)
    .run();
  return {
    reports: reports.meta?.changes ?? 0,
    clientRate: clientRate.meta?.changes ?? 0,
    ipRate: ipRate.meta?.changes ?? 0,
  };
}
