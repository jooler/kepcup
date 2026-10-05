import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { directoryUsage, DISK_WALK_ENTRY_BUDGET, fileSizeOrNull } from '../../src/infra/disk-usage.js';

describe('disk-usage (P13 任务 6 诊断「磁盘占用」)', () => {
  const dirs: string[] = [];
  function scratch(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-disk-usage-'));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('sums files across nested directories and reports the file count', () => {
    const root = scratch();
    mkdirSync(path.join(root, 'a/b'), { recursive: true });
    writeFileSync(path.join(root, 'top.db'), 'x'.repeat(100));
    writeFileSync(path.join(root, 'a', 'mid.log'), 'x'.repeat(30));
    writeFileSync(path.join(root, 'a', 'b', 'deep.txt'), 'x'.repeat(6));

    const usage = directoryUsage(root);
    expect(usage.bytes).toBe(136);
    // 条目数含目录本身（a、b 两个目录 + 3 个文件）——预算守卫按访问条目计。
    expect(usage.files).toBe(5);
    expect(usage.truncated).toBe(false);
  });

  test('does not follow symlinks (data-dir symlink must not pull outside trees in)', () => {
    const root = scratch();
    const outside = scratch();
    writeFileSync(path.join(outside, 'big'), 'x'.repeat(1000));
    writeFileSync(path.join(root, 'small'), 'x'.repeat(10));
    symlinkSync(outside, path.join(root, 'link'));

    const usage = directoryUsage(root);
    expect(usage.bytes).toBe(10);
    expect(usage.files).toBe(2); // small + the link entry itself
  });

  test('missing root counts as empty', () => {
    const root = path.join(scratch(), 'does-not-exist');
    expect(directoryUsage(root)).toEqual({ bytes: 0, files: 0, truncated: false });
  });

  test('entry budget truncates huge trees and flags it', () => {
    const root = scratch();
    writeFileSync(path.join(root, 'one'), 'x');
    writeFileSync(path.join(root, 'two'), 'x');
    // 恰好用满预算（条目数 === 预算）不算截断：整棵树都走完了。
    expect(directoryUsage(root, 2)).toEqual({ bytes: 2, files: 2, truncated: false });
    // 预算小于条目数：停在预算处并如实标记（结果是下界）。
    const usage = directoryUsage(root, 1);
    expect(usage.files).toBe(1);
    expect(usage.truncated).toBe(true);
  });

  test('default budget is exported and generous', () => {
    expect(DISK_WALK_ENTRY_BUDGET).toBe(200_000);
  });

  test('fileSizeOrNull returns undefined for missing files', () => {
    const root = scratch();
    writeFileSync(path.join(root, 'present.db'), '12345');
    expect(fileSizeOrNull(path.join(root, 'present.db'))).toBe(5);
    expect(fileSizeOrNull(path.join(root, 'absent.db'))).toBeUndefined();
  });
});
