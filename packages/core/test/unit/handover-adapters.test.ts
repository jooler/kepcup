import { describe, expect, it } from 'vitest';
import type { Bot, BotProfile, Conversation, MailAccount, Schedule } from '@kepcup/shared';
import { botProfile } from '@kepcup/testkit';
import { HandoverRegistry } from '../../src/handover/registry.js';
import { ModelAdapter } from '../../src/handover/adapters/model.js';
import { AppAdapter } from '../../src/handover/adapters/app.js';
import { McpAdapter } from '../../src/handover/adapters/mcp.js';
import { MailAdapter } from '../../src/handover/adapters/mail.js';
import { ScheduleAdapter } from '../../src/handover/adapters/schedule.js';
import type { HandoverBotWriter } from '../../src/handover/adapters/common.js';
import type { HandoverContext } from '../../src/handover/types.js';

/**
 * D88 P0 适配器（todo/bot-handover.md §3.7 core 单测）：盘点、校验、apply 幂等（重复
 * apply 不重复建 / 不重复绑）、恢复判定。依赖全部用内存桩。
 */

function makeBot(id: string, name: string, runtime: Partial<BotProfile['runtime']> = {}): Bot {
  const profile = botProfile({ name });
  return {
    id,
    name,
    avatar: null,
    bio: '',
    profile: { ...profile, runtime: { ...profile.runtime, ...runtime } },
    status: 'active',
    setupState: null,
    systemRole: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** In-memory bot store + writer (counts writes). */
function botWorld(bots: Bot[]): HandoverBotWriter & { writes: number; bot(id: string): Bot } {
  const map = new Map(bots.map((bot) => [bot.id, bot]));
  return {
    writes: 0,
    get: (id) => map.get(id) ?? null,
    bot(id) {
      return map.get(id)!;
    },
    updateProfile(id, mutate) {
      this.writes += 1;
      const current = map.get(id)!;
      const next = { ...current, profile: mutate(current.profile) };
      map.set(id, next);
      return next;
    },
  };
}

function ctxOf(
  world: { bot(id: string): Bot },
  from: string,
  to: string | null,
): HandoverContext & { toBot: Bot } {
  const toBot = to === null ? null : world.bot(to);
  return {
    handoverId: 'hnd_1',
    fromBot: world.bot(from),
    toBot: toBot as Bot,
    toName: toBot?.name ?? '新人',
  };
}

describe('model adapter', () => {
  const options = [{ ref: 'p/m1', label: 'P · M1' }];
  const allowAll = {
    selectable: () => null,
    defaultPermission: (id: string) =>
      id === 'preview-agent' ? ('ask' as const) : ('workspace' as const),
  };
  const agentOf = (id: string, extra: Partial<Bot['profile']['runtime']['agent']> = {}) => ({
    id,
    model: '',
    effort: '',
    permission: 'workspace' as const,
    capabilities: null,
    ...extra,
  });

  it('inventories model:inherit; resolves default / available refs; rejects the rest', () => {
    const world = botWorld([makeBot('bot_a', 'A', { model: 'p/m1' }), makeBot('bot_b', 'B')]);
    const adapter = new ModelAdapter({
      bots: world,
      modelOptions: () => options,
      agents: allowAll,
    });
    expect(adapter.inventory('bot_a')).toEqual([
      expect.objectContaining({ key: 'model:inherit', label: 'P · M1', actions: ['copy'] }),
    ]);
    const registry = new HandoverRegistry([adapter]);
    expect(registry.entry('bot_a', 'model:default')?.entry.label).toBe('跟随设置默认');
    expect(registry.entry('bot_a', 'model:p/m1')?.entry.label).toBe('P · M1');
    expect(registry.entry('bot_a', 'model:p/gone')).toBeNull();
    expect(adapter.validate(ctxOf(world, 'bot_a', null), 'model:inherit', 'copy')).toMatch(
      /new_bot/,
    );
  });

  it('inherit copies model / light model / agent; a ref switches to the built-in engine', async () => {
    const world = botWorld([
      makeBot('bot_a', 'A', { model: 'p/m1', light_model: 'p/l' }),
      makeBot('bot_b', 'B', {
        agent: { id: 'claude', model: '', effort: '', permission: 'workspace', capabilities: null },
      }),
    ]);
    const adapter = new ModelAdapter({
      bots: world,
      modelOptions: () => options,
      agents: allowAll,
    });
    await adapter.apply(ctxOf(world, 'bot_a', 'bot_b'), 'model:inherit');
    expect(world.bot('bot_b').profile.runtime).toMatchObject({
      model: 'p/m1',
      light_model: 'p/l',
      agent: { id: '' },
    });
    await adapter.apply(ctxOf(world, 'bot_a', 'bot_b'), 'model:default');
    expect(world.bot('bot_b').profile.runtime).toMatchObject({ model: '', light_model: '' });
  });

  it('inherit copies the engine (id / model / effort) but keeps B’s own permission and capabilities', async () => {
    const source = agentOf('preview-agent', {
      model: 'opus',
      effort: 'high',
      permission: 'read_only',
      capabilities: ['core'],
    });
    const world = botWorld([
      makeBot('bot_a', 'A', { agent: source }),
      makeBot('bot_b', 'B', {
        agent: agentOf('other', { permission: 'ask', capabilities: ['web'] }),
      }),
      makeBot('bot_c', 'C'),
    ]);
    const adapter = new ModelAdapter({
      bots: world,
      modelOptions: () => options,
      agents: allowAll,
    });
    await adapter.apply(ctxOf(world, 'bot_a', 'bot_b'), 'model:inherit');
    expect(world.bot('bot_b').profile.runtime.agent).toEqual({
      id: 'preview-agent',
      model: 'opus',
      effort: 'high',
      permission: 'ask',
      capabilities: ['web'],
    });
    // A built-in B takes the catalog default permission of the new agent, default packs.
    await adapter.apply(ctxOf(world, 'bot_a', 'bot_c'), 'model:inherit');
    expect(world.bot('bot_c').profile.runtime.agent).toEqual({
      id: 'preview-agent',
      model: 'opus',
      effort: 'high',
      permission: 'ask',
      capabilities: null,
    });
  });

  it('validate refuses an agent bots.update would refuse; the card says when the engine changes', async () => {
    const world = botWorld([
      makeBot('bot_a', 'A', { agent: agentOf('claude') }),
      makeBot('bot_b', 'B'),
      makeBot('bot_x', 'X', { agent: agentOf('codex') }),
    ]);
    const adapter = new ModelAdapter({
      bots: world,
      modelOptions: () => options,
      agents: { selectable: () => '外部智能体是实验功能', defaultPermission: () => 'workspace' },
    });
    expect(adapter.validate(ctxOf(world, 'bot_a', 'bot_b'), 'model:inherit', 'copy')).toContain(
      '外部智能体是实验功能',
    );
    // Same engine already: nothing to check.
    expect(adapter.validate(ctxOf(world, 'bot_b', 'bot_b'), 'model:inherit', 'copy')).toBeNull();
    const inherit = adapter.inventory('bot_a')[0]!;
    expect(adapter.warnings(ctxOf(world, 'bot_a', 'bot_b'), inherit)).toEqual([
      'B 目前由「内置引擎」驱动，之后改由「外部智能体 claude」驱动',
    ]);
    // A ref or「default」on an external-agent bot switches it back to the built-in engine.
    const registry = new HandoverRegistry([adapter]);
    const byRef = registry.entry('bot_a', 'model:p/m1')!.entry;
    expect(adapter.warnings(ctxOf(world, 'bot_a', 'bot_x'), byRef)).toEqual([
      'X 目前由「外部智能体 codex」驱动，之后改由「内置引擎」驱动',
    ]);
    expect(adapter.describe(byRef, 'copy', 'X')).toContain('内置引擎');
    await adapter.apply(ctxOf(world, 'bot_a', 'bot_x'), 'model:default');
    expect(world.bot('bot_x').profile.runtime).toMatchObject({ model: '', agent: { id: '' } });
  });
});

describe('app adapter', () => {
  const connections = new Map([
    ['conn_nt', { id: 'conn_nt', connectorId: 'notion', label: 'me' }],
    ['conn_nt2', { id: 'conn_nt2', connectorId: 'notion', label: 'work' }],
  ]);

  function setup(bRuntime: string[] = []) {
    const world = botWorld([
      makeBot('bot_a', 'A', { app_connection_ids: ['conn_nt'] }),
      makeBot('bot_b', 'B', { app_connection_ids: bRuntime }),
    ]);
    const revoked: string[] = [];
    const adapter = new AppAdapter({
      bots: world,
      connections: { get: (id) => connections.get(id) ?? null },
      appName: () => 'Notion',
      revoke: (serverId, botIds) => revoked.push(`${serverId}:${botIds.join(',')}`),
    });
    return { world, adapter, revoked };
  }

  it('inventories the bot connections (share by default, external label)', () => {
    const { adapter } = setup();
    expect(adapter.inventory('bot_a')).toEqual([
      expect.objectContaining({
        key: 'app:conn_nt',
        label: 'Notion（me）',
        actions: ['share', 'move'],
        defaultAction: 'share',
        external: true,
      }),
    ]);
  });

  it('greys out a target that already has another account of the same connector', () => {
    const { world, adapter } = setup(['conn_nt2']);
    expect(adapter.validate(ctxOf(world, 'bot_a', 'bot_b'), 'app:conn_nt', 'share')).toContain(
      'B 已连接另一个 Notion 账号',
    );
    // A new (empty) target never conflicts.
    expect(adapter.validate(ctxOf(world, 'bot_a', null), 'app:conn_nt', 'share')).toBeNull();
  });

  it('share keeps A; move releases A and interrupts its tasks; both are re-entrant', async () => {
    const { world, adapter, revoked } = setup();
    const ctx = () => ctxOf(world, 'bot_a', 'bot_b');
    await adapter.apply(ctx(), 'app:conn_nt');
    await adapter.apply(ctx(), 'app:conn_nt');
    expect(world.bot('bot_b').profile.runtime.app_connection_ids).toEqual(['conn_nt']);
    expect(adapter.isApplied(ctx(), 'app:conn_nt', 'share')).toBe(true);
    expect(adapter.isApplied(ctx(), 'app:conn_nt', 'move')).toBe(false);
    await adapter.release(ctx(), 'app:conn_nt');
    await adapter.release(ctx(), 'app:conn_nt');
    expect(world.bot('bot_a').profile.runtime.app_connection_ids).toEqual([]);
    expect(revoked).toEqual(['conn_nt:bot_a']);
    expect(adapter.isApplied(ctx(), 'app:conn_nt', 'move')).toBe(true);
  });
});

describe('mcp adapter', () => {
  it('skips deleted servers, greys out globally disabled ones', () => {
    const world = botWorld([
      makeBot('bot_a', 'A', { mcp_server_ids: ['s1', 's2', 'gone'] }),
      makeBot('bot_b', 'B'),
    ]);
    const adapter = new McpAdapter({
      bots: world,
      servers: () => [
        { id: 's1', name: 'Search', enabled: true },
        { id: 's2', name: 'Old', enabled: false },
      ],
      revoke: () => undefined,
    });
    const entries = adapter.inventory('bot_a');
    expect(entries.map((entry) => entry.key)).toEqual(['mcp:s1', 'mcp:s2']);
    expect(entries[0]!.blocked).toBeUndefined();
    expect(entries[1]!.blocked).toContain('全局停用');
    expect(adapter.validate(ctxOf(world, 'bot_a', 'bot_b'), 'mcp:s2', 'share')).toContain(
      '全局停用',
    );
  });
});

describe('mail adapter', () => {
  function setup() {
    const bindings = new Map<string, string[]>([['mal_1', ['bot_a']]]);
    const calls: string[] = [];
    const world = botWorld([makeBot('bot_a', 'A'), makeBot('bot_b', 'B')]);
    const adapter = new MailAdapter({
      mail: {
        accountsForBot: (botId) =>
          [...bindings.entries()]
            .filter(([, bots]) => bots.includes(botId))
            .map(([id]) => ({ id, label: '工作', address: 'w@x.com' }) as MailAccount),
        boundBotIds: (accountId) => bindings.get(accountId) ?? null,
        addBinding: (accountId, botId) => {
          calls.push(`add:${botId}`);
          const list = bindings.get(accountId)!;
          if (!list.includes(botId)) list.push(botId);
        },
        removeBinding: (accountId, botId) => {
          calls.push(`remove:${botId}`);
          bindings.set(
            accountId,
            bindings.get(accountId)!.filter((id) => id !== botId),
          );
        },
        retargetPendingAlerts: (_accountId, from, to) => {
          calls.push(`retarget:${from}->${to}`);
          return 0;
        },
      },
    });
    return { world, adapter, bindings, calls };
  }

  it('move binds B first, retargets the queued alerts, then unbinds A; re-running changes nothing', async () => {
    const { world, adapter, bindings, calls } = setup();
    expect(adapter.inventory('bot_a')[0]).toMatchObject({
      key: 'mail:mal_1',
      label: '工作 <w@x.com>',
      defaultAction: 'move',
    });
    const ctx = () => ctxOf(world, 'bot_a', 'bot_b');
    expect(adapter.validate(ctx(), 'mail:mal_1', 'move')).toBeNull();
    await adapter.apply(ctx(), 'mail:mal_1', 'move');
    expect(calls).toEqual(['add:bot_b', 'retarget:bot_a->bot_b', 'remove:bot_a']);
    expect(bindings.get('mal_1')).toEqual(['bot_b']);
    expect(adapter.isApplied(ctx(), 'mail:mal_1', 'move')).toBe(true);
    // Re-validating after the move: A no longer owns it (recovery uses isApplied first).
    expect(adapter.validate(ctx(), 'mail:mal_1', 'move')).toContain('已不再负责');
    await adapter.apply(ctx(), 'mail:mal_1', 'move');
    expect(bindings.get('mal_1')).toEqual(['bot_b']);
    expect(adapter.validate(ctx(), 'mail:gone', 'move')).toContain('已被删除');
  });

  it('share binds B and keeps A', async () => {
    const { world, adapter, bindings } = setup();
    await adapter.apply(ctxOf(world, 'bot_a', 'bot_b'), 'mail:mal_1', 'share');
    expect(bindings.get('mal_1')).toEqual(['bot_a', 'bot_b']);
    expect(adapter.isApplied(ctxOf(world, 'bot_a', 'bot_b'), 'mail:mal_1', 'share')).toBe(true);
  });
});

describe('schedule adapter', () => {
  function row(id: string, conversationId: string, extra: Partial<Schedule> = {}): Schedule {
    return {
      id,
      botId: 'bot_a',
      conversationId,
      kind: 'cron',
      runAt: null,
      cron: '0 9 * * *',
      timezone: 'UTC',
      note: '写日报',
      title: '日报',
      origin: 'tool',
      commitmentId: null,
      status: 'active',
      nextFireAt: 1,
      lastFiredAt: null,
      createdAt: 1,
      ...extra,
    } as Schedule;
  }

  function setup() {
    const rows = new Map<string, Schedule>([
      ['sch_d', row('sch_d', 'conv_a')],
      ['sch_g', row('sch_g', 'conv_g')],
      ['sch_c', row('sch_c', 'conv_a', { commitmentId: 'mem_1' })],
    ]);
    const conversations: Record<string, Partial<Conversation>> = {
      conv_a: { id: 'conv_a', type: 'direct', directBotId: 'bot_a', readOnly: false, title: null },
      conv_g: { id: 'conv_g', type: 'group', directBotId: null, readOnly: false, title: '周报群' },
    };
    const members: Record<string, string[]> = { conv_a: ['bot_a'], conv_g: ['bot_a'] };
    const transfers: string[] = [];
    const world = botWorld([makeBot('bot_a', 'A'), makeBot('bot_b', 'B')]);
    const adapter = new ScheduleAdapter({
      schedules: {
        listActiveForBot: () => [...rows.values()].filter((r) => r.status === 'active'),
        get: (id) => rows.get(id) ?? null,
        transferTo: (id, target) => {
          transfers.push(`${id}->${target.conversationId}`);
          rows.set(id, { ...rows.get(id)!, status: 'cancelled' });
          return row(`${id}_new`, target.conversationId, { botId: target.botId });
        },
        transferredTo: (id) => rows.get(id)?.status === 'cancelled',
        describeWhen: () => '每天 09:00',
      },
      conversations: {
        get: (id) => (conversations[id] as Conversation | undefined) ?? null,
        memberBotIds: (id) => members[id] ?? [],
        directIdFor: (botId) => `direct_${botId}`,
      },
    });
    return { world, adapter, transfers, members };
  }

  it('inventories active schedules; commitment-linked ones are greyed out without a memory port', () => {
    const { adapter } = setup();
    const entries = adapter.inventory('bot_a');
    expect(entries.map((entry) => entry.key)).toEqual([
      'schedule:sch_d',
      'schedule:sch_g',
      'schedule:sch_c',
    ]);
    expect(entries[0]).toMatchObject({
      label: '日报',
      detail: '每天 09:00，私聊',
      actions: ['move'],
    });
    expect(entries[1]!.detail).toContain('群「周报群」');
    expect(entries[2]!.blocked).toContain('承诺');
  });

  it('a group schedule needs B in the group; a direct one moves to B’s direct chat once', async () => {
    const { world, adapter, transfers, members } = setup();
    const ctx = () => ctxOf(world, 'bot_a', 'bot_b');
    expect(adapter.validate(ctx(), 'schedule:sch_g', 'move')).toBe('B 不在群「周报群」里');
    expect(adapter.validate(ctxOf(world, 'bot_a', null), 'schedule:sch_g', 'move')).toContain(
      '不在群',
    );
    members['conv_g'] = ['bot_a', 'bot_b'];
    expect(adapter.validate(ctx(), 'schedule:sch_g', 'move')).toBeNull();
    expect(adapter.validate(ctx(), 'schedule:sch_d', 'move')).toBeNull();
    await adapter.apply(ctx(), 'schedule:sch_d');
    expect(transfers).toEqual(['sch_d->direct_bot_b']);
    expect(adapter.isApplied(ctx(), 'schedule:sch_d')).toBe(true);
    // 没有承诺的任务移交后就是「已结束」（宿主先看 isApplied → done，不会走到 validate）；
    // 只有承诺联动、且本次移交给过 B 承诺副本的才走恢复捷径（审查 #5，见 P1 测试）。
    expect(adapter.validate(ctx(), 'schedule:sch_d', 'move')).toContain('已结束');
  });
});
