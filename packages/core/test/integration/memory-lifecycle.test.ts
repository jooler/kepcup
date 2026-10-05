import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTestStack,
  makeBot,
  makeGroup,
  openDirect,
  sendDrafts,
  step,
  waitFor,
} from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';

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

async function completedRun(
  stack: Awaited<ReturnType<typeof createTestStack>>,
  conversationId: string,
): Promise<Run> {
  return waitFor(
    async () => {
      const result = (await stack.core.rpc.call('runs.list', { conversationId, limit: 20 })) as {
        runs: Run[];
      };
      return (
        result.runs.find((run) => run.status === 'completed' && run.loopType === 'response') ?? null
      );
    },
    { label: 'completed response run' },
  );
}

async function listMemoryItems(stack: Awaited<ReturnType<typeof createTestStack>>, botId: string) {
  const result = (await stack.core.rpc.call('memory.list', { botId })) as {
    items: Array<{ id: string; kind: string; content: string; status: string }>;
  };
  return result.items;
}

describe('P07 生命周期级联（docs/dev/03-data-model.md 删除级联）', () => {
  it('删除对话 → 其中的承诺为 void，其他记忆保留', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿诺');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('记住'))
          .replyToolCall('remember', {
            content: '周五前给用户出报告',
            kind: 'commitment',
            due_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          }),
        step().replyText('记住了'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      const batch = await sendDrafts(stack.core, conv.id, [{ text: '记住：周五前给报告' }]);
      await completedRun(stack, conv.id);

      // 第二条非承诺记忆（领域层直写，证据来自上面的真实触发消息）。
      await stack.core.services.memory!.writeMemory(bot.id, conv.id, {
        content: '用户的项目叫 kepcup',
        kind: 'fact',
        triggerMessages: batch,
      });

      let items = await listMemoryItems(stack, bot.id);
      expect(items.find((item) => item.kind === 'commitment')).toBeDefined();

      await stack.core.rpc.call('conversations.delete', { id: conv.id });
      items = await listMemoryItems(stack, bot.id);
      expect(items.find((item) => item.kind === 'commitment')!.status).toBe('void');
      expect(items.find((item) => item.content.includes('kepcup'))!.status).toBe('active');
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('从群移除 Bot → 它在该群做出的承诺 void', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const botA = await makeBot(stack.core, '阿群');
      const botB = await makeBot(stack.core, '阿乙');
      const group = await makeGroup(stack.core, '项目群', [botA.id, botB.id]);
      stack.llm.script('mock-main', [step().replyText('好的')]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      const batch = await sendDrafts(stack.core, group.id, [
        { text: '记住：下周三给群里的评审', mentions: [botA.id] },
      ]);
      await completedRun(stack, group.id);
      await stack.core.services.memory!.writeMemory(botA.id, group.id, {
        content: '下周三之前给群里出评审',
        kind: 'commitment',
        triggerMessages: batch,
      });

      let items = await listMemoryItems(stack, botA.id);
      expect(items.find((item) => item.kind === 'commitment')!.status).toBe('active');

      await stack.core.rpc.call('groups.removeMember', {
        conversationId: group.id,
        botId: botA.id,
      });
      items = await listMemoryItems(stack, botA.id);
      expect(items.find((item) => item.kind === 'commitment')!.status).toBe('void');
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('删除 Bot → memory.db 随目录删除；它贡献的画像条目保留', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿删');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [step().replyText('好的')]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      const batch = await sendDrafts(stack.core, conv.id, [{ text: '你好' }]);
      await completedRun(stack, conv.id);
      await stack.core.services.memory!.writeMemory(bot.id, conv.id, {
        content: '用户在测试删除级联',
        kind: 'fact',
        triggerMessages: batch,
      });
      const memoryPath = path.join(stack.core.services.paths.home, 'bots', bot.id, 'memory.db');
      expect(existsSync(memoryPath)).toBe(true);

      // Bot 贡献的画像条目（先经提案入画像）。
      const proposals = stack.core.services.memory!.submitProfileProposal(bot.id, {
        category: 'work',
        content: '用户的工作与大模型相关',
        source: 'explicit',
        evidence: [batch[0]!.id],
        confidence: 1,
        sensitivity: 'normal',
        privateToBot: false,
      });
      expect(proposals.ok).toBe(true);
      // 冻结的延迟整理任务（60s 后）占用 dedupe 键：清掉后立即触发。
      stack.core.services
        .mainDb!.prepare(
          "delete from jobs where dedupe_key = 'profile_curation' and status = 'pending'",
        )
        .run();
      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('<pending_proposals>'))
          .replyJson({
            operations: [
              {
                op: 'add',
                proposalId: stack.core.services.memory!.profileStore.pendingProposals()[0]!.id,
                category: 'work',
                content: '用户的工作与大模型相关',
              },
            ],
            card: '画像卡片：工作与大模型相关',
          }),
      ]);
      stack.core.services.memory!.scheduleCuration(true);
      await waitFor(
        () => {
          const items = stack.core.services.memory!.profileStore.list('active');
          return items.length === 1 ? items : null;
        },
        { label: 'profile item curated' },
      );

      await stack.core.rpc.call('bots.delete', { id: bot.id });
      expect(existsSync(memoryPath)).toBe(false);
      expect(existsSync(path.join(stack.core.services.paths.home, 'bots', bot.id))).toBe(false);
      const profile = (await stack.core.rpc.call('profile.list')) as {
        items: Array<{ content: string; contributedBy: string | null }>;
      };
      expect(profile.items).toHaveLength(1);
      expect(profile.items[0]!.contributedBy).toBe(bot.id);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);
});
