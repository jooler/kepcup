import { afterEach, describe, expect, it } from 'vitest';
import type { Episode, Message, Run } from '@kepcup/shared';
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
 * 协作熔断端到端（D92 T1a WP2，todo/project/WP2-episodes.md §5）：经
 * KEPCUP_EPISODE_PAIR_BREAKER 注入小阈值，脚本化两个 Bot 来回 @——第 3 次
 * 同对触发熔断：恰好一条用户可见的 episode_paused 卡（带 episodeId）、回合
 * paused 且被暂停的触发不丢（pending）；RPC episodes.resume 按序补投、Bot
 * 继续响应；episodes.stop 之后状态 stopped、pending 清空、不再投递。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack({ env: { KEPCUP_EPISODE_PAIR_BREAKER: '2' } });
  stacks.push(stack);
  return stack;
}

function orchestrator(stack: { core: CoreHarness }) {
  return stack.core.services.orchestrator!;
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

function episodeRows(core: CoreHarness, conversationId: string): EpisodeRow[] {
  return core.services.mainDb!
    .prepare('select * from episodes where conversation_id = ?')
    .all(conversationId) as EpisodeRow[];
}

interface EpisodeRow {
  id: string;
  status: string;
  hops: number;
  pending_json: string;
}

function pauseCards(messages: Message[]): Message[] {
  return messages.filter(
    (m) => m.kind === 'system_event' && (m.content as { event?: string }).event === 'episode_paused',
  );
}

async function waitIdle(stack: TestStack, botId: string, conversationId: string): Promise<void> {
  await waitFor(() => (orchestrator(stack).isMailboxIdle(botId, conversationId) ? true : null), {
    label: 'mailbox idle',
    timeoutMs: 20_000,
  });
}

/**
 * Scripts one A↔B ping-pong up to the tripping trigger: A @ B (pair trigger 1)
 * → B @ A (pair trigger 2) → A @ B again — the pair's third trigger pauses the
 * episode (KEPCUP_EPISODE_PAIR_BREAKER = 2).
 */
function pingPongScript(aName: string, bName: string, aId: string, bId: string) {
  return [
    step().inTurn().expect(isBot(aName)).replyToolCall('send_message', {
      text: '第一轮请阿乙看',
      mention_bot_ids: [bId],
    }),
    step().inTurn().expect(isBot(aName)).replyText(`${aName}第一轮完成`),
    step().inTurn().expect(isBot(bName)).replyToolCall('send_message', {
      text: '阿甲请复核',
      mention_bot_ids: [aId],
    }),
    step().inTurn().expect(isBot(bName)).replyText(`${bName}第一轮完成`),
    step().inTurn().expect(isBot(aName)).replyToolCall('send_message', {
      text: '再请阿乙看',
      mention_bot_ids: [bId],
    }),
    step().inTurn().expect(isBot(aName)).replyText(`${aName}第二轮完成`),
  ];
}

/** Runs one full ping-pong until the breaker pauses the episode, then quiesces. */
async function tripBreaker(
  stack: TestStack,
): Promise<{ conversationId: string; aId: string; bId: string; episodeId: string }> {
  const { core, llm } = stack;
  const a = await makeBot(core, '阿甲');
  const b = await makeBot(core, '阿乙');
  const conv = await makeProject(core, '熔断协作', [a.id, b.id], { leadBotId: a.id });
  await core.rpc.call('settings.update', { providerConcurrency: { default: 4, 'custom:mock': 1 } });
  llm.script('mock-main', pingPongScript('阿甲', '阿乙', a.id, b.id));
  await sendDrafts(core, conv.id, [{ text: '开始协作', mentions: [a.id] }]);
  const row = await waitFor(
    () => episodeRows(core, conv.id).find((r) => r.status === 'paused') ?? null,
    { label: 'paused episode row', timeoutMs: 30_000 },
  );
  await waitIdle(stack, a.id, conv.id);
  await waitIdle(stack, b.id, conv.id);
  return { conversationId: conv.id, aId: a.id, bId: b.id, episodeId: row.id };
}

describe('episode breaker (D92 T1a WP2)', () => {
  it('pair breaker pauses the round with one visible card; resume re-delivers and the round continues', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId, bId, episodeId } = await tripBreaker(stack);

    // Exactly one visible pause card naming the episode and the round's hops.
    const cards = pauseCards(await listMessages(core, conversationId));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.content).toMatchObject({
      event: 'episode_paused',
      text: '协作已自动往返 2 次，已暂停',
      episodeId,
    });

    // The tripped trigger was kept, not delivered: B has only its first turn.
    expect(turnRunsOf(stack, conversationId, bId)).toHaveLength(1);
    const row = episodeRows(core, conversationId).find((r) => r.id === episodeId)!;
    expect(row).toMatchObject({ status: 'paused', hops: 2 });
    expect(JSON.parse(row.pending_json)).toHaveLength(1);

    // episodes.get (RPC) reports the pause.
    const got = (await core.rpc.call('episodes.get', { id: episodeId })) as { episode: Episode };
    expect(got.episode).toMatchObject({ id: episodeId, status: 'paused', hops: 2, pendingCount: 1 });

    // Resume: counters reset, the kept trigger is re-delivered, B answers.
    llm.script('mock-main', [step().inTurn().expect(isBot('阿乙')).replyText('乙补投已收到')]);
    const resumed = (await core.rpc.call('episodes.resume', { id: episodeId })) as {
      episode: Episode;
    };
    expect(resumed.episode).toMatchObject({
      id: episodeId,
      status: 'active',
      hops: 0,
      pendingCount: 0,
    });

    const bResumed = await waitFor(
      () =>
        turnRunsOf(stack, conversationId, bId).find(
          (run) =>
            run.status === 'completed' &&
            run.triggerReason === 'bot_mention' &&
            run.episodeHop === 3,
        ) ?? null,
      { label: 'B resumed turn (kept trigger, hop 3)', timeoutMs: 20_000 },
    );
    // The re-delivered trigger stays bound to the same episode at its kept hop
    // (re-delivery does not count towards the fresh round); still one row.
    expect(bResumed.episodeId).toBe(episodeId);
    const after = episodeRows(core, conversationId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'active', hops: 0, pending_json: '[]' });
    // Still exactly one pause card: resume never writes a second one.
    expect(pauseCards(await listMessages(core, conversationId))).toHaveLength(1);
  }, 60_000);

  it('stop clears the pending triggers (nothing is delivered) and writes the internal episode_stopped', async () => {
    const stack = await start();
    const { core } = stack;
    const { conversationId, bId, episodeId } = await tripBreaker(stack);
    expect(turnRunsOf(stack, conversationId, bId)).toHaveLength(1);

    const stopped = (await core.rpc.call('episodes.stop', { id: episodeId })) as {
      episode: Episode;
    };
    expect(stopped.episode).toMatchObject({ id: episodeId, status: 'stopped', pendingCount: 0 });

    // The kept trigger is dropped: B never gets a second turn.
    await new Promise((r) => setTimeout(r, 800));
    expect(turnRunsOf(stack, conversationId, bId)).toHaveLength(1);

    // episode_stopped is internal: bots see it, users do not.
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

    const row = episodeRows(core, conversationId).find((r) => r.id === episodeId)!;
    expect(row).toMatchObject({ status: 'stopped', pending_json: '[]' });
  }, 60_000);
});
