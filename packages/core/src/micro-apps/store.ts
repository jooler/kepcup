import {
  AppError,
  MICRO_APP_COLLECTION_DOC_ID_MAX_CHARS,
  MICRO_APP_COLLECTION_QUOTA_BYTES,
  MICRO_APP_CONTEXT_DATA_MAX_BYTES,
  MICRO_APP_CONTEXT_HEADLINE_MAX_CHARS,
  MICRO_APP_DIAG_PUSH_MAX_PER_DAY,
  type MicroAppContextSummary,
} from '@kepcup/shared';
import type { Message } from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { CoreLogger } from '../infra/logger.js';

/**
 * 微应用 P2 数据面（D112，设计 55 §8.5 / §9.4 / §10 / §12.3）：collections、
 * context.update 摘要、运行时诊断与能力审计。全部按微应用隔离（widget_id 命名空间），
 * 表随 widgets 行级联删除（0070 起审计表也带外键）。
 */

export interface MicroAppStoreDeps {
  db: SqliteDatabase;
  clock: Clock;
  logger: CoreLogger;
  /** 系统消息落库（诊断推送到来源会话）。 */
  appendMessage(input: {
    conversationId: string;
    senderType: 'system';
    kind: 'text';
    text: string;
  }): Message;
  publishMessage(message: Message): void;
}

export class MicroAppStore {
  readonly #deps: MicroAppStoreDeps;

  constructor(deps: MicroAppStoreDeps) {
    this.#deps = deps;
  }

  // --- collections（55 §10）---------------------------------------------------------

