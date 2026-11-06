import { describe, expect, it } from 'vitest';
import type { Settings } from '@kepcup/shared';
import {
  addProviderKey,
  buildModelRegistry,
  nextProviderApiKey,
  providerKeySecretNames,
  readProviderKeys,
  removeProviderKeyAt,
  replaceProviderKeys,
} from '../../src/agent/models.js';
import type { SecretsService } from '../../src/domain/secrets.js';

/** 只实现 Key 存取助手用到的方法，避免为单测拉起完整 SQLite / 加密栈。 */
function fakeSecrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const service = {
    store,
    hasValue: (name: string): boolean => store.has(name),
    getValue: (name: string): string | null => store.get(name) ?? null,
    names: (): string[] => [...store.keys()].sort(),
    setValue: (name: string, value: string): void => {
      store.set(name, value);
    },
    removeValue: (name: string): void => {
      store.delete(name);
    },
  };
  return service as unknown as SecretsService & typeof service;
}

describe('provider keys', () => {
  it('追加多个 Key：首个沿用历史 secret 名，其余进编号槽位', () => {
    const secrets = fakeSecrets();
    addProviderKey(secrets, 'p-multi', 'sk-first-1111');
    addProviderKey(secrets, 'p-multi', 'sk-proj-second-2222');

    expect(providerKeySecretNames(secrets, 'p-multi')).toEqual([
      'provider:p-multi',
      'provider:p-multi:key:0001',
    ]);
    expect(readProviderKeys(secrets, 'p-multi')).toEqual([
      'sk-first-1111',
      'sk-proj-second-2222',
    ]);
  });

  it('相同 Key 不重复写入；setKey 语义仍为整体替换', () => {
    const secrets = fakeSecrets();
    addProviderKey(secrets, 'p-dup', 'sk-same-1234');
    addProviderKey(secrets, 'p-dup', 'sk-same-1234');
    expect(readProviderKeys(secrets, 'p-dup')).toEqual(['sk-same-1234']);

    replaceProviderKeys(secrets, 'p-dup', ['sk-new-5678']);
    expect(readProviderKeys(secrets, 'p-dup')).toEqual(['sk-new-5678']);
  });

  it('按下标删除后重新编号，游标按剩余 Key 轮询', () => {
    const secrets = fakeSecrets();
    addProviderKey(secrets, 'p-remove', 'sk-a-1111');
    addProviderKey(secrets, 'p-remove', 'sk-b-2222');
    addProviderKey(secrets, 'p-remove', 'sk-c-3333');

    removeProviderKeyAt(secrets, 'p-remove', 1);
    expect(readProviderKeys(secrets, 'p-remove')).toEqual(['sk-a-1111', 'sk-c-3333']);
    expect(providerKeySecretNames(secrets, 'p-remove')).toEqual([
      'provider:p-remove',
      'provider:p-remove:key:0001',
    ]);
    expect(() => removeProviderKeyAt(secrets, 'p-remove', 9)).toThrow(/不存在/);
  });

  it('nextProviderApiKey 逐个请求轮换，没有配置时返回 null', () => {
    const secrets = fakeSecrets();
    expect(nextProviderApiKey(secrets, 'p-rotate')).toBeNull();

    addProviderKey(secrets, 'p-rotate', 'sk-a-1111');
    addProviderKey(secrets, 'p-rotate', 'sk-b-2222');
    expect(nextProviderApiKey(secrets, 'p-rotate')).toBe('sk-a-1111');
    expect(nextProviderApiKey(secrets, 'p-rotate')).toBe('sk-b-2222');
    expect(nextProviderApiKey(secrets, 'p-rotate')).toBe('sk-a-1111');

    replaceProviderKeys(secrets, 'p-rotate', []);
    expect(nextProviderApiKey(secrets, 'p-rotate')).toBeNull();
  });

  it('注册表在每次请求解析 Key 时轮换（实例供应商）', async () => {
    const secrets = fakeSecrets();
    addProviderKey(secrets, 'p-wire', 'sk-a-1111');
    addProviderKey(secrets, 'p-wire', 'sk-b-2222');

    const settings = {
      modelProviders: [
        {
          id: 'p-wire',
          vendor: null,
          name: 'Wire',
          baseUrl: 'http://127.0.0.1:9',
          enabled: true,
          api: 'openai-completions',
          builtinCatalog: false,
          models: [{ id: 'm', contextWindow: 1_000, capabilities: ['chat'] }],
        },
      ],
    } as unknown as Settings;
    const registry = buildModelRegistry({
      settings,
      secrets,
      logger: { info() {}, debug() {}, warn() {}, error() {} } as never,
    });
    const resolve = registry.getProvider('p-wire')?.auth.apiKey?.resolve;
    expect(resolve).toBeDefined();

    // 真实解析链：readCredential（轮换）→ resolve（复用）→ 每个请求只前进一次。
    const auths: Array<string | undefined> = [];
    for (let i = 0; i < 4; i++) {
      auths.push((await registry.getAuth('p-wire'))?.auth.apiKey);
    }
    expect(auths).toEqual(['sk-a-1111', 'sk-b-2222', 'sk-a-1111', 'sk-b-2222']);

    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const resolved = await resolve!({} as never);
      keys.push(resolved.auth.apiKey);
    }
    expect(keys).toEqual(['sk-a-1111', 'sk-b-2222', 'sk-a-1111']);
  });

  it('解析已轮换出的 credential 时不再前进游标（每个请求只轮换一次）', async () => {
    const secrets = fakeSecrets();
    addProviderKey(secrets, 'p-reuse', 'sk-a-1111');
    addProviderKey(secrets, 'p-reuse', 'sk-b-2222');

    const settings = {
      modelProviders: [
        {
          id: 'p-reuse',
          vendor: null,
          name: 'Reuse',
          baseUrl: 'http://127.0.0.1:9',
          enabled: true,
          api: 'openai-completions',
          builtinCatalog: false,
          models: [{ id: 'm', contextWindow: 1_000, capabilities: ['chat'] }],
        },
      ],
    } as unknown as Settings;
    const registry = buildModelRegistry({
      settings,
      secrets,
      logger: { info() {}, debug() {}, warn() {}, error() {} } as never,
    });
    const resolve = registry.getProvider('p-reuse')?.auth.apiKey?.resolve;

    // credentialStore 读出的 credential 原样返回。
    const reused = await resolve!({
      credential: { type: 'api_key', key: 'sk-b-2222' },
    } as never);
    expect(reused.auth.apiKey).toBe('sk-b-2222');

    // 无 credential（例如直接探测）时才自己取一次，游标未被上一步推进。
    expect((await resolve!({} as never)).auth.apiKey).toBe('sk-a-1111');
    expect((await resolve!({} as never)).auth.apiKey).toBe('sk-b-2222');
  });
});
