import { afterEach, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, makeGroup, openDirect, type TestStack } from '@kepcup/testkit';

/**
 * D73 P1 app_tool_grants 的清理级联（真实 core）：Bot 删除撤销其全部授权；Bot 被移出群撤销
 * 其在该对话的授权（Bot 级保留）；对话删除由外键级联删除授权行。
 */

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0).reverse()) await stack.cleanup();
});

async function start() {
  const stack = await createTestStack();
  stacks.push(stack);
  const services = stack.core.services;
  const connection = services.apps!.store.create({
    connectorId: 'x/app',
    label: 'App',
    status: 'connected',
  });
  return { ...stack, grants: services.appToolGrants!, connectionId: connection.id, services };
}

describe('app tool grants cleanup', () => {
  it('deleting a bot revokes all of its grants (and only its)', async () => {
    const { core, grants, connectionId } = await start();
    const a = await makeBot(core, '甲');
    const b = await makeBot(core, '乙');
    const conv = await openDirect(core, a.id);
    const tool = { connectionId, toolName: 'create_issue' };
    grants.create({ botId: a.id, ...tool });
    grants.create({ botId: a.id, ...tool, toolName: 'other', conversationId: conv.id });
    const kept = grants.create({ botId: b.id, ...tool });

    await core.rpc.call('bots.delete', { id: a.id });

    expect(grants.list({ botId: a.id })).toEqual([]);
    expect(grants.find({ botId: a.id, ...tool, conversationId: conv.id })).toBeNull();
    expect(
      grants.list({ botId: a.id, includeRevoked: true }).every((g) => g.revokedAt !== null),
    ).toBe(true);
    expect(grants.find({ botId: b.id, ...tool, conversationId: null })?.id).toBe(kept.id);
  });

  it('removing a bot from a group revokes its grants scoped to that group, not bot-wide ones or other groups', async () => {
    const { core, grants, connectionId } = await start();
    const a = await makeBot(core, '甲');
    const b = await makeBot(core, '乙');
    const g1 = await makeGroup(core, '群一', [a.id, b.id]);
    const g2 = await makeGroup(core, '群二', [a.id, b.id]);
    const key = { connectionId, toolName: 'create_issue' };
    const inG1 = grants.create({ botId: a.id, ...key, conversationId: g1.id });
    const inG2 = grants.create({ botId: a.id, ...key, conversationId: g2.id });
    const botWide = grants.create({ botId: a.id, ...key, toolName: 'wide' });
    const otherBot = grants.create({ botId: b.id, ...key, conversationId: g1.id });

    await core.rpc.call('groups.removeMember', { conversationId: g1.id, botId: a.id });

    expect(grants.get(inG1.id)?.revokedAt).not.toBeNull();
    expect(grants.get(inG2.id)?.revokedAt).toBeNull();
    expect(grants.get(botWide.id)?.revokedAt).toBeNull();
    expect(grants.get(otherBot.id)?.revokedAt).toBeNull();
    expect(grants.find({ botId: a.id, ...key, conversationId: g1.id })).toBeNull();
  });

  it('deleting a conversation removes its grants by foreign-key cascade', async () => {
    const { core, grants, connectionId, services } = await start();
    const a = await makeBot(core, '甲');
    const b = await makeBot(core, '乙');
    const g1 = await makeGroup(core, '群一', [a.id, b.id]);
    const g2 = await makeGroup(core, '群二', [a.id, b.id]);
    const key = { connectionId, toolName: 'create_issue' };
    grants.create({ botId: a.id, ...key, conversationId: g1.id });
    const survivor = grants.create({ botId: a.id, ...key, conversationId: g2.id });
    const botWide = grants.create({ botId: a.id, ...key, toolName: 'wide' });

    await core.rpc.call('conversations.delete', { id: g1.id });

    const rows = services
      .mainDb!.prepare('select id from app_tool_grants order by id')
      .all() as Array<{ id: string }>;
    expect(rows.map((row) => row.id).sort()).toEqual([survivor.id, botWide.id].sort());
  });

  it('deleting the connection removes its grants', async () => {
    const { core, grants, connectionId, services } = await start();
    const a = await makeBot(core, '甲');
    grants.create({ botId: a.id, connectionId, toolName: 't' });
    services.apps!.store.delete(connectionId);
    expect(grants.list({ includeRevoked: true })).toEqual([]);
  });
});
