import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTOR_META_KEY,
  connectorCatalogEntrySchema,
  connectorMetaOf,
  connectorRemoteOf,
  findConnectorBySlug,
  type ConnectorCatalogEntry,
} from '@kepcup/shared';
import {
  ConnectorCatalog,
  effectiveConnectorCatalog,
  parseConnectorEntries,
} from '../../src/apps/catalog.js';
import { BuiltinPlugins } from '../../src/plugins/builtin.js';
import { buildBuiltinPluginsDir } from '@kepcup/testkit';
import { runConnectorCatalogContract } from '../contract/connector-catalog.contract.js';
import { SHIPPED_PLUGINS_DIR, readShippedConnectorEntries } from '../support/shipped-connectors.js';

/**
 * 连接应用目录（D73 P1 §5.2）：契约（内置来源 + 一个纯数据新增的条目）、schema 反例与
 * 运行时加载。目录通道已随 D104 商店化移除，来源只有插件贡献 / 本机连接。
 * 契约本身在 `test/contract/connector-catalog.contract.ts`。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const shipped = readShippedConnectorEntries();

/** 经 BuiltinPlugins 读随包内置插件（等价旧的环境变量目录注入）。 */
function shippedSource() {
  return new BuiltinPlugins({
    env: { KEPCUP_BUILTIN_PLUGINS: SHIPPED_PLUGINS_DIR },
    logger: { warn() {}, info() {} },
  }).connectorSource();
}

function sample(
  slug: string,
  overrides: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
) {
  return {
    name: `com.${slug}/mcp`,
    title: slug,
    description: `${slug} test connector`,
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: `https://mcp.${slug}.test/mcp` }],
    _meta: {
      [CONNECTOR_META_KEY]: {
        slug,
        icon: `${slug}.svg`,
        category: 'other',
        tier: 'builtin',
        auth: {
          kind: 'oauth',
          registration: 'auto',
          clientRef: null,
          scopes: { default: [], write: [] },
        },
        toolPolicy: {},
        skills: [],
        ui: false,
        privacyPolicy: `https://${slug}.test/privacy`,
        ...meta,
      },
    },
    ...overrides,
  };
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-connectors-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// --- contract: shipped builtin plugin + a data-only extra catalog --------------------------

runConnectorCatalogContract({
  label: 'shipped builtin plugin (plugins/connector-*)',
  entries: shipped,
  iconsDir: SHIPPED_PLUGINS_DIR,
  iconPaths: shippedSource().iconPaths,
});

{
  // Lives for the whole file (the per-test `tmp()` dirs are removed after each test).
  const iconsDir = mkdtempSync(path.join(tmpdir(), 'kepcup-connector-icons-'));
  afterAll(() => rmSync(iconsDir, { recursive: true, force: true }));
  writeFileSync(path.join(iconsDir, 'extra.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  runConnectorCatalogContract({
    label: 'injected data-only entry',
    entries: [sample('extra')],
    iconsDir,
  });
}

describe('shipped catalog', () => {
  it('has the expected plugin manifest shape and unique gates, all closed in connector-release-gates.json', () => {
    // D104 商店化：目录来源是 plugins/connector-* 独立插件（每个插件恰好一条贡献）。
    const slugs = shipped.map((c) => connectorMetaOf(connectorCatalogEntrySchema.parse(c)).slug);
    expect(slugs).toHaveLength(shipped.length);
    for (const slug of slugs) {
      const manifest = JSON.parse(
        readFileSync(path.join(SHIPPED_PLUGINS_DIR, `connector-${slug}`, 'plugin.json'), 'utf8'),
      ) as { id: string; version: string; contributions: { connectors: Array<{ file: string }> } };
      expect(manifest.id).toBe(`app.kepcup/connector-${slug}`);
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(manifest.contributions.connectors).toEqual([
        { file: `connectors/${slug}/server.json` },
      ]);
      // 每个 server.json 声明都真实存在（shipped 条目即从这些文件读出）。
      expect(
        existsSync(
          path.join(
            SHIPPED_PLUGINS_DIR,
            `connector-${slug}`,
            ...manifest.contributions.connectors[0]!.file.split('/'),
          ),
        ),
      ).toBe(true);
    }
  });

  it('uses auto registration (CIMD/DCR) or the preregistered google client, on streamable-http', () => {
    for (const raw of shipped) {
      const entry = connectorCatalogEntrySchema.parse(raw);
      const { auth } = connectorMetaOf(entry);
      if (auth.registration === 'preregistered') expect(auth.clientRef).toBe('google');
      else expect(auth.registration).toBe('auto');
      expect(connectorRemoteOf(entry)?.type).toBe('streamable-http');
    }
  });
});

