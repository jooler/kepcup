import { afterEach, describe, expect, it } from 'vitest';
import { SCHEDULE_CREATED_EVENT, mailAlertDedupeKey, type Message } from '@kepcup/shared';
import {
  createTestStack,
  listAllMessages,
  makeBot,
  openDirect,
  type TestStack,
} from '@kepcup/testkit';
import type { MailService } from '../../src/mail/service.js';

/**
 * D88 移交用到的服务层新入口（todo/bot-handover.md §3.4 / §3.7）：`MailService` 的单条
 * 增删绑定与 `retargetPendingAlerts`、`ScheduleService.transferTo` / `transferredTo`。
 * 不经模型，直接调服务。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

function seedAccount(mail: MailService, id: string): void {
  const now = Date.now();
  mail.store.insert({
    id,
    address: `${id}@example.com`,
    label: id,
    provider: 'custom',
    imapHost: '127.0.0.1',
    imapPort: 993,
    imapSecure: 'ssl',
    smtpHost: '127.0.0.1',
    smtpPort: 465,
    smtpSecure: 'ssl',
    username: id,
    mode: 'auto',
    pollIntervalSec: 300,
    status: 'paused',
    listen: null,
    lastUid: null,
    uidValidity: null,
    unseenCount: null,
    lastError: null,
    lastOkAt: null,
    failureStreak: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
}

describe('MailService single bindings + retargetPendingAlerts', () => {
  it('addBinding keeps the other bindings and the existing alert state; removeBinding drops one row', async () => {
    const stack = await start();
    const mail = stack.core.services.mail!;
    const a = await makeBot(stack.core, '甲');
    const b = await makeBot(stack.core, '乙');
    seedAccount(mail, 'mal_1');
    mail.setBots('mal_1', [a.id]);
    mail.store.setAlertState('mal_1', a.id, true, [1, 2]);
    expect(mail.addBinding('mal_1', b.id).botIds).toEqual([a.id, b.id]);
    // 已绑定再加：不变，A 的暂停状态保留。
    mail.addBinding('mal_1', a.id);
    const bindings = mail.store.bindings('mal_1');
    expect(bindings.find((x) => x.botId === a.id)).toMatchObject({
      alertsPaused: true,
      alertTimes: [1, 2],
    });
    expect(bindings.find((x) => x.botId === b.id)).toMatchObject({
      alertsPaused: false,
      alertTimes: [],
    });
    expect(mail.removeBinding('mal_1', a.id).botIds).toEqual([b.id]);
    expect(mail.removeBinding('mal_1', a.id).botIds).toEqual([b.id]);
    expect(() => mail.addBinding('mal_1', 'bot_missing')).toThrow();
  });

  it('moves A’s queued mail_alert jobs to B under B’s dedupe key; running / other jobs untouched', async () => {
    const stack = await start();
    const { core } = stack;
    const mail = core.services.mail!;
    const jobs = core.services.domain!.jobs;
    const a = await makeBot(core, '甲');
    const b = await makeBot(core, '乙');
    const c = await makeBot(core, '丙');
    seedAccount(mail, 'mal_1');
    seedAccount(mail, 'mal_2');
    mail.setBots('mal_1', [a.id, c.id]);
    const later = Date.now() + 60 * 60 * 1000;
    const enqueue = (accountId: string, uid: number, botId: string) =>
      jobs.enqueue({
        type: 'mail_alert',
        botId,
        conversationId: null,
        payload: {
          accountId,
          botId,
          uid,
          key: mailAlertDedupeKey(accountId, uid, botId),
          from: 'x',
          subject: `信 ${uid}`,
          date: '',
          snippet: '',
        },
        priority: 2,
        dedupeKey: mailAlertDedupeKey(accountId, uid, botId),
        runAfter: later,
      });
    enqueue('mal_1', 5, a.id);
    enqueue('mal_1', 6, a.id);
    enqueue('mal_1', 5, c.id);
    enqueue('mal_2', 5, a.id);
    // B 还没绑定：拒绝（否则 runAlertJob 会把改投的提醒丢掉）。
    expect(() => mail.retargetPendingAlerts('mal_1', a.id, b.id)).toThrow(/还没有绑定/);
    mail.addBinding('mal_1', b.id);
    expect(mail.retargetPendingAlerts('mal_1', a.id, b.id)).toBe(2);
    expect(mail.retargetPendingAlerts('mal_1', a.id, b.id)).toBe(0);
    const rows = core.services
      .mainDb!.prepare(
        "select bot_id, status, dedupe_key, run_after, conversation_id from jobs where type = 'mail_alert' order by dedupe_key",
      )
      .all() as Array<{
      bot_id: string;
      status: string;
      dedupe_key: string;
      run_after: number;
      conversation_id: string | null;
    }>;
    const byKey = new Map(rows.map((row) => [row.dedupe_key, row]));
    expect(byKey.get(mailAlertDedupeKey('mal_1', 5, a.id))?.status).toBe('cancelled');
    expect(byKey.get(mailAlertDedupeKey('mal_1', 6, a.id))?.status).toBe('cancelled');
    expect(byKey.get(mailAlertDedupeKey('mal_1', 5, b.id))).toMatchObject({
      status: 'pending',
      run_after: later,
    });
    expect(byKey.get(mailAlertDedupeKey('mal_1', 6, b.id))?.status).toBe('pending');
    expect(byKey.get(mailAlertDedupeKey('mal_1', 5, b.id))?.conversation_id).toBe(
      (await openDirect(core, b.id)).id,
    );
    // 丙的、别的邮箱的不动。
    expect(byKey.get(mailAlertDedupeKey('mal_1', 5, c.id))?.status).toBe('pending');
    expect(byKey.get(mailAlertDedupeKey('mal_2', 5, a.id))?.status).toBe('pending');
  });
});

describe('ScheduleService.transferTo', () => {
  function receipts(messages: Message[]): Message[] {
    return messages.filter(
      (m) =>
        m.kind === 'system_event' &&
        'event' in m.content &&
        m.content.event === SCHEDULE_CREATED_EVENT,
    );
  }

  it('rebuilds with the original fields in the target chat, cancels the source and marks its card', async () => {
    const stack = await start();
    const { core } = stack;
    const schedules = core.services.schedules!;
    const a = await makeBot(core, '甲');
    const b = await makeBot(core, '乙');
    const directA = await openDirect(core, a.id);
    const directB = await openDirect(core, b.id);
    const runAt = Date.now() + 2 * 60 * 60 * 1000;
    const source = schedules.createOnce({
      botId: a.id,
      conversationId: directA.id,
      runAt,
      note: '提醒交房租',
      title: '房租',
      origin: 'offer',
    });
    expect(schedules.transferredTo(source.id, b.id)).toBe(false);
    const moved = schedules.transferTo(source.id, {
      botId: b.id,
      botName: '乙',
      conversationId: directB.id,
    });
    expect(moved).toMatchObject({
      botId: b.id,
      conversationId: directB.id,
      kind: 'once',
      runAt,
      note: '提醒交房租',
      title: '房租',
      origin: 'offer',
      status: 'active',
      nextFireAt: runAt,
    });
    expect(schedules.store.get(source.id)!.status).toBe('cancelled');
    expect(schedules.transferredTo(source.id, b.id)).toBe(true);
    // offer 来源也出新回执卡（移交总要让接手方看到）。
    const bCards = receipts(await listAllMessages(core, directB.id));
    expect(bCards.map((m) => (m.content as { schedule?: { id: string } }).schedule?.id)).toEqual([
      moved.id,
    ]);
    // 已取消的不能再移交；目标不在对话里的拒绝。
    expect(() =>
      schedules.transferTo(source.id, { botId: b.id, botName: '乙', conversationId: directB.id }),
    ).toThrow(/已结束/);
    const other = schedules.createOnce({
      botId: a.id,
      conversationId: directA.id,
      runAt,
      note: 'x',
    });
    expect(() =>
      schedules.transferTo(other.id, { botId: b.id, botName: '乙', conversationId: directA.id }),
    ).toThrow(/不在该对话/);
    expect(schedules.store.get(other.id)!.status).toBe('active');
  });
});
