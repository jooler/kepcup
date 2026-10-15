import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_COLORS,
  AVATAR_FOREGROUND_LIGHT,
  AVATAR_SHAPES,
  avatarOnFillForeground,
  parsePresetAvatar,
  presetForName,
} from './presets';

/**
 * 预置眼睛、气泡文字、按键图标走 avatarOnFillForeground：第一种「黑白」取对比
 * 变量，其余预置色一律白（产品取舍）。
 */

const fixedColors = AVATAR_COLORS.filter((color) => color.contrast === undefined);
const themedColors = AVATAR_COLORS.filter((color) => color.contrast !== undefined);

describe('avatarOnFillForeground', () => {
  it('inverts the themed mono colour and keeps every other preset white', () => {
    expect(themedColors.map((color) => color.id)).toEqual(['mono']);
    for (const color of themedColors) {
      expect(avatarOnFillForeground(color)).toBe(color.contrast);
    }
    for (const color of fixedColors) {
      expect(color.hex).toMatch(/^#[0-9a-f]{6}$/i);
      expect(avatarOnFillForeground(color)).toBe(AVATAR_FOREGROUND_LIGHT);
    }
  });

  it('the themed mono pair passes 4.5:1 in both themes (app.css)', () => {
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
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('presetForName', () => {
  it('is stable for the same name and always a valid preset', () => {
    for (const name of ['阿甲', 'Alice', '', '🙂 emoji', 'a'.repeat(200)]) {
      const avatar = presetForName(name);
      expect(presetForName(name)).toBe(avatar);
      const parsed = parsePresetAvatar(avatar);
      expect(parsed).not.toBeNull();
      expect(AVATAR_SHAPES).toContain(parsed!.shape);
      expect(AVATAR_COLORS).toContain(parsed!.color);
    }
  });

  it('spreads typical names over different presets', () => {
    const names = ['阿甲', '阿乙', '阿丙', '阿丁', '研究员', '写手', 'Alice', 'Bob'];
    const avatars = new Set(names.map(presetForName));
    expect(avatars.size).toBeGreaterThanOrEqual(names.length - 1);
    expect(presetForName('阿甲')).not.toBe(presetForName('阿乙'));
  });
});
