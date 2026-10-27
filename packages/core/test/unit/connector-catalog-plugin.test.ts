import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { connectorCatalogEntrySchema, connectorMetaOf } from '@kepcup/shared';

import {
  ConnectorCatalog,
  buildConnectorCatalog,
  type PluginConnectorEntry,
} from '../../src/apps/catalog.js';

/**
 * ConnectorCatalog 的插件来源（D104 P0a-2 步骤 6.1）：条目出现在门禁后、本机前；
 * origin='plugin'、isDirectorySourced 为真；与打包 / 远端 / 本机条目冲突时让位；
 * 本机让位于插件；图标读插件自带文件；revision 变化后重建。
 */

const root = mkdtempSync(path.join(tmpdir(), 'catalog-plugin-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const noopLogger = { warn() {} };

function entry(slug: string, options: { name?: string; icon?: string } = {}) {
  return connectorCatalogEntrySchema.parse({
    name: options.name ?? `test.${slug}/mcp`,
    title: `Fake ${slug}`,
    description: `测试应用 ${slug}`,
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: `https://mcp.${slug}.test/mcp` }],
    _meta: {
      'app.kepcup/connector': {
        slug,
        icon: options.icon ?? `${slug}.svg`,
        category: 'productivity',
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
        privacyPolicy: 'https://example.com/privacy',
        releaseGate: 'test',
      },
    },
  });
}

function pluginEntry(
  slug: string,
  options: { pluginId?: string; iconPath?: string | null; name?: string } = {},
): PluginConnectorEntry {
  return {
    entry: entry(slug, { name: options.name }),
    pluginId: options.pluginId ?? 'io.github.tester/plugins',
    iconPath: options.iconPath === undefined ? null : options.iconPath,
  };
}

function makeCatalog(
  options: {
    bundled?: ReturnType<typeof entry>[];
    local?: ReturnType<typeof entry>[];
    remote?: ReturnType<typeof entry>[];
  } = {},
): ConnectorCatalog {
  return new ConnectorCatalog({
    logger: noopLogger,
    source: { entries: options.bundled ?? [], iconsDir: null },
    ...(options.local !== undefined ? { local: options.local } : {}),
    ...(options.remote !== undefined
      ? { directory: { revision: () => 1, entries: () => options.remote! } }
      : {}),
  });
}

describe('buildConnectorCatalog with plugin entries', () => {
  it('plugin entries land after the gate and before local entries', () => {
    const built = buildConnectorCatalog({
      source: { entries: [entry('bundled')], iconsDir: null },
      plugin: [pluginEntry('plugone')],
      local: [entry('localslug')],
    });
    expect(built.entries.map((item) => connectorMetaOf(item).slug)).toEqual([
      'bundled',
      'plugone',
      'localslug',
    ]);
    expect(built.pluginSlugs).toEqual(new Set(['plugone']));
    expect(built.pluginOwners.get('plugone')).toBe('io.github.tester/plugins');
    expect(built.yieldedPluginSlugs).toEqual(new Set());
  });

  it('yields to bundled / remote / already-appended plugin slugs and names', () => {
    const built = buildConnectorCatalog({
      logger: noopLogger,
      source: { entries: [entry('takenglad')], iconsDir: null },
      plugin: [
        pluginEntry('takenglad'),
        pluginEntry('takenname', { name: 'test.takenglad/mcp' }),
        pluginEntry('ok'),
        pluginEntry('secondone', { pluginId: 'io.github.tester/other' }),
        pluginEntry('secondone', { pluginId: 'io.github.tester/another' }),
      ],
    });
    expect(built.entries.map((item) => connectorMetaOf(item).slug)).toEqual([
      'takenglad',
      'ok',
      'secondone',
    ]);
    expect(built.yieldedPluginSlugs).toEqual(new Set(['takenglad', 'takenname', 'secondone']));
    expect(built.pluginOwners.get('secondone')).toBe('io.github.tester/other');
  });

  it('a builtin-source entry still holds its slug against plugin entries', () => {
    const built = buildConnectorCatalog({
      logger: noopLogger,
      source: { entries: [entry('gated')], iconsDir: null },
      plugin: [pluginEntry('gated')],
    });
    expect(built.entries.map((item) => connectorMetaOf(item).slug)).toEqual(['gated']);
    expect(built.yieldedPluginSlugs).toEqual(new Set(['gated']));
  });

  it('local entries yield to plugin entries (slug or name)', () => {
    const built = buildConnectorCatalog({
      logger: noopLogger,
      source: { entries: [], iconsDir: null },
      plugin: [pluginEntry('firstplug'), pluginEntry('nameholder', { name: 'local.holder/mcp' })],
      local: [entry('firstplug'), entry('loser', { name: 'local.holder/mcp' }), entry('winslocal')],
    });
    expect(built.entries.map((item) => connectorMetaOf(item).slug)).toEqual([
      'firstplug',
      'nameholder',
      'winslocal',
    ]);
    expect(built.localSlugs).toEqual(new Set(['winslocal']));
  });
});

