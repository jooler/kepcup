import type { HandoverAdapter, HandoverEntry, InventoryQuery } from './types.js';

/**
 * 适配器注册表（D88）：按 stage 排序；按 key 前缀找适配器。引擎只经它访问适配器。
 */
export class HandoverRegistry {
  readonly #adapters: HandoverAdapter[];

  constructor(adapters: readonly HandoverAdapter[]) {
    this.#adapters = [...adapters].sort((a, b) => a.stage - b.stage);
  }

  /** All adapters, ordered by execution stage. */
  list(): readonly HandoverAdapter[] {
    return this.#adapters;
  }

  /** The adapter that owns `key`, or null (a key nobody owns is fabricated). */
  forKey(key: string): HandoverAdapter | null {
    return this.#adapters.find((adapter) => adapter.owns(key)) ?? null;
  }

  /** Inventory of every adapter, in stage order. */
  inventory(botId: string, query?: InventoryQuery): HandoverEntry[] {
    return this.#adapters.flatMap((adapter) => adapter.inventory(botId, query));
  }

  /** Per-type summary lines of the inventory (e.g. memory counts), in stage order. */
  summaries(botId: string): Array<{ type: string; text: string }> {
    const out: Array<{ type: string; text: string }> = [];
    for (const adapter of this.#adapters) {
      const text = adapter.summary?.(botId) ?? null;
      if (text !== null && text.length > 0) out.push({ type: adapter.type, text });
    }
    return out;
  }

  /** Why an existing `key` can never be handed over (null = not such a key). */
  refusal(botId: string, key: string): string | null {
    return this.forKey(key)?.refusal?.(botId, key) ?? null;
  }

  /**
   * The entry behind `key` as of now: the adapter's inventory first, then its `resolve`
   * (keys valid outside the inventory, e.g. `model:<ref>`). null = no such asset.
   */
  entry(botId: string, key: string): { adapter: HandoverAdapter; entry: HandoverEntry } | null {
    const adapter = this.forKey(key);
    if (adapter === null) return null;
    const entry =
      adapter.inventory(botId).find((candidate) => candidate.key === key) ??
      adapter.resolve?.(botId, key) ??
      null;
    return entry === null ? null : { adapter, entry };
  }
}
