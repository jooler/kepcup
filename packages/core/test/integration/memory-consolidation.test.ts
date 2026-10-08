import { describe, expect, it } from 'vitest';
import { createTestStack, makeBot, openDirect, sendDrafts, step, waitFor } from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';
import type { CoreHarness } from '@kepcup/core';
import type { Embedder } from '../../src/memory/embedder.js';

const TEST_ENV = { KEPCUP_PROFILE_CURATION_DELAY_MS: '60000' };

/** Deterministic 8-dim embedder (same shape as memory.test.ts 的注入向量). */
function fakeEmbedder(): Embedder {
  return {
    id: 'fake:8',
    dim: 8,
    ready: () => true,
    embed: async (texts: string[]) =>
      texts.map((text) => {
        const vector = new Float32Array(8);
        for (let i = 0; i < text.length; i++) vector[(text.charCodeAt(i) + i) % 8] += 1;
        let sum = 0;
        for (const value of vector) sum += value * value;
        const norm = Math.sqrt(sum) || 1;
        for (let i = 0; i < 8; i++) vector[i] = vector[i]! / norm;
        return vector;
      }),
  };
}

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
      return (
        result.runs.find((run) => run.status === 'completed' && run.loopType === 'turn') ?? null
      );
    },
    { label: 'completed response run' },
  );
}

