import type { WatchEntry } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * 确定性监看（W7）的渲染端缓存：对话里的监看卡按 watchId 读监看行，
 * `watch.updated` 推送实时重绘（检查结果、提醒、暂停 / 恢复 / 停止、删除）。
 * 状态都在 core（main.db watches）；这里只是展示缓存（§5 护栏 3）。
 */
class WatchesState {
  byId = $state<Record<string, WatchEntry>>({});
  /** Watches whose row is gone (bot / conversation deleted). */
  removed = $state<Record<string, true>>({});
  #started = false;
  #loading = new Set<string>();

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('watch.updated', (payload) => {
      const { watch, removed } = payload as { watch: WatchEntry; removed?: boolean };
      if (removed === true) {
        this.removed = { ...this.removed, [watch.id]: true };
      }
      this.byId = { ...this.byId, [watch.id]: watch };
    });
  }

  /** Loads a watch once (cards mount lazily while scrolling history). */
  async ensure(id: string): Promise<void> {
    this.start();
    if (id.length === 0 || this.byId[id] !== undefined || this.#loading.has(id)) return;
    this.#loading.add(id);
    try {
      const result = (await core.call('watches.get', { id })) as { watch: WatchEntry | null };
      if (result.watch !== null) this.byId = { ...this.byId, [id]: result.watch };
      else this.removed = { ...this.removed, [id]: true };
    } catch {
      // Card falls back to its placeholder.
    } finally {
      this.#loading.delete(id);
    }
  }

  async act(id: string, action: 'pause' | 'resume' | 'stop'): Promise<WatchEntry> {
    const result = (await core.call(`watches.${action}`, { id })) as { watch: WatchEntry };
    this.byId = { ...this.byId, [id]: result.watch };
    return result.watch;
  }
}

export const watches = new WatchesState();
