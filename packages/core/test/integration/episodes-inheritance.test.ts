import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
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
import type { Run } from '@kepcup/shared';

/**
 * D92 T1a WP2 回归：任务结算唤醒的对话轮**继承**发起轮的协作回合（修复
 * 「任务唤醒不带回合、隔任务即新开」的缺口），且绑定在唤醒时解析——发起
 * 轮在任务启动后才第一次 @（才建回合）也能继承；发起轮从未 @ 过时唤醒轮
 * 不绑回合。
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

function runsOf(core: CoreHarness, conversationId: string): Run[] {
  const domain = core.services.domain!;
  return domain.runs
    .listByConversation(conversationId, 100)
    .filter((run) => run.loopType === 'turn')
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

function episodesOf(core: CoreHarness, conversationId: string) {
  return core.services.mainDb!
    .prepare('select * from episodes where conversation_id = ?')
    .all(conversationId) as Array<{
    id: string;
    status: string;
    hops: number;
    pending_json: string;
  }>;
}

describe('任务结算唤醒继承协作回合', () => {
  it('A @ B、B 的轮里派任务：任务唤醒的 B 轮继承同一回合，再 @ 计数延续', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const conv = await makeProject(core, '接力任务', [a.id, b.id], { leadBotId: a.id });

    llm.script('mock-main', [
      // A's turn (user @): mentions B.
      step().inTurn().expect(isBot('阿甲')).replyToolCall('send_message', {
        text: '请阿乙处理',
        mention_bot_ids: [b.id],
      }),
      step().inTurn().expect(isBot('阿甲')).replyText('甲已安排'),
      // B's episode turn (bot_mention): starts a task, then acks.
      step().inTurn().expect(isBot('阿乙')).replyToolCall('start_task', {
        title: '调研',
        instruction: '把事情做完',
        source_message_ids: [],
        writes: false,
      }),
      step().inTurn().expect(isBot('阿乙')).replyText('我去处理'),
      // The task itself.
      step().inTask().replyText('TASK-DONE 结果'),
      // B's woken turn (task result): @s A back, then relays.
      step().inTurn().expect(isBot('阿乙')).replyToolCall('send_message', {
        text: '阿甲请复核',
        mention_bot_ids: [a.id],
      }),
      step().inTurn().expect(isBot('阿乙')).replyText('结果已出'),
      // A's second turn (bot_mention, hop 2).
      step().inTurn().expect(isBot('阿甲')).replyText('甲复核完毕'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '这件事交给谁', mentions: [a.id] }]);

    const runs = await waitFor(
      async () => {
        const all = runsOf(core, conv.id);
        const aRuns = all.filter((run) => run.botId === a.id);
        const bRuns = all.filter((run) => run.botId === b.id);
        return aRuns.length === 2 && bRuns.length === 2 &&
          all.every((run) => run.status === 'completed')
          ? all
          : null;
      },
      { label: 'all four turns completed', timeoutMs: 30_000 },
    );

    // The episode: one row, created by A's first @, counters continuing.
    const episodes = episodesOf(core, conv.id);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ status: 'active', hops: 2, pending_json: '[]' });
    const episodeId = episodes[0]!.id;

    const aRuns = runs.filter((run) => run.botId === a.id);
    const bRuns = runs.filter((run) => run.botId === b.id);
    // A's initiating turn is the episode root (hop 0).
    expect(aRuns[0]).toMatchObject({ episodeId, episodeHop: 0, triggerReason: 'mention' });
    // B's bot_mention turn: hop 1.
    expect(bRuns[0]).toMatchObject({ episodeId, episodeHop: 1, triggerReason: 'bot_mention' });
    // The task run itself is NOT bound to the episode.
    const task = core.services
      .domain!.runs.listByConversation(conv.id, 100)
      .find((run) => run.loopType === 'task')!;
    expect(task.originRunId).toBe(bRuns[0]!.id);
    expect(task.episodeId).toBeNull();
    // The task-woken turn inherits the SAME episode at B's hop — not a new one.
    expect(bRuns[1]).toMatchObject({ episodeId, episodeHop: 1, triggerReason: 'task' });
    // Its @ of A continues the counters: hop 2 on the same episode.
    expect(aRuns[1]).toMatchObject({ episodeId, episodeHop: 2, triggerReason: 'bot_mention' });
  }, 40_000);

  it('发起任务的轮从未 @ 过任何人：唤醒的轮不绑回合', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const a = await makeBot(core, '阿单');
    const b = await makeBot(core, '阿双');
    const conv = await makeProject(core, '无回合任务', [a.id, b.id], { leadBotId: a.id });

    llm.script('mock-main', [
      // A's turn (user @): starts a task, never mentions anyone.
      step().inTurn().expect(isBot('阿单')).replyToolCall('start_task', {
        title: '独立任务',
        instruction: '独立完成',
        source_message_ids: [],
        writes: false,
      }),
      step().inTurn().expect(isBot('阿单')).replyText('我去处理'),
      step().inTask().replyText('ALONE-DONE 结果'),
      step().inTurn().expect(isBot('阿单')).replyText('任务完成'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '帮我做这件事', mentions: [a.id] }]);

    const aRuns = await waitFor(
      async () => {
        const runs = runsOf(core, conv.id).filter((run) => run.botId === a.id);
        return runs.length === 2 && runs.every((run) => run.status === 'completed') ? runs : null;
      },
      { label: "A's two turns completed", timeoutMs: 30_000 },
    );

    expect(aRuns[0]!.triggerReason).toBe('mention');
    expect(aRuns[0]!.episodeId).toBeNull();
    // No @ anywhere: no episode row, the woken turn is unbound.
    expect(aRuns[1]).toMatchObject({ triggerReason: 'task', episodeId: null });
    expect(episodesOf(core, conv.id)).toHaveLength(0);
    // Sanity: no bot message from A besides the ack/relay; nothing else ran.
    expect((await listMessages(core, conv.id)).filter((m) => m.senderBotId === b.id)).toHaveLength(0);
  }, 40_000);
});
