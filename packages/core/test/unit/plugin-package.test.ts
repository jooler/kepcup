import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { buildPluginDir, buildPluginFixture } from '@kepcup/testkit';
import {
  PluginPackager,
  type PluginPackagerDeps,
  type StagedPlugin,
} from '../../src/plugins/package.js';

/**
 * 插件包暂存管线（D104 P0a-1 步骤 7）：file 走私有快照 + zip 防护，folder 走目录遍历
 * 校验 + 复制副本；恶意包 / 恶意目录被拒且不留残渣；树哈希稳定；解包位只保留执行位。
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'plugin-package-'));
  dirs.push(dir);
  return dir;
}

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

async function makePackager(overrides: Partial<PluginPackagerDeps> = {}): Promise<{
  packager: PluginPackager;
  home: string;
  pluginsDir: string;
}> {
  const home = await tmp();
  const pluginsDir = path.join(home, 'plugins');
  return {
    packager: new PluginPackager({
      pluginsDir,
      logger,
      appVersion: '0.0.0-test',
      platform: 'linux',
      ...overrides,
    }),
    home,
    pluginsDir,
  };
}

async function expectCode(promise: Promise<unknown>, code: string, match?: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  if (match !== undefined) expect((error as AppError).message).toMatch(match);
}

const baseOptions = {
  skills: [{ name: 'docx', description: 'Word tools' }, { name: 'xlsx' }],
  connectors: [{ slug: 'notion' }],
  mcpb: [{ id: 'dbtools' }],
};

async function stagingNames(staged: StagedPlugin): Promise<string[]> {
  const walk = async (dir: string, prefix = ''): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), relative)));
      else out.push(relative);
    }
    return out.sort();
  };
  return walk(staged.stagingDir);
}

describe('staging a .kepcup file', () => {
  it('stages a valid package: complete tree, file sha256, snapshot removed', async () => {
    const { packager, pluginsDir } = await makePackager();
    const fixture = await buildPluginFixture({ dir: await tmp(), ...baseOptions });
    const staged = await packager.stage({ kind: 'file', path: fixture.path });
    expect(staged.manifest.id).toBe('io.github.tester/fixture');
    expect(staged.packageSha256).toBe(fixture.sha256);
    expect(staged.sizeBytes).toBe(fixture.size);
    expect(staged.source).toEqual({ kind: 'file', path: fixture.path });
    expect(await stagingNames(staged)).toEqual([
      'connectors/notion/notion.svg',
      'connectors/notion/server.json',
      'mcp/dbtools.mcpb',
      'plugin.json',
      'skills/docx/SKILL.md',
      'skills/xlsx/SKILL.md',
    ]);
    const stagingRoot = path.join(pluginsDir, '.staging');
    const leftovers = (await readdir(stagingRoot)).filter((name) => name.startsWith('.snap-'));
    expect(leftovers).toEqual([]);
    await packager.discard(staged);
  });

  it('rejects hostile entries and leaves nothing behind', async () => {
    const cases: Array<[string, Parameters<typeof buildPluginFixture>[0]['extraEntries']]> = [
      ['slip', [{ name: '../evil.txt', data: 'x' }]],
      ['absolute', [{ name: '/abs', data: 'x' }]],
      ['backslash', [{ name: 'a\\b', data: 'x' }]],
      ['drive', [{ name: 'C:/x', data: 'x' }]],
      ['symlink', [{ name: 'link', data: '/etc/passwd', symlink: true, deflate: false }]],
      ['duplicate', [{ name: 'Skills/Docx/SKILL.md', data: 'dup' }]],
    ];
    for (const [label, extraEntries] of cases) {
      const { packager, home } = await makePackager();
      const fixture = await buildPluginFixture({
        dir: await tmp(),
        fileName: `${label}.kepcup`,
        ...baseOptions,
        extraEntries,
      });
      await expectCode(packager.stage({ kind: 'file', path: fixture.path }), 'PLUGIN_INVALID');
      const stagingRoot = path.join(home, 'plugins', '.staging');
      expect(await readdir(stagingRoot)).toEqual([]);
      expect(existsSync(path.join(home, 'evil.txt'))).toBe(false);
    }
  });

  it('rejects a missing / oversized / invalid / newer / incompatible manifest', async () => {
    const { packager } = await makePackager();
    const dir = await tmp();
    const missing = await buildPluginFixture({
      dir,
      fileName: 'missing.kepcup',
      skills: [{ name: 'a' }],
      omitManifest: true,
    });
    await expectCode(
      packager.stage({ kind: 'file', path: missing.path }),
      'PLUGIN_INVALID',
      /plugin\.json/,
    );
    const oversized = await buildPluginFixture({
      dir,
      fileName: 'oversized.kepcup',
      skills: [{ name: 'a' }],
      rawManifest: JSON.stringify({
        format_version: 1,
        id: 'io.github.tester/fixture',
        name: 'Fixture',
        version: '1.0.0',
        description: 'x'.repeat(70 * 1024),
        contributions: { skills: [{ dir: 'skills/a' }] },
      }),
    });
    await expectCode(
      packager.stage({ kind: 'file', path: oversized.path }),
      'PLUGIN_INVALID',
      /过大|上限/,
    );
    const broken = await buildPluginFixture({
      dir,
      fileName: 'broken.kepcup',
      skills: [{ name: 'a' }],
      rawManifest: '{not json',
    });
    await expectCode(packager.stage({ kind: 'file', path: broken.path }), 'PLUGIN_INVALID');
    const newer = await buildPluginFixture({
      dir,
      fileName: 'newer.kepcup',
      skills: [{ name: 'a' }],
      manifest: { format_version: 2 },
    });
    await expectCode(
      packager.stage({ kind: 'file', path: newer.path }),
      'PLUGIN_INCOMPATIBLE',
      /更新版本的 KepCup/,
    );
    const { packager: linuxPackager } = await makePackager();
    const windowsOnly = await buildPluginFixture({
      dir,
      fileName: 'win.kepcup',
      skills: [{ name: 'a' }],
      manifest: { platforms: ['win32'] },
    });
    await expectCode(
      linuxPackager.stage({ kind: 'file', path: windowsOnly.path }),
      'PLUGIN_INCOMPATIBLE',
      /win32/,
    );
  });

  it('rejects a declared contribution file that is not in the package', async () => {
    const { packager } = await makePackager();
    const fixture = await buildPluginFixture({
      dir: await tmp(),
      skills: [{ name: 'docx' }],
      manifest: {
        contributions: { skills: [{ dir: 'skills/docx' }, { dir: 'skills/ghost' }] },
      },
    });
    await expectCode(
      packager.stage({ kind: 'file', path: fixture.path }),
      'PLUGIN_INVALID',
      /skills\/ghost/,
    );
  });

  it('rejects relative paths and missing files', async () => {
    const { packager } = await makePackager();
    await expectCode(
      packager.stage({ kind: 'file', path: 'relative.kepcup' }),
      'PLUGIN_INVALID',
      /绝对路径/,
    );
    await expectCode(
      packager.stage({ kind: 'file', path: '/nonexistent/pkg.kepcup' }),
      'NOT_FOUND',
    );
  });

  it.skipIf(process.platform === 'win32')('extracts files as 0755 / 0644 only', async () => {
    const { packager } = await makePackager();
    const fixture = await buildPluginFixture({
      dir: await tmp(),
      skills: [{ name: 'docx' }],
      extraEntries: [
        { name: 'data/open.txt', data: 'x', mode: 0o666 },
        { name: 'data/tool.sh', data: 'x', mode: 0o777 },
      ],
    });
    const staged = await packager.stage({ kind: 'file', path: fixture.path });
    expect((await stat(path.join(staged.stagingDir, 'data', 'open.txt'))).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(staged.stagingDir, 'data', 'tool.sh'))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(staged.stagingDir, 'plugin.json'))).mode & 0o777).toBe(0o644);
    await packager.discard(staged);
  });
});

describe('staging a development directory', () => {
  it('stages the same content with a stable tree hash', async () => {
    const { packager } = await makePackager();
    const dir = await tmp();
    await buildPluginDir({ dir, ...baseOptions });
    const first = await packager.stage({ kind: 'folder', path: dir });
    const second = await packager.stage({ kind: 'folder', path: dir });
    expect(first.manifest).toEqual(second.manifest);
    expect(first.packageSha256).toBe(second.packageSha256);
    expect(first.packageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.sizeBytes).toBe(second.sizeBytes);
    expect(first.source).toEqual({ kind: 'folder', path: dir });
    await packager.discard(first);
    await packager.discard(second);
  });

  it('rejects symlinks pointing outside the directory', async () => {
    const { packager } = await makePackager();
    const outside = await tmp();
    const secret = path.join(outside, 'secret.txt');
    await writeFile(secret, 'top secret');
    const dir = await tmp();
    await buildPluginDir({ dir, skills: [{ name: 'docx' }] });
    await symlink(secret, path.join(dir, 'skills', 'docx', 'leak.txt'));
    await expectCode(packager.stage({ kind: 'folder', path: dir }), 'PLUGIN_INVALID', /符号链接/);
  });

  it('uses the staged copy only: later source edits do not leak in', async () => {
    const { packager } = await makePackager();
    const dir = await tmp();
    await buildPluginDir({ dir, skills: [{ name: 'docx' }] });
    const staged = await packager.stage({ kind: 'folder', path: dir });
    const skillFile = path.join(dir, 'skills', 'docx', 'SKILL.md');
    const original = await readFile(skillFile, 'utf8');
    await writeFile(skillFile, '---\nname: tampered\n---\n');
    expect(await readFile(path.join(staged.stagingDir, 'skills', 'docx', 'SKILL.md'), 'utf8')).toBe(
      original,
    );
    await packager.discard(staged);
  });

  it('rejects relative paths and missing directories', async () => {
    const { packager } = await makePackager();
    await expectCode(
      packager.stage({ kind: 'folder', path: 'relative/dir' }),
      'PLUGIN_INVALID',
      /绝对路径/,
    );
    await expectCode(packager.stage({ kind: 'folder', path: '/nonexistent/dir' }), 'NOT_FOUND');
  });

  it.skipIf(process.platform === 'win32')(
    'copies keep the mode rule (no group/world bits)',
    async () => {
      const { packager } = await makePackager();
      const dir = await tmp();
      await buildPluginDir({ dir, skills: [{ name: 'docx' }] });
      await chmod(path.join(dir, 'skills', 'docx', 'SKILL.md'), 0o666);
      const staged = await packager.stage({ kind: 'folder', path: dir });
      expect(
        (await stat(path.join(staged.stagingDir, 'skills', 'docx', 'SKILL.md'))).mode & 0o777,
      ).toBe(0o644);
      await packager.discard(staged);
    },
  );
});

describe('discard / sweepStaging', () => {
  it('discard is idempotent and sweepStaging empties the staging root', async () => {
    const { packager, pluginsDir } = await makePackager();
    const fixture = await buildPluginFixture({ dir: await tmp(), skills: [{ name: 'docx' }] });
    const staged = await packager.stage({ kind: 'file', path: fixture.path });
    expect(existsSync(staged.stagingDir)).toBe(true);
    await packager.discard(staged);
    await packager.discard(staged);
    expect(existsSync(staged.stagingDir)).toBe(false);

    const stagingRoot = path.join(pluginsDir, '.staging');
    const junk = path.join(stagingRoot, 'junk-dir');
    await mkdir(junk, { recursive: true });
    await writeFile(path.join(junk, 'leftover.txt'), 'stale');
    await packager.sweepStaging();
    expect(existsSync(stagingRoot)).toBe(false);
  });
});
