import { describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import type { SourceId } from '$lib/rpc/connections.svelte';
import { createMemoryIdbKvFactory, type IdbKvFactory } from '$lib/persist/idb-kv';
import {
  MESSAGE_VISIBILITY_STORAGE_KEY,
  MessageVisibilityStore,
  type DisplayMessage,
  type LegacyVisibilityStorage,
  type MessageVisibilityPersist,
} from './message-visibility.svelte';

function memoryPersist(
  legacy: Record<string, string> | null = null,
): MessageVisibilityPersist & { kv: IdbKvFactory } {
  return {
    kv: createMemoryIdbKvFactory(),
    legacy:
      legacy === null
        ? null
        : {
            getItem: (key) => legacy[key] ?? null,
            removeItem: (key) => void delete legacy[key],
          },
  };
}

function legacyStorage(initial: Record<string, string>): LegacyVisibilityStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    removeItem: (key) => void delete data[key],
  };
}

/** 落盘是异步的（fire-and-forget）；多轮微任务把写链冲到底。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

async function kvEntries(kv: IdbKvFactory): Promise<Array<{ key: string; value: unknown }>> {
  const db = await kv.open('kepcup.message-visibility', 1);
  const hidden = await db.store('hidden').getEntries();
  const preview = await db.store('preview').getEntries();
  return [...hidden.map((e) => ({ ...e, store: 'hidden' as const })), ...preview.map((e) => ({ ...e, store: 'preview' as const }))];
}

function message(id = 'msg_1'): Message {
  return {
    id,
    conversationId: 'conv_1',
    seq: 1,
    senderType: 'bot',
    senderBotId: 'bot_1',
    kind: 'text',
    content: { text: 'PRIVATE_MESSAGE_TEXT' },
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 1,
    attachments: [],
    ownerBotId: null,
    taskId: null,
  };
}

const sourceScope = (source: SourceId): string => source;

describe('MessageVisibilityStore', () => {
  it('indexes hidden ids per conversation for cheap sidebar/search lookups', () => {
    const store = new MessageVisibilityStore(memoryPersist(), sourceScope);
    store.setHidden('local', 'conv_1', 'msg_a', true);
    store.setHidden('local', 'conv_1', 'msg_b', true);
    store.setHidden('local', 'conv_2', 'msg_c', true);
    expect(store.hasHiddenMessages('local', 'conv_1')).toBe(true);
    expect(store.hiddenMessageIds('local', 'conv_1').sort()).toEqual(['msg_a', 'msg_b']);
    expect(store.hasHiddenMessages('local', 'conv_3')).toBe(false);

    store.forget('local', 'conv_1', 'msg_a');
    expect(store.hiddenMessageIds('local', 'conv_1')).toEqual(['msg_b']);
    store.forget('local', 'conv_1', 'msg_b');
    expect(store.hasHiddenMessages('local', 'conv_1')).toBe(false);
    expect(store.hasHiddenMessages('local', 'conv_2')).toBe(true);
  });

  it('persists ids only, per conversation, and restores them into a new store', async () => {
    const persist = memoryPersist();
    const store = new MessageVisibilityStore(persist, sourceScope);
    store.setHidden('local', 'conv_1', 'msg_1', true);
    await settle();

    const entries = await kvEntries(persist.kv);
    expect(entries).toHaveLength(1);
    const raw = JSON.stringify(entries);
    expect(raw).toContain('msg_1');
    expect(raw).not.toContain('PRIVATE_MESSAGE_TEXT');

    const restored = new MessageVisibilityStore(persist, sourceScope);
    await restored.ready();
    expect(restored.isHidden('local', 'conv_1', 'msg_1')).toBe(true);
    expect(restored.isHidden('team:server-hash', 'conv_1', 'msg_1')).toBe(false);
    expect(restored.isHidden('local', 'conv_2', 'msg_1')).toBe(false);
  });

  it('applies the store-authoritative overlay without mutating raw messages', () => {
    const store = new MessageVisibilityStore(memoryPersist(), sourceScope);
    const raw = message();
    store.setHidden('local', 'conv_1', raw.id, true);

    expect(store.apply('local', 'conv_1', raw)).toEqual({ ...raw, hidden: true });
    expect('hidden' in raw).toBe(false);
    store.setHidden('local', 'conv_1', raw.id, false);
    expect(store.apply('local', 'conv_1', raw)).toEqual(raw);
    expect(store.apply('local', 'conv_1', raw)).not.toBe(raw);
    const stale = { ...raw, hidden: true } as DisplayMessage;
    expect(store.apply('local', 'conv_1', stale).hidden).toBeUndefined();
  });

  it('persists un-hides (both record branches) and they survive a restart as un-hidden', async () => {
    const persist = memoryPersist();
    const store = new MessageVisibilityStore(persist, sourceScope);
    const hiddenRecord = async (conversationId: string): Promise<unknown | undefined> => {
      const db = await persist.kv.open('kepcup.message-visibility', 1);
      const entries = await db.store('hidden').getEntries();
      return entries.find((entry) => entry.key === JSON.stringify(['local', conversationId]))?.value;
    };

    // 分支一：会话还有剩余隐藏 id → 记录 put 为更新后的列表。
    store.setHidden('local', 'conv_1', 'msg_a', true);
    store.setHidden('local', 'conv_1', 'msg_b', true);
    store.setHidden('local', 'conv_1', 'msg_a', false);
    await settle();
    expect(await hiddenRecord('conv_1')).toEqual(['msg_b']);

    // 分支二：删空 → 记录整体删除。
    store.setHidden('local', 'conv_1', 'msg_b', false);
    await settle();
    expect(await hiddenRecord('conv_1')).toBeUndefined();

    // 跨重启：取消隐藏不复活（旧版用例末尾的断言，迁移后等价承接）。
    store.setHidden('local', 'conv_1', 'msg_a', true);
    store.setHidden('local', 'conv_1', 'msg_a', false);
    await settle();
    const restored = new MessageVisibilityStore(persist, sourceScope);
    await restored.ready();
    expect(restored.isHidden('local', 'conv_1', 'msg_a')).toBe(false);
    expect(restored.hasHiddenMessages('local', 'conv_1')).toBe(false);
  });

  it('persists latest-preview overrides and forgets them with their conversation', async () => {
    const persist = memoryPersist();
    const store = new MessageVisibilityStore(persist, sourceScope);
    store.setHidden('local', 'conv_1', 'msg_1', true);
    store.setPreviewHidden('local', 'conv_1', true, 7, 'msg_1');
    await settle();

    const restored = new MessageVisibilityStore(persist, sourceScope);
    await restored.ready();
    expect(restored.previewHidden('local', 'conv_1')).toBe(true);
    expect(restored.previewHidden('local', 'conv_1', 8)).toBe(false);
    expect(restored.previewOverride('local', 'conv_1')).toEqual({ seq: 7, messageId: 'msg_1' });
    expect(restored.previewHidden('team:server-hash', 'conv_1')).toBe(false);
    restored.forget('local', 'conv_1', 'msg_1');
    expect(restored.isHidden('local', 'conv_1', 'msg_1')).toBe(false);
    expect(restored.previewHidden('local', 'conv_1')).toBe(true);
    restored.forget('local', 'conv_1');
    expect(restored.previewHidden('local', 'conv_1')).toBe(false);
    await settle();
    expect(await kvEntries(persist.kv)).toEqual([]);
  });

  it('keeps team accounts isolated and restores their state when switching back', async () => {
    const persist = memoryPersist();
    let memberId = 'mbr_a';
    const resolveScope = (source: 'local' | `team:${string}`) =>
      source === 'local' ? 'local' : `${source}:${memberId}`;
    const store = new MessageVisibilityStore(persist, resolveScope);
    store.setHidden('team:h1', 'conv_1', 'msg_1', true);
    store.setPreviewHidden('team:h1', 'conv_1', true, 7, 'msg_1');

    memberId = 'mbr_b';
    expect(store.isHidden('team:h1', 'conv_1', 'msg_1')).toBe(false);
    expect(store.previewHidden('team:h1', 'conv_1')).toBe(false);
    store.forget('team:h1', 'conv_1');

    memberId = 'mbr_a';
    expect(store.isHidden('team:h1', 'conv_1', 'msg_1')).toBe(true);
    expect(store.previewOverride('team:h1', 'conv_1')).toEqual({ seq: 7, messageId: 'msg_1' });
    const restored = new MessageVisibilityStore(persist, resolveScope);
    await restored.ready();
    expect(restored.isHidden('team:h1', 'conv_1', 'msg_1')).toBe(true);
  });

  it('masks messages, previews, replies, and persisted overrides while identity is pending', async () => {
    const persist = memoryPersist();
    let scope = 'local:team:identity-pending';
    const store = new MessageVisibilityStore(persist, () => scope);
    const raw = message();

    expect(store.isIdentityPending('local')).toBe(true);
    expect(store.apply('local', 'conv_1', raw).hidden).toBe(true);
    expect(store.isHidden('local', 'conv_1', raw.id)).toBe(true);
    expect(store.previewHidden('local', 'conv_1')).toBe(true);
    expect(store.hasHiddenMessages('local', 'conv_1')).toBe(true);
    store.setHidden('local', 'conv_1', raw.id, true);
    store.setPreviewHidden('local', 'conv_1', true, raw.seq, raw.id);
    await settle();
    expect(await kvEntries(persist.kv)).toEqual([]);

    scope = 'local:team:mbr_a';
    expect(store.apply('local', 'conv_1', raw).hidden).toBeUndefined();
    expect(store.previewHidden('local', 'conv_1')).toBe(false);
  });

  it('imports the legacy localStorage table once and deletes the key', async () => {
    const legacy = legacyStorage({
      [MESSAGE_VISIBILITY_STORAGE_KEY]: JSON.stringify({
        version: 2,
        hidden: [['local', 'conv_1', 'msg_1']],
        previewHidden: [['local', 'conv_1', 7, 'msg_1']],
      }),
    });
    const persist = memoryPersist();
    const store = new MessageVisibilityStore(
      { kv: persist.kv, legacy },
      sourceScope,
    );
    await store.ready();
    expect(store.isHidden('local', 'conv_1', 'msg_1')).toBe(true);
    expect(store.previewOverride('local', 'conv_1')).toEqual({ seq: 7, messageId: 'msg_1' });
    await settle();
    // 旧键已删 + 记录已落到 IndexedDB。
    expect(legacy.data[MESSAGE_VISIBILITY_STORAGE_KEY]).toBeUndefined();
    expect(await kvEntries(persist.kv)).toHaveLength(2);

    // 再次启动：IndexedDB 里还在，旧键不再出现（幂等）。
    const restored = new MessageVisibilityStore(persist, sourceScope);
    await restored.ready();
    expect(restored.isHidden('local', 'conv_1', 'msg_1')).toBe(true);
  });

  it('ignores malformed or old-version legacy tables and bad IDB records', async () => {
    const malformed = legacyStorage({
      [MESSAGE_VISIBILITY_STORAGE_KEY]: JSON.stringify({
        version: 2,
        hidden: [['local'], ['team:h1:mbr_a', 'conv_1', 'msg_1'], 'bad'],
        previewHidden: [
          ['local', 42],
          ['team:h1:mbr_a', 'conv_1', 7],
        ],
      }),
    });
    const persist = memoryPersist();
    const store = new MessageVisibilityStore({ kv: persist.kv, legacy: malformed }, sourceScope);
    await store.ready();
    expect(store.isHidden('local', 'conv_1', 'msg_1')).toBe(false);
    expect(store.isHidden('team:h1:mbr_a', 'conv_1', 'msg_1')).toBe(true);
    expect(store.previewHidden('team:h1:mbr_a', 'conv_1')).toBe(false);

    const old = legacyStorage({
      [MESSAGE_VISIBILITY_STORAGE_KEY]: JSON.stringify({
        version: 1,
        hidden: [['local', 'conv_1', 'msg_1']],
        previewHidden: [],
      }),
    });
    const oldStore = new MessageVisibilityStore({ kv: persist.kv, legacy: old }, sourceScope);
    await oldStore.ready();
    expect(oldStore.isHidden('local', 'conv_1', 'msg_1')).toBe(false);

    // IndexedDB 记录值形状不对：整条丢弃，当没存过。
    const badKv = createMemoryIdbKvFactory();
    const db = await badKv.open('kepcup.message-visibility', 1);
    await db.store('hidden').put(JSON.stringify(['local', 'conv_1']), ['msg_1', 42]);
    await db.store('hidden').put(JSON.stringify(['local', 'conv_2']), 'not-an-array');
    await db.store('preview').put(JSON.stringify(['local', 'conv_3']), { seq: -1, messageId: '' });
    const badStore = new MessageVisibilityStore({ kv: badKv, legacy: null }, sourceScope);
    await badStore.ready();
    expect(badStore.hasHiddenMessages('local', 'conv_1')).toBe(false);
    expect(badStore.hasHiddenMessages('local', 'conv_2')).toBe(false);
    expect(badStore.previewHidden('local', 'conv_3')).toBe(false);
  });

  it('merges with IndexedDB as authority: legacy fills gaps, previews keep IDB value', async () => {
    const persist = memoryPersist();
    // 预置 IDB（较新状态）：conv_1 已有 hidden 记录与 preview 覆盖。
    const db = await persist.kv.open('kepcup.message-visibility', 1);
    await db.store('hidden').put(JSON.stringify(['local', 'conv_1']), ['msg_new']);
    await db.store('preview').put(JSON.stringify(['local', 'conv_1']), {
      seq: 9,
      messageId: 'msg_new',
    });
    // 旧键带着同一会话的旧 preview 与另一会话的旧 hidden。
    const legacy = legacyStorage({
      [MESSAGE_VISIBILITY_STORAGE_KEY]: JSON.stringify({
        version: 2,
        hidden: [
          ['local', 'conv_1', 'msg_old'],
          ['local', 'conv_2', 'msg_old2'],
        ],
        previewHidden: [['local', 'conv_1', 3, 'msg_old']],
      }),
    });
    const store = new MessageVisibilityStore({ kv: persist.kv, legacy }, sourceScope);
    await store.ready();
    // hidden 并集；preview 以 IDB 为准（旧键不覆盖）；旧键补上另一会话的缺口。
    expect(store.hiddenMessageIds('local', 'conv_1').sort()).toEqual(['msg_new', 'msg_old']);
    expect(store.previewOverride('local', 'conv_1')).toEqual({ seq: 9, messageId: 'msg_new' });
    expect(store.isHidden('local', 'conv_2', 'msg_old2')).toBe(true);
    await settle();
    expect(legacy.data[MESSAGE_VISIBILITY_STORAGE_KEY]).toBeUndefined();
  });

  it('keeps working in memory when IndexedDB writes reject', async () => {
    const failing: IdbKvFactory = {
      open: () => Promise.reject(new Error('denied')),
    };
    const store = new MessageVisibilityStore({ kv: failing, legacy: null }, sourceScope);
    await store.ready();
    store.setHidden('local', 'conv_1', 'msg_1', true);
    store.setPreviewHidden('local', 'conv_1', true, 7, 'msg_1');
    expect(store.isHidden('local', 'conv_1', 'msg_1')).toBe(true);
    expect(store.previewHidden('local', 'conv_1')).toBe(true);
  });

  it('keeps the legacy table when IndexedDB cannot open (sole durable copy)', async () => {
    const legacy = legacyStorage({
      [MESSAGE_VISIBILITY_STORAGE_KEY]: JSON.stringify({
        version: 2,
        hidden: [['local', 'conv_1', 'msg_1']],
        previewHidden: [],
      }),
    });
    const store = new MessageVisibilityStore(
      { kv: { open: () => Promise.reject(new Error('denied')) }, legacy },
      sourceScope,
    );
    await store.ready();
    // 内存态照常工作；旧键不删（无处落库时它是唯一持久副本，下次启动重试迁移）。
    expect(store.isHidden('local', 'conv_1', 'msg_1')).toBe(true);
    expect(legacy.data[MESSAGE_VISIBILITY_STORAGE_KEY]).toBeDefined();
  });
});
