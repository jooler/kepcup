import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openImapflow } from '../../src/mail/imap.js';
import type { MailImap, MailImapOpenInput } from '../../src/mail/message.js';
import { FakeImapServer, sampleMessage, type FakeImapOptions } from '../support/fake-mail-server.js';

/**
 * imapflow 适配层对着假 IMAP 服务器的行为（D84 复审修复）：连接级 error 事件、ID 发送策略、
 * 未读数、UIDVALIDITY、坏 Date 头。
 */

let previous: string | undefined;
const servers: FakeImapServer[] = [];
const clients: MailImap[] = [];

beforeEach(() => {
  previous = process.env.KEPCUP_MAIL_ALLOW_PRIVATE;
  process.env.KEPCUP_MAIL_ALLOW_PRIVATE = '1';
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const server of servers.splice(0)) await server.stop();
  if (previous === undefined) delete process.env.KEPCUP_MAIL_ALLOW_PRIVATE;
  else process.env.KEPCUP_MAIL_ALLOW_PRIVATE = previous;
});

async function startServer(options: FakeImapOptions = {}): Promise<FakeImapServer> {
  const server = new FakeImapServer(options);
  await server.start();
  servers.push(server);
  return server;
}

async function open(
  server: FakeImapServer,
  extra: Partial<MailImapOpenInput> = {},
): Promise<MailImap> {
  const client = await openImapflow({
    host: '127.0.0.1',
    port: server.port,
    secure: 'ssl',
    username: 'bot@example.com',
    password: 'authcode',
    ...extra,
  });
  clients.push(client);
  return client;
}

describe('connection error events (review #1)', () => {
  it('turns an idle-time connection error into a subscriber callback instead of an unhandled exception', async () => {
    const server = await startServer({ advertiseIdle: false });
    const client = await open(server);
    await client.selectInbox();
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));
    // 空闲连接被 RST：socket 报 ECONNRESET，imapflow 会 emit('error')。
    server.resetConnections();
    await waitUntil(() => errors.length > 0);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it('does not crash when nobody subscribed, and replays the failure to a late subscriber', async () => {
    const server = await startServer({ advertiseIdle: false });
    const client = await open(server);
    await client.selectInbox();
    server.resetConnections();
    // 没有订阅者：库的 error 事件必须有人接，否则 vitest 会把未处理异常记成失败。
    await new Promise((resolve) => setTimeout(resolve, 300));
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));
    await waitUntil(() => errors.length > 0);
    expect(errors).toHaveLength(1);
  });

  it('stops delivering to a subscriber once the connection is closed or unsubscribed', async () => {
    const server = await startServer({ advertiseIdle: false });
    const client = await open(server);
    await client.selectInbox();
    const errors: Error[] = [];
    const unsubscribe = client.onError((error) => errors.push(error));
    unsubscribe();
    server.resetConnections();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(errors).toHaveLength(0);
  });
});

describe('IMAP ID policy (review #6)', () => {
  it('forces ID for a server that needs but does not advertise it (163 style) and tolerates BAD', async () => {
    const needs = await startServer({ requireId: true, advertiseIdle: false });
    const client = await open(needs, { forceId: true });
    await expect(client.selectInbox()).resolves.toMatchObject({ uidNext: 1 });
    expect(needs.idCommands).toBe(1);
    // 不支持 ID 的服务器回 BAD：强发也不能把连接搞挂。
    const bad = await startServer({ rejectId: true, advertiseIdle: false });
    const second = await open(bad, { forceId: true });
    await expect(second.selectInbox()).resolves.toMatchObject({ uidNext: 1 });
    expect(bad.idCommands).toBe(1);
  });

  it('does not send ID at all to a server that neither advertises nor needs it', async () => {
    const server = await startServer({ rejectId: true, advertiseIdle: false });
    const client = await open(server);
    await client.selectInbox();
    expect(server.idCommands).toBe(0);
    expect(client.capabilities).not.toContain('ID');
  });

  it('adds no ID of its own when the server advertises it (the library already sends it)', async () => {
    const plain = await startServer({ advertiseId: true, advertiseIdle: false });
    await (await open(plain)).selectInbox();
    const forced = await startServer({ advertiseId: true, advertiseIdle: false });
    await (await open(forced, { forceId: true })).selectInbox();
    // 广告了 ID 时库自己在登录前后发（假服务器的应答太短，它会再发一次）；我们不再多发。
    expect(plain.idCommands).toBeGreaterThan(0);
    expect(forced.idCommands).toBe(plain.idCommands);
  });

  it('decides by host: NetEase hosts need ID, others do not', async () => {
    const { mailHostNeedsImapId } = await import('../../src/mail/message.js');
    for (const host of ['imap.163.com', 'imap.126.com', 'imap.yeah.net', 'imap.188.com', 'IMAP.163.COM']) {
      expect(mailHostNeedsImapId(host), host).toBe(true);
    }
    for (const host of ['imap.qq.com', 'imap.gmail.com', 'mail.evil163.com', '127.0.0.1', 'imap.163.com.evil.org']) {
      expect(mailHostNeedsImapId(host), host).toBe(false);
    }
  });

  it('does not leave a fake ID capability behind', async () => {
    const server = await startServer({ requireId: true, advertiseIdle: false });
    const client = await open(server, { forceId: true });
    expect(client.capabilities).not.toContain('ID');
  });
});

