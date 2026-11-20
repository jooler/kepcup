import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationCache, MessageCache } from '@kepcup/shared';
import {
  createIdbTeamCacheStore,
  createMemoryIdbFactory,
  idbNameOf,
  type IdbFactoryLike,
} from './team-cache-idb';

/**
 * T8 步骤 2（team-cache-idb.ts）：web IndexedDB 适配器。仓库无 fake-indexeddb，
 * 也不新增依赖——适配器以可注入的 `IdbFactoryLike` 最小面为底座，测试用内存
 * 替身（createMemoryIdbFactory）跑真实 adapter 逻辑（该决定记入任务报告）。
 * localStorage 仍是测试桩（库名登记表）。
 */

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

const P = { serverHash: 'h1', memberId: 'mbr_a' };
const P2 = { serverHash: 'h1', memberId: 'mbr_b' };

let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal(
    'localStorage',
    {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
      clear: () => void storage.clear(),
      get length() {
        return storage.size;
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IDB 适配器（内存替身底座）', () => {
  it('库按 (serverHash, memberId) 分区命名，open 登记 localStorage 清单', async () => {
    const factory = createMemoryIdbFactory();
    const store = createIdbTeamCacheStore({ factory });
    await store.open(P);
    expect(idbNameOf(P)).toBe('kepcup-team-cache:h1:mbr_a');
    expect(JSON.parse(storage.get('kepcup.teamCache.dbs') ?? '[]')).toEqual([
      'kepcup-team-cache:h1:mbr_a',
    ]);
    await store.open(P2);
    expect(JSON.parse(storage.get('kepcup.teamCache.dbs') ?? '[]')).toEqual([
      'kepcup-team-cache:h1:mbr_a',
      'kepcup-team-cache:h1:mbr_b',
    ]);
  });

  it('会话 put/get 往返 + replace 对账删除；不同分区互不可见', async () => {
    const factory = createMemoryIdbFactory();
    const store = createIdbTeamCacheStore({ factory });
    await store.putConversations(P, [convFixture('c1', { lastMessageAt: 100 }), convFixture('c2', { lastMessageAt: 200 })]);
    await store.putConversations(P2, [convFixture('c3')]);

    let rows = await store.getConversations(P);
    expect(rows.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect((await store.getConversations(P2)).map((c) => c.id)).toEqual(['c3']);

    // replace：c2 不在清单 → 删除（c1 upsert 保留）。
    await store.putConversations(P, [convFixture('c1', { lastMessageAt: 300 })], true);
    rows = await store.getConversations(P);
    expect(rows.map((c) => c.id)).toEqual(['c1']);
    expect(rows[0]!.lastMessageAt).toBe(300);
  });

  it('消息按 seq 升序返回；beforeSeq / limit 分页；replace 清会话；编辑 upsert', async () => {
    const factory = createMemoryIdbFactory();
    const store = createIdbTeamCacheStore({ factory });
    await store.putMessages(P, 'c1', [msgFixture('c1', 3), msgFixture('c1', 1), msgFixture('c1', 2)]);

    let rows = await store.getMessages(P, 'c1', { limit: 60 });
    expect(rows.map((m) => m.seq)).toEqual([1, 2, 3]);

    // limit：desc 取页再反转。
    rows = await store.getMessages(P, 'c1', { limit: 2 });
    expect(rows.map((m) => m.seq)).toEqual([2, 3]);

    // beforeSeq。
    rows = await store.getMessages(P, 'c1', { beforeSeq: 3, limit: 60 });
    expect(rows.map((m) => m.seq)).toEqual([1, 2]);

    // 编辑同 seq 覆盖。
    await store.putMessages(P, 'c1', [msgFixture('c1', 2, { status: 'edited' })]);
    rows = await store.getMessages(P, 'c1', { limit: 60 });
    expect(rows.find((m) => m.seq === 2)?.status).toBe('edited');

    // replace 清空该会话（不影响其它会话）。
    await store.putMessages(P, 'c2', [msgFixture('c2', 9)]);
    await store.putMessages(P, 'c1', [msgFixture('c1', 9)], true);
    expect((await store.getMessages(P, 'c1', { limit: 60 })).map((m) => m.seq)).toEqual([9]);
    expect((await store.getMessages(P, 'c2', { limit: 60 })).map((m) => m.seq)).toEqual([9]);
  });

  it('附件 put/get/missing；clearPartition 删库 + 登记表；clearServer 只删该服务器', async () => {
    const factory = createMemoryIdbFactory();
    const store = createIdbTeamCacheStore({ factory });
    await store.putAttachment(P, 'att1', 'YmFzZTY0');
    await expect(store.getAttachment(P, 'att1')).resolves.toEqual({ bytesBase64: 'YmFzZTY0' });
    await expect(store.getAttachment(P, 'nope')).resolves.toEqual({ missing: true });

    // P2 的库也已登记（clearServer 需要把它一起删掉）。
    await store.open(P2);

    await store.clearPartition(P);
    expect(storage.get('kepcup.teamCache.dbs')).not.toContain('h1:mbr_a');
    // 库已删：数据没了（重新 open 后为空）。
    const fresh = createIdbTeamCacheStore({ factory });
    await fresh.open(P);
    await expect(fresh.getAttachment(P, 'att1')).resolves.toEqual({ missing: true });

    await store.putAttachment(P, 'att2', 'YQ==');
    await store.putAttachment({ serverHash: 'h9', memberId: 'mbr_a' }, 'att3', 'Yg==');
    await store.clearServer('h1');
    const names = JSON.parse(storage.get('kepcup.teamCache.dbs') ?? '[]') as string[];
    expect(names).toEqual(['kepcup-team-cache:h9:mbr_a']);
    const after = createIdbTeamCacheStore({ factory });
    await after.open(P);
    await expect(after.getAttachment(P, 'att2')).resolves.toEqual({ missing: true });
  });

  it('工厂 open 失败 → 方法抛错（引擎按禁用处理）；close 丢弃句柄不删数据', async () => {
    let openCalls = 0;
    const factory: IdbFactoryLike = {
      open: () => {
        openCalls += 1;
        return Promise.reject(new Error('quota exceeded'));
      },
      remove: () => Promise.resolve(),
    };
    const store = createIdbTeamCacheStore({ factory });
    await expect(store.open(P)).rejects.toThrow('quota exceeded');
    expect(openCalls).toBe(1);
    // 句柄 promise 缓存的是 rejected 状态？——close 后重试重新 open。
    await store.close(P);
    openCalls = 0;
    await store.open(P).catch(() => undefined);
    expect(openCalls).toBe(1);
  });
});
