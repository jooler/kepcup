import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PackageGuardError, ZipArchive, buildZipBuffer, extractZip } from '@kepcup/package-guard';
import { buildZip } from '../../testkit/src/mcpb-fixture.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'package-guard-extract-'));
  dirs.push(dir);
  return dir;
}

async function archive(bytes: Buffer): Promise<ZipArchive> {
  const dir = await tmp();
  const file = path.join(dir, 'archive.kepcup');
  await writeFile(file, bytes);
  return ZipArchive.open(file, { label: '.kepcup' });
}

const factory = (message: string) => new PackageGuardError(message);

describe('extractZip', () => {
  it('extracts files and directories with sanitized modes', async () => {
    const zip = await archive(
      buildZipBuffer([
        { name: 'skills/' },
        { name: 'skills/a/SKILL.md', data: Buffer.from('skill') },
        { name: 'run', data: Buffer.from('#!/bin/sh\n'), mode: 0o777 },
        { name: 'plain', data: Buffer.from('x'), mode: 0o600 },
      ]),
    );
    const dest = path.join(await tmp(), 'out');
    try {
      const result = await extractZip(zip, dest, { error: factory, label: '.kepcup' });
      expect(result.files).toBe(3);
      expect(result.bytes).toBe(Buffer.byteLength('skill#!/bin/sh\nx'));
      expect(await readFile(path.join(dest, 'skills/a/SKILL.md'), 'utf8')).toBe('skill');
      expect((await stat(path.join(dest, 'run'))).mode & 0o777).toBe(0o755);
      expect((await stat(path.join(dest, 'plain'))).mode & 0o777).toBe(0o644);
      expect((await stat(path.join(dest, 'skills'))).isDirectory()).toBe(true);
    } finally {
      await zip.close();
    }
  });

  it('refuses a destination that already has content', async () => {
    const zip = await archive(buildZipBuffer([{ name: 'a.txt', data: Buffer.from('a') }]));
    const dest = await tmp();
    await writeFile(path.join(dest, 'keep.txt'), 'keep');
    try {
      await expect(extractZip(zip, dest, { error: factory })).rejects.toThrow(/空目录/);
    } finally {
      await zip.close();
    }
  });

  it('rejects zip-slip and leaves nothing outside the destination', async () => {
    const parent = await tmp();
    const zip = await archive(buildZip([{ name: '../escaped.txt', data: 'evil', deflate: false }]));
    try {
      await expect(
        extractZip(zip, path.join(parent, 'dest'), { error: factory, label: '.kepcup' }),
      ).rejects.toThrow(/越界路径段/);
      expect(await readdir(parent)).toEqual(['dest']);
    } finally {
      await zip.close();
    }
  });

  it('rejects symlinks and case-folded duplicates', async () => {
    const symlinkZip = await archive(
      buildZip([{ name: 'link', data: '/etc/passwd', symlink: true, deflate: false }]),
    );
    try {
      await expect(
        extractZip(symlinkZip, path.join(await tmp(), 'dest'), { error: factory }),
      ).rejects.toThrow(/符号链接/);
    } finally {
      await symlinkZip.close();
    }
    const duplicateZip = await archive(
      buildZip([
        { name: 'A.txt', data: 'one', deflate: false },
        { name: 'a.txt', data: 'two', deflate: false },
      ]),
    );
    try {
      await expect(
        extractZip(duplicateZip, path.join(await tmp(), 'dest'), { error: factory }),
      ).rejects.toThrow(/重复路径/);
    } finally {
      await duplicateZip.close();
    }
  });

  it('rejects a file and a directory sharing a path with a guard error, not a bare fs error', async () => {
    for (const order of [
      [
        { name: 'a', data: 'file', deflate: false },
        { name: 'a/b', data: 'nested', deflate: false },
      ],
      [
        { name: 'a/b', data: 'nested', deflate: false },
        { name: 'a', data: 'file', deflate: false },
      ],
    ]) {
      const zip = await archive(buildZip(order));
      try {
        await expect(
          extractZip(zip, path.join(await tmp(), 'dest'), { error: factory }),
        ).rejects.toSatisfy(
          (reason: unknown) =>
            reason instanceof PackageGuardError && /路径冲突/.test(reason.message),
        );
      } finally {
        await zip.close();
      }
    }
  });

  it('enforces entry and unpacked-size limits', async () => {
    const zip = await archive(
      buildZip([
        { name: 'a.txt', data: 'aaa', deflate: false },
        { name: 'b.txt', data: 'bbbb', deflate: false },
      ]),
    );
    try {
      await expect(
        extractZip(zip, path.join(await tmp(), 'one'), {
          error: factory,
          limits: { maxEntries: 1 },
        }),
      ).rejects.toThrow(/条目过多/);
      await expect(
        extractZip(zip, path.join(await tmp(), 'two'), {
          error: factory,
          limits: { maxUnpackedBytes: 3 },
        }),
      ).rejects.toThrow(/体积超过上限/);
    } finally {
      await zip.close();
    }
  });

  it('creates a missing destination directory', async () => {
    const zip = await archive(buildZipBuffer([{ name: 'a.txt', data: Buffer.from('a') }]));
    const dest = path.join(await tmp(), 'nested', 'out');
    try {
      await extractZip(zip, dest, { error: factory });
      expect(await readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('a');
    } finally {
      await zip.close();
    }
  });

  it('rejects a destination path that is a file', async () => {
    const zip = await archive(buildZipBuffer([{ name: 'a.txt', data: Buffer.from('a') }]));
    const parent = await tmp();
    const file = path.join(parent, 'file');
    await mkdir(path.join(parent, 'empty'));
    await writeFile(file, 'x');
    try {
      await expect(extractZip(zip, file, { error: factory })).rejects.toThrow(/不是目录/);
    } finally {
      await zip.close();
    }
  });
});
