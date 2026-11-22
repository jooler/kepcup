import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 团队项目组创建流（member-bots B4 子域 A）：lead 单选 + Bot / 人类成员多选 →
 * `projects.create`（经团队来源连接；服务端 keepCallerAsOnlyPrincipal）→
 * `team.projects.addMembers` 补人类成员 → 跳转新会话。无人类成员时不发
 * addMembers；错误码原样呈现。
 */

const h = vi.hoisted(() => {
  return {
    bots: [] as Array<Record<string, unknown>>,
    members: [] as Array<{ id: string; displayName: string; state: string }>,
    memberId: 'mbr_me' as string | null,
    calls: [] as Array<{ method: string; input: unknown }>,
    failWith: null as { code: string } | null,
    select: vi.fn(),
  };
});

vi.mock('$lib/rpc/connections.svelte', () => ({
  serverHashOf: (source: string) => (source === 'local' ? null : source.slice('team:'.length)),
  teamSourceId: (hash: string) => `team:${hash}`,
  connections: {
    sources: () => ['local', 'team:h1'],
    onSourcesChanged: () => () => undefined,
    get: () => ({
      status: 'connected',
      memberId: h.memberId,
      onConnected: () => () => undefined,
      onEvent: () => () => undefined,
      call: async (method: string, input?: unknown) => {
        h.calls.push({ method, input });
        if (h.failWith !== null) throw h.failWith;
        if (method === 'projects.create') return { conversation: { id: 'conv_proj_1' } };
        throw new Error(`unexpected core call ${method}`);
      },
      callTeam: async (method: string, input?: unknown) => {
        h.calls.push({ method, input });
        if (h.failWith !== null) throw h.failWith;
        if (method === 'team.bots.list') return { bots: h.bots };
        if (method === 'team.members.list') return { members: h.members };
        if (method === 'team.projects.addMembers') return { ok: true };
        throw new Error(`unexpected ${method}`);
      },
    }),
  },
}));

vi.mock('$lib/stores/chat.svelte', () => ({ chat: { select: h.select } }));

async function freshState() {
  const mod = await import('./team-project-create.svelte');
  const state = new mod.TeamProjectCreateState('team:h1');
  await state.init();
  return { mod, state };
}

beforeEach(() => {
  h.bots = [
    { id: 'bot_lead', name: '主管', mode: 'public', canEdit: false, canDelete: false },
    { id: 'bot_a', name: '研究员', mode: 'private', ownerMemberId: 'mbr_me', canEdit: true, canDelete: true },
    { id: 'bot_b', name: '_writer', mode: 'public', canEdit: false, canDelete: false },
  ];
  h.members = [
    { id: 'mbr_me', displayName: '我自己', state: 'online' },
    { id: 'mbr_alice', displayName: 'Alice', state: 'online' },
  ];
  h.memberId = 'mbr_me';
  h.calls = [];
  h.failWith = null;
  h.select.mockClear();
});

describe('候选与选择', () => {
  it('init：Bot 列表 + 人类成员（不含自己）', async () => {
    const { state } = await freshState();
    expect(state.bots.map((bot) => bot.id)).toEqual(['bot_lead', 'bot_a', 'bot_b']);
    expect(state.humans.map((member) => member.id)).toEqual(['mbr_alice']);
  });

  it('lead 选定后从成员候选移除；换 lead 时旧 lead 回到候选、成员轮选择保留', async () => {
    const { state } = await freshState();
    state.selectLead('bot_lead');
    state.toggleBotMember('bot_a');
    expect(state.botCandidates.map((bot) => bot.id)).toEqual(['bot_a', 'bot_b']);
    state.selectLead('bot_a');
    // bot_lead 回到候选；bot_a 从成员轮移除，bot_b 之外的既有选择保留。
    expect(state.botCandidates.map((bot) => bot.id)).toEqual(['bot_lead', 'bot_b']);
    state.selectLead('bot_lead');
    // bot_a 当过 lead：回到成员轮不再自动恢复（成员轮选择只对未当过 lead 的项保留）。
    expect(state.memberBotIds).toEqual([]);
  });

  it('titlePreview：lead 在前（projectTitleFromMemberNames 同本机 compose）', async () => {
    const { state } = await freshState();
    state.selectLead('bot_lead');
    state.toggleBotMember('bot_a');
    expect(state.titlePreview).toContain('主管');
    expect(state.titlePreview).toContain('研究员');
  });

  it('canSubmit：lead 必选 + 至少一个 Bot 成员', async () => {
    const { state } = await freshState();
    expect(state.canSubmit).toBe(false);
    state.selectLead('bot_lead');
    expect(state.canSubmit).toBe(false);
    state.toggleBotMember('bot_a');
    expect(state.canSubmit).toBe(true);
  });
});

describe('提交流', () => {
  it('projects.create（memberBotIds 含 lead）→ 有人类成员时 addMembers → 跳转', async () => {
    const { state } = await freshState();
    state.selectLead('bot_lead');
    state.toggleBotMember('bot_a');
    state.toggleHuman('mbr_alice');
    expect(await state.submit()).toBe(true);
    expect(h.calls.find((c) => c.method === 'projects.create')?.input).toMatchObject({
      leadBotId: 'bot_lead',
      memberBotIds: ['bot_lead', 'bot_a'],
    });
    expect(h.calls.find((c) => c.method === 'team.projects.addMembers')?.input).toEqual({
      conversationId: 'conv_proj_1',
      memberIds: ['mbr_alice'],
    });
    expect(h.select).toHaveBeenCalledWith({ source: 'team:h1', id: 'conv_proj_1' });
  });

  it('无人类成员：不发 addMembers', async () => {
    const { state } = await freshState();
    state.selectLead('bot_lead');
    state.toggleBotMember('bot_b');
    expect(await state.submit()).toBe(true);
    expect(h.calls.some((c) => c.method === 'team.projects.addMembers')).toBe(false);
  });

  it('创建失败：errorCode 原样呈现、不跳转', async () => {
    const { state } = await freshState();
    state.selectLead('bot_lead');
    state.toggleBotMember('bot_a');
    h.failWith = { code: 'INVALID_INPUT' };
    expect(await state.submit()).toBe(false);
    expect(state.errorCode).toBe('INVALID_INPUT');
    expect(h.select).not.toHaveBeenCalled();
  });
});

describe('宿主（openTeamProjectCreate）', () => {
  it('open 置 state 并预取；close 清空', async () => {
    const mod = await import('./team-project-create.svelte');
    mod.teamProjectCreate.close();
    mod.openTeamProjectCreate('team:h1');
    expect(mod.teamProjectCreate.state).not.toBeNull();
    await vi.waitFor(() =>
      expect(mod.teamProjectCreate.state?.loading).toBe(false),
    );
    expect(mod.teamProjectCreate.state?.bots.length).toBe(3);
    mod.closeTeamProjectCreate();
    expect(mod.teamProjectCreate.state).toBeNull();
  });
});
