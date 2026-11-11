import { describe, expect, it } from 'vitest';
import { TASK_WRITE_DOMAINS_MAX, TASK_WRITE_DOMAIN_PATTERN_MAX } from '@kepcup/shared';
import {
  absolutePatterns,
  domainsConflict,
  encodeWriteDomainKey,
  globsIntersect,
  normalizeDeclaredDomains,
  parseWriteDomainKey,
  writeDomainKeysConflict,
} from '../../src/workdir/domains.js';

/** D123 写域纯函数（docs/design/59 §3.2、todo/parallel-tasks-and-coordination.md §2.3）。 */

describe('normalizeDeclaredDomains', () => {
  it('归一化分隔符 / 前导 ./ / 尾斜杠并去重', () => {
    expect(normalizeDeclaredDomains(['src\\**', './docs/', 'docs/'])).toEqual([
      'src/**',
      'docs',
    ]);
    expect(normalizeDeclaredDomains(['a/./b'])).toEqual(['a/b']);
  });

  it('空数组、空串、..、绝对路径、空段、超限都返回 null', () => {
    expect(normalizeDeclaredDomains([])).toBeNull();
    expect(normalizeDeclaredDomains([''])).toBeNull();
    expect(normalizeDeclaredDomains(['../outside/**'])).toBeNull();
    expect(normalizeDeclaredDomains(['src/../lib/**'])).toBeNull();
    expect(normalizeDeclaredDomains(['/etc/**'])).toBeNull();
    expect(normalizeDeclaredDomains(['~/secrets/**'])).toBeNull();
    expect(normalizeDeclaredDomains(['C:\\src\\**'])).toBeNull();
    expect(normalizeDeclaredDomains(['a//b'])).toBeNull();
    expect(normalizeDeclaredDomains(['x'.repeat(TASK_WRITE_DOMAIN_PATTERN_MAX + 1)])).toBeNull();
    expect(
      normalizeDeclaredDomains(
        Array.from({ length: TASK_WRITE_DOMAINS_MAX + 1 }, (_, index) => `dir-${index}/**`),
      ),
    ).toBeNull();
  });
});

describe('absolutePatterns', () => {
  it('拼接 root 并归一化分隔符', () => {
    expect(absolutePatterns('/proj', ['src/**', 'docs'])).toEqual([
      '/proj/src/**',
      '/proj/docs',
    ]);
    expect(absolutePatterns('C:\\proj\\', ['src/**'])).toEqual(['C:/proj/src/**']);
  });
});

describe('globsIntersect（保守：判不了即相交）', () => {
  const cases: Array<[string, string, boolean]> = [
    ['**', 'src/a.ts', true],
    ['src/**', 'src/a.ts', true],
    ['src/**', 'lib/**', false],
    ['a/*', 'a/b/c.ts', true],
    ['a/**', 'b/**', false],
    ['a/**/c', 'a/b/c', true],
    ['src/index.ts', 'src/other.ts', false],
    ['src/*.ts', 'src/index.ts', true],
    ['apps/*', 'packages/*', false],
    ['SRC\\**', 'src/x', true],
    ['src/**', 'src/**', true],
    // Embedded `**` can span segments in the matcher: unknown → conservative true.
    ['a**b/c', 'a/x/b/d', true],
    ['a//b', 'a/b', true],
  ];
  for (const [a, b, expected] of cases) {
    it(`${a} vs ${b} → ${expected}`, () => {
      expect(globsIntersect(a, b)).toBe(expected);
      expect(globsIntersect(b, a)).toBe(expected);
    });
  }

  it('相同模式与根目录自身相交', () => {
    expect(globsIntersect('/proj/src/**', '/proj/src/**')).toBe(true);
    expect(globsIntersect('/proj', '/proj/src/a.ts')).toBe(true);
  });
});

describe('domainsConflict', () => {
  const domain = (root: string, patterns: string[]) => ({ root, patterns });

  it('同一 root 下域相交 / 不相交', () => {
    expect(
      domainsConflict(domain('/proj', ['apps/renderer/**']), domain('/proj', ['packages/core/**'])),
    ).toBe(false);
    expect(
      domainsConflict(domain('/proj', ['apps/renderer/**']), domain('/proj', ['apps/**'])),
    ).toBe(true);
    expect(domainsConflict(domain('/proj', ['**']), domain('/proj', ['packages/core/**']))).toBe(
      true,
    );
  });

  it('root 有重叠时按绝对模式判定', () => {
    expect(domainsConflict(domain('/proj', ['**']), domain('/proj/sub', ['x/**']))).toBe(true);
    expect(domainsConflict(domain('/proj/a', ['**']), domain('/proj/b', ['**']))).toBe(false);
    expect(domainsConflict(domain('/proj', ['docs/**']), domain('/proj/sub', ['docs/**']))).toBe(
      false,
    );
  });
});

describe('write-domain lease keys', () => {
  it('encodes patterns ASCII-sorted and decodes plain keys as whole roots', () => {
    expect(encodeWriteDomainKey('/proj', ['src/**', 'apps/renderer/**'])).toBe(
      '/proj|domains:apps%2Frenderer%2F**,src%2F**',
    );
    expect(parseWriteDomainKey(encodeWriteDomainKey('/proj', ['src/**']))).toEqual({
      base: '/proj',
      patterns: ['src/**'],
    });
    expect(parseWriteDomainKey('/proj')).toEqual({ base: '/proj', patterns: ['**'] });
    expect(parseWriteDomainKey('ws:bot_1:conv_1')).toEqual({
      base: 'ws:bot_1:conv_1',
      patterns: ['**'],
    });
  });

  it('keeps a comma inside a pattern from splitting the domain list', () => {
    const key = encodeWriteDomainKey('/proj', ['a,b/**', 'c/**']);
    expect(parseWriteDomainKey(key).patterns).toEqual(['a,b/**', 'c/**']);
  });

  it('conflicts only when roots overlap and domains intersect', () => {
    const a = encodeWriteDomainKey('/proj', ['apps/**']);
    const b = encodeWriteDomainKey('/proj', ['apps/renderer/**']);
    const c = encodeWriteDomainKey('/proj', ['packages/**']);
    expect(writeDomainKeysConflict(a, b)).toBe(true);
    expect(writeDomainKeysConflict(a, c)).toBe(false);
    // A plain root key is a whole-root domain.
    expect(writeDomainKeysConflict('/proj', a)).toBe(true);
    // Sibling workdirs never conflict, even with whole-root keys.
    expect(writeDomainKeysConflict('/proj', '/proj2')).toBe(false);
    // Workspace keys are roots of their own.
    expect(writeDomainKeysConflict('ws:bot_1:conv_1', 'ws:bot_2:conv_2')).toBe(false);
    expect(writeDomainKeysConflict('ws:bot_1:conv_1', 'ws:bot_1:conv_1')).toBe(true);
  });
});
