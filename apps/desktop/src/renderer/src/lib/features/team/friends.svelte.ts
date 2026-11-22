import type { TeamFriendRequestView, TeamMember } from '@kepcup/shared';
import { toast } from 'svelte-sonner';
import { t } from '$lib/i18n';
import { shell } from '$lib/stores/shell.svelte';
import { connections, serverHashOf, teamSourceId, type SourceId } from '$lib/rpc/connections.svelte';

/**
 * 好友层客户端状态（62.04 D129v2）：每个团队来源一份切片（web 团队端点 =
 * `local`；桌面融合 = `team:<serverHash>`），持好友卡 / 待处理申请 / 我拉黑的
 * 成员。数据经 `team.friends.list` 拉取；`friend.*` 事件到达即重拉（载荷含申请
 * 视图，但列表面小、重拉最省心智——不本地拼装，与服务端单一事实来源收敛）；
 * blocked / unblocked 事件只发操作者本人，多标签页据此同步拉黑名单（2026-11）。
 *
 * `local` 来源在桌面（非团队）也存在：team.* 方法在个人版 core 不存在，刷新
 * 静默失败、切片保持空骨架（通讯录好友栏只在团队上下文渲染，无 UI 影响）。
 */

export interface FriendsSlice {
  serverHash: string;
  connected: boolean;
  friends: TeamMember[];
  incoming: TeamFriendRequestView[];
  outgoing: TeamFriendRequestView[];
  /** 我拉黑的成员（2026-11；通讯录「已拉黑」小节的数据源）。 */
  blocked: TeamMember[];
}

function emptySlice(serverHash: string): FriendsSlice {
  return { serverHash, connected: false, friends: [], incoming: [], outgoing: [], blocked: [] };
}

/**
 * 是否可向该成员发起好友申请（2026-11，加好友弹框与通讯录搜索行共用）：以
 * friends 切片为准——已有 pending outgoing 或已是好友则不可；对方拒绝 / 接受 /
 * 移除后 friend.* 事件 → refresh → 判定自动恢复（切片开着也实时生效），不依赖
 * 各入口的本地已申请标记（那份标记与服务端终态脱钩，拒绝后按钮永不解除）。
 * 切片未就绪（null）不设限，不因数据未到而误禁入口。
 */
export function canRequestFriend(slice: FriendsSlice | null, memberId: string): boolean {
  if (slice === null) return true;
  return (
    !slice.outgoing.some((request) => request.to.id === memberId) &&
    !slice.friends.some((friend) => friend.id === memberId)
  );
}

/** 好友申请通知的停留时长：1 分钟（仅此 toast，不改全局 Toaster）。 */
const FRIEND_REQUEST_TOAST_DURATION_MS = 60_000;

class FriendsState {
  slices = $state<Record<string, FriendsSlice>>({});
  #started = false;
  /** 已接线的连接实例（按实例而非来源键：断开重连换新连接对象）。 */
  readonly #wired = new Set<object>();
  readonly #unsubscribers: Array<() => void> = [];
  /**
   * 已弹过通知的申请 id（2026-11）：并发 refresh（如 friend.requested 与其他
   * 触发源同时到达）会在对方切片写入前完成 diff，各自视同一申请为新——弹前
   * 在此查重、弹后登记，保证一个申请只弹一次。类是单例，天然跨切片 / 跨触发
   * 源共享；量极小无需清理（拒绝后再申请是新 id，仍正常弹）。
   */
  readonly #toastedRequestIds = new Set<string>();

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribers.push(connections.onSourcesChanged(() => this.#wire()));
    this.#wire();
  }

  /** 来源（'local' | `team:<hash>`）→ 切片键（'local' | serverHash）。 */
  #keyOf(source: SourceId): string | null {
    if (source === 'local') return 'local';
    return serverHashOf(source);
  }

