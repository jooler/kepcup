import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamBotView } from '@kepcup/shared';
import type * as dialogsModule from './team-bot-dialogs.svelte';

/**
 * 团队编辑 Bot 对话框逻辑（member-bots B4 子域 A）：
 * - 编辑：patch 组装（子结构整体替换、未碰字段以加载基线回填、workdirKey
 *   未改不进 patch）；转交目标不含自己；保存 / 转交 / 删除的错误码呈现；
 * - 团队版创建入口（bot-setup.createTeamBotConversational，2026-11「+」菜单
 *   重构后由菜单直调，原创建对话框状态类已随组件移除）。
 *
 * connections / i18n 全 mock；状态类直测（无 DOM mount 基建）。
 */

const h = vi.hoisted(() => {
  return {
    caps: null as { canCreatePublicBot: boolean; privateBotsUsed: number; privateBotsLimit: number } | null,
    memberId: 'mbr_me' as string | null,
    bots: [] as Array<Record<string, unknown>>,
    profile: { } as Record<string, unknown>,
    models: [] as Array<{ id: string; label: string }>,
    members: [] as Array<{ id: string; displayName: string; state: string }>,
    calls: [] as Array<{ method: string; input: unknown }>,
    failWith: null as { code: string } | null,
  };
});

vi.mock('$lib/rpc/connections.svelte', () => ({
  serverHashOf: (source: string) => (source === 'local' ? null : source.slice('team:'.length)),
  teamSourceId: (hash: string) => `team:${hash}`,
  connections: {
    sources: () => ['local'],
    onSourcesChanged: () => () => undefined,
    get: () => ({
      status: 'connected',
      memberId: h.memberId,
      onConnected: () => () => undefined,
      onEvent: () => () => undefined,
      call: async (method: string, input?: unknown) => {
        h.calls.push({ method, input });
        if (h.failWith !== null) throw h.failWith;
        if (method === 'bots.get') return { bot: { profile: h.profile } };
        if (method === 'conversations.openDirect') return { conversation: { id: 'conv_direct_1' } };
        throw new Error(`unexpected core call ${method}`);
      },
      callTeam: async (method: string, input?: unknown) => {
        h.calls.push({ method, input });
        if (h.failWith !== null) throw h.failWith;
        if (method === 'team.bots.list') return { bots: h.bots };
        if (method === 'team.bots.modelOptions') return { models: h.models };
        if (method === 'team.members.list') return { members: h.members };
        if (method === 'team.bots.create') return { bot: { id: 'bot_new', name: 'n', mode: 'private', canEdit: true, canDelete: true } };
        if (method === 'team.bots.update') return { bot: h.bots[0] ?? { id: 'bot_1' } };
        if (method === 'team.bots.delete') return { deleted: true };
        if (method === 'team.bots.transfer') return { bot: { id: 'bot_1' } };
        throw new Error(`unexpected ${method}`);
      },
    }),
  },
}));

function profileFixture(): Record<string, unknown> {
  return {
    identity: { name: '研究助理', bio: '旧的简介', avatar: 'preset:1' },
    persona: { personality: '严谨', tone: '', style: '', values: '', sample_dialogues: '' },
    role: { expertise: '文献综述', responsibilities: '' },
    boundaries: ['不碰生产环境'],
    behavior: { proactive: false, quiet_hours: null, max_proactive_per_day: null },
    runtime: { model: 'gpt-x', light_model: '', network_policy: 'open', mcp_server_ids: [] },
  };
}

async function freshModules() {
  const dialogs = await import('./team-bot-dialogs.svelte');
  const store = (await import('./team-bots.svelte')).teamBots;
  store.reset();
  return { dialogs, store };
}

