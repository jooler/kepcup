import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOT_ACCENT_COLOR_IDS, DEFAULT_BOT_ACCENT_COLOR } from '@kepcup/shared';
import {
  ACCENT_COLORS,
  DEFAULT_ACCENT_COLOR,
  AVATAR_FOREGROUND_LIGHT,
  AVATAR_MASKS,
  AVATAR_SHAPES,
  avatarMaskClass,
  avatarOnFillForeground,
  parsePresetAvatar,
  presetForName,
  resolveAccentColor,
  uploadedAvatarShapeClass,
} from './presets';

/**
 * 预置眼睛、气泡文字、按键图标走 avatarOnFillForeground：第一种「黑白」取对比
 * 变量，其余预置色一律白（产品取舍）。
 */

const fixedColors = ACCENT_COLORS.filter((color) => color.contrast === undefined);
const themedColors = ACCENT_COLORS.filter((color) => color.contrast !== undefined);

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
      expect(ACCENT_COLORS).toContain(parsed!.color);
    }
  });

  it('spreads typical names over different presets', () => {
    const names = ['阿甲', '阿乙', '阿丙', '阿丁', '研究员', '写手', 'Alice', 'Bob'];
    const avatars = new Set(names.map(presetForName));
    expect(avatars.size).toBeGreaterThanOrEqual(names.length - 1);
    expect(presetForName('阿甲')).not.toBe(presetForName('阿乙'));
  });
});

describe('avatarMaskClass', () => {
  it('maps the mask to the outer rounding class, defaulting to a circle', () => {
    expect(avatarMaskClass('rounded')).toBe('rounded-[28%]');
    // 旧数据 / 未设置 / 未知值一律圆形（与 core 的 normalizeBotAvatarMask 同义）。
    expect(avatarMaskClass('circle')).toBe('rounded-full');
    expect(avatarMaskClass(null)).toBe('rounded-full');
    expect(avatarMaskClass(undefined)).toBe('rounded-full');
    expect(avatarMaskClass('square' as never)).toBe('rounded-full');
  });

  it('offers exactly the two switchable options, circle first', () => {
    expect(AVATAR_MASKS).toEqual(['circle', 'rounded']);
  });
});

describe('uploadedAvatarShapeClass', () => {
  it('follows the mask only for uploaded images', () => {
    expect(uploadedAvatarShapeClass('upload:avatar-1.png', 'rounded')).toBe('rounded-[28%]');
    expect(uploadedAvatarShapeClass('upload:avatar-1.png', 'circle')).toBe('rounded-full');
    // 预置头像 / 首字母占位不跟遮罩变方：圆按钮不能套方图。
    expect(uploadedAvatarShapeClass('preset:orb:orange', 'rounded')).toBe('rounded-full');
    expect(uploadedAvatarShapeClass(null, 'rounded')).toBe('rounded-full');
    expect(uploadedAvatarShapeClass(undefined, undefined)).toBe('rounded-full');
  });
});

describe('accent colour palette', () => {
  it('covers exactly the shared BotAccentColor ids, first entry is the default', () => {
    expect(ACCENT_COLORS.map((color) => color.id)).toEqual([...BOT_ACCENT_COLOR_IDS]);
    expect(DEFAULT_ACCENT_COLOR.id).toBe(DEFAULT_BOT_ACCENT_COLOR);
  });
});

describe('resolveAccentColor', () => {
  it('prefers the explicit accent colour over the preset avatar colour', () => {
    // 老数据：只有预置串里的颜色；新数据：显式列优先。两者不一致时以列为准。
    expect(resolveAccentColor('blue', 'preset:orb:red').id).toBe('blue');
  });

  it('falls back to the preset avatar colour for old rows without accent_color', () => {
    expect(resolveAccentColor(null, 'preset:heart:orange').id).toBe('orange');
    expect(resolveAccentColor(undefined, 'preset:heart:orange').id).toBe('orange');
  });

  it('falls back to mono for uploaded avatars, placeholders and junk values', () => {
    // 上传头像没有可继承的颜色：旧 bug 就是这里回退到「第一个自动色」，现在是显式列。
    expect(resolveAccentColor(null, 'upload:avatar-1.png').id).toBe('mono');
    expect(resolveAccentColor(undefined, null).id).toBe('mono');
    expect(resolveAccentColor('chartreuse', 'preset:orb:teal').id).toBe('teal');
    expect(resolveAccentColor('chartreuse', 'upload:avatar-1.png').id).toBe('mono');
    expect(resolveAccentColor('', '').id).toBe('mono');
  });
});
