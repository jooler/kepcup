import {
  botHandoverPayloadSchema,
  type BotHandoverPayload,
  type HandoverItemStatus,
  type HandoverStatus,
  type HandoverView,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';

/** `bot_handovers` / `bot_handover_items` 的读写（D88，main 0035 暂定）。 */

interface HandoverRow {
  id: string;
  approval_id: string | null;
  proposer_bot_id: string;
  conversation_id: string;
  from_bot_id: string;
  to_bot_id: string | null;
  new_bot_json: string | null;
  status: HandoverStatus;
  plan_json: string;
  notified_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  handover_id: string;
  key: string;
  asset_type: string;
  action: string;
  status: HandoverItemStatus;
  error: string | null;
  result_json: string | null;
  updated_at: number;
}

export interface HandoverRecord {
  id: string;
  approvalId: string | null;
  proposerBotId: string;
  conversationId: string;
  fromBotId: string;
  toBotId: string | null;
  status: HandoverStatus;
  /** 提交时的移交卡 payload 快照。 */
  plan: BotHandoverPayload;
  /** 结果通知已投递的时间（null = 还没有）。 */
  notifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface HandoverItemRecord {
  handoverId: string;
  key: string;
  assetType: string;
  action: string;
  status: HandoverItemStatus;
  error: string | null;
  result: Record<string, unknown> | null;
  updatedAt: number;
}

function toRecord(row: HandoverRow): HandoverRecord {
  return {
    id: row.id,
    approvalId: row.approval_id,
    proposerBotId: row.proposer_bot_id,
    conversationId: row.conversation_id,
    fromBotId: row.from_bot_id,
    toBotId: row.to_bot_id,
    status: row.status,
    plan: botHandoverPayloadSchema.parse(JSON.parse(row.plan_json)),
    notifiedAt: row.notified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItem(row: ItemRow): HandoverItemRecord {
  let result: Record<string, unknown> | null = null;
  if (row.result_json !== null) {
    try {
      result = JSON.parse(row.result_json) as Record<string, unknown>;
    } catch {
      result = null;
    }
  }
  return {
    handoverId: row.handover_id,
    key: row.key,
    assetType: row.asset_type,
    action: row.action,
    status: row.status,
    error: row.error,
    result,
    updatedAt: row.updated_at,
  };
}

export class HandoverStore {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;

  constructor(deps: { db: SqliteDatabase; clock: Clock }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  insert(input: {
    id: string;
    proposerBotId: string;
    conversationId: string;
    fromBotId: string;
    toBotId: string | null;
    plan: BotHandoverPayload;
  }): HandoverRecord {
    const now = this.#clock.now();
    this.#db
      .prepare(
        `insert into bot_handovers
           (id, approval_id, proposer_bot_id, conversation_id, from_bot_id, to_bot_id, new_bot_json,
            status, plan_json, created_at, updated_at)
         values (?, null, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.proposerBotId,
        input.conversationId,
        input.fromBotId,
        input.toBotId,
        input.plan.target.kind === 'new' ? JSON.stringify(input.plan.target.bot) : null,
        JSON.stringify(input.plan),
        now,
        now,
      );
    return this.getOrThrow(input.id);
  }

  get(id: string): HandoverRecord | null {
    const row = this.#db.prepare('select * from bot_handovers where id = ?').get(id) as
      HandoverRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  getOrThrow(id: string): HandoverRecord {
    const record = this.get(id);
    if (record === null) throw new Error(`handover ${id} does not exist`);
    return record;
  }

  getByApproval(approvalId: string): HandoverRecord | null {
    const row = this.#db
      .prepare('select * from bot_handovers where approval_id = ? order by created_at desc limit 1')
      .get(approvalId) as HandoverRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  listByStatus(statuses: readonly HandoverStatus[]): HandoverRecord[] {
    if (statuses.length === 0) return [];
    return (
      this.#db
        .prepare(
          `select * from bot_handovers where status in (${statuses.map(() => '?').join(', ')})
           order by created_at`,
        )
        .all(...statuses) as HandoverRow[]
    ).map(toRecord);
  }

  /** 结算 / 拒绝了但还没通知发起方的移交（启动恢复补发）。 */
  listUnnotified(): HandoverRecord[] {
    return (
      this.#db
        .prepare(
          `select * from bot_handovers
           where notified_at is null and status in ('completed', 'partial', 'failed', 'denied')
           order by created_at`,
        )
        .all() as HandoverRow[]
    ).map(toRecord);
  }

  markNotified(id: string): void {
    this.#db
      .prepare('update bot_handovers set notified_at = ? where id = ?')
      .run(this.#clock.now(), id);
  }

  setApproval(id: string, approvalId: string): void {
    this.#db
      .prepare('update bot_handovers set approval_id = ?, updated_at = ? where id = ?')
      .run(approvalId, this.#clock.now(), id);
  }

  setStatus(id: string, status: HandoverStatus): void {
    this.#db
      .prepare('update bot_handovers set status = ?, updated_at = ? where id = ?')
      .run(status, this.#clock.now(), id);
  }

  /** 新建目标建好后回填（只在还没回填时写）。 */
  setToBot(id: string, botId: string): void {
    this.#db
      .prepare(
        'update bot_handovers set to_bot_id = ?, updated_at = ? where id = ? and to_bot_id is null',
      )
      .run(botId, this.#clock.now(), id);
  }

  /** 批准时一次写入被选中的条目（pending）；已存在的行不动（幂等）。 */
  insertItems(
    handoverId: string,
    items: ReadonlyArray<{ key: string; assetType: string; action: string }>,
  ): void {
    const now = this.#clock.now();
    const insert = this.#db.prepare(
      `insert into bot_handover_items (handover_id, key, asset_type, action, status, error, result_json, updated_at)
       values (?, ?, ?, ?, 'pending', null, null, ?)
       on conflict(handover_id, key) do nothing`,
    );
    for (const item of items) insert.run(handoverId, item.key, item.assetType, item.action, now);
  }

  items(handoverId: string): HandoverItemRecord[] {
    return (
      this.#db
        .prepare('select * from bot_handover_items where handover_id = ? order by rowid')
        .all(handoverId) as ItemRow[]
    ).map(toItem);
  }

  setItem(
    handoverId: string,
    key: string,
    status: HandoverItemStatus,
    error: string | null,
    result: Record<string, unknown> | null = null,
  ): void {
    this.#db
      .prepare(
        `update bot_handover_items set status = ?, error = ?, result_json = ?, updated_at = ?
         where handover_id = ? and key = ?`,
      )
      .run(
        status,
        error,
        result === null ? null : JSON.stringify(result),
        this.#clock.now(),
        handoverId,
        key,
      );
  }

  view(id: string): HandoverView | null {
    const record = this.get(id);
    if (record === null) return null;
    const items = this.items(id);
    return {
      id: record.id,
      approvalId: record.approvalId,
      conversationId: record.conversationId,
      status: record.status,
      fromBotId: record.fromBotId,
      toBotId: record.toBotId,
      items: items.map((item) => ({
        key: item.key,
        assetType: item.assetType,
        status: item.status,
        error: item.error,
      })),
      // Item progress counts as an update of the view (renderer keeps the newest).
      updatedAt: Math.max(record.updatedAt, ...items.map((item) => item.updatedAt)),
    };
  }
}
