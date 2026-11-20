import { afterEach, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, makeProject, TestClock, waitFor, type TestStack } from '@kepcup/testkit';
import type { CoreHarness, ScheduleService } from '@kepcup/core';

/**
 * 62.11 C13（T6 步骤 1.4 / 1.6，docs/design/62-team-server/07-delivery-and-presence.md
 * §3）：主动消息每日上限按 (Bot, 排期归属主体) 计数——一个成员的排期不挤占他人
 * 的配额；排期到期创建的 run 的主体 = 排期归属（owner 为 NULL 时维持 T1 规则：
 * 直聊按会话 owner、其余 NULL）；建立时 owner 与 conversation_id 必须一致
 * （直聊 owner 匹配或 conversation_principals 在册），否则拒绝。
 */

const PR_A = 'pr_AAA';
const PR_B = 'pr_BBB';
const PR_C = 'pr_CCC';

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

function start(clock: TestClock): Promise<TestStack> {
  const promise = createTestStack({ clock, timers: clock });
  return promise.then((stack) => {
    stacks.push(stack);
    return stack;
  });
}

function schedulesOf(core: CoreHarness): ScheduleService {
  const service = core.services.schedules;
  if (service === null) throw new Error('schedule service not wired');
  return service;
}

function expectNotFound(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe('NOT_FOUND');
    return;
  }
  throw new Error('expected NOT_FOUND, call succeeded');
}

