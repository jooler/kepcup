import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationCache, MessageCache } from '@kepcup/shared';
import {
  CachePartition,
  attachmentFileName,
  openAttachment,
  partitionPathsOf,
  sealAttachment,
} from './team-cache/partition';
import { DEFAULT_ATTACHMENT_LIMIT_BYTES, TeamCacheService } from './team-cache/service';

/**
 * T8 步骤 1（team-cache/）：加密分区库的单测——真 fs（tmpdir）+ 注入 safeStorage
 * / 随机源 / 时钟，不起 Electron、不连网。覆盖任务书 §测试：加密文件离线不可读
 * （错密钥打不开 → 重建不崩）、key.bin 0600、分区互不可见（同设备两成员 / 两
 * 服务器）、put/get 往返、replace 对账删除、损坏重建、LRU 淘汰（小上限注入）、
 * clearPartition / clearServer、safeStorage 不可用 → 缓存禁用（不做明文兜底）。
 */

// --- fakes -----------------------------------------------------------------

/** safeStorage 可用版：`enc:<base64>` 往返（不真加密，只验调用面与往返语义）。 */
function fakeSafeStorage(): {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
} {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`),
    decryptString: (sealed) => Buffer.from(sealed.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
}

const unavailableSafeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.alloc(0),
  decryptString: () => '',
};

// --- 夹具 -----------------------------------------------------------------

function convFixture(id: string, overrides: Partial<ConversationCache> = {}): ConversationCache {
  return {
    id,
    type: 'dm',
    title: null,
    directBotId: null,
    readOnly: false,
    workdirId: null,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 10,
    lastReadSeq: 0,
    lastMessageAt: 1000,
    createdAt: 500,
    ...overrides,
  } as ConversationCache;
}

function msgFixture(conversationId: string, seq: number, overrides: Partial<MessageCache> = {}): MessageCache {
  return {
    id: `msg-${conversationId}-${seq}`,
    conversationId,
    seq,
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    content: { text: `hello ${seq}` },
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 1000 + seq,
    attachments: [],
    ownerBotId: null,
    taskId: null,
    ...overrides,
  } as MessageCache;
}

/** 单调时钟（LRU 平手确定性）+ 随机源（真随机足够——密文断言不依赖密钥值）。 */
function serviceDeps(dir: string, overrides: { now?: () => number } = {}) {
  return {
    baseDir: () => dir,
    safeStorage: fakeSafeStorage(),
    now: overrides.now ?? (() => 1),
    log: () => undefined,
  };
}

let dir: string;
const caches: TeamCacheService[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kepcup-team-cache-'));
});

afterEach(() => {
  for (const cache of caches.splice(0)) cache.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

const HASH = 'a1b2c3d4e5f60718';
const MEMBER = 'mbr_aaa';
const MEMBER2 = 'mbr_bbb';

function track(cache: TeamCacheService): TeamCacheService {
  caches.push(cache);
  return cache;
}

function service(): TeamCacheService {
  return track(new TeamCacheService(serviceDeps(dir)));
}

// --- 用例 -----------------------------------------------------------------

describe('分区库：加密与密钥', () => {
  it('cache.db 落盘为密文（离线读不到明文），key.bin 0600 且 safeStorage 密文', async () => {
    const cache = service();
    cache.putConversations({ serverHash: HASH, memberId: MEMBER, conversations: [convFixture('c1')] });
    cache.putMessages({
      serverHash: HASH,
      memberId: MEMBER,
      conversationId: 'c1',
      messages: [msgFixture('c1', 1)],
    });
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: 'att1', bytes: 'cGVua2VkLXNlY3JldC1ieXRlcw==' });

    const paths = partitionPathsOf(dir, HASH, MEMBER);
    const rawDb = readFileSync(paths.dbFile).toString('latin1');
    expect(rawDb).not.toContain('hello 1');
    expect(rawDb).not.toContain('"c1"');
    const rawAttachment = readFileSync(path.join(paths.attachmentsDir, attachmentFileName('att1')));
    expect(rawAttachment.toString('latin1')).not.toContain('penked-secret-bytes');
    // 密文可用分区密钥解开（往返）。
    const sealed = readFileSync(path.join(paths.attachmentsDir, attachmentFileName('att1')));
    const keyHex = fakeSafeStorage().decryptString(readFileSync(paths.keyFile));
    const plain = openAttachment(
      sealed,
      'att1',
      Buffer.from(keyHex.replace(/^v1:/, ''), 'hex'),
    );
    expect(plain.toString('utf8')).toBe('penked-secret-bytes');

    if (process.platform !== 'win32') {
      const mode = statSync(paths.keyFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('错密钥（key.bin 被换）打不开 → 删除重建空库不崩', async () => {
    const cache = service();
    cache.putConversations({ serverHash: HASH, memberId: MEMBER, conversations: [convFixture('c1')] });
    const paths = partitionPathsOf(dir, HASH, MEMBER);
    expect(existsSync(paths.dbFile)).toBe(true);

    // 模拟密钥丢失后换了一把（safeStorage 解出的 hex 不同 → 库解不开）。
    const otherKey = Buffer.alloc(32, 7);
    const sealed = fakeSafeStorage().encryptString(`v1:${otherKey.toString('hex')}`);
    chmodSync(paths.keyFile, 0o644);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(paths.keyFile, sealed, { mode: 0o600 });

    cache.closeAll();
    const cache2 = service();
    cache2.putConversations({ serverHash: HASH, memberId: MEMBER, conversations: [convFixture('c2')] });
    const read = cache2.getConversations({ serverHash: HASH, memberId: MEMBER });
    expect(read.conversations.map((c) => (c as ConversationCache).id)).toEqual(['c2']);
  });

  it('库损坏（垃圾字节 + WAL 一并损坏）→ 删除重建空库不崩', () => {
    const cache = service();
    cache.putConversations({ serverHash: HASH, memberId: MEMBER, conversations: [convFixture('c1')] });
    const paths = partitionPathsOf(dir, HASH, MEMBER);
    // 主库文件与 WAL 同时打烂（只烂主库时 WAL 恢复机制会救回已提交数据——那是
    // SQLite 的正常行为，不算损坏场景）。
    writeFileSync(paths.dbFile, Buffer.from('not a sqlite file at all'.repeat(40)));
    writeFileSync(paths.dbFile + '-wal', Buffer.from('wal garbage'.repeat(64)));
    writeFileSync(paths.dbFile + '-shm', Buffer.from('shm garbage'.repeat(64)));
    cache.closeAll();
    const cache2 = service();
    const read = cache2.getConversations({ serverHash: HASH, memberId: MEMBER });
    expect(read.conversations).toEqual([]);
    // 重建后照常可用。
    cache2.putConversations({ serverHash: HASH, memberId: MEMBER, conversations: [convFixture('c3')] });
    expect(
      cache2.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations,
    ).toHaveLength(1);
  });

  it('schema 版本不符（user_version 升到未来版本）→ 删除重建空库', () => {
    const cache = service();
    cache.putConversations({ serverHash: HASH, memberId: MEMBER, conversations: [convFixture('c1')] });
    const paths = partitionPathsOf(dir, HASH, MEMBER);
    // 用分区密钥把库的 user_version 改到未来（模拟「更高版本客户端写过」）。
    const keyHex = fakeSafeStorage().decryptString(readFileSync(paths.keyFile));
    const key = Buffer.from(keyHex.replace(/^v1:/, ''), 'hex');
    const raw = new Database(paths.dbFile);
    raw.pragma("cipher='chacha20'");
    raw.pragma(`key="x'${key.toString('hex')}'"`);
    raw.pragma(`user_version = ${99}`);
    raw.close();
    cache.closeAll();
    const cache2 = service();
    expect(cache2.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations).toEqual([]);
  });

  it('safeStorage 不可用 → open 拒绝（缓存整体禁用；不做明文兜底）', () => {
    const cache = track(new TeamCacheService({
      baseDir: () => dir,
      safeStorage: unavailableSafeStorage,
    });
    expect(() => cache.open({ serverHash: HASH, memberId: MEMBER })).toThrow(/safeStorage/);
    // 读路径静默退化（空集），绝不落明文库。
    expect(cache.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations).toEqual([]);
    expect(existsSync(partitionPathsOf(dir, HASH, MEMBER).dir)).toBe(false);
  });

  it('key.bin 缺失但库还在 → 一并重建（旧密文不可达）', () => {
    const cache = service();
    cache.putConversations({ serverHash: HASH, memberId: MEMBER, conversations: [convFixture('c1')] });
    const paths = partitionPathsOf(dir, HASH, MEMBER);
    rmSync(paths.keyFile);
    cache.closeAll();
    const cache2 = service();
    expect(cache2.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations).toEqual([]);
    expect(cache2.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations).toEqual([]);
  });
});

describe('分区隔离（62.10 §3 同设备多账号）', () => {
  it('同服务器两个成员分区互不可见', () => {
    const cache = service();
    cache.putConversations({
      serverHash: HASH,
      memberId: MEMBER,
      conversations: [convFixture('c1')],
    });
    cache.putMessages({
      serverHash: HASH,
      memberId: MEMBER,
      conversationId: 'c1',
      messages: [msgFixture('c1', 1)],
    });
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: 'att-a', bytes: 'YQ==' });

    const mine = cache.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations;
    const other = cache.getConversations({ serverHash: HASH, memberId: MEMBER2 }).conversations;
    expect(mine).toHaveLength(1);
    expect(other).toEqual([]);
    expect(cache.getMessages({ serverHash: HASH, memberId: MEMBER2, conversationId: 'c1' }).messages).toEqual([]);
    expect(
      (cache.getAttachment({ serverHash: HASH, memberId: MEMBER2, key: 'att-a' }) as { missing: true })
        .missing,
    ).toBe(true);

    // 分区目录独立、互不串写。
    expect(existsSync(partitionPathsOf(dir, HASH, MEMBER).dbFile)).toBe(true);
    cache.putConversations({
      serverHash: HASH,
      memberId: MEMBER2,
      conversations: [convFixture('c2')],
    });
    expect(cache.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations).toHaveLength(1);
    expect(cache.getConversations({ serverHash: HASH, memberId: MEMBER2 }).conversations).toHaveLength(1);
  });

  it('同一成员在不同服务器的分区互不可见', () => {
    const cache = service();
    cache.putConversations({ serverHash: HASH, memberId: MEMBER, conversations: [convFixture('c1')] });
    cache.putConversations({
      serverHash: 'b000000000000009',
      memberId: MEMBER,
      conversations: [convFixture('c2')],
    });
    expect(cache.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations).toHaveLength(1);
    expect(cache.getConversations({ serverHash: 'b000000000000009', memberId: MEMBER }).conversations).toHaveLength(1);
    // 密钥文件也是每分区一份（互不相同）。
    const keyA = readFileSync(partitionPathsOf(dir, HASH, MEMBER).keyFile);
    const keyB = readFileSync(partitionPathsOf(dir, 'b000000000000009', MEMBER).keyFile);
    expect(keyA.equals(keyB)).toBe(false);
  });
});

describe('put/get 往返与 replace 对账', () => {
  it('会话 upsert + 按 lastMessageAt 排序；replace 删除列表外的行', () => {
    const cache = service();
    cache.putConversations({
      serverHash: HASH,
      memberId: MEMBER,
      conversations: [convFixture('c1', { lastMessageAt: 100 }), convFixture('c2', { lastMessageAt: 300 })],
    });
    let rows = cache.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations as ConversationCache[];
    expect(rows.map((c) => c.id)).toEqual(['c2', 'c1']);

    // upsert 更新（不产生重复行）。
    cache.putConversations({
      serverHash: HASH,
      memberId: MEMBER,
      conversations: [convFixture('c1', { lastMessageAt: 500 })],
    });
    rows = cache.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations as ConversationCache[];
    expect(rows.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(rows[0]!.lastMessageAt).toBe(500);

    // replace 对账（bootstrap 收敛）：c2 不在清单 → 删除。
    cache.putConversations({
      serverHash: HASH,
      memberId: MEMBER,
      conversations: [convFixture('c1'), convFixture('c3')],
      replace: true,
    });
    rows = cache.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations as ConversationCache[];
    expect(rows.map((c) => c.id).sort()).toEqual(['c1', 'c3']);
  });

  it('消息按 seq upsert、getMessages 升序 + beforeSeq 分页；replace 整会话重置', () => {
    const cache = service();
    const rows = [3, 1, 2].map((seq) => msgFixture('c1', seq));
    cache.putMessages({ serverHash: HASH, memberId: MEMBER, conversationId: 'c1', messages: rows });
    let page = cache.getMessages({ serverHash: HASH, memberId: MEMBER, conversationId: 'c1' })
      .messages as MessageCache[];
    expect(page.map((m) => m.seq)).toEqual([1, 2, 3]);

    // 编辑（同 seq 新 payload）被 upsert 覆盖。
    cache.putMessages({
      serverHash: HASH,
      memberId: MEMBER,
      conversationId: 'c1',
      messages: [msgFixture('c1', 2, { status: 'edited', editedAt: 42 })],
    });
    page = cache.getMessages({ serverHash: HASH, memberId: MEMBER, conversationId: 'c1' })
      .messages as MessageCache[];
    expect(page.find((m) => m.seq === 2)?.status).toBe('edited');

    // beforeSeq 分页（desc 取页再反转——语义对齐 core messages.list）。
    const earlier = cache.getMessages({
      serverHash: HASH,
      memberId: MEMBER,
      conversationId: 'c1',
      beforeSeq: 2,
      limit: 60,
    }).messages as MessageCache[];
    expect(earlier.map((m) => m.seq)).toEqual([1]);

    // replace 重置：旧 seq 全没了。
    cache.putMessages({
      serverHash: HASH,
      memberId: MEMBER,
      conversationId: 'c1',
      messages: [msgFixture('c1', 9)],
      replace: true,
    });
    page = cache.getMessages({ serverHash: HASH, memberId: MEMBER, conversationId: 'c1' })
      .messages as MessageCache[];
    expect(page.map((m) => m.seq)).toEqual([9]);
  });
});

describe('附件 LRU 与用量', () => {
  it('LRU：小上限淘汰最久未用；get 触碰保活；clearPartition/clearServer', () => {
    let clock = 0;
    const cache = track(new TeamCacheService({ ...serviceDeps(dir), now: () => (clock += 1) });
    cache.setAttachmentLimit({ limitBytes: 120 });
    const b64 = (size: number): string => Buffer.alloc(size, 1).toString('base64');
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: 'a', bytes: b64(50) });
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: 'b', bytes: b64(50) });
    // 触碰 a（accessed_at 更新）→ 淘汰应命中 b 之后插入的 c 时保住 a。
    cache.getAttachment({ serverHash: HASH, memberId: MEMBER, key: 'a' });
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: 'c', bytes: b64(50) });

    const paths = partitionPathsOf(dir, HASH, MEMBER);
    const present = (key: string): boolean =>
      existsSync(path.join(paths.attachmentsDir, attachmentFileName(key)));
    expect(present('a')).toBe(true);
    expect(present('c')).toBe(true);
    // b 最旧 → 被淘汰（总字节回到上限内）。
    expect(present('b')).toBe(false);

    // clearPartition：分区目录整体删除（库 + 附件 + 密钥文件）。
    cache.clearPartition({ serverHash: HASH, memberId: MEMBER });
    expect(existsSync(paths.dir)).toBe(false);
    expect(cache.usage({ serverHash: HASH, memberId: MEMBER }).cacheBytes).toBeNull();

    // clearServer：该服务器全部分区（含其它成员）。
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER2, key: 'd', bytes: b64(10) });
    cache.putAttachment({ serverHash: 'f000000000000003', memberId: MEMBER, key: 'e', bytes: b64(10) });
    cache.clearServer({ serverHash: HASH });
    expect(existsSync(partitionPathsOf(dir, HASH, MEMBER).dir)).toBe(false);
    expect(existsSync(partitionPathsOf(dir, HASH, MEMBER2).dir)).toBe(false);
    expect(existsSync(partitionPathsOf(dir, 'f000000000000003', MEMBER).dir)).toBe(true);
  });

  it('默认上限 1 GB；usage 汇总分区目录字节', () => {
    const cache = service();
    expect(cache.attachmentLimitBytes()).toBe(DEFAULT_ATTACHMENT_LIMIT_BYTES);
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: 'a', bytes: Buffer.alloc(100, 2).toString('base64') });
    const usage = cache.usage({ serverHash: HASH, memberId: MEMBER });
    expect(usage.cacheBytes).toBeGreaterThan(100);
    expect(usage.attachmentLimitBytes).toBe(DEFAULT_ATTACHMENT_LIMIT_BYTES);
  });

  it('附件密文损坏 → 读时按未缓存处理并清理（下次重下）', () => {
    const cache = service();
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: 'a', bytes: Buffer.alloc(10, 3).toString('base64') });
    const paths = partitionPathsOf(dir, HASH, MEMBER);
    const file = path.join(paths.attachmentsDir, attachmentFileName('a'));
    writeFileSync(file, Buffer.alloc(4, 9));
    expect(cache.getAttachment({ serverHash: HASH, memberId: MEMBER, key: 'a' })).toEqual({ missing: true });
    expect(existsSync(file)).toBe(false);
  });

  it('AEAD：AAD 绑定 key（换 key 解密失败）', () => {
    const partition = new CachePartition(HASH, MEMBER, partitionPathsOf(dir, HASH, MEMBER), {
      safeStorage: fakeSafeStorage(),
    });
    partition.open();
    const key = Buffer.alloc(32, 5);
    const sealed = sealAttachment(Buffer.from('payload'), 'key-a', key, (n) => Buffer.alloc(n, 0));
    expect(() => openAttachment(sealed, 'key-b', key)).toThrow();
    expect(openAttachment(sealed, 'key-a', key).toString('utf8')).toBe('payload');
    partition.close();
  });
});

describe('路径注入防线（T8 审查补齐：schema regex + service 层双保险）', () => {
  it('service 层（直连调用）：serverHash / memberId 的路径注入形状一律拒绝且不落盘', () => {
    const cache = service();
    const badHashes = [
      '../escape',
      '/etc/passwd',
      'a/b',
      'a\\b',
      '..',
      '.',
      'a1b2c3d4e5f6071', // 15 位（缺 1）
      'a1b2c3d4e5f607188', // 17 位（多 1）
      'A1B2C3D4E5F60718', // 大写 hex（remoteProfileHash 恒小写）
      'g1b2c3d4e5f60718', // 非 hex
      'zzzzzzzzzzzzzzzz', // 非 hex
      '',
    ];
    for (const serverHash of badHashes) {
      expect(() =>
        cache.putConversations({ serverHash, memberId: MEMBER, conversations: [convFixture('c1')] }),
      ).toThrow(/INVALID_INPUT/);
    }
    const badMembers = ['..', '../..', '/abs', 'a/b', 'a\\b', 'mbr_', 'member1', 'mbr_../x', 'mbr_a/b', ''];
    for (const memberId of badMembers) {
      expect(() =>
        cache.putConversations({ serverHash: HASH, memberId, conversations: [convFixture('c1')] }),
      ).toThrow(/INVALID_INPUT/);
    }
    // clearServer 的 serverHash 同门。
    expect(() => cache.clearServer({ serverHash: '../escape' })).toThrow(/INVALID_INPUT/);
    // 全部拒绝：baseDir 下没有建立任何分区目录。
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('IPC 层（zod schema）：路径注入入参 → INVALID_INPUT；合法 16-hex + mbr_* 放行', () => {
    const cache = service();
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
    cache.registerIpc((channel, handler) => handlers.set(channel, handler));
    const open = handlers.get('platform:teamCache:open')!;
    expect(() => open(null, { serverHash: '../escape', memberId: MEMBER })).toThrow(/INVALID_INPUT/);
    expect(() => open(null, { serverHash: HASH, memberId: 'mbr_../../x' })).toThrow(/INVALID_INPUT/);
    expect(() => open(null, { serverHash: HASH, memberId: 'member-1' })).toThrow(/INVALID_INPUT/);
    expect(open(null, { serverHash: HASH, memberId: MEMBER })).toEqual({ ok: true });
    // clearPartition / clearServer 同样过 schema（跨分区误删的唯一入口是这几个动词）。
    const clearPartition = handlers.get('platform:teamCache:clearPartition')!;
    expect(() =>
      clearPartition(null, { serverHash: 'a/b/c/d', memberId: MEMBER }),
    ).toThrow(/INVALID_INPUT/);
    const clearServer = handlers.get('platform:teamCache:clearServer')!;
    expect(() => clearServer(null, { serverHash: '..' })).toThrow(/INVALID_INPUT/);
  });

  it('附件 key 含路径字符 → 文件名恒为 sha256 hex（attachmentsDir 下无子目录、无逃逸）', () => {
    const cache = service();
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: '../../evil', bytes: 'YQ==' });
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: 'a\\b', bytes: 'Yg==' });
    const paths = partitionPathsOf(dir, HASH, MEMBER);
    const entries = readdirSync(paths.attachmentsDir, { withFileTypes: true });
    expect(entries.length).toBe(2);
    expect(entries.every((entry) => !entry.isDirectory() && /^[0-9a-f]{64}\.bin$/.test(entry.name))).toBe(
      true,
    );
    expect(existsSync(path.join(paths.attachmentsDir, attachmentFileName('../../evil')))).toBe(true);
    // 读回同 key 命中（文件名函数与写侧一致）。
    expect(cache.getAttachment({ serverHash: HASH, memberId: MEMBER, key: '../../evil' })).toEqual({
      bytes: 'YQ==',
    });
  });
});

describe('分区重建不外溢（T8 审查补齐）', () => {
  it('分区 A 损坏重建只清 A：分区 B 的库 / 附件 / 密钥原样', () => {
    const cache = service();
    cache.putConversations({ serverHash: HASH, memberId: MEMBER, conversations: [convFixture('c1')] });
    cache.putConversations({ serverHash: HASH, memberId: MEMBER2, conversations: [convFixture('c2')] });
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER2, key: 'att-b', bytes: 'Yg==' });
    const pathsA = partitionPathsOf(dir, HASH, MEMBER);
    const pathsB = partitionPathsOf(dir, HASH, MEMBER2);
    const keyBBefore = readFileSync(pathsB.keyFile);

    // 打烂 A 的库（主库 + WAL）→ 重建。
    writeFileSync(pathsA.dbFile, Buffer.from('corrupt'.repeat(64)));
    writeFileSync(pathsA.dbFile + '-wal', Buffer.from('wal garbage'.repeat(64)));
    cache.closeAll();
    const cache2 = service();
    expect(cache2.getConversations({ serverHash: HASH, memberId: MEMBER }).conversations).toEqual([]);
    expect(cache2.getConversations({ serverHash: HASH, memberId: MEMBER2 }).conversations).toHaveLength(1);
    // B 的附件可读、密钥文件字节未变（没有连锁重建）。
    expect(cache2.getAttachment({ serverHash: HASH, memberId: MEMBER2, key: 'att-b' })).toEqual({
      bytes: 'Yg==',
    });
    expect(readFileSync(pathsB.keyFile).equals(keyBBefore)).toBe(true);
    expect(existsSync(pathsB.attachmentsDir)).toBe(true);
  });

  it('LRU 淘汰只动当前分区：A 超限淘汰不触碰 B 的附件', () => {
    let clock = 0;
    const cache = track(new TeamCacheService({ ...serviceDeps(dir), now: () => (clock += 1) });
    cache.setAttachmentLimit({ limitBytes: 120 });
    const b64 = (size: number): string => Buffer.alloc(size, 1).toString('base64');
    // B 先放一个附件（accessed_at 更早）。
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER2, key: 'b-keep', bytes: b64(50) });
    // A 放三个（合计 150 > 120 → 淘汰最旧的）。
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: 'a-1', bytes: b64(50) });
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: 'a-2', bytes: b64(50) });
    cache.putAttachment({ serverHash: HASH, memberId: MEMBER, key: 'a-3', bytes: b64(50) });

    const pathsA = partitionPathsOf(dir, HASH, MEMBER);
    const pathsB = partitionPathsOf(dir, HASH, MEMBER2);
    // A 淘汰到上限内（三个里最旧的 a-1 被清）。
    expect(existsSync(path.join(pathsA.attachmentsDir, attachmentFileName('a-1')))).toBe(false);
    expect(existsSync(path.join(pathsA.attachmentsDir, attachmentFileName('a-2')))).toBe(true);
    expect(existsSync(path.join(pathsA.attachmentsDir, attachmentFileName('a-3')))).toBe(true);
    // B 的附件原样（淘汰循环只查 A 分区的表）。
    expect(existsSync(path.join(pathsB.attachmentsDir, attachmentFileName('b-keep')))).toBe(true);
    expect(cache.getAttachment({ serverHash: HASH, memberId: MEMBER2, key: 'b-keep' })).toEqual({
      bytes: b64(50),
    });
  });
});

describe('platform 装配（registerIpc + zod 入参校验）', () => {
  it('12 个 channel 全部登记，handlers 经 shared schema 校验入参（仿 teamServers）', () => {
    const cache = service();
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
    cache.registerIpc((channel, handler) => handlers.set(channel, handler));
    // 12 个 channel 全部登记（T8 契约面：open/close/put×2/get×2/attachment×2/clear×2/usage/limit）。
    expect(handlers.size).toBe(12);

    const open = handlers.get('platform:teamCache:open')!;
    expect(open(null, { serverHash: HASH, memberId: MEMBER })).toEqual({ ok: true });
    // 非法入参（缺 memberId）→ INVALID_INPUT JSON 错误约定。
    expect(() => open(null, { serverHash: HASH })).toThrow(/INVALID_INPUT/);

    const put = handlers.get('platform:teamCache:putConversations')!;
    expect(
      put(null, { serverHash: HASH, memberId: MEMBER, conversations: [convFixture('c9')], replace: true }),
    ).toEqual({ ok: true });
    const get = handlers.get('platform:teamCache:getConversations')!;
    const listed = get(null, { serverHash: HASH, memberId: MEMBER }) as { conversations: ConversationCache[] };
    expect(listed.conversations.map((c) => c.id)).toEqual(['c9']);

    const getAttachment = handlers.get('platform:teamCache:getAttachment')!;
    expect(getAttachment(null, { serverHash: HASH, memberId: MEMBER, key: 'nope' })).toEqual({ missing: true });
  });
});
