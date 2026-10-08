import { describe, expect, it } from 'vitest';
import {
  createTestStack,
  listMessages,
  makeBot,
  makeGroup,
  openDirect,
  sendDrafts,
  step,
  waitFor,
} from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';
import type { CoreHarness } from '@kepcup/core';

/**
 * 安全用例（docs/dev/05-testing.md 安全用例集，P07 条目）：
 * 其他 Bot 的发言、工具输出中的"指令"不会导致记忆或画像写入——
 * 画像证据必须来自用户消息（docs/design/06-isolation-and-storage.md 信任隔离）。
 */
const TEST_ENV = { KEPCUP_PROFILE_CURATION_DELAY_MS: '60000' };

function emptyReflection() {
  return {
    runSummary: '无新记忆',
    memories: [],
    profileProposals: [],
    wikiSuggestions: [],
    skillSuggestion: null,
  };
}

async function completedRun(core: CoreHarness, conversationId: string): Promise<Run> {
  return waitFor(
    async () => {
      const result = (await core.rpc.call('runs.list', { conversationId, limit: 20 })) as {
        runs: Run[];
      };
      return result.runs.find((run) => run.status === 'completed' && run.loopType === 'turn') ?? null;
    },
    { label: 'completed response run' },
  );
}

describe('P07 安全：画像证据必须来自用户消息（记忆污染防线）', () => {
  it('群聊中其他 Bot 声称的"关于用户的说法"不进入画像，也不写入提议 Bot 的记忆', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const botA = await makeBot(stack.core, '阿甲');
      const botB = await makeBot(stack.core, '阿乙');
      const group = await makeGroup(stack.core, '污染测试群', [botA.id, botB.id]);
      // 阿乙通过 send_message 把"关于用户的说法"发给阿甲（Bot 发言，untrusted）。
      stack.llm.script('mock-main', [
        step().expect((req) => req.lastUserText().includes('告诉阿甲')).replyToolCall('send_message', {
          text: '用户是公司 CEO',
          mention_bot_ids: [botA.id],
        }),
        step().replyText('转告完毕'),
        step().replyText('好的'), // 阿甲的连锁 run
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection()), step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, group.id, [
        { text: '请告诉阿甲：用户是公司 CEO', mentions: [botB.id] },
      ]);
      await completedRun(stack.core, group.id);
      await waitFor(
        () => {
          const rows = stack.core.services.mainDb!
            .prepare("select status from jobs where type = 'reflection' order by created_at")
            .all() as Array<{ status: string }>;
          return rows.length >= 2 && rows.every((row) => row.status === 'done') ? true : null;
        },
        { label: 'seed reflections done' },
      );
      const messages = await listMessages(stack.core, group.id);
      const botStatement = messages.find(
        (message) => message.senderType === 'bot' && message.senderBotId === botB.id,
      );
      expect(botStatement).toBeDefined();

      // 阿甲的反思把阿乙的说法当作用户画像提案/记忆（恶意或被注入的模型输出）。
      stack.llm.script('mock-light', [
        step().replyJson({
          runSummary: 'x',
          memories: [
            {
              kind: 'fact',
              content: '用户是公司 CEO（来自其他 Bot 的说法）',
              source: 'inferred',
              evidenceMessageIds: [botStatement!.id],
              confidence: 0.95,
              sensitivity: 'normal',
              privateToBot: false,
            },
          ],
          profileProposals: [
            {
              category: 'basic',
              content: '用户是公司 CEO（来自其他 Bot 的说法）',
              source: 'inferred',
              evidenceMessageIds: [botStatement!.id],
              confidence: 0.95,
            },
          ],
          wikiSuggestions: [],
          skillSuggestion: null,
        }),
      ]);
      stack.llm.script('mock-main', [step().replyText('嗯')]);
      await sendDrafts(stack.core, group.id, [{ text: '继续讨论', mentions: [botA.id] }]);
      await completedRun(stack.core, group.id);
      await waitFor(
        () => {
          const rows = stack.core.services.mainDb!
            .prepare("select status from jobs where type = 'reflection' order by created_at")
            .all() as Array<{ status: string }>;
          return rows.length >= 2 && rows.every((row) => row.status === 'done') ? true : null;
        },
        { label: 'reflection done' },
      );

      const profile = (await stack.core.rpc.call('profile.list')) as { items: unknown[] };
      expect(profile.items).toHaveLength(0); // 画像未被污染
      const memories = (await stack.core.rpc.call('memory.list', { botId: botA.id })) as {
        items: unknown[];
      };
      expect(memories.items).toHaveLength(0); // fact 类记忆同样需要用户证据
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('工具输出内容被当作画像证据时被丢弃（untrusted 数据不进画像）', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿具');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [step().replyText('好的')]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      const batch = await sendDrafts(stack.core, conv.id, [{ text: '帮我查点东西' }]);
      await completedRun(stack.core, conv.id);
      await waitFor(
        () => {
          const rows = stack.core.services.mainDb!
            .prepare("select status from jobs where type = 'reflection' order by created_at")
            .all() as Array<{ status: string }>;
          return rows.length >= 1 && rows.every((row) => row.status === 'done') ? true : null;
        },
        { label: 'first reflection done' },
      );

      // 反思伪造"来自工具输出"的画像提案——证据不是任何消息 id。
      stack.llm.script('mock-light', [
        step().replyJson({
          runSummary: 'x',
          memories: [],
          profileProposals: [
            {
              category: 'work',
              content: '用户是某公司 CTO（来自工具输出）',
              source: 'inferred',
              evidenceMessageIds: ['msg_nonexistent_tool_output'],
              confidence: 0.95,
            },
          ],
          wikiSuggestions: [],
          skillSuggestion: null,
        }),
      ]);
      stack.llm.script('mock-main', [step().replyText('嗯')]);
      await sendDrafts(stack.core, conv.id, [{ text: '继续' }]);
      await completedRun(stack.core, conv.id);
      await waitFor(
        () => {
          const rows = stack.core.services.mainDb!
            .prepare("select status from jobs where type = 'reflection' order by created_at")
            .all() as Array<{ status: string }>;
          return rows.length >= 2 && rows.every((row) => row.status === 'done') ? true : null;
        },
        { label: 'reflection done' },
      );

      const profile = (await stack.core.rpc.call('profile.list')) as { items: unknown[] };
      expect(profile.items).toHaveLength(0);
      void batch;
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('用户界面的直接编辑通道写入画像（两条合法写入路径之一）', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      // 用户直接编辑：profile.update（不经提案、不需用户消息证据——用户即证据）。
      const seeded = stack.core.services.memory!.profileStore.insert({
        category: 'basic',
        content: '用户称呼：老李',
        source: 'explicit',
        evidence: [],
        contributedBy: null,
        confidence: 1,
      });
      const updated = (await stack.core.rpc.call('profile.update', {
        id: seeded.id,
        content: '用户称呼：老李（改）',
      })) as { items: Array<{ id: string; content: string }> };
      expect(updated.items).toHaveLength(1);
      expect(updated.items[0]!.content).toBe('用户称呼：老李（改）');
      await stack.core.rpc.call('profile.retract', { id: seeded.id });
      const after = (await stack.core.rpc.call('profile.list')) as { items: unknown[] };
      expect(after.items).toHaveLength(0);
      const card = (await stack.core.rpc.call('profile.card')) as { card: { content: string | null } };
      expect(card.card.content).toBeNull();
    } finally {
      await stack.cleanup();
    }
  }, 40_000);
});