  #sourceOf(key: string): SourceId {
    return key === 'local' ? 'local' : teamSourceId(key);
  }

  sliceOf(source: SourceId): FriendsSlice | null {
    const key = this.#keyOf(source);
    return key === null ? null : (this.slices[key] ?? null);
  }

  #wire(): void {
    for (const source of connections.sources()) {
      const key = this.#keyOf(source);
      if (key === null) continue;
      const conn = connections.get(source);
      if (this.#wired.has(conn)) continue;
      this.#wired.add(conn);
      this.#unsubscribers.push(conn.onConnected(() => void this.refresh(key)));
      // 好友面小：三类申请事件 + 移除事件都直接重拉收敛。
      this.#unsubscribers.push(
        conn.onTeamEvent('friend.requested', () => void this.refresh(key)),
      );
      this.#unsubscribers.push(conn.onTeamEvent('friend.accepted', () => void this.refresh(key)));
      this.#unsubscribers.push(conn.onTeamEvent('friend.declined', () => void this.refresh(key)));
      this.#unsubscribers.push(conn.onTeamEvent('friend.removed', () => void this.refresh(key)));
      // 拉黑 / 解除拉黑只发给操作者本人（2026-11）：同成员的其它标签页据此同步。
      this.#unsubscribers.push(conn.onTeamEvent('friend.blocked', () => void this.refresh(key)));
      this.#unsubscribers.push(conn.onTeamEvent('friend.unblocked', () => void this.refresh(key)));
      // 好友卡的在线态随名册事件本地收敛（member.presenceChanged 载荷带三态）。
      this.#unsubscribers.push(
        conn.onTeamEvent('member.presenceChanged', (payload) =>
          this.#patchPresence(key, payload as { memberId: string; state: TeamMember['state'] }),
        ),
      );
      if (conn.status === 'connected') void this.refresh(key);
    }
    // 来源被移除（服务器移除 / web 端点离开）：丢切片。
    for (const key of Object.keys(this.slices)) {
      if (!connections.sources().includes(this.#sourceOf(key))) {
        const next = { ...this.slices };
        delete next[key];
        this.slices = next;
      }
    }
  }

  async refresh(key: string): Promise<void> {
    try {
      const result = (await connections
        .get(this.#sourceOf(key))
        .callTeam('team.friends.list')) as {
        friends: TeamMember[];
        incoming: TeamFriendRequestView[];
        outgoing: TeamFriendRequestView[];
        blocked: TeamMember[];
      };
      // 新好友申请弹通知（2026-11）：与上一次切片的 incoming diff，没见过的
      // 申请 id 弹 toast（申请消息做副文，「去处理」跳通讯录，「忽略」收通知，
      // 条目留在通讯录）。停留 1 分钟；首拉与断线重连后的第一次拉取
      //（previous.connected !== true）不弹——避免启动 / 重连时对存量申请轰炸；
      // 存量申请仍由通讯录列表兜底。
      const previous = this.slices[key];
      if (previous?.connected === true) {
        const known = new Set(previous.incoming.map((request) => request.id));
        for (const request of result.incoming) {
          if (known.has(request.id)) continue;
          // 并发 refresh 去重：同一申请在切片写入前被两次 diff 各自视为新时，
          // 只有第一次到这里能通过（弹后即登记），第二次直接跳过。
          if (this.#toastedRequestIds.has(request.id)) continue;
          // svelte-sonner 只支持单个 action（无 actions 数组）：「去处理」走
          // action，忽略走 cancel 槽（两者点击后组件都会自动关 toast；
          // 忽略再显式 dismiss 一次，兜住 dismissible 关闭时的路径）。
          const toastId = toast.info(t('friends.requestReceived', { name: request.from.displayName }), {
            ...(request.message !== undefined && request.message.length > 0
              ? { description: request.message }
              : {}),
            duration: FRIEND_REQUEST_TOAST_DURATION_MS,
            action: {
              label: t('friends.openContacts'),
              onClick: () => shell.openSettings('contacts'),
            },
            cancel: {
              label: t('friends.ignore'),
              onClick: () => toast.dismiss(toastId),
            },
          });
          this.#toastedRequestIds.add(request.id);
        }
      }
      this.slices = {
        ...this.slices,
        [key]: { serverHash: key, connected: true, ...result },
      };
    } catch {
      // 个人版 core（无团队层）/ 断线：保持空骨架，不伪造数据。
      this.slices = { ...this.slices, [key]: emptySlice(key) };
    }
  }

  #patchPresence(key: string, payload: { memberId: string; state: TeamMember['state'] }): void {
    const slice = this.slices[key];
    if (!slice) return;
    const patch = (member: TeamMember): TeamMember =>
      member.id === payload.memberId ? { ...member, state: payload.state } : member;
    this.slices[key] = {
      ...slice,
      friends: slice.friends.map(patch),
      incoming: slice.incoming.map((request) => ({ ...request, from: patch(request.from), to: patch(request.to) })),
      outgoing: slice.outgoing.map((request) => ({ ...request, from: patch(request.from), to: patch(request.to) })),
    };
  }

  /** `team.members.search`（加好友 / 找成员）。失败（无团队层 / 断线）回空。 */
  async search(source: SourceId, query: string): Promise<TeamMember[]> {
    try {
      const result = (await connections.get(source).callTeam('team.members.search', {
        query,
      })) as { members: TeamMember[] };
      return result.members;
    } catch {
      return [];
    }
  }

  async request(source: SourceId, username: string, message?: string): Promise<void> {
    await connections
      .get(source)
      .callTeam('team.friends.request', message === undefined ? { username } : { username, message });
    // 发送成功后立即重拉（2026-11）：outgoing 以服务端 pending 为单一切片
    // 数据源，加好友弹框据此禁用「加好友」按钮；对方拒绝 / 接受 / 移除后
    // friend.* 事件 → refresh → 按钮自动恢复，不再依赖弹框本地已申请标记。
    const key = this.#keyOf(source);
    if (key !== null) void this.refresh(key);
  }

  async accept(source: SourceId, requestId: string): Promise<void> {
    await connections.get(source).callTeam('team.friends.accept', { requestId });
  }

  async decline(source: SourceId, requestId: string): Promise<void> {
    await connections.get(source).callTeam('team.friends.decline', { requestId });
  }

  async cancel(source: SourceId, requestId: string): Promise<void> {
    await connections.get(source).callTeam('team.friends.cancel', { requestId });
  }

  async remove(source: SourceId, memberId: string): Promise<void> {
    await connections.get(source).callTeam('team.friends.remove', { memberId });
  }

  /** 拉黑成员（2026-11）：好友关系与待处理申请随服务端一并解除。 */
  async block(source: SourceId, memberId: string): Promise<void> {
    await connections.get(source).callTeam('team.friends.block', { memberId });
  }

  /** 解除拉黑。 */
  async unblock(source: SourceId, memberId: string): Promise<void> {
    await connections.get(source).callTeam('team.friends.unblock', { memberId });
  }
}

export const friends = new FriendsState();
