import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Clock } from '../../src/infra/clock.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { BotsService } from '../../src/domain/bots.js';
import { ConversationsService } from '../../src/domain/conversations.js';
import { MessagesService } from '../../src/domain/messages.js';
import { ProjectsService } from '../../src/domain/projects.js';
import { LifecycleService, type LifecycleDeps } from '../../src/domain/lifecycle.js';

/** deleteBot 的负责人守卫与 deletionPreview().ledProjects（D92 T1a）。 */

const dir = mkdtempSync(path.join(tmpdir(), 'lifecycle-project-lead-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let now = 1_000;
const clock: Clock = { now: () => ++now };

const runsDir = mkdtempSync(path.join(tmpdir(), 'lifecycle-project-lead-runs-'));

function openRunsDb(): SqliteDatabase {
  const runs = openDatabase({
    path: path.join(runsDir, `runs-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.runsDb),
  });
  runMigrations(runs, migrationsUrl('runs'));
  return runs;
}

let db: SqliteDatabase;
let bots: BotsService;
let projects: ProjectsService;
let lifecycle: LifecycleService;

beforeEach(() => {
  db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  bots = new BotsService(db, clock);
  const conversations = new ConversationsService(db, clock);
  projects = new ProjectsService({
    db,
    clock,
    conversations,
    bots,
    removeMemberCascade: async (conversationId, botId) =>
      lifecycle.removeProjectMember(conversationId, botId),
    publishConversation: () => undefined,
    appendSystemEvent: () => undefined,
    workdirLabelOf: () => null,
    emitPluginsChanged: () => undefined,
  });
  bots.attachLeadProjectGuard((botId) => projects.ledProjectsOf(botId));
  const deps: LifecycleDeps = {
    paths: { home: path.join(dir, 'home') } as LifecycleDeps['paths'],
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => null as never,
    } as unknown as LifecycleDeps['logger'],
    mainDb: db,
    runsDb: openRunsDb(),
    bots,
    conversations,
    projects,
    messages: new MessagesService(db, clock),
    attachments: {
      deleteConversationFiles: () => undefined,
    } as unknown as LifecycleDeps['attachments'],
    jobs: { cancelByConversation: () => undefined, cancelByBot: () => undefined } as never,
    grants: { deleteForBot: () => undefined, revokeForBotInConversation: () => undefined } as never,
    abortRunsForConversation: () => Promise.resolve(),
    abortRunsForBot: () => Promise.resolve(),
    abortRunsForBotInConversation: () => undefined,
    onProjectMemberRemoved: () => undefined,
  };
  lifecycle = new LifecycleService(deps);
});

function projectOf(leadFirst: boolean): { lead: string; member: string; conversationId: string } {
  const a = bots.create({ identity: { name: '甲', bio: '' } });
  const b = bots.create({ identity: { name: '乙', bio: '' } });
  const conversation = projects.create({
    title: '项目组',
    leadBotId: leadFirst ? a.id : b.id,
    memberBotIds: [a.id, b.id],
  });
  return { lead: leadFirst ? a.id : b.id, member: leadFirst ? b.id : a.id, conversationId: conversation.id };
}

describe('deleteBot lead guard (D92 T1a)', () => {
  it('refuses while the bot leads any project, before any cascade', async () => {
    const { lead } = projectOf(true);
    await expect(lifecycle.deleteBot(lead)).rejects.toMatchObject({
      code: 'PROJECT_LEAD_REQUIRED',
    });
    // Nothing cascaded: still a member, still active, no tombstone.
    expect(db.prepare('select count(*) as n from conversation_members where bot_id = ?').get(lead)).toEqual({ n: 1 });
    expect(bots.get(lead)?.status).toBe('active');
  });

  it('the message lists every led project (titles, falling back to ids)', async () => {
    const a = bots.create({ identity: { name: '甲', bio: '' } });
    const b = bots.create({ identity: { name: '乙', bio: '' } });
    const one = projects.create({ title: '一', leadBotId: a.id, memberBotIds: [a.id, b.id] });
    const two = projects.create({ title: '二', leadBotId: a.id, memberBotIds: [a.id, b.id] });
    let error: { message: string; details?: unknown } | null = null;
    try {
      await lifecycle.deleteBot(a.id);
    } catch (e) {
      error = e as { message: string };
    }
    expect(error?.message).toBe('该 Bot 是 2 个项目组的负责人，请先更换：一、二');
    expect(error?.details).toEqual({ projects: [{ id: one.id, title: '一' }, { id: two.id, title: '二' }] });
  });

  it('deletion works once the lead is replaced', async () => {
    const { lead, member } = projectOf(true);
    projects.setLead( /* conversationId */ (
      db.prepare('select id from conversations where lead_bot_id = ?').get(lead) as { id: string }
    ).id, member);
    await expect(lifecycle.deleteBot(lead)).resolves.toBeUndefined();
    expect(bots.get(lead)?.status).toBe('deleted');
  });

  it('deletionPreview lists the led projects', () => {
    const { lead, conversationId } = projectOf(true);
    const preview = lifecycle.deletionPreview(lead);
    expect(preview.ledProjects).toEqual([{ id: conversationId, title: '项目组' }]);
    const member = db
      .prepare('select bot_id from conversation_members where conversation_id = ? and bot_id <> ?')
      .get(conversationId, lead) as { bot_id: string };
    const memberPreview = lifecycle.deletionPreview(member.bot_id);
    expect(memberPreview.ledProjects).toEqual([]);
  });

  it('bots.markDeleted backstop also refuses the lead', () => {
    const { lead } = projectOf(true);
    expect(() => bots.markDeleted(lead)).toThrowError(/请先更换/);
  });
});
