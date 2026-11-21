import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 项目组人类成员面板的逻辑层（T7 步骤 5，62.04 §4 / 62.09 §1）：
 * - 名册实时读口 `team.projects.roster`（T7 增量）：在线拉卡 + role；离线 /
 *   旧服务器回落消息推导（deriveHumanRoster）；
 * - 加人 / 移出 / 转交经会话来源的团队连接，成功后就地刷新名册；
 * - 非负责人只读：服务器以 NOT_PROJECT_LEAD 拒绝后收敛只读、后续动作本地拦截。
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; input: unknown }>,
  responder: null as null | ((method: string, input: unknown) => unknown),
  status: 'connected' as string,
  memberId: 'mbr_self' as string | null,
}));

vi.mock('$lib/rpc/connections.svelte', () => ({
  connections: {
    get: () => ({
      status: h.status,
      memberId: h.memberId,
      call: async (method: string, input?: unknown) => {
        h.calls.push({ method, input });
        if (h.responder === null) throw new Error('no responder');
        return h.responder(method, input);
      },
      onConnected: (_handler: () => void) => () => undefined,
    }),
  },
}));

const { deriveHumanRoster, ProjectMembersPanelState } = await import(
  '$lib/features/team/project-members.svelte'
);

beforeEach(() => {
  h.calls = [];
  h.responder = () => ({ ok: true });
  h.status = 'connected';
  h.memberId = 'mbr_self';
});

describe('deriveHumanRoster（名册推导）', () => {
  it('用户消息的发送主体入册；显示名取快照（后到的不覆盖已有名）', () => {
    const roster = deriveHumanRoster(
      [
        { senderType: 'bot' },
        { senderType: 'user', senderPrincipalId: 'mbr_a', senderName: '成员甲' },
        { senderType: 'user', senderPrincipalId: 'mbr_b', senderName: null },
        { senderType: 'user', senderPrincipalId: null, senderName: '本机单用户' },
        { senderType: 'system' },
      ],
      'mbr_self',
    );
    expect(roster).toEqual([
      { memberId: 'mbr_self', name: '' },
      { memberId: 'mbr_a', name: '成员甲' },
      { memberId: 'mbr_b', name: '' },
    ]);
  });

  it('空名成员补上后到的快照名（首条无名、次条有名）', () => {
    const roster = deriveHumanRoster(
      [
        { senderType: 'user', senderPrincipalId: 'mbr_a', senderName: null },
        { senderType: 'user', senderPrincipalId: 'mbr_a', senderName: '甲' },
      ],
      null,
    );
    expect(roster).toEqual([{ memberId: 'mbr_a', name: '甲' }]);
  });
});

