import type { Delegation } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * 跨 Bot 委派（D71）的渲染端缓存：A 侧的发出卡 / 结果卡按 delegationId
 * 读委派行，`delegation.updated` 推送实时重绘（排队 → 处理中 → 完成 / 失败 /
 * 取消）。懒启动：第一张委派卡出现时才订阅。
 */
class DelegationsState {
  byId = $state<Record<string, Delegation>>({});
  #started = false;
  #loading = new Set<string>();

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('delegation.updated', (payload) => {
      const { delegation } = payload as { delegation: Delegation };
      this.byId = { ...this.byId, [delegation.id]: delegation };
    });
  }

  /** Loads a delegation once (cards mount lazily while scrolling history). */
  async ensure(id: string): Promise<void> {
    this.start();
    if (id.length === 0 || this.byId[id] !== undefined || this.#loading.has(id)) return;
    this.#loading.add(id);
    try {
      const result = (await core.call('delegations.get', { id })) as {
        delegation: Delegation | null;
      };
      if (result.delegation !== null) {
        this.byId = { ...this.byId, [id]: result.delegation };
      }
    } catch {
      // Card falls back to its placeholder.
    } finally {
      this.#loading.delete(id);
    }
  }

  async cancel(id: string): Promise<void> {
    const result = (await core.call('delegations.cancel', { id })) as {
      delegation: Delegation | null;
    };
    if (result.delegation !== null) {
      this.byId = { ...this.byId, [id]: result.delegation };
    }
  }
}

export const delegations = new DelegationsState();