beforeEach(() => {
  h.caps = null;
  h.memberId = 'mbr_me';
  h.bots = [];
  h.profile = profileFixture();
  h.models = [{ id: 'gpt-x', label: 'GPT X' }, { id: 'claude-y', label: 'Claude Y' }];
  h.members = [
    { id: 'mbr_me', displayName: '我自己', state: 'online' },
    { id: 'mbr_alice', displayName: 'Alice', state: 'online' },
    { id: 'mbr_bob', displayName: 'Bob', state: 'offline' },
  ];
  h.calls = [];
  h.failWith = null;
});

describe('TeamBotEditState（编辑对话框）', () => {
  async function loadedState(overrides: Record<string, unknown> = {}) {
    const { dialogs } = await freshModules();
    h.bots = [
      {
        id: 'bot_1',
        name: '研究助理',
        mode: 'private',
        ownerMemberId: 'mbr_me',
        canEdit: true,
        canDelete: true,
        setupState: 'ready',
        workdirKey: 'member:research',
        workdirName: 'research',
        ...overrides,
      },
    ];
    const state = new dialogs.TeamBotEditState('team:h1', 'bot_1');
    await state.init();
    return state;
  }

  it('加载：表单基线绑定、转交候选不含自己、当前模型不在列表时保留标记项', async () => {
    const state = await loadedState();
    expect(state.view?.id).toBe('bot_1');
    expect(state.name).toBe('研究助理');
    expect(state.proactive).toBe(false);
    expect(state.model).toBe('gpt-x');
    expect(state.members.map((m) => m.id)).toEqual(['mbr_alice', 'mbr_bob']);
    // 模型在启用列表：不加标记项。
    expect(state.modelOptions).toHaveLength(2);
  });

  it('patch 组装：表单子结构整体发、未碰字段以基线回填、workdirKey 未改不进 patch', async () => {
    const state = await loadedState();
    state.name = '  新名字 ';
    state.personality = '活泼';
    state.boundariesText = '\n  第一条  \n\n第二条\n';
    state.proactive = true;
    const patch = state.buildPatch();
    expect(patch.identity).toEqual({ name: '新名字', bio: '旧的简介', avatar: 'preset:1' });
    expect(patch.persona).toEqual({ personality: '活泼', tone: '', style: '', values: '', sample_dialogues: '' });
    expect(patch.role).toEqual({ expertise: '文献综述', responsibilities: '' });
    expect(patch.boundaries).toEqual(['第一条', '第二条']);
    expect(patch.behavior).toEqual({ proactive: true, quiet_hours: null, max_proactive_per_day: null });
    // runtime 整体回发（model 为表单当前值，其余字段基线保留）。
    expect(patch.runtime).toMatchObject({ model: 'gpt-x', network_policy: 'open' });
    expect('workdirKey' in patch).toBe(false);
  });

  it('改选工作路径后 workdirKey 进 patch（opaque key 原样回传）', async () => {
    const state = await loadedState();
    state.workdirKey = 'admin:wrt_9';
    expect(state.buildPatch().workdirKey).toBe('admin:wrt_9');
  });

  it('名称清空：saveDisabled；保存失败置 saveError', async () => {
    const state = await loadedState();
    state.name = '   ';
    expect(state.nameInvalid).toBe(true);
    expect(state.saveDisabled).toBe(true);

    state.name = '有效名';
    h.failWith = { code: 'INVALID_INPUT' };
    expect(await state.save()).toBe(false);
    expect(state.saveError).toBe('INVALID_INPUT');
  });

  it('转交：目标校验与错误码（BOT_LIMIT_REACHED = 目标配额满）', async () => {
    const state = await loadedState();
    expect(state.transferDisabled).toBe(true);
    state.transferMemberId = 'mbr_alice';
    expect(state.transferDisabled).toBe(false);

    h.failWith = { code: 'BOT_LIMIT_REACHED' };
    expect(await state.transfer()).toBe(false);
    expect(state.transferError).toBe('BOT_LIMIT_REACHED');

    h.failWith = null;
    expect(await state.transfer()).toBe(true);
    expect(h.calls.find((c) => c.method === 'team.bots.transfer')?.input).toEqual({
      botId: 'bot_1',
      toMemberId: 'mbr_alice',
    });
  });

  it('公共 Bot：isPrivate=false（无转交分区）；删除确认后调 team.bots.delete', async () => {
    const state = await loadedState({ mode: 'public', workdirKey: 'admin:wrt_1', workdirName: 'projects' });
    expect(state.isPrivate).toBe(false);
    state.confirmingDelete = true;
    h.failWith = null;
    expect(await state.remove()).toBe(true);
    expect(h.calls.find((c) => c.method === 'team.bots.delete')?.input).toEqual({ botId: 'bot_1' });
  });

  it('加载失败（Bot 不可见）：loadError 呈现，不进表单', async () => {
    h.failWith = { code: 'NOT_FOUND' };
    const { dialogs } = await freshModules();
    const state = new dialogs.TeamBotEditState('team:h1', 'bot_ghost');
    await state.init();
    expect(state.loadError).toBe('NOT_FOUND');
    expect(state.view).toBeNull();
    expect(state.loading).toBe(false);
  });
});

