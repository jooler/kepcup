import { SHADOW_PLACEHOLDER_ITEM_ID, TRIGGERS } from 'svelte-dnd-action';
import { describe, expect, it } from 'vitest';
import {
  anchorFromFinalize,
  boardFlipDurationMs,
  createClickGuard,
  isNoopMove,
  isShadow,
  stripShadow,
} from './board-dnd';

const shadow = { id: SHADOW_PLACEHOLDER_ITEM_ID, isDndShadowItem: true as const };

describe('shadow items', () => {
  it('recognises the library placeholder and strips it', () => {
    expect(isShadow(shadow)).toBe(true);
    expect(isShadow({ id: 'a', isDndShadowItem: true })).toBe(true);
    expect(isShadow({ id: 'a' })).toBe(false);
    expect(stripShadow([{ id: 'a' }, shadow, { id: 'b' }]).map((item) => item.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('anchorFromFinalize', () => {
  const items = [{ id: 'a' }, { id: 'b' }, shadow, { id: 'c' }];

  it('anchors on the first real item after the dropped id', () => {
    expect(
      anchorFromFinalize({
        items,
        droppedId: 'b',
        info: { trigger: TRIGGERS.DROPPED_INTO_ZONE },
      }),
    ).toEqual({ kind: 'commit', beforeId: 'c' });
  });

  it('uses a null anchor when the drop is at the end', () => {
    expect(
      anchorFromFinalize({
        items: [{ id: 'a' }, { id: 'b' }],
        droppedId: 'b',
        info: { trigger: TRIGGERS.DROPPED_INTO_ZONE },
      }),
    ).toEqual({ kind: 'commit', beforeId: null });
  });

  it('ignores a drop into another zone or outside every zone', () => {
    expect(
      anchorFromFinalize({
        items,
        droppedId: 'a',
        info: { trigger: TRIGGERS.DROPPED_INTO_ANOTHER },
      }),
    ).toEqual({ kind: 'ignore' });
    expect(
      anchorFromFinalize({
        items,
        droppedId: 'a',
        info: { trigger: TRIGGERS.DROPPED_OUTSIDE_OF_ANY },
      }),
    ).toEqual({ kind: 'ignore' });
  });

  it('ignores a drop whose id is missing', () => {
    expect(
      anchorFromFinalize({
        items,
        droppedId: 'missing',
        info: { trigger: TRIGGERS.DROPPED_INTO_ZONE },
      }),
    ).toEqual({ kind: 'ignore' });
  });
});

describe('isNoopMove', () => {
  it('is true only when the id sequence is unchanged', () => {
    expect(isNoopMove(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isNoopMove(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(isNoopMove(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('createClickGuard', () => {
  it('ignores clicks only inside the window after arm', () => {
    let now = 1_000;
    const guard = createClickGuard(120, () => now);
    expect(guard.ignores()).toBe(false);
    guard.arm();
    now = 1_119;
    expect(guard.ignores()).toBe(true);
    now = 1_120;
    expect(guard.ignores()).toBe(false);
  });
});

describe('boardFlipDurationMs', () => {
  it('is 0 when the user prefers reduced motion', () => {
    expect(boardFlipDurationMs(false)).toBe(150);
    expect(boardFlipDurationMs(true)).toBe(0);
  });
});
