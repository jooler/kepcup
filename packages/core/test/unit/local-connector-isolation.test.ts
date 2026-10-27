import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONNECTOR_META_KEY,
  LOCAL_CONNECTOR_ICON,
  connectorCatalogEntrySchema,
  connectorMetaOf,
  localConnectorName,
  localConnectorOrigin,
  localConnectorSlug,
  type ConnectorCatalogEntry,
} from '@kepcup/shared';
import { ConnectorCatalog, buildConnectorCatalog } from '../../src/apps/catalog.js';
import { fakeCatalogEntry } from '../support/catalog-connect-env.js';

/**
 * 本机连接与插件条目的来源隔离（todo/local-connector-authoring.md §4；目录通道已随商店化
 * 移除）：本机条目是独立来源，不能顶替插件条目。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function localEntry(
  url = 'https://mcp.local-example.com/mcp',
  title = 'Local',
): ConnectorCatalogEntry {
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
      },
    },
  });
}

const bundled = (slug: string) => fakeCatalogEntry({ slug, url: `https://mcp.${slug}.test/mcp` });

describe('ConnectorCatalog local() source', () => {
  it('is appended after the builtin/plugin entries and tagged origin=local', () => {
    const local = localEntry();
    const slug = connectorMetaOf(local).slug;
    const catalog = new ConnectorCatalog({
      source: { entries: [bundled('alpha'), bundled('beta')], iconsDir: null },
    });
    catalog.attachLocal({ revision: () => 1, entries: () => [local] });
    expect(catalog.list().map((entry) => connectorMetaOf(entry).slug)).toEqual([
      'alpha',
      'beta',
      slug,
    ]);
    expect(catalog.originOf('alpha')).toBe('plugin');
    expect(catalog.originOf(slug)).toBe('local');
    expect(catalog.isLocal(slug)).toBe(true);
    expect(catalog.isLocal('alpha')).toBe(false);
    expect(catalog.get(slug)).toBe(local);
  });

  it('picks up changes by revision (add / remove) without rebuilding the catalog', () => {
    let revision = 0;
    let entries: ConnectorCatalogEntry[] = [];
    const catalog = new ConnectorCatalog({ source: { entries: [], iconsDir: null } });
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

  it('never shadows an existing entry: a slug or name collision drops the LOCAL one', () => {
    const local = localEntry();
    const meta = connectorMetaOf(local);
    const warnings: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warnings.push(args) };
    // An entry that took the local slug.
    const sameSlug = fakeCatalogEntry({ slug: meta.slug, url: 'https://mcp.other.test/mcp' });
    // An entry that took the local name.
    const sameName = {
      ...fakeCatalogEntry({ slug: 'zeta', url: 'https://mcp.zeta.test/mcp' }),
      name: local.name,
    };
    for (const taken of [sameSlug, sameName]) {
      const result = buildConnectorCatalog({
        logger,
        source: { entries: [taken], iconsDir: null },
        local: [local],
      });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.title).not.toBe('Local');
      expect(result.localSlugs.size).toBe(0);
    }
    expect(warnings.length).toBe(2);
  });

  it('has no icon file: iconSvg is null even when a file with the placeholder name exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lc-icons-'));
    dirs.push(dir);
    writeFileSync(
      path.join(dir, LOCAL_CONNECTOR_ICON),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    const local = localEntry();
    const catalog = new ConnectorCatalog({ source: { entries: [], iconsDir: dir } });
    catalog.attachLocal({ revision: () => 1, entries: () => [local] });
    expect(catalog.iconSvg(connectorMetaOf(local).slug)).toBeNull();
  });
});
