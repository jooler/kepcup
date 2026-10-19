import Database from 'better-sqlite3-multiple-ciphers';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/infra/migrate.js';
import { JobsService } from '../../src/domain/jobs.js';
import type { SqliteDatabase } from '../../src/infra/db.js';

/**
 * D92 T1b WP9 步骤 6.1：`lastDoneAtFor` 按 owner 取 done 作业的最近完成时间。
 * project owner 只看 conversation_id = 项目 id、payload.owner.kind = 'project'
 * 的行（同一会话里 Bot 名下的作业不参与）；bot owner 即原 lastDoneAt。
 */

const mainMigrations = fileURLToPath(new URL('../../migrations/main/', import.meta.url));

const openDbs: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function makeJobs(): JobsService {
  const db = new Database(':memory:') as SqliteDatabase;
  runMigrations(db, mainMigrations);
  openDbs.push(db);
  const now = 1_000_000;
  return new JobsService(db, { now: () => now } as never);
}

describe('JobsService.lastDoneAtFor', () => {
  it('bot owner：即原 lastDoneAt（bot_id 维度）', () => {
    const jobs = makeJobs();
    const id = jobs.enqueue({
      type: 'wiki_lint',
      botId: 'bot_a',
      payload: { owner: { kind: 'bot', id: 'bot_a' }, trigger: 'weekly' },
      priority: 2,
    });
    jobs.complete(id);
    expect(jobs.lastDoneAtFor({ kind: 'bot', id: 'bot_a' }, ['wiki_lint'])).toBeGreaterThan(0);
    expect(jobs.lastDoneAtFor({ kind: 'bot', id: 'bot_b' }, ['wiki_lint'])).toBe(0);
  });

  it('project owner：只统计项目会话里 payload.owner.kind=project 的 done 行', () => {
    const jobs = makeJobs();
    const projectId = 'conv_proj';
    const projectLint = jobs.enqueue({
      type: 'wiki_lint',
      botId: 'bot_lead',
      conversationId: projectId,
      payload: { owner: { kind: 'project', id: projectId }, trigger: 'weekly' },
      priority: 2,
    });
    // 同会话但归 bot 个人的作业：不得充当项目基线。
    const botScoped = jobs.enqueue({
      type: 'wiki_lint',
      botId: 'bot_m',
      conversationId: projectId,
      payload: { owner: { kind: 'bot', id: 'bot_m' }, trigger: 'weekly' },
      priority: 2,
    });
    // 同形态但类型不同的作业：不参与。
    const otherType = jobs.enqueue({
      type: 'wiki_ingest',
      botId: 'bot_lead',
      conversationId: projectId,
      payload: { owner: { kind: 'project', id: projectId }, sourceType: 'url', ref: 'https://x' },
      priority: 2,
    });
    jobs.complete(projectLint);
    jobs.complete(botScoped);
    jobs.complete(otherType);

    const got = jobs.lastDoneAtFor({ kind: 'project', id: projectId }, ['wiki_lint']);
    expect(got).toBeGreaterThan(0);
    expect(jobs.lastDoneAtFor({ kind: 'project', id: 'conv_other' }, ['wiki_lint'])).toBe(0);

    // 未完成行不参与基线。
    const pending = jobs.enqueue({
      type: 'wiki_lint',
      botId: 'bot_lead',
      conversationId: projectId,
      payload: { owner: { kind: 'project', id: projectId }, trigger: 'weekly' },
      priority: 2,
    });
    expect(jobs.lastDoneAtFor({ kind: 'project', id: projectId }, ['wiki_lint'])).toBe(got);
    jobs.complete(pending);
    expect(jobs.lastDoneAtFor({ kind: 'project', id: projectId }, ['wiki_lint'])).toBeGreaterThanOrEqual(got);
  });

  it('payload 缺 owner 的历史行不炸（json_extract 返回 null）', () => {
    const jobs = makeJobs();
    const id = jobs.enqueue({
      type: 'wiki_lint',
      botId: 'bot_lead',
      conversationId: 'conv_proj',
      payload: { trigger: 'weekly' },
      priority: 2,
    });
    jobs.complete(id);
    expect(jobs.lastDoneAtFor({ kind: 'project', id: 'conv_proj' }, ['wiki_lint'])).toBe(0);
  });
});

describe('JobsService.cancelPendingByBotInConversation', () => {
  it('只取消该会话该类型该 Bot 的 pending 行', () => {
    const jobs = makeJobs();
    const queued = jobs.enqueue({
      type: 'wiki_ingest',
      botId: 'bot_m',
      conversationId: 'conv_proj',
      payload: { owner: { kind: 'project', id: 'conv_proj' }, sourceType: 'url', ref: 'https://x' },
      priority: 2,
      dedupeKey: 'wiki_ingest:project:conv_proj:url:https://x',
    });
    const otherConv = jobs.enqueue({
      type: 'wiki_ingest',
      botId: 'bot_m',
      conversationId: 'conv_other',
      payload: {},
      priority: 2,
    });
    expect(jobs.cancelPendingByBotInConversation('bot_m', 'conv_proj', 'wiki_ingest')).toBe(1);
    const rows = (
      jobs as unknown as { db: SqliteDatabase }
    ).db.prepare('select id, status from jobs order by id').all() as Array<{
      id: string;
      status: string;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(queued)).toBe('cancelled');
    expect(byId.get(otherConv)).toBe('pending');
  });
});

describe('JobsService.resetRunningToPending（启动恢复）', () => {
  function statuses(jobs: JobsService): Map<string, string> {
    const rows = (jobs as unknown as { db: SqliteDatabase }).db
      .prepare('select id, status from jobs order by id')
      .all() as Array<{ id: string; status: string }>;
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  it('无冲突的 running 行复位为 pending', () => {
    const jobs = makeJobs();
    const id = jobs.enqueue({ type: 'wiki_lint', payload: {}, priority: 2, dedupeKey: 'k1' });
    jobs.claimNext();
    expect(statuses(jobs).get(id)).toBe('running');
    jobs.resetRunningToPending();
    expect(statuses(jobs).get(id)).toBe('pending');
  });

  it('同 dedupe_key 已有新的 pending 行时不复位（cancelled 让位），启动不再撞 jobs_dedupe', () => {
    const jobs = makeJobs();
    const stale = jobs.enqueue({ type: 'wiki_lint', payload: {}, priority: 2, dedupeKey: 'k2' });
    jobs.claimNext(); // stale → running（崩溃遗留状态）
    // 启动 wiring 在 reset 之前用同一个 dedupe_key 入队的新行：索引只约束
    // pending，插入成功——此刻两行同 key，复位 stale 就会 UNIQUE 冲突。
    const fresh = jobs.enqueue({ type: 'wiki_lint', payload: {}, priority: 2, dedupeKey: 'k2' });
    expect(fresh).not.toBe(stale);
    expect(() => jobs.resetRunningToPending()).not.toThrow();
    const byId = statuses(jobs);
    expect(byId.get(stale)).toBe('cancelled');
    expect(byId.get(fresh)).toBe('pending');
  });
});
