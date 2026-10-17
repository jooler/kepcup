import { afterEach, describe, expect, it } from 'vitest';
import type { Episode, Run } from '@kepcup/shared';
import {
  createTestStack,
  listAllMessages,
  listMessages,
  makeBot,
  makeProject,
  sendDrafts,
  step,
  waitFor,
  type CoreHarness,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';

/**
 * episodes.* RPC（D92 T1a WP2，todo/project/WP2-episodes.md 步骤 3.6）：
 * episodes.get（找不到 → NOT_FOUND）、episodes.resume（非暂停 → INVALID_INPUT；
 * 暂停回合经 RPC 继续、被暂扣的触发补投）、episodes.stop（幂等，内部
 * episode_stopped 只进 Bot 上下文），以及 episode.updated 事件随回合状态
 * 变化推送。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

function systemText(request: MockChatRequest): string {
  const first = request.body.messages?.[0];
  return typeof first?.content === 'string' ? first.content : '';
}
const isBot = (name: string) => (request: MockChatRequest) =>
  systemText(request).includes(`名字：${name}`);

function turnRunsOf(stack: TestStack, conversationId: string, botId: string): Run[] {
  return stack.core.services
    .domain!.runs.listByConversation(conversationId, 100)
    .filter((run) => run.loopType === 'turn' && run.botId === botId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

interface EpisodeRow {
  id: string;
  status: string;
}

function episodeRows(core: CoreHarness, conversationId: string): EpisodeRow[] {
  return core.services.mainDb!
    .prepare('select * from episodes where conversation_id = ?')
    .all(conversationId) as EpisodeRow[];
}

async function waitIdle(stack: TestStack, botId: string, conversationId: string): Promise<void> {
  await waitFor(
    () => (stack.core.services.orchestrator!.isMailboxIdle(botId, conversationId) ? true : null),
    { label: 'mailbox idle', timeoutMs: 20_000 },
  );
}

/** A @ B once: opens one active episode (hop 1) and lets both turns finish. */
async function openOneHopEpisode(
  stack: TestStack,
): Promise<{ conversationId: string; aId: string; bId: string; episodeId: string }> {
  const { core, llm } = stack;
  const a = await makeBot(core, '阿甲');
  const b = await makeBot(core, '阿乙');
  const conv = await makeProject(core, '回合 RPC', [a.id, b.id], { leadBotId: a.id });
  llm.script('mock-main', [
    step().inTurn().expect(isBot('阿甲')).replyToolCall('send_message', {
      text: '请阿乙看看',
      mention_bot_ids: [b.id],
    }),
    step().inTurn().expect(isBot('阿甲')).replyText('甲已完成'),
    step().inTurn().expect(isBot('阿乙')).replyText('乙已看到'),
  ]);
  await sendDrafts(core, conv.id, [{ text: '开始', mentions: [a.id] }]);
  const row = await waitFor(
    () => episodeRows(core, conv.id).find((r) => r.status === 'active') ?? null,
    { label: 'active episode row', timeoutMs: 30_000 },
  );
  await waitIdle(stack, a.id, conv.id);
  await waitIdle(stack, b.id, conv.id);
  return { conversationId: conv.id, aId: a.id, bId: b.id, episodeId: row.id };
}

describe('episodes.* RPC', () => {
  it('get returns the episode; unknown id is NOT_FOUND; resume refuses a non-paused round', async () => {
    const stack = await start();
    const { conversationId, episodeId } = await openOneHopEpisode(stack);
    const core = stack.core;

    await expect(core.rpc.call('episodes.get', { id: 'epi_none' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const got = (await core.rpc.call('episodes.get', { id: episodeId })) as { episode: Episode };
    expect(got.episode).toMatchObject({
      id: episodeId,
      conversationId,
      status: 'active',
      hops: 1,
      pendingCount: 0,
    });
    expect(got.episode.pausedAt).toBeNull();

    await expect(core.rpc.call('episodes.resume', { id: episodeId })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(core.rpc.call('episodes.resume', { id: 'epi_none' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  }, 60_000);

  it('stop stops the round idempotently and publishes episode.updated', async () => {
    const stack = await start();
    const { core } = stack;
    const { conversationId, episodeId } = await openOneHopEpisode(stack);

    const updated: Episode[] = [];
    core.onEvent('episode.updated', ({ episode }) => updated.push(episode));

    const stopped = (await core.rpc.call('episodes.stop', { id: episodeId })) as {
      episode: Episode;
    };
    expect(stopped.episode).toMatchObject({ id: episodeId, status: 'stopped', pendingCount: 0 });
    // Stopping an already stopped round is idempotent.
    const again = (await core.rpc.call('episodes.stop', { id: episodeId })) as {
      episode: Episode;
    };
    expect(again.episode.status).toBe('stopped');
    await expect(core.rpc.call('episodes.stop', { id: 'epi_none' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // episode.updated rides along with every transition the subscription saw:
    // both stops publish (the round-open happened before this subscription).
    await waitFor(() => (updated.length >= 2 ? true : null), { label: 'episode.updated payloads' });
    expect(updated).toHaveLength(2);
    expect(updated[0]).toMatchObject({ id: episodeId, status: 'stopped' });
    expect(updated[1]).toMatchObject({ id: episodeId, status: 'stopped' });

    // episode_stopped is internal: in the bot-facing history, not user-visible.
    const all = await listAllMessages(core, conversationId);
    expect(
      all.some(
        (m) =>
          m.kind === 'system_event' && (m.content as { event?: string }).event === 'episode_stopped',
      ),
    ).toBe(true);
    const visible = await listMessages(core, conversationId);
    expect(
      visible.some(
        (m) =>
          m.kind === 'system_event' && (m.content as { event?: string }).event === 'episode_stopped',
      ),
    ).toBe(false);
  }, 60_000);

  it('resume re-opens a breaker-paused round and delivers its kept trigger', async () => {
    // Pair breaker at 2: the third A→B trigger pauses the round.
    const stack = await createTestStack({ env: { KEPCUP_EPISODE_PAIR_BREAKER: '2' } });
    stacks.push(stack);
    const { core, llm } = stack;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const conv = await makeProject(core, '回合继续', [a.id, b.id], { leadBotId: a.id });
    await core.rpc.call('settings.update', { providerConcurrency: { default: 4, 'custom:mock': 1 } });
    llm.script('mock-main', [
      step().inTurn().expect(isBot('阿甲')).replyToolCall('send_message', {
        text: '第一轮请阿乙看',
        mention_bot_ids: [b.id],
      }),
      step().inTurn().expect(isBot('阿甲')).replyText('甲第一轮完成'),
      step().inTurn().expect(isBot('阿乙')).replyToolCall('send_message', {
        text: '阿甲请复核',
        mention_bot_ids: [a.id],
      }),
      step().inTurn().expect(isBot('阿乙')).replyText('乙第一轮完成'),
      step().inTurn().expect(isBot('阿甲')).replyToolCall('send_message', {
        text: '再请阿乙看',
        mention_bot_ids: [b.id],
      }),
      step().inTurn().expect(isBot('阿甲')).replyText('甲第二轮完成'),
    ]);
    await sendDrafts(core, conv.id, [{ text: '开始协作', mentions: [a.id] }]);
    const paused = await waitFor(
      () => episodeRows(core, conv.id).find((r) => r.status === 'paused') ?? null,
      { label: 'paused episode row', timeoutMs: 30_000 },
    );
    await waitIdle(stack, a.id, conv.id);
    await waitIdle(stack, b.id, conv.id);
    expect(turnRunsOf(stack, conv.id, b.id)).toHaveLength(1);

    llm.script('mock-main', [step().inTurn().expect(isBot('阿乙')).replyText('乙补投已收到')]);
    const resumed = (await core.rpc.call('episodes.resume', { id: paused.id })) as {
      episode: Episode;
    };
    expect(resumed.episode).toMatchObject({ id: paused.id, status: 'active', hops: 0 });

    // The kept trigger reaches B as a bot_mention turn on the same episode.
    await waitFor(
      () =>
        turnRunsOf(stack, conv.id, b.id).find(
          (run) =>
            run.status === 'completed' &&
            run.triggerReason === 'bot_mention' &&
            run.episodeHop === 3,
        ) ?? null,
      { label: 'B resumed turn', timeoutMs: 20_000 },
    );
    expect(episodeRows(core, conv.id)).toHaveLength(1);
  }, 60_000);
});
