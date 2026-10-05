import { describe, expect, it } from 'vitest';
import {
  createTestStack,
  makeBot,
  openDirect,
  sendDrafts,
  step,
  waitFor,
} from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';
import type { CoreHarness } from '@kepcup/core';
import type { Embedder } from '../../src/memory/embedder.js';

// 整理延迟冻结在 60s：只有「立即整理」路径能在测试时限内触发模型调用。
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
      return result.runs.find((run) => run.status === 'completed' && run.loopType === 'response') ?? null;
    },
    { label: 'completed response run' },
  );
}

async function waitForRunnableJobsSettled(core: CoreHarness, timeoutMs = 15_000): Promise<void> {
  await waitFor(
    () => {
      const runnable = core.services.mainDb!
        .prepare(
          "select count(*) as n from jobs where status in ('pending','running') and run_after <= ? and type not in ('wiki_suggestion','skill_suggestion')",
        )
        .get(Date.now() + 1000) as { n: number };
      const active = core.services.runsDb!
        .prepare("select count(*) as n from runs where status in ('queued','running','waiting_approval','waiting_lease')")
        .get() as { n: number };
      return runnable.n === 0 && active.n === 0 ? true : null;
    },
    { timeoutMs, intervalMs: 50, label: 'background jobs to settle' },
  );
}

