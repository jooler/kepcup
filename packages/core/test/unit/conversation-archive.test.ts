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

/**
 * 会话归档（从对话列表移除 = 软删）：数据全留，通讯录保留条目可恢复。
 * 覆盖 conversations.archived_at 的写入、列表口径与单聊的恢复语义。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'conversation-archive-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let now = 5_000;
const clock: Clock = { now: () => ++now };

interface Rig {
  db: SqliteDatabase;
  bots: BotsService;
  conversations: ConversationsService;
  projects: ProjectsService;
}

let rig: Rig;

beforeEach(() => {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 9), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  const bots = new BotsService(db, clock);
  const conversations = new ConversationsService(db, clock);
  const projects = new ProjectsService({
    db,
    clock,
    conversations,
    bots,
    removeMemberCascade: async () => undefined,
    publishConversation: () => undefined,
    appendSystemEvent: () => undefined,
    workdirLabelOf: () => null,
    emitPluginsChanged: () => undefined,
  });
  rig = { db, bots, conversations, projects };
});

function makeBot(name: string) {
  return rig.bots.create({ identity: { name, bio: '测试' } });
}

describe('会话归档', () => {
  it('归档后不进对话列表，仍在名册里；恢复后回到列表', () => {
    const bot = makeBot('甲');
    const { conversation } = rig.conversations.openDirect(bot.id);
    expect(conversation.archivedAt ?? null).toBeNull();

    const archived = rig.conversations.setArchived(conversation.id, true);
    expect(archived.archivedAt).not.toBeNull();
    // 对话列表不含它，名册（含归档）仍能拿到。
    expect(rig.conversations.listVisible().map((c) => c.id)).not.toContain(conversation.id);
    expect(rig.conversations.list().map((c) => c.id)).toContain(conversation.id);

    const restored = rig.conversations.setArchived(conversation.id, false);
    expect(restored.archivedAt ?? null).toBeNull();
    expect(rig.conversations.listVisible().map((c) => c.id)).toContain(conversation.id);
  });

  it('归档是幂等的', () => {
    const bot = makeBot('甲');
    const { conversation } = rig.conversations.openDirect(bot.id);
    const first = rig.conversations.setArchived(conversation.id, true);
    const second = rig.conversations.setArchived(conversation.id, true);
    expect(second.archivedAt).toBe(first.archivedAt);
  });

  it('归档项目组不删数据：成员与行都还在', () => {
    const a = makeBot('甲');
    const b = makeBot('乙');
    const project = rig.projects.create({
      title: '项目组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });
    rig.conversations.setArchived(project.id, true);

    const row = rig.db
      .prepare('select id, archived_at from conversations where id = ?')
      .get(project.id) as { id: string; archived_at: number | null };
    expect(row.archived_at).not.toBeNull();
    expect(rig.conversations.memberBotIds(project.id).sort()).toEqual([a.id, b.id].sort());
    expect(rig.conversations.listVisible().map((c) => c.id)).not.toContain(project.id);
  });

  it('域层打开已归档的直聊不会把它拽回列表（恢复是用户的动作）', () => {
    const bot = makeBot('甲');
    const { conversation } = rig.conversations.openDirect(bot.id);
    rig.conversations.setArchived(conversation.id, true);

    const reopened = rig.conversations.openDirect(bot.id);
    expect(reopened.created).toBe(false);
    expect(reopened.conversation.id).toBe(conversation.id);
    expect(reopened.conversation.archivedAt).not.toBeNull();
    expect(rig.conversations.listVisible().map((c) => c.id)).not.toContain(conversation.id);
  });

  it('恢复后再次打开就是同一个对话（历史延续）', () => {
    const bot = makeBot('甲');
    const { conversation } = rig.conversations.openDirect(bot.id);
    rig.conversations.setArchived(conversation.id, false);

    const reopened = rig.conversations.openDirect(bot.id);
    expect(reopened.conversation.id).toBe(conversation.id);
    expect(reopened.conversation.archivedAt ?? null).toBeNull();
    expect(rig.conversations.listVisible().map((c) => c.id)).toContain(conversation.id);
  });

  it('已删除 Bot 的只读直聊不会被恢复', () => {
    const bot = makeBot('甲');
    const { conversation } = rig.conversations.openDirect(bot.id);
    rig.conversations.setArchived(conversation.id, true);
    rig.conversations.setReadOnly(conversation.id, true);

    const reopened = rig.conversations.openDirect(bot.id);
    expect(reopened.conversation.id).not.toBe(conversation.id);
  });
});