describe('selectInbox (review #7, #9)', () => {
  it('reports the number of unseen messages, not the sequence number of the first unseen one', async () => {
    const server = await startServer({ advertiseIdle: false });
    server.addMessage(sampleMessage('a', 'x'), { seen: true });
    server.addMessage(sampleMessage('b', 'x'), { seen: true });
    server.addMessage(sampleMessage('c', 'x'), { seen: false });
    server.addMessage(sampleMessage('d', 'x'), { seen: true });
    const client = await open(server);
    const box = await client.selectInbox();
    // SELECT 里的 [UNSEEN 3] 是序号；未读数量只有 1。
    expect(box.unseen).toBe(1);
    expect(box.uidNext).toBe(5);
  });

  it('reports UIDVALIDITY', async () => {
    const server = await startServer({ advertiseIdle: false });
    server.uidValidity = 777;
    const client = await open(server);
    expect((await client.selectInbox()).uidValidity).toBe(777);
  });
});

describe('unparseable Date headers (review #3)', () => {
  it('lists and reads a message whose Date header cannot be parsed, falling back to INTERNALDATE', async () => {
    const server = await startServer({ advertiseIdle: false });
    server.addMessage(sampleMessage('broken date', 'body here', { date: 'not a real date' }));
    server.addMessage(sampleMessage('fine', 'body two'));
    const client = await open(server);
    await client.selectInbox();
    const envelopes = await client.fetch([1, 2], false);
    expect(envelopes.map((mail) => mail.uid)).toEqual([1, 2]);
    expect(envelopes[0]?.subject).toBe('broken date');
    expect(envelopes[0]?.date).toBe('2026-10-12T01:00:00.000Z');
    expect(envelopes[1]?.date).toBe('2026-10-12T01:00:00.000Z');
    const [full] = await client.fetch([1], true);
    expect(full?.text).toContain('body here');
    expect(() => new Date(full?.date ?? '').toISOString()).not.toThrow();
  });
});

