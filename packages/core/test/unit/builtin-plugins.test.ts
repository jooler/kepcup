import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBuiltinPluginsDir, connectorFixtureEntry } from '@kepcup/testkit';

import { BuiltinPlugins, resolveBuiltinPluginsDir } from '../../src/plugins/builtin.js';

/**
 * BuiltinPlugins 加载器（D104 P0b 步骤 2）：目录扫描、清单校验与容错、技能贡献
 * 映射、连接器来源（含图标路径）、只读摘要，以及「每次调用重新读盘」的契约。
 */

const root = mkdtempSync(path.join(tmpdir(), 'builtin-plugins-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const warnings: Array<{ record: Record<string, unknown>; message: string }> = [];
const infos: Array<{ record: Record<string, unknown>; message: string }> = [];
const logger = {
  warn: (record: Record<string, unknown>, message: string) => warnings.push({ record, message }),
  info: (record: Record<string, unknown>, message: string) => infos.push({ record, message }),
};

function freshDir(name: string): string {
  const dir = path.join(root, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('resolveBuiltinPluginsDir', () => {
  it('env override wins and must exist', () => {
    const dir = freshDir('override');
    expect(resolveBuiltinPluginsDir({ KEPCUP_BUILTIN_PLUGINS: dir })).toBe(path.resolve(dir));
    expect(
      resolveBuiltinPluginsDir({ KEPCUP_BUILTIN_PLUGINS: path.join(root, 'nope') }),
    ).toBeNull();
    // 空串视为未设置：走向上查找——随包资源已随商店化移除，仓库检出现在为 null。
    expect(resolveBuiltinPluginsDir({ KEPCUP_BUILTIN_PLUGINS: '' })).toBeNull();
  });
});

describe('BuiltinPlugins.list', () => {
  it('loads nothing without a builtin tree (app ships no builtin plugins)', () => {
    const builtin = new BuiltinPlugins({ env: {}, logger });
    expect(builtin.list()).toEqual([]);
  });

  it('skips unparseable plugin.json, id/directory mismatch and missing contribution files (warn, no throw)', async () => {
    const dir = freshDir('broken');
    await buildBuiltinPluginsDir({ dir, skills: [{ id: 'alpha', description: 'ok' }] });
    // 坏 JSON
    mkdirSync(path.join(dir, 'com.kepcup', 'badjson'), { recursive: true });
    writeFileSync(path.join(dir, 'com.kepcup', 'badjson', 'plugin.json'), '{oops');
    // id 与目录不符
    mkdirSync(path.join(dir, 'com.kepcup', 'mismatch'), { recursive: true });
    writeFileSync(
      path.join(dir, 'com.kepcup', 'mismatch', 'plugin.json'),
      JSON.stringify({
        format_version: 1,
        id: 'com.kepcup/other',
        name: 'Mismatch',
        version: '1.0.0',
        contributions: { skills: [{ dir: 'skills/x' }] },
      }),
    );
    // 清单声明了不存在的贡献目录
    mkdirSync(path.join(dir, 'com.kepcup', 'missing-files'), { recursive: true });
    writeFileSync(
      path.join(dir, 'com.kepcup', 'missing-files', 'plugin.json'),
      JSON.stringify({
        format_version: 1,
        id: 'com.kepcup/missing-files',
        name: 'Missing',
        version: '1.0.0',
        contributions: {
          skills: [
            {
              dir: 'skills/ghost',
              displayName: 'G',
              summary: 's',
              section: 'starter',
              version: '1.0.0',
            },
          ],
        },
      }),
    );

    warnings.length = 0;
    const builtin = new BuiltinPlugins({ env: { KEPCUP_BUILTIN_PLUGINS: dir }, logger });
    const ids = builtin.list().map((plugin) => plugin.id);
    expect(ids).toEqual(['com.kepcup/starter-skills']);
    expect(warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('plugin.json rejected'),
        expect.stringContaining('does not match its directory'),
        expect.stringContaining('contribution files incomplete'),
      ]),
    );
  });

  it('tolerates a missing root (empty list) and an unreadable root', () => {
    const missing = new BuiltinPlugins({
      env: { KEPCUP_BUILTIN_PLUGINS: path.join(root, 'does-not-exist') },
      logger,
    });
    expect(missing.list()).toEqual([]);
    expect(missing.dir).toBeNull();

    // 根目录存在但不是目录（readdirSync 失败）：容错为空。
    const filePath = path.join(root, 'builtin-not-a-dir');
    writeFileSync(filePath, 'x');
    const blocked = new BuiltinPlugins({ env: { KEPCUP_BUILTIN_PLUGINS: filePath }, logger });
    expect(blocked.list()).toEqual([]);
  });

  it('re-reads the tree on every call (edits are visible immediately)', async () => {
    const dir = freshDir('reread');
    await buildBuiltinPluginsDir({ dir, skills: [{ id: 'alpha', description: 'v1' }] });
    const builtin = new BuiltinPlugins({ env: { KEPCUP_BUILTIN_PLUGINS: dir }, logger });
    expect(builtin.skillOffers().map((offer) => offer.id)).toEqual(['alpha']);

    // 改清单（加一条）→ 立即可见
    const pluginJson = path.join(dir, 'com.kepcup', 'starter-skills', 'plugin.json');
    const manifest = JSON.parse(readFileSync(pluginJson, 'utf8'));
    manifest.contributions.skills.push({
      dir: 'skills/beta',
      displayName: 'Beta',
      summary: 'beta summary',
      section: 'starter',
      version: '1.0.0',
      tryIt: '',
    });
    writeFileSync(pluginJson, JSON.stringify(manifest));
    mkdirSync(path.join(dir, 'com.kepcup', 'starter-skills', 'skills', 'beta'), {
      recursive: true,
    });
    writeFileSync(
      path.join(dir, 'com.kepcup', 'starter-skills', 'skills', 'beta', 'SKILL.md'),
      '---\nname: beta\ndescription: beta\n---\n# beta\n',
    );
    expect(builtin.skillOffers().map((offer) => offer.id)).toEqual(['alpha', 'beta']);

    // 删掉整个插件 → 立即为空
    rmSync(path.join(dir, 'com.kepcup', 'starter-skills'), { recursive: true, force: true });
    expect(builtin.skillOffers()).toEqual([]);
    expect(builtin.get('com.kepcup/starter-skills')).toBeNull();
  });
});

describe('BuiltinPlugins.skillOffers', () => {
  it('maps display fields onto absolute dirs (vendored / icon / tryIt defaults)', async () => {
    const dir = freshDir('offers');
    await buildBuiltinPluginsDir({
      dir,
      skills: [
        {
          id: 'alpha',
          displayName: 'A',
          summary: 'alpha 摘要',
          section: 'starter',
          version: '1.2.0',
          tryIt: '试试',
        },
        {
          id: 'mineru',
          description: 'upstream',
          skillMd: '---\nname: mineru\ndescription: upstream\n---\n',
        },
      ],
    });
    // vendored 不在 fixture 缺省里，手工补进清单（与随包 mineru 一致）。
    const pluginJson = path.join(dir, 'com.kepcup', 'starter-skills', 'plugin.json');
    const manifest = JSON.parse(readFileSync(pluginJson, 'utf8'));
    manifest.contributions.skills[1]!.vendored = true;
    writeFileSync(pluginJson, JSON.stringify(manifest));

    const builtin = new BuiltinPlugins({ env: { KEPCUP_BUILTIN_PLUGINS: dir }, logger });
    const offers = builtin.skillOffers();
    expect(offers[0]).toEqual({
      id: 'alpha',
      pluginId: 'com.kepcup/starter-skills',
      dir: path.join(dir, 'com.kepcup', 'starter-skills', 'skills', 'alpha'),
      section: 'starter',
      displayName: 'A',
      summary: 'alpha 摘要',
      icon: 'puzzle',
      version: '1.2.0',
      tryIt: '试试',
      vendored: false,
    });
    expect(offers[1]).toEqual(
      expect.objectContaining({ id: 'mineru', vendored: true, icon: 'puzzle', tryIt: '' }),
    );
  });

  it('warns and skips contributions missing required display fields', async () => {
    const dir = freshDir('missing-fields');
    await buildBuiltinPluginsDir({ dir, skills: [{ id: 'alpha' }] });
    const pluginJson = path.join(dir, 'com.kepcup', 'starter-skills', 'plugin.json');
    const manifest = JSON.parse(readFileSync(pluginJson, 'utf8'));
    delete manifest.contributions.skills[0]!.summary;
    writeFileSync(pluginJson, JSON.stringify(manifest));

    warnings.length = 0;
    const builtin = new BuiltinPlugins({ env: { KEPCUP_BUILTIN_PLUGINS: dir }, logger });
    expect(builtin.skillOffers()).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('missing displayName/summary/section/version');
  });
});

describe('BuiltinPlugins.connectorSource', () => {
  it('returns raw entries in plugin.json order with per-slug icon paths', async () => {
    const dir = freshDir('connectors');
    const entry = connectorFixtureEntry('notion', { url: 'https://mcp.notion.test/mcp' });
    await buildBuiltinPluginsDir({ dir, connectors: [entry] });
    const builtin = new BuiltinPlugins({ env: { KEPCUP_BUILTIN_PLUGINS: dir }, logger });
    const source = builtin.connectorSource();
    expect(source.iconsDir).toBeNull();
    expect(source.entries).toEqual([entry]);
    expect(source.iconPaths.get('notion')).toBe(
      path.join(dir, 'com.kepcup', 'connections', 'connectors', 'notion', 'notion.svg'),
    );
    // D105：slug → 归属内置插件 id（目录条目的 pluginId 透传）。
    expect(source.owners.get('notion')).toBe('com.kepcup/connections');

    // 图标缺失：不进 map（条目仍在）。
    rmSync(path.join(dir, 'com.kepcup', 'connections', 'connectors', 'notion', 'notion.svg'));
    const withoutIcon = builtin.connectorSource();
    expect(withoutIcon.entries).toHaveLength(1);
    expect(withoutIcon.iconPaths.has('notion')).toBe(false);
  });

  it('returns an empty source when the connections plugin is absent', () => {
    const dir = freshDir('no-connectors');
    const builtin = new BuiltinPlugins({ env: { KEPCUP_BUILTIN_PLUGINS: dir }, logger });
    expect(builtin.connectorSource()).toEqual({
      entries: [],
      iconsDir: null,
      iconPaths: new Map(),
      owners: new Map(),
    });
  });
});

describe('BuiltinPlugins.summaries', () => {
  it('read-only builtin summaries: origin/tier builtin, installed, enabled, dirPath null', async () => {
    const dir = freshDir('summaries');
    await buildBuiltinPluginsDir({
      dir,
      skills: [{ id: 'alpha' }],
      connectors: [connectorFixtureEntry('notion')],
    });
    const builtin = new BuiltinPlugins({ env: { KEPCUP_BUILTIN_PLUGINS: dir }, logger });
    const summaries = builtin.summaries();
    expect(summaries.map((summary) => summary.id).sort()).toEqual([
      'com.kepcup/connections',
      'com.kepcup/starter-skills',
    ]);
    const skills = summaries.find((summary) => summary.id === 'com.kepcup/starter-skills')!;
    expect(skills).toMatchObject({
      origin: 'builtin',
      tier: 'builtin',
      state: 'installed',
      enabled: true,
      dirPath: null,
      marketplace: null,
      installedAt: null,
      updatedAt: null,
      counts: { skills: 1, connectors: 0, mcp: 0, mail: 0 },
      items: [],
      updateAvailable: null,
    });
    const connectors = summaries.find((summary) => summary.id === 'com.kepcup/connections')!;
    expect(connectors.counts).toMatchObject({ connectors: 1 });
  });
});
