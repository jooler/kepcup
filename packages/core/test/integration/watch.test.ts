import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFakeBrowserHost,
  createTestStack,
  listAllMessages,
  listMessages,
  listRuns,
  makeBot,
  makeGroup,
  openDirect,
  sendDrafts,
  step,
  TestClock,
  waitFor,
  type FakeBrowserHost,
  type TestStack,
} from '@kepcup/testkit';
import { AppError, type Message, type WatchEntry } from '@kepcup/shared';
import { createMemoryKeystore, type WatchService } from '@kepcup/core';
import type { JobRow } from '../../src/domain/jobs.js';

/**
 * W7 确定性监看（集成，TestClock + 假后台页）：todo/borrowings-from-personal-agents.md
 * W7 测试与验收——同一变化不重复唤醒、重启不重复提醒、价格 100→90（<95）唤醒一次、
 * 保持 90 不唤醒、回到 100 再跌到 90 再唤醒；只有「3 分钟前」→「4 分钟前」不唤醒；
 * 暂停 / 恢复；删除 Bot / 对话删除监看；CAS 冲突时检查结果作废。
 *
 * 检查由 TestClock 的虚拟定时器驱动，`watches.whenIdle()` 等检查落库；提醒卡与
 * 唤醒由 jobs-runner 的真实轮询（数百毫秒）认领 watch_alert 作业。
 */

const URL_A = 'https://shop.example.com/item/1';
const MINUTE = 60_000;

function watchesOf(stack: TestStack): WatchService {
  const service = stack.core.services.watches;
  if (service === null) throw new Error('watch service not wired');
  return service;
}

function scriptWakes(stack: TestStack, count = 6): void {
  stack.llm.script(
    'mock-main',
    Array.from({ length: count }, () =>
      step()
        .expect((req) => req.lastUserText().includes('<trigger reason="watch"'))
        .replyText('监看有变化了'),
    ),
  );
}

function watchCards(messages: Message[], watchId: string, event?: string): Message[] {
  return messages.filter((m) => {
    if (m.kind !== 'card') return false;
    const content = m.content as { cardType?: string; watchId?: string; watchEvent?: string };
    return (
      content.cardType === 'watch' &&
      content.watchId === watchId &&
      (event === undefined || content.watchEvent === event)
    );
  });
}

async function watchWakeRuns(stack: TestStack, conversationId: string): Promise<number> {
  return (await listRuns(stack.core, conversationId)).filter(
    (r) => r.triggerReason === 'watch' && r.loopType === 'turn',
  ).length;
}

/** Waits until `n` alert cards exist and `n` watch-triggered turns completed. */
async function expectAlerts(
  stack: TestStack,
  conversationId: string,
  watchId: string,
  n: number,
): Promise<void> {
  await waitFor(
    async () => {
      const cards = watchCards(await listMessages(stack.core, conversationId), watchId, 'alert');
      const runs = (await listRuns(stack.core, conversationId)).filter(
        (r) => r.triggerReason === 'watch' && r.loopType === 'turn' && r.status === 'completed',
      );
      return cards.length === n && runs.length === n ? true : null;
    },
    { label: `${n} watch alerts` },
  );
}

/** Negative wait: still exactly `n` alerts after the jobs runner had time to act. */
async function expectStillAlerts(
  stack: TestStack,
  conversationId: string,
  watchId: string,
  n: number,
): Promise<void> {
  await new Promise((r) => setTimeout(r, 1200));
  expect(watchCards(await listMessages(stack.core, conversationId), watchId, 'alert')).toHaveLength(
    n,
  );
  expect(await watchWakeRuns(stack, conversationId)).toBe(n);
}

async function setup(options: { clock?: TestClock; browser?: FakeBrowserHost } = {}) {
  const clock = options.clock ?? new TestClock();
  const browser = options.browser ?? createFakeBrowserHost();
  const stack = await createTestStack({ clock, timers: clock, browserRpc: browser });
  const bot = await makeBot(stack.core, '小盯');
  const conv = await openDirect(stack.core, bot.id);
  return { clock, browser, stack, bot, conv, watches: watchesOf(stack) };
}

