import type {
  Approval,
  Grant,
  Run,
  SandboxStatusOutput,
  UnattendedState,
} from '@kepcup/shared';
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { toast } from 'svelte-sonner';

export type { Approval, Grant };

/**
 * P03 client state: approvals (cards), grants (right panel), unattended mode
 * (banner / settings), sandbox status (confirm-mode banner). Updated purely
 * from core events; lists refetch on conversation switch.
 */
class PermissionsState {
  /** All known approvals by id (cards render from this). */
  approvals = $state<Record<string, Approval>>({});
  /** Pending approval count per conversation (sidebar marker). */
  pendingByConversation = $state<Record<string, number>>({});
  /** Active grants of the current conversation (right panel). */
  grants = $state<Grant[]>([]);
  unattended = $state<UnattendedState>({ enabled: false, until: null, enabledAt: null });
  sandbox = $state<SandboxStatusOutput | null>(null);
  /** Auto-approval summary of the last unattended period (dialog content). */
  summaryOpen = $state(false);
  summaryItems = $state<
    Array<{ approvalId: string; kind: string; conversationId: string | null; botId: string | null; detail: string; createdAt: number }>
  >([]);
  /** Auto-approvals already surfaced to the user (focus reminder). */
  #seenAutoApprovals = 0;
  /** Conversation the grants list currently mirrors. */
  #currentConversationId: string | null = null;
  /** Loaded once per boot for the banner; refreshed on unattended.changed. */
  #started = false;

  pendingOf(conversationId: string | null | undefined): Approval[] {
    if (!conversationId) return [];
    return Object.values(this.approvals).filter(
      (a) => a.conversationId === conversationId && a.status === 'pending',
    );
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('approval.created', (payload) => {
      const data = payload as { conversationId: string | null; approval: Approval };
      this.approvals = { ...this.approvals, [data.approval.id]: data.approval };
      this.#recount(data.approval.conversationId);
    });
    core.onEvent('approval.resolved', (payload) => {
      const data = payload as { conversationId: string | null; approval: Approval };
      this.approvals = { ...this.approvals, [data.approval.id]: data.approval };
      this.#recount(data.approval.conversationId);
    });
    core.onEvent('grant.changed', (payload) => {
      const data = payload as { conversationId: string; grants: Grant[] };
      if (data.conversationId === this.#currentConversationId) this.grants = data.grants;
    });
    core.onEvent('unattended.changed', (payload) => {
      const data = payload as { state: UnattendedState };
      this.unattended = data.state;
    });
  }

  /** Loads pending approvals + grants + sandbox state for a conversation. */
  async loadForConversation(conversationId: string): Promise<void> {
    this.#currentConversationId = conversationId;
    const [approvalsResult, grantsResult] = await Promise.all([
      core.call('approvals.list', { conversationId }) as Promise<{ approvals: Approval[] }>,
      core.call('grants.list', { conversationId }) as Promise<{ grants: Grant[] }>,
    ]);
    const next: Record<string, Approval> = { ...this.approvals };
    for (const approval of approvalsResult.approvals) next[approval.id] = approval;
    this.approvals = next;
    this.grants = grantsResult.grants;
    this.#recount(conversationId);
  }

  async refreshSandbox(probe = false): Promise<void> {
    try {
      this.sandbox = (await core.call('sandbox.status', { probe })) as SandboxStatusOutput;
    } catch {
      // Leave the last known state; the settings page shows its own errors.
    }
  }

  async refreshUnattended(): Promise<void> {
    this.unattended = (await core.call('unattended.get')) as UnattendedState;
  }

  async decide(
    approvalId: string,
    approve: boolean,
    duration?: 'once' | 'conversation',
    /** butler_proposal only (D70): indexes of the proposed bots the user kept. */
    selection?: number[],
  ): Promise<void> {
    try {
      const result = (await core.call('approvals.decide', {
        id: approvalId,
        approve,
        ...(duration !== undefined ? { duration } : {}),
        ...(selection !== undefined ? { selection } : {}),
      })) as { approval: Approval };
      this.approvals = { ...this.approvals, [approvalId]: result.approval };
      this.#recount(result.approval.conversationId);
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
    }
  }

  async revokeGrant(grantId: string): Promise<void> {
    try {
      await core.call('grants.revoke', { id: grantId });
      this.grants = this.grants.filter((g) => g.id !== grantId);
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
    }
  }

  async enableUnattended(hours: number | null): Promise<boolean> {
    try {
      this.unattended = (await core.call('unattended.enable', {
        hours,
        acknowledgeRisk: true,
      })) as UnattendedState;
      return true;
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  async disableUnattended(): Promise<void> {
    const enabledAt = this.unattended.enabledAt;
    try {
      this.unattended = (await core.call('unattended.disable')) as UnattendedState;
    } catch (error) {
      toast.error(errorText(codeOf(error), t('chats.errorCode.INTERNAL')));
      return;
    }
    // 关闭时弹出自动批准汇总（docs/dev/phases/P03-permissions.md 任务 8）。
    await this.#showSummary(enabledAt);
  }

  /**
   * 用户回到窗口且模式期间有新的自动批准记录时提醒（任务 8）。模式关闭后
   * 不再提示（关闭时已经弹过一次）。
   */
  async remindOnFocus(): Promise<void> {
    if (!this.unattended.enabled || this.unattended.enabledAt === null) return;
    await this.#showSummary(this.unattended.enabledAt);
  }

  async #showSummary(since: number | null): Promise<void> {
    try {
      this.summaryItems = since !== null ? await this.unattendedSummary(since) : [];
    } catch {
      this.summaryItems = [];
    }
    this.#seenAutoApprovals = this.summaryItems.length;
    this.summaryOpen = true;
  }

  /** Focus hook entry: true when unseen auto-approvals exist. */
  async hasUnseenAutoApprovals(): Promise<boolean> {
    if (!this.unattended.enabled || this.unattended.enabledAt === null) return false;
    const items = await this.unattendedSummary(this.unattended.enabledAt);
    return items.length > this.#seenAutoApprovals;
  }

  async unattendedSummary(since?: number): Promise<
    Array<{ approvalId: string; kind: string; conversationId: string | null; botId: string | null; detail: string; createdAt: number }>
  > {
    const result = (await core.call('unattended.summary', since !== undefined ? { since } : {})) as {
      items: Array<{ approvalId: string; kind: string; conversationId: string | null; botId: string | null; detail: string; createdAt: number }>;
    };
    return result.items;
  }

  #recount(conversationId: string | null): void {
    if (conversationId === null) return;
    const count = Object.values(this.approvals).filter(
      (a) => a.conversationId === conversationId && a.status === 'pending',
    ).length;
    this.pendingByConversation = {
      ...this.pendingByConversation,
      [conversationId]: count,
    };
  }
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

export const permissions = new PermissionsState();

/** True for run statuses that count as "active" for sidebar markers. */
export function isActiveStatus(status: Run['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting_approval' || status === 'waiting_lease';
}
