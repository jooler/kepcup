import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError, pluginManifestSchema, type PluginManifest } from '@kepcup/shared';
import { openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { systemClock } from '../../src/infra/clock.js';
import { pluginSecretScope, type PluginInstanceRow } from '../../src/plugins/instances.js';
import { CapabilityBridge, isHostAllowed } from '../../src/plugins/runtime/bridge.js';
import { PluginStorageStore } from '../../src/plugins/runtime/storage.js';

/**
 * 能力桥单测（D125 P2 步骤 2）：白名单命中 / 拒绝（大小写、通配边界）、SSRF 私网拒绝
 * 与重定向逐跳复检、20MB 上限、二进制 base64、credentials 只含实例 sensitive 字段、
 * secrets 前缀强制、storage 配额与卸载清除。
 */

const root = mkdtempSync(path.join(tmpdir(), 'plugin-bridge-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const PLUGIN = 'io.test/bridge';
const OTHER = 'io.test/other';

const noopLogger = { debug() {}, info() {}, warn() {}, error() {}, child: () => noopLogger };

function makeSecrets() {
  const values = new Map<string, string>();
  return {
    values,
    hasValue: (name: string) => values.has(name),
    getValue: (name: string) => values.get(name) ?? null,
    setValue: (name: string, value: string) => void values.set(name, value),
    removeValue: (name: string) => void values.delete(name),
    names: () => [...values.keys()],
  };
}

function manifestOf(networkAllow: string[] = ['example.invalid']): PluginManifest {
  return pluginManifestSchema.parse({
    format_version: 1,
    id: PLUGIN,
    name: '能力桥探针',
    version: '1.0.0',
    description: '能力桥单测夹具',
    usage: '测试专用',
    instances: ['capability-model'],
    runtime: {
      entry: 'main.mjs',
      hostApi: '^1',
      ...(networkAllow.length > 0 ? { network: { allow: networkAllow } } : {}),
    },
    contributions: {
      capabilityModels: [{ id: 'img', capability: 'image', model: 'm' }],
    },
  });
}

interface BridgeRigOptions {
  allow?: string[];
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
  quotaBytes?: number;
  instances?: PluginInstanceRow[];
}

function makeRig(options: BridgeRigOptions = {}) {
  const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 3), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  const secrets = makeSecrets();
  const storage = new PluginStorageStore({
    db,
    clock: systemClock,
    ...(options.quotaBytes !== undefined ? { quotaBytes: options.quotaBytes } : {}),
  });
  const manifests = new Map<string, PluginManifest>([
    [PLUGIN, manifestOf(options.allow ?? ['example.invalid'])],
  ]);
  const bridge = new CapabilityBridge({
    registry: {
      manifestOf: async (id: string) => manifests.get(id) ?? null,
    } as never,
    instances: { list: () => options.instances ?? [] },
    secrets: { getValue: secrets.getValue, names: secrets.names },
    storage,
    logger: noopLogger as never,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
  });
  return { bridge, storage, secrets, manifests, db };
}

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34' }];

const textFetch = (body: string, contentType = 'text/plain', status = 200): typeof fetch =>
  (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': contentType },
    })) as unknown as typeof fetch;

