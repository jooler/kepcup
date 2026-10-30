import { describe, expect, it } from 'vitest';
import { PROJECT_MEMBER_PREVIEW_MAX } from '@kepcup/shared';
import { memberPreviewOf, memberPreviewsOf, withUpdatedBot } from './member-preview';

/**
 * 成员预览映射：core 与本地的三处重建必须产出同一形状（含遮罩），
 * 否则加 / 减成员或 bot.updated 之后群头像会掉回圆形。
 */

describe('memberPreviewOf', () => {
  it('carries the mask and normalizes missing / unknown values to circle', () => {
    expect(
      memberPreviewOf({ id: 'bot_a', name: '甲', avatar: 'upload:a.png', avatarMask: 'rounded' }),
    ).toEqual({ id: 'bot_a', name: '甲', avatar: 'upload:a.png', avatarMask: 'rounded' });
    expect(memberPreviewOf({ id: 'bot_b', name: '乙', avatar: null })).toEqual({
      id: 'bot_b',
      name: '乙',
      avatar: null,
      avatarMask: 'circle',
    });
    expect(
      memberPreviewOf({ id: 'bot_c', name: '丙', avatar: null, avatarMask: null }).avatarMask,
    ).toBe('circle');
  });
});

describe('memberPreviewsOf', () => {
  it('keeps order and the mask, and caps at the shared preview limit', () => {
    const members = Array.from({ length: PROJECT_MEMBER_PREVIEW_MAX + 3 }, (_, index) => ({
      bot: {
        id: `bot_${index}`,
        name: `Bot ${index}`,
        avatar: `upload:${index}.png`,
        avatarMask: index % 2 === 0 ? ('rounded' as const) : ('circle' as const),
      },
    }));
    const previews = memberPreviewsOf(members);
    expect(previews).toHaveLength(PROJECT_MEMBER_PREVIEW_MAX);
    expect(previews.map((preview) => preview.id)).toEqual(
      members.slice(0, PROJECT_MEMBER_PREVIEW_MAX).map((member) => member.bot.id),
    );
    expect(previews[0]).toMatchObject({ avatarMask: 'rounded' });
    expect(previews[1]).toMatchObject({ avatarMask: 'circle' });
  });
});

describe('withUpdatedBot', () => {
  it('replaces only the updated bot and keeps the rest untouched', () => {
    const previews = [
      { id: 'bot_a', name: '甲', avatar: null, avatarMask: 'circle' as const },
      { id: 'bot_b', name: '乙', avatar: null, avatarMask: 'circle' as const },
    ];
    const next = withUpdatedBot(previews, {
      id: 'bot_b',
      name: '乙（改名）',
      avatar: 'upload:b.png',
      avatarMask: 'rounded',
    });
    expect(next).toEqual([
      previews[0],
      { id: 'bot_b', name: '乙（改名）', avatar: 'upload:b.png', avatarMask: 'rounded' },
    ]);
    // 不在预览里的 Bot（未进前 N 名）不改变列表。
    expect(withUpdatedBot(previews, { id: 'bot_z', name: 'Z', avatar: null })).toEqual(previews);
  });
});
