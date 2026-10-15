import { describe, expect, it } from 'vitest';
import { GROUP_MEMBER_PREVIEW_MAX } from '@kepcup/shared';
import { groupAvatarSlots } from './group-avatar-layout';

describe('groupAvatarSlots', () => {
  it('places two avatars side by side', () => {
    const slots = groupAvatarSlots(2, 'a|b');
    expect(slots).toHaveLength(2);
    expect(slots[0]!.y).toBe(slots[1]!.y);
    expect(slots[0]!.x).toBeLessThan(slots[1]!.x);
  });

  it('places three avatars in a triangle, one above two', () => {
    const slots = groupAvatarSlots(3, 'a|b|c');
    expect(slots).toHaveLength(3);
    const [top, left, right] = slots;
    expect(top!.y).toBeLessThan(left!.y);
    expect(top!.y).toBeLessThan(right!.y);
    expect(left!.x).toBeLessThan(right!.x);
    expect(top!.z).toBeGreaterThan(left!.z);
  });

  it('places four avatars in a two-by-two grid', () => {
    const slots = groupAvatarSlots(4, 'a|b|c|d');
    expect(slots.map((slot) => [slot.x, slot.y])).toEqual([
      [30, 30],
      [70, 30],
      [30, 70],
      [70, 70],
    ]);
  });

  it('keeps five-or-more sizes within 20% and stable for the same seed', () => {
    const first = groupAvatarSlots(6, 'm1|m2|m3|m4|m5|m6');
    const again = groupAvatarSlots(6, 'm1|m2|m3|m4|m5|m6');
    expect(again).toEqual(first);
    const sizes = first.map((slot) => slot.size);
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    expect(max / min).toBeLessThanOrEqual(1.2 + 1e-9);
    expect(new Set(first.map((slot) => slot.z)).size).toBe(6);
  });

  it('caps a large group at GROUP_MEMBER_PREVIEW_MAX slots', () => {
    expect(GROUP_MEMBER_PREVIEW_MAX).toBeLessThanOrEqual(9);
    const seed = Array.from({ length: 50 }, (_, i) => `m${i}`).join('|');
    const slots = groupAvatarSlots(50, seed);
    expect(slots).toHaveLength(GROUP_MEMBER_PREVIEW_MAX);
    expect(new Set(slots.map((slot) => slot.z)).size).toBe(GROUP_MEMBER_PREVIEW_MAX);
    expect(groupAvatarSlots(0, '')).toEqual([]);
  });
});
