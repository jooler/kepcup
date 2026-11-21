import { connections, type SourceId } from '$lib/rpc/connections.svelte';

/**
 * 项目组人类成员面板的逻辑层（T7 步骤 5，62.04 §4 / 62.09 §1）：
 *
 * - 名册数据源（在线）：`team.projects.roster`（T7 名册增量读口）——C15 名册行
 *   的实时读数，成员卡 + `role`（负责人），「新建项目组尚无人发言」「刚加人」
 *   的场景立即可见；加人 / 移出 / 转交成功后就地刷新。
 * - 名册兜底（离线 / 旧服务器无该读口）：`deriveHumanRoster` 从会话消息的
 *   `senderPrincipalId` / `senderName` 快照推导（没发过言的成员不可见——这正是
 *   实时读口要补的洞，兜底只保证面板不空转）。
 * - 负责人判定：实时读口给 `leadMemberId` / `role`；动作仍按乐观渲染，服务器对
 *   非负责人返回 `NOT_PROJECT_LEAD` 时转只读（本会话内缓存该判定）。
 */

export interface HumanRosterEntry {
  memberId: string;
  /** 发言时的显示名快照；没发过言的成员回落名册 / 主体 id。 */
  name: string;
}

/** 面板渲染条目（实时读口与离线推导统一成同一形状）。 */
export interface ProjectRosterEntry {
  memberId: string;
  name: string;
  state: 'online' | 'away' | 'offline';
  avatar: string | null;
  /** 实时读口给出；离线推导未知（按普通成员渲染，负责人判定仍由服务器把关）。 */
  role: 'lead' | 'member';
  isSelf: boolean;
}

export interface ProjectRosterSnapshot {
  members: ProjectRosterEntry[];
  leadMemberId: string | null;
}

/** 从会话消息推导人类名册（纯函数）：用户消息的发送主体 + 自己。 */
export function deriveHumanRoster(
  messages: ReadonlyArray<{
    senderType: string;
    senderPrincipalId?: string | null;
    senderName?: string | null;
  }>,
  selfMemberId: string | null,
): HumanRosterEntry[] {
  // Plain Map: 纯函数内的临时归集，不是 UI 状态。
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const byId = new Map<string, HumanRosterEntry>();
  if (selfMemberId !== null) byId.set(selfMemberId, { memberId: selfMemberId, name: '' });
  for (const message of messages) {
    if (message.senderType !== 'user') continue;
    const principalId = message.senderPrincipalId;
    if (principalId === null || principalId === undefined || principalId.length === 0) continue;
    const name = message.senderName ?? '';
    const existing = byId.get(principalId);
    if (existing === undefined) {
      byId.set(principalId, { memberId: principalId, name });
    } else if (existing.name.length === 0 && name.length > 0) {
      byId.set(principalId, { memberId: principalId, name });
    }
  }
  return [...byId.values()];
}

/** 面板动作的错误归类（乐观渲染 → 服务器拒绝时收敛只读）。 */
export type MembersActionError = 'NOT_PROJECT_LEAD' | 'OTHER';

function errorCodeOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

/**
 * 一个项目会话的成员面板状态：加人 / 移出 / 转交负责人；非负责人（服务器以
 * `NOT_PROJECT_LEAD` 拒绝后）只读。调用走会话来源的团队连接。
 */
export class ProjectMembersPanelState {
  /** 本会话内已确认「我不是负责人」（服务器拒绝后置位，面板转只读）。 */
  readonlyOnly = $state(false);
  busy = $state(false);
  lastError = $state<MembersActionError | null>(null);
  /** `team.projects.roster` 实时读数；null = 未加载 / 离线（面板回落消息推导）。 */
  roster = $state<ProjectRosterSnapshot | null>(null);

  readonly #source: SourceId;
  readonly #conversationId: string;

  constructor(input: { source: SourceId; conversationId: string }) {
    this.#source = input.source;
    this.#conversationId = input.conversationId;
  }

  #call(method: string, input: unknown): Promise<unknown> {
    return connections.get(this.#source).call(method, input);
  }

  /** 拉实时名册（在线）；失败 / 离线回落 null（面板用消息推导兜底）。 */
  async loadRoster(): Promise<void> {
    if (connections.get(this.#source).status !== 'connected') {
      this.roster = null;
      return;
    }
    try {
      const result = (await this.#call('team.projects.roster', {
        conversationId: this.#conversationId,
      })) as {
        members: Array<{
          id: string;
          displayName: string;
          avatar?: string | null;
          state: string;
          role: string;
        }>;
        leadMemberId: string | null;
      };
      const selfMemberId = connections.get(this.#source).memberId;
      this.roster = {
        leadMemberId: result.leadMemberId,
        members: result.members.map((entry) => ({
          memberId: entry.id,
          name: entry.displayName.length > 0 ? entry.displayName : entry.id,
          state: entry.state === 'away' ? 'away' : entry.state === 'online' ? 'online' : 'offline',
          avatar: entry.avatar ?? null,
          role: entry.role === 'lead' ? 'lead' : 'member',
          isSelf: entry.id === selfMemberId,
        })),
      };
    } catch {
      // 旧服务器没有该读口 / 瞬时错误：清空占位，离线推导兜底。
      this.roster = null;
    }
  }

  /** 加人（从团队成员挑选；调用方保证非空、去重）。 */
  async addMembers(memberIds: string[]): Promise<boolean> {
    if (this.readonlyOnly || memberIds.length === 0) return false;
    this.busy = true;
    this.lastError = null;
    try {
      await this.#call('team.projects.addMembers', {
        conversationId: this.#conversationId,
        memberIds,
      });
      void this.loadRoster();
      return true;
    } catch (error) {
      this.#applyError(errorCodeOf(error));
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** 移出人类成员（负责人）。 */
  async removeMember(memberId: string): Promise<boolean> {
    if (this.readonlyOnly) return false;
    this.busy = true;
    this.lastError = null;
    try {
      await this.#call('team.projects.removeMember', {
        conversationId: this.#conversationId,
        memberId,
      });
      void this.loadRoster();
      return true;
    } catch (error) {
      this.#applyError(errorCodeOf(error));
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** 转交负责人（真人负责人，62.09 §1）。 */
  async transferLead(memberId: string): Promise<boolean> {
    if (this.readonlyOnly) return false;
    this.busy = true;
    this.lastError = null;
    try {
      await this.#call('team.projects.transferLead', {
        conversationId: this.#conversationId,
        memberId,
      });
      void this.loadRoster();
      return true;
    } catch (error) {
      this.#applyError(errorCodeOf(error));
      return false;
    } finally {
      this.busy = false;
    }
  }

  #applyError(code: string | undefined): void {
    if (code === 'NOT_PROJECT_LEAD') {
      this.readonlyOnly = true;
      this.lastError = 'NOT_PROJECT_LEAD';
      return;
    }
    this.lastError = 'OTHER';
  }
}
