import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_SCREENSHOT_MAX_BASE64_CHARS,
  BROWSER_SNAPSHOT_MAX_ELEMENTS,
  BROWSER_SNAPSHOT_MAX_TEXT_CHARS,
  BROWSER_VIEWPORT_HEIGHT,
  BROWSER_VIEWPORT_WIDTH,
  WATCH_FETCH_DEADLINE_MS,
  WATCH_FETCH_TEXT_MAX_CHARS,
  AppError,
  buildSnapshotSummary,
  decideBrowserRequest,
  watchRedirectAllowed,
  watchRedirectTarget,
  type AxtreeNode,
  type BrowserActionOutput,
  type BrowserFetchTextOutput,
  type BrowserNetworkContext,
  type BrowserSnapshotOutput,
  type RefFingerprint,
} from '@kepcup/shared';
import {
  BrowserWindow,
  WebContentsView,
  session,
  type Session,
  type WebContents,
} from 'electron';
import { pageClosed, toPageError } from './browser-action-phase.js';
import {
  ControlLease,
  HANDBACK_TITLE_PREFIX,
  VIEWER_TOOLBAR_HEIGHT,
  classifyKeyInput,
  classifyMouseInput,
  parseProfileKey,
  parseViewerLabels,
  partitionDirName,
  viewerToolbarUrl,
  type HandbackReason,
  type PageControl,
  type ViewerLabels,
} from './browser-control.js';
import {
  axStateDigest,
  backAction,
  clickAction,
  pressAction,
  scrollAction,
  typeAction,
  type PageOps,
} from './browser-actions.js';
import { HostDnsResolver } from './dns-resolver.js';
import { uniqueDownloadPath } from './download-name.js';

/**
 * Hosts one bot browser page per "bot + conversation" (docs/dev/phases/
 * P11-browser.md 任务 1): each bot gets the isolated `persist:bot-{botId}`
 * partition by default — or, W8, a user-made shared profile
 * `persist:shared-{profileId}` (the core sends the page's profileKey) — pages are WebContentsViews in one hidden (offscreen but painting)
 * window, driven over `webContents.debugger` (CDP) — no remote debugging port.
 *
 * CDP protocol constraints baked in below (re-verified in the P11-B e2e):
 * commands must only run while the page is not mid-navigation; the DOM agent
 * needs `DOM.enable` + `DOM.getDocument` after each cross-document navigation
 * before `DOM.resolveNode` accepts a `backendNodeId`; screenshots use an
 * explicit clip because `Emulation.setDeviceMetricsOverride` is unstable on
 * hidden views.
 */

interface PageEntry {
  botId: string;
  conversationId: string;
  /** W8: `bot:{botId}` / `shared:{profileId}` the page was created for. */
  profileKey: string;
  /** Electron partition derived from profileKey. */
  partition: string;
  /** W8 自动接管: who may act on the page (user after a click / key in the viewer). */
  lease: ControlLease;
  view: WebContentsView;
  wc: WebContents;
  context: BrowserNetworkContext;
  downloadsDir: string;
  /**
   * ref → fingerprint (backendNodeId + role + name at snapshot time), valid
   * until the next navigation or snapshot; click/type re-check it (W1).
   */
  refs: Map<string, RefFingerprint>;
  refsValid: boolean;
  /** Bumped on every (cross- or same-document) navigation: `navigated` flag. */
  navigationSeq: number;
  /** DOM agent re-initialized for the current document. */
  domReady: boolean;
  closed: boolean;
  /**
   * W7: a watch's background page (`botId|watch:{id}`): never shown, no
   * downloads, closed right after its text was read.
   */
  background: boolean;
}

export function sessionDataRoot(env: NodeJS.ProcessEnv): string {
  const home = env['KEPCUP_HOME'] ?? path.join(homedir(), '.kepcup');
  return path.join(home, 'browser');
}

/**
 * Electron keeps one partition's disk state under `Partitions/{name}`, the
 * name lower-cased (browser-control.ts partitionDirName). The as-written
 * spelling is included too (removal is `force`, so a missing one is a no-op):
 * deletion must not depend on that naming detail.
 */
export function partitionDirs(root: string, partition: string): string[] {
  const raw = path.join(root, 'Partitions', partition.replace(/^persist:/, ''));
  const lower = path.join(root, 'Partitions', partitionDirName(partition));
  return raw === lower ? [lower] : [lower, raw];
}

/** A visible viewer window: the page view below a toolbar view (W8). */
interface Viewer {
  win: BrowserWindow;
  toolbar: WebContentsView;
  labels: ViewerLabels;
}

