import type {
  Approval,
  EffectStatus,
  Grant,
  Run,
  SandboxStatusOutput,
  UnattendedState,
} from '@kepcup/shared';
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { toast } from 'svelte-sonner';
import { mergeApprovalUpdate } from '$lib/features/approvals/approval-effect';

export type { Approval, Grant };

/** One auto-approval in the unattended summary (W4: with its ledger outcome). */
export interface UnattendedSummaryEntry {
  approvalId: string;
  kind: string;
  conversationId: string | null;
  botId: string | null;
  detail: string;
  createdAt: number;
  effectStatus?: EffectStatus;
}

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
  summaryItems = $state<Array<UnattendedSummaryEntry>>([]);
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
      this.#upsert(data.approval);
      this.#recount(data.approval.conversationId);
    });
    core.onEvent('approval.resolved', (payload) => {
      const data = payload as { conversationId: string | null; approval: Approval };
      this.#upsert(data.approval);
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
    // W3（D78）: a revocation (grants list, MCP settings, a bot's MCP selection)
    // interrupted running tasks — said right where the user just revoked.
    core.onEvent('tasks.interrupted', (payload) => {
      const data = payload as { count: number };
      if (data.count > 0) toast.warning(t('task.interruptedByRevoke', { count: data.count }));
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

  /** Refetches one conversation's approvals (W4: after an APPROVAL_STALE refusal). */
  async #reloadApprovals(conversationId: string): Promise<void> {
    try {
      const result = (await core.call('approvals.list', { conversationId })) as {
        approvals: Approval[];
      };
      const next: Record<string, Approval> = { ...this.approvals };
      for (const approval of result.approvals) next[approval.id] = approval;
      this.approvals = next;
      this.#recount(conversationId);
    } catch {
      // The toast already said it; the next event / conversation switch refreshes.
    }
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
    /**
     * W4: the payloadHash of the approval the card rendered — core refuses the
     * decision (APPROVAL_STALE) when the approval no longer matches it.
     */
    payloadHash?: string,
  ): Promise<void> {
    try {
      const result = (await core.call('approvals.decide', {
        id: approvalId,
        approve,
        ...(duration !== undefined ? { duration } : {}),
        ...(selection !== undefined ? { selection } : {}),
        ...(payloadHash !== undefined ? { payloadHash } : {}),
      })) as { approval: Approval };
      this.#upsert(result.approval);
      this.#recount(result.approval.conversationId);
    } catch (error) {
      const code = codeOf(error);
      toast.error(errorText(code, t('chats.errorCode.INTERNAL')));
      // W4: a stale card — reload the conversation's approvals so the card
      // shows what the user is actually deciding on.
      const conversationId = this.approvals[approvalId]?.conversationId ?? null;
      if (code === 'APPROVAL_STALE' && conversationId !== null) {
        void this.#reloadApprovals(conversationId);
      }
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

  async unattendedSummary(since?: number): Promise<Array<UnattendedSummaryEntry>> {
    const result = (await core.call('unattended.summary', since !== undefined ? { since } : {})) as {
      items: Array<UnattendedSummaryEntry>;
    };
    return result.items;
  }

  /** W4 复查: an older copy (decide result) never downgrades a settled receipt. */
  #upsert(approval: Approval): void {
    this.approvals = {
      ...this.approvals,
      [approval.id]: mergeApprovalUpdate(this.approvals[approval.id], approval),
    };
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
