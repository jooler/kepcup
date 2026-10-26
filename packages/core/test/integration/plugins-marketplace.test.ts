import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PluginInspectOutput, PluginSummary } from '@kepcup/shared';
import { withRemoteSource } from '@kepcup/core';
import { buildPluginFixture, createTestStack, makeBot, type TestStack } from '@kepcup/testkit';
import { bindPluginsMethods } from '../../src/rpc/plugins-bindings.js';
import type { DirectoryFetch } from '../../src/apps/directory-sync.js';
import { buildPluginIndex, makeMarketKey, pluginIndexEntryFor } from '../support/plugin-market-fixture.js';

/**
 * 插件市场集成（D104 P1-1 步骤 4）：签名索引同步 → `plugins.marketplace.list / refresh` →
 * `plugins.inspect / install` 的 marketplace 来源全流程（下载、sha256 / 清单核对、撤销、
 * `updateAvailable`）、官方与自建端点切换、防回滚与篡改拒绝、定时开关、远程端点约束。
 */

const root = mkdtempSync(path.join(tmpdir(), 'plugins-marketplace-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

const OFFICIAL_BASE = 'https://market.test/plugins/v1';
const CUSTOM_BASE = 'https://self.test/plugins/v1';
const T1 = Date.parse('2026-10-09T00:00:00.000Z');
const T2 = Date.parse('2026-10-10T00:00:00.000Z');
const T3 = Date.parse('2026-10-11T00:00:00.000Z');

interface Package {
  id: string;
  version: string;
  sha256: string;
  size: number;
  path: string;
}

async function makePackage(options: { id?: string; version?: string } = {}): Promise<Package> {
  const fixture = await buildPluginFixture({
    dir: mkdtempSync(path.join(root, 'pkg-')),
    manifest: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.version !== undefined ? { version: options.version } : {}),
    },
    skills: [{ name: 'market-demo' }],
  });
  const manifest = fixture.manifest as { id: string; version: string };
  return {
    id: manifest.id,
    version: manifest.version,
    sha256: fixture.sha256,
    size: fixture.size,
    path: fixture.path,
  };
}

