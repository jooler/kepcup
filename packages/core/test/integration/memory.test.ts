import { describe, expect, it } from 'vitest';
import { localDateKey } from '../../src/memory/local-date.js';
import {
  createTestStack,
  listMessages,
  makeBot,
  mockEmbedding,
  openDirect,
  sendDrafts,
  step,
  waitFor,
} from '@kepcup/testkit';
import type { Bot, Run } from '@kepcup/shared';
import type { CoreHarness } from '@kepcup/core';

const TEST_ENV = { KEPCUP_PROFILE_CURATION_DELAY_MS: '50' };

function emptyReflection() {
  return {
    runSummary: '无新记忆',
    memories: [],
    profileProposals: [],
    wikiSuggestions: [],
    skillSuggestion: null,
  };
}

async function listMemoryItems(core: CoreHarness, botId: string) {
  const result = (await core.rpc.call('memory.list', { botId })) as {
    items: Array<{
      id: string;
      kind: string;
      content: string;
      status: string;
      dueAt: number | null;
    }>;
  };
  return result.items;
}

async function listProfileItems(core: CoreHarness) {
  const result = (await core.rpc.call('profile.list')) as {
    items: Array<{
      id: string;
      content: string;
      contributedBy: string | null;
      category: string;
      evidence: Array<{ messageId: string | null; conversationId: string | null }>;
    }>;
  };
  return result.items;
}

