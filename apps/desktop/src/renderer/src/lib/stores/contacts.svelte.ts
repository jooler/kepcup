import type { Bot, Conversation, TeamMember, TeamMemberState } from '@kepcup/shared';
import { isArchivedConversation } from '@kepcup/shared';
import { t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { connections, serverHashOf, teamSourceId, type SourceId } from '$lib/rpc/connections.svelte';
import { teamContext } from '$lib/features/team/team-context.svelte';
import { markTeamSectionSource } from '$lib/features/team/team-availability';
import {
  setTeamBotCapabilities,
  setTeamMemberId,
  type TeamBotCapabilities,
} from '$lib/features/team/team-bots.svelte';

/**
 * 一个已融合团队来源的通讯录切片（T7 步骤 3，62.04 §1 双源名册）：成员 / 可见
 * Bot / 会话名册与「我」。数据经该来源的 team.bootstrap、team.members.list、
 * bots.list、conversations.all 拉取；事件增量维护。断开时 `connected` 为 false，
 * UI 显示「未连接」占位、不伪造数据。
 */
export interface TeamSourceSlice {
  serverHash: string;
  serverName: string;
  connected: boolean;
  members: TeamMember[];
  bots: Bot[];
  conversations: Conversation[];
  self: TeamMember | null;
}

class ContactsState {
  bots = $state<Bot[]>([]);
  /**
   * 通讯录名册里的会话（含已从对话列表移除的归档会话）：项目组一栏用它，
   * Bot 一栏用它标出「这个 Bot 的对话已从列表移除」。
   */
  conversations = $state<Conversation[]>([]);
  /** 名册是否已加载过（首屏之后才有归档会话的名单）。 */
  rosterLoaded = $state(false);
  #started = false;

  /**
   * 团队成员名册（T5，62.04 §1 融合名册）：数据源是团队上下文的
   * `team.members.list` + member.* 事件（在 team-context 统一拉取与刷新，
   * 通讯录 / @ 候选 / dm 会话头共用同一份）。非团队上下文恒为空数组——
   * 通讯录只有 Bot 与项目组两栏，与现状逐字节一致（休眠验收项）。
   */
  get members(): TeamMember[] {
    return teamContext.active ? teamContext.members : [];
  }

  /** 当前成员（「成员」栏顶部的「我」条目）；非团队上下文为 null。 */
  get self(): TeamMember | null {
    return teamContext.active ? teamContext.member : null;
  }

  /**
   * 团队来源切片（T7 融合视图）：serverHash → 名册。未融合 / 断开时无键或
   * `connected: false`——通讯录团队栏显示「未连接」占位，不伪造数据。
   */
  teamSources = $state<Record<string, TeamSourceSlice>>({});
  #teamStarted = false;
  /** 已接线的连接实例（按实例而非 serverHash：断开重连会换新连接对象）。 */
  readonly #teamWired = new Set<object>();
  readonly #teamUnsubscribers: Array<() => void> = [];

  /** 某来源的团队切片（未融合返回 null）。 */
  teamSliceOf(source: SourceId): TeamSourceSlice | null {
    const hash = serverHashOf(source);
    return hash === null ? null : (this.teamSources[hash] ?? null);
  }

  /** 某来源的团队成员名册（web 团队端点 = teamContext 名册，行为不变）。 */
  teamMembersOf(source: SourceId): TeamMember[] {
    const hash = serverHashOf(source);
    if (hash === null) return teamContext.active ? teamContext.members : [];
    return this.teamSources[hash]?.members ?? [];
  }

  /** 某来源的「我」（web = teamContext.member）。 */
  teamSelfOf(source: SourceId): TeamMember | null {
    const hash = serverHashOf(source);
    if (hash === null) return teamContext.active ? teamContext.member : null;
    return this.teamSources[hash]?.self ?? null;
  }

  /** 按来源 + 主体 id 找成员（dm 对端卡片 / 气泡头像）。 */
  teamMemberById(source: SourceId, memberId: string): TeamMember | null {
    const hash = serverHashOf(source);
    if (hash === null) return teamContext.memberById(memberId);
    const slice = this.teamSources[hash];
    if (!slice) return null;
    return slice.members.find((member) => member.id === memberId) ?? null;
  }

  /** 按来源 + Bot id 解析 Bot（团队条目的 Bot 解析按来源查，62.04 §7）。 */
  botAt(source: SourceId, botId: string): Bot | null {
    const hash = serverHashOf(source);
    if (hash === null) return this.bots.find((bot) => bot.id === botId) ?? null;
    return this.teamSources[hash]?.bots.find((bot) => bot.id === botId) ?? null;
  }

  /**
   * dm 会话的对端视图（按来源解析）：web 团队端点（'local'）沿用 teamContext
   * 的解析（T5 行为不变）；团队来源读该来源的名册切片。
   */
  dmPeerViewOf(
    source: SourceId,
    peerPrincipalIds: readonly string[] | null | undefined,
  ): {
    title: string;
    peerId: string | null;
    avatar: string | null;
    state: TeamMemberState;
    awayNote: string | null;
  } {
    if (serverHashOf(source) === null) {
      const view = teamContext.dmPeerView(peerPrincipalIds);
      return { ...view, awayNote: null };
    }
    const self = this.teamSelfOf(source);
    const peerId = (peerPrincipalIds ?? []).find((id) => id !== self?.id) ?? null;
    if (peerId === null) {
      // 自我会话：标题用「我」的显示名（2026-11 与真人条目同口径），无成员卡时
      // 才回落「我」文案。
      return {
        title: self?.displayName || t('team.selfConversation'),
        peerId: null,
        avatar: self?.avatar ?? null,
        state: self?.state ?? 'offline',
        awayNote: null,
      };
    }
    const peer = this.teamMemberById(source, peerId);
    return {
      title: peer?.displayName || peerId,
      peerId,
      avatar: peer?.avatar ?? null,
      state: peer?.state ?? 'offline',
      awayNote:
        peer?.state === 'away'
          ? peer.avatarBotName !== undefined
            ? t('team.awayAvatarHandling', { bot: peer.avatarBotName })
            : t('team.dmAwayHint')
          : null,
    };
  }

  /**
   * 打开与某成员的 dm（team.dm.open：既有会话复用，没有则新建），返回会话 id。
   * web 团队端点走 teamContext / core 单例（T5 不变）；团队来源经该来源连接。
   */
  async openDm(targetMemberId?: string): Promise<string | null> {
    if (!teamContext.active) return null;
    // 无参调用（自我会话）发空对象帧：birpc 零参调用在服务端收到 undefined，
    // strictObject 的 optional 字段不豁免整体 undefined（会 INVALID_INPUT）。
    const result = (await core.callTeam(
      'team.dm.open',
      targetMemberId === undefined ? {} : { targetMemberId },
    )) as { conversation: Conversation };
    return result.conversation.id;
  }

  /** 团队来源的 dm：返回带来源的会话引用（调用方 chat.select(ref)）。 */
  async openTeamDm(
    source: SourceId,
    targetMemberId?: string,
  ): Promise<{ source: SourceId; id: string } | null> {
    const hash = serverHashOf(source);
    if (hash === null) return null;
    const conn = connections.get(source);
    if (conn.status !== 'connected') return null;
    try {
      const result = (await conn.callTeam(
        'team.dm.open',
        targetMemberId === undefined ? {} : { targetMemberId },
      )) as { conversation: Conversation };
      return { source, id: result.conversation.id };
    } catch {
      return null;
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#startTeamSources();
    core.onEvent('bot.updated', (payload) => {
      const data = payload as { bot: Bot };
      const index = this.bots.findIndex((b) => b.id === data.bot.id);
      if (index >= 0) {
        this.bots[index] = data.bot;
        this.bots = [...this.bots];
      } else {
        this.bots = [...this.bots, data.bot];
      }
    });
    core.onEvent('bot.deleted', (payload) => {
      const data = payload as { id: string };
      this.bots = this.bots.filter((b) => b.id !== data.id);
    });
    core.onEvent('conversation.updated', (payload) => {
      const data = payload as { conversation: Conversation };
      // Card chats stay out of the address book; bot_direct exchange
      // conversations too (v2.3 — pill detail only). The dialog session
      // listens on its own.
      if (data.conversation.type === 'card' || data.conversation.type === 'bot_direct') return;
      this.#upsertConversation(data.conversation);
    });
    core.onEvent('conversation.deleted', (payload) => {
      const data = payload as { id: string };
      this.conversations = this.conversations.filter((c) => c.id !== data.id);
    });
  }

  async refresh(): Promise<void> {
    const result = (await core.call('bots.list')) as { bots: Bot[] };
    this.bots = result.bots;
    try {
      const roster = (await core.call('conversations.all')) as { conversations: Conversation[] };
      this.conversations = roster.conversations;
      this.rosterLoaded = true;
    } catch {
      // 名册拿不到也不该拖垮通讯录：Bot 一栏照常显示（项目组一栏暂时为空）。
      this.rosterLoaded = true;
    }
  }

  /** 通讯录里的项目组（含已归档的）。 */
  get projects(): Conversation[] {
    return this.conversations.filter((c) => c.type === 'project');
  }

  /** 某个 Bot 的直聊是否已从对话列表移除（归档）。 */
  isChatArchived(botId: string): boolean {
    return this.archivedChatOf(botId) !== undefined;
  }

  /** 某个 Bot 已归档的直聊（恢复它用）。 */
  archivedChatOf(botId: string): Conversation | undefined {
    return this.conversations.find(
      (c) => c.type === 'direct' && c.directBotId === botId && isArchivedConversation(c),
    );
  }

  #upsertConversation(conversation: Conversation): void {
    const index = this.conversations.findIndex((c) => c.id === conversation.id);
    if (index >= 0) {
      this.conversations[index] = { ...this.conversations[index], ...conversation };
      this.conversations = [...this.conversations];
    } else {
      this.conversations = [conversation, ...this.conversations];
    }
  }

  async create(profile: Bot['profile']): Promise<Bot> {
    const result = (await core.call('bots.create', { profile })) as { bot: Bot };
    return result.bot;
  }

  /**
   * `base`：表单是从哪一版 Profile 改出来的。给了就由 core 与最新 Profile 三方合并，表单没碰的
   * 字段（如 Bot 刚直改的模型、设置卡刚收回的 MCP）不会被过期表单覆盖（D89 审查修复）。
   */
  async update(id: string, profile: Bot['profile'], base?: Bot['profile'] | null): Promise<Bot> {
    const result = (await core.call('bots.update', {
      id,
      profile,
      ...(base !== undefined && base !== null ? { base } : {}),
    })) as { bot: Bot };
    return result.bot;
  }

  /** Projects this bot currently leads (deleting it is blocked until replaced). */
  async deletionPreview(id: string): Promise<{
    conversations: number;
    messages: number;
    memoryItems: number;
    wikiPages: number;
    skills: number;
    ledProjects: Array<{ id: string; title: string | null }>;
  }> {
    return (await core.call('bots.deletionPreview', { id })) as {
      conversations: number;
      messages: number;
      memoryItems: number;
      wikiPages: number;
      skills: number;
      ledProjects: Array<{ id: string; title: string | null }>;
    };
  }

  async remove(id: string): Promise<void> {
    await core.call('bots.delete', { id });
  }

  // --- 团队来源切片（T7 融合视图） ----------------------------------------------

  #startTeamSources(): void {
    if (this.#teamStarted) return;
    this.#teamStarted = true;
    this.#teamUnsubscribers.push(connections.onSourcesChanged(() => this.#wireTeamSources()));
    this.#wireTeamSources();
  }

  #wireTeamSources(): void {
    for (const source of connections.sources()) {
      const hash = serverHashOf(source);
      if (hash === null) continue;
      const conn = connections.get(source);
      if (this.#teamWired.has(conn)) continue;
      this.#teamWired.add(conn);
      this.#teamUnsubscribers.push(conn.onConnected(() => void this.#refreshTeamSource(hash)));
      this.#teamUnsubscribers.push(
        conn.onTeamEvent('member.presenceChanged', (payload) => {
          const data = payload as { memberId: string; state: TeamMemberState; lastSeenAt?: number };
          this.#patchTeamPresence(hash, data.memberId, data.state, data.lastSeenAt);
        }),
      );
      // updated / disabled 只带 memberId：重拉名册收敛（同 teamContext 的约定）。
      this.#teamUnsubscribers.push(
        conn.onTeamEvent('member.updated', () => void this.#refreshTeamRoster(hash)),
      );
      this.#teamUnsubscribers.push(
        conn.onTeamEvent('member.disabled', () => void this.#refreshTeamRoster(hash)),
      );
      if (conn.status === 'connected') void this.#refreshTeamSource(hash);
    }
    // 服务器被移除：丢切片（设置分区标记一并撤）。
    for (const hash of Object.keys(this.teamSources)) {
      if (!connections.sources().includes(teamSourceId(hash))) {
        const next = { ...this.teamSources };
        delete next[hash];
        this.teamSources = next;
        markTeamSectionSource(hash, false);
      }
    }
  }

  async #refreshTeamSource(serverHash: string): Promise<void> {
    const source = teamSourceId(serverHash);
    const conn = connections.get(source);
    try {
      const bootstrap = (await conn.callTeam('team.bootstrap')) as {
        member: TeamMember;
        server: { name: string };
        /** B1 契约的可选字段：旧服务端缺省 → null 降级（member-bots B4）。 */
        botCapabilities?: TeamBotCapabilities;
      };
      // 桌面融合来源的成员 Bot 能力面（B4 审查期合并校正：与 team-context 的
      // web 路径同款）——不写则桌面端建 Bot 对话框降级（无公共档 / 无配额）。
      setTeamBotCapabilities(source, bootstrap.botCapabilities ?? null);
      setTeamMemberId(source, bootstrap.member.id);
      const slice: TeamSourceSlice = {
        serverHash,
        serverName: bootstrap.server.name,
        connected: true,
        members: [bootstrap.member],
        bots: [],
        conversations: [],
        self: bootstrap.member,
      };
      this.teamSources = { ...this.teamSources, [serverHash]: slice };
      markTeamSectionSource(serverHash, true);
      await Promise.all([this.#refreshTeamRoster(serverHash), this.#refreshTeamBots(serverHash)]);
    } catch {
      // 断开 / 未认证：切片转「未连接」占位（保留空骨架，不伪造数据）。
      // 能力面一并撤空（team-context.reset 的同款语义）；成员 id 置空后
      // selfMemberIdOf 回落连接自带的 memberId（可能仍是上次登录的值）。
      setTeamBotCapabilities(source, null);
      setTeamMemberId(source, null);
      const existing = this.teamSources[serverHash];
      this.teamSources = {
        ...this.teamSources,
        [serverHash]: {
          serverHash,
          serverName: existing?.serverName ?? '',
          connected: false,
          members: [],
          bots: [],
          conversations: [],
          self: null,
        },
      };
    }
  }

  async #refreshTeamRoster(serverHash: string): Promise<void> {
    if (this.teamSources[serverHash]?.connected !== true) return;
    try {
      const result = (await connections.get(teamSourceId(serverHash)).callTeam(
        'team.members.list',
      )) as { members: TeamMember[] };
      // 并行刷新（roster / bots）互不覆盖：合并基于当时的最新切片。
      const current = this.teamSources[serverHash];
      if (current?.connected === true) {
        this.teamSources[serverHash] = { ...current, members: result.members };
      }
    } catch {
      // 名册拉取失败保留旧快照（重连后 onConnected 再收敛）。
    }
  }

  async #refreshTeamBots(serverHash: string): Promise<void> {
    if (this.teamSources[serverHash]?.connected !== true) return;
    const conn = connections.get(teamSourceId(serverHash));
    try {
      const [botsResult, rosterResult] = (await Promise.all([
        conn.call('bots.list') as Promise<{ bots: Bot[] }>,
        conn.call('conversations.all') as Promise<{ conversations: Conversation[] }>,
      ])) as [{ bots: Bot[] }, { conversations: Conversation[] }];
      const current = this.teamSources[serverHash];
      if (current?.connected === true) {
        this.teamSources[serverHash] = {
          ...current,
          bots: botsResult.bots,
          conversations: rosterResult.conversations,
        };
      }
    } catch {
      // Bot 名册失败保留旧快照。
    }
  }

  #patchTeamPresence(
    serverHash: string,
    memberId: string,
    state: TeamMemberState,
    lastSeenAt?: number,
  ): void {
    const slice = this.teamSources[serverHash];
    if (!slice) return;
    const patch = (member: TeamMember): TeamMember =>
      member.id === memberId
        ? { ...member, state, ...(lastSeenAt === undefined ? {} : { lastSeenAt }) }
        : member;
    this.teamSources[serverHash] = {
      ...slice,
      members: slice.members.map(patch),
      self: slice.self !== null ? patch(slice.self) : null,
    };
  }
}

export const contacts = new ContactsState();
