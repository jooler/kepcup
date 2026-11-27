import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '@kepcup/shared';

/**
 * T8 读路径（chat-session.svelte.ts 的缓存接线）：团队来源的会话打开 / 上滑分页
 * 的缓存行为——离线打开由缓存快照渲染（跳过服务端取数与 markRead 等写）、
 * loadEarlier 缓存优先、离线无更早（hasEarlier=false、不发服务端）、在线缓存
 * miss 向服务端补拉并回写缓存（rememberMessages）。新文件不改动既有
 * chat-session 测试（T8 审查新增——缓存读路径此前无直接用例）。
 */

const h = vi.hoisted(() => {
  const state = {
    connStatus: 'offline' as 'offline' | 'reconnecting' | 'connecting' | 'connected',
    memberId: 'mbr_a' as string | null,
    /** 团队连接的 RPC 调用台账（离线断言：不应有服务端取数）。 */
    calls: [] as Array<{ method: string; input: unknown }>,
    /** messages.list / conversations.get 的应答（在线 loadEarlier 用）。 */
    serverMessages: [] as Message[],
    /** platform 调用台账（putMessages 回写断言）。 */
    verbs: [] as Array<{ verb: string; input: Record<string, unknown> }>,
    /** 内存分区：<serverHash>::<memberId> → 数据。 */
    parts: new Map<
      string,
      { conversations: Map<string, unknown>; messages: Map<string, Map<number, unknown>> }
    >(),
    storage: new Map<string, string>(),
  };
  return state;
});

function partOf(
  serverHash: string,
  memberId: string,
): { conversations: Map<string, unknown>; messages: Map<string, Map<number, unknown>> } {
  const key = `${serverHash}::${memberId}`;
  let part = h.parts.get(key);
  if (part === undefined) {
    part = { conversations: new Map(), messages: new Map() };
    h.parts.set(key, part);
  }
  return part;
}

/** 内存 platform.teamCache 替身（与 preload 形状一致；仅引擎读路径用到的方法有行为）。 */
function fakePlatformApi(): Record<string, (input?: unknown) => Promise<unknown>> {
  const part = (input: { serverHash: string; memberId: string }): ReturnType<typeof partOf> =>
    partOf(input.serverHash, input.memberId);
  return {
    open: async () => ({ ok: true }),
    close: async () => ({ ok: true }),
    putConversations: async (raw) => {
      const input = raw as {
        serverHash: string;
        memberId: string;
        conversations: Conversation[];
        replace?: boolean;
      };
      h.verbs.push({ verb: 'putConversations', input });
      const bucket = part(input);
      if (input.replace === true) {
        const keep = new Set(input.conversations.map((c) => c.id));
        for (const id of [...bucket.conversations.keys()]) {
          if (!keep.has(id)) bucket.conversations.delete(id);
        }
      }
      for (const conversation of input.conversations)
        bucket.conversations.set(conversation.id, conversation);
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
      h.verbs.push({ verb: 'putMessages', input });
      const bucket = part(input);
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
      return { conversations: [...part(input).conversations.values()] };
    },
    getMessages: async (raw) => {
      const input = raw as {
        serverHash: string;
        memberId: string;
        conversationId: string;
        limit?: number;
        beforeSeq?: number;
      };
      const rows = part(input).messages.get(input.conversationId) ?? new Map<number, unknown>();
      let all = [...rows.keys()].sort((a, b) => b - a);
      if (input.beforeSeq !== undefined)
        all = all.filter((seq) => seq < (input.beforeSeq as number));
      const seqs = all.slice(0, input.limit ?? 60);
      return { messages: seqs.map((seq) => rows.get(seq)).reverse() };
    },
    putAttachment: async () => ({ ok: true }),
    getAttachment: async () => ({ missing: true }),
    clearPartition: async (raw) => {
      const input = raw as { serverHash: string; memberId: string };
      h.parts.delete(`${input.serverHash}::${input.memberId}`);
      return { ok: true };
    },
    clearServer: async (raw) => {
      const input = raw as { serverHash: string };
      for (const key of [...h.parts.keys()]) {
        if (key.startsWith(`${input.serverHash}::`)) h.parts.delete(key);
      }
      return { ok: true };
    },
    usage: async () => ({ cacheBytes: 0, attachmentLimitBytes: 1024 * 1024 * 1024 }),
    setAttachmentLimit: async () => ({ ok: true }),
  };
}

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    connection: 'connected',
    onEvent: () => () => undefined,
    onConnected: () => () => undefined,
    call: async () => ({}),
    callTeam: async () => {
      throw new Error('no team context');
    },
  },
}));

