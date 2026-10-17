import { describe, expect, it } from 'vitest';
import {
  PROJECT_MODULES,
  canManageEntry,
  canWriteModule,
  type ProjectActor,
  type ProjectModuleId,
} from '../../src/domain/project-modules.js';

/**
 * Table-driven coverage of the module registry (README §4.13): every
 * actor × module cell for canWriteModule, plus the canManageEntry matrix.
 */

const WRITE_TABLE: Array<[ProjectModuleId, Record<ProjectActor, boolean>]> = [
  ['chat', { user: true, lead: true, member: true }],
  ['wiki', { user: true, lead: true, member: false }],
  ['board', { user: true, lead: true, member: false }],
  ['okr', { user: true, lead: true, member: false }],
  ['calendar', { user: true, lead: true, member: false }],
];

describe('canWriteModule', () => {
  it.each(WRITE_TABLE)('%s: %s', (moduleId, expected) => {
    for (const actor of ['user', 'lead', 'member'] as const) {
      expect(canWriteModule(moduleId, actor)).toBe(expected[actor]);
    }
  });

  it('matches the declared registry', () => {
    // The table above must cover exactly the registry, with the documented
    // write levels: chat 'members', wiki 'owner', the planned trio 'lead'.
    expect(PROJECT_MODULES.map((m) => [m.id, m.write, m.status])).toEqual([
      ['chat', 'members', 'available'],
      ['wiki', 'owner', 'available'],
      ['board', 'lead', 'planned'],
      ['okr', 'lead', 'planned'],
      ['calendar', 'lead', 'planned'],
    ]);
  });

  it('returns false for an unknown module id', () => {
    expect(canWriteModule('nope' as ProjectModuleId, 'user')).toBe(false);
  });
});

describe('canManageEntry', () => {
  it('user and lead manage every entry of an owner module', () => {
    for (const actor of ['user', 'lead'] as const) {
      expect(canManageEntry('wiki', actor, { kind: 'user' })).toBe(true);
      expect(canManageEntry('wiki', actor, { kind: 'bot', id: 'bot_other' })).toBe(true);
    }
  });

  it('a member manages only its own bot entries in an owner module', () => {
    expect(canManageEntry('wiki', 'member', { kind: 'bot', id: 'bot_me' }, 'bot_me')).toBe(true);
    expect(canManageEntry('wiki', 'member', { kind: 'bot', id: 'bot_other' }, 'bot_me')).toBe(
      false,
    );
    expect(canManageEntry('wiki', 'member', { kind: 'user' }, 'bot_me')).toBe(false);
    // No actor bot id: never its own entry.
    expect(canManageEntry('wiki', 'member', { kind: 'bot', id: 'bot_me' })).toBe(false);
  });

  it('falls back to canWriteModule for non-owner modules', () => {
    expect(canManageEntry('chat', 'member', { kind: 'bot', id: 'bot_other' })).toBe(true);
    expect(canManageEntry('board', 'member', { kind: 'bot', id: 'bot_me' }, 'bot_me')).toBe(false);
    expect(canManageEntry('board', 'lead', { kind: 'bot', id: 'bot_other' })).toBe(true);
  });
});