// --- schema counter-examples ---------------------------------------------------------------

describe('connectorCatalogEntrySchema', () => {
  const ok = (value: unknown) => connectorCatalogEntrySchema.safeParse(value).success;

  it('accepts a valid entry and defaults optional extension fields', () => {
    const minimal = sample('alpha');
    delete (minimal._meta[CONNECTOR_META_KEY] as Record<string, unknown>).toolPolicy;
    delete (minimal._meta[CONNECTOR_META_KEY] as Record<string, unknown>).skills;
    delete (minimal._meta[CONNECTOR_META_KEY] as Record<string, unknown>).ui;
    const parsed = connectorCatalogEntrySchema.parse(minimal);
    expect(connectorMetaOf(parsed).toolPolicy).toEqual({});
    expect(connectorMetaOf(parsed).ui).toBe(false);
  });

  it.each(['a', 'ab_c', 'Notion', 'x'.repeat(17), 'no-dash', ''])('rejects slug %j', (slug) => {
    expect(ok(sample('alpha', {}, { slug }))).toBe(false);
  });

  it('rejects bad icon paths, tiers, risks and non-url privacy policies', () => {
    expect(ok(sample('alpha', {}, { icon: '../x.svg' }))).toBe(false);
    expect(ok(sample('alpha', {}, { icon: 'a/b.svg' }))).toBe(false);
    expect(ok(sample('alpha', {}, { icon: 'a.exe' }))).toBe(false);
    expect(ok(sample('alpha', {}, { tier: 'trusted' }))).toBe(false);
    expect(ok(sample('alpha', {}, { toolPolicy: { t: { risk: 'safe' } } }))).toBe(false);
    expect(ok(sample('alpha', {}, { toolPolicy: { t: { risk: 'write' } } }))).toBe(true);
    expect(ok(sample('alpha', {}, { privacyPolicy: 'TODO' }))).toBe(false);
  });

  it('requires the kepcup extension', () => {
    expect(ok(sample('alpha', { _meta: {} }))).toBe(false);
  });

  it('requires a clientRef for preregistered auth', () => {
    const pre = (clientRef: string | null) =>
      sample(
        'alpha',
        {},
        {
          auth: {
            kind: 'oauth',
            registration: 'preregistered',
            clientRef,
            scopes: { default: [], write: [] },
          },
        },
      );
    expect(ok(pre(null))).toBe(false);
    expect(ok(pre('github-app'))).toBe(true);
  });

  it('needs remotes or packages, and valid registry names', () => {
    expect(ok(sample('alpha', { remotes: [] }))).toBe(false);
    expect(
      ok(
        sample('alpha', {
          remotes: [],
          packages: [{ registryType: 'mcpb', identifier: 'https://x.test/a.mcpb' }],
        }),
      ),
    ).toBe(true);
    expect(ok(sample('alpha', { name: 'no-namespace' }))).toBe(false);
    expect(ok(sample('alpha', { version: 'latest' }))).toBe(false);
  });

  it('passes foreign _meta namespaces through', () => {
    const entry = sample('alpha');
    (entry._meta as Record<string, unknown>)['io.modelcontextprotocol.registry/official'] = {
      status: 'active',
    };
    const parsed = connectorCatalogEntrySchema.parse(entry);
    expect(parsed._meta['io.modelcontextprotocol.registry/official']).toEqual({ status: 'active' });
  });
});

// --- runtime loader ------------------------------------------------------------------------

