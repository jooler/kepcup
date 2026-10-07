import { describe, expect, it } from 'vitest';

import { applyReflectionOutput } from '../../src/memory/reflection.js';
import { reflectionOutputSchema } from '../../src/memory/schemas.js';

const base = {
  runSummary: '记了一条工作信息',
  memories: [
    {
      kind: 'fact' as const,
      content: '用户在做 kepcup',
      source: 'explicit' as const,
      evidenceMessageIds: ['msg_1'],
      confidence: 0.9,
      sensitivity: 'normal' as const,
      privateToBot: false,
    },
  ],
  wikiSuggestions: [],
  skillSuggestion: null,
};

describe('reflection output (omitted confidence)', () => {
  it('parses a profile proposal that left confidence out', () => {
    const parsed = reflectionOutputSchema.parse({
      ...base,
      profileProposals: [
        {
          category: 'work',
          content: '用户在做 kepcup',
          source: 'explicit',
          evidenceMessageIds: ['msg_1'],
        },
      ],
    });
    expect(parsed.profileProposals[0]!.confidence).toBeUndefined();
    expect(parsed.memories[0]!.confidence).toBe(0.9);
    expect(parsed.runSummary).toBe('记了一条工作信息');
  });

  it('still rejects a confidence outside 0~1', () => {
    const parsed = reflectionOutputSchema.safeParse({
      ...base,
      profileProposals: [
        {
          category: 'work',
          content: '用户在做 kepcup',
          source: 'explicit',
          evidenceMessageIds: ['msg_1'],
          confidence: 2,
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('drops only the items that omitted confidence', async () => {
    const output = reflectionOutputSchema.parse({
      ...base,
      memories: [
        ...base.memories,
        {
          kind: 'preference',
          content: '用户喜欢深色主题',
          source: 'explicit',
          evidenceMessageIds: ['msg_1'],
          sensitivity: 'normal',
          privateToBot: false,
        },
      ],
      profileProposals: [
        {
          category: 'work',
          content: '用户在做 kepcup',
          source: 'explicit',
          evidenceMessageIds: ['msg_1'],
        },
        {
          category: 'work',
          content: '用户在做 kepcup',
          source: 'explicit',
          evidenceMessageIds: ['msg_1'],
          confidence: null,
        },
        {
          category: 'interests',
          content: '用户关注本地模型',
          source: 'inferred',
          evidenceMessageIds: ['msg_1'],
          confidence: 0.8,
        },
      ],
    });
    const written: Array<{ content: string; confidence: number }> = [];
    const proposed: Array<{ content: string; confidence: number }> = [];
    await applyReflectionOutput(
      {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        memory: {
          writeReflectionMemory: async (_botId, _conversationId, input) => {
            written.push({ content: input.content, confidence: input.confidence });
            return { ok: true, item: null, reason: '' };
          },
          submitProfileProposal: (_botId, input) => {
            proposed.push({ content: input.content, confidence: input.confidence });
            return { ok: true };
          },
        },
        jobs: { enqueue() {} },
      } as never,
      'bot_1',
      'conv_1',
      'run_1',
      [],
      output,
    );
    expect(written.map((item) => item.content)).toEqual(['用户在做 kepcup']);
    expect(proposed.map((item) => item.content)).toEqual(['用户关注本地模型']);
  });
});
