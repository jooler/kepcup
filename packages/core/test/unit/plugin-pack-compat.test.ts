import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPluginDir } from '@kepcup/testkit';
import { PluginPackager } from '../../src/plugins/package.js';
import { packPluginDirectory } from '../../../app-validator/src/plugin/pack.js';

/**
 * `kepcup-app pack` output must be accepted by the real installer pipeline (D104 P2 step 5):
 * the archive goes through `PluginPackager.stage({ kind: 'file' })` without a special case.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'plugin-pack-compat-'));
  dirs.push(dir);
  return dir;
}

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

describe('kepcup-app pack → PluginPackager.stage', () => {
  it('stages the packed archive and keeps the contribution tree', async () => {
    const home = await tmp();
    const source = path.join(home, 'demo-plugin');
    const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>';
    await buildPluginDir({
      dir: source,
      skills: [{ name: 'hello' }],
      manifest: {
        author: { name: 'Tester' },
        homepage: 'https://example.com',
        icon: 'icon.svg',
      },
      extraEntries: [{ name: 'icon.svg', data: iconSvg }],
    });
    await writeFile(path.join(source, 'README.md'), '# Demo\n');
    const packed = await packPluginDirectory({
      dir: source,
      out: path.join(home, 'demo.kepcup'),
    });
    const packager = new PluginPackager({
      pluginsDir: path.join(home, 'plugins'),
      logger,
      appVersion: '0.0.0-test',
      platform: 'linux',
    });
    const staged = await packager.stage({ kind: 'file', path: packed.path });
    try {
      expect(staged.manifest.id).toBe('io.github.tester/fixture');
      expect(staged.manifest.contributions.skills).toEqual([{ dir: 'skills/hello' }]);
      expect(existsSync(path.join(staged.stagingDir, 'skills/hello/SKILL.md'))).toBe(true);
      expect(existsSync(path.join(staged.stagingDir, 'plugin.json'))).toBe(true);
    } finally {
      await packager.discard(staged);
    }
  });
});
