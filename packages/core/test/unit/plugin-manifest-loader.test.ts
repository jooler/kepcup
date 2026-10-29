import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, type PluginManifest } from '@kepcup/shared';
import {
  checkPluginCompatibility,
  parsePluginManifestText,
  verifyContributionFiles,
} from '../../src/plugins/manifest-loader.js';

/**
 * 清单装载（D104 P0a-1 步骤 6）：字节预算、JSON / format_version 门槛、strict schema、
 * 平台与 engines 兼容（0.0.0 核心 = 开发 / 测试，跳过）、解包树上的贡献文件校验
 * （缺失 / 类型不对 / 符号链接 / realpath 逃逸）。
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'plugin-manifest-loader-'));
  dirs.push(dir);
  return dir;
}

const manifestText = JSON.stringify({
  format_version: 1,
  id: 'io.github.alice/doc-tools',
  name: '文档工具集',
  version: '1.2.0',
  contributions: { skills: [{ dir: 'skills/docx' }] },
});

function expectCodeSync(fn: () => unknown, code: string, match?: RegExp): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    if (match !== undefined) expect((error as AppError).message).toMatch(match);
  }
}

async function expectCode(promise: Promise<unknown>, code: string, match?: RegExp): Promise<void> {
  await promise.then(
    () => expect.unreachable(),
    (error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
      if (match !== undefined) expect((error as AppError).message).toMatch(match);
    },
  );
}

describe('parsePluginManifestText', () => {
  it('accepts a valid manifest', () => {
    const manifest = parsePluginManifestText(manifestText);
    expect(manifest.id).toBe('io.github.alice/doc-tools');
    expect(manifest.contributions.skills).toEqual([{ dir: 'skills/docx' }]);
  });

  it('rejects an oversized manifest before parsing', () => {
    const padding = 'x'.repeat(70 * 1024);
    expectCodeSync(
      () => parsePluginManifestText(`{"format_version":1,"pad":"${padding}"}`),
      'PLUGIN_INVALID',
      /上限/,
    );
  });

  it('rejects non-JSON text without echoing it', () => {
    try {
      parsePluginManifestText('{secret-token not json');
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).code).toBe('PLUGIN_INVALID');
      expect((error as AppError).message).not.toContain('secret-token');
    }
  });

  it('reports a newer format_version as PLUGIN_INCOMPATIBLE', () => {
    const text = JSON.stringify({ ...JSON.parse(manifestText), format_version: 2 });
    expectCodeSync(() => parsePluginManifestText(text), 'PLUGIN_INCOMPATIBLE', /更新版本的 KepCup/);
  });

  it('maps an unknown instance kind to PLUGIN_UPGRADE_REQUIRED but garbage stays PLUGIN_INVALID', () => {
    const withKind = JSON.stringify({
      ...JSON.parse(manifestText),
      instances: ['sms'],
    });
    expect(() => parsePluginManifestText(withKind)).toThrowError(
      expect.objectContaining({ code: 'PLUGIN_UPGRADE_REQUIRED' }),
    );
    const withGarbage = JSON.stringify({
      ...JSON.parse(manifestText),
      instances: [5],
    });
    expect(() => parsePluginManifestText(withGarbage)).toThrowError(
      expect.objectContaining({ code: 'PLUGIN_INVALID' }),
    );
  });

  it('rejects unknown fields as an upgrade prompt with the offending paths', () => {
    const text = JSON.stringify({
      ...JSON.parse(manifestText),
      tier: 'verified',
      categories: ['x'],
      permissions: ['fs'],
      oneMore: true,
    });
    try {
      parsePluginManifestText(text);
      expect.unreachable();
    } catch (error) {
      // D105 可加性契约：未知字段来自更新版本的 KepCup → 提示升级而非「包无效」。
      expect((error as AppError).code).toBe('PLUGIN_UPGRADE_REQUIRED');
      expect((error as AppError).message).toMatch(/tier/);
    }
  });
});

describe('checkPluginCompatibility', () => {
  const base = parsePluginManifestText(manifestText);

  it('rejects a platform list that misses the current platform', () => {
    const manifest = { ...base, platforms: ['win32'] } as unknown as PluginManifest;
    expectCodeSync(
      () => checkPluginCompatibility(manifest, { appVersion: '0.4.1', platform: 'darwin' }),
      'PLUGIN_INCOMPATIBLE',
      /win32.*darwin/,
    );
  });

  it('accepts a platform list containing the current platform', () => {
    const manifest = { ...base, platforms: ['darwin', 'win32'] } as unknown as PluginManifest;
    expect(() =>
      checkPluginCompatibility(manifest, { appVersion: '0.4.1', platform: 'darwin' }),
    ).not.toThrow();
  });

  it('enforces engines.kepcup against the app version', () => {
    const manifest = {
      ...base,
      engines: { kepcup: '>=999.0.0' },
    } as unknown as PluginManifest;
    expectCodeSync(
      () => checkPluginCompatibility(manifest, { appVersion: '0.4.1', platform: 'darwin' }),
      'PLUGIN_INCOMPATIBLE',
      /需要 KepCup >=999\.0\.0，当前 0\.4\.1/,
    );
    const satisfiable = {
      ...base,
      engines: { kepcup: '>=0.4.0' },
    } as unknown as PluginManifest;
    expect(() =>
      checkPluginCompatibility(satisfiable, { appVersion: '0.4.1', platform: 'darwin' }),
    ).not.toThrow();
  });

  it('skips the engines check for the 0.0.0 dev / test core version', () => {
    const manifest = {
      ...base,
      engines: { kepcup: '>=999.0.0' },
    } as unknown as PluginManifest;
    expect(() =>
      checkPluginCompatibility(manifest, { appVersion: '0.0.0-test', platform: 'darwin' }),
    ).not.toThrow();
    expect(() =>
      checkPluginCompatibility(manifest, { appVersion: '0.0.0', platform: 'darwin' }),
    ).not.toThrow();
  });
});

describe('verifyContributionFiles', () => {
  async function writeLayout(dir: string, layout: Record<string, string>): Promise<void> {
    for (const [relative, data] of Object.entries(layout)) {
      const target = path.join(dir, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
    }
  }

  const manifest = parsePluginManifestText(
    JSON.stringify({
      format_version: 1,
      id: 'io.github.alice/doc-tools',
      name: 'x',
      version: '1.0.0',
      contributions: {
        skills: [{ dir: 'skills/docx' }],
        connectors: [{ file: 'connectors/notion/server.json' }],
        mcp: [{ kind: 'mcpb', id: 'db', file: 'mcp/db.mcpb' }],
      },
    }),
  );

  const layout: Record<string, string> = {
    'skills/docx/SKILL.md': '---\nname: docx\n---\n# docx\n',
    'connectors/notion/server.json': '{}',
    'mcp/db.mcpb': 'PK-binary-ish',
  };

  it('passes on a complete tree', async () => {
    const dir = await tmp();
    await writeLayout(dir, layout);
    await expect(verifyContributionFiles(manifest, dir)).resolves.toBeUndefined();
  });

  it('rejects a missing contribution file', async () => {
    const dir = await tmp();
    await writeLayout(dir, layout);
    await rm(path.join(dir, 'mcp', 'db.mcpb'));
    await expectCode(verifyContributionFiles(manifest, dir), 'PLUGIN_INVALID', /mcp\/db\.mcpb/);
  });

  it('rejects a directory where a file is declared', async () => {
    const dir = await tmp();
    await writeLayout(dir, layout);
    await rm(path.join(dir, 'connectors', 'notion', 'server.json'));
    await mkdir(path.join(dir, 'connectors', 'notion', 'server.json'));
    await expectCode(
      verifyContributionFiles(manifest, dir),
      'PLUGIN_INVALID',
      /connectors\/notion\/server\.json/,
    );
  });

  it('rejects a skill dir without SKILL.md', async () => {
    const dir = await tmp();
    await mkdir(path.join(dir, 'skills', 'docx'), { recursive: true });
    await expectCode(verifyContributionFiles(manifest, dir), 'PLUGIN_INVALID', /SKILL\.md/);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked contribution', async () => {
    const dir = await tmp();
    await writeLayout(dir, layout);
    await rm(path.join(dir, 'mcp', 'db.mcpb'));
    await symlink(
      path.join(dir, 'connectors', 'notion', 'server.json'),
      path.join(dir, 'mcp', 'db.mcpb'),
    );
    await expectCode(verifyContributionFiles(manifest, dir), 'PLUGIN_INVALID', /符号链接/);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a realpath escape through a symlinked parent',
    async () => {
      const outside = await tmp();
      const realSkill = path.join(outside, 'real-docx');
      await mkdir(realSkill, { recursive: true });
      await writeFile(path.join(realSkill, 'SKILL.md'), '---\nname: docx\n---\n');
      const dir = await tmp();
      await writeLayout(dir, layout);
      await rm(path.join(dir, 'skills', 'docx'), { recursive: true });
      await symlink(realSkill, path.join(dir, 'skills', 'docx'));
      await expectCode(verifyContributionFiles(manifest, dir), 'PLUGIN_INVALID', /skills\/docx/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a contribution reached through a symlinked ancestor (realpath containment)',
    async () => {
      // The symlink sits above the contribution itself: lstat(`skills/docx`) sees a real
      // directory, so only the realpath containment check can catch the escape.
      const outside = await tmp();
      const realSkills = path.join(outside, 'real-skills');
      await mkdir(path.join(realSkills, 'docx'), { recursive: true });
      await writeFile(path.join(realSkills, 'docx', 'SKILL.md'), '---\nname: docx\n---\n');
      const dir = await tmp();
      await writeLayout(dir, layout);
      await rm(path.join(dir, 'skills'), { recursive: true });
      await symlink(realSkills, path.join(dir, 'skills'));
      await expectCode(
        verifyContributionFiles(manifest, dir),
        'PLUGIN_INVALID',
        /越界（符号链接逃逸）：skills\/docx/,
      );
    },
  );
});
