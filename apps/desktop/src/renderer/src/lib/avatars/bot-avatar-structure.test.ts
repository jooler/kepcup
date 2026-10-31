import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { avatarMaskClass } from './presets';

/**
 * 上传头像分支的遮罩位置（回归守护）：遮罩圆角必须打在 img 上而不是外层容器。
 * padding 内缩后图片变小——圆角挂在容器上会够不着图（圆形把图片四角斜切掉、
 * 圆角方的直角露出来），百分比圆角只有按图片自身盒子解析才在任意边距下成立。
 */

const source = readFileSync(new URL('./BotAvatar.svelte', import.meta.url), 'utf8');

function uploadBranch(): string {
  const start = source.indexOf('{:else if uploadFile');
  const end = source.indexOf('{:else if glyphShadowOffset');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('BotAvatar upload branch structure', () => {
  it('applies the mask class to the img and keeps the container free of it', () => {
    const branch = uploadBranch();
    // img 行带着遮罩类与 object-cover。
    expect(branch).toContain('class="size-full object-cover {maskClass}"');
    // 容器只保留尺寸 / 内边距 / 标记：不再有 overflow-hidden 与遮罩类，内边距走 style。
    const spanTag = /<span\b[^>]*>/.exec(branch)?.[0] ?? '';
    const spanClass = /class="([^"]+)"/.exec(spanTag)?.[1] ?? '';
    expect(spanClass).not.toContain('maskClass');
    expect(spanClass).not.toContain('overflow-hidden');
    expect(spanTag).toContain('style={paddingStyle}');
  });

  it('keeps the two mask shapes distinct so both scale with the image box', () => {
    // 圆 / 圆角方两个类都必须是百分比 / 全圆形态——相对图片盒解析才不怕内缩。
    expect(avatarMaskClass('circle')).toBe('rounded-full');
    expect(avatarMaskClass('rounded')).toBe('rounded-[28%]');
  });
});
