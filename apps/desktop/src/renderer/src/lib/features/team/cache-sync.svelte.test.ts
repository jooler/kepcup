import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationCache, Message } from '@kepcup/shared';

/**
 * T8 步骤 3（cache-sync.svelte.ts）：同步引擎单测——假团队连接 + 内存 platform
 * 替身（与主进程 zod 契约同形状），localStorage 桩存同步 cursor。覆盖任务书：
 * 休眠断言（无 platform 不 open）、首连 bootstrap 对账（replace）、断线补拉不重
 * 不漏（seq 断言）、seq 断档 → 损坏重拉、changedSince 收敛、事件直写、会话删除
 * 经 bootstrap 收敛、同设备两成员分区互不可见、safeStorage / open 失败 → 缓存
 * 禁用退化、离线只读判定。
 */

const h = vi.hoisted(() => {
  const state = {
    sourcesChanged: [] as Array<() => void>,
    conn: null as null | {
      status: 'offline' | 'reconnecting' | 'connecting' | 'connected';
      memberId: string | null;
      connectedHandlers: Array<() => void>;
      eventHandlers: Map<string, Set<(payload: unknown) => void>>;
      calls: Array<{ method: string; input: unknown }>;
      responder: (method: string, input: Record<string, unknown>) => unknown;
      onConnected(handler: () => void): () => void;
      onEvent(name: string, handler: (payload: unknown) => void): () => void;
      call(method: string, input?: unknown): Promise<unknown>;
      callTeam(method: string, input?: unknown): Promise<unknown>;
    },
    /** 内存分区：<serverHash>::<memberId> → 数据。 */
    parts: new Map<string, { conversations: Map<string, unknown>; messages: Map<string, Map<number, unknown>>; attachments: Map<string, string> }>(),
    /** 当前团队来源的 serverHash（harness 按用例注入；sources() 据此拼 source id）。 */
    currentHash: 'h1',
    /** platform 调用台账。 */
    verbs: [] as Array<{ verb: string; input: Record<string, unknown> }>,
    storage: new Map<string, string>(),
    /** open 拒绝（safeStorage 不可用 / 磁盘故障模拟）。 */
    openFails: false,
    serverSeq: 0,
    /** 来源清单（connections.sources()；休眠用例注入 ['local']）。 */
    sourceList: ['local'] as string[],
  };
  return state;
});

function partKey(serverHash: string, memberId: string): string {
  return `${serverHash}::${memberId}`;
}

function partOf(serverHash: string, memberId: string): {
  conversations: Map<string, unknown>;
  messages: Map<string, Map<number, unknown>>;
  attachments: Map<string, string>;
} {
  const key = partKey(serverHash, memberId);
  let part = h.parts.get(key);
  if (part === undefined) {
    part = { conversations: new Map(), messages: new Map(), attachments: new Map() };
    h.parts.set(key, part);
  }
  return part;
}