describe('ConnectorCatalog.attachPlugins', () => {
  it('exposes plugin entries: origin, isDirectorySourced, isPlugin, pluginIdOf, yielded', () => {
    const catalog = makeCatalog({ bundled: [entry('bundled')] });
    let revision = 0;
    const sourceEntries: PluginConnectorEntry[] = [pluginEntry('plugone')];
    catalog.attachPlugins({ revision: () => revision, entries: () => sourceEntries });

    const slugs = () => catalog.list().map((item) => connectorMetaOf(item).slug);
    expect(slugs()).toEqual(['bundled', 'plugone']);
    expect(catalog.originOf('plugone')).toBe('plugin');
    expect(catalog.originOf('bundled')).toBe('plugin');
    expect(catalog.isPlugin('plugone')).toBe(true);
    expect(catalog.isPlugin('bundled')).toBe(false);
    expect(catalog.isDirectorySourced('plugone')).toBe(true);
    expect(catalog.isDirectorySourced('bundled')).toBe(false);
    expect(catalog.pluginIdOf('plugone')).toBe('io.github.tester/plugins');
    expect(catalog.pluginIdOf('bundled')).toBeNull();
    expect(catalog.yieldedPluginSlugs()).toEqual(new Set());

    // Yield on a later revision: the plugin entry loses to a new remote entry.
    revision += 1;
    sourceEntries.push(pluginEntry('bundled')); // now conflicts with the bundled slug
    expect(slugs()).toEqual(['bundled', 'plugone']);
    expect(catalog.yieldedPluginSlugs()).toEqual(new Set(['bundled']));
    expect(catalog.isPlugin('bundled')).toBe(false);
  });

  it('iconSvg reads the plugin-provided svg and refuses others', () => {
    const iconDir = path.join(root, 'icons-src');
    rmSync(iconDir, { recursive: true, force: true });
    mkdirSync(iconDir, { recursive: true });
    writeFileSync(path.join(iconDir, 'acme.svg'), '<svg>acme</svg>');
    writeFileSync(path.join(iconDir, 'bitmap.png'), 'png-bytes');
    const catalog = makeCatalog();
    catalog.attachPlugins({
      revision: () => 1,
      entries: () => [
        pluginEntry('acme', { iconPath: path.join(iconDir, 'acme.svg') }),
        pluginEntry('bitmap', { iconPath: path.join(iconDir, 'bitmap.png') }),
        pluginEntry('noicon', { iconPath: null }),
      ],
    });
    expect(catalog.iconSvg('acme')).toBe('<svg>acme</svg>');
    expect(catalog.iconSvg('bitmap')).toBeNull(); // not .svg
    expect(catalog.iconSvg('noicon')).toBeNull();
    expect(catalog.iconSvg('missing')).toBeNull();
  });
});
