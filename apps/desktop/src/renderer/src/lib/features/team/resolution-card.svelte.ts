import {
  resolutionCardSchema,
  type ResolutionCardData,
  type ResolutionSnapshotMember,
} from '@kepcup/shared';
import { connections, type SourceId } from '$lib/rpc/connections.svelte';

/**
 * 决议卡的决策逻辑层（T9，62.09 §5）——与 DOM 无关，供 ResolutionCard.svelte
 * 与无 mount 测试共用（同 T8 cache-sync 的决策逻辑级测试口径）：
 *
 * - `resolutionCardDataOf`：从 cardType 'resolution' 的宿主卡消息解析载荷
 *   （shared resolutionCardSchema 校验；不合法 = null，调用方按普通卡片兜底）。
 * - `ResolutionCardState`：签署状态派生（本人签的是当前版本 / 待重签 / 未签）、
 *   按钮显隐（本人 ∈ 快照才可签；项目负责人 = `team.projects.roster` 的
 *   leadMemberId）、动作（approve 带 version / revoke / withdraw）与 stale 错误
 *   归类（RESOLUTION_STALE → 提示刷新；卡片本体随 `message.updated` 收敛）。
 */

/** 从一条消息解析决议卡载荷；非决议卡或载荷不合法 = null。 */
export function resolutionCardDataOf(content: unknown): ResolutionCardData | null {
  if (typeof content !== 'object' || content === null) return null;
  const card = content as { cardType?: unknown; hostCard?: { data?: unknown } };
  if (card.cardType !== 'resolution') return null;
  const data = card.hostCard?.data;
  const parsed = resolutionCardSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export type ResolutionActionErrorCode =
  | 'RESOLUTION_STALE'
  | 'RESOLUTION_LOCKED'
  | 'NOT_PROJECT_LEAD'
  | 'OTHER';

/** 快照成员的签署呈现（头像 + 勾 / 待重签 / 未签）。 */
export function signatureStateOf(
  member: ResolutionSnapshotMember,
  version: number,
): 'signed' | 'stale' | 'unsigned' {
  if (member.approvedVersion === null) return 'unsigned';
  return member.approvedVersion === version ? 'signed' : 'stale';
}

export class ResolutionCardState {
  /** 当前消息解析出的载荷（message.updated 就地刷新后由调用方重新喂入）。 */
  data = $state<ResolutionCardData | null>(null);
  /** 项目负责人（`team.projects.roster` 的 leadMemberId）；null = 未知 / 离线（作废按钮隐藏）。 */
  leadMemberId = $state<string | null>(null);
  busy = $state(false);
  /** 最近一次动作的机器错误码（组件用 errorText 映射文案；卡片随事件收敛）。 */
  lastError = $state<ResolutionActionErrorCode | null>(null);

  readonly #source: SourceId;
  readonly #conversationId: string;

  constructor(input: { source: SourceId; conversationId: string }) {
    this.#source = input.source;
    this.#conversationId = input.conversationId;
  }

  get conversationId(): string {
    return this.#conversationId;
  }

  get selfMemberId(): string | null {
    return connections.get(this.#source).memberId;
  }

  /** 把一条（新）消息喂进状态：载荷就地刷新（message.updated 收敛路径）。 */
  applyMessage(content: unknown): void {
    this.data = resolutionCardDataOf(content);
  }

  /** 本人当前版本的签署（null = 未签 / 不在快照）。 */
  get myApprovedVersion(): number | null {
    const data = this.data;
    if (data === null) return null;
    const self = this.selfMemberId;
    if (self === null) return null;
    return data.snapshot.find((member) => member.memberId === self)?.approvedVersion ?? null;
  }

  /** 本人是否在快照内（可签人群）。 */
  get inSnapshot(): boolean {
    const data = this.data;
    const self = this.selfMemberId;
    if (data === null || self === null) return false;
    return data.snapshot.some((member) => member.memberId === self);
  }

  /** 本人「通过决议」：讨论中 + 在快照 + 未签当前版本。 */
  get canApprove(): boolean {
    const data = this.data;
    return data !== null && data.state === 'open' && this.inSnapshot && this.myApprovedVersion !== data.version;
  }

  /** 本人「撤回签署」：讨论中 + 在快照 + 已签当前版本（62.09 §2 直到通过）。 */
  get canRevoke(): boolean {
    const data = this.data;
    return data !== null && data.state === 'open' && this.inSnapshot && this.myApprovedVersion === data.version;
  }

  /** 项目负责人「作废」：讨论中 + 本人确认是负责人（roster 读到才显示）。 */
  get canWithdraw(): boolean {
    const data = this.data;
    return (
      data !== null &&
      data.state === 'open' &&
      this.leadMemberId !== null &&
      this.leadMemberId === this.selfMemberId
    );
  }

  /** 拉一次实时名册取 leadMemberId（失败 / 离线 = 保持 null，按钮隐藏）。 */
  async loadLead(): Promise<void> {
    if (connections.get(this.#source).status !== 'connected') {
      this.leadMemberId = null;
      return;
    }
    try {
      const result = (await connections.get(this.#source).call('team.projects.roster', {
        conversationId: this.#conversationId,
      })) as { leadMemberId?: string | null };
      this.leadMemberId = result.leadMemberId ?? null;
    } catch {
      this.leadMemberId = null;
    }
  }

  #errorOf(error: unknown): ResolutionActionErrorCode {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === 'RESOLUTION_STALE' || code === 'RESOLUTION_LOCKED' || code === 'NOT_PROJECT_LEAD') {
      return code;
    }
    return 'OTHER';
  }

  /** 「通过决议」（带当前版本号调用——版本不符服务器 RESOLUTION_STALE 拒）。 */
  async approve(): Promise<boolean> {
    const data = this.data;
    if (data === null || this.busy) return false;
    this.busy = true;
    this.lastError = null;
    try {
      await connections.get(this.#source).call('team.resolutions.approve', {
        resolutionId: data.resolutionId,
        version: data.version,
      });
      return true;
    } catch (error) {
      this.lastError = this.#errorOf(error);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** 「撤回签署」（直到通过）。 */
  async revoke(): Promise<boolean> {
    const data = this.data;
    if (data === null || this.busy) return false;
    this.busy = true;
    this.lastError = null;
    try {
      await connections.get(this.#source).call('team.resolutions.revoke', {
        resolutionId: data.resolutionId,
      });
      return true;
    } catch (error) {
      this.lastError = this.#errorOf(error);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** 项目负责人「作废」（带原因；passed 后 RESOLUTION_LOCKED）。 */
  async withdraw(): Promise<boolean> {
    const data = this.data;
    if (data === null || this.busy) return false;
    this.busy = true;
    this.lastError = null;
    try {
      await connections.get(this.#source).call('team.resolutions.withdraw', {
        resolutionId: data.resolutionId,
      });
      return true;
    } catch (error) {
      this.lastError = this.#errorOf(error);
      return false;
    } finally {
      this.busy = false;
    }
  }
}
