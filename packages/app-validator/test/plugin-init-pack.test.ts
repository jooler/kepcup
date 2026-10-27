import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZipArchive } from '@kepcup/package-guard';
import { initPluginDirectory } from '../src/plugin/init.js';
import { PluginPackError, packPluginDirectory } from '../src/plugin/pack.js';
import { validatePlugin } from '../src/plugin/validate.js';

/**
 * `kepcup-app init plugin` / `pack` (D104 P2 step 5): the generated skeleton validates, the
 * archive is reproducible and exclusion rules / symlinks / validation errors are enforced.
 */

const dirs: string[] = [];
const ORIGINAL_CWD = process.cwd();

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  process.chdir(ORIGINAL_CWD);
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'app-validator-pack-'));
  dirs.push(dir);
  return dir;
}

async function minimalPlugin(dir: string): Promise<string> {
  await mkdir(path.join(dir, 'skills', 'hello'), { recursive: true });
  await writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      format_version: 1,
      id: 'io.github.tester/demo',
      name: 'Demo',
      version: '1.0.0',
      description: 'A demo plugin',
      author: { name: 'Tester' },
      homepage: 'https://example.com',
      engines: { kepcup: '>=0.4.0' },
      contributions: { skills: [{ dir: 'skills/hello' }] },
    }),
  );
  await writeFile(path.join(dir, 'README.md'), '# Demo\n');
  await writeFile(
    path.join(dir, 'skills', 'hello', 'SKILL.md'),
    '---\nname: hello\ndescription: Says hello\n---\n# Hello\n',
  );
  return dir;
}

async function zipNames(file: string): Promise<string[]> {
  const zip = await ZipArchive.open(file);
  try {
    return zip.entries.map((entry) => entry.name);
  } finally {
    await zip.close();
  }
}

