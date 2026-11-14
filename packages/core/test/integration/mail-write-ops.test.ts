import { afterEach, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, openDirect, waitFor, type TestStack } from '@kepcup/testkit';
import type { AppNoticePayload } from '@kepcup/shared';
import type { JobsService, EnqueueJobInput } from '../../src/domain/jobs.js';
import { MailService } from '../../src/mail/service.js';
import {
  FakeImapServer,
  FakeSmtpServer,
  sampleMessage,
  type FakeImapOptions,
} from '../support/fake-mail-server.js';

/**
 * D144 邮箱内部写操作的服务层端到端：MailService 挂测试 core 的真实数据库与 secrets，
 * 收发走 FakeImapServer / FakeSmtpServer，写命令的状态断言直接读假服务器内存。
 */

interface Local {
  stack: TestStack;
  mail: MailService;
  imap: FakeImapServer;
  smtp: FakeSmtpServer;
  jobs: EnqueueJobInput[];
  alerts: Array<{ botId: string; conversationId: string; text: string }>;
  notices: AppNoticePayload[];
  cleanup(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: { imap?: FakeImapOptions } = {}): Promise<Local> {
  const imap = new FakeImapServer({ advertiseIdle: false, ...options.imap });
  const smtp = new FakeSmtpServer();
  await imap.start();
  await smtp.start();
  const previous = process.env.KEPCUP_MAIL_ALLOW_PRIVATE;
  process.env.KEPCUP_MAIL_ALLOW_PRIVATE = '1';
  const stack = await createTestStack();
  const services = stack.core.services;
  const domain = services.domain;
  if (domain === null || services.mainDb === null || services.taint === null)
    throw new Error('core not ready');
  const jobs: EnqueueJobInput[] = [];
  const alerts: Local['alerts'] = [];
  const notices: AppNoticePayload[] = [];
  const clock = { t: Date.now(), now: () => clock.t };
  const stubJobs = {
    enqueue: (input: EnqueueJobInput) => {
      jobs.push(input);
      return `job_${jobs.length}`;
    },
    cancelByDedupePrefix: () => 0,
  } as unknown as JobsService;
  const mail = new MailService({
    db: services.mainDb,
    clock,
    logger: services.logger,
    secrets: domain.secrets,
    bots: domain.bots,
    conversations: domain.conversations,
    messages: domain.messages,
    jobs: stubJobs,
    taint: services.taint,
    requestApproval: (identity, kind, payload, opts) =>
      domain.approvals.request(identity, kind, payload, opts),
    deliverAlert: (input) => alerts.push(input),
    publishAccount: () => undefined,
    publishMessage: () => undefined,
    notice: (notice) => notices.push(notice),
    sessionBackoffMs: () => 15,
  });
  const local: Local = { stack, mail, imap, smtp, jobs, alerts, notices, cleanup: async () => undefined };
  local.cleanup = async () => {
    mail.stop();
    await stack.cleanup();
    await imap.stop();
    await smtp.stop();
    if (previous === undefined) delete process.env.KEPCUP_MAIL_ALLOW_PRIVATE;
    else process.env.KEPCUP_MAIL_ALLOW_PRIVATE = previous;
  };
  cleanups.push(() => local.cleanup());
  return local;
}

async function accountFor(local: Local, botId: string): Promise<string> {
  const db = local.stack.core.services.mainDb;
  if (db === null) throw new Error('core db not ready');
  db.prepare(
    `insert into plugins (id, version, origin, tier, state, enabled, package_sha256, marketplace, dir, update_to, update_snapshot, config_json, installed_at, updated_at)
     values ('io.github.tester/maildom', '1.0.0', 'local', 'developer', 'installed', 1, 'seeded', NULL, 'io.github.tester/maildom@1.0.0', NULL, NULL, '{}', 0, 0)
     on conflict(id) do nothing`,
  ).run();
  const instanceId = `pli_seed_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `insert into plugin_instances (id, plugin_id, kind, title, config_json, created_at, updated_at)
     values (?, 'io.github.tester/maildom', 'mail', 'seeded', '{}', 0, 0)`,
  ).run(instanceId);
  const account = await local.mail.createForInstance({
    address: 'bot@example.com',
    password: 'authcode',
    mode: 'poll_only',
    pollIntervalSec: 3600,
    imapHost: '127.0.0.1',
    imapPort: local.imap.port,
    imapSecure: 'ssl',
    smtpHost: '127.0.0.1',
    smtpPort: local.smtp.port,
    smtpSecure: 'ssl',
    instanceId,
  });
  local.mail.setBots(account.id, [botId]);
  await waitFor(() => (local.mail.get(account.id).status === 'running' ? true : null), {
    label: 'account running',
  });
  return account.id;
}

describe('markMessages (D144)', () => {
  it('marks read on the server and the listing shows it', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    const uid = local.imap.addMessage(sampleMessage('unread', 'body'));
    local.mail.wake();
    await waitFor(() => (local.jobs.length === 1 ? true : null), { label: 'alert enqueued' });

    const receipt = await local.mail.markMessages(bot.id, direct.id, { uids: [uid], seen: true });
    expect(receipt).toContain('已置上 \\Seen');
    expect(local.imap.inbox.messages[0]?.seen).toBe(true);

    // 未读清单里消失了；全量清单显示已读。
    const unseen = await local.mail.listMessages(bot.id, direct.id, { unseen: true });
    expect(unseen).toContain('没有符合条件的邮件');
    const listed = await local.mail.listMessages(bot.id, direct.id, {});
    expect(listed).toContain('已读');
    // 普通未读信（无任何旗标）也要显示「未读」，Bot 靠它决定 mail_mark。
    const fresh = local.imap.addMessage(sampleMessage('brand new', 'x'));
    const listedFresh = await local.mail.listMessages(bot.id, direct.id, { unseen: true });
    expect(listedFresh).toContain('未读');
    expect(listedFresh).toContain(`UID ${fresh}`);

    // 标回未读。
    await local.mail.markMessages(bot.id, direct.id, { uids: [uid], seen: false });
    expect(local.imap.inbox.messages[0]?.seen).toBe(false);
    const unreadAgain = await local.mail.listMessages(bot.id, direct.id, { unseen: true });
    expect(unreadAgain).toContain('unread');
  });

  it('flags a message and refuses a no-op call without seen/flagged', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    const uid = local.imap.addMessage(sampleMessage('f', 'x'));
    await local.mail.markMessages(bot.id, direct.id, { uids: [uid], flagged: true });
    expect(local.imap.inbox.messages[0]?.flags).toContain('\\Flagged');
    await expect(
      local.mail.markMessages(bot.id, direct.id, { uids: [uid] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(local.mail.markMessages(bot.id, direct.id, { uids: [] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('tagMessages (D144)', () => {
  it('adds, searches and removes custom tags, and lists known tags', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    const uid = local.imap.addMessage(sampleMessage('tagged', 'x'));
    local.imap.addMessage(sampleMessage('plain', 'x'));

    await local.mail.tagMessages(bot.id, direct.id, { uids: [uid], add: ['bill'] });
    expect(local.imap.inbox.messages[0]?.flags).toContain('bill');
    const found = await local.mail.searchMessages(bot.id, direct.id, { query: { keyword: 'bill' } });
    expect(found).toContain('tagged');

    const tags = await local.mail.tagMessages(bot.id, direct.id, {});
    expect(tags).toContain('bill');
    await local.mail.tagMessages(bot.id, direct.id, { uids: [uid], remove: ['bill'] });
    expect(local.imap.inbox.messages[0]?.flags).not.toContain('bill');

    // 中文标签在协议层就是不行，提前拦成 INVALID_INPUT。
    await expect(
      local.mail.tagMessages(bot.id, direct.id, { uids: [uid], add: ['账单'] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      local.mail.tagMessages(bot.id, direct.id, { add: ['x'] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // mail_search 的 keyword 同一校验：非法值是 INVALID_INPUT，不是「连接失败」。
    await expect(
      local.mail.searchMessages(bot.id, direct.id, { query: { keyword: '中文标签' } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('input guards (D144 review)', () => {
  it('rejects out-of-range uids, oversized batches and control characters in folder names', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    await expect(
      local.mail.markMessages(bot.id, direct.id, { uids: [1e21], seen: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      local.mail.markMessages(bot.id, direct.id, {
        uids: Array.from({ length: 501 }, (_, index) => index + 1),
        seen: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      local.mail.createFolder(bot.id, direct.id, { path: 'bad\nname' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('resolves namespace-prefixed special-use folders so the guard cannot be bypassed by a bare name', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    // Cyrus 风格：LIST 里是带前缀的归一路径。
    local.imap.addFolder('INBOX.Sent', { specialUse: '\\Sent' });
    await expect(
      local.mail.deleteFolder(bot.id, direct.id, { path: 'Sent' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      local.mail.renameFolder(bot.id, direct.id, { path: 'Sent', newPath: 'Mine' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 服务器真的还有这个文件夹。
    expect(local.imap.folders.has('INBOX.Sent')).toBe(true);
    // 不存在的文件夹给 NOT_FOUND，而不是「连接失败」。
    await expect(
      local.mail.deleteFolder(bot.id, direct.id, { path: 'Nowhere' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('moveMessages / deleteMessages (D144)', () => {
  it('moves to another folder and reports the new uid', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    const uid = local.imap.addMessage(sampleMessage('movable', 'x'));
    local.imap.addMessage(sampleMessage('stays', 'x'));
    await local.mail.createFolder(bot.id, direct.id, { path: 'Archive' });

    const receipt = await local.mail.moveMessages(bot.id, direct.id, {
      uids: [uid],
      destination: 'Archive',
    });
    expect(receipt).toContain('已把收件箱的 1 封邮件移到 Archive');
    expect(receipt).toContain(`新 UID`);
    expect(local.imap.inbox.messages).toHaveLength(1);
    expect(local.imap.folders.get('Archive')?.messages[0]?.raw).toContain('Subject: movable');
    // 子文件夹里的信按 folder 参数可读。
    const archived = await local.mail.listMessages(bot.id, direct.id, { folder: 'Archive' });
    expect(archived).toContain('movable');
  });

  it('refuses to move without MOVE / UIDPLUS support', async () => {
    const local = await setup({ imap: { advertiseMove: false, advertiseUidPlus: false } });
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    const uid = local.imap.addMessage(sampleMessage('m', 'x'));
    await expect(
      local.mail.moveMessages(bot.id, direct.id, { uids: [uid], destination: 'Archive' }),
    ).rejects.toMatchObject({ code: 'MAIL_CAPABILITY' });
    expect(local.imap.inbox.messages).toHaveLength(1);
  });

  it('hard-deletes with UIDPLUS and refuses without it', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    const gone = local.imap.addMessage(sampleMessage('delete me', 'x'));
    const stays = local.imap.addMessage(sampleMessage('keep me', 'x'));
    await local.mail.deleteMessages(bot.id, direct.id, { uids: [gone] });
    expect(local.imap.inbox.messages.map((message) => message.uid)).toEqual([stays]);

    const noUidPlus = await setup({ imap: { advertiseUidPlus: false } });
    const bot2 = await makeBot(noUidPlus.stack.core, '乙');
    const direct2 = await openDirect(noUidPlus.stack.core, bot2.id);
    await accountFor(noUidPlus, bot2.id);
    const uid2 = noUidPlus.imap.addMessage(sampleMessage('d', 'x'));
    await expect(
      noUidPlus.mail.deleteMessages(bot2.id, direct2.id, { uids: [uid2] }),
    ).rejects.toMatchObject({ code: 'MAIL_CAPABILITY' });
    expect(noUidPlus.imap.inbox.messages).toHaveLength(1);
  });
});

describe('saveDraft (D144)', () => {
  it('appends to the existing Drafts special-use folder with the \\Draft flag', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    local.imap.addFolder('Drafts', { specialUse: '\\Drafts' });

    const receipt = await local.mail.saveDraft(identityOf(bot.id, direct.id), {
      to: ['kate@example.com'],
      subject: 'draft subject',
      text: 'draft body',
    });
    expect(receipt).toContain('草稿已保存到 Drafts');
    const draft = local.imap.folders.get('Drafts')?.messages[0];
    expect(draft?.flags).toEqual(['\\Draft']);
    expect(draft?.raw).toContain('Subject: draft subject');
    expect(draft?.raw).toContain('To: kate@example.com');
    expect(draft?.raw).toContain('draft body');
    // 草稿有 Message-ID / Date 头（nodemailer 组装，和真实发信同源）。
    expect(draft?.raw).toMatch(/Message-ID: </);
    expect(draft?.raw).toMatch(/^Date: /m);
    // RFC 822/9051：必须全 CRLF，不能有裸 LF 或孤 CR（newline '\r\n' 的回归断言）。
    expect(draft?.raw.match(/(?<!\r)\n/g) ?? []).toHaveLength(0);
    expect(draft?.raw.match(/\r(?!\n)/g) ?? []).toHaveLength(0);
  });

  it('auto-creates a Drafts folder when the server has none', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    expect(local.imap.folders.size).toBe(1);
    const receipt = await local.mail.saveDraft(identityOf(bot.id, direct.id), {
      to: [],
      subject: 'no folder',
      text: 'x',
    });
    expect(receipt).toContain('草稿已保存到 Drafts');
    expect(local.imap.folders.get('Drafts')?.messages).toHaveLength(1);
  });

  it('rejects invalid recipients', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    await expect(
      local.mail.saveDraft(identityOf(bot.id, direct.id), {
        to: ['not-an-email'],
        subject: 's',
        text: 'x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('folders (D144)', () => {
  it('lists with special-use labels and guards system folders', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    local.imap.addFolder('Drafts', { specialUse: '\\Drafts' });
    local.imap.addFolder('Trash', { specialUse: '\\Trash' });

    const listed = await local.mail.listFolders(bot.id, direct.id, {});
    expect(listed).toContain('- INBOX');
    expect(listed).toContain('- Drafts（草稿箱）');
    expect(listed).toContain('- Trash（废纸篓）');

    const created = await local.mail.createFolder(bot.id, direct.id, { path: 'Work' });
    expect(created).toContain('已创建');
    const again = await local.mail.createFolder(bot.id, direct.id, { path: 'Work' });
    expect(again).toContain('已存在');

    const renamed = await local.mail.renameFolder(bot.id, direct.id, {
      path: 'Work',
      newPath: 'Project',
    });
    expect(renamed).toContain('已改名为 Project');
    expect(local.imap.folders.has('Project')).toBe(true);

    await local.mail.deleteFolder(bot.id, direct.id, { path: 'Project' });
    expect(local.imap.folders.has('Project')).toBe(false);

    await expect(
      local.mail.deleteFolder(bot.id, direct.id, { path: 'INBOX' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      local.mail.deleteFolder(bot.id, direct.id, { path: 'Trash' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      local.mail.renameFolder(bot.id, direct.id, { path: 'Drafts', newPath: 'My' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      local.mail.deleteFolder(bot.id, direct.id, { path: 'Missing' }),
    ).rejects.toThrow();
  });
});

describe('binding and taint (D144)', () => {
  it('refuses ops on an unbound account with MAIL_NOT_BOUND', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    const other = await makeBot(local.stack.core, '乙');
    const otherDirect = await openDirect(local.stack.core, other.id);
    const uid = local.imap.addMessage(sampleMessage('x', 'x'));
    await expect(
      local.mail.markMessages(other.id, otherDirect.id, { uids: [uid], seen: true }),
    ).rejects.toMatchObject({ code: 'MAIL_NOT_BOUND' });
  });

  it('marks taint after reading mail (write receipts carry no external content and do not taint)', async () => {
    const local = await setup();
    const bot = await makeBot(local.stack.core, '甲');
    const direct = await openDirect(local.stack.core, bot.id);
    await accountFor(local, bot.id);
    const uid = local.imap.addMessage(sampleMessage('hostile', 'body'));
    expect(local.stack.core.services.taint?.guard(bot.id, direct.id)).toBeNull();
    await local.mail.readMessage(bot.id, direct.id, { uid });
    expect(local.stack.core.services.taint?.guard(bot.id, direct.id)).not.toBeNull();
  });
});

function identityOf(botId: string, conversationId: string): {
  runId: string;
  botId: string;
  conversationId: string;
  loopType: 'turn';
} {
  return { runId: 'run_test', botId, conversationId, loopType: 'turn' };
}