describe('P07 审查修复回归（BR-P07-003/004/005/006）', () => {
  it('forget 画像条目：pending 的延迟整理任务被提前到立即执行（BR-P07-003）', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿快');
      const memory = stack.core.services.memory!;
      const item = memory.profileStore.insert({
        category: 'work',
        content: '用户在做记忆系统',
        source: 'inferred',
        evidence: [],
        contributedBy: bot.id,
        confidence: 0.9,
      });
      memory.profileStore.setCard('画像卡片：在做记忆系统');

      // 先产生一个被 60s 延迟去重键合并的 pending 任务（修复前它会被等待）。
      memory.scheduleCuration(false);
      const pendingBefore = stack.core.services.mainDb!
        .prepare("select run_after from jobs where type = 'profile_curation' and status = 'pending'")
        .get() as { run_after: number } | undefined;
      expect(pendingBefore).toBeDefined();
      expect(pendingBefore!.run_after).toBeGreaterThan(Date.now() + 30_000);

      // curation 需要一次模型调用（retract 由代码在模型之后兜底应用）。
      stack.llm.script('mock-main', [
        step().expect((req) => req.lastUserText().includes('<pending_proposals>')).replyJson({
          operations: [],
          card: '画像卡片：（无）',
        }),
      ]);
      const outcome = memory.forget(bot.id, [item.id]);
      expect(outcome.proposed).toEqual([item.id]);

      // 立即语义：同键 pending 任务的 run_after 被提前到现在，而不是被丢弃。
      const pendingAfter = stack.core.services.mainDb!
        .prepare("select run_after from jobs where type = 'profile_curation' and status = 'pending'")
        .get() as { run_after: number };
      expect(pendingAfter.run_after).toBeLessThanOrEqual(Date.now());

      await waitForRunnableJobsSettled(stack.core);
      expect(memory.profileStore.getItem(item.id)!.status).toBe('retracted');
      expect(memory.profileStore.getCard().content).toBe('画像卡片：（无）');
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('整理输出 update/supersede 的内容过凭据检测：命中按 reject 处理，条目保持原内容（BR-P07-004）', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿闸');
      const memory = stack.core.services.memory!;
      const item = memory.profileStore.insert({
        category: 'work',
        content: '用户在做记忆系统',
        source: 'inferred',
        evidence: [],
        contributedBy: bot.id,
        confidence: 0.9,
      });
      const proposal = memory.profileStore.insertProposal({
        botId: bot.id,
        op: 'add',
        payload: {
          category: 'work',
          content: '用户在做记忆系统',
          source: 'explicit',
          evidenceMessageIds: [],
          confidence: 0.9,
        },
      });
      stack.llm.script('mock-main', [
        step().expect((req) => req.lastUserText().includes('<pending_proposals>')).replyJson({
          operations: [
            { op: 'update', itemId: item.id, proposalId: proposal.id, content: '管理系统密码是password1234' },
          ],
          card: '画像卡片：在做记忆系统',
        }),
      ]);
      memory.scheduleCuration(true);
      await waitForRunnableJobsSettled(stack.core);

      // 条目保持原内容；提案按凭据命中被拒绝（不是 applied）。
      expect(memory.profileStore.getItem(item.id)!.content).toBe('用户在做记忆系统');
      const decided = memory.profileStore.getProposal(proposal.id)!;
      expect(decided.status).toBe('rejected');
      expect(decided.result).toMatchObject({ reason: 'credential pattern' });
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('embed 挂起期间连接被池淘汰，写入仍落库不抛错（BR-P07-005）', async () => {
    // 第一个 embed 调用挂起直到手动放行；之后的调用立即返回。
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let holdArmed = true;
    const toVector = (text: string) => {
      const vector = new Float32Array(8);
      for (let i = 0; i < text.length; i++) vector[(text.charCodeAt(i) + i) % 8] += 1;
      let sum = 0;
      for (const value of vector) sum += value * value;
      const norm = Math.sqrt(sum) || 1;
      for (let i = 0; i < 8; i++) vector[i] = vector[i]! / norm;
      return vector;
    };
    const embedder: Embedder = {
      id: 'fake:8',
      dim: 8,
      ready: () => true,
      embed: async (texts: string[]) => {
        if (holdArmed) {
          holdArmed = false;
          await firstGate;
        }
        return texts.map(toVector);
      },
    };
    const stack = await createTestStack({ env: TEST_ENV, memoryEmbedder: embedder });
    try {
      const memory = stack.core.services.memory!;
      const bots = [];
      for (let i = 0; i < 10; i++) bots.push(await makeBot(stack.core, `阿池${i}`));

      // Bot 0 的写入停在 embed 上（store 引用已持在 #persistValidated 内）。
      const first = memory.writeMemory(bots[0]!.id, null, {
        content: '池底之蛙的记忆',
        kind: 'self_note',
        triggerMessages: [],
      });
      await waitFor(() => (holdArmed === false ? true : null), {
        label: 'first embed held',
        intervalMs: 10,
      });

      // 其余 9 个 Bot 依次写入：连接池超过 8 → Bot 0 的连接被 LRU 关闭。
      for (let i = 1; i < 10; i++) {
        await memory.writeMemory(bots[i]!.id, null, {
          content: `池中第 ${i} 位 Bot 的记忆`,
          kind: 'self_note',
          triggerMessages: [],
        });
      }

      releaseFirst();
      // 修复前：挂起的写入继续使用已关闭的连接 → "connection not open" 抛出。
      const result = await first;
      expect(result.ok).toBe(true);
      expect(result.item!.content).toBe('池底之蛙的记忆');
      for (let i = 0; i < 10; i++) {
        const items = memory.listMemory(bots[i]!.id);
        expect(items.some((entry) => entry.status === 'active')).toBe(true);
      }
    } finally {
      releaseFirst(); // 兜底放行，避免 cleanup 挂起
      await stack.cleanup();
    }
  }, 40_000);

  it('反思挂起期间删除对话：不写任何记忆，runs 无孤儿行（BR-P07-006）', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿删');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [step().replyText('好的')]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '随便聊聊' }]);
      await completedRun(stack.core, conv.id);
      await waitFor(
        () => {
          const rows = stack.core.services.mainDb!
            .prepare("select status from jobs where type = 'reflection'")
            .all() as Array<{ status: string }>;
          return rows.length >= 1 && rows.every((row) => row.status === 'done') ? true : null;
        },
        { label: 'first reflection done' },
      );

      // 第二轮：反思的模型调用被挂起（修复前它会在删除后继续写入）。
      stack.llm.script('mock-main', [step().replyText('嗯')]);
      const held = step()
        .replyJson({
          runSummary: 'x',
          memories: [
            {
              kind: 'lesson',
              content: '用户偏好简洁的回复（删除后不应存在）',
              source: 'inferred',
              evidenceMessageIds: [],
              confidence: 0.9,
              sensitivity: 'normal',
              privateToBot: false,
            },
          ],
          profileProposals: [],
          wikiSuggestions: [],
          skillSuggestion: null,
        })
        .hold();
      stack.llm.script('mock-light', [held]);
      await sendDrafts(stack.core, conv.id, [{ text: '再说点' }]);
      await completedRun(stack.core, conv.id);
      await waitFor(
        () => (stack.llm.requestsFor('mock-light').length >= 2 ? true : null),
        { label: 'reflection request held at the mock' },
      );

      await stack.core.rpc.call('conversations.delete', { id: conv.id });
      held.release();

      await waitFor(
        () => {
          const rows = stack.core.services.mainDb!
            .prepare("select status from jobs where type = 'reflection'")
            .all() as Array<{ status: string }>;
          return rows.length >= 2 && rows.every((row) => row.status === 'done') ? true : null;
        },
        { label: 'second reflection settled after release' },
      );

      // 无新记忆：删除后模型输出被整体丢弃（lesson 空证据推断也不落库）。
      const items = (await stack.core.rpc.call('memory.list', { botId: bot.id })) as {
        items: unknown[];
      };
      expect(items.items).toHaveLength(0);
      // 无孤儿 run 行：级联删除之后反思不再重建/保留该对话的 run。
      const orphanRuns = stack.core.services.runsDb!
        .prepare('select count(*) as n from runs where conversation_id = ?')
        .get(conv.id) as { n: number };
      expect(orphanRuns.n).toBe(0);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);
});
