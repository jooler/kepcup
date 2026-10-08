import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTestStack,
  listMessages,
  makeBot,
  makeGroup,
  openDirect,
  sendDrafts,
  step,
  TestClock,
  waitFor,
  type MockChatRequest,
  type MockLlmServer,
} from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';
import { createMemoryKeystore, type CoreHarness, type ScheduleService } from '@kepcup/core';
import { nextLocalMidnight } from '../../src/memory/local-date.js';

/**
 * P10 主动消息与调度（集成）。时间全部走 TestClock + 虚拟定时器：任务的
 * 定时器、fire job 的 run_after、护栏的重试时刻都以虚拟时钟计算，测试中
 * "前进一分钟 / 三小时" 是同步操作，绝不真实等待；fire job 由 jobs-runner
 * 的真实轮询在数百毫秒内认领。mock 模型步骤用 lastUserText 谓词对齐
 * （踩坑清单：工具结果轮的 lastUserText 仍是触发消息）。
 *
 * 每个用例独立的 TestClock：cron 用例的对齐断言依赖整点边界，共享时钟会
 * 随用例累积漂移。触发段属性断言走 lastUserText() 原文——requestBodiesContain
 * 匹配 JSON.stringify 后的文本，引号被转义，永远匹配不到带引号的子串。
 */

function schedulesOf(stack: { core: { services: { schedules: ScheduleService | null } } }): ScheduleService {
  const service = stack.core.services.schedules;
  if (service === null) throw new Error('schedule service not wired');
  return service;
}

/** Waits for a completed scheduled response run (any bot) in the conversation. */
function waitForScheduledRun(core: CoreHarness, conversationId: string, timeoutMs = 15_000): Promise<Run> {
  return waitFor(
    async () => {
      const result = (await core.rpc.call('runs.list', { conversationId, limit: 100 })) as {
        runs: Run[];
      };
      return (
        result.runs.find(
          (r) => r.triggerReason === 'scheduled' && r.loopType === 'turn' && r.status === 'completed',
        ) ?? null
      );
    },
    { label: 'scheduled response run', timeoutMs },
  );
}

/** The recorded mock-main request whose trigger message contains `marker`. */
function requestWithTriggerText(llm: MockLlmServer, marker: string): MockChatRequest | undefined {
  return llm.requestsFor('mock-main').find((r) => r.lastUserText().includes(marker));
}

/** Negative wait: no scheduled run appears within `ms` of real time. */
async function expectNoScheduledRun(
  core: CoreHarness,
  conversationId: string,
  ms = 1200,
  excludeRunIds: readonly string[] = [],
): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  const result = (await core.rpc.call('runs.list', { conversationId, limit: 100 })) as {
    runs: Run[];
  };
  expect(
    result.runs.filter(
      (r) =>
        r.triggerReason === 'scheduled' && r.loopType === 'turn' && !excludeRunIds.includes(r.id),
    ),
  ).toHaveLength(0);
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

/** ISO wall time the virtual clock will reach after `ms`. */
function isoAfter(clock: TestClock, ms: number): string {
  return new Date(clock.now() + ms).toISOString();
}

