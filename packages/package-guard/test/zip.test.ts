import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PackageGuardError,
  safeEntryPath,
  ZipArchive,
  type ZipEntry,
  type ZipGuardOptions,
} from '@kepcup/package-guard';
import { buildZip } from '../../testkit/src/mcpb-fixture.js';

/**
 * `@kepcup/package-guard` (D104 step 1): the dependency-free ZIP reader extracted from
 * core's mcpb/zip.ts. Covers the injected error/label policy, the entry-name guard
 * table, and the archive-level structural rejections (no EOCD, ZIP64, encryption,
 * out-of-bounds central-directory declarations, CRC damage).
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'package-guard-'));
  dirs.push(dir);
  return dir;
}

async function writeArchive(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(await tmp(), name);
  await writeFile(file, bytes);
  return file;
}

/** Central-directory entry `index` starts at cenOffset + sum(46 + name length). */
function patchCentral(
  bytes: Buffer,
  patch: (central: Buffer, offset: number) => void,
  entryName = 'a.txt',
): Buffer {
  const copy = Buffer.from(bytes);
  const eocd = copy.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = copy.readUInt32LE(eocd + 16);
  for (let i = 0; i < copy.readUInt16LE(eocd + 10); i += 1) {
    const nameLength = copy.readUInt16LE(offset + 28);
    const name = copy.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === entryName) {
      patch(copy, offset);
      return copy;
    }
    offset += 46 + nameLength + copy.readUInt16LE(offset + 30) + copy.readUInt16LE(offset + 32);
  }
  throw new Error('entry not found');
}

function openOptions(
  errors: string[],
  label = '.kepcup',
): ZipGuardOptions & { factory: ZipGuardOptions['error'] } {
  return {
    error: (message: string) => {
      errors.push(message);
      return new PackageGuardError(message);
    },
    label,
  };
}

describe('error factory and label', () => {
  it('calls the custom error factory with a message containing the label', async () => {
    const errors: string[] = [];
    const file = await writeArchive('short.bin', Buffer.from('tiny'));
    await expect(ZipArchive.open(file, openOptions(errors))).rejects.toBeInstanceOf(
      PackageGuardError,
    );
    expect(errors[0]).toContain('.kepcup');
  });

  it('defaults to PackageGuardError with the generic zip label', async () => {
    const file = await writeArchive('short.bin', Buffer.from('tiny'));
    await expect(ZipArchive.open(file)).rejects.toThrow(/不是有效的 zip（ZIP）文件/);
  });
});

describe('safeEntryPath', () => {
  it('rejects the hostile-name table', () => {
    const cases: Array<[string, RegExp]> = [
      ['../x', /越界路径段/],
      ['a/../../x', /越界路径段/],
      ['/abs', /绝对路径/],
      ['C:/x', /绝对路径/],
      ['a\\b', /含反斜杠/],
      ['a\0b', /含 NUL/],
      ['a:b', /绝对路径/],
      ['1a:b', /含冒号/],
      ['trailing.', /路径段以点或空格结尾/],
      ['x /y', /路径段以点或空格结尾/],
      ['CON', /Windows 保留设备名/],
      ['NUL.txt', /Windows 保留设备名/],
      ['a//b', /越界路径段/],
    ];
    for (const [name, match] of cases) {
      expect(() => safeEntryPath(name, (m) => new PackageGuardError(m))).toThrow(match);
    }
    expect(() => safeEntryPath('', (m) => new PackageGuardError(m))).toThrow(/长度/);
  });

  it('accepts normal paths and strips a directory trailing slash', () => {
    expect(safeEntryPath('a/b/c')).toBe('a/b/c');
    expect(safeEntryPath('a/b/')).toBe('a/b');
  });
});

