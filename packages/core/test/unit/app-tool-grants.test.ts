import { afterEach, describe, expect, it } from 'vitest';

import { AppToolGrants } from '../../src/apps/grants.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';

/** D73 P1 `apps/grants.ts`：(Bot, 连接, 工具) 持续授权的创建 / 命中 / 撤销（真库）。 */

let env: RealMainDb | undefined;
afterEach(() => {
  env?.dispose();
  env = undefined;
});

function setup(): { env: RealMainDb; grants: AppToolGrants } {
  env = openRealMainDb();
  for (const id of ['conn_a', 'conn_b']) {
    env.db
      .prepare(
        "insert into app_connections (id, connector_id, label, status, created_at, updated_at) values (?, ?, ?, 'connected', 1, 1)",
      )
      .run(id, `x/${id}`, id);
  }
  for (const id of ['conv_1', 'conv_2']) {
    env.db
      .prepare("insert into conversations (id, type, created_at) values (?, 'group', 1)")
      .run(id);
  }
  return { env, grants: new AppToolGrants({ db: env.db, clock: env.clock }) };
}

const key = { botId: 'bot_1', connectionId: 'conn_a', toolName: 'create_issue' };

describe('AppToolGrants', () => {
  it('create is idempotent per (bot, connection, tool, scope) and records the approval', () => {
    const { grants } = setup();
    const first = grants.create({ ...key, conversationId: 'conv_1', approvalId: 'apr_1' });
    expect(first).toMatchObject({
      id: expect.stringMatching(/^atg_/),
      conversationId: 'conv_1',
      approvalId: 'apr_1',
      revokedAt: null,
      createdAt: 1_000,
    });
    expect(grants.create({ ...key, conversationId: 'conv_1' }).id).toBe(first.id);
    // 不同范围各是一条。
    const botWide = grants.create(key);
    expect(botWide.conversationId).toBeNull();
    expect(botWide.id).not.toBe(first.id);
    expect(grants.list()).toHaveLength(2);
  });

  it('find: conversation grant only matches its conversation; bot-wide matches everywhere; scoped per bot / connection / tool', () => {
    const { grants } = setup();
    const scoped = grants.create({ ...key, conversationId: 'conv_1' });
    expect(grants.find({ ...key, conversationId: 'conv_1' })?.id).toBe(scoped.id);
    expect(grants.find({ ...key, conversationId: 'conv_2' })).toBeNull();
    expect(grants.find({ ...key, conversationId: null })).toBeNull();

    const botWide = grants.create(key);
    expect(grants.find({ ...key, conversationId: 'conv_2' })?.id).toBe(botWide.id);
    expect(grants.find({ ...key, conversationId: null })?.id).toBe(botWide.id);
    // 两种都有时返回 Bot 级。
    expect(grants.find({ ...key, conversationId: 'conv_1' })?.id).toBe(botWide.id);

    expect(grants.find({ ...key, botId: 'bot_2', conversationId: 'conv_1' })).toBeNull();
    expect(grants.find({ ...key, connectionId: 'conn_b', conversationId: 'conv_1' })).toBeNull();
    expect(grants.find({ ...key, toolName: 'other', conversationId: 'conv_1' })).toBeNull();
  });

  it('revoke makes a grant not live; revoked rows stay for audit; re-create gives a new grant', () => {
    const { env: e, grants } = setup();
    const grant = grants.create(key);
    e.clock.set(5_000);
    expect(grants.revoke(grant.id)).toBe(true);
    expect(grants.revoke(grant.id)).toBe(false);
    expect(grants.find({ ...key, conversationId: 'conv_1' })).toBeNull();
    expect(grants.get(grant.id)?.revokedAt).toBe(5_000);
    expect(grants.list()).toEqual([]);
    expect(grants.list({ includeRevoked: true })).toHaveLength(1);

    const again = grants.create(key);
    expect(again.id).not.toBe(grant.id);
    expect(grants.find({ ...key, conversationId: null })?.id).toBe(again.id);
  });

  it('list filters by connection and bot', () => {
    const { grants } = setup();
    grants.create(key);
    grants.create({ ...key, connectionId: 'conn_b' });
    grants.create({ ...key, botId: 'bot_2' });
    expect(grants.list({ connectionId: 'conn_b' })).toHaveLength(1);
    expect(grants.list({ botId: 'bot_1' })).toHaveLength(2);
    expect(grants.list({ botId: 'bot_1', connectionId: 'conn_a' })).toHaveLength(1);
  });

  it('revokeForBot revokes every grant of that bot only', () => {
    const { grants } = setup();
    grants.create(key);
    grants.create({ ...key, toolName: 'b', conversationId: 'conv_1' });
    const other = grants.create({ ...key, botId: 'bot_2' });
    expect(grants.revokeForBot('bot_1')).toBe(2);
    expect(grants.find({ ...key, conversationId: 'conv_1' })).toBeNull();
    expect(grants.find({ ...key, botId: 'bot_2', conversationId: null })?.id).toBe(other.id);
    expect(grants.revokeForBot('bot_1')).toBe(0);
  });

  it('revokeForBotInConversation revokes only that conversation-scoped grants (bot-wide survive)', () => {
    const { grants } = setup();
    const inConv = grants.create({ ...key, conversationId: 'conv_1' });
    const inOther = grants.create({ ...key, toolName: 'b', conversationId: 'conv_2' });
    const botWide = grants.create({ ...key, toolName: 'c' });
    expect(grants.revokeForBotInConversation('bot_1', 'conv_1')).toBe(1);
    expect(grants.get(inConv.id)?.revokedAt).not.toBeNull();
    expect(grants.get(inOther.id)?.revokedAt).toBeNull();
    expect(grants.get(botWide.id)?.revokedAt).toBeNull();
  });

  it('revokeForTool revokes the tool across bots', () => {
    const { grants } = setup();
    grants.create(key);
    grants.create({ ...key, botId: 'bot_2' });
    grants.create({ ...key, toolName: 'other' });
    expect(grants.revokeForTool('conn_a', 'create_issue')).toBe(2);
    expect(grants.list()).toHaveLength(1);
  });

  it('deleting the conversation or the connection removes the rows (FK cascade)', () => {
    const { env: e, grants } = setup();
    grants.create({ ...key, conversationId: 'conv_1' });
    grants.create({ ...key, conversationId: 'conv_2' });
    grants.create({ ...key, connectionId: 'conn_b' });
    e.db.prepare('delete from conversations where id = ?').run('conv_1');
    expect(grants.list({ includeRevoked: true })).toHaveLength(2);
    e.db.prepare('delete from app_connections where id = ?').run('conn_a');
    expect(grants.list({ includeRevoked: true }).map((grant) => grant.connectionId)).toEqual([
      'conn_b',
    ]);
  });
});
