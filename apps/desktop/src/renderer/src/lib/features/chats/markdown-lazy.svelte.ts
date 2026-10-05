import type { Component } from 'svelte';

/**
 * Lazily loads the markdown pipeline (streamdown-svelte + shiki + katex,
 * docs/design/12-ui-layout.md 消息渲染). P13 任务 7 evidence: these libraries
 * dominate the renderer's eager entry chunk (~3MB of ~4MB parsed code) while
 * the app's live JS heap is only ~16MB — importing them at startup costs
 * renderer working set and cold-boot time for a capability most sessions use
 * only after a bot answers. A module-level singleton loads the chunk once;
 * every message bubble re-renders when it arrives.
 */
class LazyMarkdown {
  component = $state<Component<{ content: string }> | null>(null);
  #started = false;

  /** Idempotent; safe to call from every bot bubble's effect. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    void import('streamdown-svelte').then((m) => {
      this.component = m.Streamdown as Component<{ content: string }>;
    });
  }
}

export const lazyMarkdown = new LazyMarkdown();
