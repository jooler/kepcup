import type { ImStatus, ImTransport } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';

/**
 * IM 账号与绑定（D107，54 号文档 §3）。一个插件实例 = 一个 IM 账号（卸载级联：
 * instance_id FK ON DELETE CASCADE）；绑定多对多，`forward_enabled` 是 D111 的
 * 「同步消息到此微信」开关（绑定即入站，勾选才出站，永不自动取消）。
 * bot_token 不在这里——单一事实来源是实例 secrets。
 */

export interface ImAccountRecord {
  id: string;
  instanceId: string;
  transport: ImTransport;
  apiBase: string;
  label: string;
  status: ImStatus;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  /** 非敏感会话元数据：ilink_bot_id、登录时间、getUpdates 游标、转发限流窗口。 */
  configJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImBindingRecord {
  accountId: string;
  botId: string;
  forwardEnabled: boolean;
  forwardUpdatedAt: number | null;
  alertsPaused: boolean;
  alertTimes: number[];
  createdAt: number;
}

interface AccountSqlRow {
  id: string;
  instance_id: string;
  transport: string;
  api_base: string;
  label: string;
  status: string;
  last_error: string | null;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  config_json: string;
  created_at: number;
  updated_at: number;
}

interface BindingSqlRow {
  account_id: string;
  bot_id: string;
  forward_enabled: number;
  forward_updated_at: number | null;
  alerts_paused: number;
  alert_times_json: string;
  created_at: number;
}

function accountFromRow(row: AccountSqlRow): ImAccountRecord {
  return {
    id: row.id,
    instanceId: row.instance_id,
    transport: row.transport as ImTransport,
    apiBase: row.api_base,
    label: row.label,
    status: row.status as ImStatus,
    lastError: row.last_error,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
    configJson: row.config_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function bindingFromRow(row: BindingSqlRow): ImBindingRecord {
  let times: number[] = [];
  try {
    const parsed = JSON.parse(row.alert_times_json) as unknown;
    if (Array.isArray(parsed)) {
      times = parsed.filter((item): item is number => typeof item === 'number');
    }
  } catch {
    times = [];
  }
  return {
    accountId: row.account_id,
    botId: row.bot_id,
    forwardEnabled: row.forward_enabled !== 0,
    forwardUpdatedAt: row.forward_updated_at,
    alertsPaused: row.alerts_paused !== 0,
    alertTimes: times,
    createdAt: row.created_at,
  };
}

const ACCOUNT_COLUMNS = `id, instance_id, transport, api_base, label, status, last_error, last_inbound_at,
  last_outbound_at, config_json, created_at, updated_at`;
const BINDING_COLUMNS = `account_id, bot_id, forward_enabled, forward_updated_at, alerts_paused,
  alert_times_json, created_at`;

export class ImStore {
  constructor(private readonly db: SqliteDatabase) {}

  listActive(): ImAccountRecord[] {
    const rows = this.db
      .prepare(`select ${ACCOUNT_COLUMNS} from im_accounts order by created_at`)
      .all() as AccountSqlRow[];
    return rows.map(accountFromRow);
  }

  /**
   * `PluginSummary.instanceCounts.im` 的口径：im 账号全部挂实例（无遗留账号），
   * 按归属本插件的活跃实例行计数。
   */
  countActiveForPlugin(pluginId: string): number {
    const row = this.db
      .prepare(
        `select count(*) as n from im_accounts
         where instance_id in (select id from plugin_instances where plugin_id = ? and kind = 'im')`,
      )
      .get(pluginId) as { n: number };
    return row.n;
  }

  /** 一个插件实例落地的账号 id（materializer 拆除 / 更新时定位）；无则 null。 */
  idByInstance(instanceId: string): string | null {
    const row = this.db
      .prepare('select id from im_accounts where instance_id = ? limit 1')
      .get(instanceId) as { id: string } | undefined;
    return row === undefined ? null : row.id;
  }

  get(id: string): ImAccountRecord | null {
    const row = this.db
      .prepare(`select ${ACCOUNT_COLUMNS} from im_accounts where id = ?`)
      .get(id) as AccountSqlRow | undefined;
    return row === undefined ? null : accountFromRow(row);
  }

  insert(row: ImAccountRecord): void {
    this.db
      .prepare(
        `insert into im_accounts (
           id, instance_id, transport, api_base, label, status, last_error, last_inbound_at,
           last_outbound_at, config_json, created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.instanceId,
        row.transport,
        row.apiBase,
        row.label,
        row.status,
        row.lastError,
        row.lastInboundAt,
        row.lastOutboundAt,
        row.configJson,
        row.createdAt,
        row.updatedAt,
      );
  }

  /** 局部更新；只写给出的列。 */
  patch(
    id: string,
    patch: Partial<
      Pick<
        ImAccountRecord,
        | 'label'
        | 'status'
        | 'lastError'
        | 'lastInboundAt'
        | 'lastOutboundAt'
        | 'configJson'
        | 'updatedAt'
      >
    >,
  ): void {
    const columns: Record<string, unknown> = {
      label: patch.label,
      status: patch.status,
      last_error: patch.lastError,
      last_inbound_at: patch.lastInboundAt,
      last_outbound_at: patch.lastOutboundAt,
      config_json: patch.configJson,
      updated_at: patch.updatedAt,
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of Object.entries(columns)) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`update im_accounts set ${sets.join(', ')} where id = ?`).run(...values);
  }

  delete(id: string): void {
    this.db.prepare('delete from im_accounts where id = ?').run(id);
  }

  // --- 绑定 -----------------------------------------------------------------------

  bindings(accountId: string): ImBindingRecord[] {
    const rows = this.db
      .prepare(`select ${BINDING_COLUMNS} from im_account_bots where account_id = ? order by created_at`)
      .all(accountId) as BindingSqlRow[];
    return rows.map(bindingFromRow);
  }

  bindingsForBot(botId: string): ImBindingRecord[] {
    const rows = this.db
      .prepare(`select ${BINDING_COLUMNS} from im_account_bots where bot_id = ? order by created_at`)
      .all(botId) as BindingSqlRow[];
    return rows.map(bindingFromRow);
  }

  /** 整集替换某账号的绑定（保留既有行的开关 / 暂停状态，同 mail replaceBots）。 */
  replaceBots(accountId: string, botIds: readonly string[], now: number): void {
    const existing = new Map(this.bindings(accountId).map((binding) => [binding.botId, binding]));
    const next = [...new Set(botIds)];
    this.db.transaction(() => {
      this.db.prepare('delete from im_account_bots where account_id = ?').run(accountId);
      const insert = this.db.prepare(
        `insert into im_account_bots (account_id, bot_id, forward_enabled, forward_updated_at, alerts_paused, alert_times_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const botId of next) {
        const previous = existing.get(botId);
        insert.run(
          accountId,
          botId,
          previous?.forwardEnabled === true ? 1 : 0,
          previous?.forwardUpdatedAt ?? null,
          previous?.alertsPaused === true ? 1 : 0,
          JSON.stringify(previous?.alertTimes ?? []),
          previous?.createdAt ?? now,
        );
      }
    })();
  }

  /** D111 开关写入。返回是否真的改了值（幂等调用不更新 forward_updated_at）。 */
  setForward(accountId: string, botId: string, enabled: boolean, now: number): boolean {
    const binding = this.bindings(accountId).find((row) => row.botId === botId);
    if (binding === undefined) return false;
    if (binding.forwardEnabled === enabled) return false;
    this.db
      .prepare(
        'update im_account_bots set forward_enabled = ?, forward_updated_at = ? where account_id = ? and bot_id = ?',
      )
      .run(enabled ? 1 : 0, now, accountId, botId);
    return true;
  }

  setAlertState(accountId: string, botId: string, paused: boolean, times: readonly number[]): void {
    this.db
      .prepare(
        'update im_account_bots set alerts_paused = ?, alert_times_json = ? where account_id = ? and bot_id = ?',
      )
      .run(paused ? 1 : 0, JSON.stringify(times), accountId, botId);
  }

  deleteBindingsForBot(botId: string): number {
    return this.db.prepare('delete from im_account_bots where bot_id = ?').run(botId).changes;
  }

  deleteBindings(accountId: string): void {
    this.db.prepare('delete from im_account_bots where account_id = ?').run(accountId);
  }
}
