import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * team-context 对 bootstrap.botCapabilities 的消费（B4 子域 B 步骤 3，B1 契约）：
 * bootstrap 后写入子域 A 的 team-bots store（web 端点 source='local'，含成员
 * id——连接层拿不到）：
 * - 新服务器携带该字段 → botCapabilitiesOf('local') 原样可读；
 * - 旧服务器缺省字段 → null 降级（无成员 Bot 面能力的确定答案）；
 * - 会话失效 reset → 能力面与成员 id 一并撤空。
 *
 * 与 team-context.svelte.test.ts 同款 core 单例 mock；本文件不改动既有用例
 * （并行开发期零改动基线）。
 */

const h = vi.hoisted(() => {
  /** bootstrap 载荷（按用例改写）；null = 全部调用抛错。 */
  let bootstrap: Record<string, unknown> | null = null;
  return {
    get bootstrap(): Record<string, unknown> | null {
      return bootstrap;
    },
    set bootstrap(value: Record<string, unknown> | null) {
      bootstrap = value;
    },
  };
});

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    connection: 'connected',
    onConnected: () => () => undefined,
    onTeamEvent: () => () => undefined,
    onEvent: () => () => undefined,
    call: async () => {
      throw new Error('unexpected core.call');
    },
    callTeam: async (method: string) => {
      if (method === 'team.bootstrap') {
        if (h.bootstrap === null) throw new Error('FORBIDDEN');
        return h.bootstrap;
      }
      if (method === 'team.members.list') return { members: [] };
      throw new Error(`unexpected method ${method}`);
    },
  },
}));

const { teamContext } = await import('./team-context.svelte');
const { teamBots, botCapabilitiesOf } = await import('./team-bots.svelte');

const CAPS = {
  canCreatePublicBot: true,
  privateBotsUsed: 2,
  privateBotsLimit: 10,
} as const;

function baseBootstrap(): Record<string, unknown> {
  return {
    member: { id: 'mbr_self', displayName: '甲', state: 'online' },
    server: { name: 'Acme 团队', version: '1.0.0' },
    surfaces: { hidden: [] },
    conversations: [],
    permissionCeiling: 'auto',
  };
}

beforeEach(() => {
  h.bootstrap = baseBootstrap();
  teamContext.reset();
  teamBots.reset();
});

describe('botCapabilities 消费（B1 契约字段 → team-bots store）', () => {
  it('新服务器携带 botCapabilities → botCapabilitiesOf 原样可读；成员 id 一并写入', async () => {
    h.bootstrap = { ...baseBootstrap(), botCapabilities: CAPS };
    teamContext.begin();
    await vi.waitFor(() => expect(teamContext.active).toBe(true));
    expect(botCapabilitiesOf('local')).toEqual(CAPS);
    expect(teamBots.selfMemberIdOf('local')).toBe('mbr_self');
  });

  it('旧服务器缺省字段 → null 降级（不是 undefined）', async () => {
    teamContext.begin();
    await vi.waitFor(() => expect(teamContext.active).toBe(true));
    expect(botCapabilitiesOf('local')).toBe(null);
  });

  it('reset 撤空：能力面回 null、成员 id 回 null', async () => {
    h.bootstrap = { ...baseBootstrap(), botCapabilities: CAPS };
    teamContext.begin();
    await vi.waitFor(() => expect(botCapabilitiesOf('local')).toEqual(CAPS));
    teamContext.reset();
    expect(botCapabilitiesOf('local')).toBe(null);
    expect(teamBots.selfMemberIdOf('local')).toBe(null);
  });
});
