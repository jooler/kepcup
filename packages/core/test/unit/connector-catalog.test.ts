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
  filterReleasedConnectors,
  HIDDEN_CONNECTOR_SLUGS,
  isHiddenConnectorId,
  findConnectorBySlug,
  type ConnectorCatalogEntry,
} from '@kepcup/shared';
import {
  ConnectorCatalog,
  connectorReleaseGates,
  effectiveConnectorCatalog,
  parseConnectorEntries,
} from '../../src/apps/catalog.js';
import { BuiltinPlugins } from '../../src/plugins/builtin.js';
import { buildBuiltinPluginsDir } from '@kepcup/testkit';
import { runConnectorCatalogContract } from '../contract/connector-catalog.contract.js';
import { SHIPPED_PLUGINS_DIR, readShippedConnectorEntries } from '../support/shipped-connectors.js';

/**
 * 连接应用目录（D73 P1 §5.2）：契约（内置目录 + 一个纯数据新增的条目）、
 * `filterReleasedConnectors` fail-closed、schema 反例与运行时加载。
 * 打包快照来源是内置插件 com.kepcup/connections（D104 P0b）。
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
        releaseGate: slug,
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
    const gates = JSON.parse(
      readFileSync(path.join(repoRoot, 'apps/desktop/connector-release-gates.json'), 'utf8'),
    ) as { approved: unknown };
    expect(Array.isArray(gates.approved)).toBe(true);
    const approved = gates.approved as string[];
    expect(approved.every((gate) => typeof gate === 'string')).toBe(true);
    expect(approved).not.toContain('testkit');
    // Opening a gate is a deliberate act (after the user's login testing, U2): every approved
    // gate must name an existing entry, so a typo cannot silently approve nothing.
    const known = shipped.map(
      (c) => connectorMetaOf(connectorCatalogEntrySchema.parse(c)).releaseGate,
    );
    for (const gate of approved) expect(known).toContain(gate);
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

// --- filterReleasedConnectors (fail-closed) -----------------------------------------------

describe('filterReleasedConnectors', () => {
  const a = connectorCatalogEntrySchema.parse(sample('alpha'));
  const b = connectorCatalogEntrySchema.parse(sample('beta'));
  const catalog = [a, b];

  it('drops hidden entries in every build, even with null gates (dev)', () => {
    const raw = sample('gamma') as { _meta: Record<string, Record<string, unknown>> };
    raw._meta[CONNECTOR_META_KEY]!.hidden = true;
    const hidden = connectorCatalogEntrySchema.parse(raw);
    expect(connectorMetaOf(hidden).hidden).toBe(true);
    expect(connectorMetaOf(a).hidden).toBeUndefined();
    expect(filterReleasedConnectors([a, hidden], null)).toEqual([a]);
    expect(filterReleasedConnectors([a, hidden], ['alpha', 'gamma'])).toEqual([a]);
  });

  it('shipped Google entries are parked as hidden (code kept)', () => {
    const google = shipped
      .map((c) => connectorMetaOf(connectorCatalogEntrySchema.parse(c)))
      .filter((m) => m.slug === 'gcalendar' || m.slug === 'gdrive');
    expect(google.map((m) => m.slug)).toEqual(['gcalendar', 'gdrive']);
    expect(google.every((m) => m.hidden)).toBe(true);
    // 渲染端兜底常量必须与 catalog.json 的 hidden 条目对齐。
    expect([...HIDDEN_CONNECTOR_SLUGS].sort()).toEqual(['gcalendar', 'gdrive']);
    expect(google.every((m) => isHiddenConnectorId(m.slug))).toBe(true);
  });

  it('null gates = no filtering (dev/test builds), returns a copy', () => {
    const out = filterReleasedConnectors(catalog, null);
    expect(out).toEqual(catalog);
    expect(out).not.toBe(catalog);
  });

  it('keeps only approved gates; empty approval list = nothing', () => {
    expect(filterReleasedConnectors(catalog, ['beta'])).toEqual([b]);
    expect(filterReleasedConnectors(catalog, [])).toEqual([]);
    expect(filterReleasedConnectors(catalog, ['unknown'])).toEqual([]);
  });

  it('fails closed for entries without a (valid) releaseGate', () => {
    const noGate = structuredClone(a) as unknown as {
      _meta: Record<string, Record<string, unknown>>;
    };
    delete noGate._meta[CONNECTOR_META_KEY]!.releaseGate;
    const emptyGate = structuredClone(a) as unknown as {
      _meta: Record<string, Record<string, unknown>>;
    };
    emptyGate._meta[CONNECTOR_META_KEY]!.releaseGate = '';
    const noMeta = { ...structuredClone(a), _meta: {} } as unknown as ConnectorCatalogEntry;
    const entries = [noGate, emptyGate, noMeta] as unknown as ConnectorCatalogEntry[];
    expect(filterReleasedConnectors(entries, ['', 'alpha', 'undefined'])).toEqual([]);
  });

  it('matches by gate, not by slug', () => {
    const gated = connectorCatalogEntrySchema.parse(sample('gamma', {}, { releaseGate: 'g-1' }));
    expect(filterReleasedConnectors([gated], ['gamma'])).toEqual([]);
    expect(filterReleasedConnectors([gated], ['g-1'])).toEqual([gated]);
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
    expect(ok(sample('alpha', {}, { releaseGate: '' }))).toBe(false);
  });

  it('requires releaseGate and the kepcup extension', () => {
    const noGate = sample('alpha');
    delete (noGate._meta[CONNECTOR_META_KEY] as Record<string, unknown>).releaseGate;
    expect(ok(noGate)).toBe(false);
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

  it('loads the shipped builtin plugin from the repo checkout and applies injected gates', () => {
    const all = effectiveConnectorCatalog({ source: shippedSource(), approvedGates: null });
    // 目录顺序 = plugins/ 下的 slug 排序（商店化后每插件一目录）。
    expect(all.map((entry) => connectorMetaOf(entry).slug)).toEqual([
      'atlassian',
      'canva',
      'cloudflare',
      'linear',
      'notion',
      'sentry',
      'stripe',
    ]);
    const some = new ConnectorCatalog({
      source: shippedSource(),
      approvedGates: ['linear', 'stripe'],
    });
    expect(some.list().map((entry) => connectorMetaOf(entry).slug)).toEqual(['linear', 'stripe']);
    expect(some.get('linear')?.name).toBe('app.linear/linear');
    expect(some.get('notion')).toBeNull();
    expect(new ConnectorCatalog({ source: shippedSource(), approvedGates: [] }).list()).toEqual([]);
  });

  it('dev/test builds (constant undefined) do not filter; an injected constant does', () => {
    expect(connectorReleaseGates()).toBeNull();
    expect(new ConnectorCatalog({ source: shippedSource() }).list()).toHaveLength(7);
    vi.stubGlobal('__KEPCUP_CONNECTOR_RELEASE_GATES__', []);
    expect(connectorReleaseGates()).toEqual([]);
    expect(new ConnectorCatalog({ source: shippedSource() }).list()).toEqual([]);
    vi.stubGlobal('__KEPCUP_CONNECTOR_RELEASE_GATES__', ['notion']);
    expect(new ConnectorCatalog({ source: shippedSource() }).list().map((e) => e.name)).toEqual([
      'com.notion/mcp',
    ]);
    // An explicit null from the caller still wins (tests that need everything).
    expect(
      new ConnectorCatalog({ source: shippedSource(), approvedGates: null }).list(),
    ).toHaveLength(7);
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

  it('merges extra entries (first slug wins) and gates them too', () => {
    const extra = connectorCatalogEntrySchema.parse(sample('zeta'));
    const dupe = connectorCatalogEntrySchema.parse(sample('alpha', { name: 'com.dupe/mcp' }));
    const source = { entries: [sample('alpha')], iconsDir: null };
    const catalog = new ConnectorCatalog({
      source,
      extra: [extra, dupe],
      approvedGates: ['zeta'],
    });
    expect(catalog.list().map((entry) => entry.name)).toEqual(['com.zeta/mcp']);
    expect(findConnectorBySlug(catalog.list(), 'zeta')).not.toBeNull();
    const open = new ConnectorCatalog({
      source,
      extra: [extra, dupe],
      approvedGates: null,
    });
    expect(open.list().map((entry) => entry.name)).toEqual(['com.alpha/mcp', 'com.zeta/mcp']);
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
    const catalog = new ConnectorCatalog({ source, approvedGates: null });
    // 条目顺序 = plugins/ 的 slug 排序；hidden（gcalendar/gdrive）任何构建都不放出。
    const visibleSlugs = source.entries
      .map((entry) => connectorMetaOf(connectorCatalogEntrySchema.parse(entry)))
      .filter((meta) => meta.hidden !== true)
      .map((meta) => meta.slug);
    expect(catalog.list().map((entry) => connectorMetaOf(entry).slug)).toEqual(visibleSlugs);
    expect(visibleSlugs).not.toContain('gcalendar');
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