async function getCard(core: CoreHarness) {
  return (await core.rpc.call('profile.card')) as {
    card: { content: string | null; compiledAt: number | null };
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

async function waitForRunnableJobsSettled(core: CoreHarness, timeoutMs = 15_000): Promise<void> {
  await waitFor(
    () => {
      const runnable = core.services
        .mainDb!.prepare(
          "select count(*) as n from jobs where status in ('pending','running') and run_after <= ? and type not in ('wiki_suggestion','skill_suggestion')",
        )
        .get(Date.now() + 1000) as { n: number };
      const active = core.services
        .runsDb!.prepare(
          "select count(*) as n from runs where status in ('queued','running','waiting_approval','waiting_lease')",
        )
        .get() as { n: number };
      return runnable.n === 0 && active.n === 0 ? true : null;
    },
    { timeoutMs, intervalMs: 50, label: 'background jobs to settle' },
  );
}

describe('P07 记忆与画像（集成）', () => {
  it('用户说“记住我下周三要交报告”→ remember 写入承诺，下一次执行的 <my_state> 中出现', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿忆');
      const conv = await openDirect(stack.core, bot.id);
      const dueAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('记住'))
          .replyToolCall('remember', {
            content: '下周三之前提交周报',
            kind: 'commitment',
            due_at: dueAt,
          }),
        step().replyText('好的，我记住了'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);

      await sendDrafts(stack.core, conv.id, [{ text: '记住我下周三要交报告' }]);
      await completedRun(stack.core, conv.id);

      const items = await listMemoryItems(stack.core, bot.id);
      const commitment = items.find((item) => item.kind === 'commitment');
      expect(commitment).toBeDefined();
      expect(commitment!.content).toContain('周报');
      expect(commitment!.dueAt).not.toBeNull();
      expect(commitment!.status).toBe('active');

      stack.llm.script('mock-main', [step().replyText('在的')]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '在吗' }]);
      await waitFor(
        () =>
          stack.llm
            .requestsFor('mock-main')
            .some((req) => JSON.stringify(req.body).includes('<my_state>'))
            ? true
            : null,
        { label: 'my_state injection' },
      );
      const injected = stack.llm
        .requestsFor('mock-main')
        .find((req) => JSON.stringify(req.body).includes('<my_state>'));
      expect(JSON.stringify(injected?.body)).toContain('周报');
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('两个 Bot 同时产生画像提案 → 一次整理合并处理，卡片更新且另一个 Bot 可见', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const botA = await makeBot(stack.core, '阿甲');
      const botB = await makeBot(stack.core, '阿乙');
      const convA = await openDirect(stack.core, botA.id);
      const convB = await openDirect(stack.core, botB.id);

      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('简洁'))
          .replyToolCall('remember', {
            content: '用户偏好简洁的回复',
            kind: 'preference',
          }),
        step().replyText('好的'),
        step()
          .expect((req) => req.lastUserText().includes('工程师'))
          .replyToolCall('remember', {
            content: '用户是后端工程师',
            kind: 'fact',
          }),
        step().replyText('好的'),
      ]);
      stack.llm.script('mock-light', [
        step().replyJson(emptyReflection()),
        step().replyJson(emptyReflection()),
      ]);

      await sendDrafts(stack.core, convA.id, [{ text: '记住：我偏好简洁回复' }]);
      await completedRun(stack.core, convA.id);
      await sendDrafts(stack.core, convB.id, [{ text: '记住：我是工程师' }]);
      await completedRun(stack.core, convB.id);
      // 两个提案 pending（延迟整理在本测试中被冻结在 60s 后）。
      const proposals = await waitFor(
        () => {
          const pending = stack.core.services.memory!.profileStore.pendingProposals();
          return pending.length === 2 ? pending : null;
        },
        { label: 'two pending proposals' },
      );
      const first = proposals.find(
        (p) => (p.payload as { content?: string }).content === '用户偏好简洁的回复',
      )!;
      const second = proposals.find(
        (p) => (p.payload as { content?: string }).content === '用户是后端工程师',
      )!;
      // 脚本就绪后立即触发整理（真实链路：同一 dedupe 键的 profile_curation 任务）。
      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('<pending_proposals>'))
          .replyJson({
            operations: [
              {
                op: 'add',
                proposalId: first.id,
                category: 'communication',
                content: '用户偏好简洁的回复',
              },
              { op: 'add', proposalId: second.id, category: 'work', content: '用户是后端工程师' },
            ],
            card: '画像卡片：后端工程师，偏好简洁回复',
          }),
      ]);
      stack.core.services.memory!.scheduleCuration(true);
      await waitForRunnableJobsSettled(stack.core);

      const items = await listProfileItems(stack.core);
      expect(items.map((item) => item.content).sort()).toEqual(
        ['用户偏好简洁的回复', '用户是后端工程师'].sort(),
      );
      // 证据的 conversationId 回填自消息（BR-P07-010，不是恒 null）。
      const byContent = new Map(items.map((item) => [item.content, item] as const));
      for (const [content, conversation] of [
        ['用户偏好简洁的回复', convA.id],
        ['用户是后端工程师', convB.id],
      ] as const) {
        const item = byContent.get(content)!;
        expect(item.contributedBy).toBeTruthy();
        expect(item.evidence.length).toBeGreaterThan(0);
        expect(item.evidence.every((e) => e.conversationId === conversation)).toBe(true);
      }
      const contributors = new Set(items.map((item) => item.contributedBy));
      expect(contributors.has(botA.id)).toBe(true);
      expect(contributors.has(botB.id)).toBe(true);
      expect((await getCard(stack.core)).card.content).toContain('后端工程师');

      // 另一个 Bot（阿乙）的下一次执行中可以看到画像卡片。
      stack.llm.script('mock-main', [step().replyText('好')]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, convB.id, [{ text: '在忙吗' }]);
      await waitFor(
        () =>
          stack.llm
            .requestsFor('mock-main')
            .some((req) => JSON.stringify(req.body).includes('<user_profile>'))
            ? true
            : null,
        { label: 'user_profile injection' },
      );
      const injected = stack.llm
        .requestsFor('mock-main')
        .find((req) => JSON.stringify(req.body).includes('<user_profile>'));
      expect(JSON.stringify(injected?.body)).toContain('画像卡片：后端工程师');
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('forget 画像条目 → 立即整理后不再出现在卡片中', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿忘');
      const conv = await openDirect(stack.core, bot.id);
      // 种子：直接经画像存储（整理任务的同一写入函数）建一条 active 条目。
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

      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('忘掉'))
          .replyToolCall('forget', {
            item_ids: [item.id],
          }),
        step().replyText('好的，已忘掉'),
        step()
          .expect((req) => req.lastUserText().includes('<pending_proposals>'))
          .replyJson({
            operations: [],
            card: '画像卡片：（无）',
          }),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '请忘掉那条画像' }]);
      await completedRun(stack.core, conv.id);
      await waitForRunnableJobsSettled(stack.core);

      expect(await listProfileItems(stack.core)).toHaveLength(0);
      expect((await getCard(stack.core)).card.content).toBe('画像卡片：（无）');
      expect(memory.profileStore.getItem(item.id)!.status).toBe('retracted');
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('propose_profile_change 阻塞等待用户决定，批准后写入 Profile', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿改');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [
        step().replyToolCall('propose_profile_change', {
          changes: [{ field: 'persona.tone', value: '更正式一些' }],
          reason: '用户要求更正式',
        }),
        step().replyText('谢谢确认'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);

      await sendDrafts(stack.core, conv.id, [{ text: '你以后语气正式一点吧' }]);
      const run = await waitFor(
        async () => {
          const result = (await stack.core.rpc.call('runs.list', {
            conversationId: conv.id,
            limit: 10,
          })) as {
            runs: Run[];
          };
          return result.runs.find((r) => r.status === 'waiting_approval') ?? null;
        },
        { label: 'waiting_approval run' },
      );
      expect(run.loopType).toBe('turn');

      const approvals = (await stack.core.rpc.call('approvals.list', {
        conversationId: conv.id,
      })) as {
        approvals: Array<{ id: string; kind: string; payload: Record<string, unknown> }>;
      };
      const approval = approvals.approvals.find((a) => a.kind === 'profile_change');
      expect(approval).toBeDefined();
      expect(approval!.payload['changes']).toEqual([
        { field: 'persona.tone', value: '更正式一些' },
      ]);
      await stack.core.rpc.call('approvals.decide', { id: approval!.id, approve: true });

      await waitFor(
        async () => {
          const result = (await stack.core.rpc.call('runs.list', {
            conversationId: conv.id,
            limit: 10,
          })) as {
            runs: Run[];
          };
          return result.runs.find((r) => r.id === run.id && r.status === 'completed') ?? null;
        },
        { label: 'profile-change run completed' },
      );
      const updated = (await stack.core.rpc.call('bots.get', { id: bot.id })) as { bot: Bot };
      expect(updated.bot.profile.persona.tone).toBe('更正式一些');
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('向量服务未就绪时检索只用全文检索，结果正确（带 id 与过时提示）', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿文');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('记住'))
          .replyToolCall('remember', {
            content: '用户的部署流程全在 Deploy.md 里',
            kind: 'fact',
          }),
        step().replyText('记住了'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '记住：部署流程' }]);
      await completedRun(stack.core, conv.id);

      const status = (await stack.core.rpc.call('embedding.status')) as {
        ready: boolean;
        reason?: string;
        source: string;
      };
      expect(status.ready).toBe(false);
      expect(status.reason).toBeTruthy();

      stack.llm.script('mock-main', [step().replyText('好的')]);
      await sendDrafts(stack.core, conv.id, [{ text: '部署文档在哪' }]);
      await waitFor(
        () =>
          stack.llm
            .requestsFor('mock-main')
            .some((req) => JSON.stringify(req.body).includes('<relevant_memories>'))
            ? true
            : null,
        { label: 'relevant_memories injection' },
      );
      const injected = stack.llm
        .requestsFor('mock-main')
        .find((req) => JSON.stringify(req.body).includes('<relevant_memories>'));
      const body = JSON.stringify(injected?.body);
      expect(body).toContain('Deploy.md');
      expect(body).toContain('mem_'); // 注入的记忆必须带 id（memory_feedback 依赖）
      expect(body).toContain('可能已过时');
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('注入测试 embedder 时走向量路径（memory_vec 建表 + KNN 检索 + meta 记录）', async () => {
    const embedder = {
      id: 'fake:test',
      dim: 8,
      ready: () => true,
      embed: async (texts: string[]) =>
        texts.map((text) => {
          const vector = new Float32Array(8);
          for (let i = 0; i < text.length; i++) vector[text.charCodeAt(i) % 8] += 1;
          let sum = 0;
          for (const value of vector) sum += value * value;
          const norm = Math.sqrt(sum) || 1;
          for (let i = 0; i < 8; i++) vector[i] = vector[i]! / norm;
          return vector;
        }),
    };
    const stack = await createTestStack({ env: TEST_ENV, memoryEmbedder: embedder });
    try {
      const bot = await makeBot(stack.core, '阿量');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('记住'))
          .replyToolCall('remember', {
            content: '用户的项目代号是蓝鲸',
            kind: 'fact',
          }),
        step().replyText('记住了'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '记住项目代号' }]);
      await completedRun(stack.core, conv.id);

      const status = (await stack.core.rpc.call('embedding.status')) as {
        ready: boolean;
        dim: number | null;
      };
      expect(status.ready).toBe(true);
      expect(status.dim).toBe(8);

      const store = stack.core.services.memory!.storeFor(bot.id);
      expect(store.vecDim()).toBe(8);
      expect(store.vecModelId()).toBe('fake:test');
      expect(store.allActiveWithRowids()).toHaveLength(1);

      stack.llm.script('mock-main', [step().replyText('好')]);
      await sendDrafts(stack.core, conv.id, [{ text: '项目代号是什么' }]);
      await waitFor(
        () =>
          stack.llm
            .requestsFor('mock-main')
            .some((req) => JSON.stringify(req.body).includes('蓝鲸'))
            ? true
            : null,
        { label: 'vector-backed injection' },
      );
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('后台预算超出后当天的反思任务推迟（不执行、推迟到次日）', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿预');
      const conv = await openDirect(stack.core, bot.id);
      await stack.core.rpc.call('budget.update', { tokens: 100 });
      const budget = (await stack.core.rpc.call('budget.get')) as { tokens: number };
      expect(budget.tokens).toBe(100);

      stack.core.services.domain!.usage.record({
        runId: 'run_seed',
        botId: bot.id,
        conversationId: conv.id,
        loopType: 'reflection',
        provider: 'mock',
        model: 'mock-main',
        inputTokens: 50_000,
        outputTokens: 60_000,
      });

      stack.llm.script('mock-main', [step().replyText('好')]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '触发一次反思登记' }]);
      await completedRun(stack.core, conv.id);

      // 等到任务被认领并推迟（run_after 推到次日）而不是刚注册的瞬间。
      // BR-P09-011: the deferral target is the next local midnight — its local
      // date must be strictly after the deferral moment's local date. A
      // "run_after > now + 12h" assertion only holds before local noon.
      const job = await waitFor(
        () => {
          const row = stack.core.services
            .mainDb!.prepare(
              "select * from jobs where type = 'reflection' order by created_at desc limit 1",
            )
            .get() as { status: string; run_after: number; updated_at: number } | undefined;
          if (row === undefined) return null;
          const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
          const deferredDay = localDateKey(new Date(row.updated_at), timeZone);
          const targetDay = localDateKey(new Date(row.run_after), timeZone);
          return targetDay > deferredDay && row.run_after >= row.updated_at ? row : null;
        },
        { label: 'reflection job deferred to next day' },
      );
      expect(job.status).toBe('pending');
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(stack.llm.requestsFor('mock-light')).toHaveLength(0); // 推迟：没有执行
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('embedding.configure 切换来源并登记重建任务；未就绪时任务自我延后', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      await makeBot(stack.core, '阿换');
      const status = (await stack.core.rpc.call('embedding.configure', {
        source: 'provider',
        provider: 'mock',
        model: 'mock-embed',
      })) as { source: string; ready: boolean };
      expect(status.source).toBe('provider');
      expect(status.ready).toBe(false); // mock provider 无存储 key

      await waitFor(
        () => {
          const job = stack.core.services
            .mainDb!.prepare("select * from jobs where type = 'memory_vec_rebuild'")
            .get() as { status: string } | undefined;
          return job ?? null;
        },
        { label: 'rebuild job registered' },
      );
      await new Promise((resolve) => setTimeout(resolve, 900));
      const job = stack.core.services
        .mainDb!.prepare("select * from jobs where type = 'memory_vec_rebuild'")
        .get() as { status: string; attempts: number };
      expect(job.status).toBe('pending');
      expect(job.attempts).toBeLessThanOrEqual(1);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('usage.summary 按 Bot / loop 类型 / 本地日期聚合', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿账');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [
        step().replyText('回复', { prompt_tokens: 100, completion_tokens: 20 }),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      await sendDrafts(stack.core, conv.id, [{ text: '你好' }]);
      await completedRun(stack.core, conv.id);
      await waitForRunnableJobsSettled(stack.core);

      const summary = (await stack.core.rpc.call('usage.summary', { days: 3 })) as {
        entries: Array<{
          botId: string | null;
          loopType: string;
          inputTokens: number;
          outputTokens: number;
          date: string;
        }>;
      };
      const responseRow = summary.entries.find(
        (entry) => entry.botId === bot.id && entry.loopType === 'turn',
      );
      expect(responseRow).toBeDefined();
      expect(responseRow!.inputTokens).toBeGreaterThanOrEqual(100);
      const reflectionRow = summary.entries.find((entry) => entry.loopType === 'reflection');
      expect(reflectionRow).toBeDefined();
      expect(/^\d{4}-\d{2}-\d{2}$/.test(reflectionRow!.date)).toBe(true);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('首次需要向量：系统（botId null）发起 environment 审批，卡片落在对话里且去重', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿嵌');
      const conv = await openDirect(stack.core, bot.id);
      stack.core.services.memory!.ensureEmbeddingConfigured(conv.id);

      await waitFor(
        async () => {
          const messages = await listMessages(stack.core, conv.id);
          return messages.some((m) => m.kind === 'card') ? true : null;
        },
        { label: 'approval card message' },
      );
      const approvals = (await stack.core.rpc.call('approvals.list', {
        conversationId: conv.id,
      })) as {
        approvals: Array<{ kind: string; botId: string | null; payload: Record<string, unknown> }>;
      };
      const env = approvals.approvals.find((a) => a.kind === 'environment');
      expect(env).toBeDefined();
      expect(env!.botId).toBeNull(); // 系统（不是 Bot）发起
      expect(env!.payload['item']).toBe('embedding-model');

      stack.core.services.memory!.ensureEmbeddingConfigured(conv.id);
      const approvals2 = (await stack.core.rpc.call('approvals.list', {
        conversationId: conv.id,
      })) as {
        approvals: Array<{ kind: string }>;
      };
      expect(approvals2.approvals.filter((a) => a.kind === 'environment')).toHaveLength(1);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('memory.update 支持独立编辑 content 与 privateToBot（任务书任务 13 界面动作）', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿标');
      const store = stack.core.services.memory!.storeFor(bot.id);
      const item = store.insert({
        kind: 'fact',
        content: '用户在杭州工作',
        source: 'explicit',
        evidence: [],
        origin: 'private',
        confidence: 1,
        sensitivity: 'normal',
        privateToBot: false,
      });

      // 只改 privateToBot：content 不变。
      const flagged = (await stack.core.rpc.call('memory.update', {
        id: item.id,
        botId: bot.id,
        privateToBot: true,
      })) as { items: Array<{ id: string; content: string; privateToBot: boolean }> };
      expect(flagged.items.find((entry) => entry.id === item.id)).toMatchObject({
        content: '用户在杭州工作',
        privateToBot: true,
      });

      // 只改 content：标记保持。
      const edited = (await stack.core.rpc.call('memory.update', {
        id: item.id,
        botId: bot.id,
        content: '用户在苏州工作',
      })) as { items: Array<{ id: string; content: string; privateToBot: boolean }> };
      expect(edited.items.find((entry) => entry.id === item.id)).toMatchObject({
        content: '用户在苏州工作',
        privateToBot: true,
      });

      // 凭据内容拒绝；空 patch 拒绝。
      await expect(
        stack.core.rpc.call('memory.update', {
          id: item.id,
          botId: bot.id,
          content: 'key 是 sk-abcdef1234567890',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        stack.core.rpc.call('memory.update', { id: item.id, botId: bot.id }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('厂商向量来源端到端可用（BR-P07-001）：写入即建索引，KNN 可检出，重建任务终态 done', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿厂');
      const conv = await openDirect(stack.core, bot.id);
      // 与设置页完全相同的路径：「向量模型」section 配置厂商 + 模型，
      // 「向量来源」切到厂商接口；厂商兼容根指向 mock LLM 的 /v1/embeddings。
      await stack.core.rpc.call('settings.update', {
        vendorProviders: [
          {
            id: 'dashscope',
            baseUrl: stack.llm.url,
            models: [{ id: 'qwen-plus' }],
          },
        ],
        capabilityModels: {
          embedding: { vendor: 'dashscope', model: 'text-embedding-v4' },
          rerank: null,
          multimodal: null,
          asr: null,
          tts: null,
          image: null,
          video: null,
        },
      });
      await stack.core.rpc.call('providers.setKey', {
        provider: 'dashscope',
        key: 'sk-vendor-embed-test',
      });
      const configured = (await stack.core.rpc.call('embedding.configure', {
        source: 'provider',
      })) as { source: string; ready: boolean; provider: string; dim: number | null };
      expect(configured.source).toBe('provider');
      expect(configured.provider).toBe('dashscope');
      expect(configured.ready).toBe(true); // 厂商条目 + key 均可解析
      expect(configured.dim).toBeNull(); // 尚无任何成功 embed

      const memory = stack.core.services.memory!;
      const written = await memory.writeMemory(bot.id, conv.id, {
        content: '用户的项目代号是蓝鲸计划',
        kind: 'episode',
        triggerMessages: [],
      });
      expect(written.ok).toBe(true);

      // 首次 embed 的维度持久化进 settings，status 返回非 null dim。
      const status = (await stack.core.rpc.call('embedding.status')) as {
        ready: boolean;
        dim: number | null;
      };
      expect(status.ready).toBe(true);
      expect(status.dim).toBe(8); // mock /v1/embeddings 的确定性维度

      // memory_vec_rebuild 任务终态 done（修复前恒 PROVIDER_UNAVAILABLE 永久 defer）。
      await waitFor(
        () => {
          const job = stack.core.services
            .mainDb!.prepare("select status from jobs where type = 'memory_vec_rebuild'")
            .get() as { status: string } | undefined;
          return job?.status === 'done' ? job : null;
        },
        { label: 'memory_vec_rebuild done' },
      );

      const store = memory.storeFor(bot.id);
      expect(store.vecDim()).toBe(8);
      expect(store.vecModelId()).toBe('provider:dashscope/text-embedding-v4');

      // 写入的条目可被 KNN 检出：用与 mock 端点相同的确定性向量查询。
      const hits = store.knn(mockEmbedding('用户的项目代号是蓝鲸计划'), 5);
      expect(hits.map((entry) => entry.id)).toContain(written.item!.id);

      // 混合检索端到端走厂商 embedder（修复前 knn 分支永不进入）。
      const recalled = await memory.recall(bot.id, conv.id, '项目代号是什么');
      expect(recalled.items.some((entry) => entry.id === written.item!.id)).toBe(true);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('国内厂商能力测试：providers.test 按能力经网关探测；条目只承载对话模型', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      // dashscope 条目的兼容根指向 mock LLM：适配器的兼容向量分支
      // （text-embedding-v4 → {baseUrl}/embeddings）即打到 mock 端点上。
      await stack.core.rpc.call('settings.update', {
        vendorProviders: [
          {
            id: 'dashscope',
            baseUrl: stack.llm.url,
            models: [{ id: 'qwen-plus' }],
          },
        ],
      });
      await stack.core.rpc.call('providers.setKey', {
        provider: 'dashscope',
        key: 'sk-dash-embed',
      });

      // 能力测试不要求厂商条目登记对应模型：显式 capability 经网关路由到适配器。
      await expect(
        stack.core.rpc.call('providers.test', {
          provider: 'dashscope',
          model: 'text-embedding-v4',
          capability: 'embedding',
        }),
      ).resolves.toEqual({ ok: true });

      // 「向量模型」section 配置 + 「向量来源」切厂商接口后，status 就绪。
      await stack.core.rpc.call('settings.update', {
        capabilityModels: {
          embedding: { vendor: 'dashscope', model: 'text-embedding-v4' },
          rerank: null,
          multimodal: null,
          asr: null,
          tts: null,
          image: null,
          video: null,
        },
      });
      await stack.core.rpc.call('embedding.configure', { source: 'provider' });
      const status = (await stack.core.rpc.call('embedding.status')) as {
        source: string;
        provider: string;
        model: string;
        ready: boolean;
      };
      expect(status.source).toBe('provider');
      expect(status.provider).toBe('dashscope');
      expect(status.model).toBe('text-embedding-v4');
      expect(status.ready).toBe(true);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);
});
