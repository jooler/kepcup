import { describe, expect, test } from 'vitest';
import {
  clearLastConversationId,
  LAST_CONVERSATION_STORAGE_KEY,
  loadLastConversationId,
  saveLastConversationId,
} from './last-conversation-persist';

/** 极简 localStorage 替身（node 环境无 DOM）。 */
function fakeStorage(initial: Record<string, string> = {}, failSet = false): {
  store: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      if (failSet) throw new DOMException('quota exceeded', 'QuotaExceededError');
      void store.set(key, value);
    },
    removeItem: (key) => void store.delete(key),
  };
}

describe('last-conversation-persist', () => {
  test('存取回路：save 后 load 原样取回', () => {
    const storage = fakeStorage();
    saveLastConversationId(storage, 'conv_abc');
    expect(loadLastConversationId(storage)).toBe('conv_abc');
    expect(storage.store.get(LAST_CONVERSATION_STORAGE_KEY)).toBe('conv_abc');
  });

  test('无存储 / 未写入 / 空串 → null', () => {
    expect(loadLastConversationId(null)).toBeNull();
    expect(loadLastConversationId(fakeStorage())).toBeNull();
    expect(loadLastConversationId(fakeStorage({ [LAST_CONVERSATION_STORAGE_KEY]: '' }))).toBeNull();
  });

  test('存储内容损坏（任意串）原样返回：有效性由调用方对照会话名单校验', () => {
    const storage = fakeStorage({ [LAST_CONVERSATION_STORAGE_KEY]: 'not-a-json{{{' });
    expect(loadLastConversationId(storage)).toBe('not-a-json{{{');
  });

  test('localStorage 抛异常（读取/写入/清除）都吞掉，不阻塞调用方', () => {
    const broken: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('unavailable');
      },
    };
    expect(loadLastConversationId(broken)).toBeNull();
    expect(() => saveLastConversationId(broken, 'conv_x')).not.toThrow();
    expect(() => clearLastConversationId(broken)).not.toThrow();
  });

  test('storage 为 null 时写入/清除是空操作', () => {
    expect(() => saveLastConversationId(null, 'conv_x')).not.toThrow();
    expect(() => clearLastConversationId(null)).not.toThrow();
  });

  test('clear 移除键；配额满未写入时不留半截值', () => {
    const storage = fakeStorage({ [LAST_CONVERSATION_STORAGE_KEY]: 'conv_old' });
    clearLastConversationId(storage);
    expect(loadLastConversationId(storage)).toBeNull();

    const failing = fakeStorage({}, true);
    saveLastConversationId(failing, 'conv_new');
    expect(failing.store.has(LAST_CONVERSATION_STORAGE_KEY)).toBe(false);
  });
});
