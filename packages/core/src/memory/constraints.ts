import { HARD_CONSTRAINT_MAX_ITEMS, type MemoryItem, type ProfileItem } from '@kepcup/shared';

/**
 * Deterministic hard-constraint extraction (docs/design/04-memory.md 注入方式).
 *
 * Hard constraints are read straight from the active entries — never from the
 * compiled profile card (which can be stale or truncated) and never from top-k
 * retrieval (which can miss them when the turn is unrelated). The word list is
 * deliberately separate from sensitive-topics.ts: that one decides privacy
 * downgrades; this one decides "must always be obeyed".
 *
 * 词表分两级，防止普通偏好被误当硬约束灌满 200 token 预算：
 *
 * - 强词：过敏 / 忌口 / 禁食 / 不能吃 / 不吃 / 禁止 / 务必 / 必须——语义
 *   明确，任何来源（共享画像非 boundaries 条目、私有记忆）命中即入选。
 * - 弱词：不能 / 不要 / 避免 / 忌——单独出现时大量命中普通偏好
 *   （“回复不要太长”“避免语音通话”），只对 boundaries 分类的画像条目有
 *   意义；而 boundaries 条目本来就无条件入选，所以弱词不参与
 *   {@linkcode matchesHardConstraint} 的判定。私有条目没有 boundaries
 *   分类（MemoryKind 无此值），同样只认强词。
 */
const STRONG_CONSTRAINT_PATTERN = /过敏|忌口|禁食|不能吃|不吃|禁止|务必|必须/;
const WEAK_CONSTRAINT_PATTERN = /不能|不要|避免|忌/;

/**
 * True when the text states a constraint the bot must always follow
 * (strong tier only — weak words alone do not qualify, see above).
 */
export function matchesHardConstraint(text: string): boolean {
  return STRONG_CONSTRAINT_PATTERN.test(text);
}

/**
 * True when the text matches either tier. The weak tier only applies to
 * boundaries-class entries (which are collected unconditionally anyway);
 * exported to pin the two-tier split in tests.
 */
export function matchesBoundaryClassConstraint(text: string): boolean {
  return STRONG_CONSTRAINT_PATTERN.test(text) || WEAK_CONSTRAINT_PATTERN.test(text);
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
 * current bot's private entries must match the strong word list. Shared entries
 * win the content de-duplication.
 *
 * 输入顺序即注入顺序（达到条数上限时按此截断）：共享画像条目由
 * ProfileStore.list 按 created_at 升序返回（先记的边界在前），私有条目由
 * MemoryStore.activeItems 按 created_at 降序返回（最新在前），超限先丢
 * 私有条目。
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
