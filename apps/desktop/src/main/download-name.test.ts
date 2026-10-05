import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { sanitizeDownloadName, uniqueDownloadPath } from './download-name.js';

/**
 * Unit tests for the page-supplied download filename sanitizer (BR-P11-004):
 * the name is untrusted input, and dot-only names (`.`、`..`) must never
 * produce a target outside the downloads directory.
 */

const DIR = path.join(path.sep, 'downloads');

describe('sanitizeDownloadName', () => {
  test('keeps ordinary names', () => {
    expect(sanitizeDownloadName('report.txt')).toBe('report.txt');
    expect(sanitizeDownloadName('数据 表格.csv')).toBe('数据 表格.csv');
  });

  test('flattens paths and replaces separators / reserved characters', () => {
    expect(sanitizeDownloadName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeDownloadName('a/b/c.txt')).toBe('c.txt');
    // basename splits on the platform separator; the other one is replaced.
    // (posix keeps 'a\b.txt' whole → 'a_b.txt'; win32 basename → 'b.txt'.)
    expect(sanitizeDownloadName('a\\b.txt')).toMatch(/^[ab][_.]b\.txt$/);
    expect(sanitizeDownloadName('weird:name?.txt')).toBe('weird_name_.txt');
  });

  test('dot-only and leading-dot names normalize away (BR-P11-004)', () => {
    expect(sanitizeDownloadName('..')).toBe('download');
    expect(sanitizeDownloadName('.')).toBe('download');
    expect(sanitizeDownloadName('')).toBe('download');
    expect(sanitizeDownloadName('.env')).toBe('env');
    expect(sanitizeDownloadName('..hidden')).toBe('hidden');
  });

  test('control characters are dropped', () => {
    expect(sanitizeDownloadName('re\u0000port\n.txt')).toBe('report.txt');
  });
});

describe('uniqueDownloadPath', () => {
  test('filename=".." never escapes the downloads directory (BR-P11-004)', () => {
    const target = uniqueDownloadPath(DIR, '..');
    expect(target.startsWith(DIR + path.sep)).toBe(true);
    expect(target).toBe(path.join(DIR, 'download'));
    expect(path.relative(DIR, target)).not.toContain('..');
  });

  test('filename="." lands inside the directory as download', () => {
    expect(uniqueDownloadPath(DIR, '.')).toBe(path.join(DIR, 'download'));
  });

  test('collision-free suffixes stay inside the directory', () => {
    const existing = new Set([path.join(DIR, 'report.txt'), path.join(DIR, 'report-1.txt')]);
    const exists = (candidate: string): boolean => existing.has(candidate);
    expect(uniqueDownloadPath(DIR, 'report.txt', exists)).toBe(path.join(DIR, 'report-2.txt'));
    expect(uniqueDownloadPath(DIR, '../x/report.txt', exists)).toBe(path.join(DIR, 'report-2.txt'));
  });
});