describe('initPluginDirectory', () => {
  it('writes a skeleton that validates with no errors', async () => {
    const dir = path.join(await tmp(), 'demo-plugin');
    const result = await initPluginDirectory({ dir });
    expect(result.id).toBe('io.github.your-name/demo-plugin');
    expect(result.files).toEqual(['plugin.json', 'README.md', 'skills/hello/SKILL.md']);
    const report = await validatePlugin(dir);
    expect(report.checks.filter((check) => check.severity === 'error')).toEqual([]);
    expect(report.checks.some((check) => check.id === 'plugin.manifest-metadata')).toBe(true);
  });

  it('honours --id and --name', async () => {
    const dir = path.join(await tmp(), 'demo');
    await initPluginDirectory({ dir, id: 'io.github.alice/demo-tools', name: 'Alice Tools' });
    const manifest = JSON.parse(await readFile(path.join(dir, 'plugin.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest['id']).toBe('io.github.alice/demo-tools');
    expect(manifest['name']).toBe('Alice Tools');
  });

  it('protects a non-empty directory unless --force is given', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'keep.txt'), 'keep');
    await expect(initPluginDirectory({ dir })).rejects.toThrow(/not empty/);
    await initPluginDirectory({ dir, force: true });
    expect(await readFile(path.join(dir, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await readFile(path.join(dir, 'plugin.json'), 'utf8')).toContain('"format_version": 1');
  });

  it('rejects invalid and reserved ids', async () => {
    const base = await tmp();
    await expect(
      initPluginDirectory({ dir: path.join(base, 'a'), id: 'not-an-id' }),
    ).rejects.toThrow(/not a valid plugin id/);
    await expect(
      initPluginDirectory({ dir: path.join(base, 'b'), id: 'com.kepcup/evil' }),
    ).rejects.toThrow(/reserved/);
  });
});

describe('packPluginDirectory', () => {
  it('is reproducible: two runs and a different creation order give the same sha256', async () => {
    const first = await minimalPlugin(await tmp());
    const a = await packPluginDirectory({ dir: first, out: path.join(await tmp(), 'a.kepcup') });
    const b = await packPluginDirectory({ dir: first, out: path.join(await tmp(), 'b.kepcup') });
    expect(a.sha256).toBe(b.sha256);
    expect(await readFile(a.path)).toEqual(await readFile(b.path));

    const second = await tmp();
    await writeFile(path.join(second, 'README.md'), '# Demo\n');
    const manifest = await readFile(path.join(first, 'plugin.json'));
    const skill = await readFile(path.join(first, 'skills/hello/SKILL.md'));
    await mkdir(path.join(second, 'skills', 'hello'), { recursive: true });
    await writeFile(path.join(second, 'skills/hello/SKILL.md'), skill);
    await writeFile(path.join(second, 'plugin.json'), manifest);
    const c = await packPluginDirectory({ dir: second, out: path.join(await tmp(), 'c.kepcup') });
    expect(c.sha256).toBe(a.sha256);
  });

  it('excludes .git, node_modules, .DS_Store, *.kepcup and .kepcup-ignore paths', async () => {
    const dir = await minimalPlugin(await tmp());
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, '.git', 'config'), 'git');
    await mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(dir, 'node_modules', 'x', 'index.js'), 'x');
    await writeFile(path.join(dir, '.DS_Store'), 'junk');
    await writeFile(path.join(dir, 'old.kepcup'), 'junk');
    await writeFile(path.join(dir, 'secret.txt'), 'secret');
    await mkdir(path.join(dir, 'dist'), { recursive: true });
    await writeFile(path.join(dir, 'dist', 'out.txt'), 'out');
    await writeFile(path.join(dir, '.kepcup-ignore'), '# ignore\nsecret.txt\ndist/\n');
    const result = await packPluginDirectory({ dir, out: path.join(await tmp(), 'out.kepcup') });
    const names = await zipNames(result.path);
    expect(names).toContain('plugin.json');
    expect(names).toContain('skills/hello/SKILL.md');
    for (const name of names) {
      expect(name.startsWith('.git')).toBe(false);
      expect(name.startsWith('node_modules')).toBe(false);
      expect(name.includes('.DS_Store')).toBe(false);
      expect(name.endsWith('.kepcup')).toBe(false);
      expect(name.includes('secret.txt')).toBe(false);
      expect(name.startsWith('dist')).toBe(false);
    }
  });

  it('refuses symbolic links', async () => {
    const dir = await minimalPlugin(await tmp());
    await symlink(path.join(dir, 'README.md'), path.join(dir, 'link.md'));
    const failure = packPluginDirectory({ dir, out: path.join(await tmp(), 'out.kepcup') });
    await expect(failure).rejects.toMatchObject({ report: { exitCode: 1 } });
    const report = await failure.catch((error: PluginPackError) => error.report);
    expect(report?.checks.some((check) => check.id === 'plugin.files-path')).toBe(true);
  });

  it('writes no output when validation fails', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'plugin.json'), '{"format_version":1}');
    const out = path.join(await tmp(), 'out.kepcup');
    await expect(packPluginDirectory({ dir, out })).rejects.toMatchObject({
      report: { exitCode: 1 },
    });
    await expect(readFile(out)).rejects.toThrow();
  });

  it('uses <id with __>-<version>.kepcup by default', async () => {
    const dir = await minimalPlugin(await tmp());
    const cwd = await tmp();
    process.chdir(cwd);
    try {
      const result = await packPluginDirectory({ dir });
      expect(result.path).toBe(
        path.join(await realpath(cwd), 'io.github.tester__demo-1.0.0.kepcup'),
      );
      expect(await zipNames(result.path)).toContain('plugin.json');
    } finally {
      process.chdir(ORIGINAL_CWD);
    }
  });

  it('surfaces the validation report on PluginPackError', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'plugin.json'), '{"format_version":2}');
    await expect(
      packPluginDirectory({ dir, out: path.join(await tmp(), 'out.kepcup') }),
    ).rejects.toBeInstanceOf(PluginPackError);
  });
});
