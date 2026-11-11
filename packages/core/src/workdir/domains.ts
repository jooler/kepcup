import path from 'node:path';

import { TASK_WRITE_DOMAINS_MAX, TASK_WRITE_DOMAIN_PATTERN_MAX } from '@kepcup/shared';

/**
 * D123 write-domain primitives (docs/design/59-parallel-tasks-and-coordination.md §3).
 *
 * A task write domain is `{ root, patterns }`: `root` is the resolved (absolute)
 * task cwd, `patterns` are the globs declared through `start_task.writes`. Two
 * domains conflict when the absolute pattern sets intersect.
 *
 * The intersection check is deliberately conservative: when the patterns cannot
 * be analysed, it reports a conflict. A false positive only serializes tasks
 * that could have run in parallel; a false negative would let two tasks write
 * the same path concurrently, which the design forbids.
 */

/** A task write domain after cwd resolution (§3.1). */
export interface AbsDomain {
  root: string;
  patterns: string[];
}

export interface DeclaredDomainIssue {
  /** The offending declaration as received (or a field-level description). */
  pattern: string;
  message: string;
}

const META_CHARS = /[*?[]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;

function toPosix(value: string): string {
  return value.replaceAll('\\', '/');
}

function stripRelativePrefix(value: string): string {
  let result = toPosix(value.trim());
  while (result.startsWith('./')) result = result.slice(2);
  return result;
}

/** True for anything a relative-cwd glob must not be (absolute paths, homes, drives). */
function isAbsolutePattern(pattern: string): boolean {
  return pattern.startsWith('/') || DRIVE_PREFIX.test(pattern) || pattern.startsWith('~');
}

/**
 * Normalizes one declared pattern (`a\b` → `a/b`, leading `./` and trailing `/`
 * dropped, `.` segments collapsed, duplicate slashes rejected by the caller).
 * Returns null when the pattern stays empty or is still ambiguous.
 */
function normalizePattern(value: string): string | null {
  const posix = stripRelativePrefix(value).replace(/\/+$/, '');
  if (posix.length === 0) return null;
  const segments = posix.split('/').filter((segment) => segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) return null;
  return segments.join('/');
}

/**
 * Validates `start_task.writes` array declarations (§2). Returns the normalized,
 * deduplicated patterns or every violation to report. Empty arrays are invalid:
 * whole-cwd writes use `true`, read-only uses `false` / omission.
 */
export function inspectDeclaredDomains(
  patterns: readonly unknown[],
): { domains: string[] } | { issues: DeclaredDomainIssue[] } {
  const issues: DeclaredDomainIssue[] = [];
  const seen = new Set<string>();
  const domains: string[] = [];
  if (patterns.length === 0) {
    return { issues: [{ pattern: 'writes', message: '写域数组不能为空：整目录请用 writes: true' }] };
  }
  for (const raw of patterns) {
    if (typeof raw !== 'string') {
      issues.push({ pattern: String(raw), message: '写域必须是字符串数组' });
      continue;
    }
    const normalized = normalizePattern(raw);
    if (normalized === null) {
      issues.push({ pattern: raw, message: '写域不能为空，且不能含空段（//）或仅剩 .' });
      continue;
    }
    if (normalized.length > TASK_WRITE_DOMAIN_PATTERN_MAX) {
      issues.push({
        pattern: normalized,
        message: `单条写域最多 ${TASK_WRITE_DOMAIN_PATTERN_MAX} 字符`,
      });
      continue;
    }
    if (isAbsolutePattern(normalized)) {
      issues.push({ pattern: normalized, message: '写域必须是相对 cwd 的 glob，不能是绝对路径' });
      continue;
    }
    if (normalized.split('/').some((segment) => segment === '..')) {
      issues.push({ pattern: normalized, message: '写域不能用 .. 越出 cwd' });
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    domains.push(normalized);
  }
  if (domains.length > TASK_WRITE_DOMAINS_MAX) {
    issues.push({
      pattern: 'writes',
      message: `去重后写域最多 ${TASK_WRITE_DOMAINS_MAX} 条（当前 ${domains.length} 条）`,
    });
  }
  return issues.length > 0 ? { issues } : { domains };
}

/** `inspectDeclaredDomains` as a pure predicate: null = invalid (§2.3). */
export function normalizeDeclaredDomains(patterns: string[]): string[] | null {
  const inspected = inspectDeclaredDomains(patterns);
  return 'domains' in inspected ? inspected.domains : null;
}

/** Absolute glob patterns of a domain: `root + '/' + pattern` (§3.1). */
export function absolutePatterns(cwd: string, patterns: string[]): string[] {
  const root = toPosix(cwd).replace(/\/+$/, '');
  return patterns.map((pattern) => {
    const normalized = normalizePattern(pattern) ?? '**';
    return normalized === '**' ? `${root}/**` : `${root}/${normalized}`;
  });
}

/** Human-readable write domain for queue reasons / prompts. */
export function formatWriteDomain(patterns: readonly string[]): string {
  if (patterns.length === 1 && patterns[0] === '**') return '整目录';
  return patterns.join('、');
}

/**
 * Declared domains as plain directory paths, for sandbox policies that only
 * accept directories (§3.6). Returns null when any pattern cannot be
 * expressed ("判不了"): the caller then keeps today's whole-root mount.
 *
 * A pattern is expressible when its leading segments are literal up to a
 * `**` (or are entirely literal); `*`, `?` and character classes inside a
 * segment are not.
 */
export function expressibleDomainDirs(domain: AbsDomain): string[] | null {
  const dirs: string[] = [];
  for (const pattern of domain.patterns) {
    const segments = toPosix(pattern).split('/').filter((segment) => segment !== '' && segment !== '.');
    const literal: string[] = [];
    let expressible = true;
    for (const segment of segments) {
      if (!META_CHARS.test(segment)) {
        literal.push(segment);
        continue;
      }
      if (segment !== '**') expressible = false;
      break;
    }
    if (!expressible) return null;
    dirs.push(literal.length > 0 ? path.join(domain.root, ...literal) : domain.root);
  }
  return [...new Set(dirs)];
}

/**
 * Conservative glob intersection (§3.2): true when some path can match both
 * patterns. Unknown constructs (embedded `**`, empty segments, `~`) report true.
 */
export function globsIntersect(a: string, b: string): boolean {
  const left = splitPattern(a);
  const right = splitPattern(b);
  if (left === null || right === null) return true;
  return segmentsIntersect(left, 0, right, 0);
}

/** Absolute pattern sets intersect pairwise; roots must overlap first (§3.3). */
export function domainsConflict(a: AbsDomain, b: AbsDomain): boolean {
  if (!rootsOverlap(a.root, b.root)) return false;
  const left = absolutePatterns(a.root, a.patterns);
  const right = absolutePatterns(b.root, b.patterns);
  return left.some((one) => right.some((other) => globsIntersect(one, other)));
}

/** Lease keys of domain-scoped write tasks carry their sorted patterns (§2.5). */
const DOMAIN_KEY_SUFFIX = '|domains:';

/**
 * Encodes a structured write-domain lease key: `base|domains:p1,p2`
 * (patterns ASCII-sorted and URI-encoded so a comma inside a pattern cannot
 * split it). `base` is the workdir root, the workspace key, or a grant path.
 */
export function encodeWriteDomainKey(base: string, patterns: string[]): string {
  const sorted = [...patterns].sort();
  return `${base}${DOMAIN_KEY_SUFFIX}${sorted.map((pattern) => encodeURIComponent(pattern)).join(',')}`;
}

/** Decodes a lease key; a key without domains is a whole-root key (`['**']`). */
export function parseWriteDomainKey(key: string): { base: string; patterns: string[] } {
  const index = key.lastIndexOf(DOMAIN_KEY_SUFFIX);
  if (index < 0) return { base: key, patterns: ['**'] };
  const encoded = key.slice(index + DOMAIN_KEY_SUFFIX.length);
  try {
    const patterns = encoded
      .split(',')
      .filter((pattern) => pattern.length > 0)
      .map((pattern) => decodeURIComponent(pattern));
    return { base: key.slice(0, index), patterns: patterns.length > 0 ? patterns : ['**'] };
  } catch {
    // Not one of ours: treat the whole key as an undeclared root.
    return { base: key, patterns: ['**'] };
  }
}

/**
 * Lease conflict predicate with write domains (§2.5): both keys decode to a
 * base + patterns; plain keys are whole roots. Roots must overlap before the
 * domain patterns are compared (two sibling workdirs never conflict).
 */
export function writeDomainKeysConflict(a: string, b: string): boolean {
  const left = parseWriteDomainKey(a);
  const right = parseWriteDomainKey(b);
  return domainsConflict(
    { root: left.base, patterns: left.patterns },
    { root: right.base, patterns: right.patterns },
  );
}

/** True when every claim pattern is inside the task's declared domain (§5). */
export function claimWithinDomain(
  root: string,
  domainPatterns: string[],
  claimPatterns: string[],
): boolean {
  const domains = absolutePatterns(root, domainPatterns).map(comparablePattern);
  return claimPatterns.every((claim) => {
    const claimPattern = comparablePattern(absolutePatterns(root, [claim])[0] ?? '');
    return domains.some(
      (domain) =>
        domain === claimPattern ||
        (globsIntersect(domain, claimPattern) &&
          literalPrefixPath(claimPattern).startsWith(literalPrefixPath(domain))),
    );
  });
}

/** Case/separator normalization used by every domain comparison. */
export function comparablePattern(value: string): string {
  const normalized = toPosix(value);
  return process.platform === 'linux' ? normalized : normalized.toLowerCase();
}

/** Path segments before the first glob segment ('' for a leading wildcard). */
function literalPrefixPath(pattern: string): string {
  const segments = pattern.split('/');
  const index = segments.findIndex((segment) => META_CHARS.test(segment));
  return (index < 0 ? segments : segments.slice(0, index)).join('/');
}

/** True when one root equals the other or is its ancestor (path-component-wise). */
function rootsOverlap(a: string, b: string): boolean {
  const left = pathSegments(a);
  const right = pathSegments(b);
  if (left.length === 0 || right.length === 0) return left.length === right.length;
  const shorter = Math.min(left.length, right.length);
  for (let index = 0; index < shorter; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function pathSegments(value: string): string[] {
  const normalized = toPosix(value).toLowerCase().replace(/\/+$/, '');
  const segments = normalized.split('/');
  if (segments[0] === '') segments.shift();
  return segments.filter((segment) => segment.length > 0);
}

/**
 * Segment view of a pattern, or null when it cannot be analysed confidently.
 * Case and separators are normalized (lowercase is conservative: it can only
 * turn "different" into "same", never hide an intersection).
 */
function splitPattern(pattern: string): string[] | null {
  const normalized = toPosix(pattern).toLowerCase();
  if (normalized.length === 0) return null;
  if (normalized.startsWith('~')) return null;
  let segments = normalized.split('/');
  if (segments[0] === '') segments = segments.slice(1);
  while (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment.length === 0)) return null;
  // `**` is only valid as a whole segment; embedded `**` can span segments in
  // the matcher and cannot be reasoned about here.
  if (segments.some((segment) => segment !== '**' && segment.includes('**'))) return null;
  return segments;
}

function segmentsIntersect(a: string[], ai: number, b: string[], bi: number): boolean {
  if (ai === a.length && bi === b.length) return true;
  // One side exhausted while the other can still match: a prefix pattern (or a
  // `**` matching zero segments) may overlap — conservatively true.
  if (ai === a.length || bi === b.length) return true;
  const segmentA = a[ai] ?? '';
  const segmentB = b[bi] ?? '';
  if (segmentA === '**') {
    return segmentsIntersect(a, ai + 1, b, bi) || segmentsIntersect(a, ai, b, bi + 1);
  }
  if (segmentB === '**') {
    return segmentsIntersect(a, ai, b, bi + 1) || segmentsIntersect(a, ai + 1, b, bi);
  }
  if (!segmentIntersects(segmentA, segmentB)) return false;
  return segmentsIntersect(a, ai + 1, b, bi + 1);
}

/**
 * Two single segments: compare literal prefixes. Equal or nested prefixes may
 * overlap; disjoint literal prefixes cannot (no wildcard can bridge them).
 * An empty prefix means the segment starts with a wildcard — unknown, so true.
 */
function segmentIntersects(a: string, b: string): boolean {
  if (a === b) return true;
  const prefixA = literalPrefix(a);
  const prefixB = literalPrefix(b);
  if (prefixA.length === 0 || prefixB.length === 0) return true;
  return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
}

function literalPrefix(segment: string): string {
  const index = segment.search(META_CHARS);
  return index < 0 ? segment : segment.slice(0, index);
}
