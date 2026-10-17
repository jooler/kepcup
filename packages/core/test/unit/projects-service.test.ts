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
import { ProjectsService } from '../../src/domain/projects.js';
import type { Conversation } from '@kepcup/shared';

/** ProjectsService 行为（D92 T1a，todo/project/WP1 步骤 7.5）。 */

const dir = mkdtempSync(path.join(tmpdir(), 'projects-service-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let now = 1_000;
const clock: Clock = { now: () => ++now };

interface Rig {
  db: SqliteDatabase;
  projects: ProjectsService;
  bots: BotsService;
  conversations: ConversationsService;
  published: string[];
  systemEvents: Array<{ conversationId: string; event: string; text: string }>;
  cascades: Array<{ conversationId: string; botId: string }>;
  workdirLabels: Map<string, string>;
}

let rig: Rig;

beforeEach(() => {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  const bots = new BotsService(db, clock);
  const conversations = new ConversationsService(db, clock);
  const published: string[] = [];
  const systemEvents: Array<{ conversationId: string; event: string; text: string }> = [];
  const cascades: Array<{ conversationId: string; botId: string }> = [];
  const workdirLabels = new Map<string, string>();
  const projects = new ProjectsService({
    db,
    clock,
    conversations,
    bots,
    removeMemberCascade: async (conversationId, botId) => {
      cascades.push({ conversationId, botId });
    },
    publishConversation: (conversationId) => published.push(conversationId),
    appendSystemEvent: (input) => systemEvents.push(input),
    workdirLabelOf: (conversationId) => workdirLabels.get(conversationId) ?? null,
  });
  rig = { db, projects, bots, conversations, published, systemEvents, cascades, workdirLabels };
});

function makeBot(id: string, options: { role?: 'butler'; profileName?: string } = {}) {
  const profile = {
    identity: {
      name: options.profileName ?? '',
      bio: '测试 Bot',
    },
  };
  return rig.bots.create(profile, {
    ...(options.role !== undefined ? { systemRole: options.role } : {}),
  });
}

describe('ProjectsService.create', () => {
  it('creates a project with a lead among the members and no system messages', () => {
    const a = makeBot('甲');
    const b = makeBot('乙');
    const conversation = rig.projects.create({
      title: ' 项目组 ',
      goal: ' 做事 ',
      leadBotId: a.id,
      memberBotIds: [b.id, a.id, a.id],
    });
    expect(conversation.type).toBe('project');
    expect(conversation.title).toBe('项目组');
    expect(conversation.goal).toBe('做事');
    expect(conversation.leadBotId).toBe(a.id);
    // Duplicates collapse; both members are in.
    expect(rig.conversations.memberBotIds(conversation.id).sort()).toEqual([a.id, b.id].sort());
    expect(rig.published).toEqual([conversation.id]);
    expect(rig.systemEvents).toEqual([]);
  });

  it('stores an empty goal as NULL', () => {
    const a = makeBot('甲');
    const b = makeBot('乙');
    const conversation = rig.projects.create({
      title: '项目组',
      goal: '   ',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    expect(conversation.goal).toBeUndefined();
  });

  it.each([
    ['empty title', { title: '  ', lead: true }],
    ['fewer than two members', { title: '项目组', memberCount: 1 }],
    ['lead not a member', { title: '项目组', leadOutside: true }],
    ['butler member', { title: '项目组', butler: true }],
  ])('rejects: %s', (_name, options) => {
    const a = makeBot('甲');
    const b = makeBot('乙');
    const butler = makeBot('管家', { role: 'butler' });
    const outsider = makeBot('外人');
    const input = {
      title: (options as { title: string }).title,
      leadBotId: (options as { leadOutside?: boolean }).leadOutside ? outsider.id : a.id,
      memberBotIds: [
        a.id,
        ...((options as { memberCount?: number }).memberCount === 1 ? [] : [b.id]),
        ...((options as { butler?: boolean }).butler ? [butler.id] : []),
      ],
    };
    expect(() => rig.projects.create(input)).toThrowError(/项目组|负责人|管家/);
  });

  it('rejects a deleted bot', () => {
    const a = makeBot('甲');
    const b = makeBot('乙');
    rig.bots.markDeleted(b.id);
    expect(() =>
      rig.projects.create({ title: '项目组', leadBotId: a.id, memberBotIds: [a.id, b.id] }),
    ).toThrowError(/不存在或已删除/);
  });
});

describe('ProjectsService.setLead', () => {
  function seeded(): { conversation: Conversation; a: ReturnType<typeof makeBot>; b: ReturnType<typeof makeBot> } {
    const a = makeBot('甲', { profileName: '阿甲' });
    const b = makeBot('乙', { profileName: '阿乙' });
    const conversation = rig.projects.create({
      title: '项目组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    rig.published.length = 0;
    return { conversation, a, b };
  }

  it('replaces the lead and writes the project_lead_changed system message', () => {
    const { conversation, b } = seeded();
    const updated = rig.projects.setLead(conversation.id, b.id);
    expect(updated.leadBotId).toBe(b.id);
    expect(rig.systemEvents).toEqual([
      { conversationId: conversation.id, event: 'project_lead_changed', text: '负责人已更换为 阿乙' },
    ]);
    expect(rig.published).toEqual([conversation.id]);
  });

  it('returns as-is when the lead is unchanged (no message, no publish)', () => {
    const { conversation, a } = seeded();
    const updated = rig.projects.setLead(conversation.id, a.id);
    expect(updated.leadBotId).toBe(a.id);
    expect(rig.systemEvents).toEqual([]);
    expect(rig.published).toEqual([]);
  });

  it('rejects a non-member, a butler and a non-project conversation', () => {
    const { conversation, a } = seeded();
    const outsider = makeBot('外人');
    const butler = makeBot('管家', { role: 'butler' });
    // Butlers cannot even be members; push the row directly for the guard test.
    rig.db
      .prepare('insert into conversation_members (conversation_id, bot_id, joined_at) values (?, ?, 0)')
      .run(conversation.id, butler.id);
    expect(() => rig.projects.setLead(conversation.id, outsider.id)).toThrowError(/不是项目成员/);
    expect(() => rig.projects.setLead(conversation.id, butler.id)).toThrowError(/管家/);
    const direct = rig.conversations.openDirect(a.id).conversation;
    expect(() => rig.projects.setLead(direct.id, a.id)).toThrowError(/不是项目组/);
  });
});

describe('ProjectsService.update', () => {
  it('updates title and goal (null clears)', () => {
    const a = makeBot('甲');
    const b = makeBot('乙');
    const conversation = rig.projects.create({
      title: '项目组',
      goal: '旧目标',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    rig.published.length = 0;
    const renamed = rig.projects.update(conversation.id, { title: '新名' });
    expect(renamed.title).toBe('新名');
    const cleared = rig.projects.update(conversation.id, { goal: null });
    expect(cleared.goal).toBeUndefined();
    expect(rig.published).toEqual([conversation.id, conversation.id]);
  });

  it('rejects an empty title and an over-long goal', () => {
    const a = makeBot('甲');
    const b = makeBot('乙');
    const conversation = rig.projects.create({
      title: '项目组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    expect(() => rig.projects.update(conversation.id, { title: ' ' })).toThrowError(/名称不能为空/);
    expect(() => rig.projects.update(conversation.id, { goal: '长'.repeat(4001) })).toThrowError(
      /项目目标/,
    );
  });
});

describe('ProjectsService.addMembers', () => {
  it('writes project_member_joined per new member, with the workdir label when bound', () => {
    const a = makeBot('甲', { profileName: '阿甲' });
    const b = makeBot('乙');
    const conversation = rig.projects.create({
      title: '项目组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    rig.workdirLabels.set(conversation.id, '仓库');
    const c = makeBot('丙', { profileName: '阿丙' });
    const members = rig.projects.addMembers(conversation.id, [c.id, b.id]);
    expect(members.map((m) => m.bot.id)).toContain(c.id);
    expect(rig.systemEvents).toEqual([
      {
        conversationId: conversation.id,
        event: 'project_member_joined',
        text: '阿丙 已加入项目组，获得工作目录「仓库」的读写权限',
      },
    ]);
  });

  it('uses the plain text without a workdir and skips existing members', () => {
    const a = makeBot('甲', { profileName: '阿甲' });
    const b = makeBot('乙');
    const conversation = rig.projects.create({
      title: '项目组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    rig.projects.addMembers(conversation.id, [a.id]);
    expect(rig.systemEvents).toEqual([]);
    const c = makeBot('丙', { profileName: '阿丙' });
    rig.projects.addMembers(conversation.id, [c.id]);
    expect(rig.systemEvents).toEqual([
      { conversationId: conversation.id, event: 'project_member_joined', text: '阿丙 已加入项目组' },
    ]);
  });

  it('rejects the butler', () => {
    const a = makeBot('甲');
    const b = makeBot('乙');
    const butler = makeBot('管家', { role: 'butler' });
    const conversation = rig.projects.create({
      title: '项目组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    expect(() => rig.projects.addMembers(conversation.id, [butler.id])).toThrowError(/管家/);
  });
});

describe('ProjectsService.removeMember', () => {
  it('refuses to remove the lead and otherwise runs the cascade', async () => {
    const a = makeBot('甲');
    const b = makeBot('乙');
    const conversation = rig.projects.create({
      title: '项目组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    await expect(rig.projects.removeMember(conversation.id, a.id)).rejects.toMatchObject({
      code: 'PROJECT_LEAD_REQUIRED',
    });
    expect(rig.cascades).toEqual([]);
    await rig.projects.removeMember(conversation.id, b.id);
    expect(rig.cascades).toEqual([{ conversationId: conversation.id, botId: b.id }]);
  });

  it('rejects a non-member with NOT_FOUND', async () => {
    const a = makeBot('甲');
    const b = makeBot('乙');
    const conversation = rig.projects.create({
      title: '项目组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    const outsider = makeBot('外人');
    await expect(rig.projects.removeMember(conversation.id, outsider.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('ProjectsService.ledProjectsOf', () => {
  it('lists the projects a bot leads, in creation order', () => {
    const a = makeBot('甲');
    const b = makeBot('乙');
    const one = rig.projects.create({
      title: '一',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    const two = rig.projects.create({
      title: '二',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    rig.projects.create({ title: '三', leadBotId: b.id, memberBotIds: [a.id, b.id] });
    expect(rig.projects.ledProjectsOf(a.id)).toEqual([
      { id: one.id, title: '一' },
      { id: two.id, title: '二' },
    ]);
    // A SQL-level NULL title maps to null (legacy rows from migration 0040).
    rig.db.prepare('update conversations set title = NULL where id = ?').run(two.id);
    expect(rig.projects.ledProjectsOf(a.id)).toEqual([
      { id: one.id, title: '一' },
      { id: two.id, title: null },
    ]);
    expect(rig.projects.leadOf(one.id)).toBe(a.id);
  });
});
