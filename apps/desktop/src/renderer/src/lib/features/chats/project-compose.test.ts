import { describe, expect, it } from 'vitest';
import {
  composeAddMember,
  composeBackToLead,
  composeCandidates,
  composeEnterAction,
  composePool,
  composeRemoveMember,
  composeSelectLead,
  stepHighlight,
  type ComposeState,
} from './project-compose';

/** Roster: a butler (systemRole='butler') plus four regular bots. */
const roster = [
  { id: 'butler', name: '管家', systemRole: 'butler' as const },
  { id: 'b1', name: 'Alice', systemRole: null },
  { id: 'b2', name: '阿甲', systemRole: null },
  { id: 'b3', name: 'alice', systemRole: null },
  { id: 'b4', name: 'Bob', systemRole: null },
];

/** The candidate pool (composePool result, no butler). */
const bots = roster.filter((bot) => bot.systemRole == null);

const emptyState: ComposeState = { phase: 'lead', leadId: null, memberIds: [] };

function enter(
  phase: ComposeState['phase'],
  query: string,
  state: { leadId: string | null; memberIds: string[] } = emptyState,
  highlight = -1,
): ReturnType<typeof composeEnterAction> {
  const excluded =
    phase === 'members' && state.leadId !== null
      ? [state.leadId, ...state.memberIds]
      : state.memberIds;
  return composeEnterAction({
    phase,
    query,
    bots,
    leadId: state.leadId,
    memberIds: state.memberIds,
    candidates: composeCandidates(bots, excluded, query),
    highlight,
  });
}

describe('composePool', () => {
  it('drops butlers from the roster (butlers never join a project)', () => {
    expect(composePool(roster).map((bot) => bot.id)).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(composePool(bots)).toEqual(bots);
  });
});

describe('composeCandidates', () => {
  it('drops excluded ids (the lead and chosen members) and filters by name, case-insensitively, keeping order', () => {
    expect(composeCandidates(bots, ['b1', 'b4'], '').map((bot) => bot.id)).toEqual(['b2', 'b3']);
    expect(composeCandidates(bots, [], ' ALI ').map((bot) => bot.id)).toEqual(['b1', 'b3']);
  });
});

describe('composeEnterAction · lead round', () => {
  it('picks the arrow-highlighted candidate as lead even when text was typed', () => {
    expect(enter('lead', '', emptyState, 2)).toEqual({ kind: 'selectLead', botId: 'b3' });
    // typed "ali" → candidates [b1, b3]; highlight 1 picks b3, not a new Bot "ali"
    expect(enter('lead', 'ali', emptyState, 1)).toEqual({ kind: 'selectLead', botId: 'b3' });
  });

  it('picks an existing Bot on an exact (trimmed, case-insensitive) name match', () => {
    expect(enter('lead', '  bob ')).toEqual({ kind: 'selectLead', botId: 'b4' });
    expect(enter('lead', 'ALICE')).toEqual({ kind: 'selectLead', botId: 'b1' });
  });

  it('creates a Bot as lead for a new name (partial matches do not count)', () => {
    expect(enter('lead', 'Carol', { leadId: null, memberIds: ['b1'] }, 5)).toEqual({
      kind: 'create',
      name: 'Carol',
    });
    expect(enter('lead', 'Al')).toEqual({ kind: 'create', name: 'Al' });
  });

  it('empty Enter asks for a lead', () => {
    expect(enter('lead', '')).toEqual({ kind: 'needLead' });
    expect(enter('lead', '   ')).toEqual({ kind: 'needLead' });
  });
});