/** 内存 platform 替身：方法名 / 输入输出形状与 preload 的 platform.teamCache 一致。 */
function fakePlatformApi(): Record<string, (input?: unknown) => Promise<unknown>> {
  const record = (verb: string, input: Record<string, unknown>): void => {
    h.verbs.push({ verb, input });
  };
  const part = (input: { serverHash: string; memberId: string }): ReturnType<typeof partOf> =>
    partOf(input.serverHash, input.memberId);
  return {
    open: async (raw) => {
      const input = raw as { serverHash: string; memberId: string };
      record('open', input);
      if (h.openFails) throw new Error('safeStorage unavailable');
      partOf(input.serverHash, input.memberId);
      return { ok: true };
    },
    close: async () => ({ ok: true }),
    putConversations: async (raw) => {
      const input = raw as {
        serverHash: string;
        memberId: string;
        conversations: Conversation[];
        replace?: boolean;
      };
      record('putConversations', input);
      const bucket = partOf(input.serverHash, input.memberId);
      if (input.replace === true) {
        const keep = new Set(input.conversations.map((c) => c.id));
        for (const id of [...bucket.conversations.keys()]) {
          if (!keep.has(id)) bucket.conversations.delete(id);
        }
      }
      for (const conversation of input.conversations) bucket.conversations.set(conversation.id, conversation);
      return { ok: true };
    },
    putMessages: async (raw) => {
      const input = raw as {
        serverHash: string;
        memberId: string;
        conversationId: string;
        messages: Message[];
        replace?: boolean;
      };
      record('putMessages', input);
      const bucket = partOf(input.serverHash, input.memberId);
      let rows = bucket.messages.get(input.conversationId);
      if (rows === undefined) {
        rows = new Map();
        bucket.messages.set(input.conversationId, rows);
      }
      if (input.replace === true) rows.clear();
      for (const message of input.messages) rows.set(message.seq, message);
      return { ok: true };
    },
    getConversations: async (raw) => {
      const input = raw as { serverHash: string; memberId: string };
      record('getConversations', input);
      return { conversations: [...part(input).conversations.values()] };
    },
    getMessages: async (raw) => {
      const input = raw as { serverHash: string; memberId: string; conversationId: string; limit?: number; beforeSeq?: number };
      record('getMessages', input);
      const rows = part(input).messages.get(input.conversationId) ?? new Map<number, unknown>();
      let all = [...rows.keys()].sort((a, b) => b - a);
      if (input.beforeSeq !== undefined) all = all.filter((seq) => seq < (input.beforeSeq as number));
      const limit = input.limit ?? 60;
      const seqs = all.slice(0, limit);
      return { messages: seqs.map((seq) => rows.get(seq)).reverse() };
    },
    putAttachment: async (raw) => {
      const input = raw as { serverHash: string; memberId: string; key: string; bytes: string };
      record('putAttachment', input);
      part(input).attachments.set(input.key, input.bytes);
      return { ok: true };
    },
    getAttachment: async (raw) => {
      const input = raw as { serverHash: string; memberId: string; key: string };
      record('getAttachment', input);
      const bytes = part(input).attachments.get(input.key);
      return bytes === undefined ? { missing: true } : { bytes };
    },
    clearPartition: async (raw) => {
      const input = raw as { serverHash: string; memberId: string };
      record('clearPartition', input);
      h.parts.delete(partKey(input.serverHash, input.memberId));
      return { ok: true };
    },
    clearServer: async (raw) => {
      const input = raw as { serverHash: string };
      record('clearServer', input);
      for (const key of [...h.parts.keys()]) {
        if (key.startsWith(`${input.serverHash}::`)) h.parts.delete(key);
      }
      return { ok: true };
    },
  };
}

vi.mock('$lib/rpc/connections.svelte', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- 测试 mock 的模块类型标注。
  const actual = (await importOriginal()) as typeof import('$lib/rpc/connections.svelte');
  return {
    ...actual,
    connections: {
      sources: () => h.sourceList,
      onSourcesChanged: (callback: () => void) => {
        h.sourcesChanged.push(callback);
        queueMicrotask(callback);
        return () => undefined;
      },
      get: (source: string) => {
        if (source === 'local') {
          return {
            status: 'connected',
            memberId: null,
            onConnected: () => () => undefined,
            onEvent: () => () => undefined,
          };
        }
        return h.conn;
      },
    },
  };
});

vi.stubGlobal('window', { kepcup: { isWeb: false } });
vi.stubGlobal(
  'localStorage',
  (() => {
    const store = h.storage;
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => void store.clear(),
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
    };
  })(),
);

const { TeamCacheSync } = await import('./cache-sync.svelte');

// --- 夹具 -------------------------------------------------------------------

function convFixture(id: string, lastSeq: number): Conversation {
  return {
    id,
    type: 'dm',
    title: null,
    directBotId: null,
    readOnly: false,
    workdirId: null,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq,
    lastReadSeq: 0,
    lastMessageAt: 1000,
    createdAt: 500,
  } as Conversation;
}

