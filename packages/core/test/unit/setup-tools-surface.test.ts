import { describe, expect, it } from 'vitest';
import type { RunIdentity } from '../../src/agent/types.js';
import { buildSetupTools, type SetupToolFacade } from '../../src/tools/setup-tools.js';

const setup: SetupToolFacade = {
  saveProfile: () => ({ ok: true, message: 'saved' }),
  finishSetup: () => ({ ok: true, message: 'done' }),
  askQuestion: () => ({ ok: true, message: 'asked' }),
};

const identity: RunIdentity = {
  runId: 'run',
  botId: 'bot',
  conversationId: 'conv',
  loopType: 'turn',
};

describe('buildSetupTools surface', () => {
  it('keeps the interview questions on a direct chat', () => {
    expect(buildSetupTools({ identity, setup }).map((tool) => tool.name)).toEqual([
      'save_profile',
      'ask_question',
      'finish_setup',
    ]);
  });

  it('only lets a group interview save the profile', () => {
    expect(buildSetupTools({ identity, setup, surface: 'project' }).map((tool) => tool.name)).toEqual(
      ['save_profile'],
    );
  });
});
