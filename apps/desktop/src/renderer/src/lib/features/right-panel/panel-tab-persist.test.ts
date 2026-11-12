import { describe, expect, it } from 'vitest';
import {
  loadPanelTab,
  PANEL_TAB_MAX_CONVERSATIONS,
  PANEL_TAB_STORAGE_KEY,
  savePanelTab,
  type PanelTabStorage,
} from './panel-tab-persist';

/** 极简 localStorage 替身（node 环境无 DOM）。 */
function fakeStorage(initial: Record<string, string> = {}): PanelTabStorage & {
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

describe('right panel tab persistence', () => {
  it('records one tab per conversation', () => {
    const storage = fakeStorage();
    savePanelTab(storage, 'c1', 'tasks');
    savePanelTab(storage, 'c2', 'widgets');
    expect(loadPanelTab(storage, 'c1')).toBe('tasks');
    expect(loadPanelTab(storage, 'c2')).toBe('widgets');
    expect(loadPanelTab(storage, 'missing')).toBeNull();
  });

  it('overwrites the same conversation without touching the others', () => {
    const storage = fakeStorage();
    savePanelTab(storage, 'c1', 'tasks');
    savePanelTab(storage, 'c2', 'notes');
    savePanelTab(storage, 'c1', 'detail');
    expect(loadPanelTab(storage, 'c1')).toBe('detail');
    expect(loadPanelTab(storage, 'c2')).toBe('notes');
  });

  it('treats corrupted or unknown data as empty', () => {
    const storage = fakeStorage({ [PANEL_TAB_STORAGE_KEY]: '{not json' });
    expect(loadPanelTab(storage, 'c1')).toBeNull();
    storage.setItem(PANEL_TAB_STORAGE_KEY, JSON.stringify(['detail']));
    expect(loadPanelTab(storage, 'c1')).toBeNull();
    storage.setItem(PANEL_TAB_STORAGE_KEY, JSON.stringify({ c1: 'bogus', c2: 'tasks' }));
    expect(loadPanelTab(storage, 'c1')).toBeNull();
    expect(loadPanelTab(storage, 'c2')).toBe('tasks');
  });

  it('returns null when storage is unavailable', () => {
    expect(loadPanelTab(null, 'c1')).toBeNull();
    expect(() => savePanelTab(null, 'c1', 'tasks')).not.toThrow();
  });

  it('evicts the least recently used conversation beyond the cap', () => {
    const storage = fakeStorage();
    for (let index = 0; index < PANEL_TAB_MAX_CONVERSATIONS; index += 1) {
      savePanelTab(storage, `c${index}`, 'tasks');
    }
    // 重新访问 c0：刷新顺序，最久未访问变成 c1。
    savePanelTab(storage, 'c0', 'widgets');
    savePanelTab(storage, 'overflow', 'notes');
    expect(loadPanelTab(storage, 'c0')).toBe('widgets');
    expect(loadPanelTab(storage, 'c1')).toBeNull();
    expect(loadPanelTab(storage, 'overflow')).toBe('notes');
  });
});
