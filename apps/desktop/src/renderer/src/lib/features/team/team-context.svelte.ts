import type { TeamMember, TeamMemberState } from '@kepcup/shared';
import { teamBootstrapSchema } from '@kepcup/shared';
import { t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { isTeamHidden, setTeamHiddenSurfaces } from './surface-gate';
import { markTeamSectionSource } from './team-availability';

/**
 * 团队上下文（T5 步骤 2，62.08 §3 / 62.04 §7）：渲染层与团队服务器会话的
 * 响应式视图——我是谁（成员）、服务器信息、被隐藏的入口（surfaces）、成员
 * 名册与在线状态。
 *
 * 休眠铁律（逐 PR 验收项）：`begin()` 只在团队端点被识别后调用（whoami 探测
 * 或登录响应携带 `member`，见 gate.svelte.ts）。非团队上下文里 `active` 恒为
 * false、名册恒为空数组、`isTeamHidden` 恒为 false——所有消费点（设置分区
 * 过滤、endpointSupports、通讯录成员栏、气泡分侧）的行为与未接团队服务器时
 * 完全一致。
 *
 * bootstrap 失败（权限被拒 / 断线 / 非 P0 服务器）时保持休眠不报错：体验层
 * 门控只是增强，真正的边界在团队服务器的成员方法策略（未归类即拒绝）。
 * 连接恢复（core.onConnected）后自动重试，事件（member.*）驱动增量刷新。
 */
class TeamContextState {
  /** 团队会话已建立（bootstrap 成功）。非团队端点恒 false。 */
  active = $state(false);
  /**
   * 团队端点已确认（探测 / 登录响应带 member）——与 begin() 同步置位，不等
   * bootstrap。`active` 要等 team.bootstrap RPC 成功才翻转，App 首屏 bootstrap
   * 与之并行竞速：settings / permissions 等 store 需要在首屏就拿到「这是团队
   * 服务器」的确定答案（跳过 admin-plane 方法），用这个。
   */
  endpointIsTeam = $state(false);
  /** 当前成员（团队身份）；自我会话、气泡分侧、@ 候选排除都用它。 */
  member = $state<TeamMember | null>(null);
  /** 团队服务器显示名（通讯录「成员」栏标题等展示用）。 */
  serverName = $state('');
  /** 授权上限（C14，P0 仅记录，P1 权限菜单消费）。 */
  permissionCeiling = $state<string | null>(null);
  /**
   * 成员名册（`team.members.list` + member.* 事件增量维护，含自己）。
   * 通讯录「成员」栏与 @ 候选的数据源；非团队上下文恒空数组。
   */
  members = $state<TeamMember[]>([]);

  #started = false;
  #bound = false;
  #refreshing = false;

  /**
   * 团队端点已确认（探测 / 登录响应带 member）。幂等；此后每次连接建立都会
   * 自动拉取 bootstrap。仅由登录门（gate.svelte.ts）调用。
   */
  begin(): void {
    if (this.#started) return;
    this.#started = true;
    // 同步确认端点身份（不等 bootstrap，见 endpointIsTeam 注释）。
    this.endpointIsTeam = true;
    // T7：「团队」设置分区在 web 团队端点出现（离开态 / 免打扰 / 用量）。
    markTeamSectionSource('local', true);
    this.#bind();
    // 已连接的会话（登录前 Cookie 就在）不会再触发 onConnected：直接试一次。
    void this.#refresh();
  }

  /**
   * 会话失效 / 登出：回到休眠态（团队面全部消失，同非团队上下文）。`#started`
   * 一并复位——同一页面内重新登录（不刷新）后 `begin()` 要能再次拉起团队上下文。
   */
  reset(): void {
    this.active = false;
    this.endpointIsTeam = false;
    this.member = null;
    this.serverName = '';
    this.permissionCeiling = null;
    setTeamHiddenSurfaces([]);
    this.members = [];
    markTeamSectionSource('local', false);
    this.#started = false;
    this.#refreshing = false;
  }

  #bind(): void {
    if (this.#bound) return;
    this.#bound = true;
    core.onConnected(() => void this.#refresh());
    core.onTeamEvent('member.presenceChanged', (payload) => {
      const data = payload as { memberId: string; state: TeamMemberState; lastSeenAt?: number };
      this.#patchPresence(data.memberId, data.state, data.lastSeenAt);
    });
    // updated / disabled 都只带 memberId：按设计约定直接重拉名册收敛。
    core.onTeamEvent('member.updated', () => void this.#refreshMembers());
    core.onTeamEvent('member.disabled', () => void this.#refreshMembers());
  }

  /** 拉取 bootstrap 并填充上下文；失败保持现状（休眠或上次成功的快照）。 */
  async #refresh(): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      const bootstrap = teamBootstrapSchema.parse(
        (await core.callTeam('team.bootstrap')) as unknown,
      );
      this.active = true;
      this.member = bootstrap.member;
      this.serverName = bootstrap.server.name;
      this.permissionCeiling = bootstrap.permissionCeiling;
      setTeamHiddenSurfaces(bootstrap.surfaces.hidden);
      // bootstrap 里的 conversations 是会话视图快照：左栏/通讯录统一走既有
      // conversations.list 路径，这里不落 store。
      await this.#refreshMembers();
    } catch {
      // 服务器拒绝 / 断线：体验层保持现状。首次失败即保持休眠（active=false）。
    } finally {
      this.#refreshing = false;
    }
  }

  async #refreshMembers(): Promise<void> {
    try {
      const result = (await core.callTeam('team.members.list')) as { members: TeamMember[] };
      if (!this.active) return;
      this.members = result.members;
      // 自己的成员卡一并收敛（updateSelf 改显示名 / 头像后 member.updated 只带
      // id，名册重拉是唯一事实源；bootstrap 之外不再原地旧值）。
      const self = this.member?.id !== undefined ? (result.members.find((entry) => entry.id === this.member?.id) ?? null) : null;
      if (self !== null) this.member = self;
    } catch {
      // 名册拉取失败保留旧快照（断线重连后 onConnected 会再收敛）。
    }
  }

  #patchPresence(memberId: string, state: TeamMemberState, lastSeenAt?: number): void {
    const patch = (entry: TeamMember): TeamMember =>
      entry.id === memberId ? { ...entry, state, ...(lastSeenAt === undefined ? {} : { lastSeenAt }) } : entry;
    this.members = this.members.map(patch);
    if (this.member?.id === memberId) {
      this.member = { ...this.member, state, ...(lastSeenAt === undefined ? {} : { lastSeenAt }) };
    }
  }

  /**
   * 入口门控判定（T5 步骤 3）：代理到共享的 surface-gate（被隐藏 id 集合）。
   * 非团队上下文（集合为空）恒 false——所有调用点在休眠时零行为变化。
   */
  isTeamHidden(id: string): boolean {
    return isTeamHidden(id);
  }

  /** 按主体 id 找成员（气泡头像 / dm 对端卡片）；找不到（已禁用等）返回 null。 */
  memberById(id: string): TeamMember | null {
    if (this.member?.id === id) return this.member;
    return this.members.find((member) => member.id === id) ?? null;
  }

  /** 成员在线状态；非团队上下文（无成员）恒 offline。 */
  memberState(id: string): TeamMemberState {
    return this.memberById(id)?.state ?? 'offline';
  }

  /**
   * dm 会话的对端视图（T5 步骤 3，侧栏 / 全局搜索 / 会话头共用一份解析）：
   * `peerPrincipalIds` 排除自己后取名册成员；没有对端 = 自我会话——标题用
   * 自己的服务端显示名（2026-11：与真人条目一致，不再写死「我」；没有成员卡
   * 时才回落「我」文案）。对端不在名册（已禁用 / 名册未到）回落主体 id，标题
   * 不为空。非团队上下文（member 为 null、名册为空）下 dm 会话本就不存在；
   * 真被调用时单成员的 peerPrincipalIds 会解析成自我会话，无害。
   */
  dmPeerView(peerPrincipalIds: readonly string[] | null | undefined): {
    /** 标题：对端成员显示名（快照回落名册 / 主体 id）；自我会话 = 自己的显示名。 */
    title: string;
    /** 对端主体 id；自我会话为 null。 */
    peerId: string | null;
    avatar: string | null;
    state: TeamMemberState;
  } {
    const peerId = (peerPrincipalIds ?? []).find((id) => id !== this.member?.id) ?? null;
    if (peerId === null) {
      return {
        title: this.member?.displayName || t('team.selfConversation'),
        peerId: null,
        avatar: this.member?.avatar ?? null,
        state: this.member?.state ?? 'offline',
      };
    }
    const peer = this.memberById(peerId);
    return {
      title: peer?.displayName || peerId,
      peerId,
      avatar: peer?.avatar ?? null,
      state: peer?.state ?? 'offline',
    };
  }
}

export const teamContext = new TeamContextState();
