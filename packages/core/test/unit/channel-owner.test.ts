import Database from 'better-sqlite3-multiple-ciphers';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/infra/migrate.js';
import type { SqliteDatabase } from '../../src/infra/db.js';
import { MailService } from '../../src/mail/service.js';
import type { FetchedMail } from '../../src/mail/message.js';
import { ImService } from '../../src/im/service.js';

/**
 * 62.07 §3 / 62.11 C13（T6 步骤 2）：通道入站通知对象。`PrincipalDirectory
 * .ownerForChannel(kind, accountId)` 返回的成员决定「为入站提醒开直聊」的
 * owner——目录返回 owner → 开对应主体的直聊；无目录 / 无 owner → owner 为
 * NULL（单用户现状）。真实 MailService / ImService + 迁移后的内存库，会话
 * 服务用记录桩（只关心 openDirect 收到的 owner 参数）。
 */

const PR_A = 'pr_AAA';
const mainMigrations = fileURLToPath(new URL('../../migrations/main/', import.meta.url));

const openDbs: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

interface DirectCall {
  botId: string;
  ownerPrincipalId?: string | null;
}

function openDb(): SqliteDatabase {
  const db = new Database(':memory:') as SqliteDatabase;
  db.pragma('foreign_keys = ON');
  runMigrations(db, mainMigrations);
  openDbs.push(db);
  return db;
}

/** Records every openDirect owner argument; ids are opaque to the services here. */
function recorderConversations() {
  const calls: DirectCall[] = [];
  let seq = 0;
  return {
    calls,
    service: {
      get: () => null,
      memberBotIds: () => [],
      listDirectByBot: () => [],
      openDirect: (botId: string, options?: { ownerPrincipalId?: string }) => {
        const owner = options?.ownerPrincipalId ?? null;
        calls.push({ botId, ownerPrincipalId: owner });
        seq += 1;
        return {
          conversation: { id: `conv_${owner ?? 'plain'}_${botId}_${seq}`, readOnly: false },
          created: true,
        };
      },
    },
  };
}

const activeBot = {
  id: 'bot_x',
  name: 'bot_x',
  status: 'active',
  profile: { identity: { name: 'bot_x' } },
} as never;

function seedMail(db: SqliteDatabase, accountId: string): void {
  db.prepare(
    `insert into mail_accounts (id, address, label, provider, imap_host, imap_port, imap_secure,
       smtp_host, smtp_port, smtp_secure, username, status, created_at, updated_at)
     values (?, 'a@b.c', '邮箱', 'custom', 'imap.b.c', 993, 'ssl', 'smtp.b.c', 465, 'ssl', 'a@b.c', 'idle', 0, 0)`,
  ).run(accountId);
  db.prepare(
    'insert into mail_account_bots (account_id, bot_id, alerts_paused, alert_times_json, created_at) values (?, ?, 0, ?, 0)',
  ).run(accountId, 'bot_x', '[]');
}

function seedIm(db: SqliteDatabase, accountId: string): void {
  db.prepare(
    `insert into plugins (id, version, origin, tier, state, enabled, package_sha256, marketplace, dir, installed_at, updated_at)
     values ('plug_im', '1.0.0', 'marketplace', 'verified', 'installed', 1, 'x', 'https://market.example', 'plug/im@1.0.0', 0, 0)`,
  ).run();
  db.prepare(
    `insert into plugin_instances (id, plugin_id, kind, title, created_at, updated_at)
     values ('pli_im', 'plug_im', 'im', 'IM 实例', 0, 0)`,
  ).run();
  db.prepare(
    `insert into im_accounts (id, instance_id, transport, api_base, label, status, config_json, created_at, updated_at)
     values (?, 'pli_im', 'ilink', 'https://im.example', '微信', 'ready', ?, 0, 0)`,
  ).run(accountId, JSON.stringify({ ilink_user_id: 'u1' }));
  db.prepare(
    'insert into im_account_bots (account_id, bot_id, forward_enabled, alerts_paused, alert_times_json, created_at) values (?, ?, 0, 0, ?, 0)',
  ).run(accountId, 'bot_x', '[]');
}

const directory = (ownerByAccount: Record<string, string | null>) => ({
  describe: () => null,
  ownerForChannel: (kind: 'mail' | 'im', accountId: string): string | null =>
    ownerByAccount[accountId] ?? null,
});