export interface BrowserHostOptions {
  /**
   * W8: the user handed a page back (toolbar / closed viewer / idle). The
   * main process forwards it to the core (`browser.controlReturned`), which
   * tells the page's running tasks to snapshot before going on.
   */
  onControlReturned?: (input: {
    botId: string;
    conversationId: string;
    reason: HandbackReason;
  }) => void;
}

export class BrowserHost {
  readonly #sessionRoot: string;
  #hostWindow: BrowserWindow | null = null;
  readonly #pages = new Map<string, PageEntry>();
  readonly #pagesByWebContents = new Map<number, PageEntry>();
  readonly #configuredSessions = new Set<Session>();
  readonly #dns = new HostDnsResolver();
  readonly #tombstonedBots = new Set<string>();
  readonly #tombstonedPairs = new Set<string>();
  /** W8: deleted shared profiles (a late ensurePage must not recreate them). */
  readonly #tombstonedProfiles = new Set<string>();
  /** Per-page visible viewer windows (ipc browser.show, docs 任务 5). */
  readonly #viewers = new Map<string, Viewer>();
  readonly #options: BrowserHostOptions;

  constructor(env: NodeJS.ProcessEnv, options: BrowserHostOptions = {}) {
    this.#sessionRoot = sessionDataRoot(env);
    this.#options = options;
  }

  // --- lifecycle ------------------------------------------------------------

