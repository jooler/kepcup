import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONNECTOR_META_KEY,
  LOCAL_CONNECTOR_GATE,
  LOCAL_CONNECTOR_ICON,
  connectorCatalogEntrySchema,
  connectorMetaOf,
  filterReleasedConnectors,
  localConnectorName,
  localConnectorOrigin,
  localConnectorSlug,
  type ConnectorCatalogEntry,
} from '@kepcup/shared';
import { ConnectorCatalog, buildConnectorCatalog } from '../../src/apps/catalog.js';
import { mergeDirectoryEntries } from '../../src/apps/directory-merge.js';
import { fakeCatalogEntry } from '../support/catalog-connect-env.js';
import { SIGN_SCRIPT_PATH } from '../support/directory-fixture.js';

/**
 * 本机连接与发行 / 签名 / 目录的隔离（todo/local-connector-authoring.md §4）：本机条目是独立来源，
 * 不经发行门禁、不进签名脚本输入、不能由远端目录下发，也不能顶替打包 / 远端条目。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function localEntry(url = 'https://mcp.local-example.com/mcp', title = 'Local'): ConnectorCatalogEntry {
  const slug = localConnectorSlug(localConnectorOrigin(url)!);
  return connectorCatalogEntrySchema.parse({
    name: localConnectorName(slug),
    title,
    description: 'd',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url }],
    _meta: {
      [CONNECTOR_META_KEY]: {
        slug,
        icon: LOCAL_CONNECTOR_ICON,
        category: 'other',
        tier: 'developer',
        auth: {
          kind: 'oauth',
          registration: 'auto',
          clientRef: null,
          scopes: { default: [], write: [] },
        },
        toolPolicy: {},
        skills: [],
        ui: false,
        privacyPolicy: 'https://mcp.local-example.com/',
        releaseGate: LOCAL_CONNECTOR_GATE,
      },
    },
  });
}

const bundled = (slug: string, gate = slug) =>
  fakeCatalogEntry({ slug, url: `https://mcp.${slug}.test/mcp`, releaseGate: gate });

describe('ConnectorCatalog local() source', () => {
  it('is appended after the merge, never gate-filtered, and tagged origin=local', () => {
    const local = localEntry();
    const slug = connectorMetaOf(local).slug;
    // Release gates closed: only `approved` bundled entries survive, the local one is unaffected.
    const catalog = new ConnectorCatalog({
      env: {},
      source: { entries: [bundled('alpha'), bundled('beta')], iconsDir: null },
      approvedGates: ['alpha'],
    });
    catalog.attachLocal({ revision: () => 1, entries: () => [local] });
    expect(catalog.list().map((entry) => connectorMetaOf(entry).slug)).toEqual(['alpha', slug]);
    expect(catalog.originOf('alpha')).toBe('bundled');
    expect(catalog.originOf(slug)).toBe('local');
    expect(catalog.isLocal(slug)).toBe(true);
    expect(catalog.isLocal('alpha')).toBe(false);
    expect(catalog.get(slug)).toBe(local);
    // Even with NO gate approved at all (a release build with an empty allow-list) it is there.
    const closed = buildConnectorCatalog({
      env: {},
      source: { entries: [bundled('alpha')], iconsDir: null },
      approvedGates: [],
      local: [local],
    });
    expect(closed.entries).toEqual([local]);
    expect([...closed.localSlugs]).toEqual([slug]);
  });

  it('is a separate source: the release filter alone would not pass it (nothing relies on the gate)', () => {
    const local = localEntry();
    // `releaseGate: local` is not on any allow-list a build ships with.
    expect(filterReleasedConnectors([local], ['alpha', 'beta'])).toEqual([]);
    expect(filterReleasedConnectors([local], [])).toEqual([]);
  });

  it('picks up changes by revision (add / remove) without rebuilding the catalog', () => {
    let revision = 0;
    let entries: ConnectorCatalogEntry[] = [];
    const catalog = new ConnectorCatalog({ env: {}, source: { entries: [], iconsDir: null }, approvedGates: null });
    catalog.attachLocal({ revision: () => revision, entries: () => entries });
    expect(catalog.list()).toEqual([]);
    entries = [localEntry()];
    expect(catalog.list()).toEqual([]); // revision unchanged → cached
    revision = 1;
    expect(catalog.list()).toHaveLength(1);
    entries = [];
    revision = 2;
    expect(catalog.list()).toEqual([]);
  });

  it('never shadows a bundled / remote entry: a slug or name collision drops the LOCAL one', () => {
    const local = localEntry();
    const meta = connectorMetaOf(local);
    const warnings: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warnings.push(args) };
    // A bundled entry that took the local slug.
    const sameSlug = fakeCatalogEntry({ slug: meta.slug, url: 'https://mcp.other.test/mcp' });
    // A remote-only entry that took the local name.
    const sameName = { ...fakeCatalogEntry({ slug: 'zeta', url: 'https://mcp.zeta.test/mcp' }), name: local.name };
    for (const taken of [sameSlug, sameName]) {
      const result = buildConnectorCatalog({
        env: {},
        logger,
        source: { entries: [taken], iconsDir: null },
        approvedGates: null,
        local: [local],
      });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.title).not.toBe('Local');
      expect(result.localSlugs.size).toBe(0);
    }
    expect(warnings.length).toBe(2);
    // The entry hidden by the gate still counts as taken (so it cannot be shadowed once released).
    const gated = buildConnectorCatalog({
      env: {},
      logger,
      source: { entries: [sameSlug], iconsDir: null },
      approvedGates: [],
      local: [local],
    });
    expect(gated.entries).toEqual([]);
  });

  it('has no bundled icon: iconSvg is null even when a file with the placeholder name exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lc-icons-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, LOCAL_CONNECTOR_ICON), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const local = localEntry();
    const catalog = new ConnectorCatalog({ env: {}, source: { entries: [], iconsDir: dir }, approvedGates: null });
    catalog.attachLocal({ revision: () => 1, entries: () => [local] });
    expect(catalog.iconSvg(connectorMetaOf(local).slug)).toBeNull();
  });
});

describe('the signed directory path never carries a local connector', () => {
  it('a signed remote entry cannot use the local namespace or gate (dropped by the merge)', () => {
    const local = localEntry();
    const squatName = { ...bundled('epsilon'), name: 'local.kepcup/lffffffffffff' };
    const squatGate = fakeCatalogEntry({
      slug: 'gamma',
      url: 'https://mcp.gamma.test/mcp',
      tier: 'verified',
      releaseGate: LOCAL_CONNECTOR_GATE,
    });
    const squatNameVerified = fakeCatalogEntry({
      slug: 'delta',
      url: 'https://mcp.delta.test/mcp',
      tier: 'verified',
    });
    squatNameVerified['name'] = local.name;
    const merged = mergeDirectoryEntries(
      [connectorCatalogEntrySchema.parse(bundled('alpha'))],
      [squatGate, squatNameVerified, squatName].map((entry) => connectorCatalogEntrySchema.parse(entry)),
      undefined,
    );
    expect(merged.dropped.map((item) => item.reason)).toEqual([
      'reserved_for_local_connectors',
      'reserved_for_local_connectors',
      'reserved_for_local_connectors',
    ]);
    expect(merged.entries.map((entry) => entry.name)).toEqual(['test.alpha/mcp']);
  });

  it('the signing script reads only the shipped catalog by default, and refuses a local entry in --extra-dir', async () => {
    const script = (await import(/* @vite-ignore */ pathToFileURL(SIGN_SCRIPT_PATH).href)) as {
      collectEntries(input?: { catalog?: string; extraDir?: string }): Array<{ name: string }>;
    };
    // Default inputs = apps/desktop/resources/connectors/catalog.json, byte for byte.
    const shipped = JSON.parse(
      readFileSync(path.join(repoRoot, 'apps/desktop/resources/connectors/catalog.json'), 'utf8'),
    ) as { connectors: Array<{ name: string; _meta: Record<string, { releaseGate?: string }> }> };
    expect(script.collectEntries().map((entry) => entry.name)).toEqual(
      shipped.connectors.map((entry) => entry.name),
    );
    for (const entry of shipped.connectors) {
      expect(entry.name.startsWith('local.kepcup/')).toBe(false);
      expect(entry._meta[CONNECTOR_META_KEY]?.releaseGate).not.toBe(LOCAL_CONNECTOR_GATE);
    }
    // A local record pasted into the extra directory by mistake is refused outright.
    const dir = mkdtempSync(path.join(tmpdir(), 'lc-extra-'));
    dirs.push(dir);
    const extra = path.join(dir, 'extra');
    mkdirSync(extra);
    writeFileSync(path.join(extra, 'oops.json'), JSON.stringify(localEntry()));
    expect(() => script.collectEntries({ extraDir: extra })).toThrow(/local connector/);
    // …even when it hides behind another name but keeps the local gate.
    const renamed = { ...localEntry(), name: 'com.sneaky/mcp' };
    writeFileSync(path.join(extra, 'oops.json'), JSON.stringify(renamed));
    expect(() => script.collectEntries({ extraDir: extra })).toThrow(/local connector/);
  });

  it('nothing under the directory / signing code paths reads settings.apps.localConnectors', () => {
    for (const file of [
      'scripts/sign-connector-index.mjs',
      'packages/core/src/apps/directory-sync.ts',
      'packages/core/src/apps/directory-merge.ts',
    ]) {
      expect(readFileSync(path.join(repoRoot, file), 'utf8'), file).not.toContain('localConnectors');
    }
  });
});
