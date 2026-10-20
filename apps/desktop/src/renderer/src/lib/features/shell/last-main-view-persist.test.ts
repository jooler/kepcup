import { describe, expect, test } from 'vitest';
import {
  LAST_MAIN_VIEW_STORAGE_KEY,
  loadLastMainView,
  saveLastMainView,
} from './last-main-view-persist';

/** 极简 localStorage 替身（node 环境无 DOM）。 */
function fakeStorage(
  initial: Record<string, string> = {},
  failSet = false,
): {
  store: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      if (failSet) throw new DOMException('quota exceeded', 'QuotaExceededError');
      void store.set(key, value);
    },
  };
}

describe('last-main-view-persist', () => {
  test('存取回路：save 后 load 原样取回', () => {
    const storage = fakeStorage();
    saveLastMainView(storage, 'workbench');
    expect(loadLastMainView(storage)).toBe('workbench');
    expect(storage.store.get(LAST_MAIN_VIEW_STORAGE_KEY)).toBe('workbench');

    saveLastMainView(storage, 'chats');
    expect(loadLastMainView(storage)).toBe('chats');
  });

  test('无存储 / 未写入 / 无法识别的值 → null（调用方按默认对话处理）', () => {
    expect(loadLastMainView(null)).toBeNull();
    expect(loadLastMainView(fakeStorage())).toBeNull();
    expect(loadLastMainView(fakeStorage({ [LAST_MAIN_VIEW_STORAGE_KEY]: '' }))).toBeNull();
    expect(loadLastMainView(fakeStorage({ [LAST_MAIN_VIEW_STORAGE_KEY]: 'project' }))).toBeNull();
  });

  test('localStorage 抛异常（读取/写入）都吞掉，不阻塞调用方', () => {
    const broken: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      },
    };
    expect(loadLastMainView(broken)).toBeNull();
    expect(() => saveLastMainView(broken, 'workbench')).not.toThrow();
  });

  test('storage 为 null 时写入是空操作', () => {
    expect(() => saveLastMainView(null, 'chats')).not.toThrow();
  });
});
