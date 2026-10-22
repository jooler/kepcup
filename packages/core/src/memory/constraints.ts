import { HARD_CONSTRAINT_MAX_ITEMS, type MemoryItem, type ProfileItem } from '@kepcup/shared';

/**
 * Deterministic hard-constraint extraction (docs/design/04-memory.md 注入方式).
 *
 * Hard constraints are read straight from the active entries — never from the
 * compiled profile card (which can be stale or truncated) and never from top-k
 * retrieval (which can miss them when the turn is unrelated). The word list is
 * deliberately separate from sensitive-topics.ts: that one decides privacy
 * downgrades; this one decides "must always be obeyed".
 */
const HARD_CONSTRAINT_PATTERN = /过敏|忌口|禁食|不能吃|不吃|禁止|不能|不要|必须|务必|避免|忌/;

/** True when the text states a constraint the bot must always follow. */
export function matchesHardConstraint(text: string): boolean {
  return HARD_CONSTRAINT_PATTERN.test(text);
}

export interface HardConstraint {
  id: string;
  content: string;
  source: 'profile' | 'private';
  origin: 'private' | 'project';
  privateToBot: boolean;
}

export interface CollectHardConstraintsInput {
  profileItems: ProfileItem[];
  privateItems: MemoryItem[];
  /** Project conversations exclude bot-private sensitive entries (retrieval policy). */
  isProject: boolean;
  now: number;
  maxItems?: number;
}

const MAX_CONTENT_CHARS = 120;

function isExpired(validUntil: number | null, now: number): boolean {
  return validUntil !== null && validUntil <= now;
}

function normalize(content: string): string {
  return content.trim().replace(/\s+/g, ' ');
}

/**
 * Shared `boundaries` entries are unconditional; other shared entries and the
 * current bot's private entries must match the word list. Shared entries win
 * the content de-duplication.
 */
export function collectHardConstraints(input: CollectHardConstraintsInput): HardConstraint[] {
  const maxItems = input.maxItems ?? HARD_CONSTRAINT_MAX_ITEMS;
  const seen = new Set<string>();
  const collected: HardConstraint[] = [];

  const push = (
    id: string,
    content: string,
    source: 'profile' | 'private',
    origin: 'private' | 'project',
    privateToBot: boolean,
  ) => {
    if (collected.length >= maxItems) return;
    const key = normalize(content);
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    collected.push({
      id,
      content: content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS) : content,
      source,
      origin,
      privateToBot,
    });
  };

  for (const item of input.profileItems) {
    if (item.status !== 'active') continue;
    if (isExpired(item.validUntil, input.now)) continue;
    if (item.category !== 'boundaries' && !matchesHardConstraint(item.content)) continue;
    push(item.id, item.content, 'profile', 'project', false);
  }

  for (const item of input.privateItems) {
    if (item.status !== 'active') continue;
    if (isExpired(item.validUntil, input.now)) continue;
    if (input.isProject && item.sensitivity === 'sensitive') continue;
    if (!matchesHardConstraint(item.content)) continue;
    push(item.id, item.content, 'private', item.origin, item.privateToBot);
  }

  return collected;
}
