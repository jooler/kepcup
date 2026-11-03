import { SHADOW_PLACEHOLDER_ITEM_ID, TRIGGERS, type DndEventInfo } from 'svelte-dnd-action';

/**
 * Drop math for svelte-dnd-action. `consider` never reaches these; `finalize`
 * does. Only a drop into a zone commits, and the anchor is the first real
 * item after the dropped id.
 */

export interface DndItem {
  id: string;
  isDndShadowItem?: boolean;
}

const SHADOW_ID: string = SHADOW_PLACEHOLDER_ITEM_ID;

export function isShadow(item: DndItem): boolean {
  return item.isDndShadowItem === true || item.id === SHADOW_ID;
}

export function stripShadow<T extends DndItem>(items: readonly T[]): T[] {
  return items.filter((item) => !isShadow(item));
}

export function anchorFromFinalize(input: {
  items: readonly DndItem[];
  droppedId: string;
  info: Pick<DndEventInfo, 'trigger'> | { trigger: string };
}): { kind: 'commit'; beforeId: string | null } | { kind: 'ignore' } {
  if (input.info.trigger !== TRIGGERS.DROPPED_INTO_ZONE) return { kind: 'ignore' };
  const index = input.items.findIndex((item) => item.id === input.droppedId && !isShadow(item));
  if (index < 0) return { kind: 'ignore' };
  for (let cursor = index + 1; cursor < input.items.length; cursor += 1) {
    const item = input.items[cursor];
    if (item !== undefined && !isShadow(item)) return { kind: 'commit', beforeId: item.id };
  }
  return { kind: 'commit', beforeId: null };
}

/** Same id sequence, including length. A drop that lands where it started. */
export function isNoopMove(prev: readonly string[], next: readonly string[]): boolean {
  return prev.length === next.length && prev.every((id, index) => id === next[index]);
}

/**
 * Ignore card clicks for a short window after `finalize`, so the click that
 * the browser synthesizes at the end of a drag does not open the dialog.
 */
export function createClickGuard(
  ms = 120,
  now: () => number = () => Date.now(),
): { arm: () => void; ignores: () => boolean } {
  let until = 0;
  return {
    arm() {
      until = now() + ms;
    },
    ignores() {
      return now() < until;
    },
  };
}

export const cardClickGuard = createClickGuard();

/**
 * 拖拽浮动副本（`#dnd-action-dragged-el`）的实测高度：shadow 占位用它钉住高度，
 * 否则副本与占位形态不一致时会缩放跳动。
 */
export function draggedElementHeight(): number | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById('dnd-action-dragged-el');
  return el === null ? null : el.getBoundingClientRect().height;
}

export const BOARD_FLIP_MS = 150;

export function boardFlipDurationMs(reducedMotion: boolean): number {
  return reducedMotion ? 0 : BOARD_FLIP_MS;
}