describe('P10 主动消息与调度（集成，可控时钟）', () => {
  it('schedule 一分钟后 → 时钟前进 → 执行被触发，触发段为 scheduled；一次性任务标 done', async () => {
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    try {
      const bot = await makeBot(stack.core, '阿钟');
      const conv = await openDirect(stack.core, bot.id);

      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('帮我定个提醒'))
          .replyToolCall('schedule', { when: isoAfter(clock, 60_000), note: '提醒喝水' }),
        step().replyText('好的，一分钟内提醒你'),
        step()
          .expect((req) => req.lastUserText().includes('<trigger reason="scheduled"'))
          .replyText('时间到啦，该喝水了'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection()), step().replyJson(emptyReflection())]);

      await sendDrafts(stack.core, conv.id, [{ text: '帮我定个提醒：一分钟内提醒喝水' }]);
      await waitFor(
        async () => {
          const result = (await stack.core.rpc.call('runs.list', { conversationId: conv.id, limit: 50 })) as {
            runs: Run[];
          };
          return result.runs.find((r) => r.status === 'completed' && r.loopType === 'turn') ?? null;
        },
        { label: 'creation run completed' },
      );

      const service = schedulesOf(stack);
      const [row] = service.listForBotInConversation(bot.id, conv.id);
      expect(row).toBeDefined();
      expect(row!.kind).toBe('once');
      expect(row!.nextFireAt).toBe(clock.now() + 60_000);
      expect(row!.status).toBe('active');

      // 时钟前进一分钟：虚拟定时器触发 → schedule_fire job → Mailbox 投递。
      clock.advance(60_000);
      const run = await waitForScheduledRun(stack.core, conv.id);
      expect(run.triggerReason).toBe('scheduled');
      // 触发段带 schedule_id 属性（04-agent-runtime.md 触发段；原文匹配以绕开
      // JSON 转义）。
      const fireRequest = requestWithTriggerText(stack.llm, '定时任务触发：提醒喝水');
      expect(fireRequest).toBeDefined();
      expect(fireRequest!.lastUserText()).toContain('schedule_id="sch_');
      expect(stack.llm.requestBodiesContain('定时任务触发：提醒喝水')).toBe(true);
      const messages = await listMessages(stack.core, conv.id);
      expect(messages.some((m) => m.senderType === 'bot' && m.content.text === '时间到啦，该喝水了')).toBe(true);

      const done = service.store.get(row!.id);
      expect(done?.status).toBe('done');
      expect(done?.nextFireAt).toBeNull();
      expect(done?.lastFiredAt).not.toBeNull();
    } finally {
      await stack.cleanup();
    }
  });

  it('承诺带截止时间 → 自动创建任务 → 到期触发带承诺内容；删除对话 → 承诺作废、任务删除', async () => {
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    try {
      const bot = await makeBot(stack.core, '阿诺');
      const conv = await openDirect(stack.core, bot.id);

      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('答应你'))
          .replyToolCall('remember', {
            content: '周五之前把反馈整理给用户',
            kind: 'commitment',
            due_at: isoAfter(clock, 2 * 60_000),
          }),
        step().replyText('记住了，到时提醒我'),
        step()
          .expect((req) => req.lastUserText().includes('承诺到期：周五之前把反馈整理给用户'))
          .replyText('到时间了：这是整理好的反馈'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection()), step().replyJson(emptyReflection())]);

      await sendDrafts(stack.core, conv.id, [{ text: '答应你周五之前给反馈，到时提醒我' }]);
      await waitFor(
        async () => {
          const result = (await stack.core.rpc.call('runs.list', { conversationId: conv.id, limit: 50 })) as {
            runs: Run[];
          };
          return result.runs.find((r) => r.status === 'completed' && r.loopType === 'turn') ?? null;
        },
        { label: 'remember run completed' },
      );

      const service = schedulesOf(stack);
      const items = (await stack.core.rpc.call('memory.list', { botId: bot.id })) as {
        items: Array<{ id: string; kind: string; status: string; dueAt: number | null }>;
      };
      const commitment = items.items.find((i) => i.kind === 'commitment');
      expect(commitment).toBeDefined();
      // 承诺联动：自动创建一次性任务并写 commitment_id（P10 任务 6）。
      const rows = service.listForBotInConversation(bot.id, conv.id);
      const linked = rows.find((r) => r.commitmentId === commitment!.id);
      expect(linked).toBeDefined();
      expect(linked!.kind).toBe('once');
      expect(linked!.nextFireAt).toBe(commitment!.dueAt);

      clock.advance(2 * 60_000);
      const run = await waitForScheduledRun(stack.core, conv.id);
      expect(run.triggerReason).toBe('scheduled');
      // 触发段附承诺内容（任务书任务 3）。
      expect(stack.llm.requestBodiesContain('承诺到期：周五之前把反馈整理给用户')).toBe(true);

      // 删除对话：承诺作废（P07 级联）、任务删除（03-data-model 删除级联）。
      await stack.core.rpc.call('conversations.delete', { id: conv.id });
      const after = (await stack.core.rpc.call('memory.list', { botId: bot.id })) as {
        items: Array<{ id: string; status: string }>;
      };
      expect(after.items.find((i) => i.id === commitment!.id)?.status).toBe('void');
      expect(service.store.get(linked!.id)).toBeNull();
    } finally {
      await stack.cleanup();
    }
  });

  it('模拟休眠 3 小时后 power.resume → 补触发 late_by ≈ 3 小时；周期任务错过 3 次只补 1 次', async () => {
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    try {
      const onceBot = await makeBot(stack.core, '阿眠');
      const cronBot = await makeBot(stack.core, '阿周');
      const onceConv = await openDirect(stack.core, onceBot.id);
      const cronConv = await openDirect(stack.core, cronBot.id);
      const service = schedulesOf(stack);

      const onceAt = clock.now() + 60_000;
      service.createOnce({
        botId: onceBot.id,
        conversationId: onceConv.id,
        runAt: onceAt,
        note: '喝水提醒',
      });
      const cronStart = clock.now();
      service.createCron({
        botId: cronBot.id,
        conversationId: cronConv.id,
        expression: '0 * * * *',
        note: '整点站会提醒',
      });

      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('late_by="2 小时 59 分钟"'))
          .replyText('抱歉迟到了，喝水提醒现在补上'),
        step()
          .expect((req) => req.lastUserText().includes('late_by="2 小时"'))
          .replyText('错过的整点提醒补一次'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection()), step().replyJson(emptyReflection())]);

      // 休眠：停掉定时器（OS 休眠期间定时器不走），时钟前进 3 小时。
      service.disarmTimerForTest();
      clock.advance(3 * 60 * 60_000);
      await expectNoScheduledRun(stack.core, onceConv.id, 600);
      await expectNoScheduledRun(stack.core, cronConv.id, 200);

      // power.resume（端口 B 平台方法）→ 补触发。
      await stack.core.services.platformMethods['power.resume'].handle(undefined);

      const onceRun = await waitForScheduledRun(stack.core, onceConv.id);
      expect(onceRun.triggerReason).toBe('scheduled');
      // 04:01 的任务 07:00 才触发 → late_by = 2 小时 59 分钟（>1 分钟才标注）。
      // 属性断言走触发请求的原文（requestBodiesContain 匹配 JSON 转义文本，
      // 带引号子串永远不匹配）。
      const onceRequest = requestWithTriggerText(stack.llm, '定时任务触发：喝水提醒');
      expect(onceRequest).toBeDefined();
      expect(onceRequest!.lastUserText()).toContain('late_by="2 小时 59 分钟"');

      const cronRun = await waitForScheduledRun(stack.core, cronConv.id);
      expect(cronRun.triggerReason).toBe('scheduled');
      // 05:00 / 06:00 / 07:00 三次错过只补一次：late_by 按最早一次 = 2 小时。
      const cronRequest = requestWithTriggerText(stack.llm, '定时任务触发：整点站会提醒');
      expect(cronRequest).toBeDefined();
      expect(cronRequest!.lastUserText()).toContain('late_by="2 小时"');

      const cronRuns = (await stack.core.rpc.call('runs.list', { conversationId: cronConv.id, limit: 100 })) as {
        runs: Run[];
      };
      expect(
        cronRuns.runs.filter((r) => r.triggerReason === 'scheduled' && r.loopType === 'turn'),
      ).toHaveLength(1);
      // 周期任务从 now 之后的第一个整点继续。
      const cronRow = service.listForBotInConversation(cronBot.id, cronConv.id)[0];
      expect(cronRow?.nextFireAt).toBe(cronStart + 4 * 60 * 60_000); // 08:00Z
      const onceRow = service.listForBotInConversation(onceBot.id, onceConv.id)[0];
      expect(onceRow).toBeUndefined(); // 一次性任务触发后 done，不再列出
      expect(service.store.listActive().find((r) => r.id === cronRow?.id)).toBeDefined();
    } finally {
      await stack.cleanup();
    }
  });

  it('超远期任务的定时器延迟被钳制在 setTimeout 溢出阈值内（防护热循环）', async () => {
    const clock = new TestClock();
    const armedDelays: number[] = [];
    const timers = {
      setTimer: (delayMs: number, _fn: () => void) => {
        armedDelays.push(delayMs);
        return () => {};
      },
    };
    const stack = await createTestStack({ clock, timers });
    try {
      const bot = await makeBot(stack.core, '阿远');
      const conv = await openDirect(stack.core, bot.id);
      // 一年后的任务：原始延迟 > 2^31-1 ms，Node 会把 setTimeout 钳到 1ms。
      schedulesOf(stack).createOnce({
        botId: bot.id,
        conversationId: conv.id,
        runAt: clock.now() + 400 * 24 * 60 * 60_000,
        note: '明年见',
      });
      expect(armedDelays.length).toBeGreaterThan(0);
      expect(armedDelays.every((d) => d > 0 && d <= 2 ** 31 - 1 - 60_000)).toBe(true);
    } finally {
      await stack.cleanup();
    }
  });

  it('免打扰时段内的触发推迟到时段结束；每日上限推迟到次日；skip_reply 不计数', async () => {
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    try {
      const machineTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const wallTime = (ms: number): string => {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: machineTz,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(ms));
        return parts;
      };
      const service = schedulesOf(stack);

      // --- 免打扰：触发时刻落在窗口内 → 推迟到窗口结束 ---
      const quietBot = await makeBot(stack.core, '阿静');
      const quietConv = await openDirect(stack.core, quietBot.id);
      const quietStartMs = clock.now() + 30 * 60_000;
      const quietEndMs = clock.now() + 90 * 60_000;
      await stack.core.rpc.call('bots.update', {
        id: quietBot.id,
        profile: {
          ...quietBot.profile,
          behavior: { proactive: true, quiet_hours: [wallTime(quietStartMs), wallTime(quietEndMs)], max_proactive_per_day: null },
        },
      });
      service.createOnce({
        botId: quietBot.id,
        conversationId: quietConv.id,
        runAt: clock.now() + 40 * 60_000, // 窗口内
        note: '静音期任务',
      });

      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('静音期任务'))
          .replyText('静音结束，现在提醒'),
        step()
          .expect((req) => req.lastUserText().includes('超额任务'))
          .replyText('超额任务被推迟了'),
        step()
          .expect((req) => req.lastUserText().includes('不用回复的任务'))
          .replyToolCall('skip_reply', { reason: '无需回应' }),
        step()
          .expect((req) => req.lastUserText().includes('不用回复的任务'))
          .replyText('第二次触发，这次回复了'),
      ]);
      stack.llm.script(
        'mock-light',
        [step().replyJson(emptyReflection()), step().replyJson(emptyReflection()), step().replyJson(emptyReflection()), step().replyJson(emptyReflection())],
      );

      clock.advance(40 * 60_000);
      await expectNoScheduledRun(stack.core, quietConv.id);
      const deferred = service.store.get(
        service.listForBotInConversation(quietBot.id, quietConv.id)[0]!.id,
      );
      expect(deferred?.status).toBe('active');
      expect(deferred?.nextFireAt).toBeGreaterThan(clock.now());
      // 推迟目标 ≈ 免打扰结束时刻（90 分钟处，±2 分钟容忍跨时区取整）
      expect(Math.abs(deferred!.nextFireAt! - (clock.now() - 40 * 60_000 + 90 * 60_000))).toBeLessThanOrEqual(
        2 * 60_000,
      );
      // 列表 API 给出推迟原因（任务 7 界面口径）
      const listed = (await stack.core.rpc.call('schedules.list', { conversationId: quietConv.id })) as {
        schedules: Array<{ deferredReason: string | null }>;
      };
      expect(listed.schedules[0]?.deferredReason).toBe('免打扰时段');

      clock.advance(51 * 60_000);
      const quietRun = await waitForScheduledRun(stack.core, quietConv.id);
      expect(quietRun.triggerReason).toBe('scheduled');
      expect(stack.llm.requestBodiesContain('静音期任务')).toBe(true);

      // --- 每日上限：达到上限推迟到次日零点 ---
      const capBot = await makeBot(stack.core, '阿额');
      const capConv = await openDirect(stack.core, capBot.id);
      await stack.core.rpc.call('bots.update', {
        id: capBot.id,
        profile: {
          ...capBot.profile,
          behavior: { proactive: true, quiet_hours: null, max_proactive_per_day: 1 },
        },
      });
      const runs = stack.core.services.runsDb!;
      // 种一条今天已完成且发出过消息的 scheduled 执行 → 该 Bot 计数 = 1。
      // （runs.db 是全局的：按 bot 过滤，避免把上面静音 Bot 的 run 计进来。）
      const seed = stack.core.services.domain!.runs.create({
        botId: capBot.id,
        conversationId: capConv.id,
        loopType: 'turn',
        triggerReason: 'scheduled',
        triggerMessageIds: [],
      });
      stack.core.services.domain!.runs.update(seed.id, {
        status: 'completed',
        outputMessageIds: ['msg_seed'],
      });
      expect(
        runs.prepare('select count(*) as n from runs where bot_id = ?').get(capBot.id),
      ).toMatchObject({ n: 1 });

      service.createOnce({
        botId: capBot.id,
        conversationId: capConv.id,
        runAt: clock.now() + 5 * 60_000,
        note: '超额任务',
      });
      clock.advance(5 * 60_000);
      await expectNoScheduledRun(stack.core, capConv.id, 1200, [seed.id]);
      const capDeferred = service.listForBotInConversation(capBot.id, capConv.id)[0];
      expect(capDeferred).toBeDefined();
      // 推迟目标 = 下一个本地零点（时区敏感，直接按实现同源函数计算期望）。
      expect(capDeferred!.nextFireAt).toBe(nextLocalMidnight(clock.now(), machineTz));
      const capListed = (await stack.core.rpc.call('schedules.list', {})) as {
        schedules: Array<{ deferredReason: string | null }>;
      };
      expect(
        capListed.schedules.find((s) => s.deferredReason !== null)?.deferredReason,
      ).toBe('今日主动消息已达上限');
      // 清掉推迟的任务，避免虚拟时钟继续前进时它再次尝试
      service.cancel(capDeferred!.id);

      // --- skip_reply 不计数：不发消息的执行不占每日上限 ---
      const skipBot = await makeBot(stack.core, '阿跳');
      const skipConv = await openDirect(stack.core, skipBot.id);
      await stack.core.rpc.call('bots.update', {
        id: skipBot.id,
        profile: {
          ...skipBot.profile,
          behavior: { proactive: true, quiet_hours: null, max_proactive_per_day: 1 },
        },
      });
      service.createOnce({
        botId: skipBot.id,
        conversationId: skipConv.id,
        runAt: clock.now() + 5 * 60_000,
        note: '不用回复的任务',
      });
      clock.advance(5 * 60_000);
      const skipRun = await waitForScheduledRun(stack.core, skipConv.id);
      expect(skipRun.triggerReason).toBe('scheduled');
      const skipMessages = await listMessages(stack.core, skipConv.id);
      expect(skipMessages.filter((m) => m.senderType === 'bot')).toHaveLength(0);
      // 第一次执行 skip_reply 后计数仍为 0 → 第二次任务照常触发
      service.createOnce({
        botId: skipBot.id,
        conversationId: skipConv.id,
        runAt: clock.now() + 5 * 60_000,
        note: '不用回复的任务',
      });
      clock.advance(5 * 60_000);
      await waitFor(
        async () => {
          const result = (await stack.core.rpc.call('runs.list', { conversationId: skipConv.id, limit: 100 })) as {
            runs: Run[];
          };
          const scheduled = result.runs.filter(
            (r) => r.triggerReason === 'scheduled' && r.loopType === 'turn' && r.status === 'completed',
          );
          return scheduled.length >= 2 ? true : null;
        },
        { label: 'second scheduled run (skip_reply did not count)' },
      );
    } finally {
      await stack.cleanup();
    }
  }, 30_000);

  it('Profile 关闭主动消息后不触发（任务保留）', async () => {
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    try {
      const bot = await makeBot(stack.core, '阿关');
      const conv = await openDirect(stack.core, bot.id);
      await stack.core.rpc.call('bots.update', {
        id: bot.id,
        profile: {
          ...bot.profile,
          behavior: { proactive: false, quiet_hours: null, max_proactive_per_day: null },
        },
      });
      const service = schedulesOf(stack);
      service.createOnce({
        botId: bot.id,
        conversationId: conv.id,
        runAt: clock.now() + 60_000,
        note: '不该触发的任务',
      });

      stack.llm.script('mock-main', [step().replyText('不应被消费')]);

      clock.advance(60_000);
      await expectNoScheduledRun(stack.core, conv.id);
      const row = service.listForBotInConversation(bot.id, conv.id)[0];
      expect(row).toBeDefined();
      expect(row!.status).toBe('active');
      // 护栏推迟（周期性重试），任务没有被丢弃
      expect(row!.nextFireAt).toBeGreaterThan(clock.now());
      const listed = (await stack.core.rpc.call('schedules.list', {})) as {
        schedules: Array<{ deferredReason: string | null }>;
      };
      expect(listed.schedules.find((s) => s.id === row!.id)?.deferredReason).toBe('该 Bot 已关闭主动消息');

      // 再过一个重试周期仍然不触发
      clock.advance(30 * 60_000);
      await expectNoScheduledRun(stack.core, conv.id, 600);
      expect(stack.llm.requestsFor('mock-main')).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  });

  it('移出群、删除 Bot 后相关任务取消', async () => {
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    try {
      const member = await makeBot(stack.core, '阿移');
      const other = await makeBot(stack.core, '阿留');
      const victim = await makeBot(stack.core, '阿删');
      const group = await makeGroup(stack.core, '项目群', [member.id, other.id]);
      const victimConv = await openDirect(stack.core, victim.id);
      const service = schedulesOf(stack);

      service.createOnce({
        botId: member.id,
        conversationId: group.id,
        runAt: clock.now() + 60 * 60_000,
        note: '群里的任务',
      });
      service.createCron({
        botId: victim.id,
        conversationId: victimConv.id,
        expression: '0 9 * * *',
        note: '每日晨报',
      });

      // 移出群：该 Bot 在此群的任务取消（03-data-model 从群中移除 Bot）。
      await stack.core.rpc.call('groups.removeMember', { conversationId: group.id, botId: member.id });
      const memberRows = service.store.listActiveForBotInConversation(member.id, group.id);
      expect(memberRows).toHaveLength(0);
      const cancelled = service.store
        .listActive()
        .find((r) => r.botId === member.id && r.conversationId === group.id);
      expect(cancelled).toBeUndefined();
      // store 行状态为 cancelled（保留可追溯）
      const allForGroup = stack.core.services.mainDb!
        .prepare('select status from schedules where bot_id = ? and conversation_id = ?')
        .all(member.id, group.id) as Array<{ status: string }>;
      expect(allForGroup).toEqual([{ status: 'cancelled' }]);

      // 删除 Bot：任务删除（03-data-model 删除 Bot）。
      service.createOnce({
        botId: victim.id,
        conversationId: victimConv.id,
        runAt: clock.now() + 30 * 60_000,
        note: '即将随 Bot 删除',
      });
      expect(service.listForBotInConversation(victim.id, victimConv.id).length).toBe(2);
      await stack.core.rpc.call('bots.delete', { id: victim.id });
      const victimRows = stack.core.services.mainDb!
        .prepare('select count(*) as n from schedules where bot_id = ?')
        .get(victim.id) as { n: number };
      expect(victimRows.n).toBe(0);
      // 该 Bot 的 schedule_fire jobs 也被取消
      const victimJobs = stack.core.services.mainDb!
        .prepare("select count(*) as n from jobs where bot_id = ? and type = 'schedule_fire' and status in ('pending','running')")
        .get(victim.id) as { n: number };
      expect(victimJobs.n).toBe(0);
    } finally {
      await stack.cleanup();
    }
  });

  it('事件触发接入护栏：免打扰时段推迟投递、不受每日上限；schedules.list/cancel RPC 可用', async () => {
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    try {
      const bot = await makeBot(stack.core, '阿事');
      const conv = await openDirect(stack.core, bot.id);
      const machineTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const wallTime = (ms: number): string =>
        new Intl.DateTimeFormat('en-GB', {
          timeZone: machineTz,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(ms));
      await stack.core.rpc.call('bots.update', {
        id: bot.id,
        profile: {
          ...bot.profile,
          behavior: {
            proactive: true,
            quiet_hours: [wallTime(clock.now()), wallTime(clock.now() + 30 * 60_000)],
            max_proactive_per_day: 0, // 事件触发不受每日上限
          },
        },
      });

      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('<trigger reason="event"'))
          .replyText('收到事件'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);

      // 免打扰时段内投递事件：系统消息立即落库，响应触发推迟到时段结束。
      stack.core.services.orchestrator!.deliverEventToBot(bot.id, conv.id, 'deploy_done', '部署完成了');
      await waitFor(
        async () => {
          const messages = await listMessages(stack.core, conv.id);
          return messages.some((m) => m.kind === 'system_event' && m.content.event === 'deploy_done')
            ? true
            : null;
        },
        { label: 'event message recorded' },
      );
      await expectNoScheduledRun(stack.core, conv.id, 600);
      // 注意：事件触发不受每日上限，但受免打扰约束——推迟期间无响应 run。
      expect(
        ((await stack.core.rpc.call('runs.list', { conversationId: conv.id, limit: 50 })) as { runs: Run[] })
          .runs.filter((r) => r.triggerReason === 'event'),
      ).toHaveLength(0);

      clock.advance(31 * 60_000);
      const eventRun = await waitFor(
        async () => {
          const result = (await stack.core.rpc.call('runs.list', { conversationId: conv.id, limit: 50 })) as {
            runs: Run[];
          };
          return result.runs.find((r) => r.triggerReason === 'event' && r.status === 'completed') ?? null;
        },
        { label: 'deferred event run completed' },
      );
      expect(eventRun.triggerReason).toBe('event');

      // --- schedules.list / schedules.cancel RPC ---
      const service = schedulesOf(stack);
      const created = service.createOnce({
        botId: bot.id,
        conversationId: conv.id,
        runAt: clock.now() + 60 * 60_000,
        note: '用户可取消的任务',
      });
      const listOut = (await stack.core.rpc.call('schedules.list', { conversationId: conv.id })) as {
        schedules: Array<{ id: string; botName: string | null; note: string; status: string }>;
      };
      expect(listOut.schedules.find((s) => s.id === created.id)).toMatchObject({
        botName: '阿事',
        note: '用户可取消的任务',
        status: 'active',
      });
      await stack.core.rpc.call('schedules.cancel', { id: created.id });
      expect(service.store.get(created.id)?.status).toBe('cancelled');
    } finally {
      await stack.cleanup();
    }
  });

  it('cancel_schedule 所有权：cancelOwn 非 owner 拒绝且行状态不变，owner 取消成功（BR-P10-002）', async () => {
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    try {
      const owner = await makeBot(stack.core, '阿主');
      const outsider = await makeBot(stack.core, '阿客');
      const group = await makeGroup(stack.core, '共有群', [owner.id, outsider.id]);
      const service = schedulesOf(stack);
      const created = service.createOnce({
        botId: owner.id,
        conversationId: group.id,
        runAt: clock.now() + 60 * 60_000,
        note: '甲的定时任务',
      });

      // 非 owner（同对话的另一 Bot）取消：拒绝，行完全不变
      const stolen = service.cancelOwn(outsider.id, created.id);
      expect(stolen.ok).toBe(false);
      expect(stolen.message).toBe('定时任务不存在，或不是你创建的任务');
      const afterSteal = service.store.get(created.id);
      expect(afterSteal?.status).toBe('active');
      expect(afterSteal?.nextFireAt).toBe(created.nextFireAt);
      // 不存在的 id 与非 owner 同文案（不泄露存在性）
      expect(service.cancelOwn(outsider.id, 'sch_missing')).toEqual(stolen);

      // owner 自己取消：成功
      const own = service.cancelOwn(owner.id, created.id);
      expect(own.ok).toBe(true);
      expect(service.store.get(created.id)?.status).toBe('cancelled');
      // 已取消的任务再取消：拒绝
      expect(service.cancelOwn(owner.id, created.id).ok).toBe(false);
    } finally {
      await stack.cleanup();
    }
  });

  it('每日上限并发空窗：两个同刻到期任务只触发一个（BR-P10-005）', async () => {
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    try {
      const bot = await makeBot(stack.core, '阿额');
      const companion = await makeBot(stack.core, '阿群');
      const convA = await openDirect(stack.core, bot.id);
      // 单 Bot 只有一个单聊：第二个任务放同 Bot 的群聊（上限按 Bot 计）
      const convB = await makeGroup(stack.core, '阿额的群', [bot.id, companion.id]);
      await stack.core.rpc.call('bots.update', {
        id: bot.id,
        profile: {
          ...bot.profile,
          behavior: { proactive: true, quiet_hours: null, max_proactive_per_day: 1 },
        },
      });
      const service = schedulesOf(stack);
      const fireAt = clock.now() + 60_000;
      const rowA = service.createOnce({ botId: bot.id, conversationId: convA.id, runAt: fireAt, note: '任务一' });
      const rowB = service.createOnce({ botId: bot.id, conversationId: convB.id, runAt: fireAt, note: '任务二' });

      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('任务一') || req.lastUserText().includes('任务二'))
          .replyText('其中一个任务触发了'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);

      clock.advance(60_000);
      // 两个任务同刻到期、相继认领（间隔 ≥ 500ms）：谁先投递不确定，但第二个
      // 必须看到第一个的在途/已产出执行并推迟——总共只有 1 条 scheduled run。
      const winnerRun = await waitFor(
        async () => {
          for (const convId of [convA.id, convB.id]) {
            const result = (await stack.core.rpc.call('runs.list', { conversationId: convId, limit: 50 })) as {
              runs: Run[];
            };
            const run = result.runs.find(
              (r) => r.triggerReason === 'scheduled' && r.loopType === 'turn' && r.status === 'completed',
            );
            if (run) return { convId, run };
          }
          return null;
        },
        { label: 'the one scheduled run that passes the cap' },
      );
      const loserConv = winnerRun.convId === convA.id ? convB : convA;
      const loserRowId = winnerRun.convId === convA.id ? rowB.id : rowA.id;

      // 落选任务的对话里没有 scheduled run，行推迟到次日零点
      await expectNoScheduledRun(stack.core, loserConv.id, 1200);
      const deferredRow = service.store.get(loserRowId);
      expect(deferredRow?.status).toBe('active');
      expect(deferredRow?.nextFireAt).toBe(nextLocalMidnight(clock.now(), machineTimeZone()));
      const listed = (await stack.core.rpc.call('schedules.list', {})) as {
        schedules: Array<{ id: string; deferredReason: string | null }>;
      };
      expect(listed.schedules.find((s) => s.id === loserRowId)?.deferredReason).toBe('今日主动消息已达上限');
      // 全部对话里恰好 1 条 scheduled run（赢家）
      let scheduledRuns = 0;
      for (const convId of [convA.id, convB.id]) {
        const result = (await stack.core.rpc.call('runs.list', { conversationId: convId, limit: 50 })) as {
          runs: Run[];
        };
        scheduledRuns += result.runs.filter((r) => r.triggerReason === 'scheduled').length;
      }
      expect(scheduledRuns).toBe(1);
    } finally {
      await stack.cleanup();
    }
  });

  it('schedule_fire 的 job 以响应优先级 1 进调度器，不被后台槽阻塞（BR-P10-004）', async () => {
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    try {
      const bot = await makeBot(stack.core, '阿优');
      const conv = await openDirect(stack.core, bot.id);
      // 侦察 scheduler.submit：run 层的 scheduled 响应本就是 1，job 层必须同优先级
      const submits: Array<{ priority: number; key: string }> = [];
      const scheduler = stack.core.services.scheduler!;
      type SubmitInput = Parameters<typeof scheduler.submit>[0];
      const original = scheduler.submit.bind(scheduler);
      scheduler.submit = (job: SubmitInput) => {
        submits.push({ priority: job.priority, key: job.key });
        original(job);
      };

      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('优先级任务'))
          .replyText('到了'),
      ]);
      stack.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      schedulesOf(stack).createOnce({
        botId: bot.id,
        conversationId: conv.id,
        runAt: clock.now() + 30_000,
        note: '优先级任务',
      });
      clock.advance(30_000);
      await waitForScheduledRun(stack.core, conv.id);

      const fireJobs = stack.core.services.mainDb!
        .prepare("select id from jobs where type = 'schedule_fire'")
        .all() as Array<{ id: string }>;
      expect(fireJobs.length).toBeGreaterThan(0);
      for (const job of fireJobs) {
        const submit = submits.find((s) => s.key === `job:${job.id}`);
        expect(submit, 'schedule_fire job was submitted to the scheduler').toBeDefined();
        expect(submit!.priority).toBe(1);
      }
    } finally {
      await stack.cleanup();
    }
  });

  it('免打扰窗口内的推迟事件持久化：重启后窗口结束仍到达（BR-P10-006）', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-event-park-'));
    const keystore = createMemoryKeystore();
    const wallTime = (ms: number): string =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: machineTimeZone(),
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(ms));
    const clock = new TestClock();
    const first = await createTestStack({ clock, timers: clock, home, keystore });
    let convId = '';
    let firstClosed = false;
    try {
      const bot = await makeBot(first.core, '阿久');
      const conv = await openDirect(first.core, bot.id);
      convId = conv.id;
      await first.core.rpc.call('bots.update', {
        id: bot.id,
        profile: {
          ...bot.profile,
          behavior: {
            proactive: true,
            quiet_hours: [wallTime(clock.now()), wallTime(clock.now() + 30 * 60_000)],
            max_proactive_per_day: null,
          },
        },
      });
      // 窗口内投递事件：系统消息立即落库，响应触发推迟为持久化 job
      first.core.services.orchestrator!.deliverEventToBot(bot.id, conv.id, 'deploy_done', '部署完成了');
      await waitFor(
        async () => {
          const messages = await listMessages(first.core, conv.id);
          return messages.some((m) => m.kind === 'system_event' && m.content.event === 'deploy_done')
            ? true
            : null;
        },
        { label: 'event message recorded' },
      );
      const parked = first.core.services.mainDb!
        .prepare("select run_after from jobs where type = 'event_delivery' and status = 'pending'")
        .all() as Array<{ run_after: number }>;
      expect(parked).toHaveLength(1);
      expect(Math.abs(parked[0]!.run_after - (clock.now() + 30 * 60_000))).toBeLessThanOrEqual(2 * 60_000);

      // 模拟崩溃/重启：窗口未结束，推迟的投递尚未发生
      await first.core.close();
      await first.llm.stop();
      firstClosed = true;
    } finally {
      if (!firstClosed) await first.cleanup();
    }

    // 同 home / keystore 重启，时钟对齐重启时刻
    const clock2 = new TestClock(clock.now());
    const second = await createTestStack({ clock: clock2, timers: clock2, home, keystore });
    try {
      second.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('<trigger reason="event"'))
          .replyText('重启后窗口结束，补上'),
      ]);
      second.llm.script('mock-light', [step().replyJson(emptyReflection())]);
      clock2.advance(31 * 60_000);
      const eventRun = await waitFor(
        async () => {
          const result = (await second.core.rpc.call('runs.list', { conversationId: convId, limit: 50 })) as {
            runs: Run[];
          };
          return result.runs.find((r) => r.triggerReason === 'event' && r.status === 'completed') ?? null;
        },
        { label: 'parked event run completed after restart' },
      );
      expect(eventRun.triggerReason).toBe('event');
      const messages = await listMessages(second.core, convId);
      expect(messages.some((m) => m.senderType === 'bot')).toBe(true);
    } finally {
      await second.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });
});

function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
