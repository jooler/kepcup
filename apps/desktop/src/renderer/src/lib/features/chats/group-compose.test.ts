import { describe, expect, it } from 'vitest';
import { composeCandidates, composeEnterAction, stepHighlight } from './group-compose';

const bots = [
  { id: 'b1', name: 'Alice' },
  { id: 'b2', name: '阿甲' },
  { id: 'b3', name: 'alice' },
  { id: 'b4', name: 'Bob' },
];

function enter(
  query: string,
  selectedIds: string[] = [],
  highlight = -1,
): ReturnType<typeof composeEnterAction> {
  return composeEnterAction({
    query,
    bots,
    selectedIds,
    candidates: composeCandidates(bots, selectedIds, query),
    highlight,
  });
}

describe('composeCandidates', () => {
  it('drops selected bots and filters by name, case-insensitively, keeping order', () => {
    expect(composeCandidates(bots, ['b1'], '').map((bot) => bot.id)).toEqual(['b2', 'b3', 'b4']);
    expect(composeCandidates(bots, [], ' ALI ').map((bot) => bot.id)).toEqual(['b1', 'b3']);
  });
});

describe('composeEnterAction', () => {
  it('adds the arrow-highlighted candidate even when text was typed', () => {
    expect(enter('', [], 2)).toEqual({ kind: 'add', botId: 'b3' });
    // typed "ali" → candidates [b1, b3]; highlight 1 picks b3, not a new Bot "ali"
    expect(enter('ali', [], 1)).toEqual({ kind: 'add', botId: 'b3' });
  });

  it('ignores an out-of-range highlight and falls back to the typed text', () => {
    expect(enter('Carol', [], 5)).toEqual({ kind: 'create', name: 'Carol' });
  });

  it('matches an existing name exactly, ignoring case and surrounding spaces', () => {
    expect(enter('  bob ')).toEqual({ kind: 'add', botId: 'b4' });
    expect(enter('ALICE')).toEqual({ kind: 'add', botId: 'b1' });
  });

  it('prefers an unselected same-name bot over a selected one', () => {
    expect(enter('ALICE', ['b1'])).toEqual({ kind: 'add', botId: 'b3' });
  });

  it('does not create a duplicate Bot when the exact name is already selected', () => {
    expect(enter('bob', ['b4'])).toEqual({ kind: 'alreadySelected', botId: 'b4' });
  });

  it('creates a Bot for a new name (partial matches do not count)', () => {
    expect(enter('Al')).toEqual({ kind: 'create', name: 'Al' });
  });

  it('empty Enter commits with ≥ 2 known members, otherwise asks for more', () => {
    expect(enter('')).toEqual({ kind: 'needMembers' });
    expect(enter('   ', ['b1'])).toEqual({ kind: 'needMembers' });
    expect(enter('', ['b1', 'gone'])).toEqual({ kind: 'needMembers' });
    expect(enter('', ['b1', 'b4'])).toEqual({ kind: 'commit' });
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
