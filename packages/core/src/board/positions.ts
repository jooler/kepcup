import { BOARD_POSITION_MIN_GAP, BOARD_POSITION_STEP } from '@kepcup/shared';

/** Fractional-position knobs; defaults are the board's. The workbench memos pass their own. */
export interface PositionOptions {
  /** Gap between freshly seeded or renumbered positions. */
  step?: number;
  /** Neighbor gap below which the list is renumbered. */
  minGap?: number;
}

/**
 * Fractional position between two neighbors (docs/design/50-project-board.md §5.4).
 * Both empty → STEP. No predecessor → after / 2. No successor → before + STEP.
 * Otherwise the midpoint.
 */
export function positionBetween(
  before?: number | null,
  after?: number | null,
  options: PositionOptions = {},
): number {
  const step = options.step ?? BOARD_POSITION_STEP;
  const hasBefore = before !== undefined && before !== null;
  const hasAfter = after !== undefined && after !== null;
  if (!hasBefore && !hasAfter) return step;
  if (!hasBefore) return (after as number) / 2;
  if (!hasAfter) return (before as number) + step;
  return ((before as number) + (after as number)) / 2;
}

/**
 * True when the gap is below the min gap or the midpoint collapses onto a
 * neighbor (float precision). A missing predecessor is treated as 0, so
 * inserting at the head renumbers once `after` itself is too small.
 */
export function needsRenumber(
  before?: number | null,
  after?: number | null,
  options: PositionOptions = {},
): boolean {
  const minGap = options.minGap ?? BOARD_POSITION_MIN_GAP;
  const hasBefore = before !== undefined && before !== null;
  const hasAfter = after !== undefined && after !== null;
  if (hasBefore && hasAfter && (after as number) - (before as number) < minGap) return true;
  if (!hasBefore && hasAfter && (after as number) < minGap) return true;
  const mid = positionBetween(before, after, options);
  if (hasBefore && mid === before) return true;
  if (hasAfter && mid === after) return true;
  return false;
}

/** Even STEP spacing, 1-based, in the given order. */
export function renumber(
  ids: readonly string[],
  options: PositionOptions = {},
): Array<{ id: string; position: number }> {
  const step = options.step ?? BOARD_POSITION_STEP;
  return ids.map((id, index) => ({ id, position: step * (index + 1) }));
}

export interface Positioned {
  id: string;
  position: number;
}

export interface Placement {
  items: Positioned[];
  /** True when the whole list was rewritten to STEP spacing. */
  renumbered: boolean;
  /** False when `id` was already sitting in the requested slot. */
  changed: boolean;
}

/**
 * Place `id` before `beforeId` (`null` = end). `id` may already be in `items`
 * (a move) or not (an insert). Throws if the anchor is missing or is `id`.
 */
export function placeItem(
  items: readonly Positioned[],
  id: string,
  beforeId: string | null,
  options: PositionOptions = {},
): Placement {
  if (beforeId === id) throw new Error('placeItem: beforeId is the moved item');
  const without = items.filter((item) => item.id !== id);
  let index: number;
  if (beforeId === null) {
    index = without.length;
  } else {
    index = without.findIndex((item) => item.id === beforeId);
    if (index < 0) throw new Error('placeItem: anchor missing');
  }
  const before = index > 0 ? without[index - 1]! : null;
  const after = index < without.length ? without[index]! : null;
  const existingIndex = items.findIndex((item) => item.id === id);
  if (existingIndex >= 0) {
    const currentBefore = existingIndex > 0 ? items[existingIndex - 1]! : null;
    const currentAfter = existingIndex < items.length - 1 ? items[existingIndex + 1]! : null;
    if (
      (currentBefore?.id ?? null) === (before?.id ?? null) &&
      (currentAfter?.id ?? null) === (after?.id ?? null)
    ) {
      return { items: items.map((item) => ({ ...item })), renumbered: false, changed: false };
    }
  }
  if (needsRenumber(before?.position ?? null, after?.position ?? null, options)) {
    const ids = [
      ...without.slice(0, index).map((item) => item.id),
      id,
      ...without.slice(index).map((item) => item.id),
    ];
    return { items: renumber(ids, options), renumbered: true, changed: true };
  }
  const position = positionBetween(before?.position ?? null, after?.position ?? null, options);
  const next = without.map((item) => ({ ...item }));
  next.splice(index, 0, { id, position });
  return { items: next, renumbered: false, changed: true };
}
