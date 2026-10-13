/**
 * Open bot browser pages (main process BrowserHost), kept live over ipc
 * `browser:pages`. The right panel shows「查看浏览器」only while the bot has a
 * page in the current conversation.
 */
export interface BrowserPageRef {
  botId: string;
  conversationId: string;
}

export function hasBrowserPage(
  pages: readonly BrowserPageRef[],
  botId: string,
  conversationId: string,
): boolean {
  return pages.some((p) => p.botId === botId && p.conversationId === conversationId);
}

class BrowserPagesStore {
  pages = $state<BrowserPageRef[]>([]);
  #started = false;

  /** Idempotent; safe outside Electron (no bridge → stays empty). */
  start(): void {
    if (this.#started) return;
    const bridge = typeof window === 'undefined' ? undefined : window.kepcup;
    if (!bridge?.getBotBrowserPages || !bridge.onBotBrowserPagesChanged) return;
    this.#started = true;
    bridge.onBotBrowserPagesChanged((pages) => {
      this.pages = pages;
    });
    void bridge.getBotBrowserPages().then(
      (pages) => {
        this.pages = pages;
      },
      () => {},
    );
  }

  has(botId: string, conversationId: string): boolean {
    return hasBrowserPage(this.pages, botId, conversationId);
  }
}

export const browserPages = new BrowserPagesStore();
