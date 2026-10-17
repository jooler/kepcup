import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Episode, Message } from '@kepcup/shared';
import type { Clock } from '../../src/infra/clock.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { BotsService } from '../../src/domain/bots.js';
import { ConversationsService } from '../../src/domain/conversations.js';
import { MessagesService } from '../../src/domain/messages.js';
import { RunsService } from '../../src/domain/runs.js';
import { EpisodesService } from '../../src/dispatch/episodes.js';
import type { TriggerBatch } from '../../src/scheduler/mailbox.js';
import { insertProjectConversation } from '../support/projects.js';

/** EpisodesService（D92 T1a WP2）：回合建立、继承、熔断与暂停 / 继续 / 停止。 */

const dir = mkdtempSync(path.join(tmpdir(), 'episodes-service-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let now = 1_000;
const clock: Clock = { now: () => ++now };

interface Rig {
  main: SqliteDatabase;
  runsDb: SqliteDatabase;
  bots: BotsService;
  conversations: ConversationsService;
  messages: MessagesService;
  runs: RunsService;
  episodes: EpisodesService;
  delivered: TriggerBatch[];
  systemEvents: Array<{
    conversationId: string;
    event: string;
    text: string;
    episodeId?: string;
    internal?: boolean;
  }>;
  published: Episode[];
}

let rig: Rig;

beforeEach(() => {
  const main = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(main, migrationsUrl('main'));
  const runsDb = openDatabase({
    path: path.join(dir, `runs-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.runsDb),
  });
  runMigrations(runsDb, migrationsUrl('runs'));
  const bots = new BotsService(main, clock);
  const conversations = new ConversationsService(main, clock);
  const messages = new MessagesService(main, clock);
  const runs = new RunsService(runsDb, clock);
  const delivered: TriggerBatch[] = [];
  const systemEvents: Rig['systemEvents'] = [];
  const published: Episode[] = [];
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
  const episodes = new EpisodesService({
    db: main,
    clock,
    logger,
    bots,
    conversations,
    messages,
    runs,
    deliver: (batch) => delivered.push(batch),
    appendSystemEvent: (input) => systemEvents.push(input),
    publishEpisode: (episode) => published.push(episode),
    limits: { hops: 3, pair: 2 },
  });
  rig = { main, runsDb, bots, conversations, messages, runs, episodes, delivered, systemEvents, published };
});

function makeBot(name: string): string {
  const bot = rig.bots.create({ identity: { name, bio: '测试' } });
  return bot.id;
}

interface ProjectRig {
  conversationId: string;
  a: string;
  b: string;
  c: string;
}

function makeProject(): ProjectRig {
  const a = makeBot('阿甲');
  const b = makeBot('阿乙');
  const c = makeBot('阿丙');
  insertProjectConversation(rig.main, {
    id: 'conv_p',
    title: '协作',
    leadBotId: a,
    memberBotIds: [a, b, c],
  });
  return { conversationId: 'conv_p', a, b, c };
}

/** A bot turn run, bound as the orchestrator's #startTurn would bind it. */
function turnRun(botId: string, conversationId: string, binding?: { episodeId: string; hop: number }) {
  return rig.runs.create({
    botId,
    conversationId,
    loopType: 'turn',
    triggerReason: 'direct',
    triggerMessageIds: [],
    ...(binding !== undefined
      ? { episodeId: binding.episodeId, episodeHop: binding.hop }
      : {}),
  });
}

function botMessage(conversationId: string, botId: string, text: string): Message {
  return rig.messages.append({
    conversationId,
    senderType: 'bot',
    senderBotId: botId,
    kind: 'text',
    text,
  });
}

function identityOf(runId: string, botId: string, conversationId: string) {
  return { runId, botId, conversationId, loopType: 'turn' as const };
}

function episodeRow(id: string): { status: string; hops: number; pending_json: string; pair_hops_json: string } {
  return rig.main
    .prepare('select status, hops, pending_json, pair_hops_json from episodes where id = ?')
    .get(id) as { status: string; hops: number; pending_json: string; pair_hops_json: string };
}

describe('mention：建回合与继承', () => {
  it('首次 mention 建回合并把发起 run 绑为 hop 0，投递 bot_mention 批', () => {
    const { conversationId, a, b } = makeProject();
    const run = turnRun(a, conversationId);
    const message = botMessage(conversationId, a, '请乙看看');

    const note = rig.episodes.mention(identityOf(run.id, a, conversationId), [b], message);

    expect(note).toContain('已通知 1 个 Bot');
    expect(note).toContain('协作第 1 次');
    const bound = rig.runs.get(run.id)!;
    expect(bound.episodeHop).toBe(0);
    expect(bound.episodeId).toBeTruthy();
    expect(rig.delivered).toHaveLength(1);
    expect(rig.delivered[0]).toMatchObject({
      conversationId,
      botId: b,
      reason: 'bot_mention',
      episode: { id: bound.episodeId, hop: 1 },
      extraAttributes: { from_bot: '阿甲', hop: 1 },
    });
    expect(episodeRow(bound.episodeId!)).toMatchObject({ status: 'active', hops: 1 });
    expect(rig.published).toHaveLength(1);
  });

  it('被投递的 run 再 mention：同一回合，hop 递增', () => {
    const { conversationId, a, b, c } = makeProject();
    const root = turnRun(a, conversationId);
    const first = rig.episodes.mention(
      identityOf(root.id, a, conversationId),
      [b],
      botMessage(conversationId, a, '一'),
    );
    expect(first).toContain('协作第 1 次');
    const episodeId = rig.runs.get(root.id)!.episodeId!;

    const bRun = turnRun(b, conversationId, { episodeId, hop: 1 });
    const second = rig.episodes.mention(
      identityOf(bRun.id, b, conversationId),
      [c],
      botMessage(conversationId, b, '二'),
    );

    expect(second).toContain('协作第 2 次');
    expect(rig.runs.get(bRun.id)!.episodeId).toBe(episodeId);
    expect(rig.delivered[1]).toMatchObject({
      botId: c,
      reason: 'bot_mention',
      episode: { id: episodeId, hop: 2 },
      extraAttributes: { from_bot: '阿乙' },
    });
    expect(rig.main.prepare('select count(*) as n from episodes').get()).toEqual({ n: 1 });
  });
});

describe('mention：过滤', () => {
  it('非项目会话 / 目标不是成员 / 自己：对应文案且不投递', () => {
    const { conversationId, a, b } = makeProject();
    // A direct conversation: mentions are refused outright.
    const directBot = makeBot('独聊');
    rig.main
      .prepare("insert into conversations (id, type, direct_bot_id, created_at) values ('conv_d', 'direct', ?, 0)")
      .run(directBot);
    const outside = makeBot('外人');
    const directRun = turnRun(directBot, 'conv_d');
    expect(
      rig.episodes.mention(identityOf(directRun.id, directBot, 'conv_d'), [outside], botMessage('conv_d', directBot, '私聊提及')),
    ).toBe('（仅项目组中可以 @ 其他 Bot，本次 @ 未触发任何人）');

    // Non-member / self targets inside the project.
    const run = turnRun(a, conversationId);
    const note = rig.episodes.mention(
      identityOf(run.id, a, conversationId),
      [outside, a, b],
      botMessage(conversationId, a, '混合提及'),
    );
    // B is a valid member: it triggers; the rest are noted as skipped.
    expect(note).toContain('已通知 1 个 Bot');
    expect(note).toContain('未触发：外人、自己 不是项目成员');
    expect(rig.delivered.map((batch) => batch.botId)).toEqual([b]);

    const emptyRun = turnRun(a, conversationId);
    expect(
      rig.episodes.mention(identityOf(emptyRun.id, a, conversationId), [outside], botMessage(conversationId, a, '只提外人')),
    ).toBe('（@ 未触发：目标不是当前项目组的成员）');
  });
});

describe('熔断', () => {
  it('总数熔断：放行恰好 limits.hops 次，下一次暂停并落 pending，只发一张暂停卡', () => {
    const { conversationId, a, b, c } = makeProject();
    const root = turnRun(a, conversationId);
    rig.episodes.mention(identityOf(root.id, a, conversationId), [b], botMessage(conversationId, a, '1'));
    const episodeId = rig.runs.get(root.id)!.episodeId!;
    const bRun = turnRun(b, conversationId, { episodeId, hop: 1 });
    rig.episodes.mention(identityOf(bRun.id, b, conversationId), [c], botMessage(conversationId, b, '2'));
    const cRun = turnRun(c, conversationId, { episodeId, hop: 2 });
    rig.episodes.mention(identityOf(cRun.id, c, conversationId), [a], botMessage(conversationId, c, '3'));
    expect(rig.delivered).toHaveLength(3);
    expect(episodeRow(episodeId).hops).toBe(3);

    // The 4th bot trigger (root run again, its pair count is still 1) exceeds
    // the total: paused, not delivered, kept pending, one pause card.
    const message = botMessage(conversationId, a, '4');
    const note = rig.episodes.mention(identityOf(root.id, a, conversationId), [b], message);

    expect(note).toBe('（协作已暂停，等待用户确认是否继续）');
    expect(rig.delivered).toHaveLength(3);
    const row = episodeRow(episodeId);
    expect(row.status).toBe('paused');
    expect(row.hops).toBe(3);
    const pending = JSON.parse(row.pending_json) as Array<{
      toBotId: string;
      fromBotId: string;
      messageId: string;
      hop: number;
    }>;
    expect(pending).toEqual([{ toBotId: b, fromBotId: a, messageId: message.id, hop: 1 }]);
    expect(rig.systemEvents).toEqual([
      {
        conversationId,
        event: 'episode_paused',
        text: '协作已自动往返 3 次，已暂停',
        episodeId,
      },
    ]);
    expect(rig.published.at(-1)).toMatchObject({ id: episodeId, status: 'paused', pendingCount: 1 });
  });

  it('成对熔断：同对超过 limits.pair 次即暂停，先于总数熔断', () => {
    const { conversationId, a, b } = makeProject();
    const root = turnRun(a, conversationId);
    rig.episodes.mention(identityOf(root.id, a, conversationId), [b], botMessage(conversationId, a, '1'));
    const episodeId = rig.runs.get(root.id)!.episodeId!;
    const bRun = turnRun(b, conversationId, { episodeId, hop: 1 });
    rig.episodes.mention(identityOf(bRun.id, b, conversationId), [a], botMessage(conversationId, b, '2'));
    expect(episodeRow(episodeId).hops).toBe(2);
    // Third trigger of the A|B pair (total would still be 3 = allowed): the
    // pair limit (2) trips first.
    const note = rig.episodes.mention(
      identityOf(root.id, a, conversationId),
      [b],
      botMessage(conversationId, a, '3'),
    );
    expect(note).toBe('（协作已暂停，等待用户确认是否继续）');
    const row = episodeRow(episodeId);
    expect(row.status).toBe('paused');
    expect(row.hops).toBe(2);
    expect(JSON.parse(row.pending_json)).toHaveLength(1);
    expect(rig.systemEvents).toHaveLength(1);
  });

  it('暂停期间再 mention：追加 pending，不再发第二张暂停卡', () => {
    const { conversationId, a, b } = makeProject();
    const root = turnRun(a, conversationId);
    rig.episodes.mention(identityOf(root.id, a, conversationId), [b], botMessage(conversationId, a, '1'));
    const episodeId = rig.runs.get(root.id)!.episodeId!;
    const bRun = turnRun(b, conversationId, { episodeId, hop: 1 });
    rig.episodes.mention(identityOf(bRun.id, b, conversationId), [a], botMessage(conversationId, b, '2'));
    // The pair's third trigger trips the breaker: paused, pending = 1.
    rig.episodes.mention(identityOf(root.id, a, conversationId), [b], botMessage(conversationId, a, '3'));
    expect(episodeRow(episodeId).status).toBe('paused');
    const firstEvents = rig.systemEvents.length;

    const note = rig.episodes.mention(
      identityOf(bRun.id, b, conversationId),
      [a],
      botMessage(conversationId, b, '暂停中'),
    );

    expect(note).toBe('（协作已暂停，等待用户确认是否继续）');
    expect(rig.delivered).toHaveLength(2);
    const row = episodeRow(episodeId);
    expect(JSON.parse(row.pending_json)).toHaveLength(2);
    expect(rig.systemEvents.length).toBe(firstEvents);
  });
});

describe('resume / stop', () => {
  /** A paused episode whose pending holds two triggers (breaker + paused-time). */
  function pausedEpisode(): {
    episodeId: string;
    conversationId: string;
    a: string;
    b: string;
    pending: Array<{ toBotId: string; fromBotId: string; messageId: string; hop: number }>;
  } {
    const { conversationId, a, b } = makeProject();
    const root = turnRun(a, conversationId);
    rig.episodes.mention(identityOf(root.id, a, conversationId), [b], botMessage(conversationId, a, '1'));
    const episodeId = rig.runs.get(root.id)!.episodeId!;
    const bRun = turnRun(b, conversationId, { episodeId, hop: 1 });
    rig.episodes.mention(identityOf(bRun.id, b, conversationId), [a], botMessage(conversationId, b, '2'));
    // Third trigger of the A|B pair trips the pair breaker (pending item 1).
    rig.episodes.mention(identityOf(root.id, a, conversationId), [b], botMessage(conversationId, a, '3'));
    // Mentioning while paused appends instead of delivering (pending item 2).
    rig.episodes.mention(identityOf(bRun.id, b, conversationId), [a], botMessage(conversationId, b, '4'));
    expect(episodeRow(episodeId).status).toBe('paused');
    const pending = JSON.parse(episodeRow(episodeId).pending_json) as Array<{
      toBotId: string;
      fromBotId: string;
      messageId: string;
      hop: number;
    }>;
    expect(pending).toHaveLength(2);
    return { episodeId, conversationId, a, b, pending };
  }

  it('resume：按序投递 pending，跳过已删除 / 已收回的消息，计数清零', () => {
    const { episodeId, conversationId, pending } = pausedEpisode();
    // The first kept trigger's message was deleted; the second was recalled.
    rig.main.prepare('delete from messages where id = ?').run(pending[0]!.messageId);
    rig.main.prepare('update messages set status = ? where id = ?').run('recalled', pending[1]!.messageId);

    const episode = rig.episodes.resume(episodeId);

    expect(episode).toMatchObject({ id: episodeId, status: 'active', hops: 0, pendingCount: 0 });
    expect(episodeRow(episodeId)).toMatchObject({
      status: 'active',
      hops: 0,
      pair_hops_json: '{}',
      pending_json: '[]',
    });
    expect(rig.delivered).toHaveLength(2); // nothing re-delivered: both skipped
    expect(rig.published.at(-1)).toMatchObject({ id: episodeId, status: 'active' });
    void conversationId;
  });

  it('resume 投递仍存在的触发（顺序与来源 / hop 属性）', () => {
    const { episodeId, pending } = pausedEpisode();
    void pending;
    const episode = rig.episodes.resume(episodeId);
    expect(episode.pendingCount).toBe(0);
    expect(rig.delivered).toHaveLength(4); // 2 before the pause + 2 re-delivered
    const redelivered = rig.delivered.slice(2);
    expect(redelivered.map((batch) => batch.reason)).toEqual(['bot_mention', 'bot_mention']);
    expect(redelivered.map((batch) => batch.episode!.hop)).toEqual([1, 2]);
    expect(redelivered.map((batch) => batch.extraAttributes?.['from_bot'])).toEqual(['阿甲', '阿乙']);
  });

  it('resume 对非暂停回合抛 INVALID_INPUT', () => {
    const { conversationId, a, b } = makeProject();
    const root = turnRun(a, conversationId);
    rig.episodes.mention(identityOf(root.id, a, conversationId), [b], botMessage(conversationId, a, 'x'));
    const episodeId = rig.runs.get(root.id)!.episodeId!;
    expect(() => rig.episodes.resume(episodeId)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('stop：stopped、pending 清空、internal episode_stopped，之后 mention 不投递；幂等', () => {
    const { episodeId, conversationId, a, b } = pausedEpisode();

    const stopped = rig.episodes.stop(episodeId);

    expect(stopped).toMatchObject({ id: episodeId, status: 'stopped', pendingCount: 0 });
    expect(rig.systemEvents).toContainEqual({
      conversationId,
      event: 'episode_stopped',
      text: '用户已停止本次协作（不再继续 Bot 之间的往返）',
      internal: true,
    });
    const eventsBefore = rig.systemEvents.length;
    const later = turnRun(a, conversationId, { episodeId, hop: 3 });
    expect(
      rig.episodes.mention(identityOf(later.id, a, conversationId), [b], botMessage(conversationId, a, '停止后')),
    ).toBe('（协作已被用户停止，@ 未触发）');
    expect(rig.delivered).toHaveLength(2);
    // Stopping again changes nothing.
    const again = rig.episodes.stop(episodeId);
    expect(again.status).toBe('stopped');
    expect(rig.systemEvents).toHaveLength(eventsBefore);
  });
});

describe('旧库遗留与绑定查询', () => {
  it('episode_id 指向不存在的回合行：视为无回合，新建', () => {
    const { conversationId, a, b } = makeProject();
    const legacy = turnRun(a, conversationId, { episodeId: 'chn_legacy', hop: 2 });
    const note = rig.episodes.mention(
      identityOf(legacy.id, a, conversationId),
      [b],
      botMessage(conversationId, a, '旧绑定'),
    );
    expect(note).toContain('协作第 1 次');
    const fresh = rig.runs.get(legacy.id)!.episodeId!;
    expect(fresh).not.toBe('chn_legacy');
    expect(episodeRow(fresh).hops).toBe(1);
  });

  it('bindingOfRun：有绑定 / 无绑定 / 行不存在', () => {
    const { conversationId, a, b } = makeProject();
    const root = turnRun(a, conversationId);
    expect(rig.episodes.bindingOfRun(root.id)).toBeNull();
    rig.episodes.mention(identityOf(root.id, a, conversationId), [b], botMessage(conversationId, a, 'x'));
    const episodeId = rig.runs.get(root.id)!.episodeId!;
    expect(rig.episodes.bindingOfRun(root.id)).toEqual({ id: episodeId, hop: 0 });
    const ghost = turnRun(a, conversationId, { episodeId: 'chn_ghost', hop: 1 });
    expect(rig.episodes.bindingOfRun(ghost.id)).toBeNull();
    expect(rig.episodes.bindingOfRun('run_missing')).toBeNull();
  });
});

afterEach(() => {
  closeDatabase(rig.main);
  closeDatabase(rig.runsDb);
});
