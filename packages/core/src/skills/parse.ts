import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadSkillsFromDir, type ResourceDiagnostic } from '@earendil-works/pi-coding-agent';
import { SKILL_DESCRIPTION_MAX_CHARS } from '@kepcup/shared';

/**
 * SKILL.md parsing (docs/dev/phases/P08-skills.md 任务 1). Name/description
 * come from pi's `loadSkillsFromDir` so imported skills behave exactly like
 * they would in Claude Code / Codex hosts (Agent Skills standard); the extra
 * flat frontmatter fields this product supports (permissions / sandbox /
 * test) are read by a minimal parser below — values stay plain strings, a
 * list is a string array.
 */

export interface SkillFrontmatterExtras {
  /** Comma/JSON list or single string, e.g. `permissions: network, credentials`. */
  permissions: string[];
  /** `sandbox: enhanced` marks the skill incompatible with the default sandbox. */
  sandbox: string;
  /** Test command run in the sandbox when a `tests/` directory exists. */
  test: string;
}

export interface ParsedSkill {
  name: string;
  /** Truncated to SKILL_DESCRIPTION_MAX_CHARS (任务书 注意事项). */
  description: string;
  /** pi's diagnostics (name/description spec violations still load). */
  diagnostics: ResourceDiagnostic[];
  extras: SkillFrontmatterExtras;
  /** Raw frontmatter map (unknown keys visible to the scanner). */
  frontmatter: Record<string, string | string[]>;
}

const EMPTY_EXTRAS: SkillFrontmatterExtras = {
  permissions: [],
  sandbox: '',
  test: '',
};

/** Splits `---` frontmatter from the markdown body; null when absent/malformed. */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } | null {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return null;
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) return null;
  const closing = normalized.indexOf('\n', end + 1);
  return {
    frontmatter: normalized.slice(4, end).trim(),
    body: normalized.slice(closing + 1),
  };
}

/** Splits an inline `[a, 'b, c']` list respecting quotes. */
function splitInlineList(inner: string): string[] {
  const entries: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of inner) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ',') {
      entries.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) entries.push(current.trim());
  return entries.filter((entry) => entry.length > 0);
}

/**
 * Minimal flat frontmatter reader: `key: value` lines, `key:` followed by
 * `- item` list lines, inline `[a, b]` lists. Nested YAML objects are out of
 * scope — every value the scanner needs is flat (validated by unit tests).
 */
export function parseFlatFrontmatter(raw: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  const commitList = () => {
    if (currentKey !== null && currentList !== null) result[currentKey] = currentList;
    currentKey = null;
    currentList = null;
  };
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    const listEntry = /^-\s+(.*)$/.exec(line.trim());
    if (listEntry && currentKey !== null && currentList !== null) {
      currentList.push(stripQuotes(listEntry[1]!.trim()));
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!pair) continue;
    commitList();
    const key = pair[1]!;
    const value = pair[2]!.trim();
    if (value.length === 0) {
      currentKey = key;
      currentList = [];
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = splitInlineList(value.slice(1, -1));
      continue;
    }
    result[key] = stripQuotes(value);
  }
  commitList();
  return result;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function asString(map: Record<string, string | string[]>, key: string): string {
  const value = map[key];
  return typeof value === 'string' ? value : '';
}

function asList(map: Record<string, string | string[]>, key: string): string[] {
  const value = map[key];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return [];
}

function readExtras(dir: string): { extras: SkillFrontmatterExtras; frontmatter: Record<string, string | string[]> } {
  try {
    const text = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const split = splitFrontmatter(text);
    if (split === null) return { extras: EMPTY_EXTRAS, frontmatter: {} };
    const map = parseFlatFrontmatter(split.frontmatter);
    return {
      extras: {
        permissions: [...asList(map, 'permissions'), ...asList(map, 'allowed-tools')],
        sandbox: asString(map, 'sandbox'),
        test: asString(map, 'test'),
      },
      frontmatter: map,
    };
  } catch {
    return { extras: EMPTY_EXTRAS, frontmatter: {} };
  }
}

/** SKILL.md content of one skill directory (raw markdown with frontmatter). */
export function readSkillMarkdown(dir: string): string {
  try {
    return readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Parses one skill directory via pi. Returns null when pi does not recognize
 * the directory as a skill (no SKILL.md / no description) — the caller
 * surfaces the diagnostics instead of guessing.
 */
export function parseSkillDir(dir: string): ParsedSkill | null {
  const result = loadSkillsFromDir({ dir, source: 'skills' });
  const skill = result.skills[0];
  if (result.skills.length === 0) return null;
  const { extras, frontmatter } = readExtras(dir);
  return {
    name: skill!.name,
    description: truncateDescription(skill!.description),
    diagnostics: result.diagnostics,
    extras,
    frontmatter,
  };
}

export function truncateDescription(description: string): string {
  return description.length > SKILL_DESCRIPTION_MAX_CHARS
    ? `${description.slice(0, SKILL_DESCRIPTION_MAX_CHARS)}…（描述超长已截断）`
    : description;
}

/**
 * Agent Skills name rule: lowercase a-z / 0-9 / hyphens, no doubles, no
 * leading/trailing hyphen, ≤64 chars. Used by the import/authoring flows and
 * `create_skill` so no impossible directory name ever reaches disk.
 */
export function sanitizeSkillName(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return /^[a-z0-9][a-z0-9-]*$/.test(cleaned) ? cleaned : null;
}
