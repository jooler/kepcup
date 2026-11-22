import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 团队建 Bot / 编辑 Bot 对话框逻辑（member-bots B4 子域 A）：
 * - 创建：public 仅 canCreatePublicBot；配额满前置禁用；BOT_LIMIT_REACHED /
 *   WORKDIR_NOT_ALLOWED 错误码置 errorCode；成功路径不走禁用分支；
 * - 编辑：patch 组装（子结构整体替换、未碰字段以加载基线回填、workdirPath
 *   未改不进 patch）；转交目标不含自己；保存 / 转交 / 删除的错误码呈现。
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

describe('TeamCreateBotState（创建对话框）', () => {
  it('默认 private；无 caps（旧服务端）= public 隐藏、不显配额、不禁用', async () => {
    const { dialogs } = await freshModules();
    const state = new dialogs.TeamCreateBotState('team:h1', { submit: async () => ({ ok: true }) });
    expect(state.mode).toBe('private');
    expect(state.publicAllowed).toBe(false);
    expect(state.quota).toBeNull();
    expect(state.quotaFull).toBe(false);
    expect(state.createDisabled).toBe(false);
  });

  it('caps.canCreatePublicBot = true 时 public 档可用；配额满时 private 前置禁用', async () => {
    const { dialogs, store } = await freshModules();
    store.setTeamBotCapabilities('team:h1', { canCreatePublicBot: true, privateBotsUsed: 10, privateBotsLimit: 10 });
    const state = new dialogs.TeamCreateBotState('team:h1', { submit: async () => ({ ok: true }) });
    expect(state.publicAllowed).toBe(true);
    expect(state.quota).toEqual({ used: 10, limit: 10 });
    expect(state.quotaFull).toBe(true);
    expect(state.createDisabled).toBe(true);
    // public 档不受私有配额限制（服务端另行校验分组权限）。
    state.mode = 'public';
    expect(state.createDisabled).toBe(false);
  });

  it('名称超 50 字前置禁用；提交带 trim 后的名称与工作路径', async () => {
    const { dialogs } = await freshModules();
    const submits: Array<Record<string, unknown>> = [];
    const state = new dialogs.TeamCreateBotState('team:h1', {
      submit: async (input) => {
        submits.push(input as unknown as Record<string, unknown>);
        return { ok: true };
      },
    });
    state.name = 'x'.repeat(51);
    expect(state.nameInvalid).toBe(true);
    expect(state.createDisabled).toBe(true);
    await state.submit();
    expect(submits).toHaveLength(0);

    state.name = '  数据分析  ';
    state.workdirPath = '/srv/projects';
    expect(await state.submit()).toBe(true);
    expect(submits[0]).toEqual({ mode: 'private', name: '数据分析', workdirPath: '/srv/projects' });
  });

  it('BOT_LIMIT_REACHED：errorCode 置码（对话框内联 limitReached），提交失败不关框', async () => {
    const { dialogs } = await freshModules();
    const state = new dialogs.TeamCreateBotState('team:h1', {
      submit: async () => ({ ok: false, code: 'BOT_LIMIT_REACHED' }),
    });
    expect(await state.submit()).toBe(false);
    expect(state.errorCode).toBe('BOT_LIMIT_REACHED');
  });

  it('mode=public 而权限被收回（caps 刷新后）：normalizeMode 回退 private', async () => {
    const { dialogs, store } = await freshModules();
    store.setTeamBotCapabilities('team:h1', { canCreatePublicBot: true, privateBotsUsed: 0, privateBotsLimit: 10 });
    const state = new dialogs.TeamCreateBotState('team:h1', { submit: async () => ({ ok: true }) });
    state.mode = 'public';
    store.setTeamBotCapabilities('team:h1', { canCreatePublicBot: false, privateBotsUsed: 0, privateBotsLimit: 10 });
    state.normalizeMode();
    expect(state.mode).toBe('private');
  });
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
        workdirPath: '/data/members/mbr_me/workdirs/research',
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

  it('patch 组装：表单子结构整体发、未碰字段以基线回填、workdirPath 未改不进 patch', async () => {
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
    expect('workdirPath' in patch).toBe(false);
  });

  it('改选工作路径后 workdirPath 进 patch', async () => {
    const state = await loadedState();
    state.workdirPath = '/srv/projects';
    expect(state.buildPatch().workdirPath).toBe('/srv/projects');
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
    const state = await loadedState({ mode: 'public', workdirPath: '/srv/projects' });
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
      const failed = await createTeamBotConversational('team:h1', { mode: 'public', workdirPath: '/etc' });
      expect(failed).toEqual({ ok: false, code: 'WORKDIR_NOT_ALLOWED' });
    } finally {
      vi.doUnmock('$lib/stores/chat.svelte');
      vi.doUnmock('$lib/stores/shell.svelte');
      vi.doUnmock('$lib/stores/contacts.svelte');
      vi.resetModules();
    }
  });
});