describe('主动消息上限与排期归属（62.11 C13）', () => {
  it('sentProactiveCount 按 (Bot, 主体) 计数：互不挤占；null 主体 = Bot 全量（现状）', async () => {
    // TestClock 基点固定（2026-10-01T04:00:00Z）：铺的 runs 行与计数窗口同取
    // clock.now()，落在同一个服务器本地日内，断言与时区无关。
    const clock = new TestClock();
    const stack = await start(clock);
    const core = stack.core;
    const bot = await makeBot(core, '阿计');
    const schedules = schedulesOf(core);
    // 直接铺 runs 行（同一本地日内）：A 两笔、B 一笔、无主一笔。
    const at = clock.now();
    const insert = core.services.runsDb!.prepare(
      `insert into runs (id, bot_id, conversation_id, loop_type, status, trigger_reason,
                         output_message_ids_json, principal_id, created_at)
       values (?, ?, null, 'turn', 'completed', 'scheduled', ?, ?, ?)`,
    );
    insert.run('run_a1', bot.id, '["m1"]', PR_A, at);
    insert.run('run_a2', bot.id, '["m2"]', PR_A, at + 1);
    insert.run('run_b1', bot.id, '["m3"]', PR_B, at + 2);
    insert.run('run_p1', bot.id, '["m4"]', null, at + 3);

    expect(schedules.sentProactiveCount(bot.id, PR_A)).toBe(2);
    expect(schedules.sentProactiveCount(bot.id, PR_B)).toBe(1);
    // null / 缺省 = 按 Bot 全量（T1 现状口径）。
    expect(schedules.sentProactiveCount(bot.id)).toBe(4);
    expect(schedules.sentProactiveCount(bot.id, null)).toBe(4);
    // 其他主体不背别人的账。
    expect(schedules.sentProactiveCount(bot.id, PR_C)).toBe(0);
  });

  it('排期到期 run 的主体 = 排期归属；owner 为 NULL 时维持 T1 规则（直聊 = 会话 owner）', async () => {
    const clock = new TestClock();
    const stack = await start(clock);
    const core = stack.core;
    const bot = await makeBot(core, '阿时');
    const conversations = core.services.domain!.conversations;
    const schedules = schedulesOf(core);

    const convA = conversations.openDirect(bot.id, { ownerPrincipalId: PR_A }).conversation;
    schedules.createOnce({
      botId: bot.id,
      conversationId: convA.id,
      runAt: clock.now() + 60_000,
      note: 'A 的排期',
      ownerPrincipalId: PR_A,
    });
    // 同一会话里一条无归属排期：T1 规则 = 直聊 owner（PR_A）。
    schedules.createOnce({
      botId: bot.id,
      conversationId: convA.id,
      runAt: clock.now() + 61_000,
      note: '无主排期（落在 A 的直聊）',
    });
    // 无主直聊里的无主排期：T1 规则 = NULL。
    const convPlain = conversations.openDirect(bot.id).conversation;
    schedules.createOnce({
      botId: bot.id,
      conversationId: convPlain.id,
      runAt: clock.now() + 62_000,
      note: '无主直聊的无主排期',
    });

    clock.advance(90_000);
    const runsOf = (conversationId: string): Array<string | null> =>
      (
        core.services.runsDb!
          .prepare(
            "select principal_id as p from runs where conversation_id = ? and trigger_reason = 'scheduled'",
          )
          .all(conversationId) as Array<{ p: string | null }>
      ).map((row) => row.p);
    const fired = await waitFor(
      () => {
        const inA = runsOf(convA.id);
        const inPlain = runsOf(convPlain.id);
        return inA.length === 2 && inPlain.length === 1 ? { inA, inPlain } : null;
      },
      { label: 'scheduled runs created', timeoutMs: 15_000 },
    );
    // 归属排期 → run 主体 = 排期归属；无归属 → T1 规则（直聊 owner / NULL）。
    expect([...fired.inA].sort()).toEqual([PR_A, PR_A].sort());
    expect(fired.inPlain).toEqual([null]);
  });

  it('建立时校验：owner 须对该会话有资格（直聊 owner 匹配 / 项目组在册），否则拒绝', async () => {
    const stack = await start(new TestClock());
    const core = stack.core;
    const bot = await makeBot(core, '阿格');
    const other = await makeBot(core, '阿员');
    const schedules = schedulesOf(core);
    const runAt = Date.now() + 3_600_000;

    // 直聊 owner 不匹配 → NOT_FOUND（不泄露会话存在性）。
    const convA = core.services.domain!.conversations.openDirect(bot.id, {
      ownerPrincipalId: PR_A,
    }).conversation;
    expectNotFound(() =>
      schedules.createOnce({
        botId: bot.id,
        conversationId: convA.id,
        runAt,
        note: 'B 想在 A 的直聊里建排期',
        ownerPrincipalId: PR_B,
      }),
    );
    // owner 匹配 → 放行（行归属 B 无关：A 自己建即可）。
    expect(
      schedules.createOnce({
        botId: bot.id,
        conversationId: convA.id,
        runAt,
        note: 'A 自己的排期',
        ownerPrincipalId: PR_A,
      }).ownerPrincipalId,
    ).toBe(PR_A);

    // 项目组：在册主体放行、陌生主体拒绝。
    const project = await makeProject(core, '资格项目', [bot.id, other.id]);
    await core.services.principalOps!.join(project.id, PR_B, 'member');
    expect(
      schedules.createOnce({
        botId: bot.id,
        conversationId: project.id,
        runAt,
        note: '在册主体的排期',
        ownerPrincipalId: PR_B,
      }).ownerPrincipalId,
    ).toBe(PR_B);
    expectNotFound(() =>
      schedules.createOnce({
        botId: bot.id,
        conversationId: project.id,
        runAt,
        note: '陌生主体的排期',
        ownerPrincipalId: PR_C,
      }),
    );

    // 监看同口径。
    const watches = core.services.watches!;
    const watchInput = {
      botId: bot.id,
      conversationId: project.id,
      source: { kind: 'web_page', url: 'https://example.com/w' },
      condition: { kind: 'changed' },
      intervalSec: 600,
    };
    expect(watches.create({ ...watchInput, ownerPrincipalId: PR_B }).ownerPrincipalId).toBe(PR_B);
    expectNotFound(() => watches.create({ ...watchInput, ownerPrincipalId: PR_C }));
  });
});