  /** Closes every page (app quit); in-flight operations reject. */
  closeAll(): void {
    for (const page of [...this.#pages.values()]) {
      this.#destroyPage(page, { permanent: false });
    }
  }

  // --- port B methods ---------------------------------------------------------

  ensurePage(input: {
    botId: string;
    conversationId: string;
    profileKey: string;
    networkContext: BrowserNetworkContext;
    downloadsDir: string;
  }): { ok: true } {
    const key = pairKey(input.botId, input.conversationId);
    if (this.#tombstonedBots.has(input.botId)) {
      throw new AppError('BROWSER_BOT_DELETED', '该 Bot 已删除，浏览器页面不可用');
    }
    if (this.#tombstonedPairs.has(key)) {
      throw new AppError('BROWSER_CONVERSATION_DELETED', '该对话已删除，浏览器页面不可用');
    }
    const profile = parseProfileKey(input.profileKey);
    // A private profile belongs to its own bot only.
    if (profile.kind === 'bot' && profile.id !== input.botId) {
      throw new AppError('INVALID_INPUT', '私有浏览器资料只属于它自己的 Bot');
    }
    if (profile.kind === 'shared' && this.#tombstonedProfiles.has(profile.id)) {
      throw new AppError('BROWSER_PAGE_CLOSED', '该共享浏览器资料已删除');
    }
    const existing = this.#pages.get(key);
    if (existing && existing.profileKey === input.profileKey) {
      existing.context = input.networkContext;
      existing.downloadsDir = input.downloadsDir;
      return { ok: true };
    }
    // W8: the bot's profile changed under an open page (core closes pages on
    // a switch; this covers a call racing it) — never reuse the old identity.
    if (existing) this.#destroyPage(existing, { permanent: false });
    this.#sessionFor(profile.partition);
    const view = new WebContentsView({
      webPreferences: {
        partition: profile.partition,
        backgroundThrottling: false,
      },
    });
    view.setBounds({
      x: 0,
      y: 0,
      width: BROWSER_VIEWPORT_WIDTH,
      height: BROWSER_VIEWPORT_HEIGHT,
    });
    const wc = view.webContents;
    wc.setBackgroundThrottling(false);
    // Popups stay in the same page (docs 任务 1: 禁用弹窗). The popup URL is
    // page-controlled, so it goes through the same http/https allowlist as
    // navigate — window.open('file://…') must never loadURL (BR-P11-002).
    wc.setWindowOpenHandler(({ url }) => {
      if (httpHttpsUrl(url)) void wc.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    wc.on('did-navigate', () => this.#invalidateDocumentState(wc));
    wc.on('did-navigate-in-page', () => this.#invalidateDocumentState(wc));
    // W8 自动接管: only input inside the visible viewer counts — a click or a
    // key press takes the page over; moves / wheel only keep the lease alive.
    wc.on('before-input-event', (_event, keyInput) => {
      this.#userInput(wc, classifyKeyInput(keyInput));
    });
    wc.on('before-mouse-event', (_event, mouse) => {
      this.#userInput(wc, classifyMouseInput(mouse));
    });
    try {
      wc.debugger.attach('1.3');
    } catch {
      // Already attached (should not happen for a fresh view).
    }
    this.#hostWindowLazy().contentView.addChildView(view);

    const lease = new ControlLease({
      onChange: (control, reason) => this.#controlChanged(key, control, reason),
    });
    const page: PageEntry = {
      botId: input.botId,
      conversationId: input.conversationId,
      profileKey: input.profileKey,
      partition: profile.partition,
      lease,
      view,
      wc,
      context: input.networkContext,
      downloadsDir: input.downloadsDir,
      refs: new Map(),
      refsValid: false,
      navigationSeq: 0,
      domReady: false,
      closed: false,
      background: false,
    };
    this.#pages.set(key, page);
    this.#pagesByWebContents.set(wc.id, page);
    return { ok: true };
  }

  setNetworkContext(input: {
    botId: string;
    conversationId: string;
    networkContext: BrowserNetworkContext;
  }): { ok: true } {
    this.#pageOf(input.botId, input.conversationId).context = input.networkContext;
    return { ok: true };
  }

  /**
   * 查看窗口（docs 任务 5）：moves the page's WebContentsView into a visible
   * window so the user can watch / manually log in. The ipc layer only
   * forwards the capability request — permission decisions live in the core
   * (docs 注意事项). Closing the window returns the view to the hidden host
   * window; the webContents object is never touched, so an in-flight run
   * keeps operating the page uninterrupted.
   */
  show(input: {
    botId: string;
    conversationId: string;
    title?: string;
    labels?: unknown;
  }): { ok: true } {
    const page = this.#pageOf(input.botId, input.conversationId);
    // W7: a watch's background page is never shown.
    if (page.background) throw new AppError('BROWSER_PAGE_CLOSED', '浏览器页面未打开或已关闭');
    const key = pairKey(input.botId, input.conversationId);
    const existing = this.#viewers.get(key);
    if (existing !== undefined && !existing.win.isDestroyed()) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.focus();
      return { ok: true };
    }
    const win = new BrowserWindow({
      width: BROWSER_VIEWPORT_WIDTH,
      height: BROWSER_VIEWPORT_HEIGHT + VIEWER_TOOLBAR_HEIGHT,
      title: input.title && input.title.length > 0 ? input.title : 'Bot 浏览器',
      autoHideMenuBar: true,
    });
    // W8 工具条: a tiny data: page above the bot's page (state + 交还给 Bot).
    // Its own in-memory session; no node, sandboxed; the button speaks through
    // document.title (page-title-updated) — no IPC surface.
    const toolbar = new WebContentsView({
      webPreferences: { partition: 'kepcup-viewer-toolbar', sandbox: true, javascript: true },
    });
    const viewer: Viewer = { win, toolbar, labels: parseViewerLabels(input.labels) };
    toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    toolbar.webContents.on('will-navigate', (event) => event.preventDefault());
    toolbar.webContents.on('page-title-updated', (_event, title) => {
      if (title.startsWith(HANDBACK_TITLE_PREFIX)) page.lease.handBack('button');
    });
    win.contentView.addChildView(toolbar);
    win.contentView.addChildView(page.view);
    this.#renderToolbar(viewer, page.lease.control);
    const fit = (): void => {
      if (page.closed) return;
      // contentView.bounds is undefined before first layout — the window API
      // always answers (fit() runs synchronously inside show()).
      const { width, height } = win.getContentBounds();
      toolbar.setBounds({ x: 0, y: 0, width, height: VIEWER_TOOLBAR_HEIGHT });
      page.view.setBounds({
        x: 0,
        y: VIEWER_TOOLBAR_HEIGHT,
        width,
        height: Math.max(0, height - VIEWER_TOOLBAR_HEIGHT),
      });
    };
    fit();
    win.on('resize', fit);
    // Two-step handback (e2e-verified on macOS): during `close` the view is
    // only detached — a view still inside a closing window would be destroyed
    // with it, and a view added to another window during `close` is dropped
    // again by the teardown. Once the window is gone (`closed`), the hidden
    // host window re-adopts the live view, so an in-flight run keeps going.
    win.on('close', () => {
      if (page.closed) return;
      try {
        win.contentView.removeChildView(page.view);
      } catch {
        // Window already tearing down.
      }
    });
    win.on('closed', () => {
      if (this.#viewers.get(key) === viewer) this.#viewers.delete(key);
      try {
        toolbar.webContents.close();
      } catch {
        // Already destroyed with the window.
      }
      if (page.closed) return;
      this.#hostWindowLazy().contentView.addChildView(page.view);
      page.view.setBounds({
        x: 0,
        y: 0,
        width: BROWSER_VIEWPORT_WIDTH,
        height: BROWSER_VIEWPORT_HEIGHT,
      });
      // W8: closing the viewer hands the page back to the bot.
      page.lease.handBack('viewer_closed');
    });
    this.#viewers.set(key, viewer);
    return { ok: true };
  }

  /** W8: the toolbar's 交还给 Bot (also reachable without the toolbar, e.g. tests). */
  handBack(input: { botId: string; conversationId: string }): { ok: true } {
    this.#pageOf(input.botId, input.conversationId).lease.handBack('button');
    return { ok: true };
  }

  /** W8: current control of a page (null = no such page). */
  controlOf(input: { botId: string; conversationId: string }): PageControl | null {
    return this.#pages.get(pairKey(input.botId, input.conversationId))?.lease.control ?? null;
  }

  async navigate(input: { botId: string; conversationId: string; url: string }): Promise<{
    ok: true;
    title: string;
    url: string;
  }> {
    const page = this.#pageOf(input.botId, input.conversationId);
    // W8: the user has the page — nothing is loaded (not_started).
    page.lease.assertAgent();
    if (!httpHttpsUrl(input.url)) {
      if (!isValidUrl(input.url)) {
        throw new AppError('INVALID_INPUT', `无效的 URL：${input.url}`);
      }
      throw new AppError('INVALID_INPUT', '浏览器只能打开 http/https 网页');
    }
    await this.#load(page, input.url);
    return { ok: true, title: await this.#title(page), url: page.wc.getURL() || input.url };
  }

  async snapshot(input: { botId: string; conversationId: string }): Promise<BrowserSnapshotOutput> {
    const page = this.#pageOf(input.botId, input.conversationId);
    await this.#settle(page);
    await this.#initDomAgent(page);
    const tree = (await this.#send(page, 'Accessibility.getFullAXTree', {})) as {
      nodes?: AxtreeNode[];
    };
    const summary = buildSnapshotSummary(tree.nodes ?? [], {
      maxElements: BROWSER_SNAPSHOT_MAX_ELEMENTS,
      maxTextChars: BROWSER_SNAPSHOT_MAX_TEXT_CHARS,
    });
    const fingerprints = new Map<string, RefFingerprint>();
    for (const element of summary.elements) {
      const backendNodeId = summary.refs.get(element.ref);
      if (backendNodeId === undefined) continue;
      fingerprints.set(element.ref, { backendNodeId, role: element.role, name: element.name });
    }
    page.refs = fingerprints;
    page.refsValid = true;
    const stateDigest = axStateDigest(
      tree.nodes ?? [],
      new Set([...fingerprints.values()].map((fp) => fp.backendNodeId)),
    );
    return {
      title: await this.#title(page),
      url: page.wc.getURL(),
      elements: summary.elements,
      elementsTruncated: summary.elementsTruncated,
      elementsOmitted: summary.elementsOmitted,
      stateDigest,
      text: summary.text,
      textTruncated: summary.textTruncated,
    };
  }

  /*
   * W1 动作确定性：click / type / press / scroll / back 的流程在
   * browser-actions.ts（无 Electron 依赖、逐个 CDP 调用点有单测）；抛出的
   * AppError 都带 `details.phase`——派发前 'pre'，派发后（含 settle 期间页面
   * 关闭、debugger detach）'post'。core 据此映射 not_started / uncertain。
   */

  click(input: { botId: string; conversationId: string; ref: string }): Promise<BrowserActionOutput> {
    return clickAction(() => this.#ops(input.botId, input.conversationId), input.ref);
  }

  type(input: {
    botId: string;
    conversationId: string;
    ref: string;
    text: string;
  }): Promise<BrowserActionOutput> {
    return typeAction(() => this.#ops(input.botId, input.conversationId), input.ref, input.text);
  }

  press(input: { botId: string; conversationId: string; key: string }): Promise<BrowserActionOutput> {
    return pressAction(() => this.#ops(input.botId, input.conversationId), input.key);
  }

  scroll(input: {
    botId: string;
    conversationId: string;
    direction: 'up' | 'down';
    amount: number;
  }): Promise<BrowserActionOutput> {
    return scrollAction(
      () => this.#ops(input.botId, input.conversationId),
      input.direction,
      input.amount,
    );
  }

  async screenshot(input: { botId: string; conversationId: string }): Promise<{
    ok: true;
    dataBase64: string;
    mimeType: 'image/png';
    width: number;
    height: number;
  }> {
    const page = this.#pageOf(input.botId, input.conversationId);
    await this.#settle(page);
    const shot = (await this.#send(page, 'Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: 0,
        y: 0,
        width: BROWSER_VIEWPORT_WIDTH,
        height: BROWSER_VIEWPORT_HEIGHT,
        scale: 1,
      },
    })) as { data: string };
    if (shot.data.length > BROWSER_SCREENSHOT_MAX_BASE64_CHARS) {
      throw new AppError('INTERNAL', '截图数据超出大小上限');
    }
    return {
      ok: true,
      dataBase64: shot.data,
      mimeType: 'image/png',
      width: BROWSER_VIEWPORT_WIDTH,
      height: BROWSER_VIEWPORT_HEIGHT,
    };
  }

  back(input: { botId: string; conversationId: string }): Promise<BrowserActionOutput> {
    return backAction(() => this.#ops(input.botId, input.conversationId));
  }

  async close(input: {
    botId: string;
    conversationId: string;
    permanent?: boolean;
  }): Promise<{ ok: true }> {
    const key = pairKey(input.botId, input.conversationId);
    const page = this.#pages.get(key);
    // W8: the bot's own browser_close waits for the user's handback like any
    // action; deletion cascades (permanent) always go through.
    if (page && input.permanent !== true) page.lease.assertAgent();
    if (page) this.#destroyPage(page, { permanent: input.permanent === true });
    if (input.permanent === true) this.#tombstonedPairs.add(key);
    return { ok: true };
  }

  /**
   * Deletion cascade (docs 任务 6): closes every page of the bot, clears the
   * partition storage and removes the partition directory on disk. The bot is
   * tombstoned — ids are never reused, so a late ensurePage from an aborted
   * run can never resurrect the session.
   */
  async clearBotData(input: { botId: string }): Promise<{ ok: true }> {
    // Every page of the bot (its shared-profile pages too) closes; only the
    // bot's private partition is wiped — a shared profile outlives the bot (W8).
    for (const page of [...this.#pages.values()]) {
      if (page.botId === input.botId) this.#destroyPage(page, { permanent: false });
    }
    this.#tombstonedBots.add(input.botId);
    await this.#wipePartition(parseProfileKey(`bot:${input.botId}`).partition, { removeDir: true });
    return { ok: true };
  }

  /** W8: the bot's browser profile changed — close all its pages (no tombstone). */
  closeBotPages(input: { botId: string }): { ok: true } {
    for (const page of [...this.#pages.values()]) {
      if (page.botId === input.botId) this.#destroyPage(page, { permanent: false });
    }
    return { ok: true };
  }

  /**
   * W8: wipes a shared profile. `remove` (the profile is deleted): pages on
   * it close, the profile is tombstoned and its directory removed, like
   * clearBotData. Without it (清除数据) the pages close and the stored data is
   * cleared; the profile stays usable.
   */
  async clearProfileData(input: { profileId: string; remove?: boolean }): Promise<{ ok: true }> {
    const profile = parseProfileKey(`shared:${input.profileId}`);
    const profileKey = `shared:${input.profileId}`;
    for (const page of [...this.#pages.values()]) {
      if (page.profileKey === profileKey) this.#destroyPage(page, { permanent: false });
    }
    if (input.remove === true) this.#tombstonedProfiles.add(input.profileId);
    await this.#wipePartition(profile.partition, { removeDir: input.remove === true });
    return { ok: true };
  }

  /**
   * W7 确定性监看：loads `url` in a hidden background page keyed
   * `botId|watch:{watchId}` (the bot's effective profile → its login state;
   * the same network interception as every bot page), returns the body text
   * — or `selector`'s — plus each `extraSelectors` text (null = no match),
   * and always closes the page. Never shown, downloads cancelled.
   *
   * Not page content (→ BROWSER_NAVIGATION_FAILED, a failed check): a
   * main-frame HTTP status ≥ 400, and a final URL on another site than the
   * requested one (`watchRedirectAllowed`: same host modulo `www.`, http →
   * https allowed — anything else is most likely a login / anti-bot page).
   * The whole fetch is bounded by WATCH_FETCH_DEADLINE_MS, so the `finally`
   * always closes the page.
   */
  async fetchText(input: {
    botId: string;
    watchId: string;
    profileKey: string;
    networkContext: BrowserNetworkContext;
    url: string;
    selector?: string;
    extraSelectors?: string[];
  }): Promise<BrowserFetchTextOutput> {
    if (!httpHttpsUrl(input.url)) {
      throw new AppError('INVALID_INPUT', '监看只能打开 http/https 网页');
    }
    const conversationId = `watch:${input.watchId}`;
    this.ensurePage({
      botId: input.botId,
      conversationId,
      profileKey: input.profileKey,
      networkContext: input.networkContext,
      downloadsDir: '',
    });
    const page = this.#pageOf(input.botId, conversationId);
    page.background = true;
    try {
      return await withTimeout(
        this.#fetchTextOn(page, input),
        WATCH_FETCH_DEADLINE_MS,
        () =>
          new AppError(
            'BROWSER_NAVIGATION_FAILED',
            `读取页面超时（${WATCH_FETCH_DEADLINE_MS / 1000} 秒）`,
          ),
      );
    } finally {
      // Never kept across checks (also after the deadline: in-flight steps
      // then fail on the closed page, and nobody awaits them any more).
      this.#destroyPage(page, { permanent: false });
    }
  }

  async #fetchTextOn(
    page: PageEntry,
    input: { url: string; selector?: string; extraSelectors?: string[] },
  ): Promise<BrowserFetchTextOutput> {
    // The last committed main-frame navigation's HTTP status (after server
    // redirects: the final response; a later client-side redirect updates it).
    const nav = { status: 0 };
    const onNavigate = (_event: unknown, _url: string, httpResponseCode: number): void => {
      nav.status = httpResponseCode;
    };
    page.wc.on('did-navigate', onNavigate);
    const assertContent = (): void => {
      if (nav.status >= 400) {
        throw new AppError('BROWSER_NAVIGATION_FAILED', `页面返回 HTTP ${nav.status}`, {
          status: nav.status,
        });
      }
      const finalUrl = page.wc.getURL() || input.url;
      if (!watchRedirectAllowed(input.url, finalUrl)) {
        throw new AppError(
          'BROWSER_NAVIGATION_FAILED',
          `页面被重定向到 ${watchRedirectTarget(finalUrl)}（可能需要登录）`,
        );
      }
    };
    try {
      await this.#load(page, input.url);
      assertContent();
      // Client-rendered pages fill in after the load event.
      await delay(WATCH_RENDER_SETTLE_MS);
      if (page.closed) throw pageClosed();
      // Isolated world (the page's own scripts cannot tamper with the reader),
      // no user gesture. The title comes along: no second round trip.
      const script = `(() => {
        const pick = (selector) => {
          try {
            const el = document.querySelector(selector);
            return el ? String(el.innerText ?? el.textContent ?? '') : null;
          } catch { return null; }
        };
        const main = ${JSON.stringify(input.selector ?? null)};
        return {
          title: String(document.title ?? ''),
          text: main === null ? String(document.body ? document.body.innerText : '') : pick(main),
          extra: ${JSON.stringify(input.extraSelectors ?? [])}.map(pick),
        };
      })()`;
      const result = (await withTimeout(
        page.wc.executeJavaScriptInIsolatedWorld(WATCH_EXTRACT_WORLD_ID, [{ code: script }], false),
        WATCH_EXTRACT_TIMEOUT_MS,
        () => new AppError('BROWSER_NAVIGATION_FAILED', '读取页面文本超时'),
      )) as { title: string; text: string | null; extra: Array<string | null> };
      // A client-side redirect during the settle counts the same way.
      assertContent();
      if (result.text === null) {
        throw new AppError('BROWSER_SELECTOR_NOT_FOUND', `页面上找不到元素 ${input.selector ?? ''}`);
      }
      const truncated = result.text.length > WATCH_FETCH_TEXT_MAX_CHARS;
      return {
        ok: true,
        title: result.title,
        url: page.wc.getURL() || input.url,
        text: truncated ? result.text.slice(0, WATCH_FETCH_TEXT_MAX_CHARS) : result.text,
        ...(truncated ? { truncated: true } : {}),
        ...(input.extraSelectors !== undefined
          ? {
              extraTexts: result.extra.map((text) =>
                text === null ? null : text.slice(0, WATCH_FETCH_TEXT_MAX_CHARS),
              ),
            }
          : {}),
      };
    } finally {
      if (!page.closed) page.wc.removeListener('did-navigate', onNavigate);
    }
  }

  // --- internals --------------------------------------------------------------

  #pageOf(botId: string, conversationId: string): PageEntry {
    const page = this.#pages.get(pairKey(botId, conversationId));
    if (!page) {
      throw new AppError('BROWSER_PAGE_CLOSED', '浏览器页面未打开或已关闭');
    }
    return page;
  }

  #invalidateDocumentState(wc: WebContents): void {
    const page = this.#pagesByWebContents.get(wc.id);
    if (!page) return;
    page.refs = new Map();
    page.refsValid = false;
    page.navigationSeq += 1;
    page.domReady = false;
  }

  /** Clears a partition's storage + cache; `removeDir` also deletes it on disk. */
  async #wipePartition(partition: string, options: { removeDir: boolean }): Promise<void> {
    const target = session.fromPartition(partition);
    try {
      await target.clearStorageData();
      await target.clearCache();
    } catch {
      // Session may already be gone; the directory removal below still runs.
    }
    if (options.removeDir) {
      for (const dir of partitionDirs(this.#sessionRoot, partition)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  /** W8: a page input event → the lease (only while the viewer is open). */
  #userInput(wc: WebContents, kind: 'takeover' | 'activity' | null): void {
    if (kind === null) return;
    const page = this.#pagesByWebContents.get(wc.id);
    if (!page || page.closed) return;
    const viewer = this.#viewers.get(pairKey(page.botId, page.conversationId));
    if (viewer === undefined || viewer.win.isDestroyed() || !viewer.win.isVisible()) return;
    page.lease.userInput(kind);
  }

  /** W8: lease transition → toolbar redraw; a handback is reported to the core. */
  #controlChanged(key: string, control: PageControl, reason: HandbackReason | null): void {
    const viewer = this.#viewers.get(key);
    if (viewer !== undefined && !viewer.win.isDestroyed()) this.#renderToolbar(viewer, control);
    const page = this.#pages.get(key);
    if (control === 'agent' && reason !== null && page !== undefined && !page.closed) {
      this.#options.onControlReturned?.({
        botId: page.botId,
        conversationId: page.conversationId,
        reason,
      });
    }
  }

  #renderToolbar(viewer: Viewer, control: PageControl): void {
    try {
      void viewer.toolbar.webContents.loadURL(viewerToolbarUrl(viewer.labels, control)).catch(() => {});
    } catch {
      // Toolbar already destroyed.
    }
  }

  #sessionFor(partition: string): Session {
    const botSession = session.fromPartition(partition);
    if (!this.#configuredSessions.has(botSession)) {
      this.#configureSession(botSession);
      this.#configuredSessions.add(botSession);
    }
    return botSession;
  }

  #configureSession(botSession: Session): void {
    // Permission requests (notifications, geolocation, camera, …) are always
    // denied (docs 任务 1).
    botSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    botSession.setPermissionCheckHandler(() => false);

    // Network interception: every http(s) request of every bot page resolves
    // through DNS and any blocked address cancels it (docs 任务 2).
    botSession.webRequest.onBeforeRequest((details, callback) => {
      this.#intercept(details, callback);
    });

    botSession.on('will-download', (_event, item, contents) => {
      const page = this.#pagesByWebContents.get(contents.id);
      // W7: a watch's background page never downloads.
      if (!page || page.background) {
        item.cancel();
        return;
      }
      try {
        mkdirSync(page.downloadsDir, { recursive: true });
        item.setSavePath(uniqueDownloadPath(page.downloadsDir, item.getFilename()));
      } catch {
        item.cancel();
      }
    });
  }

  #intercept(
    details: { url: string; webContentsId?: number },
    callback: (response: { cancel?: boolean }) => void,
  ): void {
    let target: URL;
    try {
      target = new URL(details.url);
    } catch {
      callback({ cancel: true });
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      // about/blob/data never touch the network; everything else (file, ftp,
      // ws, …) is refused outright.
      const passthrough = ['about:', 'blob:', 'data:'].some((p) => target.protocol === p);
      callback({ cancel: !passthrough });
      return;
    }
    const page =
      details.webContentsId !== undefined
        ? this.#pagesByWebContents.get(details.webContentsId)
        : undefined;
    if (!page) {
      // Requests outside a tracked page (prefetchers, service workers) fail closed.
      callback({ cancel: true });
      return;
    }
    const host = target.hostname;
    const context = page.context;
    this.#dns
      .resolve(host)
      .then((addresses) =>
        decideBrowserRequest({ host, addresses, scheme: target.protocol, context }),
      )
      .catch(() => ({ action: 'cancel' as const, reason: 'unresolvable-host' as const }))
      .then((decision) => callback({ cancel: decision.action === 'cancel' }))
      .catch(() => callback({ cancel: true }));
  }

  async #load(page: PageEntry, url: string, timeoutMs = BROWSER_NAVIGATION_TIMEOUT_MS): Promise<void> {
    if (page.closed) throw pageClosed();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new AppError('BROWSER_NAVIGATION_FAILED', `打开页面超时（${timeoutMs / 1000} 秒）`));
      }, timeoutMs);
      const onFinished = () => {
        cleanup();
        resolve();
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onFailed = (_event: any, code: number, description: string, _url: unknown, isMainFrame: boolean) => {
        if (isMainFrame === false) return; // subframe failures don't end the navigation
        cleanup();
        // -20 ERR_BLOCKED_BY_CLIENT: our own network rules cancelled the load.
        reject(
          code === -20
            ? new AppError('BROWSER_BLOCKED', '该地址被网络规则拦截（内网地址，或未绑定 project 的本机地址）')
            : new AppError('BROWSER_NAVIGATION_FAILED', `页面加载失败：${description || code}`),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        page.wc.removeListener('did-finish-load', onFinished);
        page.wc.removeListener('did-fail-load', onFailed);
      };
      page.wc.on('did-finish-load', onFinished);
      page.wc.on('did-fail-load', onFailed);
      page.wc.loadURL(url).catch((error) => {
        // did-fail-load covers load errors; a destroyed target surfaces here.
        cleanup();
        reject(toPageError(error));
      });
    });
    await delay(250);
  }

  /** Waits for in-flight navigation to finish, plus a settle delay. */
  async #settle(page: PageEntry, timeoutMs = BROWSER_NAVIGATION_TIMEOUT_MS): Promise<void> {
    if (page.closed) throw pageClosed();
    if (!page.wc.isLoading()) {
      await delay(100);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(); // Proceed anyway; CDP commands will fail visibly if broken.
      }, timeoutMs);
      const onFinished = () => {
        cleanup();
        resolve();
      };
      const onFailed = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        page.wc.removeListener('did-finish-load', onFinished);
        page.wc.removeListener('did-fail-load', onFailed);
      };
      page.wc.on('did-finish-load', onFinished);
      page.wc.on('did-fail-load', onFailed);
    });
    if (page.closed) throw pageClosed();
    await delay(250);
  }

  /** DOM agent must be re-initialized per document before resolveNode works. */
  async #initDomAgent(page: PageEntry): Promise<void> {
    if (page.domReady) return;
    await this.#send(page, 'DOM.enable', {});
    await this.#send(page, 'DOM.getDocument', { depth: 1 });
    page.domReady = true;
  }

  #refNode(page: PageEntry, ref: string): RefFingerprint {
    if (!page.refsValid || page.refs.size === 0) {
      throw new AppError('BROWSER_REF_UNKNOWN', '没有可用的元素引用，请先获取快照');
    }
    const fingerprint = page.refs.get(ref);
    if (fingerprint === undefined) {
      throw new AppError('BROWSER_REF_UNKNOWN', `引用 ${ref} 不存在或已失效，请重新获取快照`);
    }
    return fingerprint;
  }

  /** The page operations the action flows (browser-actions.ts) drive. */
  #ops(botId: string, conversationId: string): PageOps {
    const page = this.#pageOf(botId, conversationId);
    // W8: refused before anything runs while the user has the page.
    page.lease.assertAgent();
    return {
      settle: (timeoutMs) => this.#settle(page, timeoutMs),
      initDom: () => this.#initDomAgent(page),
      // Key / wheel / text input the bot synthesizes is not the user's input.
      send: (method, params) =>
        method.startsWith('Input.')
          ? page.lease.withBotInput(() => this.#send(page, method, params))
          : this.#send(page, method, params),
      assertControl: () => page.lease.assertAgent(),
      refFingerprint: (ref) => this.#refNode(page, ref),
      navigationSeq: () => page.navigationSeq,
      canGoBack: () => page.wc.navigationHistory.canGoBack(),
      goBack: () => page.wc.navigationHistory.goBack(),
      delay,
    };
  }

  async #send(page: PageEntry, method: string, params: object): Promise<unknown> {
    if (page.closed) throw pageClosed();
    try {
      return await page.wc.debugger.sendCommand(method, params);
    } catch (error) {
      throw toPageError(error);
    }
  }

  async #title(page: PageEntry): Promise<string> {
    try {
      return await page.wc.executeJavaScript('document.title', true);
    } catch {
      return '';
    }
  }

  #destroyPage(page: PageEntry, options: { permanent: boolean }): void {
    if (page.closed) return;
    page.closed = true;
    const key = pairKey(page.botId, page.conversationId);
    this.#pages.delete(key);
    this.#pagesByWebContents.delete(page.wc.id);
    if (options.permanent) this.#tombstonedPairs.add(key);
    // The lease dies with the page: no idle timer, no handback report.
    page.lease.dispose();
    // A visible viewer must not outlive its page: close it first (its
    // 'closed' handler sees page.closed and skips re-adopting the view).
    const viewer = this.#viewers.get(key);
    if (viewer !== undefined && !viewer.win.isDestroyed()) viewer.win.close();
    this.#viewers.delete(key);
    try {
      page.wc.debugger.detach();
    } catch {
      // Not attached.
    }
    try {
      this.#hostWindow?.contentView.removeChildView(page.view);
    } catch {
      // Host window already gone.
    }
    try {
      page.wc.close();
    } catch {
      // Already destroyed.
    }
  }

  #hostWindowLazy(): BrowserWindow {
    if (this.#hostWindow === null || this.#hostWindow.isDestroyed()) {
      this.#hostWindow = new BrowserWindow({
        show: false,
        width: BROWSER_VIEWPORT_WIDTH,
        height: BROWSER_VIEWPORT_HEIGHT,
        webPreferences: { backgroundThrottling: false },
      });
    }
    return this.#hostWindow;
  }
}

/** W7: extra wait after the load event for client-rendered content. */
const WATCH_RENDER_SETTLE_MS = 1000;
/** W7: reading the page text may take at most this long. */
const WATCH_EXTRACT_TIMEOUT_MS = 10_000;
/**
 * W7: the isolated world the text extraction runs in (any id other than 0 =
 * the page's main world; Electron's preload isolation uses 999).
 */
const WATCH_EXTRACT_WORLD_ID = 1007;

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function pairKey(botId: string, conversationId: string): string {
  return `${botId}|${conversationId}`;
}

/** True when `url` parses and its scheme is http/https (navigate + popups). */
function httpHttpsUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