describe('P07 记忆整理（consolidation，每 Bot 每天一次）', () => {
  it('过期条目直接失效（不经模型）；同 kind 批次经模型合并，完成后记录日期', async () => {
    const stack = await createTestStack({ env: TEST_ENV, memoryEmbedder: fakeEmbedder() });
    try {
      const bot = await makeBot(stack.core, '阿整');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [step().replyText('好的')]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      const batch = await sendDrafts(stack.core, conv.id, [{ text: '你好呀' }]);
      await completedRun(stack.core, conv.id);
      await waitFor(
        () => {
          const rows = stack.core.services
            .mainDb!.prepare("select status from jobs where type = 'reflection'")
            .all() as Array<{ status: string }>;
          return rows.length >= 1 && rows.every((row) => row.status === 'done') ? true : null;
        },
        { label: 'reflection done' },
      );

      const memory = stack.core.services.memory!;
      const store = memory.storeFor(bot.id);
      // 过期条目：valid_until 已过 → 直接 superseded，不消耗模型调用。
      store.insert({
        kind: 'fact',
        content: '一条已过期的临时信息',
        source: 'explicit',
        evidence: [{ messageId: batch[0]!.id, conversationId: conv.id, runId: null }],
        origin: 'private',
        originConversationId: conv.id,
        confidence: 1,
        sensitivity: 'normal',
        privateToBot: false,
        validUntil: Date.now() - 1000,
      });
      // 两条高度相似的条目 → 模型 merge。第二条带敏感/私有/时效约束
      // （BR-P07-002：合并不得把约束洗掉）。
      store.insert({
        kind: 'preference',
        content: '用户偏好深色主题',
        source: 'explicit',
        evidence: [{ messageId: batch[0]!.id, conversationId: conv.id, runId: null }],
        origin: 'private',
        confidence: 1,
        sensitivity: 'normal',
        privateToBot: false,
      });
      const withConstraints = store.insert({
        kind: 'preference',
        content: '用户喜欢深色界面',
        source: 'inferred',
        evidence: [{ messageId: batch[0]!.id, conversationId: conv.id, runId: null }],
        origin: 'private',
        confidence: 0.8,
        sensitivity: 'sensitive',
        privateToBot: true,
        dueAt: Date.now() + 2 * 60 * 60 * 1000,
        validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      // 画像整理的 dedupe 不受影响；登记与真实调度同型的整理任务。
      const preferences = store.activeByKind('preference', 50);
      stack.llm.script('mock-light', [
        step()
          .expect((req) => req.lastUserText().includes('preference'))
          .replyJson({
            operations: [
              {
                op: 'merge',
                itemIds: preferences.map((item) => item.id),
                content: '用户偏好深色主题的界面',
              },
            ],
          }),
      ]);
      stack.core.services.domain!.jobs.enqueue({
        type: 'memory_consolidation',
        botId: bot.id,
        payload: { day: '2026-10-01' },
        priority: 2,
      });

      await waitFor(
        () => {
          const job = stack.core.services
            .mainDb!.prepare(
              "select status, attempts, last_error from jobs where type = 'memory_consolidation'",
            )
            .get() as { status: string; attempts: number; last_error: string | null } | undefined;
          return job !== undefined && (job.status === 'done' || job.status === 'failed')
            ? job
            : null;
        },
        { label: 'consolidation job settled' },
      );
      const job = stack.core.services
        .mainDb!.prepare(
          "select status, attempts, last_error from jobs where type = 'memory_consolidation'",
        )
        .get() as { status: string; attempts: number; last_error: string | null };
      expect(job.status).toBe('done');

      const result = (await stack.core.rpc.call('memory.list', { botId: bot.id })) as {
        items: Array<{
          content: string;
          status: string;
          sensitivity: string;
          privateToBot: boolean;
          dueAt: number | null;
          validUntil: number | null;
        }>;
      };
      expect(result.items.find((item) => item.content.includes('过期的临时信息'))!.status).toBe(
        'superseded',
      );
      expect(result.items.find((item) => item.content === '用户偏好深色主题')!.status).toBe(
        'superseded',
      );
      expect(result.items.find((item) => item.content === '用户喜欢深色界面')!.status).toBe(
        'superseded',
      );
      const merged = result.items.find((item) => item.content === '用户偏好深色主题的界面');
      expect(merged).toBeDefined();
      expect(merged!.status).toBe('active');
      // 合并保留最强约束（BR-P07-002）：任一敏感即敏感、任一私有即私有、
      // 截止/时效取最晚（不会比任何来源更早失效）。
      expect(merged!.sensitivity).toBe('sensitive');
      expect(merged!.privateToBot).toBe(true);
      expect(merged!.dueAt).toBe(withConstraints.dueAt);
      expect(merged!.validUntil).toBe(withConstraints.validUntil);
      // 整理产物可被 KNN 检出（BR-P07-002：插入后回填向量）。
      const embedder = fakeEmbedder();
      const [vector] = await embedder.embed(['用户偏好深色主题的界面']);
      expect(store.knn(vector!, 5).map((entry) => entry.id)).toContain(merged!.id);
      // 整理完成记录当天日期（每天一次的依据）。
      expect(store.getMeta('last_consolidation_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('无内置模型（只用外部 Agent）：跳过合并但照常过期失效并记录日期，避免每小时重复入队（P4-B 审查 #2）', async () => {
    const stack = await createTestStack({
      env: { ...TEST_ENV, KEPCUP_MOCK_LLM_URL: '' },
      memoryEmbedder: fakeEmbedder(),
    });
    try {
      const bot = await makeBot(stack.core, '阿整');
      const store = stack.core.services.memory!.storeFor(bot.id);
      store.insert({
        kind: 'fact',
        content: '一条已过期的临时信息',
        source: 'explicit',
        evidence: [],
        origin: 'private',
        confidence: 1,
        sensitivity: 'normal',
        privateToBot: false,
        validUntil: Date.now() - 1000,
      });
      stack.core.services.domain!.jobs.enqueue({
        type: 'memory_consolidation',
        botId: bot.id,
        payload: { day: '2026-10-01' },
        priority: 2,
      });
      const job = await waitFor(
        () => {
          const row = stack.core.services
            .mainDb!.prepare(
              "select status, last_error from jobs where type = 'memory_consolidation'",
            )
            .get() as { status: string; last_error: string | null } | undefined;
          return row !== undefined && (row.status === 'done' || row.status === 'failed')
            ? row
            : null;
        },
        { label: 'consolidation job settled' },
      );
      expect(job).toEqual({ status: 'done', last_error: null });
      expect(store.getMeta('last_consolidation_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const result = (await stack.core.rpc.call('memory.list', { botId: bot.id })) as {
        items: Array<{ content: string; status: string }>;
      };
      expect(result.items.find((item) => item.content.includes('过期的临时信息'))!.status).toBe(
        'superseded',
      );
      // 已记录当天日期：每小时的调度不再为它入队。
      expect(stack.core.services.memory!.enqueueDueConsolidations()).toBe(0);
    } finally {
      await stack.cleanup();
    }
  }, 30_000);
});
