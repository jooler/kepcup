import {
  MAIL_MAX_ALERTS_PER_HOUR,
  MAIL_RECONNECT_CAP_MS,
  type MailAccount,
  type MailListen,
  type MailMode,
  type MailProvider,
  type MailSecure,
  type MailStatus,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';

const HOUR_MS = 60 * 60 * 1000;

/** 滚动 1 小时内的唤醒时间。超出上限的那一次不唤醒。 */
export function recentMailAlerts(times: readonly number[], now: number): number[] {
  return times.filter((at) => at > now - HOUR_MS && at <= now);
}

export function mailAlertsExceeded(recentCount: number): boolean {
  return recentCount >= MAIL_MAX_ALERTS_PER_HOUR;
}

/** 断线重连：1s 起翻倍，封顶 15 分钟。streak 从 1 计。 */
export function mailBackoffMs(streak: number): number {
  const shift = Math.min(10, Math.max(0, streak - 1));
  return Math.min(MAIL_RECONNECT_CAP_MS, 1000 * 2 ** shift);
}

export interface MailAccountRecord {
  id: string;
  address: string;
  label: string;
  provider: MailProvider;
  imapHost: string;
  imapPort: number;
  imapSecure: MailSecure;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: MailSecure;
  username: string;
  mode: MailMode;
  pollIntervalSec: number;
  status: MailStatus;
  listen: MailListen | null;
  lastUid: number | null;
  unseenCount: number | null;
  lastError: string | null;
  lastOkAt: number | null;
  failureStreak: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface MailBindingRecord {
  accountId: string;
  botId: string;
  alertsPaused: boolean;
  alertTimes: number[];
  createdAt: number;
}

interface AccountSqlRow {
  id: string;
  address: string;
  label: string;
  provider: string;
  imap_host: string;
  imap_port: number;
  imap_secure: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: string;
  username: string;
  mode: string;
  poll_interval_sec: number;
  status: string;
  listen: string | null;
  last_uid: number | null;
  unseen_count: number | null;
  last_error: string | null;
  last_ok_at: number | null;
  failure_streak: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface BindingSqlRow {
  account_id: string;
  bot_id: string;
  alerts_paused: number;
  alert_times_json: string;
  created_at: number;
}

function accountFromRow(row: AccountSqlRow): MailAccountRecord {
  return {
    id: row.id,
    address: row.address,
    label: row.label,
    provider: row.provider as MailProvider,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: row.imap_secure as MailSecure,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: row.smtp_secure as MailSecure,
    username: row.username,
    mode: row.mode as MailMode,
    pollIntervalSec: row.poll_interval_sec,
    status: row.status as MailStatus,
    listen: row.listen === 'idle' || row.listen === 'poll' ? row.listen : null,
    lastUid: row.last_uid,
    unseenCount: row.unseen_count,
    lastError: row.last_error,
    lastOkAt: row.last_ok_at,
    failureStreak: row.failure_streak,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function bindingFromRow(row: BindingSqlRow): MailBindingRecord {
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
    alertsPaused: row.alerts_paused !== 0,
    alertTimes: times,
    createdAt: row.created_at,
  };
}

export function toPublicAccount(
  row: MailAccountRecord,
  bindings: readonly MailBindingRecord[],
): MailAccount {
  return {
    id: row.id,
    address: row.address,
    label: row.label,
    provider: row.provider,
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    imapSecure: row.imapSecure,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure,
    username: row.username,
    mode: row.mode,
    pollIntervalSec: row.pollIntervalSec,
    status: row.status,
    listen: row.listen,
    lastError: row.lastError,
    lastOkAt: row.lastOkAt,
    unseenCount: row.unseenCount,
    botIds: bindings.map((binding) => binding.botId),
    alertPausedBotIds: bindings.filter((binding) => binding.alertsPaused).map((binding) => binding.botId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const ACCOUNT_COLUMNS = `id, address, label, provider, imap_host, imap_port, imap_secure, smtp_host, smtp_port,
  smtp_secure, username, mode, poll_interval_sec, status, listen, last_uid, unseen_count, last_error,
  last_ok_at, failure_streak, created_at, updated_at, deleted_at`;

export class MailStore {
  constructor(private readonly db: SqliteDatabase) {}

  listActive(): MailAccountRecord[] {
    const rows = this.db
      .prepare(`select ${ACCOUNT_COLUMNS} from mail_accounts where deleted_at is null order by created_at`)
      .all() as AccountSqlRow[];
    return rows.map(accountFromRow);
  }

  get(id: string): MailAccountRecord | null {
    const row = this.db
      .prepare(`select ${ACCOUNT_COLUMNS} from mail_accounts where id = ? and deleted_at is null`)
      .get(id) as AccountSqlRow | undefined;
    return row === undefined ? null : accountFromRow(row);
  }

  insert(row: MailAccountRecord): void {
    this.db
      .prepare(
        `insert into mail_accounts (
           id, address, label, provider, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
           username, mode, poll_interval_sec, status, listen, last_uid, unseen_count, last_error, last_ok_at,
           failure_streak, created_at, updated_at, deleted_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.address,
        row.label,
        row.provider,
        row.imapHost,
        row.imapPort,
        row.imapSecure,
        row.smtpHost,
        row.smtpPort,
        row.smtpSecure,
        row.username,
        row.mode,
        row.pollIntervalSec,
        row.status,
        row.listen,
        row.lastUid,
        row.unseenCount,
        row.lastError,
        row.lastOkAt,
        row.failureStreak,
        row.createdAt,
        row.updatedAt,
        row.deletedAt,
      );
  }

  /** 局部更新。调用方先改内存里的记录再整行写回会丢并发；这里只写给出的列。 */
  patch(
    id: string,
    patch: Partial<
      Pick<
        MailAccountRecord,
        | 'label'
        | 'username'
        | 'mode'
        | 'pollIntervalSec'
        | 'status'
        | 'listen'
        | 'lastUid'
        | 'unseenCount'
        | 'lastError'
        | 'lastOkAt'
        | 'failureStreak'
        | 'imapHost'
        | 'imapPort'
        | 'imapSecure'
        | 'smtpHost'
        | 'smtpPort'
        | 'smtpSecure'
        | 'updatedAt'
        | 'deletedAt'
      >
    >,
  ): void {
    const columns: Record<string, unknown> = {
      label: patch.label,
      username: patch.username,
      mode: patch.mode,
      poll_interval_sec: patch.pollIntervalSec,
      status: patch.status,
      listen: patch.listen,
      last_uid: patch.lastUid,
      unseen_count: patch.unseenCount,
      last_error: patch.lastError,
      last_ok_at: patch.lastOkAt,
      failure_streak: patch.failureStreak,
      imap_host: patch.imapHost,
      imap_port: patch.imapPort,
      imap_secure: patch.imapSecure,
      smtp_host: patch.smtpHost,
      smtp_port: patch.smtpPort,
      smtp_secure: patch.smtpSecure,
      updated_at: patch.updatedAt,
      deleted_at: patch.deletedAt,
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
    this.db.prepare(`update mail_accounts set ${sets.join(', ')} where id = ?`).run(...values);
  }

  bindings(accountId: string): MailBindingRecord[] {
    const rows = this.db
      .prepare(
        `select account_id, bot_id, alerts_paused, alert_times_json, created_at
         from mail_account_bots where account_id = ? order by created_at`,
      )
      .all(accountId) as BindingSqlRow[];
    return rows.map(bindingFromRow);
  }

  bindingsForBot(botId: string): MailBindingRecord[] {
    const rows = this.db
      .prepare(
        `select account_id, bot_id, alerts_paused, alert_times_json, created_at
         from mail_account_bots where bot_id = ? order by created_at`,
      )
      .all(botId) as BindingSqlRow[];
    return rows.map(bindingFromRow);
  }

  replaceBots(accountId: string, botIds: readonly string[], now: number): void {
    const existing = new Map(this.bindings(accountId).map((binding) => [binding.botId, binding]));
    const next = [...new Set(botIds)];
    this.db.transaction(() => {
      this.db.prepare('delete from mail_account_bots where account_id = ?').run(accountId);
      const insert = this.db.prepare(
        `insert into mail_account_bots (account_id, bot_id, alerts_paused, alert_times_json, created_at)
         values (?, ?, ?, ?, ?)`,
      );
      for (const botId of next) {
        const previous = existing.get(botId);
        insert.run(
          accountId,
          botId,
          previous?.alertsPaused === true ? 1 : 0,
          JSON.stringify(previous?.alertTimes ?? []),
          previous?.createdAt ?? now,
        );
      }
    })();
  }

  /** 全量替换某个 Bot 的邮箱绑定。其它 Bot 的绑定不动。 */
  replaceAccountsForBot(botId: string, accountIds: readonly string[], now: number): void {
    const next = [...new Set(accountIds)];
    this.db.transaction(() => {
      this.db.prepare('delete from mail_account_bots where bot_id = ?').run(botId);
      const insert = this.db.prepare(
        `insert into mail_account_bots (account_id, bot_id, alerts_paused, alert_times_json, created_at)
         values (?, ?, 0, '[]', ?)`,
      );
      for (const accountId of next) insert.run(accountId, botId, now);
    })();
  }

  setAlertState(accountId: string, botId: string, paused: boolean, times: readonly number[]): void {
    this.db
      .prepare(
        `update mail_account_bots set alerts_paused = ?, alert_times_json = ? where account_id = ? and bot_id = ?`,
      )
      .run(paused ? 1 : 0, JSON.stringify(times), accountId, botId);
  }

  deleteBindingsForBot(botId: string): number {
    return this.db.prepare('delete from mail_account_bots where bot_id = ?').run(botId).changes;
  }

  deleteBindings(accountId: string): void {
    this.db.prepare('delete from mail_account_bots where account_id = ?').run(accountId);
  }
}