describe('通道入站通知对象（62.07 §3 / 62.11 C13）', () => {
  it('mail：目录返回 owner → 开对应主体直聊；无目录 / 无 owner → 现状（owner NULL）', () => {
    const mail = (accountId: string, principals?: unknown): DirectCall[] => {
      const db = openDb();
      seedMail(db, accountId);
      const conversations = recorderConversations();
      const enqueued: Array<{ type: string; conversationId: string | undefined }> = [];
      const service = new MailService({
        db,
        clock: { now: () => 1_000 },
        logger,
        secrets: { getValue: () => null } as never,
        bots: { get: () => activeBot } as never,
        conversations: conversations.service as never,
        messages: {} as never,
        jobs: {
          enqueue: (input: { type: string; conversationId?: string }) => {
            enqueued.push({ type: input.type, conversationId: input.conversationId });
          },
        } as never,
        taint: { mark() {}, guard: () => null } as never,
        requestApproval: (async () => ({ decision: 'approve' })) as never,
        deliverAlert: () => {},
        publishAccount: () => {},
        publishMessage: () => {},
        notice: () => {},
        ...(principals === undefined ? {} : { principals: principals as never }),
      });
      const fetched: FetchedMail[] = [
        {
          uid: 1,
          from: 'someone@example.com',
          to: ['a@b.c'],
          subject: '标题',
          date: 'Thu, 01 Oct 2026 04:00:00 +0000',
          text: '正文',
          attachments: [],
        },
      ];
      service.ingest(accountId, fetched);
      expect(enqueued.filter((job) => job.type === 'mail_alert')).toHaveLength(1);
      return conversations.calls;
    };

    // 目录指定 owner → 开该主体的直聊（作业也落那个会话）。
    expect(mail('acc_owner', directory({ acc_owner: PR_A }))).toEqual([
      { botId: 'bot_x', ownerPrincipalId: PR_A },
    ]);
    // 目录在但该账号未指定 → owner NULL（现状）。
    expect(mail('acc_none', directory({ acc_owner: PR_A }))).toEqual([
      { botId: 'bot_x', ownerPrincipalId: null },
    ]);
    // 无目录（单用户）→ owner NULL（现状）。
    expect(mail('acc_plain')).toEqual([{ botId: 'bot_x', ownerPrincipalId: null }]);
  });

  it('im：目录返回 owner → 开对应主体直聊；无目录 / 无 owner → 现状（owner NULL）', () => {
    const im = (accountId: string, principals?: unknown): DirectCall[] => {
      const db = openDb();
      seedIm(db, accountId);
      const conversations = recorderConversations();
      const enqueued: Array<{ type: string }> = [];
      const service = new ImService({
        db,
        clock: { now: () => 1_000 },
        logger,
        secrets: { getValue: () => null } as never,
        bots: { get: () => activeBot } as never,
        conversations: conversations.service as never,
        messages: { append: () => ({ id: 'm_1', conversationId: 'conv_x' }) } as never,
        jobs: {
          enqueue: (input: { type: string }) => {
            enqueued.push({ type: input.type });
          },
        } as never,
        taint: { mark() {} } as never,
        deliverAlert: () => {},
        publishAccount: () => {},
        publishMessage: () => {},
        notice: () => {},
        recordEgress: () => {},
        instanceOwner: {
          ownerOf: () => ({ pluginId: 'plug_im' }),
          pluginName: () => 'p',
          botTokenSecretName: () => 's',
        } as never,
        instances: { create: (async () => ({})) as never, update: (async () => ({})) as never },
        pluginEnabledForBot: () => true,
        ...(principals === undefined ? {} : { principals: principals as never }),
      });
      service.ingest(accountId, [
        {
          message_type: 1,
          from_user_id: 'u1',
          message_id: 'mid_1',
          item_list: [{ type: 1, text_item: { text: '在吗' } }],
        },
      ]);
      expect(enqueued.filter((job) => job.type === 'im_alert')).toHaveLength(1);
      return conversations.calls;
    };

    expect(im('ima_owner', directory({ ima_owner: PR_A }))).toEqual([
      { botId: 'bot_x', ownerPrincipalId: PR_A },
    ]);
    expect(im('ima_none', directory({ ima_owner: PR_A }))).toEqual([
      { botId: 'bot_x', ownerPrincipalId: null },
    ]);
    expect(im('ima_plain')).toEqual([{ botId: 'bot_x', ownerPrincipalId: null }]);
  });
});