  #requireWidget(widgetId: string): { botId: string } {
    const row = this.#deps.db
      .prepare('select bot_id from widgets where id = ?')
      .get(widgetId) as { bot_id: string } | undefined;
    if (row === undefined) throw new AppError('NOT_FOUND', '微应用不存在（或已删除）');
    return { botId: row.bot_id };
  }

  collectionPut(widgetId: string, name: string, doc: Record<string, unknown>): void {
    this.#requireWidget(widgetId);
    const id = typeof doc['id'] === 'string' ? doc['id'] : '';
    if (id === '' || id.length > MICRO_APP_COLLECTION_DOC_ID_MAX_CHARS) {
      throw new AppError('INVALID_INPUT', '文档必须有字符串 id（≤120 字）');
    }
    const json = JSON.stringify(doc);
    const bytes = Buffer.byteLength(json);
    const existing = this.#deps.db
      .prepare('select length(cast(doc_json as blob)) as bytes from micro_app_collections where widget_id = ? and name = ? and id = ?')
      .get(widgetId, name, id) as { bytes: number | null } | undefined;
    const total =
      Number(
        (
          this.#deps.db
            .prepare('select coalesce(sum(length(cast(doc_json as blob))), 0) as bytes from micro_app_collections where widget_id = ?')
            .get(widgetId) as { bytes: number | bigint }
        ).bytes,
      ) - Number(existing?.bytes ?? 0) + bytes;
    if (total > MICRO_APP_COLLECTION_QUOTA_BYTES) {
      throw new AppError('WIDGET_STORAGE_QUOTA', `集合总量超出上限（${MICRO_APP_COLLECTION_QUOTA_BYTES} 字节）`);
    }
    const names = this.#deps.db
      .prepare('select count(distinct name) as n from micro_app_collections where widget_id = ?')
      .get(widgetId) as { n: number | bigint };
    const isNewDoc = existing === undefined;
    if (isNewDoc && Number(names.n) >= 10 && this.#collectionNameCount(widgetId, name) === 0) {
      throw new AppError('WIDGET_STORAGE_QUOTA', '集合数已达上限（10 个）');
    }
    this.#deps.db
      .prepare(
        `insert into micro_app_collections (widget_id, name, id, doc_json, updated_at) values (?, ?, ?, ?, ?)
         on conflict(widget_id, name, id) do update set doc_json = excluded.doc_json, updated_at = excluded.updated_at`,
      )
      .run(widgetId, name, id, json, this.#deps.clock.now());
  }

  #collectionNameCount(widgetId: string, name: string): number {
    return Number(
      (
        this.#deps.db
          .prepare('select count(*) as n from micro_app_collections where widget_id = ? and name = ?')
          .get(widgetId, name) as { n: number | bigint }
      ).n,
    );
  }

  collectionGet(widgetId: string, name: string, id: string): { doc: unknown } {
    const row = this.#deps.db
      .prepare('select doc_json from micro_app_collections where widget_id = ? and name = ? and id = ?')
      .get(widgetId, name, id) as { doc_json: string } | undefined;
    if (row === undefined) throw new AppError('NOT_FOUND', '文档不存在');
    return { doc: JSON.parse(row.doc_json) as unknown };
  }

  collectionDelete(widgetId: string, name: string, id: string): void {
    this.#deps.db
      .prepare('delete from micro_app_collections where widget_id = ? and name = ? and id = ?')
      .run(widgetId, name, id);
  }

  collectionList(widgetId: string, name: string): { docs: unknown[] } {
    const rows = this.#deps.db
      .prepare('select doc_json from micro_app_collections where widget_id = ? and name = ? order by id')
      .all(widgetId, name) as Array<{ doc_json: string }>;
    return { docs: rows.map((row) => JSON.parse(row.doc_json) as unknown) };
  }

  collectionQuery(
    widgetId: string,
    name: string,
    where: Array<{ field: string; op: string; value: unknown }>,
    limit: number,
  ): { docs: unknown[] } {
    const { docs } = this.collectionList(widgetId, name);
    const filtered = docs.filter((doc) => {
      if (doc === null || typeof doc !== 'object') return false;
      const record = doc as Record<string, unknown>;
      return where.every((condition) => {
        const actual = record[condition.field];
        switch (condition.op) {
          case 'eq':
            return actual === condition.value;
          case 'ne':
            return actual !== condition.value;
          case 'gt':
            return compare(actual, condition.value) > 0;
          case 'gte':
            return compare(actual, condition.value) >= 0;
          case 'lt':
            return compare(actual, condition.value) < 0;
          case 'lte':
            return compare(actual, condition.value) <= 0;
          case 'exists':
            return actual !== undefined;
          default:
            return false;
        }
      });
    });
    return { docs: filtered.slice(0, limit) };
  }

  // --- context.update（55 §8.5）-----------------------------------------------------

  contextUpdate(input: {
    widgetId: string;
    conversationId: string;
    version: number;
    summary: MicroAppContextSummary;
    reason: 'gesture' | 'pause' | 'close';
  }): void {
    const dataJson = input.summary.data !== undefined ? JSON.stringify(input.summary.data) : '{}';
    if (Buffer.byteLength(dataJson) > MICRO_APP_CONTEXT_DATA_MAX_BYTES) {
      throw new AppError('INVALID_INPUT', `摘要 data 超出上限（${MICRO_APP_CONTEXT_DATA_MAX_BYTES} 字节）`);
    }
    if (input.summary.headline.length > MICRO_APP_CONTEXT_HEADLINE_MAX_CHARS) {
      throw new AppError('INVALID_INPUT', `headline 超出上限（${MICRO_APP_CONTEXT_HEADLINE_MAX_CHARS} 字）`);
    }
    this.#deps.db
      .prepare(
        `insert into micro_app_context (widget_id, conversation_id, version, headline, data_json, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(widget_id) do update set
           conversation_id = excluded.conversation_id,
           version = excluded.version,
           headline = excluded.headline,
           data_json = excluded.data_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.widgetId,
        input.conversationId,
        input.version,
        input.summary.headline,
        dataJson,
        this.#deps.clock.now(),
      );
  }

  contextClear(widgetId: string): void {
    this.#deps.db.prepare('delete from micro_app_context where widget_id = ?').run(widgetId);
  }

  contextOf(widgetId: string): { headline: string; dataJson: string; conversationId: string } | null {
    const row = this.#deps.db
      .prepare('select headline, data_json, conversation_id from micro_app_context where widget_id = ?')
      .get(widgetId) as { headline: string; data_json: string; conversation_id: string } | undefined;
    if (row === undefined) return null;
    return { headline: row.headline, dataJson: row.data_json, conversationId: row.conversation_id };
  }

  /** 会话的当前摘要（注入模型上下文用；按更新时间倒序取最新一条）。 */
  contextForConversation(
    conversationId: string,
  ): Array<{ widgetId: string; headline: string; dataJson: string; version: number }> {
    const rows = this.#deps.db
      .prepare(
        'select widget_id, headline, data_json, version from micro_app_context where conversation_id = ? order by updated_at desc',
      )
      .all(conversationId) as Array<{ widget_id: string; headline: string; data_json: string; version: number }>;
    return rows.map((row) => ({
      widgetId: row.widget_id,
      headline: row.headline,
      dataJson: row.data_json,
      version: row.version,
    }));
  }

  // --- 诊断（55 §9.4）----------------------------------------------------------------

  diagnosticsRecord(input: {
    widgetId: string;
    version: number;
    phase: 'prepare' | 'run' | 'stream';
    code: string;
    detail: string;
  }): { pushed: boolean } {
    const day = dayOf(this.#deps.clock.now());
    const now = this.#deps.clock.now();
    this.#deps.db
      .prepare(
        `insert into micro_app_diagnostics (widget_id, version, day, phase, code, detail, count, first_at, last_at)
         values (?, ?, ?, ?, ?, ?, 1, ?, ?)
         on conflict(widget_id, version, day, phase, code) do update set
           count = count + 1,
           detail = case when excluded.detail != '' then excluded.detail else detail end,
           last_at = excluded.last_at`,
      )
      .run(input.widgetId, input.version, day, input.phase, input.code, input.detail, now, now);
    // 投递闸（持久化，审查 P1-3）：同 (widget, version, code) 当天已推送过 → 不再打扰；
    // 再加每微应用每日推送上限（审查 P2-1：换 code 轮换也刷不动来源会话）。
    const already = this.#deps.db
      .prepare('select 1 from micro_app_diag_pushes where widget_id = ? and version = ? and code = ? and day = ?')
      .get(input.widgetId, input.version, input.code, day);
    if (already !== undefined) return { pushed: false };
    const pushedToday = Number(
      (
        this.#deps.db
          .prepare('select count(*) as n from micro_app_diag_pushes where widget_id = ? and day = ?')
          .get(input.widgetId, day) as { n: number | bigint }
      ).n,
    );
    if (pushedToday >= MICRO_APP_DIAG_PUSH_MAX_PER_DAY) return { pushed: false };
    this.#deps.db
      .prepare('insert into micro_app_diag_pushes (widget_id, version, code, day, pushed_at) values (?, ?, ?, ?, ?)')
      .run(input.widgetId, input.version, input.code, day, now);
    return { pushed: true };
  }

  /** 诊断系统消息（≤300 字，来源会话；来源会话为 NULL / 已删时由调用方跳过）。 */
  pushDiagnosticMessage(input: {
    widgetId: string;
    version: number;
    code: string;
    detail: string;
  }): string | null {
    const widget = this.#deps.db
      .prepare('select conversation_id, title from widgets where id = ?')
      .get(input.widgetId) as { conversation_id: string | null; title: string } | undefined;
    if (widget === undefined || widget.conversation_id === null) return null;
    const text = (
      `微应用「${widget.title}」v${input.version} 运行出现问题：${input.code}` +
      (input.detail !== '' ? `（${input.detail}）` : '') +
      '。可调用 micro_app_diagnostics_read 查看详情。'
    ).slice(0, 300);
    const message = this.#deps.appendMessage({
      conversationId: widget.conversation_id,
      senderType: 'system',
      kind: 'text',
      text,
    });
    this.#deps.publishMessage(message);
    return message.id;
  }

  /** 最近 24h 聚合（Bot 只读工具）。 */
  diagnosticsRead(widgetId: string): {
    entries: Array<{
      version: number;
      phase: string;
      code: string;
      detail: string;
      count: number;
      firstAt: number;
      lastAt: number;
    }>;
    truncated: boolean;
  } {
    const since = this.#deps.clock.now() - 24 * 60 * 60 * 1000;
    const rows = this.#deps.db
      .prepare(
        'select version, phase, code, detail, count, first_at, last_at from micro_app_diagnostics where widget_id = ? and last_at >= ? order by last_at desc limit 51',
      )
      .all(widgetId, since) as Array<{
      version: number;
      phase: string;
      code: string;
      detail: string;
      count: number;
      first_at: number;
      last_at: number;
    }>;
    const truncated = rows.length > 50;
    const entries = rows.slice(0, 50).map((row) => ({
      version: row.version,
      phase: row.phase,
      code: row.code,
      detail: row.detail,
      count: row.count,
      firstAt: row.first_at,
      lastAt: row.last_at,
    }));
    return { entries, truncated };
  }

  /** 管理页「运行问题」（最近 24h 按 code 聚合）。 */
  diagnosticsCounts24h(widgetId: string): Array<{ code: string; count: number; version: number }> {
    const since = this.#deps.clock.now() - 24 * 60 * 60 * 1000;
    return this.#deps.db
      .prepare(
        'select code, sum(count) as count, max(version) as version from micro_app_diagnostics where widget_id = ? and last_at >= ? group by code order by count desc limit 20',
      )
      .all(widgetId, since) as Array<{ code: string; count: number; version: number }>;
  }

  // --- 审计（55 §12.3）---------------------------------------------------------------

  audit(input: {
    widgetId: string;
    version: number;
    instanceId: string;
    capability: string;
    outcome: 'ok' | 'denied' | 'error' | 'revoked';
    durationMs?: number;
  }): void {
    this.#deps.db
      .prepare(
        'insert into micro_app_audit (id, widget_id, version, instance_id, capability, outcome, duration_ms, at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        null,
        input.widgetId,
        input.version,
        input.instanceId,
        input.capability,
        input.outcome,
        input.durationMs ?? 0,
        this.#deps.clock.now(),
      );
  }

  /** 按天修剪诊断（默认 30 天；启动与每次记录时顺带做，幂等）。 */
  pruneDiagnostics(retainDays = 30): void {
    const cutoffDay = dayOf(this.#deps.clock.now() - retainDays * 24 * 60 * 60 * 1000);
    this.#deps.db.prepare('delete from micro_app_diagnostics where day < ?').run(cutoffDay);
    this.#deps.db.prepare('delete from micro_app_diag_pushes where day < ?').run(cutoffDay);
  }
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return NaN;
}

function dayOf(now: number): string {
  const date = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