describe('composeEnterAction · members round', () => {
  const state = { leadId: 'b1', memberIds: [] as string[] };

  it('adds the arrow-highlighted candidate from the filtered list', () => {
    // lead b1 excluded → candidates [b2, b3, b4]
    expect(enter('members', '', state, 0)).toEqual({ kind: 'add', botId: 'b2' });
    // typed "ali" → candidates [b3] (b1 is the lead)
    expect(enter('members', 'ali', state, 0)).toEqual({ kind: 'add', botId: 'b3' });
  });

  it('adds an existing Bot on an exact name match', () => {
    expect(enter('members', '  bob ', state)).toEqual({ kind: 'add', botId: 'b4' });
  });

  it('never creates a duplicate Bot when the name is the lead', () => {
    // Bob (b4) is the only same-name Bot → alreadySelected. A second same-name
    // Bot would still be added (round 2 keeps the old prefer-unpicked rule).
    expect(enter('members', '  BOB ', { leadId: 'b4', memberIds: [] })).toEqual({
      kind: 'alreadySelected',
      botId: 'b4',
    });
  });

  it('never creates a duplicate Bot when the name is a chosen member', () => {
    expect(enter('members', 'bob', { leadId: 'b1', memberIds: ['b4'] })).toEqual({
      kind: 'alreadySelected',
      botId: 'b4',
    });
  });

  it('creates a Bot as member for a new name', () => {
    expect(enter('members', 'Carol', state)).toEqual({ kind: 'create', name: 'Carol' });
  });

  it('empty Enter commits with at least one valid member, otherwise asks for more', () => {
    expect(enter('members', '', state)).toEqual({ kind: 'needMembers' });
    // A member deleted between the deletion event and the roster refresh does not count.
    expect(enter('members', '', { leadId: 'b1', memberIds: ['gone'] })).toEqual({
      kind: 'needMembers',
    });
    expect(enter('members', '', { leadId: 'b1', memberIds: ['b2'] })).toEqual({ kind: 'commit' });
  });
});

describe('compose state transitions', () => {
  it('composeSelectLead moves to the members round and removes the promoted Bot from the members', () => {
    expect(composeSelectLead({ ...emptyState, memberIds: ['b2', 'b3'] }, 'b2')).toEqual({
      phase: 'members',
      leadId: 'b2',
      memberIds: ['b3'],
    });
    expect(composeSelectLead(emptyState, 'b4')).toEqual({
      phase: 'members',
      leadId: 'b4',
      memberIds: [],
    });
  });

  it('composeBackToLead clears the lead and keeps the chosen members', () => {
    expect(composeBackToLead({ phase: 'members', leadId: 'b1', memberIds: ['b2'] })).toEqual({
      phase: 'lead',
      leadId: null,
      memberIds: ['b2'],
    });
  });

  it('composeAddMember is a no-op for the lead or an existing member and appends otherwise', () => {
    const state: ComposeState = { phase: 'members', leadId: 'b1', memberIds: ['b2'] };
    expect(composeAddMember(state, 'b1')).toEqual(state);
    expect(composeAddMember(state, 'b2')).toEqual(state);
    expect(composeAddMember(state, 'b3')).toEqual({
      phase: 'members',
      leadId: 'b1',
      memberIds: ['b2', 'b3'],
    });
  });

  it('composeRemoveMember drops only that member', () => {
    const state: ComposeState = { phase: 'members', leadId: 'b1', memberIds: ['b2', 'b3'] };
    expect(composeRemoveMember(state, 'b2')).toEqual({
      phase: 'members',
      leadId: 'b1',
      memberIds: ['b3'],
    });
    expect(composeRemoveMember(state, 'b1')).toEqual(state);
  });
});

describe('stepHighlight', () => {
  it('moves between -1 (none) and the last candidate without wrapping', () => {
    expect(stepHighlight(-1, 'down', 3)).toBe(0);
    expect(stepHighlight(2, 'down', 3)).toBe(2);
    expect(stepHighlight(0, 'up', 3)).toBe(-1);
    expect(stepHighlight(-1, 'up', 3)).toBe(-1);
    // list shrank under the highlight
    expect(stepHighlight(5, 'up', 3)).toBe(1);
    expect(stepHighlight(1, 'down', 0)).toBe(-1);
  });
});
