import { describe, expect, it } from 'vitest';
import { groupMemberPlan, proposedMemberIds } from './project-members';

describe('group member card plan (D89 review)', () => {
  it('a bot prefill only adds: existing members stay checked, nothing is removed', () => {
    const plan = groupMemberPlan(['a', 'b'], proposedMemberIds({ bots: ['new'] }), {});
    expect(['a', 'b', 'new'].map(plan.checked)).toEqual([true, true, true]);
    expect(plan.toAdd).toEqual(['new']);
    expect(plan.toRemove).toEqual([]);
    expect(plan.count).toBe(3);
  });

  it('a prefill that leaves members out still cannot remove them', () => {
    const plan = groupMemberPlan(['a', 'b'], proposedMemberIds({ bots: ['a'] }), {});
    expect(plan.toRemove).toEqual([]);
    expect(plan.toAdd).toEqual([]);
  });

  it('removal only comes from the user unchecking a member', () => {
    const plan = groupMemberPlan(['a', 'b'], ['new'], { b: false, new: false });
    expect(plan.toRemove).toEqual(['b']);
    expect(plan.toAdd).toEqual([]);
    expect(plan.count).toBe(1);
  });

  it('a member added elsewhere while the card is open is not removed on apply', () => {
    const choices = { c: true };
    expect(groupMemberPlan(['a'], [], choices)).toMatchObject({ toAdd: ['c'], toRemove: [] });
    // Someone else added `late` (and `c`) in the meantime.
    expect(groupMemberPlan(['a', 'late', 'c'], [], choices)).toMatchObject({
      toAdd: [],
      toRemove: [],
    });
  });

  it('ignores malformed prefills', () => {
    expect(proposedMemberIds({ bots: 'x' })).toEqual([]);
    expect(proposedMemberIds({ bots: ['x', 1, 'x'] })).toEqual(['x']);
    expect(proposedMemberIds(null)).toEqual([]);
  });
});
