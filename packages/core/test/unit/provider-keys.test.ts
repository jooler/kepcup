import { describe, expect, it } from 'vitest';
import { maskApiKey, type Settings } from '@kepcup/shared';
import {
  addProviderKey,
  buildModelRegistry,
  nextProviderApiKey,
  providerKeySecretNames,
  readProviderEntries,
  readProviderKeys,
  removeProviderKeyAt,
  replaceProviderKeys,
  updateProviderKeyMeta,
} from '../../src/agent/models.js';
import type { SecretsService } from '../../src/domain/secrets.js';

/** 只实现 Key 存取助手用到的方法，避免为单测拉起完整 SQLite / 加密栈。 */
function fakeSecrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const redactValues = new Set<string>();
  const service = {
    store,
    redactValues,
    hasValue: (name: string): boolean => store.has(name),
    getValue: (name: string): string | null => store.get(name) ?? null,
    names: (): string[] => [...store.keys()].sort(),
    setValue: (name: string, value: string): void => {
      store.set(name, value);
    },
    removeValue: (name: string): void => {
      store.delete(name);
    },
    registerRedactValue: (value: string): void => {
      redactValues.add(value);
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

    replaceProviderKeys(secrets, 'p-dup', [{ key: 'sk-new-5678', enabled: true }]);
    expect(readProviderKeys(secrets, 'p-dup')).toEqual(['sk-new-5678']);
  });

  it('标注随 Key 落盘：别名 / 启停 roundtrip，旧格式纯文本按启用读取', () => {
    const secrets = fakeSecrets();
    // 旧格式：多 Key 功能引入前的纯文本 Key。
    secrets.store.set('provider:p-legacy', 'sk-legacy-9999');

    addProviderKey(secrets, 'p-legacy', 'sk-second-0000');
    updateProviderKeyMeta(secrets, 'p-legacy', 0, { alias: '主力', enabled: false });
    updateProviderKeyMeta(secrets, 'p-legacy', 1, { alias: ' 备用 ' });

    expect(readProviderEntries(secrets, 'p-legacy')).toEqual([
      { key: 'sk-legacy-9999', alias: '主力', enabled: false },
      { key: 'sk-second-0000', alias: '备用', enabled: true },
    ]);
    // 落盘为 JSON envelope（含标注），不再是纯文本。
    expect(secrets.store.get('provider:p-legacy')).toContain('"alias"');

    // 内层明文 Key 补登记进 redact 集合：envelope 槽位的存储值是整串 JSON，
    // secrets.redact 的精确匹配盖不到内层，不登记就会从防泄漏防线漏走。
    expect([...secrets.redactValues]).toEqual(
      expect.arrayContaining(['sk-legacy-9999', 'sk-second-0000']),
    );

    // 只改启停：别名原样保留（部分更新语义，两个方向都要成立）。
    updateProviderKeyMeta(secrets, 'p-legacy', 1, { enabled: false });
    expect(readProviderEntries(secrets, 'p-legacy')[1]).toEqual({
      key: 'sk-second-0000',
      alias: '备用',
      enabled: false,
    });

    // 空串别名 = 清除；enabled 缺省保持原值。
    updateProviderKeyMeta(secrets, 'p-legacy', 0, { alias: '' });
    expect(readProviderEntries(secrets, 'p-legacy')[0]).toEqual({
      key: 'sk-legacy-9999',
      enabled: false,
    });

    // 非法下标报 INVALID_INPUT。
    expect(() =>
      updateProviderKeyMeta(secrets, 'p-legacy', 9, { enabled: true }),
    ).toThrow(/不存在/);
  });

  it('损坏槽位的兜底：合法 JSON 但缺 key 字段时整串按旧格式明文 Key 处理', () => {
    const secrets = fakeSecrets({
      'provider:p-corrupt': '{"alias":"只有标注"}',
    });
    // 槽位里的一切都按「可能是 Key」兜底（放进 Authorization 头 + 掩码预览），
    // 固定该行为：解析不抛错、不静默丢条目。
    expect(readProviderEntries(secrets, 'p-corrupt')).toEqual([
      { key: '{"alias":"只有标注"}', enabled: true },
    ]);
    expect(readProviderKeys(secrets, 'p-corrupt')).toEqual(['{"alias":"只有标注"}']);
  });

  it('按下标删除保留其余条目的标注；整体替换重置标注', () => {
    const secrets = fakeSecrets();
    addProviderKey(secrets, 'p-meta', 'sk-a-1111');
    addProviderKey(secrets, 'p-meta', 'sk-b-2222');
    addProviderKey(secrets, 'p-meta', 'sk-c-3333');
    updateProviderKeyMeta(secrets, 'p-meta', 1, { alias: '备份', enabled: false });

    removeProviderKeyAt(secrets, 'p-meta', 0);
    expect(readProviderEntries(secrets, 'p-meta')).toEqual([
      { key: 'sk-b-2222', alias: '备份', enabled: false },
      { key: 'sk-c-3333', enabled: true },
    ]);

    // setKey（整体替换）语义：换成新 Key，标注一并重置。
    replaceProviderKeys(secrets, 'p-meta', [{ key: 'sk-fresh-4444', enabled: true }]);
    expect(readProviderEntries(secrets, 'p-meta')).toEqual([{ key: 'sk-fresh-4444', enabled: true }]);
  });

  it('nextProviderApiKey 跳过停用的 Key，全部停用时返回 null', () => {
    const secrets = fakeSecrets();
    addProviderKey(secrets, 'p-skip', 'sk-a-1111');
    addProviderKey(secrets, 'p-skip', 'sk-b-2222');
    addProviderKey(secrets, 'p-skip', 'sk-c-3333');
    updateProviderKeyMeta(secrets, 'p-skip', 1, { enabled: false });

    // 只在启用中的 a / c 之间轮换，b 被跳过。
    expect(nextProviderApiKey(secrets, 'p-skip')).toBe('sk-a-1111');
    expect(nextProviderApiKey(secrets, 'p-skip')).toBe('sk-c-3333');
    expect(nextProviderApiKey(secrets, 'p-skip')).toBe('sk-a-1111');

    updateProviderKeyMeta(secrets, 'p-skip', 0, { enabled: false });
    updateProviderKeyMeta(secrets, 'p-skip', 2, { enabled: false });
    expect(nextProviderApiKey(secrets, 'p-skip')).toBeNull();
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

  it('全部停用时鉴权解析失败，不回退到环境变量 / 占位 key；从未配 Key 的端点保持原行为', async () => {
    const secrets = fakeSecrets();
    addProviderKey(secrets, 'p-off', 'sk-off-1111');
    updateProviderKeyMeta(secrets, 'p-off', 0, { enabled: false });

    const settings = {
      modelProviders: [
        {
          id: 'p-off',
          vendor: null,
          name: 'Off',
          baseUrl: 'http://127.0.0.1:9',
          enabled: true,
          api: 'openai-completions',
          builtinCatalog: false,
          models: [{ id: 'm', contextWindow: 1_000, capabilities: ['chat'] }],
        },
        {
          id: 'p-keyless',
          vendor: null,
          name: 'Keyless',
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

    await expect(registry.getAuth('p-off')).rejects.toThrow(/全部停用/);
    // 从未配置 Key：沿用无鉴权（本地兼容端点）行为。
    expect((await registry.getAuth('p-keyless'))?.auth.apiKey).toBe('unused');
  });

  it('每进程对每个供应商记一次 Key 概览（只有掩码，不含明文）', async () => {
    const secrets = fakeSecrets();
    addProviderKey(secrets, 'p-summary', 'sk-a-1111');
    addProviderKey(secrets, 'p-summary', 'sk-b-2222');
    updateProviderKeyMeta(secrets, 'p-summary', 1, { enabled: false });

    const logged: Array<Record<string, unknown>> = [];
    const settings = {
      modelProviders: [
        {
          id: 'p-summary',
          vendor: null,
          name: 'Summary',
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
      logger: {
        info: (record: Record<string, unknown>, message?: string) =>
          logged.push({ ...record, ...(message !== undefined ? { msg: message } : {}) }),
        debug() {},
        warn() {},
        error() {},
      } as never,
    });

    await registry.getAuth('p-summary');
    await registry.getAuth('p-summary');

    const rows = logged.filter((record) => record['msg'] === 'provider keys loaded');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: 'p-summary',
      enabledKeys: 1,
      disabledKeys: 1,
      keyMasks: [maskApiKey('sk-a-1111')],
    });
    expect(JSON.stringify(rows)).not.toContain('sk-a-1111');
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
