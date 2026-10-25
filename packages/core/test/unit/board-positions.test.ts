import { describe, expect, it } from 'vitest';
import { BOARD_POSITION_MIN_GAP, BOARD_POSITION_STEP } from '@kepcup/shared';
import { needsRenumber, placeItem, positionBetween, renumber } from '../../src/board/positions.js';

describe('positionBetween', () => {
  it('places the first item, the head, the tail, and a midpoint', () => {
    expect(positionBetween(null, null)).toBe(BOARD_POSITION_STEP);
    expect(positionBetween(null, 1024)).toBe(512);
    expect(positionBetween(1024, null)).toBe(1024 + BOARD_POSITION_STEP);
    expect(positionBetween(1024, 3072)).toBe(2048);
  });
});

describe('needsRenumber', () => {
  it('fires when the gap is below the minimum or the midpoint collapses', () => {
    expect(needsRenumber(0, BOARD_POSITION_MIN_GAP)).toBe(false);
    expect(needsRenumber(0, BOARD_POSITION_MIN_GAP / 2)).toBe(true);
    expect(needsRenumber(null, BOARD_POSITION_MIN_GAP / 2)).toBe(true);
    expect(needsRenumber(1, 1)).toBe(true);
    expect(needsRenumber(1024, null)).toBe(false);
  });
});

describe('renumber', () => {
  it('spaces ids by STEP starting at STEP', () => {
    expect(renumber(['a', 'b', 'c'])).toEqual([
      { id: 'a', position: BOARD_POSITION_STEP },
      { id: 'b', position: BOARD_POSITION_STEP * 2 },
      { id: 'c', position: BOARD_POSITION_STEP * 3 },
    ]);
  });
});

describe('placeItem', () => {
  it('renumbers after 60 inserts into the same gap and keeps order', () => {
    let items = [
      { id: 'a', position: BOARD_POSITION_STEP },
      { id: 'b', position: BOARD_POSITION_STEP * 2 },
    ];
    let sawRenumber = false;
    const inserted: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const id = `n${i}`;
      const placed = placeItem(items, id, 'b');
      items = placed.items;
      if (placed.renumbered) sawRenumber = true;
      inserted.push(id);
    }
    expect(sawRenumber).toBe(true);
    expect(items.map((item) => item.id)).toEqual(['a', ...inserted, 'b']);
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i]!.position - items[i - 1]!.position).toBeGreaterThanOrEqual(
        BOARD_POSITION_MIN_GAP,
      );
    }
  });

  it('reports a no-op when the item is already in that slot', () => {
    const items = [
      { id: 'a', position: 1024 },
      { id: 'b', position: 2048 },
    ];
    const placed = placeItem(items, 'a', 'b');
    expect(placed.changed).toBe(false);
    expect(placed.renumbered).toBe(false);
    expect(placed.items.map((item) => item.id)).toEqual(['a', 'b']);
  });
});