describe('ProjectMembersPanelState（加人 / 移出 / 转交 / 非负责人只读）', () => {
  it('加人 → team.projects.addMembers（memberIds 数组）+ 名册就地刷新', async () => {
    const panel = new ProjectMembersPanelState({ source: 'team:h1', conversationId: 'proj_1' });
    const ok = await panel.addMembers(['mbr_a', 'mbr_b']);
    expect(ok).toBe(true);
    expect(h.calls).toEqual([
      { method: 'team.projects.addMembers', input: { conversationId: 'proj_1', memberIds: ['mbr_a', 'mbr_b'] } },
      { method: 'team.projects.roster', input: { conversationId: 'proj_1' } },
    ]);
  });

  it('移出 / 转交 → team.projects.removeMember / transferLead（各自跟名册刷新）', async () => {
    const panel = new ProjectMembersPanelState({ source: 'team:h1', conversationId: 'proj_1' });
    await panel.removeMember('mbr_a');
    await panel.transferLead('mbr_b');
    expect(h.calls.map((call) => call.method)).toEqual([
      'team.projects.removeMember',
      'team.projects.roster',
      'team.projects.transferLead',
      'team.projects.roster',
    ]);
    expect(h.calls[0]!.input).toEqual({ conversationId: 'proj_1', memberId: 'mbr_a' });
    expect(h.calls[2]!.input).toEqual({ conversationId: 'proj_1', memberId: 'mbr_b' });
  });

  it('非负责人：NOT_PROJECT_LEAD 拒绝后转只读，后续动作本地拦截', async () => {
    const panel = new ProjectMembersPanelState({ source: 'team:h1', conversationId: 'proj_1' });
    h.responder = () => {
      const error = new Error('not the lead') as Error & { code?: string };
      error.code = 'NOT_PROJECT_LEAD';
      throw error;
    };
    const removed = await panel.removeMember('mbr_a');
    expect(removed).toBe(false);
    expect(panel.readonlyOnly).toBe(true);
    expect(panel.lastError).toBe('NOT_PROJECT_LEAD');
    // 只读后不再发请求。
    h.calls.length = 0;
    expect(await panel.removeMember('mbr_b')).toBe(false);
    expect(await panel.transferLead('mbr_b')).toBe(false);
    expect(await panel.addMembers(['mbr_c'])).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('其它错误保持可操作（面板提示后可重试）', async () => {
    const panel = new ProjectMembersPanelState({ source: 'team:h1', conversationId: 'proj_1' });
    h.responder = () => {
      const error = new Error('rate limited') as Error & { code?: string };
      error.code = 'RATE_LIMITED';
      throw error;
    };
    expect(await panel.addMembers(['mbr_a'])).toBe(false);
    expect(panel.readonlyOnly).toBe(false);
    expect(panel.lastError).toBe('OTHER');
    h.responder = () => ({ ok: true });
    expect(await panel.addMembers(['mbr_a'])).toBe(true);
  });
});

describe('实时名册读口 team.projects.roster（T7 增量）', () => {
  it('在线拉取：映射成员卡 + role（负责人在前由服务器保证），isSelf 按连接成员标', async () => {
    const panel = new ProjectMembersPanelState({ source: 'team:h1', conversationId: 'proj_1' });
    h.responder = (_method, input) => {
      expect(input).toEqual({ conversationId: 'proj_1' });
      return {
        members: [
          { id: 'mbr_self', displayName: '我', state: 'online', role: 'lead' },
          { id: 'mbr_b', displayName: 'Bob', avatar: null, state: 'away', role: 'member' },
        ],
        leadMemberId: 'mbr_self',
      };
    };
    await panel.loadRoster();
    expect(panel.roster).not.toBe(null);
    expect(panel.roster?.leadMemberId).toBe('mbr_self');
    expect(panel.roster?.members).toEqual([
      { memberId: 'mbr_self', name: '我', state: 'online', avatar: null, role: 'lead', isSelf: true },
      { memberId: 'mbr_b', name: 'Bob', state: 'away', avatar: null, role: 'member', isSelf: false },
    ]);
  });

  it('动作成功后就地刷新名册（addMembers → roster 跟进）', async () => {
    const panel = new ProjectMembersPanelState({ source: 'team:h1', conversationId: 'proj_1' });
    h.responder = () => ({ ok: true });
    await panel.addMembers(['mbr_c']);
    expect(h.calls.map((call) => call.method)).toEqual([
      'team.projects.addMembers',
      'team.projects.roster',
    ]);
    h.calls.length = 0;
    await panel.removeMember('mbr_c');
    await panel.transferLead('mbr_c');
    expect(h.calls.map((call) => call.method)).toEqual([
      'team.projects.removeMember',
      'team.projects.roster',
      'team.projects.transferLead',
      'team.projects.roster',
    ]);
  });

  it('读口失败（旧服务器无该方法）→ roster=null 占位，面板回落消息推导；离线不发请求', async () => {
    const panel = new ProjectMembersPanelState({ source: 'team:h1', conversationId: 'proj_1' });
    h.responder = () => {
      throw new Error('FORBIDDEN: team method not implemented');
    };
    await panel.loadRoster();
    expect(panel.roster).toBe(null);

    h.status = 'idle';
    h.calls.length = 0;
    await panel.loadRoster();
    expect(panel.roster).toBe(null);
    expect(h.calls).toEqual([]);
  });
});
