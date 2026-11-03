import type { Delegation } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * 跨 Bot 委派（D71 v2 / D113）的渲染端缓存：双方用户对话里的药丸卡按
 * delegationId 读委派行，`delegation.updated` 推送实时重绘（排队 → 处理中 →
 * 完成 / 失败 / 取消）。懒启动：第一枚药丸出现时才订阅。药丸点击打开
 * `openDetailId` 指向的交换会话详情视图（ChatsArea 整区替换，同任务详情页
 * 范式）；切换会话时由 `chat.select` 关闭。
 */
class DelegationsState {
  byId = $state<Record<string, Delegation>>({});
  /** 当前打开详情视图的委派 id（null = 关闭）。 */
  openDetailId = $state<string | null>(null);
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

  /** Loads a delegation once (pills mount lazily while scrolling history). */
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
      // Pill falls back to its placeholder.
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

  /** Opens the exchange-conversation detail view for this delegation. */
  openDetail(id: string): void {
    this.start();
    void this.ensure(id);
    this.openDetailId = id;
  }

  closeDetail(): void {
    this.openDetailId = null;
  }
}

export const delegations = new DelegationsState();