/** In-memory market + package server wired into the test stack (fresh ETags per put). */
class Market {
  readonly requests: string[] = [];
  readonly #files = new Map<string, Buffer>();
  readonly #etags = new Map<string, string>();
  #version = 0;
  readonly fetch: DirectoryFetch = async (input, init) => {
    this.requests.push(input);
    const file = this.#files.get(input);
    if (file === undefined) return new Response('not found', { status: 404 });
    const etag = this.#etags.get(input) ?? '"missing"';
    if ((init?.headers?.['if-none-match'] ?? null) === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(new Uint8Array(file), { status: 200, headers: { etag } });
  };
  get indexRequests(): number {
    return this.requests.filter((url) => url.endsWith('/index.json') && !url.endsWith('.sig'))
      .length;
  }
  put(url: string, bytes: Buffer): void {
    this.#files.set(url, bytes);
    this.#etags.set(url, `"v${++this.#version}"`);
  }
  drop(url: string): void {
    this.#files.delete(url);
  }
  publish(input: {
    base: string;
    key: ReturnType<typeof makeMarketKey>;
    generatedAt: number;
    entries: Array<Record<string, unknown>>;
    revoked?: Array<Record<string, unknown>>;
    tamperedIndex?: boolean;
    badSignature?: boolean;
  }): void {
    const signed = buildPluginIndex({
      key: input.key,
      generatedAt: input.generatedAt,
      entries: input.entries,
      ...(input.revoked !== undefined ? { revoked: input.revoked } : {}),
    });
    const indexBytes = input.tamperedIndex === true
      ? Buffer.from(signed.indexBytes.toString('utf8').replace('"1.0.0"', '"9.9.9"'))
      : signed.indexBytes;
    this.put(`${input.base}/index.json`, indexBytes);
    this.put(
      `${input.base}/index.json.sig`,
      Buffer.from(`${input.badSignature === true ? `${'A'.repeat(86)}==` : signed.sig}\n`),
    );
  }
  servePackage(base: string, pkg: Package): void {
    this.put(`${base}/${pkg.sha256}.kepcup`, readFileSync(pkg.path));
  }
}

interface Rig {
  stack: TestStack;
  market: Market;
  officialKey: ReturnType<typeof makeMarketKey>;
  customKey: ReturnType<typeof makeMarketKey>;
}

const stacks: TestStack[] = [];
afterAll(() => {
  for (const stack of stacks.splice(0)) void stack.cleanup();
});

async function setup(options: {
  officialKeys?: boolean;
  /** Explicit official key (tests that publish the index before the stack starts). */
  officialKey?: ReturnType<typeof makeMarketKey>;
  baseUrl?: string;
  fetch?: DirectoryFetch;
  downloadFetch?: DirectoryFetch;
  intervalMs?: number;
  initialDelayMs?: number;
} = {}): Promise<Rig> {
  const market = new Market();
  const officialKey = options.officialKey ?? makeMarketKey('official-test');
  const customKey = makeMarketKey('custom');
  const stack = await createTestStack({
    mcpbRuntimes: { node: { command: process.execPath, version: '24.21.0' } },
    pluginMarketplace: {
      ...(options.officialKeys === false ? {} : { keys: [officialKey.publicEntry] }),
      baseUrl: options.baseUrl ?? OFFICIAL_BASE,
      fetch: options.fetch ?? market.fetch,
      ...(options.downloadFetch !== undefined ? { downloadFetch: options.downloadFetch } : {}),
      ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
      ...(options.initialDelayMs !== undefined
        ? { initialDelayMs: options.initialDelayMs }
        : { initialDelayMs: 3600_000 }),
    },
  });
  stacks.push(stack);
  return { stack, market, officialKey, customKey };
}

async function marketList(stack: TestStack) {
  return (await stack.core.rpc.call('plugins.marketplace.list', undefined)) as {
    status: {
      state: string;
      disabledReason: string | null;
      lastSync: number | null;
      error: string | null;
      endpoint: string;
    };
    entries: Array<{
      id: string;
      version: string;
      tier: string;
      compatible: boolean;
      incompatibleReason: string | null;
      installed: { version: string; updateAvailable: boolean } | null;
      revoked: string | null;
    }>;
  };
}

async function refresh(stack: TestStack) {
  return (await stack.core.rpc.call('plugins.marketplace.refresh', undefined)) as {
    status: { state: string; error: string | null };
  };
}

describe('plugins marketplace integration (P1-1)', () => {
  it('默认构建（官方公钥为空）不发任何网络请求，市场关闭', async () => {
    const { stack, market } = await setup({ officialKeys: false, initialDelayMs: 10 });
    const list = await marketList(stack);
    expect(list.status).toMatchObject({ state: 'disabled', disabledReason: 'no_keys' });
    expect(list.entries).toEqual([]);
    await expect(
      stack.core.rpc.call('plugins.inspect', {
        source: { kind: 'marketplace', id: 'io.a/b' },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    // start() 已跑过（stack 启动即 start）；定时器不应有任何拉取。
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(market.requests).toEqual([]);
  }, 30_000);

  it('注入测试密钥后 refresh → list → inspect → install 全流程', async () => {
    const { stack, market, officialKey } = await setup();
    const pkg = await makePackage({ id: 'io.official/demo', version: '1.0.0' });
    market.servePackage(OFFICIAL_BASE, pkg);
    const entry = pluginIndexEntryFor(
      { path: pkg.path, sha256: pkg.sha256, size: pkg.size, manifest: { id: pkg.id, version: pkg.version } as never },
      { downloadUrl: `${OFFICIAL_BASE}/${pkg.sha256}.kepcup` },
    );
    market.publish({ base: OFFICIAL_BASE, key: officialKey, generatedAt: T1, entries: [entry] });

    const refreshed = await refresh(stack);
    expect(refreshed.status.state).toBe('ok');
    const list = await marketList(stack);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]).toMatchObject({
      id: pkg.id,
      version: '1.0.0',
      tier: 'verified',
      compatible: true,
      installed: null,
      revoked: null,
    });

    const inspect = (await stack.core.rpc.call('plugins.inspect', {
      source: { kind: 'marketplace', id: pkg.id },
    })) as PluginInspectOutput;
    expect(inspect).toMatchObject({
      id: pkg.id,
      version: '1.0.0',
      origin: 'marketplace',
      tier: 'verified',
      packageSha256: pkg.sha256,
      installable: true,
    });

    const install = (await stack.core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: pkg.id },
      sha256: inspect.packageSha256,
      userConfig: {},
    })) as { plugin: PluginSummary };
    expect(install.plugin).toMatchObject({
      id: pkg.id,
      origin: 'marketplace',
      tier: 'verified',
      marketplace: OFFICIAL_BASE,
      revoked: null,
    });
    const plugins = (await stack.core.rpc.call('plugins.list', undefined)) as {
      plugins: PluginSummary[];
    };
    expect(plugins.plugins[0]).toMatchObject({
      origin: 'marketplace',
      tier: 'verified',
      marketplace: OFFICIAL_BASE,
    });
  }, 60_000);