describe('团队版创建入口（bot-setup.createTeamBotConversational）', () => {
  it('创建 → 同来源 openDirect → chat.select({source,id})；错误码原样返回', async () => {
    const select = vi.fn();
    vi.doMock('$lib/stores/chat.svelte', () => ({ chat: { select } }));
    vi.doMock('$lib/stores/shell.svelte', () => ({ shell: {} }));
    vi.doMock('$lib/stores/contacts.svelte', () => ({ contacts: {} }));
    try {
      const { createTeamBotConversational } = await import('$lib/features/bot-setup');
      const ok = await createTeamBotConversational('team:h1', { mode: 'private', name: '甲' });
      expect(ok).toMatchObject({ ok: true });
      expect(select).toHaveBeenCalledWith({ source: 'team:h1', id: 'conv_direct_1' });
      expect(h.calls.map((c) => c.method)).toContain('team.bots.create');
      expect(h.calls.find((c) => c.method === 'conversations.openDirect')?.input).toEqual({ botId: 'bot_new' });

      h.failWith = { code: 'WORKDIR_NOT_ALLOWED' };
      const failed = await createTeamBotConversational('team:h1', {
        mode: 'public',
        workdirKey: 'admin:missing',
      });
      expect(failed).toEqual({ ok: false, code: 'WORKDIR_NOT_ALLOWED' });
    } finally {
      vi.doUnmock('$lib/stores/chat.svelte');
      vi.doUnmock('$lib/stores/shell.svelte');
      vi.doUnmock('$lib/stores/contacts.svelte');
      vi.resetModules();
    }
  });
});

