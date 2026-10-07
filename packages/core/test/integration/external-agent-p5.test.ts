import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, Run, UsageSummaryEntry } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAgentEntry,
  fakeAgentSpawner,
  listMessages,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  waitFor,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
  type TestStack,
} from '@kepcup/testkit';

/**
 * P5 第二部分经 orchestrator 的端到端（todo §8.1 / §8.2「30 分钟内连续两问
 * 复用会话」）：agent_sessions 读写与增量对话段、run 外不重发会话级提示词、
 * 删除对话 → session/delete + 删行、用量页单列外部 Agent、被拒的 steering
 * 在 run 结束后续投不丢。
 */

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

const CLAUDE_MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'acceptEdits', name: 'Accept Edits' },
  ],
};

async function start(
  scripts: Record<string, FakeAgentScript | FakeAgentScript[]>,
  extra: ReturnType<typeof fakeAgentEntry>[] = [],
) {
  const started: FakeAcpAgentHandle[] = [];
  const stack = await createTestStack({
    ...(extra.length > 0 ? { agentCatalog: extra } : {}),
    agentLaunch: () => ({ command: 'in-process', args: [], env: {} }),
    agentSpawn: fakeAgentSpawner(scripts, started) as never,
  });
  stacks.push(stack);
  await stack.core.rpc.call('settings.update', {
    experimental: { externalAgents: true },
    agents: Object.fromEntries(Object.keys(scripts).map((id) => [id, { enabled: true }])),
  });
  return { stack, started };
}

async function agentBot(stack: TestStack, agentId: string): Promise<Bot> {
  const bot = await makeBot(stack.core, '外援');
  const profile = {
    ...bot.profile,
    runtime: { ...bot.profile.runtime, agent: { ...bot.profile.runtime.agent, id: agentId } },
  };
  return ((await stack.core.rpc.call('bots.update', { id: bot.id, profile })) as { bot: Bot }).bot;
}

function completedRuns(runs: Run[]): Run[] {
  return runs
    .filter((run) => run.loopType === 'response' && run.status === 'completed')
    .sort((a, b) => a.createdAt - b.createdAt);
}

async function waitForCompleted(stack: TestStack, conversationId: string, count: number) {
  return waitFor(
    async () => {
      const runs = completedRuns(await listRuns(stack.core, conversationId));
      return runs.length >= count ? runs : null;
    },
    { label: `${count} completed runs` },
  );
}

describe('external agent session reuse through the orchestrator (P5)', () => {
  it('a second question reuses the session with the delta only; deletion deletes it', async () => {
    const { stack, started } = await start({
      fake: {
        sessionDelete: true,
        turns: [
          agentTurn().text('第一答').usage({ inputTokens: 50, outputTokens: 5, totalTokens: 55 }),
          agentTurn().text('第二答'),
        ],
      },
    });
    const bot = await agentBot(stack, 'fake');
    const conv = await openDirect(stack.core, bot.id);

    await sendBatch(stack.core, conv.id, ['第一问：天空为什么是蓝的']);
    await waitForCompleted(stack, conv.id, 1);
    await sendBatch(stack.core, conv.id, ['第二问：那晚霞呢']);
    const runs = await waitForCompleted(stack, conv.id, 2);

    expect(runs.map((run) => run.agentSessionId)).toEqual(['fake-session-1', 'fake-session-1']);
    const observed = started[0]!.observed;
    expect(observed.sessions).toHaveLength(1);
    const [first, second] = observed.prompts;
    expect(first!.text).toContain('<platform_rules');
    expect(first!.text).toContain('第一问');
    // Reused: no session prompt, no replay of what the session already saw.
    expect(second!.text).not.toContain('<platform_rules');
    expect(second!.text).not.toContain('第一问');
    expect(second!.text).not.toContain('第一答');
    expect(second!.text).toContain('第二问');

    const steps = (await stack.core.rpc.call('runs.steps', { runId: runs[1]!.id })) as {
      steps: Array<{ type: string; payload: { session?: string } }>;
    };
    expect(steps.steps.find((step) => step.type === 'request')!.payload.session).toBe('reused');

    // Usage: external agents listed apart (turns; tokens when reported).
    const summary = (await stack.core.rpc.call('usage.summary', { days: 1 })) as {
      entries: UsageSummaryEntry[];
    };
    const agentRows = summary.entries.filter((entry) => entry.agentId === 'fake');
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]).toMatchObject({
      turns: 2,
      inputTokens: 50,
      outputTokens: 5,
      costUsd: null,
    });

    await stack.core.rpc.call('conversations.delete', { id: conv.id });
    await waitFor(() => (observed.deletedSessions.length === 1 ? true : null), {
      label: 'session/delete',
    });
    expect(observed.deletedSessions).toEqual(['fake-session-1']);
  }, 30_000);

  it('messages from others since the last run reach the reused session as a delta', async () => {
    const { stack, started } = await start({
      fake: { turns: [agentTurn().text('收到'), agentTurn().text('再收到')] },
    });
    const bot = await agentBot(stack, 'fake');
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['甲']);
    await waitForCompleted(stack, conv.id, 1);
    await sendBatch(stack.core, conv.id, ['乙']);
    await waitForCompleted(stack, conv.id, 2);
    const prompts = started[0]!.observed.prompts;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.text).toContain('乙');
    expect(prompts[1]!.text).not.toContain('甲');
    expect(started[0]!.observed.sessions).toHaveLength(1);
    const texts = (await listMessages(stack.core, conv.id))
      .filter((message) => message.senderBotId === bot.id)
      .map((message) => ('text' in message.content ? message.content.text : ''));
    expect(texts).toEqual(['收到', '再收到']);
  }, 30_000);

  it('a steer the agent refuses is re-delivered as a new run after the current one', async () => {
    const entry = fakeAgentEntry('fake-steer', { provider: 'claude' });
    const { stack, started } = await start(
      {
        'fake-steer': {
          steering: true,
          steeringOutcome: 'promptRequired',
          modes: CLAUDE_MODES,
          turns: [agentTurn().sleep(600).text('先答第一条'), agentTurn().text('再答第二条')],
        },
      },
      [entry],
    );
    const bot = await agentBot(stack, 'fake-steer');
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['第一条']);
    await waitFor(() => (started[0]?.observed.prompts.length === 1 ? true : null), {
      label: 'first prompt',
    });
    await sendBatch(stack.core, conv.id, ['第二条']);
    await waitFor(() => (started[0]!.observed.steerings.length === 1 ? true : null), {
      label: 'steering attempted',
    });
    const runs = await waitForCompleted(stack, conv.id, 2);
    expect(runs).toHaveLength(2);
    expect(started[0]!.observed.prompts[1]!.text).toContain('第二条');
    const texts = (await listMessages(stack.core, conv.id))
      .filter((message) => message.senderBotId === bot.id)
      .map((message) => ('text' in message.content ? message.content.text : ''));
    expect(texts).toEqual(['先答第一条', '再答第二条']);
  }, 30_000);
});
