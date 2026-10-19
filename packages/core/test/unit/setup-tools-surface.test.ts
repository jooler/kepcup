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

  it('ask_question passes mode through (multi for list-style questions)', async () => {
    const seen: Array<{ question: string; options: string[]; mode?: 'single' | 'multi' }> = [];
    const capturing: SetupToolFacade = {
      ...setup,
      askQuestion: (_botId, input) => {
        seen.push({ ...input });
        return { ok: true, message: 'asked' };
      },
    };
    const ask = buildSetupTools({ identity, setup: capturing }).find(
      (tool) => tool.name === 'ask_question',
    )!;
    await ask.execute({ question: '买哪些？', options: ['苹果', '橙子'], mode: 'multi' }, {
      signal: new AbortController().signal,
    } as never);
    await ask.execute({ question: '用哪个？', options: ['甲', '乙'] }, {
      signal: new AbortController().signal,
    } as never);
    expect(seen).toEqual([
      { question: '买哪些？', options: ['苹果', '橙子'], mode: 'multi' },
      { question: '用哪个？', options: ['甲', '乙'], mode: 'single' },
    ]);
  });
});
