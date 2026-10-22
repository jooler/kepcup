import { describe, expect, it } from 'vitest';
import {
  createTestStack,
  listAllMessages,
  listMessages,
  makeBot,
  makeProject,
  openDirect,
  sendDrafts,
  step,
  waitFor,
} from '@kepcup/testkit';
import type { Run, RunIdentity } from '@kepcup/shared';
import type { CoreHarness } from '@kepcup/core';

// 反思输出引用真实消息 id：两阶段编排——第一轮产生消息并空反射，
// 第二轮的反射步骤用第一轮的真实消息 id 作为证据。
const TEST_ENV = {
  KEPCUP_PROFILE_CURATION_DELAY_MS: '60000',
  KEPCUP_REFLECTION_DEBOUNCE_MS: '0',
};

function emptyReflection() {
  return {
    runSummary: '无新记忆',
    memories: [],
    profileProposals: [],
    wikiSuggestions: [],
    skillSuggestion: null,
  };
}

interface TurnMessages {
  userMsgId: string;
  botMsgId: string;
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

async function waitForReflectionsDone(core: CoreHarness, count: number): Promise<void> {
  await waitFor(
    () => {
      const rows = core.services
        .mainDb!.prepare("select status from jobs where type = 'reflection' order by created_at")
        .all() as Array<{ status: string }>;
      return rows.length >= count && rows.every((row) => row.status === 'done') ? true : null;
    },
    { label: `${count} reflection job(s) done` },
  );
}

/** 跑一轮（空反射）并返回该批次的用户/Bot 消息 id。 */
async function seedTurn(
  stack: Awaited<ReturnType<typeof createTestStack>>,
  conversationId: string,
  text: string,
): Promise<TurnMessages> {
  const before = reflectionCount(stack.core);
  stack.llm.script('mock-main', [step().replyText('好的')]);
  await sendDrafts(stack.core, conversationId, [{ text }]);
  await completedRun(stack.core, conversationId);
  // 该轮的反射紧随其后：给一个空反射，等待它完成（消息 id 此后稳定）。
  stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
  await waitForReflectionsDone(stack.core, before + 1);
  const messages = await listMessages(stack.core, conversationId);
  return {
    userMsgId: messages.find((m) => m.senderType === 'user')!.id,
    botMsgId: messages.find((m) => m.senderType === 'bot')!.id,
  };
}

function reflectionCount(core: CoreHarness): number {
  return (
    core.services
      .mainDb!.prepare("select count(*) as n from jobs where type = 'reflection'")
      .get() as {
      n: number;
    }
  ).n;
}

describe('P07 反思（集成，mock 反思 JSON）', () => {
  it('反思写入记忆（证据来自用户消息）；runSummary 进入 runs.summary；建议只存 pending', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿思');
      const conv = await openDirect(stack.core, bot.id);
      const { userMsgId } = await seedTurn(stack, conv.id, '我的部署流程都在 Deploy.md 里');

      stack.llm.script('mock-main', [step().replyText('嗯')]);
      stack.llm.script('mock-light', [
        step().replyJson({
          runSummary: '用户介绍了自己的部署流程',
          memories: [
            {
              kind: 'fact',
              content: '用户的部署文档是 Deploy.md',
              source: 'explicit',
              evidenceMessageIds: [userMsgId],
              confidence: 0.9,
              sensitivity: 'normal',
              privateToBot: false,
            },
          ],
          profileProposals: [],
          wikiSuggestions: [
            { sourceType: 'attachment', ref: 'att_demo', note: '部署文档值得入库' },
          ],
          skillSuggestion: { name: 'deploy', description: '固定部署流程', reason: '重复任务' },
        }),
      ]);
      await sendDrafts(stack.core, conv.id, [{ text: '再说一遍部署文档' }]);
      const run = await completedRun(stack.core, conv.id);
      await waitForReflectionsDone(stack.core, 2);

      const result = (await stack.core.rpc.call('memory.list', { botId: bot.id })) as {
        items: Array<{ content: string; origin: string; status: string }>;
      };
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.content).toContain('Deploy.md');
      expect(result.items[0]!.origin).toBe('private');

      const fresh = (await stack.core.rpc.call('runs.list', {
        conversationId: conv.id,
        limit: 10,
      })) as {
        runs: Run[];
      };
      const responseRuns = fresh.runs.filter((r) => r.loopType === 'turn');
      expect(responseRuns.some((r) => r.summary === '用户介绍了自己的部署流程')).toBe(true);
      void run;

      // 反思输入包含执行步骤概要（04 反思输入契约，BR-P07-009），
      // 且以 <untrusted> 做数据界定。
      const reflectionRequests = stack.llm.requestsFor('mock-light');
      const withSteps = reflectionRequests.find((req) =>
        String(req.lastUserText()).includes('<execution_steps>'),
      );
      expect(withSteps).toBeDefined();
      expect(String(withSteps!.lastUserText())).toContain('<untrusted>');

      // wiki 建议自 P09 起被消费：jobs-runner 把它转成 wiki_ingest 任务登记
      // （此处的 ref 不是真实附件，入库任务会以失败终态，无副作用）；技能建议
      // P08 起有消费方（后台并发 2），可能已被认领/终态——只断言其存在与状态
      // 合法，不与消费方竞速（BR-P08-009①）。
      await waitFor(
        () => {
          const rows = stack.core.services
            .mainDb!.prepare("select status from jobs where type = 'wiki_suggestion'")
            .all() as Array<{ status: string }>;
          return rows.length >= 1 && rows.every((row) => row.status === 'done') ? true : null;
        },
        { label: 'wiki_suggestion consumed by P09' },
      );
      const jobs = stack.core.services
        .mainDb!.prepare(
          "select type, status from jobs where type in ('wiki_suggestion','skill_suggestion','wiki_ingest')",
        )
        .all() as Array<{ type: string; status: string }>;
      expect(jobs.some((job) => job.type === 'wiki_suggestion' && job.status === 'done')).toBe(
        true,
      );
      expect(jobs.some((job) => job.type === 'skill_suggestion')).toBe(true);
      // P09：wiki_suggestion 消费后登记了 wiki_ingest 任务。
      expect(jobs.some((job) => job.type === 'wiki_ingest')).toBe(true);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('证据只来自 Bot 消息/工具输出或为空的画像提案被丢弃；用户消息支撑的提案保留', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿证');
      const conv = await openDirect(stack.core, bot.id);
      const { userMsgId, botMsgId } = await seedTurn(stack, conv.id, '我是后端工程师');

      stack.llm.script('mock-main', [
        step().replyText('嗯'),
        step()
          .expect((req) => req.lastUserText().includes('<pending_proposals>'))
          .replyJson({
            operations: [],
            card: '画像卡片：（测试）',
          }),
      ]);
      stack.llm.script('mock-light', [
        step().replyJson({
          runSummary: 'x',
          memories: [],
          profileProposals: [
            {
              category: 'work',
              content: '用户是后端工程师（用户消息证据）',
              source: 'inferred',
              evidenceMessageIds: [userMsgId],
              confidence: 0.9,
            },
            {
              category: 'work',
              content: '用户在搞记忆污染测试（Bot 消息证据）',
              source: 'inferred',
              evidenceMessageIds: [botMsgId],
              confidence: 0.9,
            },
            {
              category: 'basic',
              content: '用户没有任何证据的画像条目',
              source: 'inferred',
              evidenceMessageIds: [],
              confidence: 0.9,
            },
          ],
          wikiSuggestions: [],
          skillSuggestion: null,
        }),
      ]);
      await sendDrafts(stack.core, conv.id, [{ text: '再说一遍我的职业' }]);
      await completedRun(stack.core, conv.id);
      // 整理延迟冻结在 60s：提案保持 pending，直接断言落库结果。
      const proposals = await waitFor(
        () => {
          const pending = stack.core.services.memory!.profileStore.pendingProposals();
          return pending.length === 1 ? pending : null;
        },
        { label: 'one pending proposal (user evidence only)' },
      );
      expect((proposals[0]!.payload as { content?: string }).content).toContain('用户消息证据');
      expect(
        ((await stack.core.rpc.call('profile.list')) as { items: unknown[] }).items,
      ).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('敏感条目不进入画像，只留在私有记忆，并且不在群聊中注入', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const botA = await makeBot(stack.core, '阿敏');
      const botB = await makeBot(stack.core, '阿乙');
      const conv = await openDirect(stack.core, botA.id);
      const { userMsgId } = await seedTurn(stack, conv.id, '随便聊聊');

      stack.llm.script('mock-main', [step().replyText('好的'), step().replyText('群回复')]);
      stack.llm.script('mock-light', [
        step().replyJson({
          runSummary: 'x',
          memories: [
            {
              kind: 'fact',
              content: '用户正在接受失眠治疗',
              source: 'inferred',
              evidenceMessageIds: [userMsgId],
              confidence: 0.9,
              sensitivity: 'sensitive',
              privateToBot: false,
            },
            {
              kind: 'fact',
              content: '用户的猫叫年糕',
              source: 'explicit',
              evidenceMessageIds: [userMsgId],
              confidence: 1,
              sensitivity: 'normal',
              privateToBot: false,
            },
          ],
          // 同一敏感内容若被提议进画像，应被降级（不出现提案条目）。
          profileProposals: [
            {
              category: 'basic',
              content: '用户正在接受失眠治疗',
              source: 'inferred',
              evidenceMessageIds: [userMsgId],
              confidence: 0.9,
            },
          ],
          wikiSuggestions: [],
          skillSuggestion: null,
        }),
      ]);
      await sendDrafts(stack.core, conv.id, [{ text: '我最近在看医生' }]);
      await completedRun(stack.core, conv.id);
      await waitForReflectionsDone(stack.core, 2);

      expect(
        ((await stack.core.rpc.call('profile.list')) as { items: unknown[] }).items,
      ).toHaveLength(0);
      const result = (await stack.core.rpc.call('memory.list', { botId: botA.id })) as {
        items: Array<{ content: string; sensitivity: string }>;
      };
      const sensitive = result.items.find((item) => item.content.includes('失眠'));
      expect(sensitive).toBeDefined();
      expect(sensitive!.sensitivity).toBe('sensitive');
      expect(result.items.find((item) => item.content.includes('年糕'))).toBeDefined();

      // 群聊注入：敏感排除；私聊来源条目带 origin="private" 标注。
      const group = await makeProject(stack.core, '测试群', [botA.id, botB.id]);
      await sendDrafts(stack.core, group.id, [{ text: '聊聊用户的猫吧', mentions: [botA.id] }]);
      await waitFor(
        () =>
          stack.llm
            .requestsFor('mock-main')
            .some((req) => JSON.stringify(req.body).includes('年糕'))
            ? true
            : null,
        { label: 'group injection' },
      );
      const body = JSON.stringify(
        stack.llm.requestsFor('mock-main').find((req) => JSON.stringify(req.body).includes('年糕'))
          ?.body,
      );
      expect(body).not.toContain('失眠');
      expect(body).toContain('来自私聊'); // origin="private" 标注（JSON 转义后匹配中文注释）
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('“只告诉你”的条目不进入画像，只留在该 Bot 的私有记忆', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿密');
      const conv = await openDirect(stack.core, bot.id);
      const { userMsgId } = await seedTurn(stack, conv.id, '随便聊聊');

      stack.llm.script('mock-main', [step().replyText('放心')]);
      stack.llm.script('mock-light', [
        step().replyJson({
          runSummary: 'x',
          memories: [
            {
              kind: 'fact',
              content: '用户正在秘密准备跳槽',
              source: 'explicit',
              evidenceMessageIds: [userMsgId],
              confidence: 1,
              sensitivity: 'normal',
              privateToBot: true,
            },
          ],
          profileProposals: [
            {
              category: 'recent',
              content: '用户正在秘密准备跳槽',
              source: 'explicit',
              evidenceMessageIds: [userMsgId],
              confidence: 1,
            },
          ],
          wikiSuggestions: [],
          skillSuggestion: null,
        }),
      ]);
      await sendDrafts(stack.core, conv.id, [{ text: '这件事只告诉你：我在准备跳槽' }]);
      await completedRun(stack.core, conv.id);
      await waitForReflectionsDone(stack.core, 2);

      expect(
        ((await stack.core.rpc.call('profile.list')) as { items: unknown[] }).items,
      ).toHaveLength(0);
      const result = (await stack.core.rpc.call('memory.list', { botId: bot.id })) as {
        items: Array<{ content: string; privateToBot: boolean }>;
      };
      const secret = result.items.find((item) => item.content.includes('跳槽'));
      expect(secret).toBeDefined();
      expect(secret!.privateToBot).toBe(true);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('用户消息中出现凭据时不产生对话提醒（内部事务原则）；凭据内容不进入记忆', async () => {
    const stack = await createTestStack({ env: TEST_ENV });
    try {
      const bot = await makeBot(stack.core, '阿警');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [step().replyText('好的'), step().replyText('继续聊')]);
      stack.llm.script('mock-light', [
        step().replyJson({
          runSummary: 'x',
          memories: [
            {
              kind: 'fact',
              content: '用户的密码是abc123456',
              source: 'explicit',
              evidenceMessageIds: [],
              confidence: 1,
              sensitivity: 'normal',
              privateToBot: false,
            },
          ],
          profileProposals: [],
          wikiSuggestions: [],
          skillSuggestion: null,
        }),
        step().replyJson(emptyReflection()),
      ]);
      await sendDrafts(stack.core, conv.id, [{ text: '我的密码是abc123456 你记一下' }]);
      await completedRun(stack.core, conv.id);
      await sendDrafts(stack.core, conv.id, [{ text: '继续' }]);
      await completedRun(stack.core, conv.id);
      await waitForReflectionsDone(stack.core, 2);

      // 凭据处理是 Bot 自己的记忆事务：对话里没有 credential_warning，
      // domain 层也不应有任何凭据提醒消息。
      const messages = await listAllMessages(stack.core, conv.id);
      const warnings = messages.filter(
        (message) =>
          message.kind === 'system_event' &&
          (message.content as { event?: string }).event === 'credential_warning',
      );
      expect(warnings).toHaveLength(0);
      const result = (await stack.core.rpc.call('memory.list', { botId: bot.id })) as {
        items: unknown[];
      };
      expect(result.items).toHaveLength(0); // 凭据内容未被记住
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('去抖窗口：连续两轮只产生一次反思，两个 run 的记忆都写入', async () => {
    const stack = await createTestStack({
      env: {
        KEPCUP_PROFILE_CURATION_DELAY_MS: '60000',
        KEPCUP_REFLECTION_DEBOUNCE_MS: '600000',
      },
    });
    try {
      const bot = await makeBot(stack.core, '阿抖');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [step().replyText('好'), step().replyText('嗯')]);
      await sendDrafts(stack.core, conv.id, [{ text: '我住在杭州' }]);
      await completedRun(stack.core, conv.id);
      await sendDrafts(stack.core, conv.id, [{ text: '我每天早上跑步' }]);
      await waitFor(
        async () => {
          const result = (await stack.core.rpc.call('runs.list', {
            conversationId: conv.id,
            limit: 20,
          })) as { runs: Run[] };
          return result.runs.filter((run) => run.loopType === 'turn' && run.status === 'completed')
            .length >= 2
            ? true
            : null;
        },
        { label: 'two completed turns' },
      );

      const key = `reflection_debounce:${bot.id}:${conv.id}`;
      const job = await waitFor(
        () => {
          const row = stack.core.services
            .mainDb!.prepare('select * from jobs where dedupe_key = ?')
            .get(key) as { status: string; run_after: number; payload_json: string } | undefined;
          if (row === undefined) return null;
          const payload = JSON.parse(row.payload_json) as { entries?: unknown[] };
          return (payload.entries?.length ?? 0) === 2 ? row : null;
        },
        { label: 'debounced reflection job with two entries' },
      );
      expect(job.status).toBe('pending');
      expect(job.run_after).toBeGreaterThan(Date.now());

      const messages = await listMessages(stack.core, conv.id);
      const userIds = messages.filter((message) => message.senderType === 'user').map((m) => m.id);
      expect(userIds).toHaveLength(2);
      stack.llm.script('mock-light', [
        step().replyJson({
          runSummary: '用户住在杭州并每天晨跑',
          memories: [
            {
              kind: 'fact',
              content: '用户住在杭州',
              source: 'explicit',
              evidenceMessageIds: [userIds[0]],
              confidence: 0.9,
              sensitivity: 'normal',
              privateToBot: false,
            },
            {
              kind: 'preference',
              content: '用户每天早上跑步',
              source: 'explicit',
              evidenceMessageIds: [userIds[1]],
              confidence: 0.9,
              sensitivity: 'normal',
              privateToBot: false,
            },
          ],
          profileProposals: [],
          wikiSuggestions: [],
          skillSuggestion: null,
        }),
      ]);
      stack.core.services.domain!.jobs.hasten(key, stack.core.services.clock.now());
      await waitForReflectionsDone(stack.core, 1);

      const result = (await stack.core.rpc.call('memory.list', { botId: bot.id })) as {
        items: Array<{ content: string }>;
      };
      expect(result.items.map((item) => item.content).sort()).toEqual(
        ['用户住在杭州', '用户每天早上跑步'].sort(),
      );
      const runs = (await stack.core.rpc.call('runs.list', {
        conversationId: conv.id,
        limit: 20,
      })) as { runs: Run[] };
      expect(runs.runs.filter((run) => run.loopType === 'reflection')).toHaveLength(1);
      const reflectionRequest = stack.llm
        .requestsFor('mock-light')
        .find((req) => String(req.lastUserText()).includes('<debounced_runs>'));
      expect(reflectionRequest).toBeDefined();
      expect(String(reflectionRequest!.lastUserText())).toContain('<debounced_runs>');
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('同一 run 在窗口内重复登记不会产生重复 entry', async () => {
    const stack = await createTestStack({
      env: {
        KEPCUP_PROFILE_CURATION_DELAY_MS: '60000',
        KEPCUP_REFLECTION_DEBOUNCE_MS: '600000',
      },
    });
    try {
      const bot = await makeBot(stack.core, '阿重');
      const conv = await openDirect(stack.core, bot.id);
      stack.llm.script('mock-main', [step().replyText('好')]);
      await sendDrafts(stack.core, conv.id, [{ text: '你好' }]);
      const turn = await completedRun(stack.core, conv.id);
      stack.core.services.memory!.registerReflection({
        runId: turn.id,
        botId: bot.id,
        conversationId: conv.id,
        triggerMessageIds: [],
        batchId: null,
        kind: 'turn',
      });

      const key = `reflection_debounce:${bot.id}:${conv.id}`;
      const row = stack.core.services
        .mainDb!.prepare('select payload_json from jobs where dedupe_key = ?')
        .get(key) as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as { entries: Array<{ runId: string }> };
      expect(payload.entries).toHaveLength(1);
      expect(payload.entries[0]!.runId).toBe(turn.id);
    } finally {
      await stack.cleanup();
    }
  }, 40_000);

  it('任务完成后冲刷窗口内待执行的对话轮反思', async () => {
    const stack = await createTestStack({
      env: {
        KEPCUP_PROFILE_CURATION_DELAY_MS: '60000',
        KEPCUP_REFLECTION_DEBOUNCE_MS: '600000',
      },
    });
    try {
      const bot = await makeBot(stack.core, '阿冲');
      const conv = await openDirect(stack.core, bot.id);
      // 对话轮 + 任务执行 + 任务结果唤醒轮。
      stack.llm.script('mock-main', [
        step().replyText('好'),
        step().replyText('任务完成'),
        step().replyText('任务结果已收到'),
      ]);
      stack.llm.script('mock-light', [
        step().replyJson(emptyReflection()),
        step().replyJson(emptyReflection()),
      ]);
      await sendDrafts(stack.core, conv.id, [{ text: '我住在杭州' }]);
      const turn = await completedRun(stack.core, conv.id);

      const identity: RunIdentity = {
        runId: turn.id,
        botId: bot.id,
        conversationId: conv.id,
        loopType: 'turn',
      };
      const started = stack.core.services.orchestrator!.tasks.start(identity, {
        title: '整理文件',
        instruction: '整理一下 workspace',
        sourceMessageIds: [],
        writes: false,
      });
      await waitFor(
        async () => {
          const result = (await stack.core.rpc.call('runs.list', {
            conversationId: conv.id,
            limit: 30,
          })) as { runs: Run[] };
          const task = result.runs.find((run) => run.id === started.taskId);
          return task?.status === 'completed' ? true : null;
        },
        { label: 'task completed' },
      );

      const key = `reflection_debounce:${bot.id}:${conv.id}`;
      await waitFor(
        () => {
          const row = stack.core.services
            .mainDb!.prepare('select status, run_after from jobs where dedupe_key = ?')
            .get(key) as { status: string; run_after: number } | undefined;
          if (row === undefined) return null;
          // The task flush pulled the window forward: it is running / done now.
          return row.status === 'pending' && row.run_after > Date.now() ? null : true;
        },
        { label: 'turn reflection flushed by task completion' },
      );
    } finally {
      await stack.cleanup();
    }
  }, 40_000);
});
