import type { MemoryItem } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * P07 right-panel state: the viewed bot's memory items (all statuses; the tab
 * renders non-active ones muted). Loads on demand when the tab opens.
 */
class MemoryState {
  botId = $state<string | null>(null);
  items = $state<MemoryItem[]>([]);
  loading = $state(false);
  #loadedFor: string | null = null;

  async load(botId: string, force = false): Promise<void> {
    if (!force && this.#loadedFor === botId && this.botId === botId) return;
    this.loading = true;
    try {
      const result = (await core.call('memory.list', { botId })) as { items: MemoryItem[] };
      this.items = result.items;
      this.botId = botId;
      this.#loadedFor = botId;
    } finally {
      this.loading = false;
    }
  }

  /** Plain-object patch over RPC (a $state Proxy must never cross postMessage). */
  async update(
    botId: string,
    id: string,
    patch: { content?: string; privateToBot?: boolean },
  ): Promise<void> {
    const result = (await core.call('memory.update', { id, botId, ...patch })) as {
      items: MemoryItem[];
    };
    this.items = result.items;
  }

  async retract(botId: string, id: string): Promise<void> {
    const result = (await core.call('memory.retract', { id, botId })) as { items: MemoryItem[] };
    this.items = result.items;
  }

  /** Switching bots invalidates the cached list. */
  reset(): void {
    this.botId = null;
    this.items = [];
    this.#loadedFor = null;
  }
}

export const memoryStore = new MemoryState();
