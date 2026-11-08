import { describe, expect, it, vi } from 'vitest';

/**
 * 本机设备名（D121 P3）：清洗控制字符、空值回退、持久化与
 * clientIdentity 的响应式读取。
 */

const store = new Map<string, string>([['kepcup.collab.clientName', '  小明  ']]);

vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});

const { clientNameState, CLIENT_NAME_MAX_CHARS } = await import('./client-name.svelte');
const { clientIdentity } = await import('./client-identity');

describe('client name setting', () => {
  it('loads the persisted name and exposes it through clientIdentity', () => {
    expect(clientNameState.name).toBe('小明');
    expect(clientIdentity.name).toBe('小明');
  });

  it('sanitizes, persists and updates the reactive identity', () => {
    clientIdentity.setName('  \u0000小红\u0007  ');
    expect(clientNameState.name).toBe('小红');
    expect(clientIdentity.name).toBe('小红');
    expect(store.get('kepcup.collab.clientName')).toBe('小红');
  });

  it('falls back to the device name when only control characters remain', () => {
    clientIdentity.setName('\u0000\u0001');
    expect(clientNameState.name).not.toBe('');
    expect(clientNameState.name.length).toBeGreaterThan(0);
  });

  it('truncates to the contract limit', () => {
    clientIdentity.setName('名'.repeat(CLIENT_NAME_MAX_CHARS + 20));
    expect(clientNameState.name).toHaveLength(CLIENT_NAME_MAX_CHARS);
  });
});
