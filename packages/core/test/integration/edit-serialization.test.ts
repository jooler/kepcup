import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listMessages,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  waitFor,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import { step } from '@kepcup/testkit';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

describe('edit', () => {
  it('an edit after the loop ended triggers a new run', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().replyText('收到第一条'),
      step().replyText('看到修改了'),
    ]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    const [message] = await sendBatch(core, conv.id, ['原始内容']);
    await waitForRun(core, conv.id, 'completed');

    await core.rpc.call('messages.edit', { id: message!.id, text: '修改后的内容' });
    const runs = await waitFor(
      async () => {
        const all = await listRuns(core, conv.id);
        return all.length >= 2 ? all : null;
      },
      { label: 'second run' },
    );
    await waitForRun(core, conv.id, 'completed');

    const second = runs.sort((a, b) => b.createdAt - a.createdAt)[0]!;
    expect(second.triggerReason).toBe('event');
    expect(second.triggerMessageIds).toContain(message!.id);

    const all = await listMessages(core, conv.id);
    const edited = all.find((m) => m.id === message!.id);
    expect(edited?.status).toBe('edited');
    expect(edited?.editedAt).not.toBeNull();
  });
});

describe('provider concurrency', () => {
  it('queues runs of two conversations when the provider limit is 1', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('对话一'))
        .hold()
        .replyText('一完成'),
      step()
        .expect((req) => req.lastUserText().includes('对话二'))
        .hold()
        .replyText('二完成'),
    ]);
    await core.rpc.call('settings.update', {
      providerConcurrency: { default: 4, 'custom:mock': 1 },
    });

    const botA = await makeBot(core, '甲');
    const botB = await makeBot(core, '乙');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);

    await sendBatch(core, convA.id, ['对话一的消息']);
    await waitForRun(core, convA.id, 'running');
    await sendBatch(core, convB.id, ['对话二的消息']);

    // B must stay queued while A holds the single provider slot. Wait for the
    // first request to actually land (polling, not a wall-clock guess — the
    // former fixed 500ms sleep failed on loaded machines where the first
    // request took longer to start), then give a short grace for any
    // ILLEGITIMATE concurrent dispatch to surface before asserting exactly 1.
    await waitFor(() => (llm.requests().length >= 1 ? true : null), { label: 'first request' });
    await new Promise((r) => setTimeout(r, 300));
    const runsBWhileA = await listRuns(core, convB.id);
    expect(runsBWhileA[0]?.status === 'queued' || runsBWhileA[0]?.status === 'running').toBe(true);
    expect(llm.requests().length).toBe(1);

    llm.releaseAll();
    await waitForRun(core, convA.id, 'completed');
    await waitForRun(core, convB.id, 'completed');

    const runsA = await listRuns(core, convA.id);
    const runsB = await listRuns(core, convB.id);
    expect((runsB[0]?.startedAt ?? 0)).toBeGreaterThanOrEqual(runsA[0]!.endedAt ?? 0);
  }, 20_000);
});

describe('conversation summary', () => {
  it('enqueues a summary job past the threshold and injects <summary> afterwards', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [
      step().replyText('第一批完成'),
      step().expect((req) => JSON.stringify(req.body.messages).includes('<summary>')).replyText('带摘要的回复'),
    ]);
    // P07 起：每次响应完成后还有一个轻量模型的反思 loop，与摘要任务共用
    // mock-light 队列——用谓词对齐（反思输入含 <trigger_messages>，摘要输入
    // 含 <new_messages>）。
    const emptyReflection = {
      runSummary: '无新记忆',
      memories: [],
      profileProposals: [],
      wikiSuggestions: [],
      skillSuggestion: null,
    };
    llm.script('mock-light', [
      step().expect((req) => req.lastUserText().includes('<trigger_messages>')).replyJson(emptyReflection),
      step().expect((req) => req.lastUserText().includes('<new_messages>')).replyJson({
        summary: '用户在测试对话摘要功能。',
      }),
      step().expect((req) => req.lastUserText().includes('<trigger_messages>')).replyJson(emptyReflection),
    ]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    // SUMMARY_TRIGGER_UNSUMMARIZED is 50: flush 51 messages in one batch.
    const texts = Array.from({ length: 51 }, (_, i) => `消息 ${i + 1}`);
    await sendBatch(core, conv.id, texts);
    await waitForRun(core, conv.id, 'completed');

    // The job runner claims the summary and the light model produces it.
    await waitFor(
      async () => {
        const conversation = (await core.rpc.call('conversations.get', {
          id: conv.id,
        })) as { conversation: { summary: string | null } | null };
        return conversation.conversation?.summary ? true : null;
      },
      { timeoutMs: 20_000, label: 'rolling summary' },
    );
    expect(llm.requestsFor('mock-light').length).toBeGreaterThanOrEqual(1);

    // The next response run sees the summary in its context.
    await sendBatch(core, conv.id, ['继续']);
    await waitFor(
      async () => {
        const runs = await listRuns(core, conv.id);
        return runs.length >= 2 && runs.every((r) => r.status === 'completed') ? true : null;
      },
      { timeoutMs: 20_000, label: 'second run completed' },
    );
    expect(llm.requestBodiesContain('<summary>')).toBe(true);
    expect(llm.requestBodiesContain('用户在测试对话摘要功能。')).toBe(true);
  }, 40_000);
});