describe('W7 确定性监看（集成，可控时钟 + 假后台页）', () => {
  it('价格 100 → 90（<95）唤醒一次；保持 90 不唤醒；回到 100 再跌到 90 再唤醒；提醒卡与触发段', async () => {
    const { clock, browser, stack, bot, conv, watches } = await setup();
    try {
      scriptWakes(stack);
      browser.pageTexts.set(URL_A, '商品 A\n现价 ¥100\n更新于 3 分钟前');
      const watch = watches.create({
        botId: bot.id,
        conversationId: conv.id,
        source: { kind: 'web_page', url: URL_A },
        condition: { kind: 'number_below', value: 95 },
        intervalSec: 300,
      });
      // The created card is user-visible at once; the baseline check runs right away.
      expect(watchCards(await listMessages(stack.core, conv.id), watch.id, 'created')).toHaveLength(
        1,
      );
      await watches.whenIdle();
      let row = watches.get(watch.id)!;
      expect(row.lastCheckedAt).toBe(clock.now());
      expect(row.lastMatched).toBe(false);
      expect(row.alertSeq).toBe(0);
      expect(row.nextCheckAt).toBe(clock.now() + 300_000);
      // The fetch used the bot's private profile and no loopback (no project).
      const fetchCall = browser.calls.find((c) => c.method === 'browser.fetchText')!;
      expect(fetchCall.input).toMatchObject({
        botId: bot.id,
        watchId: watch.id,
        profileKey: `bot:${bot.id}`,
        networkContext: { allowLoopback: false },
        url: URL_A,
      });

      // 100 → 90: one alert.
      browser.pageTexts.set(URL_A, '商品 A\n现价 ¥90\n更新于 1 分钟前');
      clock.advance(5 * MINUTE);
      await watches.whenIdle();
      row = watches.get(watch.id)!;
      expect(row.alertSeq).toBe(1);
      expect(row.lastMatched).toBe(true);
      await expectAlerts(stack, conv.id, watch.id, 1);
      const alertCard = watchCards(await listMessages(stack.core, conv.id), watch.id, 'alert')[0]!;
      const alertContent = alertCard.content as {
        watchSeq?: number;
        watchKey?: string;
        watchSummary?: string;
      };
      expect(alertContent.watchSeq).toBe(1);
      expect(alertContent.watchKey).toMatch(new RegExp(`^watch:${watch.id}:1:[0-9a-f]{16}$`));
      expect(alertContent.watchSummary).toContain('当前数值 90');
      expect(alertContent.watchSummary).toContain('现价 ¥100 → 现价 ¥90');
      // Trigger: reason watch, the diff inside the untrusted boundary.
      const wake = stack.llm
        .requestsFor('mock-main')
        .find((r) => r.lastUserText().includes('<trigger reason="watch"'))!;
      const trigger = wake.lastUserText();
      expect(trigger).toContain(`监看提醒（${watch.id}，第 1 次）`);
      expect(trigger).toMatch(/<untrusted>\n[^]*现价 ¥100 → 现价 ¥90[^]*<\/untrusted>/);
      // The wake message itself is internal (the user sees the card).
      const all = await listAllMessages(stack.core, conv.id);
      expect(
        all.some(
          (m) =>
            m.kind === 'system_event' && (m.content as { event?: string }).event === 'watch_alert',
        ),
      ).toBe(true);
      expect(
        (await listMessages(stack.core, conv.id)).some(
          (m) =>
            m.kind === 'system_event' && (m.content as { event?: string }).event === 'watch_alert',
        ),
      ).toBe(false);

      // Staying at 90: no second alert.
      browser.pageTexts.set(URL_A, '商品 A\n现价 ¥90\n更新于 2 分钟前');
      clock.advance(5 * MINUTE);
      await watches.whenIdle();
      expect(watches.get(watch.id)!.alertSeq).toBe(1);
      await expectStillAlerts(stack, conv.id, watch.id, 1);

      // Back to 100, then 90 again: a second alert.
      browser.pageTexts.set(URL_A, '商品 A\n现价 ¥100');
      clock.advance(5 * MINUTE);
      await watches.whenIdle();
      expect(watches.get(watch.id)!.lastMatched).toBe(false);
      browser.pageTexts.set(URL_A, '商品 A\n现价 ¥90');
      clock.advance(5 * MINUTE);
      await watches.whenIdle();
      expect(watches.get(watch.id)!.alertSeq).toBe(2);
      await expectAlerts(stack, conv.id, watch.id, 2);
    } finally {
      await stack.cleanup();
    }
  });

  it('只有「3 分钟前」→「4 分钟前」不唤醒；真实变化唤醒一次；同一个 watch_alert 作业重跑不重复提醒', async () => {
    const { clock, browser, stack, bot, conv, watches } = await setup();
    try {
      scriptWakes(stack);
      browser.pageTexts.set(URL_A, '公告列表\n系统维护通知 3 分钟前');
      const watch = watches.create({
        botId: bot.id,
        conversationId: conv.id,
        source: { kind: 'web_page', url: URL_A },
        condition: { kind: 'changed' },
        intervalSec: 600,
      });
      await watches.whenIdle();
      browser.pageTexts.set(URL_A, '公告列表\n系统维护通知 4 分钟前');
      clock.advance(10 * MINUTE);
      await watches.whenIdle();
      expect(watches.get(watch.id)!.alertSeq).toBe(0);
      await expectStillAlerts(stack, conv.id, watch.id, 0);

      browser.pageTexts.set(URL_A, '公告列表\n新版本发布 刚刚\n系统维护通知 15 分钟前');
      clock.advance(10 * MINUTE);
      await watches.whenIdle();
      expect(watches.get(watch.id)!.alertSeq).toBe(1);
      await expectAlerts(stack, conv.id, watch.id, 1);

      // A crash after the card was posted re-runs the job: its card is found, nothing new.
      const db = stack.core.services.mainDb!;
      const job = db
        .prepare("select * from jobs where type = 'watch_alert' order by created_at desc limit 1")
        .get() as JobRow;
      expect(job.dedupe_key).toMatch(new RegExp(`^watch:${watch.id}:1:`));
      watches.runAlertJob(job);
      await expectStillAlerts(stack, conv.id, watch.id, 1);

      // A crash between the card and the wake: the re-run finds the card but
      // no recorded wake — it wakes the bot (once) without a second card.
      db.prepare(
        `delete from messages where conversation_id = ? and kind = 'system_event'
           and json_extract(content_json, '$.event') = 'watch_alert'`,
      ).run(conv.id);
      watches.runAlertJob(job);
      await waitFor(async () => ((await watchWakeRuns(stack, conv.id)) === 2 ? true : null), {
        label: 'wake re-delivered',
      });
      watches.runAlertJob(job);
      await new Promise((r) => setTimeout(r, 800));
      expect(watchCards(await listMessages(stack.core, conv.id), watch.id, 'alert')).toHaveLength(
        1,
      );
      expect(await watchWakeRuns(stack, conv.id)).toBe(2);
    } finally {
      await stack.cleanup();
    }
  });

  it('重启后不重复提醒同一次变化', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-watch-restart-'));
    const keystore = createMemoryKeystore();
    const clock = new TestClock();
    try {
      const browser1 = createFakeBrowserHost();
      browser1.pageTexts.set(URL_A, '库存：缺货');
      const first = await createTestStack({
        clock,
        timers: clock,
        browserRpc: browser1,
        home,
        keystore,
      });
      let watchId: string;
      let convId: string;
      try {
        scriptWakes(first);
        const bot = await makeBot(first.core, '小盯');
        const conv = await openDirect(first.core, bot.id);
        convId = conv.id;
        const watches = watchesOf(first);
        watchId = watches.create({
          botId: bot.id,
          conversationId: conv.id,
          source: { kind: 'web_page', url: URL_A },
          condition: { kind: 'contains', text: '有货' },
          intervalSec: 300,
        }).id;
        await watches.whenIdle();
        browser1.pageTexts.set(URL_A, '库存：有货');
        clock.advance(5 * MINUTE);
        await watches.whenIdle();
        await expectAlerts(first, conv.id, watchId, 1);
      } finally {
        await first.cleanup();
      }

      const browser2 = createFakeBrowserHost();
      browser2.pageTexts.set(URL_A, '库存：有货');
      const second = await createTestStack({
        clock,
        timers: clock,
        browserRpc: browser2,
        home,
        keystore,
      });
      try {
        scriptWakes(second);
        const watches = watchesOf(second);
        clock.advance(5 * MINUTE);
        await watches.whenIdle();
        expect(browser2.fetchCount()).toBeGreaterThan(0);
        const row = watches.get(watchId)!;
        expect(row.alertSeq).toBe(1);
        expect(row.lastMatched).toBe(true);
        await new Promise((r) => setTimeout(r, 1200));
        expect(watchCards(await listMessages(second.core, convId), watchId, 'alert')).toHaveLength(
          1,
        );
        const runs = (await listRuns(second.core, convId)).filter(
          (r) => r.triggerReason === 'watch',
        );
        expect(runs).toHaveLength(1);
      } finally {
        await second.cleanup();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('连续 5 次失败：退避 5/5/8/16 分钟（不早于间隔下限）后暂停并发卡片；恢复后立即检查', async () => {
    const { clock, browser, stack, bot, conv, watches } = await setup();
    try {
      browser.pageTexts.set(URL_A, new AppError('BROWSER_BLOCKED', '该地址被网络规则拦截'));
      const watch = watches.create({
        botId: bot.id,
        conversationId: conv.id,
        source: { kind: 'web_page', url: URL_A },
        condition: { kind: 'contains', text: '有货' },
        intervalSec: 300,
      });
      await watches.whenIdle();
      const backoffs: number[] = [];
      for (let failures = 1; failures < 5; failures += 1) {
        const row = watches.get(watch.id)!;
        expect(row.failures).toBe(failures);
        expect(row.status).toBe('active');
        expect(row.lastError).toContain('网络规则拦截');
        backoffs.push((row.nextCheckAt - clock.now()) / MINUTE);
        clock.advance(row.nextCheckAt - clock.now());
        await watches.whenIdle();
      }
      expect(backoffs).toEqual([5, 5, 8, 16]);
      let row = watches.get(watch.id)!;
      expect(row.failures).toBe(5);
      expect(row.status).toBe('paused');
      const paused = watchCards(await listMessages(stack.core, conv.id), watch.id, 'paused');
      expect(paused).toHaveLength(1);
      expect(paused[0]!.content).toMatchObject({
        watchKey: `watch-error:${watch.id}:1:paused`,
        watchPauseReason: 'failures',
        // The card keeps the streak: the live counter resets on resume.
        watchFailures: 5,
      });
      // Paused: the clock moving on checks nothing.
      const fetches = browser.fetchCount();
      clock.advance(120 * MINUTE);
      await watches.whenIdle();
      expect(browser.fetchCount()).toBe(fetches);

      // 恢复 (the paused card's action = watches.resume): failures reset, checks now.
      browser.pageTexts.set(URL_A, '库存：缺货');
      const resumed = (await stack.core.rpc.call('watches.resume', { id: watch.id })) as {
        watch: WatchEntry;
      };
      expect(resumed.watch.status).toBe('active');
      expect(resumed.watch.failures).toBe(0);
      await watches.whenIdle();
      row = watches.get(watch.id)!;
      expect(browser.fetchCount()).toBe(fetches + 1);
      expect(row.failures).toBe(0);
      expect(row.lastError).toBeNull();

      // pause / stop via RPC; a stopped watch is gone from the list.
      await stack.core.rpc.call('watches.pause', { id: watch.id });
      expect(watches.get(watch.id)!.status).toBe('paused');
      await stack.core.rpc.call('watches.stop', { id: watch.id });
      const list = (await stack.core.rpc.call('watches.list', { conversationId: conv.id })) as {
        watches: WatchEntry[];
      };
      expect(list.watches).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  });

  it('启动时浏览器宿主尚未绑定：到期监看不计失败、不写错误；宿主一绑定立即检查', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-watch-unbound-'));
    const keystore = createMemoryKeystore();
    const clock = new TestClock();
    try {
      const browser1 = createFakeBrowserHost();
      browser1.pageTexts.set(URL_A, '库存：缺货');
      const first = await createTestStack({
        clock,
        timers: clock,
        browserRpc: browser1,
        home,
        keystore,
      });
      let watchId: string;
      try {
        const bot = await makeBot(first.core, '小盯');
        const conv = await openDirect(first.core, bot.id);
        const watches = watchesOf(first);
        watchId = watches.create({
          botId: bot.id,
          conversationId: conv.id,
          source: { kind: 'web_page', url: URL_A },
          condition: { kind: 'contains', text: '有货' },
          intervalSec: 300,
        }).id;
        await watches.whenIdle();
        expect(watches.get(watchId)!.lastCheckedAt).toBe(clock.now());
      } finally {
        await first.cleanup();
      }

      // Restart well past the deadline with no browser host bound (the app
      // binds port B only after the core started).
      clock.advance(60 * MINUTE);
      const second = await createTestStack({ clock, timers: clock, home, keystore });
      try {
        const watches = watchesOf(second);
        await watches.whenIdle();
        let row = watches.get(watchId)!;
        expect(row.failures).toBe(0);
        expect(row.lastError).toBeNull();
        expect(row.status).toBe('active');
        const checkedBefore = row.lastCheckedAt;
        // Retried later without a host: still nothing counted.
        clock.advance(MINUTE);
        await watches.whenIdle();
        expect(watches.get(watchId)!.failures).toBe(0);

        // The host gets bound: the overdue watch is checked right away.
        const browser2 = createFakeBrowserHost();
        browser2.pageTexts.set(URL_A, '库存：缺货');
        second.core.services.browserRpc.bindFacade(browser2);
        await waitFor(() => (browser2.fetchCount() > 0 ? true : null), {
          label: 'checked on bind',
        });
        await watches.whenIdle();
        row = watches.get(watchId)!;
        expect(row.failures).toBe(0);
        expect(row.lastError).toBeNull();
        expect(row.lastCheckedAt).toBe(clock.now());
        expect(row.lastCheckedAt).not.toBe(checkedBefore);
        expect(row.nextCheckAt).toBe(clock.now() + 300_000);
      } finally {
        await second.cleanup();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('宿主断开（端口掉线）同样只是稍后重试，不计失败', async () => {
    const { clock, browser, stack, bot, conv, watches } = await setup();
    try {
      browser.pageTexts.set(URL_A, '内容 1');
      const watch = watches.create({
        botId: bot.id,
        conversationId: conv.id,
        source: { kind: 'web_page', url: URL_A },
        condition: { kind: 'changed' },
        intervalSec: 300,
      });
      await watches.whenIdle();
      browser.failWith('browser.fetchText', new AppError('INTERNAL', 'browser host disconnected'));
      clock.advance(5 * MINUTE);
      await watches.whenIdle();
      const row = watches.get(watch.id)!;
      expect(row.failures).toBe(0);
      expect(row.lastError).toBeNull();
    } finally {
      await stack.cleanup();
    }
  });

  it('HTTP 错误页与跳到别的站点（登录页）都算检查失败；同站跳转照常', async () => {
    const { clock, browser, stack, bot, conv, watches } = await setup();
    try {
      browser.pageTexts.set(URL_A, '403 Forbidden');
      browser.pageStatuses.set(URL_A, 403);
      const watch = watches.create({
        botId: bot.id,
        conversationId: conv.id,
        source: { kind: 'web_page', url: URL_A },
        condition: { kind: 'changed' },
        intervalSec: 300,
      });
      await watches.whenIdle();
      let row = watches.get(watch.id)!;
      expect(row.failures).toBe(1);
      expect(row.lastError).toContain('HTTP 403');
      expect(row.lastHash).toBeNull();

      browser.pageStatuses.delete(URL_A);
      browser.pageTexts.set(URL_A, '请登录');
      browser.redirects.set(URL_A, 'https://login.example.com/sso?next=%2Fitem%2F1');
      clock.advance(row.nextCheckAt - clock.now());
      await watches.whenIdle();
      row = watches.get(watch.id)!;
      expect(row.failures).toBe(2);
      expect(row.lastError).toContain('重定向到 https://login.example.com/sso（可能需要登录）');
      expect(row.lastHash).toBeNull();

      // http → https / a trailing slash on the same site is fine.
      browser.pageTexts.set(URL_A, '商品 A 现价 ¥100');
      browser.redirects.set(URL_A, `${URL_A}/`);
      clock.advance(row.nextCheckAt - clock.now());
      await watches.whenIdle();
      row = watches.get(watch.id)!;
      expect(row.failures).toBe(0);
      expect(row.lastHash).not.toBeNull();
    } finally {
      await stack.cleanup();
    }
  });

  it('同一批到期的监看：前一个检查期间被暂停的，不再按旧快照检查', async () => {
    const { clock, browser, stack, bot, conv, watches } = await setup();
    const URL_B = 'https://news.example.com/list';
    try {
      browser.pageTexts.set(URL_A, '甲');
      browser.pageTexts.set(URL_B, '乙');
      const create = (url: string) =>
        watches.create({
          botId: bot.id,
          conversationId: conv.id,
          source: { kind: 'web_page', url },
          condition: { kind: 'changed' },
          intervalSec: 300,
        });
      const a = create(URL_A);
      await watches.whenIdle();
      clock.advance(1000);
      const b = create(URL_B);
      await watches.whenIdle();
      const fetchesOf = (url: string) =>
        browser.calls.filter(
          (c) => c.method === 'browser.fetchText' && (c.input as { url: string }).url === url,
        ).length;
      expect(fetchesOf(URL_B)).toBe(1);

      // Both due in one batch (A first); A's fetch hangs while B gets paused.
      browser.hold('browser.fetchText');
      clock.advance(5 * MINUTE);
      await waitFor(() => (fetchesOf(URL_A) === 2 ? true : null), { label: 'A fetching' });
      await stack.core.rpc.call('watches.pause', { id: b.id });
      browser.release('browser.fetchText');
      await watches.whenIdle();
      expect(fetchesOf(URL_B)).toBe(1);
      expect(watches.get(b.id)!.status).toBe('paused');
      expect(watches.get(a.id)!.lastCheckedAt).toBe(clock.now());
    } finally {
      await stack.cleanup();
    }
  });

  it('24 小时内提醒超过上限：不唤醒，改为暂停并发「提醒过于频繁」卡；恢复后窗口清零', async () => {
    const { clock, browser, stack, bot, conv, watches } = await setup();
    try {
      scriptWakes(stack, 2);
      browser.pageTexts.set(URL_A, '版本 0');
      const watch = watches.create({
        botId: bot.id,
        conversationId: conv.id,
        source: { kind: 'web_page', url: URL_A },
        condition: { kind: 'changed' },
        intervalSec: 300,
      });
      await watches.whenIdle();
      const db = stack.core.services.mainDb!;
      // 23 alerts in the last 24 h (+ 5 older ones that no longer count).
      const now = clock.now();
      const times = [
        ...Array.from({ length: 5 }, (_, i) => now - 25 * 60 * MINUTE - i * MINUTE),
        ...Array.from({ length: 23 }, (_, i) => now - (i + 1) * 30 * MINUTE),
      ];
      db.prepare('update watches set alert_times_json = ? where id = ?').run(
        JSON.stringify(times),
        watch.id,
      );

      // The 24th alert in 24 h still wakes the bot.
      browser.pageTexts.set(URL_A, '版本 1');
      clock.advance(5 * MINUTE);
      await watches.whenIdle();
      expect(watches.get(watch.id)!.alertSeq).toBe(1);
      await expectAlerts(stack, conv.id, watch.id, 1);

      // The 25th: no wake — paused with a card instead.
      browser.pageTexts.set(URL_A, '版本 2');
      clock.advance(5 * MINUTE);
      await watches.whenIdle();
      const row = watches.get(watch.id)!;
      expect(row.status).toBe('paused');
      expect(row.alertSeq).toBe(1);
      expect(row.failures).toBe(0);
      expect(row.lastError).toContain('提醒过于频繁（24 小时内超过 24 次）');
      const paused = watchCards(await listMessages(stack.core, conv.id), watch.id, 'paused');
      expect(paused).toHaveLength(1);
      expect(paused[0]!.content).toMatchObject({
        watchKey: `watch-error:${watch.id}:1:too_frequent`,
        watchPauseReason: 'too_frequent',
      });
      expect(db.prepare("select count(*) as n from jobs where type = 'watch_alert'").get()).toEqual(
        { n: 1 },
      );
      await expectStillAlerts(stack, conv.id, watch.id, 1);

      // Resume: the window starts over; the observed version is not replayed.
      await stack.core.rpc.call('watches.resume', { id: watch.id });
      await watches.whenIdle();
      expect(
        (
          db.prepare('select alert_times_json as t from watches where id = ?').get(watch.id) as {
            t: string;
          }
        ).t,
      ).toBe('[]');
      expect(watches.get(watch.id)!.alertSeq).toBe(1);
      browser.pageTexts.set(URL_A, '版本 3');
      clock.advance(5 * MINUTE);
      await watches.whenIdle();
      expect(watches.get(watch.id)!.alertSeq).toBe(2);
      await expectAlerts(stack, conv.id, watch.id, 2);
    } finally {
      await stack.cleanup();
    }
  });

  it('CAS 冲突：检查进行中用户暂停 → 检查结果作废，用户的暂停生效', async () => {
    const { browser, stack, bot, conv, watches } = await setup();
    try {
      browser.pageTexts.set(URL_A, '价格 ¥90');
      browser.hold('browser.fetchText');
      const watch = watches.create({
        botId: bot.id,
        conversationId: conv.id,
        source: { kind: 'web_page', url: URL_A },
        condition: { kind: 'number_below', value: 95 },
        intervalSec: 300,
      });
      await waitFor(() => (browser.fetchCount() > 0 ? true : null), { label: 'fetch started' });
      const before = watches.get(watch.id)!;
      await stack.core.rpc.call('watches.pause', { id: watch.id });
      browser.release('browser.fetchText');
      await watches.whenIdle();
      const after = watches.get(watch.id)!;
      expect(after.status).toBe('paused');
      // The check's write lost the CAS: nothing it observed was stored.
      expect(after.lastHash).toBeNull();
      expect(after.alertSeq).toBe(0);
      expect(after.version).toBe(before.version + 1);
      const db = stack.core.services.mainDb!;
      expect(db.prepare("select count(*) as n from jobs where type = 'watch_alert'").get()).toEqual(
        { n: 0 },
      );
    } finally {
      await stack.cleanup();
    }
  });

  it('删除对话 / 删除 Bot / 移出群：监看随之删除', async () => {
    const { browser, stack, bot, conv, watches } = await setup();
    try {
      browser.pageTexts.set(URL_A, '内容');
      const create = (botId: string, conversationId: string) =>
        watches.create({
          botId,
          conversationId,
          source: { kind: 'web_page', url: URL_A },
          condition: { kind: 'changed' },
          intervalSec: 300,
        });
      const inDirect = create(bot.id, conv.id);
      const other = await makeBot(stack.core, '小二');
      const group = await makeGroup(stack.core, '群', [bot.id, other.id]);
      const inGroupA = create(bot.id, group.id);
      const inGroupB = create(other.id, group.id);
      await watches.whenIdle();

      await stack.core.rpc.call('conversations.delete', { id: conv.id });
      expect(watches.get(inDirect.id)).toBeNull();
      expect(watches.get(inGroupA.id)).not.toBeNull();

      await stack.core.rpc.call('groups.removeMember', {
        conversationId: group.id,
        botId: other.id,
      });
      expect(watches.get(inGroupB.id)).toBeNull();

      await stack.core.rpc.call('bots.delete', { id: bot.id });
      expect(watches.get(inGroupA.id)).toBeNull();
      expect(watches.listEntries()).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  });

  it('上限、间隔下限与非 http(s) 网址在创建时被拒绝', async () => {
    const { stack, bot, conv, watches } = await setup();
    try {
      const base = {
        botId: bot.id,
        conversationId: conv.id,
        condition: { kind: 'changed' },
        intervalSec: 300,
      };
      expect(() =>
        watches.create({ ...base, source: { kind: 'web_page', url: URL_A }, intervalSec: 120 }),
      ).toThrow(/不能短于 5 分钟/);
      expect(() =>
        watches.create({ ...base, source: { kind: 'web_page', url: 'ftp://x/y' } }),
      ).toThrow(/http/);
      expect(() =>
        watches.create({ ...base, source: { kind: 'sensor', sensor: 'camera' } }),
      ).toThrow(/监看来源无效/);
      for (let i = 0; i < 20; i += 1) {
        watches.create({ ...base, source: { kind: 'web_page', url: `${URL_A}?n=${i}` } });
      }
      expect(() => watches.create({ ...base, source: { kind: 'web_page', url: URL_A } })).toThrow(
        /最多 20 个/,
      );
      // watch_stop: only the bot's own watch of this conversation.
      const own = watches.listEntries(conv.id)[0]!;
      expect(watches.stopOwn(bot.id, 'conv_elsewhere', own.id).ok).toBe(false);
      expect(watches.stopOwn('bot_other', conv.id, own.id).ok).toBe(false);
      expect(watches.stopOwn(bot.id, conv.id, own.id).ok).toBe(true);
    } finally {
      await stack.cleanup();
    }
  });

  it('对话轮的 watch_create 工具：创建监看、出监看卡、上下文带 <watches>', async () => {
    const { browser, stack, bot, conv, watches } = await setup();
    try {
      browser.pageTexts.set(URL_A, '现价 ¥100');
      stack.llm.script('mock-main', [
        step()
          .expect((req) => req.lastUserText().includes('降价了告诉我'))
          .replyToolCall('watch_create', {
            url: URL_A,
            condition: { kind: 'number_below', value: 95 },
            interval_minutes: 30,
          }),
        step().replyText('好的，降到 95 以下我告诉你'),
        step()
          .expect((req) => req.lastUserText().includes('还在盯吗'))
          .replyToolCall('watch_list', {}),
        step().replyText('在盯'),
      ]);
      await sendDrafts(stack.core, conv.id, [{ text: '这个商品降价了告诉我' }]);
      const created = await waitFor(() => watches.listEntries(conv.id)[0] ?? null, {
        label: 'watch created',
      });
      expect(created.botId).toBe(bot.id);
      expect(created.intervalSec).toBe(1800);
      expect(created.condition).toEqual({ kind: 'number_below', value: 95 });
      await waitFor(
        async () =>
          watchCards(await listMessages(stack.core, conv.id), created.id, 'created').length === 1
            ? true
            : null,
        { label: 'created card' },
      );
      await waitFor(
        async () =>
          (await listRuns(stack.core, conv.id)).some(
            (r) => r.status === 'completed' && r.loopType === 'turn',
          )
            ? true
            : null,
        { label: 'turn completed' },
      );
      await sendDrafts(stack.core, conv.id, [{ text: '还在盯吗' }]);
      const listReq = await waitFor(
        () =>
          stack.llm
            .requestsFor('mock-main')
            .find(
              (r) =>
                JSON.stringify(r.body).includes('watch_list') &&
                r.lastUserText().includes('还在盯吗'),
            ) ?? null,
        { label: 'second turn request' },
      );
      const system = JSON.stringify(listReq.body);
      expect(system).toContain('<watches>');
      expect(system).toContain(created.id);
    } finally {
      await stack.cleanup();
    }
  });
});