describe('ZipArchive.open structural checks', () => {
  it('rejects non-zip input: too short and no end-of-central-directory', async () => {
    const errors: string[] = [];
    const short = await writeArchive('short.bin', Buffer.from('tiny'));
    await expect(ZipArchive.open(short, openOptions(errors))).rejects.toThrow(
      /不是有效的 \.kepcup（ZIP）文件$/,
    );
    const junk = await writeArchive(
      'junk.bin',
      Buffer.from('not a zip at all, definitely not a zip payload at all'),
    );
    await expect(ZipArchive.open(junk, openOptions(errors))).rejects.toThrow(/找不到目录结尾/);
  });

  it('rejects the ZIP64 sentinel values', async () => {
    const bytes = buildZip([{ name: 'a.txt', data: 'x', deflate: false }]);
    const zip64 = patchCentral(bytes, (c, o) => c.writeUInt32LE(0xffffffff, o + 20));
    const file = await writeArchive('zip64.bin', zip64);
    await expect(
      ZipArchive.open(file, { error: (m) => new PackageGuardError(m), label: 'zip' }),
    ).rejects.toThrow(/不支持 ZIP64 的 zip 包/);
  });

  it('rejects the encryption flag', async () => {
    const bytes = buildZip([{ name: 'a.txt', data: 'x', deflate: false }]);
    const encrypted = patchCentral(bytes, (c, o) =>
      c.writeUInt16LE(c.readUInt16LE(o + 8) | 1, o + 8),
    );
    const file = await writeArchive('enc.bin', encrypted);
    await expect(
      ZipArchive.open(file, { error: (m) => new PackageGuardError(m), label: '.kepcup' }),
    ).rejects.toThrow(/不支持加密的 \.kepcup 包/);
  });

  it('bounds declared sizes and offsets from the central directory', async () => {
    const bytes = buildZip([{ name: 'a.txt', data: 'x', deflate: false }]);
    const cases: Array<[string, (central: Buffer, offset: number) => void]> = [
      ['huge-compressed', (c, o) => c.writeUInt32LE(0xfffffff0, o + 20)],
      ['offset-overflow', (c, o) => c.writeUInt32LE(0xfffffff0, o + 42)],
      [
        'stored-size-mismatch',
        (c, o) => {
          c.writeUInt16LE(0, o + 10);
          c.writeUInt32LE(5, o + 24);
        },
      ],
    ];
    for (const [label_, patch] of cases) {
      const file = await writeArchive(`${label_}.bin`, patchCentral(bytes, patch));
      await expect(
        ZipArchive.open(file, { error: (m) => new PackageGuardError(m), label: '.kepcup' }),
      ).rejects.toBeInstanceOf(PackageGuardError);
    }
  });
});

describe('reading entries', () => {
  it('reads stored and deflated entries back verbatim', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'ok.bin');
    await writeFile(
      file,
      buildZip([
        { name: 'plain.txt', data: 'stored content', deflate: false },
        { name: 'nested/deflated.txt', data: 'x'.repeat(4096) },
      ]),
    );
    const zip = await ZipArchive.open(file, {
      error: (m) => new PackageGuardError(m),
      label: '.kepcup',
    });
    try {
      expect(zip.entries.map((entry: ZipEntry) => entry.name)).toEqual([
        'plain.txt',
        'nested/deflated.txt',
      ]);
      expect(await zip.read(zip.entries[0]!)).toEqual(Buffer.from('stored content'));
      expect(await zip.read(zip.entries[1]!)).toEqual(Buffer.from('x'.repeat(4096)));
    } finally {
      await zip.close();
    }
  });

  it('flags symlink entries without rejecting them', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'link.bin');
    await writeFile(
      file,
      buildZip([{ name: 'link', data: '/etc/passwd', symlink: true, deflate: false }]),
    );
    const zip = await ZipArchive.open(file, {
      error: (m) => new PackageGuardError(m),
      label: '.kepcup',
    });
    try {
      expect(zip.entries[0]!.isSymlink).toBe(true);
    } finally {
      await zip.close();
    }
  });

  it('rejects reading an entry whose payload no longer matches its CRC', async () => {
    const bytes = buildZip([{ name: 'a.txt', data: 'payload-to-corrupt', deflate: false }]);
    const index = bytes.indexOf('payload-to-corrupt');
    bytes[index] = bytes[index]! ^ 0xff;
    const file = await writeArchive('crc.bin', bytes);
    const zip = await ZipArchive.open(file, {
      error: (m) => new PackageGuardError(m),
      label: '.kepcup',
    });
    try {
      await expect(zip.read(zip.entries[0]!)).rejects.toThrow(/校验失败/);
    } finally {
      await zip.close();
    }
  });
});