describe('botPanelRemoveAction（Bot 详情面板「移除 Bot」成员面判定）', () => {
  let dialogs: typeof dialogsModule;
  beforeAll(async () => {
    dialogs = await import('./team-bot-dialogs.svelte');
  });

  const OWNER_BOT: TeamBotView = {
    id: 'bot_own',
    name: '我的私有 Bot',
    mode: 'private',
    ownerMemberId: 'mbr_me',
    canEdit: true,
    canDelete: true,
  };
  const OTHER_PUBLIC: TeamBotView = {
    id: 'bot_pub',
    name: '他人的公共 Bot',
    mode: 'public',
    ownerMemberId: 'mbr_alice',
    canEdit: false,
    canDelete: false,
  };
  /** 切片读取桩：按 source 给 loaded / bots。 */
  function sliceOf(slices: Record<string, { loaded: boolean; bots: TeamBotView[] }>) {
    return (source: string) => slices[source] ?? { loaded: false, bots: [] };
  }
  type RemoveInput = Parameters<(typeof dialogsModule)['botPanelRemoveAction']>[0];
  const base: Omit<RemoveInput, 'resolveSlice'> = {
    teamActive: true,
    conversationSource: 'local',
    botId: 'bot_own',
    systemButler: false,
  };

  it('非团队上下文：恒走本地链路（slice 内容不参与判定）', () => {
    const resolveSlice = sliceOf({ local: { loaded: true, bots: [OWNER_BOT] } });
    expect(
      dialogs.botPanelRemoveAction({ ...base, teamActive: false, resolveSlice }),
    ).toEqual({ kind: 'local' });
  });

  it('团队端点 + 所有者 Bot：team 动作，来源锁定 local', () => {
    const resolveSlice = sliceOf({
      local: { loaded: true, bots: [OWNER_BOT, OTHER_PUBLIC] },
    });
    expect(dialogs.botPanelRemoveAction({ ...base, resolveSlice })).toEqual({
      kind: 'team',
      source: 'local',
      view: OWNER_BOT,
    });
  });

  it('非所有者 / 非成员面 Bot（管理员共享）：隐藏该行', () => {
    const resolveSlice = sliceOf({
      local: { loaded: true, bots: [OTHER_PUBLIC] },
    });
    expect(
      dialogs.botPanelRemoveAction({ ...base, botId: 'bot_pub', resolveSlice }),
    ).toEqual({ kind: 'hidden' });
    expect(
      dialogs.botPanelRemoveAction({ ...base, botId: 'bot_admin_restricted', resolveSlice }),
    ).toEqual({ kind: 'hidden' });
  });

  it('清单未解析：隐藏（不出现「点了没反应」的行）', () => {
    const resolveSlice = sliceOf({});
    expect(dialogs.botPanelRemoveAction({ ...base, resolveSlice })).toEqual({ kind: 'hidden' });
  });

  it('管家 / 无对话：恒隐藏', () => {
    const resolveSlice = sliceOf({ local: { loaded: true, bots: [OWNER_BOT] } });
    expect(dialogs.botPanelRemoveAction({ ...base, systemButler: true, resolveSlice })).toEqual({
      kind: 'hidden',
    });
    expect(dialogs.botPanelRemoveAction({ ...base, botId: null, resolveSlice })).toEqual({
      kind: 'hidden',
    });
  });

  it('桌面融合：取当前对话的团队来源（本机对话仍走本地链路）', () => {
    const resolveSlice = sliceOf({
      'team:h1': { loaded: true, bots: [OWNER_BOT] },
    });
    expect(
      dialogs.botPanelRemoveAction({
        ...base,
        teamActive: false,
        conversationSource: 'team:h1',
        resolveSlice,
      }),
    ).toEqual({ kind: 'team', source: 'team:h1', view: OWNER_BOT });
    expect(
      dialogs.botPanelRemoveAction({
        ...base,
        teamActive: false,
        conversationSource: 'local',
        resolveSlice,
      }),
    ).toEqual({ kind: 'local' });
    // 该来源清单未解析 → 隐藏。
    expect(
      dialogs.botPanelRemoveAction({
        ...base,
        teamActive: false,
        conversationSource: 'team:h2',
        resolveSlice,
      }),
    ).toEqual({ kind: 'hidden' });
  });
});

