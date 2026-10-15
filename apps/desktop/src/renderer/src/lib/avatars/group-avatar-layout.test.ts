import { describe, expect, it } from 'vitest';
import { GROUP_MEMBER_PREVIEW_MAX } from '@kepcup/shared';
import {
  GROUP_AVATAR_USER_ID,
  groupAvatarFaces,
  groupAvatarSlots,
  shadowOffsetTowardCenter,
} from './group-avatar-layout';

describe('groupAvatarSlots', () => {
  it('places two avatars side by side with overlap room', () => {
    const slots = groupAvatarSlots(2, 'a|b');
    expect(slots).toHaveLength(2);
    expect(slots[0]!.y).toBe(slots[1]!.y);
    expect(slots[0]!.x).toBeLessThan(slots[1]!.x);
    expect(slots[0]!.size).toBeGreaterThan(60);
  });

  it('places three avatars in a triangle, one above two', () => {
    const slots = groupAvatarSlots(3, 'a|b|c');
    expect(slots).toHaveLength(3);
    const [top, left, right] = slots;
    expect(top!.y).toBeLessThan(left!.y);
    expect(top!.y).toBeLessThan(right!.y);
    expect(left!.x).toBeLessThan(right!.x);
    expect(top!.z).toBeGreaterThan(left!.z);
    expect(top!.size).toBeGreaterThan(60);
  });

  it('places four avatars in a two-by-two grid', () => {
    const slots = groupAvatarSlots(4, 'a|b|c|d');
    expect(slots.map((slot) => [slot.x, slot.y])).toEqual([
      [32, 32],
      [68, 32],
      [32, 68],
      [68, 68],
    ]);
    expect(slots.every((slot) => slot.size === 60)).toBe(true);
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
    expect(min).toBeGreaterThanOrEqual(58);
  });

  it('keeps every tile inside the container for any group size and seed', () => {
    for (let total = 1; total <= GROUP_MEMBER_PREVIEW_MAX; total += 1) {
      for (const seed of ['a', 'b|c', 'seed-3', 'x'.repeat(20)]) {
        for (const slot of groupAvatarSlots(total, seed)) {
          const half = slot.size / 2;
          expect(slot.x - half).toBeGreaterThanOrEqual(-1e-9);
          expect(slot.x + half).toBeLessThanOrEqual(100 + 1e-9);
          expect(slot.y - half).toBeGreaterThanOrEqual(-1e-9);
          expect(slot.y + half).toBeLessThanOrEqual(100 + 1e-9);
        }
      }
    }
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

describe('shadowOffsetTowardCenter', () => {
  it('points one unit toward the mosaic center', () => {
    const offset = shadowOffsetTowardCenter({ x: 32, y: 32 });
    expect(offset.x).toBeCloseTo(Math.SQRT1_2, 5);
    expect(offset.y).toBeCloseTo(Math.SQRT1_2, 5);
    expect(Math.hypot(offset.x, offset.y)).toBeCloseTo(1, 5);
  });

  it('falls back slightly downward when already centered', () => {
    expect(shadowOffsetTowardCenter({ x: 50, y: 50 })).toEqual({ x: 0, y: 1 });
  });
});

describe('GROUP_AVATAR_USER_ID', () => {
  it('is a stable reserved id', () => {
    expect(GROUP_AVATAR_USER_ID).toBe('__user__');
  });
});

describe('groupAvatarFaces', () => {
  const user = { id: GROUP_AVATAR_USER_ID };
  const bot = (id: string) => ({ id });

  it('puts the user first, then the bots', () => {
    expect(groupAvatarFaces([bot('a'), bot('b')], user).map((face) => face.id)).toEqual([
      GROUP_AVATAR_USER_ID,
      'a',
      'b',
    ]);
  });

  it('returns nothing when no bot is known, so the caller draws the default group icon', () => {
    expect(groupAvatarFaces([], user)).toEqual([]);
    expect(groupAvatarFaces([user], user)).toEqual([]);
  });

  it('omits the user when none is given and never duplicates one in the members', () => {
    expect(groupAvatarFaces([bot('a'), user], null).map((face) => face.id)).toEqual(['a']);
    expect(groupAvatarFaces([user, bot('a')], user).map((face) => face.id)).toEqual([
      GROUP_AVATAR_USER_ID,
      'a',
    ]);
  });

  it('caps the total, user included, at GROUP_MEMBER_PREVIEW_MAX', () => {
    const many = Array.from({ length: GROUP_MEMBER_PREVIEW_MAX + 5 }, (_, i) => bot(`b${i}`));
    const faces = groupAvatarFaces(many, user);
    expect(faces).toHaveLength(GROUP_MEMBER_PREVIEW_MAX);
    expect(faces[0]!.id).toBe(GROUP_AVATAR_USER_ID);
  });
});