  it('篡改：索引字节 / 签名 / 包字节 / 包内清单与索引不符 → 全部拒绝', async () => {
    const { stack, market, officialKey } = await setup();
    const pkg = await makePackage({ id: 'io.official/tamper', version: '1.0.0' });
    market.servePackage(OFFICIAL_BASE, pkg);
    const entry = pluginIndexEntryFor(
      { path: pkg.path, sha256: pkg.sha256, size: pkg.size, manifest: { id: pkg.id, version: pkg.version } as never },
      { downloadUrl: `${OFFICIAL_BASE}/${pkg.sha256}.kepcup` },
    );
    market.publish({ base: OFFICIAL_BASE, key: officialKey, generatedAt: T1, entries: [entry], tamperedIndex: true });
    expect((await refresh(stack)).status.error).toContain('bad_signature');

    market.publish({ base: OFFICIAL_BASE, key: officialKey, generatedAt: T2, entries: [entry], badSignature: true });
    expect((await refresh(stack)).status.error).toContain('bad_signature');

    // 索引正常但包字节被改：sha256 不符 → install 拒绝且没有装上。
    market.publish({ base: OFFICIAL_BASE, key: officialKey, generatedAt: T3, entries: [entry] });
    expect((await refresh(stack)).status.state).toBe('ok');
    market.put(`${OFFICIAL_BASE}/${pkg.sha256}.kepcup`, Buffer.from('tampered-bytes'));
    await expect(
      stack.core.rpc.call('plugins.install', {
        source: { kind: 'marketplace', id: pkg.id },
        sha256: pkg.sha256,
        userConfig: {},
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    market.servePackage(OFFICIAL_BASE, pkg);

    // 包内清单 id 与索引不符。
    const other = await makePackage({ id: 'io.official/other', version: '1.0.0' });
    market.put(`${OFFICIAL_BASE}/${pkg.sha256}.kepcup`, readFileSync(other.path));
    await expect(
      stack.core.rpc.call('plugins.install', {
        source: { kind: 'marketplace', id: pkg.id },
        sha256: pkg.sha256,
        userConfig: {},
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    const plugins = (await stack.core.rpc.call('plugins.list', undefined)) as {
      plugins: PluginSummary[];
    };
    expect(plugins.plugins).toHaveLength(0);
  }, 60_000);

  it('防回滚：更旧的合法索引被拒并保留旧视图', async () => {
    const { stack, market, officialKey } = await setup();
    const pkg = await makePackage({ id: 'io.official/rollback', version: '1.0.0' });
    market.servePackage(OFFICIAL_BASE, pkg);
    const entry = pluginIndexEntryFor(
      { path: pkg.path, sha256: pkg.sha256, size: pkg.size, manifest: { id: pkg.id, version: pkg.version } as never },
      { downloadUrl: `${OFFICIAL_BASE}/${pkg.sha256}.kepcup` },
    );
    market.publish({ base: OFFICIAL_BASE, key: officialKey, generatedAt: T2, entries: [entry] });
    expect((await refresh(stack)).status.state).toBe('ok');

    const newer = await makePackage({ id: 'io.official/rollback', version: '1.1.0' });
    market.servePackage(OFFICIAL_BASE, newer);
    const newerEntry = pluginIndexEntryFor(
      { path: newer.path, sha256: newer.sha256, size: newer.size, manifest: { id: newer.id, version: newer.version } as never },
      { downloadUrl: `${OFFICIAL_BASE}/${newer.sha256}.kepcup` },
    );
    market.publish({ base: OFFICIAL_BASE, key: officialKey, generatedAt: T3, entries: [newerEntry] });
    expect((await refresh(stack)).status.state).toBe('ok');

    market.publish({ base: OFFICIAL_BASE, key: officialKey, generatedAt: T1, entries: [entry] });
    const rolled = await refresh(stack);
    expect(rolled.status.error).toContain('rollback');
    const list = await marketList(stack);
    expect(list.entries.map((item) => item.version)).toEqual(['1.1.0']);
  }, 60_000);

  it('撤销：disable 自动停用已装插件、再装被拒；warn 只标记', async () => {
    const { stack, market, officialKey } = await setup();
    const { core } = stack;
    const bot = await makeBot(core, 'market-bot');
    const pkg = await makePackage({ id: 'io.official/revoke', version: '1.0.0' });
    market.servePackage(OFFICIAL_BASE, pkg);
    const entry = pluginIndexEntryFor(
      {
        path: pkg.path,
        sha256: pkg.sha256,
        size: pkg.size,
        manifest: { id: pkg.id, version: pkg.version } as never,
      },
      { downloadUrl: `${OFFICIAL_BASE}/${pkg.sha256}.kepcup` },
    );
    market.publish({ base: OFFICIAL_BASE, key: officialKey, generatedAt: T1, entries: [entry] });
    await refresh(stack);
    const inspect = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'marketplace', id: pkg.id },
    })) as PluginInspectOutput;
    await core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: pkg.id },
      sha256: inspect.packageSha256,
      userConfig: {},
    });

    // 新索引：disable 撤销 → 采纳后已装插件被自动停用（技能消失）。
    market.publish({
      base: OFFICIAL_BASE,
      key: officialKey,
      generatedAt: T2,
      entries: [entry],
      revoked: [{ id: pkg.id, action: 'disable', reason: 'malware' }],
    });
    await refresh(stack);
    // 撤销执行走注册表互斥锁（fire-and-forget）：等它落定。
    await vi.waitFor(async () => {
      const disabled = (await core.rpc.call('plugins.list', undefined)) as {
        plugins: PluginSummary[];
      };
      expect(disabled.plugins[0]).toMatchObject({ enabled: false, revoked: 'disable' });
    });
    const disabled = (await core.rpc.call('plugins.list', undefined)) as {
      plugins: PluginSummary[];
    };
    expect(disabled.plugins[0]).toMatchObject({ enabled: false, revoked: 'disable' });
    const skills = (await core.rpc.call('skills.list', { botId: bot.id })) as {
      skills: Array<{ name: string; scope: string }>;
    };
    expect(skills.skills.filter((skill) => skill.scope === 'public')).toHaveLength(0);

    // 再装被拒。
    await expect(
      core.rpc.call('plugins.install', {
        source: { kind: 'marketplace', id: pkg.id },
        sha256: inspect.packageSha256,
        userConfig: {},
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });

    // warn 只标记：不改变 enabled，只给 revoked 字段。
    market.publish({
      base: OFFICIAL_BASE,
      key: officialKey,
      generatedAt: T3,
      entries: [entry],
      revoked: [{ id: pkg.id, action: 'warn' }],
    });
    await refresh(stack);
    const warned = (await core.rpc.call('plugins.list', undefined)) as {
      plugins: PluginSummary[];
    };
    expect(warned.plugins[0]).toMatchObject({ enabled: false, revoked: 'warn' });
  }, 90_000);

