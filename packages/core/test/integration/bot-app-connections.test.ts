import { afterEach, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, type TestStack } from '@kepcup/testkit';
import type { Bot } from '@kepcup/shared';

/**
 * D73 P1 §5.7：Bot 对连接的授权（`runtime.app_connection_ids`）——`bots.create` / `bots.update`
 * 校验（连接存在且未删除、同一应用至多一个账号，否则 INVALID_INPUT）、`grantConnection` 的替换
 * 语义、删除连接后从所有 Bot 移除（`removeConnectionFromAll`）。
 */

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start() {
  const stack = await createTestStack();
  stacks.push(stack);
  const { core } = stack;
  const store = core.services.apps!.store;
  const connect = (id: string, connectorId: string, label: string) =>
    store.create({
      id,
      connectorId,
      label,
      serverUrl: `https://mcp.${connectorId}.test/mcp`,
      status: 'connected',
    });
  connect('conn_gh1', 'github', 'work');
  connect('conn_gh2', 'github', 'personal');
  connect('conn_nt', 'notion', 'me');
  const bots = core.services.domain!.bots;
  const profileWith = (bot: Bot, ids: string[]) => ({
    ...bot.profile,
    runtime: { ...bot.profile.runtime, app_connection_ids: ids },
  });
  return { stack, core, store, bots, connect, profileWith };
}

describe('profile validation', () => {
  it('defaults to no connections and persists valid ones through bots.update', async () => {
    const { core, profileWith } = await start();
    const bot = await makeBot(core, '小应');
    expect(bot.profile.runtime.app_connection_ids).toEqual([]);
    const updated = (await core.rpc.call('bots.update', {
      id: bot.id,
      profile: profileWith(bot, ['conn_gh1', 'conn_nt']),
    })) as { bot: Bot };
    expect(updated.bot.profile.runtime.app_connection_ids).toEqual(['conn_gh1', 'conn_nt']);
    const reread = (await core.rpc.call('bots.get', { id: bot.id })) as { bot: Bot };
    expect(reread.bot.profile.runtime.app_connection_ids).toEqual(['conn_gh1', 'conn_nt']);
  });

  it('rejects two accounts of the same connector, unknown ids and custom connection ids', async () => {
    const { core, profileWith } = await start();
    const bot = await makeBot(core, '小应');
    for (const ids of [['conn_gh1', 'conn_gh2'], ['conn_nope'], ['custom:srv']]) {
      await expect(
        core.rpc.call('bots.update', { id: bot.id, profile: profileWith(bot, ids) }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    // Nothing was written.
    const reread = (await core.rpc.call('bots.get', { id: bot.id })) as { bot: Bot };
    expect(reread.bot.profile.runtime.app_connection_ids).toEqual([]);
  });

  it('bots.create validates the same way', async () => {
    const { core, bots } = await start();
    const template = await makeBot(core, '模板');
    const create = (ids: string[]) =>
      core.rpc.call('bots.create', {
        profile: {
          ...template.profile,
          identity: { ...template.profile.identity, name: '新应用 Bot' },
          runtime: { ...template.profile.runtime, app_connection_ids: ids },
        },
      }) as Promise<{ bot: Bot }>;
    await expect(create(['conn_gh1', 'conn_gh2'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(create(['conn_missing'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const ok = await create(['conn_nt']);
    expect(ok.bot.profile.runtime.app_connection_ids).toEqual(['conn_nt']);
    expect(bots.get(ok.bot.id)!.profile.runtime.app_connection_ids).toEqual(['conn_nt']);
  });

  it('a deleted connection can no longer be authorized', async () => {
    const { core, store, profileWith } = await start();
    const bot = await makeBot(core, '小应');
    store.delete('conn_nt');
    await expect(
      core.rpc.call('bots.update', { id: bot.id, profile: profileWith(bot, ['conn_nt']) }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('grantConnection / removeConnectionFromAll', () => {
  it('grants idempotently and replaces another account of the same connector', async () => {
    const { core, bots } = await start();
    const bot = await makeBot(core, '小应');
    expect(bots.grantConnection(bot.id, 'conn_gh1')).toEqual({ replaced: [] });
    expect(bots.grantConnection(bot.id, 'conn_nt')).toEqual({ replaced: [] });
    expect(bots.grantConnection(bot.id, 'conn_gh1')).toEqual({ replaced: [] });
    expect(bots.get(bot.id)!.profile.runtime.app_connection_ids).toEqual(['conn_gh1', 'conn_nt']);
    // The other GitHub account replaces the first one.
    expect(bots.grantConnection(bot.id, 'conn_gh2')).toEqual({ replaced: ['conn_gh1'] });
    expect(bots.get(bot.id)!.profile.runtime.app_connection_ids).toEqual(['conn_nt', 'conn_gh2']);
    // Unknown connections / bots are refused.
    expect(() => bots.grantConnection(bot.id, 'conn_none')).toThrow(/不存在/);
    expect(() => bots.grantConnection('bot_none', 'conn_nt')).toThrow();
  });

  it('removeConnectionFromAll strips the connection from every bot and reports who held it', async () => {
    const { core, bots } = await start();
    const a = await makeBot(core, '小甲');
    const b = await makeBot(core, '小乙');
    const c = await makeBot(core, '小丙');
    bots.grantConnection(a.id, 'conn_gh1');
    bots.grantConnection(a.id, 'conn_nt');
    bots.grantConnection(b.id, 'conn_gh1');
    bots.grantConnection(c.id, 'conn_nt');
    expect(
      bots
        .listAppConnectionHolders('conn_gh1')
        .map((bot) => bot.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    const affected = bots.removeConnectionFromAll('conn_gh1');
    expect(affected.sort()).toEqual([a.id, b.id].sort());
    expect(bots.get(a.id)!.profile.runtime.app_connection_ids).toEqual(['conn_nt']);
    expect(bots.get(b.id)!.profile.runtime.app_connection_ids).toEqual([]);
    expect(bots.get(c.id)!.profile.runtime.app_connection_ids).toEqual(['conn_nt']);
    expect(bots.removeConnectionFromAll('conn_gh1')).toEqual([]);
  });

  it('a stale profile snapshot is refused after the connection was removed from the bot set', async () => {
    const { core, bots, store, profileWith } = await start();
    const bot = await makeBot(core, '小应');
    bots.grantConnection(bot.id, 'conn_nt');
    const stale = bots.get(bot.id)!;
    store.delete('conn_nt');
    bots.removeConnectionFromAll('conn_nt');
    // The renderer still holds the old list → INVALID_INPUT, not a silent resurrection.
    await expect(
      core.rpc.call('bots.update', { id: bot.id, profile: profileWith(stale, ['conn_nt']) }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(bots.get(bot.id)!.profile.runtime.app_connection_ids).toEqual([]);
  });
});
