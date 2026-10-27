import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PackageGuardError,
  ZipArchive,
  buildZipBuffer,
  type ZipWriteEntry,
} from '@kepcup/package-guard';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'package-guard-writer-'));
  dirs.push(dir);
  return dir;
}

async function write(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(await tmp(), name);
  await writeFile(file, bytes);
  return file;
}

const ENTRIES: ZipWriteEntry[] = [
  { name: 'docs/' },
  { name: 'docs/readme.txt', data: Buffer.from('hello plugin') },
  { name: 'bin/run.sh', data: Buffer.from('#!/bin/sh\necho hi\n'), mode: 0o755 },
  { name: 'empty.txt', data: new Uint8Array() },
];

describe('buildZipBuffer', () => {
  it('round-trips through the guarded reader (names, content, mode, directories)', async () => {
    const file = await write('plugin.kepcup', buildZipBuffer(ENTRIES));
    const zip = await ZipArchive.open(file, { label: '.kepcup' });
    try {
      expect(zip.entries.map((entry) => entry.name)).toEqual([
        'bin/run.sh',
        'docs/',
        'docs/readme.txt',
        'empty.txt',
      ]);
      const byName = new Map(zip.entries.map((entry) => [entry.name, entry]));
      expect(byName.get('docs/')!.isDirectory).toBe(true);
      expect(byName.get('bin/run.sh')!.unixMode & 0o777).toBe(0o755);
      expect(byName.get('docs/readme.txt')!.unixMode & 0o777).toBe(0o644);
      expect((await zip.read(byName.get('docs/readme.txt')!)).toString()).toBe('hello plugin');
      expect(await zip.read(byName.get('bin/run.sh')!)).toEqual(
        Buffer.from('#!/bin/sh\necho hi\n'),
      );
      expect(await zip.read(byName.get('empty.txt')!)).toEqual(Buffer.alloc(0));
    } finally {
      await zip.close();
    }
  });

  it('is deterministic: same input twice and shuffled input give the same bytes', () => {
    const first = buildZipBuffer(ENTRIES);
    expect(buildZipBuffer(ENTRIES).equals(first)).toBe(true);
    expect(buildZipBuffer([...ENTRIES].reverse()).equals(first)).toBe(true);
    expect(buildZipBuffer([...ENTRIES].sort(() => 0.5 - Math.random())).equals(first)).toBe(true);
  });

  it('fixes the timestamp at 1980-01-01 00:00', async () => {
    const file = await write(
      'time.kepcup',
      buildZipBuffer([{ name: 'a.txt', data: Buffer.from('a') }]),
    );
    const bytes = await (await import('node:fs/promises')).readFile(file);
    const central = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(bytes.readUInt16LE(central + 12)).toBe(0);
    expect(bytes.readUInt16LE(central + 14)).toBe(0x0021);
  });

  it('rejects unsafe names and case-folded duplicates', () => {
    const factory = (message: string) => new PackageGuardError(message);
    expect(() =>
      buildZipBuffer([{ name: '../x', data: Buffer.from('x') }], { error: factory }),
    ).toThrow(/越界路径段/);
    expect(() =>
      buildZipBuffer(
        [
          { name: 'A.txt', data: Buffer.from('a') },
          { name: 'a.txt', data: Buffer.from('b') },
        ],
        { error: factory },
      ),
    ).toThrow(/重复路径/);
  });

  it('enforces the configurable caps with tiny test values', () => {
    const factory = (message: string) => new PackageGuardError(message);
    expect(() => buildZipBuffer(ENTRIES, { error: factory, limits: { maxEntries: 2 } })).toThrow(
      /条目过多/,
    );
    expect(() =>
      buildZipBuffer([{ name: 'a.txt', data: Buffer.from('abcdef') }], {
        error: factory,
        limits: { maxEntryBytes: 3 },
      }),
    ).toThrow(/文件过大/);
    expect(() =>
      buildZipBuffer(
        [
          { name: 'a.txt', data: Buffer.from('abcd') },
          { name: 'b.txt', data: Buffer.from('efgh') },
        ],
        { error: factory, limits: { maxUnpackedBytes: 6 } },
      ),
    ).toThrow(/体积超过上限/);
    expect(() => buildZipBuffer(ENTRIES, { error: factory, limits: { maxFileBytes: 10 } })).toThrow(
      /包文件过大/,
    );
  });

  it('drops the executable bit for non-executable modes and adds it for executable ones', async () => {
    const file = await write(
      'modes.kepcup',
      buildZipBuffer([
        { name: 'world-readable', data: Buffer.from('x'), mode: 0o600 },
        { name: 'world-writable', data: Buffer.from('x'), mode: 0o666 },
        { name: 'exec', data: Buffer.from('x'), mode: 0o700 },
      ]),
    );
    const zip = await ZipArchive.open(file);
    try {
      const modes = new Map(zip.entries.map((entry) => [entry.name, entry.unixMode & 0o777]));
      expect(modes.get('world-readable')).toBe(0o644);
      expect(modes.get('world-writable')).toBe(0o644);
      expect(modes.get('exec')).toBe(0o755);
    } finally {
      await zip.close();
    }
  });
});
