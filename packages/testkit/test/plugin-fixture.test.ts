import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeEntryPath, ZipArchive } from '@kepcup/package-guard';
import {
  buildPluginDir,
  buildPluginFixture,
  connectorFixtureEntry,
} from '../../testkit/src/plugin-fixture.js';

/**
 * `.kepcup` 夹具（D104 P0a-1 步骤 4）：默认包能被 ZipArchive 打开、条目与清单一致、
 * manifest 删键、恶意 extraEntries 原样存入、目录形态与 zip 内容一致、内嵌 .mcpb 合法。
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'plugin-fixture-'));
  dirs.push(dir);
  return dir;
}

async function entryNames(file: string): Promise<string[]> {
  const zip = await ZipArchive.open(file);
  try {
    return zip.entries.map((entry) => safeEntryPath(entry.name));
  } finally {
    await zip.close();
  }
}

describe('buildPluginFixture', () => {
  it('produces an archive that opens, holds plugin.json and the expected entries', async () => {
    const dir = await tmp();
    const fixture = await buildPluginFixture({
      dir,
      skills: [{ name: 'docx', description: 'Word tools' }],
      connectors: [{ slug: 'notion' }],
      mcpb: [{ id: 'dbtools' }],
      http: [{ id: 'docs', url: 'https://mcp.example.com/mcp' }],
    });
    const names = await entryNames(fixture.path);
    expect(names).toContain('plugin.json');
    expect(names).toEqual(
      expect.arrayContaining([
        'skills/docx/SKILL.md',
        'connectors/notion/server.json',
        'connectors/notion/notion.svg',
        'mcp/dbtools.mcpb',
      ]),
    );
    expect(fixture.path).toBe(path.join(dir, 'io.github.tester__fixture-1.0.0.kepcup'));
    expect(fixture.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.size).toBe((await stat(fixture.path)).size);
    const manifest = fixture.manifest as {
      id: string;
      contributions: {
        skills: Array<{ dir: string }>;
        connectors: Array<{ file: string }>;
        mcp: Array<Record<string, unknown>>;
        mail: unknown[];
      };
    };
    expect(manifest.id).toBe('io.github.tester/fixture');
    expect(manifest.contributions.skills).toEqual([{ dir: 'skills/docx' }]);
    expect(manifest.contributions.connectors).toEqual([{ file: 'connectors/notion/server.json' }]);
    expect(manifest.contributions.mcp).toEqual([
      { kind: 'mcpb', id: 'dbtools', file: 'mcp/dbtools.mcpb' },
      { kind: 'http', id: 'docs', url: 'https://mcp.example.com/mcp' },
    ]);
    // The skill frontmatter description lands in SKILL.md.
    const zip = await ZipArchive.open(fixture.path);
    try {
      const skill = zip.entries.find((entry) => entry.name === 'skills/docx/SKILL.md')!;
      const text = (await zip.read(skill)).toString('utf8');
      expect(text).toContain('name: docx');
      expect(text).toContain('description: Word tools');
    } finally {
      await zip.close();
    }
  });

  it('removes manifest keys patched with null', async () => {
    const fixture = await buildPluginFixture({
      dir: await tmp(),
      skills: [{ name: 'a' }],
      manifest: { name: null, description: null },
    });
    expect(fixture.manifest).not.toHaveProperty('name');
    expect(fixture.manifest).not.toHaveProperty('description');
    const zip = await ZipArchive.open(fixture.path);
    try {
      const entry = zip.entries.find((item) => item.name === 'plugin.json')!;
      const written = JSON.parse((await zip.read(entry)).toString('utf8')) as Record<
        string,
        unknown
      >;
      expect(written).not.toHaveProperty('name');
      expect(written).not.toHaveProperty('description');
    } finally {
      await zip.close();
    }
  });

  it('stores hostile extraEntries verbatim', async () => {
    const bytes = await buildPluginFixture({
      dir: await tmp(),
      skills: [{ name: 'a' }],
      extraEntries: [
        { name: '../evil.txt', data: 'x' },
        { name: 'link', data: '/etc/passwd', symlink: true, deflate: false },
      ],
    });
    const raw = await readFile(bytes.path);
    // Raw bytes keep the hostile names: the fixture must not "fix" them (the pipeline rejects them).
    expect(raw.toString('latin1')).toContain('../evil.txt');
    const zip = await ZipArchive.open(bytes.path);
    try {
      expect(zip.entries.find((entry) => entry.name === '../evil.txt')).toBeDefined();
      expect(zip.entries.find((entry) => entry.name === 'link')?.isSymlink).toBe(true);
    } finally {
      await zip.close();
    }
  });

  it('embeds a real .mcpb whose manifest.json parses', async () => {
    const fixture = await buildPluginFixture({
      dir: await tmp(),
      mcpb: [{ id: 'dbtools', mcpb: { manifest: { name: 'db-bundle' } } }],
    });
    const zip = await ZipArchive.open(fixture.path);
    try {
      const entry = zip.entries.find((item) => item.name === 'mcp/dbtools.mcpb')!;
      const inner = await zip.read(entry);
      const innerPath = path.join(await tmp(), 'inner.mcpb');
      await writeFile(innerPath, inner);
      const innerZip = await ZipArchive.open(innerPath);
      try {
        const manifestEntry = innerZip.entries.find((item) => item.name === 'manifest.json')!;
        expect(JSON.parse((await innerZip.read(manifestEntry)).toString('utf8'))).toMatchObject({
          name: 'db-bundle',
        });
      } finally {
        await innerZip.close();
      }
    } finally {
      await zip.close();
    }
  });

  it('connectorFixtureEntry mirrors the catalog shape with a test release gate', () => {
    const entry = connectorFixtureEntry('notion', { tier: 'community' });
    const meta = (entry._meta as Record<string, Record<string, unknown>>)['app.kepcup/connector']!;
    expect(entry.name).toBe('test.notion/mcp');
    expect(meta).toMatchObject({
      slug: 'notion',
      icon: 'notion.svg',
      tier: 'community',
      releaseGate: 'test',
    });
    expect((entry.remotes as Array<{ type: string; url: string }>)[0]!.url).toBe(
      'https://mcp.notion.test/mcp',
    );
  });
});

describe('buildPluginDir', () => {
  it('writes the same content as the archive', async () => {
    const base = await tmp();
    const options = {
      skills: [{ name: 'docx', extraFiles: { 'scripts/run.sh': 'echo hi' } }],
      connectors: [{ slug: 'notion', url: 'https://mcp.notion.test/mcp' }],
    };
    const fixture = await buildPluginFixture({ ...options, dir: path.join(base, 'pkg') });
    const dirFixture = await buildPluginDir({ ...options, dir: path.join(base, 'unpack') });
    expect(dirFixture.manifest).toEqual(fixture.manifest);
    const zip = await ZipArchive.open(fixture.path);
    try {
      for (const entry of zip.entries) {
        if (entry.isDirectory) continue;
        const expected = await zip.read(entry);
        const onDisk = await readFile(
          path.join(dirFixture.path, ...safeEntryPath(entry.name).split('/')),
        );
        expect(onDisk).toEqual(expected);
      }
    } finally {
      await zip.close();
    }
    const top = await readdir(dirFixture.path);
    expect(top).toEqual(expect.arrayContaining(['plugin.json', 'skills', 'connectors']));
  });
});