  it('updateAvailable：索引有更高版本给出标记，被撤销后消失', async () => {
    const { stack, market, officialKey } = await setup();
    const { core } = stack;
    const v1 = await makePackage({ id: 'io.official/updates', version: '1.0.0' });
    market.servePackage(OFFICIAL_BASE, v1);
    const entryV1 = pluginIndexEntryFor(
      { path: v1.path, sha256: v1.sha256, size: v1.size, manifest: { id: v1.id, version: v1.version } as never },
      { downloadUrl: `${OFFICIAL_BASE}/${v1.sha256}.kepcup` },
    );
    market.publish({ base: OFFICIAL_BASE, key: officialKey, generatedAt: T1, entries: [entryV1] });
    await refresh(stack);
    const inspect = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'marketplace', id: v1.id },
    })) as PluginInspectOutput;
    await core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: v1.id },
      sha256: inspect.packageSha256,
      userConfig: {},
    });

    const v2 = await makePackage({ id: 'io.official/updates', version: '1.1.0' });
    market.servePackage(OFFICIAL_BASE, v2);
    const entryV2 = pluginIndexEntryFor(
      { path: v2.path, sha256: v2.sha256, size: v2.size, manifest: { id: v2.id, version: v2.version } as never },
      { downloadUrl: `${OFFICIAL_BASE}/${v2.sha256}.kepcup` },
    );
    market.publish({ base: OFFICIAL_BASE, key: officialKey, generatedAt: T2, entries: [entryV1, entryV2] });
    await refresh(stack);
    let list = await marketList(stack);
    expect(list.entries[0]!.installed).toEqual({ version: '1.0.0', updateAvailable: true });
    let plugins = (await core.rpc.call('plugins.list', undefined)) as { plugins: PluginSummary[] };
    expect(plugins.plugins[0]!.updateAvailable).toEqual({ version: '1.1.0' });

    // 1.1.0 被撤销 → updateAvailable 回落 null（1.0.0 未被撤销）。
    market.publish({
      base: OFFICIAL_BASE,
      key: officialKey,
      generatedAt: T3,
      entries: [entryV1, entryV2],
      revoked: [{ id: v1.id, version: '1.1.0', action: 'warn' }],
    });
    await refresh(stack);
    list = await marketList(stack);
    expect(list.entries[0]!.installed).toEqual({ version: '1.0.0', updateAvailable: false });
    plugins = (await core.rpc.call('plugins.list', undefined)) as { plugins: PluginSummary[] };
    expect(plugins.plugins[0]!.updateAvailable).toBeNull();
  }, 90_000);

  it('自建端点：无公钥关闭；登记公钥后用自己的密钥、封顶 community；切回官方后旧实例停止', async () => {
    const { stack, market, officialKey, customKey } = await setup();
    const { core } = stack;

    // 无公钥 → no_custom_key。
    await core.rpc.call('settings.update', { pluginMarketplaceUrl: CUSTOM_BASE });
    let list = await marketList(stack);
    expect(list.status).toMatchObject({ state: 'disabled', disabledReason: 'no_custom_key', endpoint: 'custom' });

    // 官方公钥签的索引被自建端点拒绝（unknown_key：官方 keyId 未登记）。
    const pkg = await makePackage({ id: 'io.self/demo', version: '1.0.0' });
    market.servePackage(CUSTOM_BASE, pkg);
    const entry = pluginIndexEntryFor(
      { path: pkg.path, sha256: pkg.sha256, size: pkg.size, manifest: { id: pkg.id, version: pkg.version } as never },
      { downloadUrl: `${CUSTOM_BASE}/${pkg.sha256}.kepcup` },
    );
    market.publish({ base: CUSTOM_BASE, key: officialKey, generatedAt: T1, entries: [entry] });
    await core.rpc.call('settings.update', {
      pluginMarketplaceUrl: CUSTOM_BASE,
      pluginMarketplacePublicKey: customKey.publicEntry.publicKey,
    });
    expect((await refresh(stack)).status).toMatchObject({ state: 'degraded', endpoint: 'custom' });
    expect((await marketList(stack)).entries).toEqual([]);

    // 自建密钥签的索引可用；条目封顶 community。
    market.publish({ base: CUSTOM_BASE, key: customKey, generatedAt: T1, entries: [entry] });
    expect((await refresh(stack)).status.state).toBe('ok');
    list = await marketList(stack);
    expect(list.entries[0]).toMatchObject({ id: pkg.id, tier: 'community' });

    // 自建来源安装：marketplace 列 = 自建 URL。
    const inspect = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'marketplace', id: pkg.id },
    })) as PluginInspectOutput;
    const install = (await core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: pkg.id },
      sha256: inspect.packageSha256,
      userConfig: {},
    })) as { plugin: PluginSummary };
    expect(install.plugin).toMatchObject({
      origin: 'marketplace',
      tier: 'community',
      marketplace: CUSTOM_BASE,
    });

    // 切回官方：current() 换成官方实例，旧的自建实例停止（不再被 current() 返回）。
    const customSync = core.services.marketplace!.current()!;
    await core.rpc.call('settings.update', { pluginMarketplaceUrl: '' });
    const official = core.services.marketplace!.current()!;
    expect(official.endpoint).toBe('official');
    expect(official).not.toBe(customSync);
  }, 90_000);

  it('远程端点可以走 marketplace 来源但不能走 file 来源', async () => {
    const { stack, market, officialKey } = await setup();
    const pkg = await makePackage({ id: 'io.remote/demo', version: '1.0.0' });
    market.servePackage(OFFICIAL_BASE, pkg);
    const entry = pluginIndexEntryFor(
      { path: pkg.path, sha256: pkg.sha256, size: pkg.size, manifest: { id: pkg.id, version: pkg.version } as never },
      { downloadUrl: `${OFFICIAL_BASE}/${pkg.sha256}.kepcup` },
    );
    market.publish({ base: OFFICIAL_BASE, key: officialKey, generatedAt: T1, entries: [entry] });
    await refresh(stack);
    const methods = bindPluginsMethods(stack.core.services);
    const inspect = methods['plugins.inspect']!;
    // file 来源在远程端点被拒（P0a 行为回归）。
    await expect(
      withRemoteSource('dev_x' as never, () =>
        inspect.handle({ source: { kind: 'file', path: pkg.path } }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // marketplace 来源经 core 下载，远程端点允许（同来源在本地端点也正常）。
    const remote = (await withRemoteSource('dev_x' as never, () =>
      inspect.handle({ source: { kind: 'marketplace', id: pkg.id } }),
    )) as PluginInspectOutput;
    expect(remote).toMatchObject({ origin: 'marketplace', installable: true });
  }, 60_000);

  it('pluginAutoCheckUpdates=false：定时不拉取，手动 refresh 仍拉取', async () => {
    // 先把索引发布好再起 stack：initialDelay 只有 10ms，首跳不能吃 404（否则定时器按
    // 重试间隔退避，测试就观察不到恢复后的自动拉取）。
    const market = new Market();
    const officialKey = makeMarketKey('official-test');
    const pkg = await makePackage({ id: 'io.official/cadence', version: '1.0.0' });
    market.servePackage(OFFICIAL_BASE, pkg);
    market.publish({
      base: OFFICIAL_BASE,
      key: officialKey,
      generatedAt: T1,
      entries: [
        pluginIndexEntryFor(
          { path: pkg.path, sha256: pkg.sha256, size: pkg.size, manifest: { id: pkg.id, version: pkg.version } as never },
          { downloadUrl: `${OFFICIAL_BASE}/${pkg.sha256}.kepcup` },
        ),
      ],
    });
    // 索引在 stack 启动前发布好（initialDelay 只有 10ms，首跳不能吃 404 / 坏签名——否则
    // 定时器按重试间隔退避，观察不到恢复后的自动拉取）。
    const { stack } = await setup({
      officialKey,
      intervalMs: 10,
      initialDelayMs: 10,
      fetch: market.fetch,
    });
    const { core } = stack;

    // 关掉自动检查（core 启动后定时器已在跑，先让在途的一跳结束再取基线）。
    await core.rpc.call('settings.update', { pluginAutoCheckUpdates: false });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const baseline = market.indexRequests;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(market.indexRequests).toBe(baseline); // 定时循环在跑但不拉取

    // 手动 refresh 不看开关。
    await refresh(stack);
    const pullsManual = market.indexRequests;
    expect(pullsManual).toBeGreaterThan(baseline);

    // 重新打开：定时恢复（CI 负载下计时器可能延迟，轮询而不是睡死等）。
    await core.rpc.call('settings.update', { pluginAutoCheckUpdates: true });
    await vi.waitFor(
      () => {
        expect(market.indexRequests).toBeGreaterThan(pullsManual);
      },
      { timeout: 5_000, interval: 50 },
    );
  }, 60_000);
});
