import { describe, expect, it } from 'vitest';
import { groupTitleFromMemberNames } from '../../src/domain/group-title.js';
import { botProfileSchema, isSparseBotProfile } from '../../src/domain/types.js';

describe('groupTitleFromMemberNames', () => {
  it('joins member names with a comma and a space', () => {
    expect(groupTitleFromMemberNames(['KepCup 开发助理', 'InkCop 开发助理'])).toBe(
      'KepCup 开发助理, InkCop 开发助理',
    );
  });

  it('drops names that would exceed the title limit', () => {
    const long = '名'.repeat(40);
    const title = groupTitleFromMemberNames([long, long, long]);
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title).toBe(`${long}, ${long}`);
  });

  it('truncates a single name that is already over the limit', () => {
    const title = groupTitleFromMemberNames(['名'.repeat(120)]);
    expect(title).toHaveLength(100);
  });
});

describe('isSparseBotProfile', () => {
  it('is sparse when only the name is set', () => {
    const profile = botProfileSchema.parse({ identity: { name: '咨询', bio: '' } });
    expect(isSparseBotProfile(profile)).toBe(true);
  });

  it('is not sparse once a role or bio is filled', () => {
    const profile = botProfileSchema.parse({
      identity: { name: '咨询', bio: '回答产品问题' },
    });
    expect(isSparseBotProfile(profile)).toBe(false);
  });
});