describe('mailbox write ops (D144)', () => {
  it('selects folders read-write and reports the selected path', async () => {
    const server = await startServer({ advertiseIdle: false });
    server.addFolder('Archive');
    const client = await open(server);
    expect(client.selectedPath()).toBeNull();
    await client.selectInbox();
    expect(client.selectedPath()).toBe('INBOX');
    await client.select('Archive');
    expect(client.selectedPath()).toBe('Archive');
    expect((await client.select('Archive')).uidNext).toBe(1);
  });

  it('stores flags on INBOX and subfolder messages, and fetches them back', async () => {
    const server = await startServer({ advertiseIdle: false });
    const uid = server.addMessage(sampleMessage('a', 'x'));
    const client = await open(server);
    await client.selectInbox();
    await expect(client.storeFlags([uid], 'add', ['\\Seen', 'bill'])).resolves.toBe(true);
    expect(server.inbox.messages[0]?.flags).toEqual(['\\Seen', 'bill']);
    await expect(client.fetchFlags([uid])).resolves.toEqual([{ uid, flags: ['\\Seen', 'bill'] }]);
    await expect(client.storeFlags([uid], 'remove', ['\\Seen'])).resolves.toBe(true);
    expect(server.inbox.messages[0]?.flags).toEqual(['bill']);
    // 标签状态会体现在 mail_list 的信封里。
    const [envelope] = await client.fetch([uid], false);
    expect(envelope?.flags).toEqual(['bill']);
  });

  it('reports false when the server only permits a subset of flags', async () => {
    const server = await startServer({ advertiseIdle: false, permanentFlags: '\\Seen' });
    const uid = server.addMessage(sampleMessage('a', 'x'));
    const client = await open(server);
    await client.selectInbox();
    await expect(client.storeFlags([uid], 'add', ['\\Flagged'])).resolves.toBe(false);
    expect(server.inbox.messages[0]?.flags).toEqual([]);
    await expect(client.storeFlags([uid], 'add', ['\\Seen'])).resolves.toBe(true);
    expect(server.inbox.messages[0]?.seen).toBe(true);
  });

  it('searches by keyword', async () => {
    const server = await startServer({ advertiseIdle: false });
    const tagged = server.addMessage(sampleMessage('tagged', 'x'));
    server.addMessage(sampleMessage('plain', 'x'));
    const client = await open(server);
    await client.selectInbox();
    await client.storeFlags([tagged], 'add', ['bill']);
    await expect(client.search({ keyword: 'bill' })).resolves.toEqual([tagged]);
    await expect(client.search({ keyword: 'missing-tag' })).resolves.toEqual([]);
  });

  it('moves messages to another folder and reports the uid map', async () => {
    const server = await startServer({ advertiseIdle: false });
    const uid = server.addMessage(sampleMessage('movable', 'x'));
    server.addMessage(sampleMessage('stays', 'x'));
    const client = await open(server);
    await client.selectInbox();
    await client.createFolder('Archive');
    const result = await client.move([uid], 'Archive');
    expect(result.uidMap).toEqual({ [uid]: 1 });
    expect(server.inbox.messages.map((message) => message.raw)).toHaveLength(1);
    expect(server.folders.get('Archive')?.messages).toHaveLength(1);
    expect(server.folders.get('Archive')?.messages[0]?.raw).toContain('Subject: movable');
  });

  it('falls back to COPY + targeted delete when MOVE is not advertised but UIDPLUS is', async () => {
    // imapflow 的回退：COPY → UID EXPUNGE（UIDPLUS 精确删除）。这条路径若误用全箱
    // EXPUNGE，会把别的客户端挂起的 \Deleted 一起收掉——守卫回归就靠这条测试。
    const server = await startServer({ advertiseIdle: false, advertiseMove: false });
    const uid = server.addMessage(sampleMessage('fallback move', 'x'));
    const deletedByOther = server.addMessage(sampleMessage('pending delete', 'x'), { flags: ['\\Deleted'] });
    const stays = server.addMessage(sampleMessage('stays', 'x'));
    const client = await open(server);
    await client.selectInbox();
    await client.createFolder('Archive');
    const result = await client.move([uid], 'Archive');
    expect(result.uidMap).toEqual({ [uid]: 1 });
    expect(server.folders.get('Archive')?.messages[0]?.raw).toContain('Subject: fallback move');
    // 别的客户端挂起的 \Deleted 不被牵连。
    expect(server.inbox.messages.map((message) => message.uid).sort()).toEqual([deletedByOther, stays].sort());
  });

  it('appends a draft to a folder and returns its uid', async () => {
    const server = await startServer({ advertiseIdle: false });
    server.addFolder('Drafts');
    const client = await open(server);
    await client.selectInbox();
    const source = Buffer.from(sampleMessage('draft subject', 'draft body'), 'utf8');
    const uid = await client.append('Drafts', source, ['\\Draft']);
    expect(uid).toBe(1);
    const stored = server.folders.get('Drafts')?.messages[0];
    expect(stored?.flags).toEqual(['\\Draft']);
    expect(stored?.raw).toBe(source.toString('utf8'));
  });

  it('appends multibyte UTF-8 content byte-exactly (literals are counted in bytes)', async () => {
    const server = await startServer({ advertiseIdle: false });
    server.addFolder('Drafts');
    const client = await open(server);
    await client.selectInbox();
    // 中文正文：literal 长度按字节计，不能按字符截断。
    const source = Buffer.from(sampleMessage('中文草稿', '正文第一行\r\n正文第二行'), 'utf8');
    const uid = await client.append('Drafts', source, ['\\Draft']);
    expect(uid).toBe(1);
    const stored = server.folders.get('Drafts')?.messages[0];
    expect(Buffer.byteLength(stored?.raw ?? '', 'utf8')).toBe(source.length);
    expect(stored?.raw).toBe(source.toString('utf8'));
  });

  it('creates, renames, deletes folders and reports existence via created:false', async () => {
    const server = await startServer({ advertiseIdle: false });
    const client = await open(server);
    await client.selectInbox();
    await expect(client.createFolder('Work')).resolves.toEqual({ created: true });
    await expect(client.createFolder('Work')).resolves.toEqual({ created: false });
    await client.renameFolder('Work', 'Project');
    expect(server.folders.has('Work')).toBe(false);
    expect(server.folders.has('Project')).toBe(true);
    await client.deleteFolder('Project');
    expect(server.folders.has('Project')).toBe(false);
    await expect(client.deleteFolder('Missing')).rejects.toThrow();
    await expect(client.deleteFolder('INBOX')).rejects.toThrow();
  });

  it('lists folders with special-use annotations', async () => {
    const server = await startServer({ advertiseIdle: false });
    server.addFolder('Drafts', { specialUse: '\\Drafts' });
    server.addFolder('Trash', { specialUse: '\\Trash' });
    const client = await open(server);
    await client.selectInbox();
    const folders = await client.listFolders();
    const byPath = new Map(folders.map((folder) => [folder.path, folder]));
    expect(byPath.get('INBOX')?.selectable).toBe(true);
    expect(byPath.get('Drafts')?.specialUse).toBe('\\Drafts');
    expect(byPath.get('Trash')?.specialUse).toBe('\\Trash');
  });

  it('hard-deletes messages via UID EXPUNGE (UIDPLUS)', async () => {
    const server = await startServer({ advertiseIdle: false });
    const gone = server.addMessage(sampleMessage('delete me', 'x'));
    const stays = server.addMessage(sampleMessage('keep me', 'x'));
    const client = await open(server);
    await client.selectInbox();
    await expect(client.deleteMessages([gone])).resolves.toBe(true);
    expect(server.inbox.messages.map((message) => message.uid)).toEqual([stays]);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
