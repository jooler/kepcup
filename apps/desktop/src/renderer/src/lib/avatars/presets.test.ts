import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_COLORS,
  AVATAR_FOREGROUND_DARK,
  AVATAR_FOREGROUND_LIGHT,
  AVATAR_MIN_CONTRAST,
  avatarColorForeground,
  contrastRatio,
  relativeLuminance,
} from './presets';

/**
 * 头像色上的前景（眼睛、输入框发送 / 语音键图标、用户气泡文字）按对比度计算：
 * 图标 ≥ 3:1（WCAG 1.4.11），文字 ≥ 4.5:1（1.4.3）。
 */

const fixedColors = AVATAR_COLORS.filter((color) => color.contrast === undefined);
const themedColors = AVATAR_COLORS.filter((color) => color.contrast !== undefined);

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // WCAG's classic example: #777777 on white ≈ 4.48:1.
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(relativeLuminance('var(--x)')).toBeNull();
    expect(contrastRatio('var(--x)', '#ffffff')).toBeNull();
  });
});

describe('avatarColorForeground', () => {
  it('every fixed preset is a computable #rrggbb colour', () => {
    expect(fixedColors.length).toBeGreaterThan(0);
    for (const color of fixedColors) expect(color.hex).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each(fixedColors.map((color) => [color.id, color] as const))(
    '%s: icon ≥ 3:1 and text ≥ 4.5:1',
    (_id, color) => {
      const icon = avatarColorForeground(color, 'graphic');
      const text = avatarColorForeground(color, 'text');
      expect([AVATAR_FOREGROUND_LIGHT, AVATAR_FOREGROUND_DARK]).toContain(icon);
      expect(contrastRatio(color.hex, icon)!).toBeGreaterThanOrEqual(AVATAR_MIN_CONTRAST.graphic);
      expect(contrastRatio(color.hex, text)!).toBeGreaterThanOrEqual(AVATAR_MIN_CONTRAST.text);
      // The default use is the icon one.
      expect(avatarColorForeground(color)).toBe(icon);
    },
  );

  it('keeps the white preset style wherever white is good enough, dark only where it is not', () => {
    for (const color of fixedColors) {
      for (const use of ['graphic', 'text'] as const) {
        const whiteOk =
          contrastRatio(color.hex, AVATAR_FOREGROUND_LIGHT)! >= AVATAR_MIN_CONTRAST[use];
        expect(avatarColorForeground(color, use)).toBe(
          whiteOk ? AVATAR_FOREGROUND_LIGHT : AVATAR_FOREGROUND_DARK,
        );
      }
    }
    // The reported failures (white ≈ 2.1:1 on amber, 2.6:1 on gray, 2.9:1 on teal) flip.
    const byId = new Map(AVATAR_COLORS.map((color) => [color.id, color]));
    for (const id of ['amber', 'gray', 'teal']) {
      expect(avatarColorForeground(byId.get(id)!, 'graphic')).toBe(AVATAR_FOREGROUND_DARK);
    }
  });

  it('is deterministic: depends on the colour value only', () => {
    for (const color of AVATAR_COLORS) {
      const copy = { ...color, id: `${color.id}-copy`, label: 'x' };
      for (const use of ['graphic', 'text'] as const) {
        expect(avatarColorForeground(copy, use)).toBe(avatarColorForeground(color, use));
        expect(avatarColorForeground(color, use)).toBe(avatarColorForeground(color, use));
      }
    }
  });

  it('themed (var) presets use their paired contrast variable, which passes in both themes', () => {
    expect(themedColors.map((color) => color.id)).toEqual(['mono']);
    for (const color of themedColors) {
      expect(avatarColorForeground(color, 'graphic')).toBe(color.contrast);
      expect(avatarColorForeground(color, 'text')).toBe(color.contrast);
    }
    // app.css defines both variables as achromatic oklch per theme; for
    // chroma 0, relative luminance Y = L³.
    const css = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');
    const blocks = [
      ...css.matchAll(
        /--avatar-mono:\s*oklch\(([\d.]+) 0 0\);\s*--avatar-mono-contrast:\s*oklch\(([\d.]+) 0 0\);/g,
      ),
    ];
    expect(blocks).toHaveLength(2); // light :root and .dark
    for (const [, fill, fg] of blocks) {
      const yFill = Number(fill) ** 3;
      const yFg = Number(fg) ** 3;
      const ratio = (Math.max(yFill, yFg) + 0.05) / (Math.min(yFill, yFg) + 0.05);
      expect(ratio).toBeGreaterThanOrEqual(AVATAR_MIN_CONTRAST.text);
    }
  });
});

describe('avatarColorForeground guaranteed floor (any #rrggbb, not just presets)', () => {
  const hex = (r: number, g: number, b: number): string =>
    `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  /** Every grey level plus an RGB grid (step 5): covers the whole luminance range. */
  const samples: string[] = [];
  for (let v = 0; v < 256; v++) samples.push(hex(v, v, v));
  for (let r = 0; r < 256; r += 5) {
    for (let g = 0; g < 256; g += 5) {
      for (let b = 0; b < 256; b += 5) samples.push(hex(r, g, b));
    }
  }

  /** Worst contrast the rule yields over all samples, and where. */
  function worstCase(pick: (fill: string) => string): { ratio: number; fill: string } {
    let worst = { ratio: Infinity, fill: '' };
    for (const fill of samples) {
      const ratio = contrastRatio(fill, pick(fill))!;
      if (ratio < worst.ratio) worst = { ratio, fill };
    }
    return worst;
  }

  it.each(['graphic', 'text'] as const)(
    '%s: worst case over the luminance range ≥ its minimum',
    (use) => {
      const worst = worstCase((fill) =>
        avatarColorForeground({ id: 'x', label: 'x', hex: fill }, use),
      );
      expect(worst.ratio, `worst at ${worst.fill}`).toBeGreaterThanOrEqual(
        AVATAR_MIN_CONTRAST[use],
      );
      // The floor is the threshold itself: white is kept down to exactly T.
      expect(worst.ratio).toBeLessThan(AVATAR_MIN_CONTRAST[use] + 0.1);
    },
  );

  it('pure black is needed: a near-black #0a0a0a would miss 4.5:1 for text right past the white switch', () => {
    const t = AVATAR_MIN_CONTRAST.text;
    const nearBlack = worstCase((fill) =>
      contrastRatio(fill, AVATAR_FOREGROUND_LIGHT)! >= t ? AVATAR_FOREGROUND_LIGHT : '#0a0a0a',
    );
    expect(nearBlack.ratio).toBeLessThan(t);
    expect(AVATAR_FOREGROUND_DARK).toBe('#000000');
  });
});
