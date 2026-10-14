import { describe, expect, it } from 'vitest';
import {
  COMPOSER_MULTILINE_EXIT_MARGIN_PX,
  nextMultiline,
  type MultilineMeasurement,
} from './composer-multiline';

/** Single-line layout leaves 400 px for text; stacked (full width) leaves 520 px. */
const SINGLE_WIDTH = 400;

function measure(overrides: Partial<MultilineMeasurement>): MultilineMeasurement {
  return {
    multiline: false,
    layout: 'single',
    empty: false,
    wraps: false,
    contentWidthPx: 120,
    singleLineWidthPx: SINGLE_WIDTH,
    ...overrides,
  };
}

/**
 * Drives the composer the way the component does: measure in the rendered
 * layout, then (as the component's rAF re-measure does after a collapse)
 * measure again in the new layout. Returns the multiline value after the
 * layout settles plus every value it passed through (flicker = more than one
 * change for a single edit).
 */
function settle(
  start: boolean,
  content: { widthPx: number; singleLineWidthPx?: number; fullWidthPx?: number },
): { multiline: boolean; changes: number } {
  const single = content.singleLineWidthPx ?? SINGLE_WIDTH;
  const full = content.fullWidthPx ?? 520;
  let multiline = start;
  let changes = 0;
  for (let i = 0; i < 4; i++) {
    const layout = multiline ? 'stacked' : 'single';
    const available = layout === 'single' ? single : full;
    const wraps = content.widthPx > available;
    const next = nextMultiline({
      multiline,
      layout,
      empty: content.widthPx === 0,
      wraps,
      contentWidthPx: wraps ? null : content.widthPx,
      singleLineWidthPx: single,
    });
    if (next === multiline) break;
    multiline = next;
    changes++;
  }
  return { multiline, changes };
}

describe('nextMultiline', () => {
  it('enters multiline when the content wraps in the single-line layout', () => {
    expect(nextMultiline(measure({ wraps: true, contentWidthPx: null }))).toBe(true);
  });

  it('stays single-line when the content fits on one line', () => {
    expect(nextMultiline(measure({ wraps: false, contentWidthPx: 120 }))).toBe(false);
  });

  it('anti-flicker: stays multiline while the text would not fit the single-line width, even though it fits at full width', () => {
    expect(
      nextMultiline(
        measure({ multiline: true, layout: 'stacked', wraps: false, contentWidthPx: 450 }),
      ),
    ).toBe(true);
    // And the settled layout does not oscillate.
    expect(settle(false, { widthPx: 450 })).toEqual({ multiline: true, changes: 1 });
    expect(settle(true, { widthPx: 450 })).toEqual({ multiline: true, changes: 0 });
  });

  it('stays multiline when the content wraps even at full width (or has a hard break)', () => {
    expect(
      nextMultiline(
        measure({ multiline: true, layout: 'stacked', wraps: true, contentWidthPx: null }),
      ),
    ).toBe(true);
  });

  it('regression: wide glyphs latch, then narrower text of greater length fits one line → back to single line', () => {
    // 30 CJK characters (~14 px each = 420 px) wrap in a 400 px single line…
    const cjk = settle(false, { widthPx: 30 * 14 });
    expect(cjk.multiline).toBe(true);
    // …then the text is replaced by 60 narrow ASCII characters (~5 px each =
    // 300 px): longer by character count, but it fits one line. The old
    // length latch (60 ≥ 30) kept the composer stacked; widths do not.
    expect(
      nextMultiline(
        measure({ multiline: true, layout: 'stacked', wraps: false, contentWidthPx: 60 * 5 }),
      ),
    ).toBe(false);
    expect(settle(true, { widthPx: 60 * 5 })).toEqual({ multiline: false, changes: 1 });
  });

  it('hysteresis band: leaves multiline only once the text is narrower than the single width by the margin', () => {
    const atEdge = SINGLE_WIDTH - COMPOSER_MULTILINE_EXIT_MARGIN_PX;
    const stacked = (contentWidthPx: number) =>
      nextMultiline(measure({ multiline: true, layout: 'stacked', contentWidthPx }));
    expect(stacked(SINGLE_WIDTH - 1)).toBe(true);
    expect(stacked(atEdge + 0.5)).toBe(true);
    expect(stacked(atEdge)).toBe(false);
    // Entering still happens exactly at the browser's wrap (no margin).
    expect(
      nextMultiline(
        measure({ multiline: false, layout: 'stacked', contentWidthPx: SINGLE_WIDTH - 1 }),
      ),
    ).toBe(false);
  });

  it('typing across the boundary changes the layout at most once per edit', () => {
    let multiline = false;
    for (let width = 300; width <= 460; width += 4) {
      const result = settle(multiline, { widthPx: width });
      expect(result.changes).toBeLessThanOrEqual(1);
      multiline = result.multiline;
    }
    expect(multiline).toBe(true);
    for (let width = 460; width >= 300; width -= 4) {
      const result = settle(multiline, { widthPx: width });
      expect(result.changes).toBeLessThanOrEqual(1);
      multiline = result.multiline;
    }
    expect(multiline).toBe(false);
  });

  it('follows the single-line width when the window is resized', () => {
    // Stacked at 450 px of text; the window widens so the single line has 600 px.
    expect(
      nextMultiline(
        measure({
          multiline: true,
          layout: 'stacked',
          contentWidthPx: 450,
          singleLineWidthPx: 600,
        }),
      ),
    ).toBe(false);
    // Narrows again: a single-line measurement that wraps re-enters.
    expect(settle(false, { widthPx: 450, singleLineWidthPx: 300, fullWidthPx: 420 })).toEqual({
      multiline: true,
      changes: 1,
    });
  });

  it('stacked because of attachments: enters multiline when the text would not fit one line', () => {
    expect(
      nextMultiline(measure({ multiline: false, layout: 'stacked', contentWidthPx: 450 })),
    ).toBe(true);
    expect(
      nextMultiline(measure({ multiline: false, layout: 'stacked', contentWidthPx: 200 })),
    ).toBe(false);
  });

  it('unknown single-line width: collapses so the next measurement happens in the single layout', () => {
    expect(
      nextMultiline(measure({ multiline: true, layout: 'stacked', singleLineWidthPx: null })),
    ).toBe(false);
  });

  it('empty content is always single-line', () => {
    expect(
      nextMultiline(
        measure({
          multiline: true,
          layout: 'stacked',
          empty: true,
          wraps: true,
          contentWidthPx: null,
        }),
      ),
    ).toBe(false);
  });
});
