import { describe, expect, it } from 'vitest';
import { placeSelectionToolbar } from './selection-pin';

const TOOLBAR = { width: 88, height: 32 };

describe('placeSelectionToolbar', () => {
  it('centers on the selection and floats above it', () => {
    const pos = placeSelectionToolbar(
      { left: 400, right: 500, top: 300, bottom: 316 },
      1000,
      800,
      TOOLBAR.width,
      TOOLBAR.height,
    );
    expect(pos).toEqual({ x: 450 - TOOLBAR.width / 2, y: 300 - TOOLBAR.height - 6 });
  });

  it('flips below when the selection is near the top edge', () => {
    const pos = placeSelectionToolbar(
      { left: 400, right: 500, top: 20, bottom: 36 },
      1000,
      800,
      TOOLBAR.width,
      TOOLBAR.height,
    );
    expect(pos.y).toBe(36 + 6);
  });

  it('clamps horizontally when the selection touches a side edge', () => {
    const pos = placeSelectionToolbar(
      { left: 0, right: 30, top: 300, bottom: 316 },
      1000,
      800,
      TOOLBAR.width,
      TOOLBAR.height,
    );
    expect(pos.x).toBe(8);
    const right = placeSelectionToolbar(
      { left: 980, right: 1000, top: 300, bottom: 316 },
      1000,
      800,
      TOOLBAR.width,
      TOOLBAR.height,
    );
    expect(right.x).toBe(1000 - TOOLBAR.width - 8);
  });

  it('stays inside the viewport when above and below both overflow', () => {
    const pos = placeSelectionToolbar(
      { left: 400, right: 500, top: 0, bottom: 790 },
      1000,
      800,
      TOOLBAR.width,
      TOOLBAR.height,
    );
    expect(pos.y).toBe(800 - TOOLBAR.height - 8);
  });
});
