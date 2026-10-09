import type { ZodType } from 'zod';
import {
  AppError,
  browserActionOutputSchema,
  browserEnsurePageOutputSchema,
  browserFetchTextOutputSchema,
  browserNavigateOutputSchema,
  browserScreenshotOutputSchema,
  browserSnapshotOutputSchema,
  okOutputSchema,
  type BrowserActionOutput,
  type BrowserFetchTextOutput,
  type BrowserNetworkContext,
  type BrowserScreenshotOutput,
  type BrowserSnapshotOutput,
} from '@kepcup/shared';

/**
 * Core-side handle for the browser capability hosted by the main process
 * (docs/dev/phases/P11-browser.md 接口与数据): every method is one port B
 * `browser.*` call. In the Electron app the deferred instance is bound to the
 * platform channel once the port arrives; tests inject a fake directly via
 * `CoreServicesOptions.browserRpc`.
 */

export interface BrowserPageKey {
  botId: string;
  conversationId: string;
}

/** Minimal client surface (the shared RpcChannel satisfies it structurally). */
export interface BrowserRpcClient {
  call(method: string, input?: unknown): Promise<unknown>;
  /** Fails in-flight calls when the binding goes away (core restart/close). */
  rejectPending(reason: string): void;
}

export interface BrowserHostRpc {
  ensurePage(input: BrowserPageKey & {
    /** W8: `bot:{botId}` / `shared:{profileId}` — the host derives the partition. */
    profileKey: string;
    networkContext: BrowserNetworkContext;
    downloadsDir: string;
  }): Promise<{ ok: true }>;
  navigate(input: BrowserPageKey & { url: string }): Promise<{ ok: true; title: string; url: string }>;
  snapshot(input: BrowserPageKey): Promise<BrowserSnapshotOutput>;
  /*
   * W1: actions resolve with `outcome: 'completed'` (+ `navigated`, and
   * `passwordField` for type); failures are AppErrors whose `details.phase`
   * says whether the side-effecting CDP call was already sent.
   */
  click(input: BrowserPageKey & { ref: string }): Promise<BrowserActionOutput>;
  type(input: BrowserPageKey & { ref: string; text: string }): Promise<BrowserActionOutput>;
  press(input: BrowserPageKey & { key: string }): Promise<BrowserActionOutput>;
  scroll(input: BrowserPageKey & { direction: 'up' | 'down'; amount: number }): Promise<BrowserActionOutput>;
  screenshot(input: BrowserPageKey): Promise<BrowserScreenshotOutput>;
  back(input: BrowserPageKey): Promise<BrowserActionOutput>;
  close(input: BrowserPageKey & { permanent?: boolean }): Promise<{ ok: true }>;
  setNetworkContext(input: BrowserPageKey & { networkContext: BrowserNetworkContext }): Promise<{ ok: true }>;
  clearBotData(input: { botId: string }): Promise<{ ok: true }>;
  /** W8: closes every page of the bot (its browser profile was switched). */
  closeBotPages(input: { botId: string }): Promise<{ ok: true }>;
  /** W8: wipes a shared profile's storage (`remove` = deleted: tombstone + directory). */
  clearProfileData(input: { profileId: string; remove?: boolean }): Promise<{ ok: true }>;
  /**
   * W7 确定性监看：a hidden background page keyed `botId|watch:{watchId}` in
   * the bot's effective profile loads `url` under the network rules, returns
   * the body text (or `selector`'s) and closes. Never shown, never kept.
   */
  fetchText(input: {
    botId: string;
    watchId: string;
    profileKey: string;
    networkContext: BrowserNetworkContext;
    url: string;
    selector?: string;
    extraSelectors?: string[];
  }): Promise<BrowserFetchTextOutput>;
}

function unavailable(): AppError {
  return new AppError('BROWSER_UNAVAILABLE', '浏览器宿主未连接');
}

/** Reason in-flight calls are rejected with when the port B binding is replaced. */
const HOST_DISCONNECTED = 'browser host disconnected';

/**
 * W7: the call failed because no browser host is connected — not bound yet
 * (startup), or the binding went away while it ran (the pending call then
 * surfaces as INTERNAL "browser host disconnected"). Not the page's fault.
 */
export function isBrowserHostUnavailable(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code === 'BROWSER_UNAVAILABLE') return true;
  return error.code === 'INTERNAL' && error.message === HOST_DISCONNECTED;
}