describe('botPanelEditAction（Bot 详情面板参数编辑的成员面判定）', () => {
  let dialogs: typeof dialogsModule;
  beforeAll(async () => {
    dialogs = await import('./team-bot-dialogs.svelte');
  });

  const OWNER_BOT: TeamBotView = {
    id: 'bot_own',
    name: '我的私有 Bot',
    mode: 'private',
    ownerMemberId: 'mbr_me',
    canEdit: true,
    canDelete: true,
    workdirKey: 'bot:bot_own',
    workdirName: 'bot_own',
  };
  const OTHER_PUBLIC: TeamBotView = {
    id: 'bot_pub',
    name: '他人的公共 Bot',
    mode: 'public',
    ownerMemberId: 'mbr_alice',
    canEdit: false,
    canDelete: false,
  };
  /** 切片读取桩：按 source 给 loaded / bots。 */
  function sliceOf(slices: Record<string, { loaded: boolean; bots: TeamBotView[] }>) {
    return (source: string) => slices[source] ?? { loaded: false, bots: [] };
  }
  type EditInput = Parameters<(typeof dialogsModule)['botPanelEditAction']>[0];
  const base: Omit<EditInput, 'resolveSlice'> = {
    teamActive: true,
    conversationSource: 'local',
    botId: 'bot_own',
  };

  it('团队端点 + 所有者 Bot（canEdit）：team 动作，保存与工作路径改走 team.bots.update', () => {
    const resolveSlice = sliceOf({ local: { loaded: true, bots: [OWNER_BOT, OTHER_PUBLIC] } });
    expect(dialogs.botPanelEditAction({ ...base, resolveSlice })).toEqual({
      kind: 'team',
      source: 'local',
      view: OWNER_BOT,
    });
  });

  it('非所有者（canEdit=false）回退本地链路——服务端 bot-edit 拒绝面兜底', () => {
    const resolveSlice = sliceOf({ local: { loaded: true, bots: [OTHER_PUBLIC] } });
    expect(
      dialogs.botPanelEditAction({ ...base, botId: 'bot_pub', resolveSlice }),
    ).toEqual({ kind: 'local' });
  });

  it('清单未解析 / 非团队成员面 Bot / 无 botId：回退本地链路（面板行为不变）', () => {
    const resolveSlice = sliceOf({});
    expect(dialogs.botPanelEditAction({ ...base, resolveSlice })).toEqual({ kind: 'local' });
    expect(
      dialogs.botPanelEditAction({ ...base, botId: 'bot_local_only', resolveSlice: sliceOf({ local: { loaded: true, bots: [OWNER_BOT] } }) }),
    ).toEqual({ kind: 'local' });
    expect(dialogs.botPanelEditAction({ ...base, botId: null, resolveSlice })).toEqual({
      kind: 'local',
    });
  });

  it('非团队上下文与桌面融合：来源判定与 removeAction 同口径', () => {
    const resolveSlice = sliceOf({ 'team:h1': { loaded: true, bots: [OWNER_BOT] } });
    expect(
      dialogs.botPanelEditAction({ ...base, teamActive: false, resolveSlice }),
    ).toEqual({ kind: 'local' });
    expect(
      dialogs.botPanelEditAction({
        ...base,
        teamActive: false,
        conversationSource: 'team:h1',
        resolveSlice,
      }),
    ).toEqual({ kind: 'team', source: 'team:h1', view: OWNER_BOT });
  });
});

describe('teamBotPatchOfProfile（右栏整份 Profile → team.bots.update patch）', () => {
  it('六个子结构浅拷贝整体进 patch（服务端按子结构替换 + 三方合并）', async () => {
    const { teamBotPatchOfProfile } = await import('./team-bot-dialogs.svelte');
    const profile = {
      identity: { name: '甲', bio: '简介' },
      persona: { personality: '沉稳', tone: '', style: '', values: '', sample_dialogues: '' },
      role: { expertise: '测试', responsibilities: '' },
      boundaries: ['不聊政治'],
      behavior: { proactive: true, quiet_hours: null, max_proactive_per_day: null },
      runtime: { model: 'p/m1', network_policy: 'open' },
    } as unknown as Parameters<typeof teamBotPatchOfProfile>[0];
    const patch = teamBotPatchOfProfile(profile);
    expect(patch).toEqual({
      identity: { name: '甲', bio: '简介' },
      persona: profile.persona,
      role: profile.role,
      boundaries: ['不聊政治'],
      behavior: profile.behavior,
      runtime: profile.runtime,
    });
    // 浅拷贝：改 patch 不回写原 profile。
    patch.boundaries?.push('另一条');
    expect(profile.boundaries).toEqual(['不聊政治']);
  });
});
