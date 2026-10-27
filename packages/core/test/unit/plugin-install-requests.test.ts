import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPluginFixture } from '@kepcup/testkit';
import { PluginInstallRequests } from '../../src/plugins/install-requests.js';
import { MarketplaceSync } from '../../src/plugins/marketplace-sync.js';
import {
  buildPluginIndex,
  makeMarketKey,
  memoryMarketFetch,
  pluginIndexEntryFor,
} from '@kepcup/testkit';

/**
 * PluginInstallRequests（D104 P1-3 步骤 2）：Bot 只能提议官方市场里 verified 级、
 * 兼容、未撤销、未安装的插件；限频先于任何校验（失败也计数）。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const BASE = 'https://market.example.com/plugins/v1';

interface Harness {
  requests: PluginInstallRequests;
  clock: { t: number; now(): number };
  publish(
    entries: Array<Record<string, unknown>>,
    options?: { revoked?: Array<Record<string, unknown>> },
  ): void;
  installed: string[];
  sync: MarketplaceSync;
}

async function harness(options: { endpoint?: 'official' | 'custom' } = {}): Promise<Harness> {
  const indexDir = mkdtempSync(path.join(tmpdir(), 'req-idx-'));
  const packagesDir = mkdtempSync(path.join(tmpdir(), 'req-pkgs-'));
  dirs.push(indexDir, packagesDir);
  const key = makeMarketKey();
  const files = new Map<string, Buffer>();
  const server = memoryMarketFetch(files);
  const clock = { t: NOW, now: () => clock.t };
  const sync = new MarketplaceSync({
    dir: indexDir,
    packagesDir,
    baseUrl: BASE,
    keys: [key.publicEntry],
    endpoint: options.endpoint ?? 'official',
    fetch: server.fetch,
    downloadFetch: server.fetch,
    clock,
    logger: { info() {}, warn() {}, error() {} } as never,
    events: { emit() {} } as never,
  });
  const installed: string[] = [];
  const requests = new PluginInstallRequests({
    marketplace: {
      current: () => sync,
      isOfficial: () => (options.endpoint ?? 'official') === 'official',
    },
    registry: {
      list: () => installed.map((id) => ({ id, version: '1.0.0' })) as never,
    },
    clock,
    appVersion: '0.5.0',
    platform: 'darwin',
  });
  let generated = NOW;
  return {
    requests,
    clock,
    installed,
    sync,
    publish(entries, publishOptions = {}) {
      generated += 1_000;
      const { indexBytes, sig } = buildPluginIndex({
        key,
        generatedAt: generated,
        entries,
        ...(publishOptions.revoked !== undefined ? { revoked: publishOptions.revoked } : {}),
      });
      files.set(`${BASE}/index.json`, indexBytes);
      files.set(`${BASE}/index.json.sig`, Buffer.from(sig, 'utf8'));
      void sync.sync();
    },
  };
}

async function entry(
  overrides: { id?: string; version?: string; tier?: 'verified' | 'community' } = {},
): Promise<Record<string, unknown>> {
  const fixture = await buildPluginFixture({
    dir: mkdtempSync(path.join(tmpdir(), 'req-fixture-')),
    manifest: {
      ...(overrides.id !== undefined ? { id: overrides.id } : {}),
      ...(overrides.version !== undefined ? { version: overrides.version } : {}),
    },
    skills: [{ name: 'demo' }],
  });
  dirs.push(path.dirname(fixture.path));
  return pluginIndexEntryFor(fixture, {
    ...(overrides.tier !== undefined ? { tier: overrides.tier } : {}),
    downloadUrl: `${BASE}/packages/${fixture.sha256}.kepcup`,
    summary: { name: 'Doc Tools', description: 'PDF conversions', author: 'Alice' },
  });
}

const context = { botId: 'bot_1', conversationId: 'conv_1', runId: 'run_1' };

describe('PluginInstallRequests.search', () => {
  it('只返回 verified / 兼容 / 未撤销的条目', async () => {
    const h = await harness();
    // 撤销一条（整 id）：即便 verified 也不该出现。
    h.publish(
      [
        await entry({ id: 'io.github.a/one', tier: 'verified' }),
        await entry({ id: 'io.github.a/two', tier: 'community' }),
        await entry({ id: 'io.github.a/x', tier: 'verified' }),
      ],
      { revoked: [{ id: 'io.github.a/x', action: 'disable' }] },
    );
    await h.sync.sync();
    const hits = h.requests.search('doc');
    expect(hits.map((hit) => hit.id)).toEqual(['io.github.a/one']);
  });

  it('切词匹配 id / 名称 / 描述 / 类别，大小写不敏感', async () => {
    const h = await harness();
    h.publish([await entry({ id: 'io.github.a/one', tier: 'verified' })]);
    await h.sync.sync();
    expect(h.requests.search('DOC')).toHaveLength(1);
    expect(h.requests.search('pdf')).toHaveLength(1);
    expect(h.requests.search('PDF conversions')).toHaveLength(1);
    expect(h.requests.search('pdf nomatch')).toHaveLength(0);
  });

  it('名称与描述经清洗（零宽 / 控制字符不进入结果）', async () => {
    const h = await harness();
    const raw = await entry({ id: 'io.github.a/one', tier: 'verified' });
    raw.summary = {
      name: 'Doc\u200bTools',
      description: 'PDF\u0000 conversions',
      author: 'Alice',
    };
    h.publish([raw]);
    await h.sync.sync();
    const [hit] = h.requests.search('doc');
    expect(hit?.name).toBe('DocTools');
    expect(hit?.description).toBe('PDF conversions');
  });

  it('无 version 的 request 与 search 解析同一个 verified 版本', async () => {
    const h = await harness();
    const v1 = await entry({ id: 'io.github.a/one', version: '1.0.0', tier: 'verified' });
    const v2 = await entry({ id: 'io.github.a/one', version: '2.0.0', tier: 'community' });
    h.publish([v1, v2]);
    await h.sync.sync();
    expect(h.requests.search('doc').map((hit) => hit.version)).toEqual(['1.0.0']);
    const result = h.requests.request({ pluginId: 'io.github.a/one', reason: '需要它' }, context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.requirement.version).toBe('1.0.0');
  });

  it('空查询与市场未启用返回空', async () => {
    const h = await harness();
    h.publish([await entry({ tier: 'verified' })]);
    await h.sync.sync();
    expect(h.requests.search('   ')).toEqual([]);

    const custom = await harness({ endpoint: 'custom' });
    custom.publish([await entry({ tier: 'verified' })]);
    await custom.sync.sync();
    expect(custom.requests.search('doc')).toEqual([]);
  });

  it('最多 10 条', async () => {
    const h = await harness();
    const entries: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 12; index += 1) {
      entries.push(await entry({ id: `io.github.a/p${index}`, tier: 'verified' }));
    }
    h.publish(entries);
    await h.sync.sync();
    expect(h.requests.search('doc')).toHaveLength(10);
  });
});

describe('PluginInstallRequests.request', () => {
  async function setup(
    options: {
      tier?: 'verified' | 'community';
      revoked?: Array<Record<string, unknown>>;
      endpoint?: 'official' | 'custom';
      installed?: string[];
    } = {},
  ): Promise<Harness> {
    const h = await harness({
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    });
    h.publish([await entry({ tier: options.tier ?? 'verified' })], {
      ...(options.revoked !== undefined ? { revoked: options.revoked } : {}),
    });
    await h.sync.sync();
    if (options.installed !== undefined) h.installed.push(...options.installed);
    return h;
  }

  it('成功返回需求（名称与理由清洗）', async () => {
    const h = await setup();
    const result = h.requests.request(
      { pluginId: 'io.github.tester/fixture', reason: '  需要它 <b>转换</b> PDF  ' },
      context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement).toMatchObject({
      kind: 'confirm-plugin-install',
      pluginId: 'io.github.tester/fixture',
      version: '1.0.0',
      name: 'Doc Tools',
    });
    // 控制 / 零宽字符被清洗；尖括号原样保留（卡片按纯文本渲染，与全仓 sanitizeDisplayText 一致）。
    expect(result.requirement.reason).toBe('需要它 <b>转换</b> PDF');
  });

  it('community 级被拒', async () => {
    const h = await setup({ tier: 'community' });
    expect(
      h.requests.request({ pluginId: 'io.github.tester/fixture', reason: 'x' }, context),
    ).toEqual({ ok: false, message: '只有官方认证的插件可以由 Bot 提议安装。' });
  });

  it('不存在 / 已撤销 / 已安装被拒', async () => {
    const h = await setup({ revoked: [{ id: 'io.github.tester/fixture', action: 'disable' }] });
    expect(h.requests.request({ pluginId: 'io.github.none/x', reason: 'x' }, context)).toEqual({
      ok: false,
      message: '官方市场里没有这个插件。',
    });
    expect(
      h.requests.request({ pluginId: 'io.github.tester/fixture', reason: 'x' }, context),
    ).toEqual({ ok: false, message: '该插件版本已被撤销，不能安装。' });

    const installed = await setup();
    installed.installed.push('io.github.tester/fixture');
    expect(
      installed.requests.request({ pluginId: 'io.github.tester/fixture', reason: 'x' }, context),
    ).toEqual({ ok: false, message: '已经安装了该插件，无需再次请求。' });
  });

  it('非官方市场被拒', async () => {
    const h = await setup({ endpoint: 'custom' });
    expect(
      h.requests.request({ pluginId: 'io.github.tester/fixture', reason: 'x' }, context),
    ).toEqual({ ok: false, message: '插件市场未启用，或当前不是官方市场。' });
  });

  it('理由清洗后为空被拒', async () => {
    const h = await setup();
    expect(
      h.requests.request(
        { pluginId: 'io.github.tester/fixture', reason: ' \u200b\u200b  ' },
        context,
      ),
    ).toEqual({ ok: false, message: '请说明为什么需要这个插件（给用户看的一句话）。' });
  });

  it('限频：run 内第 6 次被拒，失败也计数', async () => {
    const h = await setup();
    const request = (reason: string) =>
      h.requests.request({ pluginId: 'io.github.none/x', reason }, context);
    for (let index = 0; index < 5; index += 1) {
      expect(request('missing')).toEqual({
        ok: false,
        message: '官方市场里没有这个插件。',
      });
    }
    expect(request('missing')).toEqual({
      ok: false,
      message: '本次执行已经请求过插件安装，不要再重复请求。',
    });
    // 另一个 run 不受影响。
    expect(
      h.requests.request(
        { pluginId: 'io.github.tester/fixture', reason: 'x' },
        { ...context, runId: 'run_2' },
      ).ok,
    ).toBe(true);
  });

  it('限频：同对话每小时第 21 次被拒，一小时后恢复', async () => {
    const h = await setup();
    for (let index = 0; index < 20; index += 1) {
      h.requests.request(
        { pluginId: 'io.github.none/x', reason: 'x' },
        { ...context, runId: `run_${index}` },
      );
    }
    expect(
      h.requests.request(
        { pluginId: 'io.github.none/x', reason: 'x' },
        { ...context, runId: 'run_21' },
      ),
    ).toEqual({
      ok: false,
      message: '这个对话里插件安装请求太频繁了（每小时有上限），请稍后再试。',
    });
    h.clock.t += 3_601_000;
    expect(
      h.requests.request(
        { pluginId: 'io.github.tester/fixture', reason: 'x' },
        { ...context, runId: 'run_22' },
      ).ok,
    ).toBe(true);
  });
});