/** One facade dispatch per method (used when a test fake is bound). */
const FACADE_METHODS: Record<string, (facade: BrowserHostRpc, input: unknown) => Promise<unknown>> = {
  'browser.ensurePage': (f, i) => f.ensurePage(i as never),
  'browser.navigate': (f, i) => f.navigate(i as never),
  'browser.snapshot': (f, i) => f.snapshot(i as never),
  'browser.click': (f, i) => f.click(i as never),
  'browser.type': (f, i) => f.type(i as never),
  'browser.press': (f, i) => f.press(i as never),
  'browser.scroll': (f, i) => f.scroll(i as never),
  'browser.screenshot': (f, i) => f.screenshot(i as never),
  'browser.back': (f, i) => f.back(i as never),
  'browser.close': (f, i) => f.close(i as never),
  'browser.setNetworkContext': (f, i) => f.setNetworkContext(i as never),
  'browser.clearBotData': (f, i) => f.clearBotData(i as never),
  'browser.closeBotPages': (f, i) => f.closeBotPages(i as never),
  'browser.clearProfileData': (f, i) => f.clearProfileData(i as never),
  'browser.fetchText': (f, i) => f.fetchText(i as never),
};

class DeferredRpc implements BrowserHostRpc {
  #client: BrowserRpcClient | null = null;
  /** In-process target (test fake); takes precedence over the port B client. */
  #facade: BrowserHostRpc | null = null;

  readonly #boundListeners = new Set<() => void>();

  bind(client: BrowserRpcClient | null): void {
    // Fail everything still in flight: pages die with the transport.
    this.#client?.rejectPending(HOST_DISCONNECTED);
    this.#client = client;
    if (client !== null) this.#notifyBound();
  }

  /** Binds an in-process implementation (integration tests). */
  bindFacade(facade: BrowserHostRpc | null): void {
    this.#facade = facade;
    if (facade !== null) this.#notifyBound();
  }

  onBound(listener: () => void): () => void {
    this.#boundListeners.add(listener);
    return () => {
      this.#boundListeners.delete(listener);
    };
  }

  #notifyBound(): void {
    for (const listener of [...this.#boundListeners]) {
      try {
        listener();
      } catch {
        // A listener's failure never breaks the binding.
      }
    }
  }

  async #call<T>(method: string, input: unknown, output: ZodType<T>): Promise<T> {
    const facade = this.#facade;
    if (facade !== null) {
      const dispatch = FACADE_METHODS[method];
      if (dispatch === undefined) throw unavailable();
      return output.parse(await dispatch(facade, input));
    }
    const client = this.#client;
    if (client === null) throw unavailable();
    return output.parse(await client.call(method, input));
  }

  ensurePage(input: Parameters<BrowserHostRpc['ensurePage']>[0]) {
    // W8: another profile for this page = the host recreates it — the W1
    // state (no-progress streak, screenshot dedupe) belongs to the old page.
    if (notePageProfile(this, input, input.profileKey)) dropBrowserPageState(this, input);
    return this.#call('browser.ensurePage', input, browserEnsurePageOutputSchema);
  }

  navigate(input: Parameters<BrowserHostRpc['navigate']>[0]) {
    return this.#call('browser.navigate', input, browserNavigateOutputSchema);
  }

  snapshot(input: Parameters<BrowserHostRpc['snapshot']>[0]) {
    return this.#call('browser.snapshot', input, browserSnapshotOutputSchema);
  }

  click(input: Parameters<BrowserHostRpc['click']>[0]) {
    return this.#call('browser.click', input, browserActionOutputSchema);
  }

  type(input: Parameters<BrowserHostRpc['type']>[0]) {
    return this.#call('browser.type', input, browserActionOutputSchema);
  }

  press(input: Parameters<BrowserHostRpc['press']>[0]) {
    return this.#call('browser.press', input, browserActionOutputSchema);
  }

  scroll(input: Parameters<BrowserHostRpc['scroll']>[0]) {
    return this.#call('browser.scroll', input, browserActionOutputSchema);
  }

  screenshot(input: Parameters<BrowserHostRpc['screenshot']>[0]) {
    return this.#call('browser.screenshot', input, browserScreenshotOutputSchema);
  }

  back(input: Parameters<BrowserHostRpc['back']>[0]) {
    return this.#call('browser.back', input, browserActionOutputSchema);
  }

  close(input: Parameters<BrowserHostRpc['close']>[0]) {
    // Deletion cascade (permanent): forget the W1 page state with the page.
    if (input.permanent === true) dropBrowserPageState(this, input);
    return this.#call('browser.close', input, okOutputSchema);
  }

  setNetworkContext(input: Parameters<BrowserHostRpc['setNetworkContext']>[0]) {
    return this.#call('browser.setNetworkContext', input, okOutputSchema);
  }

  clearBotData(input: Parameters<BrowserHostRpc['clearBotData']>[0]) {
    dropBotBrowserPageStates(this, input.botId);
    return this.#call('browser.clearBotData', input, okOutputSchema);
  }

  closeBotPages(input: Parameters<BrowserHostRpc['closeBotPages']>[0]) {
    // The pages are gone: a reopened page (new profile) starts clean.
    dropBotBrowserPageStates(this, input.botId);
    return this.#call('browser.closeBotPages', input, okOutputSchema);
  }

  fetchText(input: Parameters<BrowserHostRpc['fetchText']>[0]) {
    return this.#call('browser.fetchText', input, browserFetchTextOutputSchema);
  }

  clearProfileData(input: Parameters<BrowserHostRpc['clearProfileData']>[0]) {
    // The host closes every page on the profile (clear and delete alike).
    dropProfileBrowserPageStates(this, `shared:${input.profileId}`);
    return this.#call('browser.clearProfileData', input, okOutputSchema);
  }
}