describe('isHostAllowed（白名单匹配语义：精确 host 或 *.domain，大小写不敏感）', () => {
  it('精确命中 / 通配子域 / 大小写 / 边界', () => {
    expect(isHostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(isHostAllowed('API.EXAMPLE.COM', ['api.example.com'])).toBe(true);
    expect(isHostAllowed('api.example.com', ['API.EXAMPLE.COM'])).toBe(true);
    expect(isHostAllowed('a.example.com', ['*.example.com'])).toBe(true);
    expect(isHostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
    // 通配只匹配子域，不匹配裸域本身（插件可同时列两条）。
    expect(isHostAllowed('example.com', ['*.example.com'])).toBe(false);
    // 后缀边界：notexample.com 不算 example.com 的子域。
    expect(isHostAllowed('notexample.com', ['*.example.com'])).toBe(false);
    expect(isHostAllowed('example.com.evil.io', ['*.example.com'])).toBe(false);
    expect(isHostAllowed('example.com', ['evil.com'])).toBe(false);
  });
});

describe('CapabilityBridge · net.fetch（D125 P2）', () => {
  it('白名单命中：文本直返（注入 fetch 与 DNS）；UA 固定不可被插件覆盖', async () => {
    let seen = '';
    let seenHeaders: Headers | null = null;
    const rig = makeRig({
      lookup: PUBLIC_LOOKUP,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen = String(url);
        seenHeaders = new Headers(init?.headers);
        return new Response('hello world', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }) as unknown as typeof fetch,
    });
    const response = await rig.bridge.netFetch(PLUGIN, 'https://example.invalid/ok', {
      headers: { 'User-Agent': 'evil-agent', 'X-Plugin': '1' },
    });
    expect(seen).toBe('https://example.invalid/ok');
    expect(response).toMatchObject({ status: 200, ok: true, bodyText: 'hello world' });
    expect(response.bodyBase64).toBeUndefined();
    expect(seenHeaders!.get('user-agent')).toContain('KepCup-Plugin');
    expect(seenHeaders!.get('user-agent')).not.toContain('evil-agent');
    expect(seenHeaders!.get('x-plugin')).toBe('1');
    expect(rig.bridge.auditSnapshot()[PLUGIN]).toEqual({ 'example.invalid': 1 });
  });

  it('单次请求超时由插件声明（init.timeoutMs）；不声明时用宿主上限兜底（不再是 60s）', async () => {
    // 慢响应：注入 fetch 监听 init.signal（真实 fetch 语义），1s 超时 → abort → 归一超时错误。
    const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('late', { status: 200 })), 5_000);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      })) as unknown as typeof fetch;
    const rig = makeRig({ lookup: PUBLIC_LOOKUP, fetchImpl: slow });
    const startedAt = Date.now();
    await expect(
      rig.bridge.netFetch(PLUGIN, 'https://example.invalid/slow', { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE', message: '插件网络请求超时' });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('abortFor（插件进程退出）取消在途请求，不再等自己的超时', async () => {
    // 注入 fetch 模拟真实语义：监听 init.signal，abort 时 reject。
    const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('late', { status: 200 })), 10_000);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      })) as unknown as typeof fetch;
    const rig = makeRig({ lookup: PUBLIC_LOOKUP, fetchImpl: slow });
    const pending = rig.bridge.netFetch(PLUGIN, 'https://example.invalid/slow', {
      timeoutMs: 600_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedAt = Date.now();
    rig.bridge.abortFor(PLUGIN);
    // abort 让 fetch 以拒绝收尾 → 归一到 PROVIDER_UNREACHABLE，不悬挂到 10s/600s。
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('白名单外域名 → PLUGIN_NETWORK_DENIED（DNS 之前拦截）', async () => {
    const rig = makeRig({ lookup: PUBLIC_LOOKUP });
    await expect(rig.bridge.netFetch(PLUGIN, 'https://blocked.invalid/x')).rejects.toMatchObject({
      code: 'PLUGIN_NETWORK_DENIED',
      details: { pluginId: PLUGIN, host: 'blocked.invalid' },
    });
  });

  it('清单无 network.allow（未声明）→ 一律拒绝', async () => {
    const rig = makeRig({ allow: [] });
    await expect(rig.bridge.netFetch(PLUGIN, 'https://example.invalid/x')).rejects.toMatchObject({
      code: 'PLUGIN_NETWORK_DENIED',
    });
  });

  it('SSRF：IP 字面量私网 / DNS 解析到私网 → PLUGIN_NETWORK_DENIED', async () => {
    const ipRig = makeRig({ allow: ['127.0.0.1', 'example.invalid'] });
    await expect(ipRig.bridge.netFetch(PLUGIN, 'http://127.0.0.1:8080/x')).rejects.toMatchObject({
      code: 'PLUGIN_NETWORK_DENIED',
    });
    // 云元数据地址。
    const metadataRig = makeRig({ allow: ['169.254.169.254'] });
    await expect(
      metadataRig.bridge.netFetch(PLUGIN, 'http://169.254.169.254/latest/meta-data'),
    ).rejects.toMatchObject({ code: 'PLUGIN_NETWORK_DENIED' });
    // 域名解析到私网（DNS rebinding 在连接前被拒）。
    const dnsRig = makeRig({
      lookup: async () => [{ address: '10.1.2.3' }],
      fetchImpl: textFetch('should-not-fetch'),
    });
    await expect(dnsRig.bridge.netFetch(PLUGIN, 'https://example.invalid/x')).rejects.toMatchObject(
      {
        code: 'PLUGIN_NETWORK_DENIED',
      },
    );
  });

  it('重定向逐跳复检：跳到白名单外域名 → PLUGIN_NETWORK_DENIED', async () => {
    const rig = makeRig({
      lookup: PUBLIC_LOOKUP,
      fetchImpl: (async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://blocked.invalid/target' },
        })) as unknown as typeof fetch,
    });
    await expect(rig.bridge.netFetch(PLUGIN, 'https://example.invalid/x')).rejects.toMatchObject({
      code: 'PLUGIN_NETWORK_DENIED',
    });
  });

  it('二进制响应 → base64；content-length 超 20MB → INVALID_INPUT', async () => {
    const binaryRig = makeRig({
      lookup: PUBLIC_LOOKUP,
      fetchImpl: (async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        })) as unknown as typeof fetch,
    });
    const binary = await binaryRig.bridge.netFetch(PLUGIN, 'https://example.invalid/bin');
    expect(binary.bodyBase64).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
    expect(binary.bodyText).toBeUndefined();

    const bigRig = makeRig({
      lookup: PUBLIC_LOOKUP,
      fetchImpl: (async () =>
        new Response('x', {
          status: 200,
          headers: { 'content-type': 'text/plain', 'content-length': '21000000' },
        })) as unknown as typeof fetch,
    });
    await expect(
      bigRig.bridge.netFetch(PLUGIN, 'https://example.invalid/big'),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    // 无 content-length（chunked）：按实际流读取累计，超过 20MB 即取消并拒绝。
    const chunkedRig = makeRig({
      lookup: PUBLIC_LOOKUP,
      fetchImpl: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const chunk = new Uint8Array(1024 * 1024);
              for (let i = 0; i < 21; i += 1) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'application/octet-stream' } },
        )) as unknown as typeof fetch,
    });
    await expect(
      chunkedRig.bridge.netFetch(PLUGIN, 'https://example.invalid/chunked'),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('http/https 之外的协议 → PLUGIN_NETWORK_DENIED', async () => {
    const rig = makeRig({ lookup: PUBLIC_LOOKUP });
    await expect(rig.bridge.netFetch(PLUGIN, 'file:///etc/passwd')).rejects.toMatchObject({
      code: 'PLUGIN_NETWORK_DENIED',
    });
  });
});