describe('ConnectorCatalog (runtime loader)', () => {
  const warnings: unknown[][] = [];
  const logger = { warn: (...args: unknown[]) => void warnings.push(args) };

  it('loads the shipped builtin plugins from the repo checkout', () => {
    const all = effectiveConnectorCatalog({ source: shippedSource() });
    // 目录顺序 = plugins/ 下的 slug 排序（商店化后每插件一目录；gcalendar/gdrive
    // 的 hidden 标记已随门禁机制移除，二者已作为市场首批发布）。
    expect(all.map((entry) => connectorMetaOf(entry).slug)).toEqual([
      'atlassian',
      'canva',
      'cloudflare',
      'gcalendar',
      'gdrive',
      'linear',
      'notion',
      'sentry',
      'stripe',
    ]);
    expect(new ConnectorCatalog({ source: shippedSource() }).list()).toHaveLength(9);
    expect(effectiveConnectorCatalog({ source: shippedSource() }).map((e) => e.name)).toContain(
      'app.linear/linear',
    );
  });

  it('skips broken entries and duplicate slugs with warnings, keeps the rest', () => {
    warnings.length = 0;
    const entries = [
      sample('alpha'),
      { name: 'broken' },
      sample('alpha', { name: 'com.other/mcp' }),
      sample('beta'),
    ];
    const parsed = parseConnectorEntries(entries, logger);
    expect(parsed.map((entry) => connectorMetaOf(entry).slug)).toEqual(['alpha', 'beta']);
    expect(warnings).toHaveLength(2);
  });

  it('merges extra entries (first slug wins)', () => {
    const extra = connectorCatalogEntrySchema.parse(sample('zeta'));
    const dupe = connectorCatalogEntrySchema.parse(sample('alpha', { name: 'com.dupe/mcp' }));
    const source = { entries: [sample('alpha')], iconsDir: null };
    const catalog = new ConnectorCatalog({
      source,
      extra: [extra, dupe],
    });
    expect(catalog.list().map((entry) => entry.name)).toEqual(['com.alpha/mcp', 'com.zeta/mcp']);
    expect(findConnectorBySlug(catalog.list(), 'zeta')).not.toBeNull();
    expect(findConnectorBySlug(catalog.list(), 'alpha')).not.toBeNull();
  });

  it('injects the packaged snapshot via BuiltinPlugins.connectorSource() and tolerates a broken plugin', async () => {
    // 不存在的内置插件目录 → 空来源（等价旧环境变量指向缺失目录）。
    const missing = new BuiltinPlugins({
      env: { KEPCUP_BUILTIN_PLUGINS: path.join(tmp(), 'nope') },
      logger,
    });
    expect(missing.connectorSource()).toEqual({
      entries: [],
      iconsDir: null,
      iconPaths: new Map(),
      owners: new Map(),
    });

    // 坏 plugin.json → 整个插件被跳过（告警），来源为空。
    const broken = tmp();
    await buildBuiltinPluginsDir({ dir: broken, connectors: [sample('alpha')] });
    rmSync(path.join(broken, 'com.kepcup', 'connections', 'plugin.json'));
    writeFileSync(path.join(broken, 'com.kepcup', 'connections', 'plugin.json'), '{not json');
    warnings.length = 0;
    expect(
      new BuiltinPlugins({ env: { KEPCUP_BUILTIN_PLUGINS: broken }, logger }).connectorSource()
        .entries,
    ).toEqual([]);
    expect(warnings.length).toBe(1);

    // 正常注入：条目 + 每条目同目录图标经 iconPaths 供 iconSvg 读取。
    const source = shippedSource();
    const catalog = new ConnectorCatalog({ source });
    // 条目顺序 = plugins/ 的 slug 排序；gcalendar/gdrive 不再 hidden（已随市场首批发布）。
    const visibleSlugs = source.entries
      .map((entry) => connectorMetaOf(connectorCatalogEntrySchema.parse(entry)))
      .map((meta) => meta.slug);
    expect(catalog.list().map((entry) => connectorMetaOf(entry).slug)).toEqual(visibleSlugs);
    expect(visibleSlugs).toContain('gcalendar');
    expect(catalog.iconSvg('notion')).toContain('<svg');
    expect(catalog.iconSvg('missing')).toBeNull();
  });

  it('serves the shipped icons as svg text', () => {
    const catalog = new ConnectorCatalog({ source: shippedSource(), approvedGates: null });
    for (const entry of catalog.list()) {
      expect(catalog.iconSvg(connectorMetaOf(entry).slug)).toMatch(/^<svg /);
    }
  });
});
