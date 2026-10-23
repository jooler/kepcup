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

describe('skillSuggestion evidence gate (P0.1: the model cites, the code resolves and counts)', () => {
  const BOT = 'bot_1';
  const CONV = 'conv_1';

  interface FakeRun {
    id: string;
    botId: string | null;
    loopType: 'turn' | 'task' | 'reflection';
    status: 'completed' | 'failed';
    triggerMessageIds: string[];
  }
  interface FakeMessage {
    id: string;
    conversationId: string;
    runId: string | null;
    taskId: string | null;
    ownerBotId: string | null;
  }

  // 两个已完成的 turn run（a、b）：各有一条触发（用户）消息与一条产出（Bot）消息。
  const run = (id: string, over: Partial<FakeRun> = {}): FakeRun => ({
    id,
    botId: BOT,
    loopType: 'turn',
    status: 'completed',
    triggerMessageIds: [],
    ...over,
  });
  const message = (id: string, over: Partial<FakeMessage> = {}): FakeMessage => ({
    id,
    conversationId: CONV,
    runId: null,
    taskId: null,
    ownerBotId: null,
    ...over,
  });

  function fixture(extra: { runs?: FakeRun[]; messages?: FakeMessage[] } = {}) {
    const runs = new Map(
      [
        run('run_a', { triggerMessageIds: ['user_a'] }),
        run('run_b', { triggerMessageIds: ['user_b'] }),
        run('run_task', { loopType: 'task' }),
        run('run_failed', { status: 'failed' }),
        run('run_other_bot', { botId: 'bot_2' }),
        run('run_reflection', { loopType: 'reflection' }),
        ...(extra.runs ?? []),
      ].map((r) => [r.id, r]),
    );
    const messages = new Map(
      [
        message('user_a'),
        message('user_b'),
        message('bot_a', { runId: 'run_a' }),
        message('bot_b', { runId: 'run_b' }),
        message('task_event_t', { taskId: 'run_task', ownerBotId: BOT }),
        message('private_to_other', { runId: 'run_b', ownerBotId: 'bot_2' }),
        ...(extra.messages ?? []),
      ].map((m) => [m.id, m]),
    );
    const enqueued: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const logged: Array<{ meta: Record<string, unknown>; msg: string }> = [];
    const written: string[] = [];
    const deps = {
      logger: {
        info: (meta: Record<string, unknown>, msg: string) => logged.push({ meta, msg }),
        warn() {},
        error() {},
        debug() {},
      },
      memory: {
        writeReflectionMemory: async (
          _botId: string,
          _conversationId: string,
          input: { content: string },
        ) => {
          written.push(input.content);
          return { ok: true, item: null, reason: '' };
        },
        submitProfileProposal: () => ({ ok: true }),
      },
      jobs: {
        enqueue: (input: { type: string; payload: Record<string, unknown> }) => {
          enqueued.push(input);
        },
      },
      runs: {
        get: (id: string) => runs.get(id) ?? null,
        listByBotInConversation: (conversationId: string, botId: string) =>
          [...runs.values()].filter((r) => r.botId === botId && conversationId === CONV),
      },
      messages: { getById: (id: string) => messages.get(id) ?? null },
    };
    return { enqueued, logged, written, deps };
  }

  const suggestionOutput = (evidenceRefs?: string[]) =>
    reflectionOutputSchema.parse({
      ...base,
      profileProposals: [],
      skillSuggestion: {
        name: 'weekly-report',
        description: '按团队模板写周报',
        reason: '同类任务已完成多次',
        ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
      },
    });

  async function apply(refs: string[] | undefined) {
    const { enqueued, logged, deps } = fixture();
    await applyReflectionOutput(deps as never, BOT, CONV, 'run_b', [], suggestionOutput(refs));
    return { enqueued, logged };
  }

  it('enqueues with the verified distinct run ids when the refs resolve to enough runs', async () => {
    // 引用写法混用：run id、Bot 消息（经产出 run）、用户消息（经触发它的 run）、任务条目消息。
    const { enqueued } = await apply(['run_a', 'bot_b']);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.type).toBe('skill_suggestion');
    expect([...(enqueued[0]!.payload['evidenceRunIds'] as string[])].sort()).toEqual([
      'run_a',
      'run_b',
    ]);
    expect(enqueued[0]!.payload['name']).toBe('weekly-report');

    expect((await apply(['user_a', 'user_b'])).enqueued).toHaveLength(1);
    expect((await apply(['bot_a', 'task_event_t'])).enqueued).toHaveLength(1);
    expect((await apply(['run_task', 'run_a'])).enqueued).toHaveLength(1);
  });

  it('drops (logged, no error) when refs are duplicated, name one run twice, or stay below the threshold', async () => {
    const cases: string[][] = [
      [],
      ['run_a'],
      ['run_a', 'run_a'],
      // 同一 run 的触发消息 + 产出消息 + run id 本身：仍是 1 次成功。
      ['user_a', 'bot_a', 'run_a'],
      // 空白串与重复串不算。
      ['run_a', '  run_a  ', ''],
    ];
    for (const refs of cases) {
      const { enqueued, logged } = await apply(refs);
      expect(enqueued, JSON.stringify(refs)).toHaveLength(0);
      expect(logged.some((entry) => entry.msg.includes('fewer runs than the repeat threshold'))).toBe(
        true,
      );
    }
  });

  it('counts nothing for invented ids, other bots, failed / non-turn runs, or messages private to another bot', async () => {
    const cases: string[][] = [
      ['run_a', 'run_invented'],
      ['run_a', 'msg_invented'],
      ['run_a', 'run_other_bot'],
      ['run_a', 'run_failed'],
      ['run_a', 'run_reflection'],
      // 另一个 Bot 的私有条目不解析（它指向的 run_b 是本 Bot 的已完成 run，解析了就会凑够 2 个）。
      ['run_a', 'private_to_other'],
    ];
    for (const refs of cases) {
      const { enqueued } = await apply(refs);
      expect(enqueued, JSON.stringify(refs)).toHaveLength(0);
    }
  });

  it('a suggestion missing evidenceRefs still parses (never fails the whole reflection) and is dropped', async () => {
    const parsed = suggestionOutput(undefined);
    expect(parsed.skillSuggestion!.evidenceRefs).toEqual([]);
    // 其余产出不受影响：记忆照常写入，只丢掉这条建议。
    const { enqueued, logged, written, deps } = fixture();
    await applyReflectionOutput(deps as never, BOT, CONV, 'run_b', [], parsed);
    expect(written).toEqual(['用户在做 kepcup']);
    expect(enqueued).toHaveLength(0);
    expect(logged).toHaveLength(1);
  });

  it('only resolves a bounded number of refs', async () => {
    const refs = [...Array.from({ length: 12 }, (_, i) => `invented_${i}`), 'run_a', 'run_b'];
    // run_a / run_b 排在第 13、14 位，超出上限的引用不再解析。
    expect((await apply(refs)).enqueued).toHaveLength(0);
  });
});