describe('CapabilityBridge · credentials / secrets（只含实例 sensitive 字段）', () => {
  function seedInstances(secrets: ReturnType<typeof makeSecrets>) {
    const scope = pluginSecretScope(PLUGIN);
    secrets.setValue(`${scope}:instance:pli_one:apiKey`, 'sk-one');
    secrets.setValue(`${scope}:instance:pli_one:baseUrl`, 'https://one.example');
    secrets.setValue(`${scope}:instance:pli_two:apiKey`, 'sk-two');
    secrets.setValue(`${pluginSecretScope(OTHER)}:instance:pli_x:apiKey`, 'sk-foreign');
    const rows: PluginInstanceRow[] = [
      {
        id: 'pli_one',
        pluginId: PLUGIN,
        kind: 'capability-model',
        title: '一号账号',
        configJson: JSON.stringify({ region: 'cn', flag: true }),
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    return rows;
  }

  it('credentialsFor 只返回该实例的 sensitive 值（不跨实例 / 不跨插件）', () => {
    const rig = makeRig();
    seedInstances(rig.secrets);
    expect(rig.bridge.credentialsFor(PLUGIN, 'pli_one')).toEqual({
      apiKey: 'sk-one',
      baseUrl: 'https://one.example',
    });
    expect(rig.bridge.credentialsFor(PLUGIN, 'pli_two')).toEqual({ apiKey: 'sk-two' });
    expect(rig.bridge.credentialsFor(PLUGIN, 'pli_missing')).toEqual({});
  });

  it('instancesFor：非敏感 config 标量 + 实例敏感字段（握手 init 帧）', () => {
    const rig = makeRig();
    const rows = seedInstances(rig.secrets);
    const bridge = new CapabilityBridge({
      registry: { manifestOf: async () => manifestOf() } as never,
      instances: { list: () => rows },
      secrets: { getValue: rig.secrets.getValue, names: rig.secrets.names },
      storage: rig.storage,
      logger: noopLogger as never,
    });
    expect(bridge.instancesFor(PLUGIN)).toEqual([
      {
        instanceId: 'pli_one',
        fields: {
          region: 'cn',
          flag: 'true',
          apiKey: 'sk-one',
          baseUrl: 'https://one.example',
        },
      },
    ]);
  });

  it('secretsGet：只读且只允许本插件的实例前缀；明文键翻译到存储名，越权拒绝', () => {
    const rig = makeRig();
    seedInstances(rig.secrets);
    const encodedKey = `${pluginSecretScope(PLUGIN)}:instance:pli_one:apiKey`;
    expect(rig.bridge.secretsGet(PLUGIN, encodedKey)).toBe('sk-one');
    // 固定契约的明文写法（plugin:{pluginId}:instance:{instanceId}:{key}）可用。
    expect(rig.bridge.secretsGet(PLUGIN, `plugin:${PLUGIN}:instance:pli_one:apiKey`)).toBe(
      'sk-one',
    );
    expect(
      rig.bridge.secretsGet(PLUGIN, `${pluginSecretScope(PLUGIN)}:instance:pli_one:none`),
    ).toBeNull();
    // 别的插件 / 别的命名空间一律拒绝。
    expect(() =>
      rig.bridge.secretsGet(PLUGIN, `${pluginSecretScope(OTHER)}:instance:pli_x:apiKey`),
    ).toThrow(AppError);
    expect(() =>
      rig.bridge.secretsGet(PLUGIN, `plugin:${OTHER}:instance:pli_x:apiKey`),
    ).toThrow(AppError);
    expect(() => rig.bridge.secretsGet(PLUGIN, 'provider:volcengine')).toThrow(/只能读取本插件/);
  });
});

describe('CapabilityBridge · storage（配额 / 前缀 / 卸载清除）', () => {
  it('set / get / list(prefix) / delete 往返；值不是 JSON 兼容数据 → INVALID_INPUT', () => {
    const rig = makeRig();
    rig.bridge.storageSet(PLUGIN, 'a', { n: 1 });
    rig.bridge.storageSet(PLUGIN, 'a_b', ['x']);
    rig.bridge.storageSet(PLUGIN, 'axb', 'text');
    expect(rig.bridge.storageGet(PLUGIN, 'a')).toEqual({ n: 1 });
    expect(rig.bridge.storageGet(PLUGIN, 'missing')).toBeNull();
    // LIKE 元字符按字面处理（`_` 不是通配符）。
    expect(rig.bridge.storageList(PLUGIN, 'a_')).toEqual(['a_b']);
    expect(rig.bridge.storageList(PLUGIN)).toEqual(['a', 'a_b', 'axb']);
    rig.bridge.storageDelete(PLUGIN, 'a');
    expect(rig.bridge.storageList(PLUGIN)).toEqual(['a_b', 'axb']);
    expect(() => rig.bridge.storageSet(PLUGIN, 'fn', () => undefined)).toThrow(/JSON/);
    expect(() => rig.bridge.storageSet(PLUGIN, 'big', 1n)).toThrow(/JSON/);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => rig.bridge.storageSet(PLUGIN, 'cyclic', cyclic)).toThrow(/JSON/);
  });

  it('10MB 配额：写前聚合校验（覆盖同键先扣旧值）；超限拒绝', () => {
    // 用小配额模拟 10MB 判定。
    const rig = makeRig({ quotaBytes: 64 });
    rig.bridge.storageSet(PLUGIN, 'k', 'a'.repeat(40));
    expect(rig.bridge.storageUsage(PLUGIN)).toBe(42); // JSON 字符串含引号
    // 超限：40 → 80 字节值 + 引号。
    expect(() => rig.bridge.storageSet(PLUGIN, 'k', 'b'.repeat(80))).toThrow(/配额/);
    // 覆盖同键先扣旧值：等长覆盖允许。
    rig.bridge.storageSet(PLUGIN, 'k', 'c'.repeat(40));
    expect(rig.bridge.storageGet(PLUGIN, 'k')).toBe('c'.repeat(40));
  });

  it('clearStorage 清空该插件全部键（卸载钩子；不动别的插件）', () => {
    const rig = makeRig();
    rig.bridge.storageSet(PLUGIN, 'a', 1);
    rig.bridge.storageSet(OTHER, 'b', 2);
    // 跨插件隔离：同 key 在不同 plugin_id 下互不可见。
    expect(rig.bridge.storageGet(OTHER, 'a')).toBeNull();
    rig.bridge.clearStorage(PLUGIN);
    expect(rig.bridge.storageList(PLUGIN)).toEqual([]);
    expect(rig.bridge.storageGet(OTHER, 'b')).toBe(2);
  });
});