export type DeferredBrowserHostRpc = BrowserHostRpc & {
  bind(client: BrowserRpcClient | null): void;
  /** Binds an in-process implementation (integration test fakes). */
  bindFacade(facade: BrowserHostRpc | null): void;
  /**
   * W7: called whenever a host gets bound (port B arrived / re-bound, or a
   * test fake) — work deferred while the host was unavailable resumes.
   */
  onBound(listener: () => void): () => void;
};

/** The unbound-by-default facade used when no client was injected yet. */
export function createBrowserHostRpc(): DeferredBrowserHostRpc {
  return new DeferredRpc();
}

// --- W1 per-page tool state ----------------------------------------------------

/**
 * Core-side memory of one bot page (W1 浏览器动作确定性, keyed `botId|conversationId`
 * per host handle): the last snapshot's hash and element fingerprints (action
 * signatures), the no-progress streak and the last screenshot hash. Run-scoped
 * parts (streak, screenshot) reset when another run touches the page — a new
 * run's model never saw the earlier screenshot, and a user-requested retry in a
 * new turn is not a loop.
 */
export interface BrowserPageState {
  runId: string;
  /** sha256 of the last rendered snapshot with ref ids stripped (null = none yet). */
  snapshotHash: string | null;
  /** ref → "role|name" of the last snapshot (signature of an action on that ref). */
  elements: Map<string, string>;
  /** Consecutive executions of one signature that left the snapshot unchanged. */
  streak: { signature: string; snapshotHash: string; count: number } | null;
  /** sha256 of the last screenshot returned as an image in this run. */
  screenshotHash: string | null;
}

/** Pages remembered per host handle (oldest dropped first). */
const PAGE_STATE_MAX = 256;
const pageStates = new WeakMap<object, Map<string, BrowserPageState>>();
/** W8: the profile key each page was last ensured with (per host handle). */
const pageProfiles = new WeakMap<object, Map<string, string>>();

/** Records the page's profile key; true when it differs from the last one seen. */
function notePageProfile(host: BrowserHostRpc, key: BrowserPageKey, profileKey: string): boolean {
  let profiles = pageProfiles.get(host);
  if (profiles === undefined) {
    profiles = new Map();
    pageProfiles.set(host, profiles);
  }
  const mapKey = `${key.botId}|${key.conversationId}`;
  const previous = profiles.get(mapKey);
  profiles.delete(mapKey);
  profiles.set(mapKey, profileKey);
  if (profiles.size > PAGE_STATE_MAX) {
    const oldest = profiles.keys().next().value;
    if (oldest !== undefined) profiles.delete(oldest);
  }
  return previous !== undefined && previous !== profileKey;
}

/** W8: forgets every page on a profile (clearProfileData closes them). */
export function dropProfileBrowserPageStates(host: BrowserHostRpc, profileKey: string): void {
  const profiles = pageProfiles.get(host);
  if (profiles === undefined) return;
  for (const [key, value] of [...profiles.entries()]) {
    if (value !== profileKey) continue;
    profiles.delete(key);
    pageStates.get(host)?.delete(key);
  }
}

export function browserPageState(
  host: BrowserHostRpc,
  key: BrowserPageKey,
  runId: string,
): BrowserPageState {
  let pages = pageStates.get(host);
  if (pages === undefined) {
    pages = new Map();
    pageStates.set(host, pages);
  }
  const mapKey = `${key.botId}|${key.conversationId}`;
  let state = pages.get(mapKey);
  if (state === undefined) {
    state = { runId, snapshotHash: null, elements: new Map(), streak: null, screenshotHash: null };
    pages.set(mapKey, state);
    if (pages.size > PAGE_STATE_MAX) {
      const oldest = pages.keys().next().value;
      if (oldest !== undefined) pages.delete(oldest);
    }
  } else if (state.runId !== runId) {
    state.runId = runId;
    state.streak = null;
    state.screenshotHash = null;
  }
  return state;
}

/** Forgets a page (browser_close): a reopened page starts clean. */
export function dropBrowserPageState(host: BrowserHostRpc, key: BrowserPageKey): void {
  pageStates.get(host)?.delete(`${key.botId}|${key.conversationId}`);
}

/** Forgets every page of a bot (bot deletion: clearBotData). */
export function dropBotBrowserPageStates(host: BrowserHostRpc, botId: string): void {
  const pages = pageStates.get(host);
  if (pages === undefined) return;
  for (const key of [...pages.keys()]) {
    if (key.startsWith(`${botId}|`)) pages.delete(key);
  }
}
