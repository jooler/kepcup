import { describe, expect, test } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import {
  buildPersistedSnapshot,
  COMPOSER_DRAFTS_STORAGE_KEY,
  isComposerDocEmpty,
  loadPersistedDrafts,
  MAX_PERSISTED_DRAFTS,
  writePersistedDrafts,
  type PersistedComposerDraft,
} from './composer-draft-persist';

/** 极简 localStorage 替身（node 环境无 DOM）。 */
function fakeStorage(initial: Record<string, string> = {}): {
  store: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

function docOf(text: string): JSONContent {
  if (text.length === 0) return { type: 'doc', content: [{ type: 'paragraph' }] };
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function draft(overrides: Partial<PersistedComposerDraft> = {}): PersistedComposerDraft {
  return {
    doc: docOf(''),
    mentions: [],
    reply: null,
    attachments: [],
    updatedAt: 0,
    ...overrides,
  };
}

describe('isComposerDocEmpty', () => {
  test('空段落/空列表为空；文本与 mention 节点不为空', () => {
    expect(isComposerDocEmpty(docOf(''))).toBe(true);
    expect(isComposerDocEmpty(docOf('草稿'))).toBe(false);
    expect(
      isComposerDocEmpty({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
          },
        ],
      }),
    ).toBe(true);
    expect(
      isComposerDocEmpty({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'mention', attrs: { id: 'bot_1', label: '阿甲' } }],
          },
        ],
      }),
    ).toBe(false);
  });
});

describe('loadPersistedDrafts', () => {
  test('空存储 / 缺 key 返回空对象', () => {
    expect(loadPersistedDrafts(null)).toEqual({});
    expect(loadPersistedDrafts(fakeStorage())).toEqual({});
  });

  test('坏 JSON / 非对象返回空对象', () => {
    expect(loadPersistedDrafts(fakeStorage({ [COMPOSER_DRAFTS_STORAGE_KEY]: '{oops' }))).toEqual(
      {},
    );
    expect(loadPersistedDrafts(fakeStorage({ [COMPOSER_DRAFTS_STORAGE_KEY]: '42' }))).toEqual({});
    expect(loadPersistedDrafts(fakeStorage({ [COMPOSER_DRAFTS_STORAGE_KEY]: 'null' }))).toEqual({});
  });

  test('doc 形状不对的条目丢弃；其余字段容错，整体为空不保留', () => {
    const storage = fakeStorage({
      [COMPOSER_DRAFTS_STORAGE_KEY]: JSON.stringify({
        conv_a: {
          doc: docOf('草稿'),
          mentions: ['bot_1', 42, null],
          reply: { id: 'm1', senderType: 'user', senderBotId: null, text: '引用' },
          attachments: [
            { attachmentId: 'att_1', fileName: 'a.png', mime: 'image/png', size: 3 },
            { attachmentId: '', fileName: 'bad' },
            'junk',
          ],
          updatedAt: 7,
        },
        conv_b: { doc: { type: 'paragraph' }, mentions: [], reply: null, attachments: [] },
        conv_c: { text: 'v1 旧格式草稿', mentions: [], reply: null, attachments: [] },
      }),
    });
    const loaded = loadPersistedDrafts(storage);
    expect(Object.keys(loaded).sort()).toEqual(['conv_a']);
    expect(loaded.conv_a).toEqual({
      doc: docOf('草稿'),
      mentions: ['bot_1'],
      reply: { id: 'm1', senderType: 'user', senderBotId: null, text: '引用' },
      attachments: [{ attachmentId: 'att_1', fileName: 'a.png', mime: 'image/png', size: 3 }],
      updatedAt: 7,
    });
  });
});

describe('buildPersistedSnapshot', () => {
  test('runtime 只保留 ready 附件；uploading/error 不落盘', () => {
    const snapshot = buildPersistedSnapshot({
      runtime: {
        conv_a: {
          doc: docOf('看图'),
          mentions: [],
          reply: null,
          uploads: [
            {
              state: 'ready',
              attachmentId: 'att_1',
              fileName: 'a.png',
              mime: 'image/png',
              size: 3,
            },
            {
              state: 'uploading',
              attachmentId: null,
              fileName: 'b.png',
              mime: 'image/png',
              size: 4,
            },
            { state: 'error', attachmentId: null, fileName: 'c.png', mime: 'image/png', size: 5 },
          ],
        },
      },
      previous: {},
      now: 100,
    });
    expect(snapshot.conv_a).toEqual({
      doc: docOf('看图'),
      mentions: [],
      reply: null,
      attachments: [{ attachmentId: 'att_1', fileName: 'a.png', mime: 'image/png', size: 3 }],
      updatedAt: 100,
    });
  });

  test('整体为空的会话不落盘；previous 里未打开的会话原样保留', () => {
    const previous: Record<string, PersistedComposerDraft> = {
      conv_old: draft({ doc: docOf('旧会话草稿'), updatedAt: 1 }),
      conv_empty: draft({ updatedAt: 2 }),
    };
    const snapshot = buildPersistedSnapshot({
      runtime: { conv_new: { doc: docOf(''), mentions: [], reply: null, uploads: [] } },
      previous,
      now: 100,
    });
    expect(Object.keys(snapshot).sort()).toEqual(['conv_old']);
  });

  test('runtime 覆盖 previous 的同会话条目（发送后清空即遗忘）', () => {
    const previous: Record<string, PersistedComposerDraft> = {
      conv_a: draft({
        doc: docOf('旧'),
        attachments: [{ attachmentId: 'att_1', fileName: 'a', mime: 'image/png', size: 1 }],
        updatedAt: 1,
      }),
    };
    const snapshot = buildPersistedSnapshot({
      runtime: { conv_a: { doc: docOf(''), mentions: [], reply: null, uploads: [] } },
      previous,
      now: 100,
    });
    expect(snapshot.conv_a).toBeUndefined();
  });

  test('超过容量上限按上限截断', () => {
    const runtime: Parameters<typeof buildPersistedSnapshot>[0]['runtime'] = {};
    for (let i = 0; i < MAX_PERSISTED_DRAFTS + 5; i += 1) {
      runtime[`conv_${i}`] = { doc: docOf(`t${i}`), mentions: [], reply: null, uploads: [] };
    }
    // runtime 条目 updatedAt 相同时稳定排序保序：保留前 MAX_PERSISTED_DRAFTS 个。
    const snapshot = buildPersistedSnapshot({ runtime, previous: {}, now: 100 });
    expect(Object.keys(snapshot).length).toBe(MAX_PERSISTED_DRAFTS);
  });
});

describe('writePersistedDrafts / 往返', () => {
  test('写后读一致；空对象清 key', () => {
    const storage = fakeStorage();
    const drafts: Record<string, PersistedComposerDraft> = {
      conv_a: draft({ doc: docOf('草稿'), updatedAt: 5 }),
    };
    writePersistedDrafts(storage, drafts);
    expect(loadPersistedDrafts(storage)).toEqual(drafts);
    writePersistedDrafts(storage, {});
    expect(storage.store.has(COMPOSER_DRAFTS_STORAGE_KEY)).toBe(false);
  });
});