vi.mock('$lib/rpc/connections.svelte', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- 测试 mock 的模块类型标注。
  const actual = (await importOriginal()) as typeof import('$lib/rpc/connections.svelte');
  return {
    ...actual,
    connections: {
      sources: () => ['local', 'team:h1'],
      onSourcesChanged: () => () => undefined,
      get: (source: string) => {
        if (source === 'local') {
          return {
            status: 'connected',
            memberId: null,
            call: async () => ({}),
            onEvent: () => () => undefined,
            onConnected: () => () => undefined,
            onIdentityChanged: () => () => undefined,
          };
        }
        return {
          status: h.connStatus,
          memberId: h.memberId,
          call: async (method: string, input?: unknown) => {
            h.calls.push({ method, input });
            if (method === 'conversations.get') return { conversation: null };
            if (method === 'messages.list') return { messages: h.serverMessages };
            return {};
          },
          onEvent: () => () => undefined,
          onConnected: () => () => undefined,
          onIdentityChanged: () => () => undefined,
          callTeam: async () => {
            throw new Error('offline');
          },
        };
      },
    },
  };
});

vi.stubGlobal('window', { kepcup: { isWeb: false, platform: { teamCache: fakePlatformApi() } } });
vi.stubGlobal('localStorage', {
  getItem: (key: string) => h.storage.get(key) ?? null,
  setItem: (key: string, value: string) => void h.storage.set(key, value),
  removeItem: (key: string) => void h.storage.delete(key),
  clear: () => void h.storage.clear(),
  get length() {
    return h.storage.size;
  },
  key: (index: number) => [...h.storage.keys()][index] ?? null,
});

const { ChatSession } = await import('./chat-session.svelte');
const { messageVisibility } = await import('./message-visibility.svelte');
const { teamCacheSync } = await import('../features/team/cache-sync.svelte');

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

function msgFixture(
  conversationId: string,
  seq: number,
  overrides: Partial<Message> = {},
): Message {
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
  } as Message;
}

/** 直接经 platform 替身播种分区缓存（不走同步引擎——单测聚焦读路径）。 */
async function seedCache(messages: Message[]): Promise<void> {
  const api = fakePlatformApi();
  await api.putConversations!({
    serverHash: 'h1',
    memberId: 'mbr_a',
    conversations: [convFixture('c1', messages.at(-1)?.seq ?? 0)],
  });
  await api.putMessages!({ serverHash: 'h1', memberId: 'mbr_a', conversationId: 'c1', messages });
}

beforeEach(() => {
  h.connStatus = 'offline';
  h.memberId = 'mbr_a';
  h.calls = [];
  h.serverMessages = [];
  h.verbs = [];
  h.parts.clear();
  h.storage.clear();
  messageVisibility.forget('team:h1', 'c1');
});

