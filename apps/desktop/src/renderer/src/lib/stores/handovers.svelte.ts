import type { HandoverView } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * Bot 资产移交（D88）的执行进度缓存：移交卡确认后按 approvalId 读执行视图
 * （`handovers.get`），`handover.updated` 推送逐项重绘（进行中 → 完成 / 部分未完成 /
 * 失败）。懒启动：第一张移交卡出现时才订阅。
 */
class HandoversState {
  byApproval = $state<Record<string, HandoverView>>({});
  #started = false;
  #loading = new Set<string>();

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('handover.updated', (payload) => {
      const { handover } = payload as { handover: HandoverView };
      if (handover.approvalId === null) return;
      this.byApproval = { ...this.byApproval, [handover.approvalId]: handover };
    });
  }

  /** Loads a handover's progress once (cards mount lazily while scrolling history). */
  async ensure(approvalId: string): Promise<void> {
    this.start();
    if (approvalId.length === 0 || this.#loading.has(approvalId)) return;
    this.#loading.add(approvalId);
    try {
      const result = (await core.call('handovers.get', { approvalId })) as {
        handover: HandoverView | null;
      };
      // A pushed update may have arrived meanwhile: keep the newer one.
      const current = this.byApproval[approvalId];
      if (
        result.handover !== null &&
        (current === undefined || current.updatedAt <= result.handover.updatedAt)
      ) {
        this.byApproval = { ...this.byApproval, [approvalId]: result.handover };
      }
    } catch {
      // The card falls back to the approval status.
    } finally {
      this.#loading.delete(approvalId);
    }
  }
}

export const handovers = new HandoversState();
