import { describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import type { SourceId } from '$lib/rpc/connections.svelte';
import {
  MESSAGE_VISIBILITY_STORAGE_KEY,
  MessageVisibilityStore,
  type DisplayMessage,
  type MessageVisibilityStorage,
} from './message-visibility.svelte';

function memoryStorage(initial: Record<string, string> = {}): MessageVisibilityStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
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
    const store = new MessageVisibilityStore(memoryStorage(), sourceScope);
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

  it('persists ids only and scopes them by source and conversation', () => {
    const storage = memoryStorage();
    const store = new MessageVisibilityStore(storage, sourceScope);
    store.setHidden('local', 'conv_1', 'msg_1', true);

    const raw = storage.data.get(MESSAGE_VISIBILITY_STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(raw).not.toContain('PRIVATE_MESSAGE_TEXT');
    const restored = new MessageVisibilityStore(storage, sourceScope);
    expect(restored.isHidden('local', 'conv_1', 'msg_1')).toBe(true);
    expect(restored.isHidden('team:server-hash', 'conv_1', 'msg_1')).toBe(false);
    expect(restored.isHidden('local', 'conv_2', 'msg_1')).toBe(false);
  });

  it('applies the store-authoritative overlay without mutating raw messages', () => {
    const storage = memoryStorage();
    const store = new MessageVisibilityStore(storage, sourceScope);
    const raw = message();
    store.setHidden('local', 'conv_1', raw.id, true);

    expect(store.apply('local', 'conv_1', raw)).toEqual({ ...raw, hidden: true });
    expect('hidden' in raw).toBe(false);
    store.setHidden('local', 'conv_1', raw.id, false);
    expect(store.apply('local', 'conv_1', raw)).toEqual(raw);
    expect(store.apply('local', 'conv_1', raw)).not.toBe(raw);
    const stale = { ...raw, hidden: true } as DisplayMessage;
    expect(store.apply('local', 'conv_1', stale).hidden).toBeUndefined();
    expect(
      new MessageVisibilityStore(storage, sourceScope).isHidden('local', 'conv_1', raw.id),
    ).toBe(false);
  });

  it('persists latest-preview overrides and forgets them with their conversation', () => {
    const storage = memoryStorage();
    const store = new MessageVisibilityStore(storage, sourceScope);
    store.setHidden('local', 'conv_1', 'msg_1', true);
    store.setPreviewHidden('local', 'conv_1', true, 7, 'msg_1');

    const restored = new MessageVisibilityStore(storage, sourceScope);
    expect(restored.previewHidden('local', 'conv_1')).toBe(true);
    expect(restored.previewHidden('local', 'conv_1', 8)).toBe(false);
    expect(restored.previewOverride('local', 'conv_1')).toEqual({ seq: 7, messageId: 'msg_1' });
    expect(restored.previewHidden('team:server-hash', 'conv_1')).toBe(false);
    restored.forget('local', 'conv_1', 'msg_1');
    expect(restored.isHidden('local', 'conv_1', 'msg_1')).toBe(false);
    expect(restored.previewHidden('local', 'conv_1')).toBe(true);
    restored.forget('local', 'conv_1');
    expect(restored.previewHidden('local', 'conv_1')).toBe(false);
    expect(new MessageVisibilityStore(storage, sourceScope).previewHidden('local', 'conv_1')).toBe(
      false,
    );
  });

  it('keeps team accounts isolated and restores their state when switching back', () => {
    const storage = memoryStorage();
    let memberId = 'mbr_a';
    const resolveScope = (source: 'local' | `team:${string}`) =>
      source === 'local' ? 'local' : `${source}:${memberId}`;
    const store = new MessageVisibilityStore(storage, resolveScope);
    store.setHidden('team:h1', 'conv_1', 'msg_1', true);
    store.setPreviewHidden('team:h1', 'conv_1', true, 7, 'msg_1');

    memberId = 'mbr_b';
    expect(store.isHidden('team:h1', 'conv_1', 'msg_1')).toBe(false);
    expect(store.previewHidden('team:h1', 'conv_1')).toBe(false);
    store.forget('team:h1', 'conv_1');

    memberId = 'mbr_a';
    expect(store.isHidden('team:h1', 'conv_1', 'msg_1')).toBe(true);
    expect(store.previewOverride('team:h1', 'conv_1')).toEqual({ seq: 7, messageId: 'msg_1' });
    const restored = new MessageVisibilityStore(storage, resolveScope);
    expect(restored.isHidden('team:h1', 'conv_1', 'msg_1')).toBe(true);
  });

  it('masks messages, previews, replies, and persisted overrides while identity is pending', () => {
    const storage = memoryStorage();
    let scope = 'local:team:identity-pending';
    const store = new MessageVisibilityStore(storage, () => scope);
    const raw = message();

    expect(store.isIdentityPending('local')).toBe(true);
    expect(store.apply('local', 'conv_1', raw).hidden).toBe(true);
    expect(store.isHidden('local', 'conv_1', raw.id)).toBe(true);
    expect(store.previewHidden('local', 'conv_1')).toBe(true);
    expect(store.hasHiddenMessages('local', 'conv_1')).toBe(true);
    store.setHidden('local', 'conv_1', raw.id, true);
    store.setPreviewHidden('local', 'conv_1', true, raw.seq, raw.id);
    expect(storage.data.size).toBe(0);

    scope = 'local:team:mbr_a';
    expect(store.apply('local', 'conv_1', raw).hidden).toBeUndefined();
    expect(store.previewHidden('local', 'conv_1')).toBe(false);
  });

  it('ignores malformed or old-version storage and keeps working when storage throws', () => {
    const malformed = memoryStorage({
      [MESSAGE_VISIBILITY_STORAGE_KEY]: JSON.stringify({
        version: 2,
        hidden: [['local'], ['team:h1:mbr_a', 'conv_1', 'msg_1'], 'bad'],
        previewHidden: [
          ['local', 42],
          ['team:h1:mbr_a', 'conv_1', 7],
        ],
      }),
    });
    const store = new MessageVisibilityStore(malformed, sourceScope);
    expect(store.isHidden('local', 'conv_1', 'msg_1')).toBe(false);
    expect(store.isHidden('team:h1:mbr_a', 'conv_1', 'msg_1')).toBe(true);

    const old = memoryStorage({
      [MESSAGE_VISIBILITY_STORAGE_KEY]: JSON.stringify({
        version: 1,
        hidden: [['local', 'conv_1', 'msg_1']],
        previewHidden: [],
      }),
    });
    expect(new MessageVisibilityStore(old, sourceScope).isHidden('local', 'conv_1', 'msg_1')).toBe(
      false,
    );

    const unavailable: MessageVisibilityStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const volatile = new MessageVisibilityStore(unavailable, sourceScope);
    volatile.setHidden('local', 'conv_1', 'msg_1', true);
    volatile.setPreviewHidden('local', 'conv_1', true, 7, 'msg_1');
    expect(volatile.isHidden('local', 'conv_1', 'msg_1')).toBe(true);
    expect(volatile.previewHidden('local', 'conv_1')).toBe(true);
  });
});
