import type { AppError} from '@kepcup/shared';
import { type BrowserNetworkContext, type BrowserSnapshotOutput } from '@kepcup/shared';
import type { BrowserHostRpc } from '@kepcup/core';

export interface FakePageState {
  url: string;
  title: string;
  snapshot: Omit<BrowserSnapshotOutput, never>;
}

export interface FakeBrowserHostCall {
  method: string;
  input: unknown;
  at: number;
}

/**
 * Programmable fake of the main-process browser host for unit/integration
 * tests (docs/dev/05-testing.md): records every browser.* call, serves canned
 * snapshots, supports gated (pending) and failing methods for race coverage.
 */
export interface FakeBrowserHost extends BrowserHostRpc {
  calls: FakeBrowserHostCall[];
  pages: Map<string, { context: BrowserNetworkContext; downloadsDir: string }>;
  /** Sets the snapshot every browser.snapshot returns. */
  setSnapshot(snapshot: BrowserSnapshotOutput): void;
  /**
   * request URL → final URL (simulated 301/302/JS redirect): navigate reports
   * the *final* URL, like the real host (`page.wc.getURL()` after the load).
   */
  readonly redirects: Map<string, string>;
  /** Makes named methods hang until `release` (or reject with `failWith`). */
  hold(method: string): void;
  release(method: string): void;
  failWith(method: string, error: AppError): void;
  clearedBots: string[];
  closedPairs: Array<{ botId: string; conversationId: string; permanent?: boolean }>;
}

export function createFakeBrowserHost(): FakeBrowserHost {
  const calls: FakeBrowserHostCall[] = [];
  const pages = new Map<string, { context: BrowserNetworkContext; downloadsDir: string }>();
  const redirects = new Map<string, string>();
  const clearedBots: string[] = [];
  const closedPairs: Array<{ botId: string; conversationId: string; permanent?: boolean }> = [];
  const gates = new Map<string, { resolve: () => void; reject: (error: AppError) => void }>();
  const failures = new Map<string, AppError>();
  let snapshot: BrowserSnapshotOutput = {
    title: 'Fake',
    url: 'about:blank',
    elements: [],
    elementsTruncated: false,
    text: '',
    textTruncated: false,
  };

  function record(method: string, input: unknown): void {
    calls.push({ method, input, at: calls.length });
  }

  async function gated<T>(method: string, run: () => Promise<T> | T): Promise<T> {
    const failure = failures.get(method);
    if (failure) throw failure;
    const hasGate = gates.has(method);
    const promise = hasGate
      ? new Promise<void>((resolve, reject) => {
          gates.set(method, { resolve, reject });
        })
      : Promise.resolve();
    const result = await run();
    await promise;
    if (failure) throw failure;
    return result;
  }

  const host: FakeBrowserHost = {
    calls,
    pages,
    redirects,
    clearedBots,
    closedPairs,
    setSnapshot(next) {
      snapshot = next;
    },
    hold(method) {
      gates.set(method, { resolve: () => {}, reject: () => {} });
    },
    release(method) {
      gates.get(method)?.resolve();
      gates.delete(method);
    },
    failWith(method, error) {
      gates.get(method)?.reject(error);
      gates.delete(method);
      failures.set(method, error);
    },
    async ensurePage(input) {
      record('browser.ensurePage', input);
      return gated('browser.ensurePage', () => {
        pages.set(`${input.botId}|${input.conversationId}`, {
          context: input.networkContext,
          downloadsDir: input.downloadsDir,
        });
        return { ok: true as const };
      });
    },
    async navigate(input) {
      record('browser.navigate', input);
      return gated('browser.navigate', () => {
        const target = redirects.get(input.url) ?? input.url;
        snapshot = { ...snapshot, url: target };
        return { ok: true as const, title: snapshot.title, url: target };
      });
    },
    async snapshot(input) {
      record('browser.snapshot', input);
      return gated('browser.snapshot', () => snapshot);
    },
    async click(input) {
      record('browser.click', input);
      return gated('browser.click', () => ({ ok: true as const }));
    },
    async type(input) {
      record('browser.type', input);
      return gated('browser.type', () => ({ ok: true as const }));
    },
    async press(input) {
      record('browser.press', input);
      return gated('browser.press', () => ({ ok: true as const }));
    },
    async scroll(input) {
      record('browser.scroll', input);
      return gated('browser.scroll', () => ({ ok: true as const }));
    },
    async screenshot(input) {
      record('browser.screenshot', input);
      return gated('browser.screenshot', () => ({
        ok: true as const,
        dataBase64: 'ZmFrZXBuZw==',
        mimeType: 'image/png' as const,
        width: 1280,
        height: 800,
      }));
    },
    async back(input) {
      record('browser.back', input);
      return gated('browser.back', () => ({ ok: true as const }));
    },
    async close(input) {
      record('browser.close', input);
      return gated('browser.close', () => {
        closedPairs.push(input);
        pages.delete(`${input.botId}|${input.conversationId}`);
        return { ok: true as const };
      });
    },
    async setNetworkContext(input) {
      record('browser.setNetworkContext', input);
      return gated('browser.setNetworkContext', () => {
        const page = pages.get(`${input.botId}|${input.conversationId}`);
        if (page) page.context = input.networkContext;
        return { ok: true as const };
      });
    },
    async clearBotData(input) {
      record('browser.clearBotData', input);
      return gated('browser.clearBotData', () => {
        clearedBots.push(input.botId);
        for (const key of [...pages.keys()]) {
          if (key.startsWith(`${input.botId}|`)) pages.delete(key);
        }
        return { ok: true as const };
      });
    },
  };
  return host;
}