describe('ChatSession 的团队缓存读路径（T8）', () => {
  it('applies per-team hidden overlays to offline cached opens and earlier pages', async () => {
    const messages = Array.from({ length: 80 }, (_, index) =>
      msgFixture('c1', index + 1, { senderType: 'bot', senderBotId: 'bot_1' }),
    );
    await seedCache(messages);
    messageVisibility.forget('team:h1', 'c1');
    messageVisibility.setHidden('team:h1', 'c1', 'msg-c1-1', true);
    messageVisibility.setHidden('team:h1', 'c1', 'msg-c1-80', true);
    const session = new ChatSession();
    await session.open({ source: 'team:h1', id: 'c1' });
    expect(session.messages.at(-1)?.hidden).toBe(true);
    expect(messageVisibility.isHidden('local', 'c1', 'msg-c1-80')).toBe(false);
    await session.loadEarlier();
    expect(session.messages[0]?.hidden).toBe(true);
    expect(h.calls).toEqual([]);
    session.dispose();
    messageVisibility.forget('team:h1', 'c1');
  });

  it('keeps an old cached preview mask when the hidden row is outside a partial page', async () => {
    const messages = Array.from({ length: 60 }, (_, index) =>
      msgFixture('c1', index + 2, {
        senderType: 'system',
        senderBotId: null,
        kind: 'system_event',
        content: { event: 'run_done', text: 'done' },
      }),
    );
    await seedCache(messages);
    messageVisibility.forget('team:h1', 'c1');
    messageVisibility.setHidden('team:h1', 'c1', 'cached-hidden-preview', true);
    messageVisibility.setPreviewHidden('team:h1', 'c1', true, 1, 'cached-hidden-preview');
    const session = new ChatSession();
    await session.open({ source: 'team:h1', id: 'c1' });
    expect(session.hasEarlier).toBe(true);
    expect(session.conversation?.lastPreviewSeq).toBeUndefined();
    expect(messageVisibility.previewHidden('team:h1', 'c1')).toBe(true);
    expect(h.calls).toEqual([]);
    session.dispose();
    messageVisibility.forget('team:h1', 'c1');
  });

  it('离线打开：缓存快照渲染（消息/hasEarlier），零服务端取数', async () => {
    await seedCache([41, 42, 43].map((seq) => msgFixture('c1', seq)));
    const session = new ChatSession();
    const opened = await session.open({ source: 'team:h1', id: 'c1' });
    expect(opened).toBe(true);
    expect(session.conversationId).toBe('c1');
    expect(session.messages.map((m) => m.seq)).toEqual([41, 42, 43]);
    // 不足一页 → hasEarlier false（缓存口径）。
    expect(session.hasEarlier).toBe(false);
    // 离线分支跳过全部服务端取数（conversations.get / messages.list / runs.list…）。
    expect(h.calls).toEqual([]);
    session.dispose();
  });

  it('离线 loadEarlier：缓存有更早 → 前插；缓存无更早 → hasEarlier=false 且不发服务端', async () => {
    await seedCache(
      [...Array.from({ length: 80 }, (_, i) => msgFixture('c1', i + 1))].map((m) => m),
    );
    // 缓存里 80 条：打开取最近 60 条（seq 21..80），更早 20 条在缓存。
    const session = new ChatSession();
    await session.open({ source: 'team:h1', id: 'c1' });
    expect(session.messages.map((m) => m.seq)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 21),
    );
    expect(session.hasEarlier).toBe(true);
    expect(h.calls).toEqual([]);

    await session.loadEarlier();
    // 缓存命中：前插 1..20，无服务端调用。
    expect(session.messages.map((m) => m.seq)).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
    expect(session.hasEarlier).toBe(false);
    expect(h.calls).toEqual([]);

    // 再翻（缓存已空）：离线 → hasEarlier 维持 false，仍无服务端调用。
    await session.loadEarlier();
    expect(session.hasEarlier).toBe(false);
    expect(h.calls).toEqual([]);
    session.dispose();
  });

  it('在线 loadEarlier：缓存 miss → 服务端补拉前插并回写缓存（rememberMessages）', async () => {
    await seedCache(Array.from({ length: 60 }, (_, i) => msgFixture('c1', i + 41)));
    const session = new ChatSession();
    await session.open({ source: 'team:h1', id: 'c1' });
    expect(session.messages.map((m) => m.seq)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 41),
    );
    // 整页（60 条）→ 打开即标记可能有更早（离线口径，与在线服务端页一致）。
    expect(session.hasEarlier).toBe(true);

    // 恢复在线 + 服务端有更早的 20 条（21..40）。
    h.connStatus = 'connected';
    h.serverMessages = Array.from({ length: 20 }, (_, i) => msgFixture('c1', i + 21));
    const rememberSpy = vi.spyOn(teamCacheSync, 'rememberMessages');
    await session.loadEarlier();
    expect(session.messages.map((m) => m.seq)).toEqual(
      Array.from({ length: 80 }, (_, i) => i + 21),
    );
    // 服务端补拉只打了一次 messages.list。
    expect(h.calls.map((c) => c.method)).toEqual(['messages.list']);
    expect(h.calls[0]!.input).toEqual({ conversationId: 'c1', beforeSeq: 41, limit: 60 });
    // 回写缓存：putMessages 带补拉的 20 行（rememberMessages 异步落库；verbs[0]
    // 是 seedCache 的播种写——waitFor 内重取台账，不能用旧快照）。
    expect(rememberSpy.mock.calls.length).toBe(1);
    await vi.waitFor(() => {
      const puts = h.verbs.filter((v) => v.verb === 'putMessages');
      expect(puts.length).toBe(2);
      expect((puts[1]!.input.messages as Message[]).map((m) => m.seq)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 21),
      );
    });
    session.dispose();
  });
});