function msgFixture(conversationId: string, seq: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`,
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
  } as Message;
}

/** 假团队服务端：messages.list 按 afterSeq / changedSince / 整页三种分支回应。 */
function makeResponder(config: {
  bootstrap: Conversation[];
  latest: Record<string, Message[]>;
  afterSeq?: Record<string, Message[]>;
  changedSince?: { messages: Message[]; cursor?: number };
  changedSinceLog?: Array<number>;
  listLog?: Array<Record<string, unknown>>;
}): (method: string, input: Record<string, unknown>) => unknown {
  return (method, input) => {
    if (method === 'team.bootstrap') return { conversations: config.bootstrap, member: {}, server: {} };
    if (method === 'messages.list') {
      config.listLog?.push(input);
      if (input.afterSeq !== undefined) {
        const rows = config.afterSeq?.[String(input.conversationId)] ?? [];
        return { messages: rows.filter((m) => m.seq > (input.afterSeq as number)) };
      }
      if (input.changedSince !== undefined) {
        config.changedSinceLog?.push(input.changedSince as number);
        return config.changedSince ?? { messages: [] };
      }
      return { messages: config.latest[String(input.conversationId)] ?? [] };
    }
    return {};
  };
}

interface Harness {
  sync: InstanceType<typeof TeamCacheSync>;
  connect(): void;
  disconnect(expected: boolean): void;
}

const HASHES = ['t800000000000001', 't800000000000002', 't800000000000003', 't800000000000004', 't800000000000005', 't800000000000006', 't800000000000007', 't800000000000008'];
let hashIndex = 0;

function harness(responder: (method: string, input: Record<string, unknown>) => unknown, serverHash?: string): Harness {
  const hash = serverHash ?? HASHES[hashIndex]!;
  hashIndex += 1;
  h.currentHash = hash;
  h.sourceList = ['local', `team:${hash}`];
  h.conn = {
    status: 'offline',
    memberId: 'mbr_a',
    connectedHandlers: [],
    eventHandlers: new Map(),
    calls: [],
    responder,
    onConnected(handler: () => void): () => void {
      h.conn!.connectedHandlers.push(handler);
      return () => {
        h.conn!.connectedHandlers = h.conn!.connectedHandlers.filter((entry) => entry !== handler);
      };
    },
    onEvent(name: string, handler: (payload: unknown) => void): () => void {
      let set = h.conn!.eventHandlers.get(name);
      if (set === undefined) {
        set = new Set();
        h.conn!.eventHandlers.set(name, set);
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
      };
    },
    async call(method: string, input?: unknown): Promise<unknown> {
      h.conn!.calls.push({ method, input });
      return h.conn!.responder(method, (input ?? {}) as Record<string, unknown>);
    },
    async callTeam(method: string, input?: unknown): Promise<unknown> {
      return h.conn!.call(method, input);
    },
  };
  h.openFails = false;
  const sync = new TeamCacheSync();
  sync.start();
  return {
    sync,
    connect(): void {
      h.conn!.status = 'connected';
      for (const handler of [...h.conn!.connectedHandlers]) handler();
    },
    disconnect(expected: boolean): void {
      h.conn!.status = expected ? 'reconnecting' : 'offline';
    },
  };
}

function cursorKey(hash: string, memberId = 'mbr_a'): string {
  return `kepcup.teamCache.cursor.${hash}.${memberId}`;
}

async function cachedConversations(hash: string, memberId = 'mbr_a'): Promise<ConversationCache[]> {
  return [...partOf(hash, memberId).conversations.values()] as unknown as ConversationCache[];
}

async function cachedSeqs(hash: string, memberId: string, conversationId: string): Promise<number[]> {
  const rows = partOf(hash, memberId).messages.get(conversationId) ?? new Map<number, unknown>();
  return [...rows.keys()].sort((a, b) => a - b);
}

beforeEach(() => {
  h.verbs = [];
  h.parts.clear();
  h.storage.clear();
  h.sourcesChanged = [];
});

afterEach(() => {
  // 每个用例用独立实例（store 解析按当次 window 桩），无需全局 teardown。
});

describe('休眠与禁用退化', () => {
  it('platform.teamCache 不存在 → 引擎 no-op（不 open、不写、不崩）', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false } }); // 无 platform.teamCache
    const responder = makeResponder({ bootstrap: [convFixture('c1', 3)], latest: { c1: [msgFixture('c1', 1)] } });
    const session = harness(responder, HASHES[hashIndex]!);
    session.connect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.verbs).toEqual([]);
    session.sync.stop();
  });

  it('open 拒绝（safeStorage 不可用）→ 该服务器缓存禁用：后续事件直写跳过', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    const responder = makeResponder({ bootstrap: [convFixture('c1', 3)], latest: { c1: [msgFixture('c1', 1)] } });
    const session = harness(responder, hash);
    h.openFails = true;
    session.connect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.verbs.filter((v) => v.verb === 'open')).toHaveLength(1);
    expect(h.verbs.filter((v) => v.verb === 'putConversations')).toHaveLength(0);
    // 禁用后的事件直写也跳过（不反复炸 open）。
    h.conn!.eventHandlers.get('message.created')!; // 已接线
    const emit = (name: string, payload: unknown): void => {
      for (const handler of h.conn!.eventHandlers.get(name) ?? []) handler(payload);
    };
    emit('message.created', { conversationId: 'c1', message: msgFixture('c1', 4) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.verbs.filter((v) => v.verb === 'putMessages')).toHaveLength(0);
    session.sync.stop();
  });

  it('web 端点休眠：未配置团队服务器 → 引擎不启动、不建 IndexedDB 库、无 cursor 键', async () => {
    let idbOpens = 0;
    let idbDeletes = 0;
    vi.stubGlobal('window', {
      kepcup: { isWeb: true },
      // 引擎休眠时根本不该碰 IndexedDB：计数器替身（任何 open 都算失败）。
      indexedDB: {
        open: (name: string) => {
          idbOpens += 1;
          throw new Error(`unexpected indexedDB.open(${name})`);
        },
        deleteDatabase: () => {
          idbDeletes += 1;
          throw new Error('unexpected indexedDB.deleteDatabase');
        },
      },
    });
    const session = harness(makeResponder({ bootstrap: [], latest: {} }), 'web0000000000000');
    session.sync.stop();
    // harness 默认注入团队来源；休眠用例撤掉（未配置团队服务器）。
    h.sourceList = ['local'];
    session.sync.start(); // web 休眠：start 后零副作用。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(idbOpens).toBe(0);
    expect(idbDeletes).toBe(0);
    // 本机来源读缓存：直接 null（不走 IDB、不抛错）。
    expect(await session.sync.getConversationsFromCache('local')).toBeNull();
    expect([...h.storage.keys()]).toEqual([]);
    session.sync.stop();
  });
});

describe('首连 bootstrap 对账与补拉', () => {
  it('bootstrap 全量 putConversations(replace) + 每会话最近一页 + cursor 持久化', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    const c1 = convFixture('c1', 5);
    const c2 = convFixture('c2', 3);
    const listLog: Array<Record<string, unknown>> = [];
    const responder = makeResponder({
      bootstrap: [c1, c2],
      latest: {
        c1: [1, 2, 3, 4, 5].map((seq) => msgFixture('c1', seq)),
        c2: [1, 2, 3].map((seq) => msgFixture('c2', seq)),
      },
      listLog,
    });
    const session = harness(responder, hash);
    session.connect();
    await vi.waitFor(() => expect(listLog.length).toBe(2));
    // replace:true 对账（bootstrap 收敛的写入口）。
    const putConvCalls = h.verbs.filter((v) => v.verb === 'putConversations' && v.input.replace === true);
    expect(putConvCalls).toHaveLength(1);
    expect((await cachedConversations(hash)).map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    // 最近一页（非 afterSeq 非整页）拉取。
    expect(listLog.every((input) => input.afterSeq === undefined && input.changedSince === undefined && input.limit === 60)).toBe(true);
    expect(await cachedSeqs(hash, 'mbr_a', 'c1')).toEqual([1, 2, 3, 4, 5]);
    expect(await cachedSeqs(hash, 'mbr_a', 'c2')).toEqual([1, 2, 3]);
    // cursor 持久化（每会话 lastSeq + 全局 lastSyncAt）。
    const cursor = JSON.parse(h.storage.get(cursorKey(hash)) ?? '{}') as { lastSyncAt: number; lastSeqByConversation: Record<string, number> };
    expect(cursor.lastSyncAt).toBeGreaterThan(0);
    expect(cursor.lastSeqByConversation.c1).toBe(5);
    expect(cursor.lastSeqByConversation.c2).toBe(3);
    session.sync.stop();
  });

  it('断线补拉不重不漏：afterSeq 只补新消息（seq 断言），缓存无重复', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    const listLog: Array<Record<string, unknown>> = [];
    const config = {
      bootstrap: [convFixture('c1', 5)],
      latest: { c1: [1, 2, 3, 4, 5].map((seq) => msgFixture('c1', seq)) } as Record<string, Message[]>,
      afterSeq: { c1: [] as Message[] },
      listLog,
    };
    const responder = makeResponder(config);
    const session = harness(responder, hash);
    session.connect();
    await vi.waitFor(async () => expect(await cachedSeqs(hash, 'mbr_a', 'c1')).toEqual([1, 2, 3, 4, 5]));

    // 断线（重连预期）→ 服务端新增 6、7 → 重连（makeResponder 按 config 引用
    // 取数，原位改属性即可换回应）。
    session.disconnect(true);
    config.bootstrap = [convFixture('c1', 7)];
    config.afterSeq = { c1: [6, 7].map((seq) => msgFixture('c1', seq)) };
    session.connect();
    await vi.waitFor(async () => expect(await cachedSeqs(hash, 'mbr_a', 'c1')).toEqual([1, 2, 3, 4, 5, 6, 7]));
    // 补拉用了 afterSeq=5（cursor 基准）且只补了两条（putMessages 共 3 次：首连 1 + 补拉 1 + 事件 0）。
    const afterCalls = listLog.filter((input) => input.afterSeq !== undefined);
    expect(afterCalls).toEqual([{ conversationId: 'c1', afterSeq: 5, limit: 200 }]);
    const putCalls = h.verbs.filter((v) => v.verb === 'putMessages');
    expect(putCalls).toHaveLength(2);
    expect((putCalls[1]!.input.messages as Message[]).map((m) => m.seq)).toEqual([6, 7]);
    session.sync.stop();
  });

  it('seq 断档（服务端 seq 越过游标不连续）→ 该会话 putMessages replace 重拉', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    // 首连：lastSeq=5、缓存 [1..5]、游标 5。重连时服务端可视行变成 [8..10]
    // （6/7 已不可见）——afterSeq=5 补拉首行 seq=9 ≠ 6 → 断档 → 重置重拉。
    const first = makeResponder({
      bootstrap: [convFixture('c1', 5)],
      latest: { c1: [1, 2, 3, 4, 5].map((seq) => msgFixture('c1', seq)) },
    });
    const session = harness(first, hash);
    session.connect();
    await vi.waitFor(async () => expect(await cachedSeqs(hash, 'mbr_a', 'c1')).toEqual([1, 2, 3, 4, 5]));
    session.disconnect(true);
    h.conn!.responder = makeResponder({
      bootstrap: [convFixture('c1', 10)],
      latest: { c1: [8, 9, 10].map((seq) => msgFixture('c1', seq)) },
      afterSeq: { c1: [9, 10].map((seq) => msgFixture('c1', seq)) },
    });
    session.connect();
    await vi.waitFor(async () => expect(await cachedSeqs(hash, 'mbr_a', 'c1')).toEqual([8, 9, 10]));
    // 重拉走了 replace:true（整会话重置）。
    const replaceCalls = h.verbs.filter((v) => v.verb === 'putMessages' && v.input.replace === true);
    expect(replaceCalls).toHaveLength(1);
    expect((replaceCalls[0]!.input.messages as Message[]).map((m) => m.seq)).toEqual([8, 9, 10]);
    // cursor 重置为重拉后的最大 seq（与 lastSeq 取大）。
    const cursor = JSON.parse(h.storage.get(cursorKey(hash)) ?? '{}') as { lastSeqByConversation: Record<string, number> };
    expect(cursor.lastSeqByConversation.c1).toBe(10);
    session.sync.stop();
  });

  it('changedSince 收敛编辑 / 撤回（message.updated 直写等价物）+ 全局游标推进', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    const changedSinceLog: Array<number> = [];
    const responder = makeResponder({
      bootstrap: [convFixture('c1', 5)],
      latest: { c1: [1, 2, 3, 4, 5].map((seq) => msgFixture('c1', seq)) },
      changedSince: {
        messages: [msgFixture('c1', 3, { status: 'recalled' }), msgFixture('c1', 4, { status: 'edited', editedAt: 250 })],
        cursor: 1750,
      },
      changedSinceLog,
    });
    const session = harness(responder, hash);
    // 预置 cursor（模拟第二次连接）：lastSyncAt=1000、lastSeq=5。
    h.storage.set(cursorKey(hash), JSON.stringify({ version: 1, lastSyncAt: 1000, lastSeqByConversation: { c1: 5 } }));
    session.connect();
    await vi.waitFor(() => expect(changedSinceLog).toEqual([1000]));
    const rows = partOf(hash, 'mbr_a').messages.get('c1')!;
    expect((rows.get(3) as Message).status).toBe('recalled');
    expect((rows.get(4) as Message).status).toBe('edited');
    const cursor = JSON.parse(h.storage.get(cursorKey(hash)) ?? '{}') as { lastSyncAt: number };
    expect(cursor.lastSyncAt).toBe(1750);
    session.sync.stop();
  });

  it('changedSince 超过一页（250 行改写）→ 按 cursor 分页循环到短页（不漏改写行）', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    const changedSinceLog: Array<number> = [];
    // 250 行改写（createdAt 随 seq 递增 = 改写时间序；core 口径 cursor = 批内 max
    // coalesce(updatedAt, createdAt)，查询排他 >）。
    const changedRows = Array.from({ length: 250 }, (_, i) => msgFixture('c1', i + 1, { status: 'edited', editedAt: 1000 + i + 1 }));
    const responder = (method: string, input: Record<string, unknown>): unknown => {
      if (method === 'team.bootstrap') return { conversations: [convFixture('c1', 250)] };
      if (method === 'messages.list') {
        if (input.changedSince !== undefined) {
          const since = input.changedSince as number;
          changedSinceLog.push(since);
          const changedAt = (m: Message): number => m.updatedAt ?? m.createdAt;
          const rows = changedRows.filter((m) => changedAt(m) > since).slice(0, 200);
          if (rows.length === 0) return { messages: [] };
          return { messages: rows, cursor: Math.max(...rows.map(changedAt)) };
        }
        if (input.afterSeq !== undefined) return { messages: [] };
        return { messages: changedRows.slice(-60) };
      }
      return {};
    };
    const session = harness(responder, hash);
    // 预置 cursor（模拟第二次连接）：lastSyncAt=1000（全部 250 行都改写于其后）。
    h.storage.set(cursorKey(hash), JSON.stringify({ version: 1, lastSyncAt: 1000, lastSeqByConversation: { c1: 0 } }));
    session.connect();
    await vi.waitFor(() => expect(changedSinceLog.length).toBeGreaterThanOrEqual(2));
    // 全部 250 行落缓存（单页截断的旧实现只落前 200 行）。
    await vi.waitFor(async () => {
      const seqs = await cachedSeqs(hash, 'mbr_a', 'c1');
      expect(seqs.length).toBe(250);
      expect(seqs[0]).toBe(1);
      expect(seqs.at(-1)).toBe(250);
    });
    // 分页按 cursor 推进：1000 → 1200（首 200 行的 max changedAt）→ 1250 后短页收口。
    expect(changedSinceLog).toEqual([1000, 1200]);
    const cursor = JSON.parse(h.storage.get(cursorKey(hash)) ?? '{}') as { lastSyncAt: number };
    expect(cursor.lastSyncAt).toBe(1250);
    session.sync.stop();
  });

  it('会话删除 / 移出经 bootstrap replace 收敛（行与 cursor 一并清理）', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    const config = {
      bootstrap: [convFixture('c1', 3), convFixture('c2', 2)],
      latest: {
        c1: [1, 2, 3].map((seq) => msgFixture('c1', seq)),
        c2: [1, 2].map((seq) => msgFixture('c2', seq)),
      } as Record<string, Message[]>,
    };
    const responder = makeResponder(config);
    const session = harness(responder, hash);
    session.connect();
    await vi.waitFor(async () => expect((await cachedConversations(hash)).length).toBe(2));
    session.disconnect(true);
    config.bootstrap = [convFixture('c1', 3)];
    session.connect();
    await vi.waitFor(async () => expect((await cachedConversations(hash)).map((c) => c.id)).toEqual(['c1']));
    const cursor = JSON.parse(h.storage.get(cursorKey(hash)) ?? '{}') as { lastSeqByConversation: Record<string, number> };
    expect(cursor.lastSeqByConversation.c2).toBeUndefined();
    session.sync.stop();
  });

  it('在线事件直写：message.created / message.updated / conversation.updated / deleted', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    const responder = makeResponder({
      bootstrap: [convFixture('c1', 2), convFixture('c2', 1)],
      latest: { c1: [1, 2].map((seq) => msgFixture('c1', seq)), c2: [msgFixture('c2', 1)] },
    });
    const session = harness(responder, hash);
    session.connect();
    await vi.waitFor(async () => expect((await cachedConversations(hash)).length).toBe(2));
    const emit = (name: string, payload: unknown): void => {
      for (const handler of h.conn!.eventHandlers.get(name) ?? []) handler(payload);
    };
    emit('message.created', { conversationId: 'c1', message: msgFixture('c1', 3) });
    emit('message.updated', { conversationId: 'c1', message: msgFixture('c1', 2, { status: 'edited' }) });
    emit('conversation.updated', { conversation: convFixture('c1', 3) as unknown as Conversation });
    emit('conversation.deleted', { id: 'c2' });
    await vi.waitFor(async () => expect(await cachedSeqs(hash, 'mbr_a', 'c1')).toEqual([1, 2, 3]));
    expect((partOf(hash, 'mbr_a').messages.get('c1')!.get(2) as Message).status).toBe('edited');
    expect((await cachedConversations(hash)).map((c) => c.id)).toEqual(['c1']);
    // 游标随事件推进（重连 afterSeq 基准 = 3）。
    const cursor = JSON.parse(h.storage.get(cursorKey(hash)) ?? '{}') as { lastSeqByConversation: Record<string, number> };
    expect(cursor.lastSeqByConversation.c1).toBe(3);
    session.sync.stop();
  });

  it('同设备两成员分区互不可见（换账号后新分区独立、旧分区数据原样）', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    const responder = makeResponder({
      bootstrap: [convFixture('c1', 2)],
      latest: { c1: [1, 2].map((seq) => msgFixture('c1', seq)) },
    });
    const session = harness(responder, hash);
    session.connect();
    await vi.waitFor(async () => expect((await cachedConversations(hash, 'mbr_a')).length).toBe(1));
    session.disconnect(false);
    // 换账号（switchAccount 语义）：memberId 变了 → 新分区。
    h.conn!.memberId = 'mbr_b';
    session.connect();
    await vi.waitFor(async () => expect((await cachedConversations(hash, 'mbr_b')).length).toBe(1));
    // 两个分区的库各自独立（内存分区键不同），旧成员数据原样、互不污染。
    expect(h.parts.has(partKey(hash, 'mbr_a'))).toBe(true);
    expect(h.parts.has(partKey(hash, 'mbr_b'))).toBe(true);
    const aRows = partOf(hash, 'mbr_a').messages.get('c1')!;
    const bRows = partOf(hash, 'mbr_b').messages.get('c1')!;
    expect([...aRows.keys()]).toEqual([1, 2]);
    expect([...bRows.keys()]).toEqual([1, 2]);
    // cursor 也按成员分键。
    expect(h.storage.has(cursorKey(hash, 'mbr_a'))).toBe(true);
    expect(h.storage.has(cursorKey(hash, 'mbr_b'))).toBe(true);
    session.sync.stop();
  });
});

describe('读路径与离线只读', () => {
  it('附件 cache-aside：缓存命中不走网络；miss 且在线经 attachments.get 并回写', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    let attachmentCalls = 0;
    const responder = (method: string, input: Record<string, unknown>): unknown => {
      if (method === 'attachments.get') {
        attachmentCalls += 1;
        return { dataBase64: 'ZG93bmxvYWRlZA==', attachment: { id: input.id } };
      }
      return makeResponder({ bootstrap: [convFixture('c1', 1)], latest: { c1: [msgFixture('c1', 1)] } })(method, input);
    };
    const session = harness(responder, hash);
    session.connect();
    await vi.waitFor(async () => expect((await cachedConversations(hash)).length).toBe(1));
    const bytes = await session.sync.attachmentBytesBase64(`team:${hash}`, 'att1');
    expect(bytes).toBe('ZG93bmxvYWRlZA==');
    expect(attachmentCalls).toBe(1);
    expect(partOf(hash, 'mbr_a').attachments.get('att1')).toBe('ZG93bmxvYWRlZA==');
    // 第二次：命中缓存，无网络。
    const again = await session.sync.attachmentBytesBase64(`team:${hash}`, 'att1');
    expect(again).toBe('ZG93bmxvYWRlZA==');
    expect(attachmentCalls).toBe(1);
    session.sync.stop();
  });

  it('离线只读判定：团队来源断线 true、在线 false、本机恒 false', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    const session = harness(makeResponder({ bootstrap: [], latest: {} }), hash);
    expect(session.sync.isSourceOffline('local')).toBe(false);
    expect(session.sync.isSourceOffline(`team:${hash}`)).toBe(true);
    session.connect();
    expect(session.sync.isSourceOffline(`team:${hash}`)).toBe(false);
    session.disconnect(true);
    expect(session.sync.isSourceOffline(`team:${hash}`)).toBe(true);
    session.sync.stop();
  });

  it('清除当前分区：clearPartition + cursor 删除（设置卡按钮路径）', async () => {
    vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
    const hash = HASHES[hashIndex]!;
    const session = harness(
      makeResponder({ bootstrap: [convFixture('c1', 2)], latest: { c1: [1, 2].map((seq) => msgFixture('c1', seq)) } }),
      hash,
    );
    session.connect();
    await vi.waitFor(async () => expect((await cachedConversations(hash)).length).toBe(1));
    await session.sync.clearCurrentPartition(`team:${hash}`);
    expect(h.parts.has(partKey(hash, 'mbr_a'))).toBe(false);
    expect(h.storage.has(cursorKey(hash))).toBe(false);
    // 清除后重新连：分区重建（空）并重新对账。
    session.connect();
    await vi.waitFor(async () => expect((await cachedConversations(hash)).length).toBe(1));
    session.sync.stop();
  });
});
