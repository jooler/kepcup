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
  AppError,
  buildSnapshotSummary,
  decideBrowserRequest,
  type AxtreeNode,
  type BrowserNetworkContext,
  type BrowserSnapshotOutput,
} from '@kepcup/shared';
import {
  BrowserWindow,
  WebContentsView,
  session,
  type Session,
  type WebContents,
} from 'electron';
import { HostDnsResolver } from './dns-resolver.js';
import { uniqueDownloadPath } from './download-name.js';

/**
 * Hosts one bot browser page per "bot + conversation" (docs/dev/phases/
 * P11-browser.md 任务 1): each bot gets the isolated `persist:bot-{botId}`
 * partition, pages are WebContentsViews in one hidden (offscreen but painting)
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
  view: WebContentsView;
  wc: WebContents;
  context: BrowserNetworkContext;
  downloadsDir: string;
  /** ref → backendNodeId, valid until the next navigation or snapshot. */
  refs: Map<string, number>;
  refsValid: boolean;
  /** DOM agent re-initialized for the current document. */
  domReady: boolean;
  closed: boolean;
}

export function sessionDataRoot(env: NodeJS.ProcessEnv): string {
  const home = env['KEPCUP_HOME'] ?? path.join(homedir(), '.kepcup');
  return path.join(home, 'browser');
}

/** Electron keeps one partition's disk state under `Partitions/{name}`. */
export function partitionDir(root: string, botId: string): string {
  return path.join(root, 'Partitions', `bot-${botId}`);
}

/**
 * Typing keys for browser_press, mapped to CDP Input.dispatchKeyEvent fields.
 * `key` is the DOM key value — CDP has no `keyCode` param, and a key event
 * without `key` never runs Chromium's default actions. Enter carries text
 * "\r" (Playwright's shape): the renderer generates the keypress/char from
 * the text, and implicit form submission only runs from that path.
 */
const KEY_EVENTS: Record<
  string,
  { key: string; code: string; windowsVirtualKeyCode: number; text?: string }
> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
};

export class BrowserHost {
  readonly #sessionRoot: string;
  #hostWindow: BrowserWindow | null = null;
  readonly #pages = new Map<string, PageEntry>();
  readonly #pagesByWebContents = new Map<number, PageEntry>();
  readonly #configuredSessions = new Set<Session>();
  readonly #dns = new HostDnsResolver();
  readonly #tombstonedBots = new Set<string>();
  readonly #tombstonedPairs = new Set<string>();
  /** Per-page visible viewer windows (ipc browser.show, docs 任务 5). */
  readonly #viewers = new Map<string, BrowserWindow>();

  constructor(env: NodeJS.ProcessEnv) {
    this.#sessionRoot = sessionDataRoot(env);
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
    const existing = this.#pages.get(key);
    if (existing) {
      existing.context = input.networkContext;
      existing.downloadsDir = input.downloadsDir;
      return { ok: true };
    }
    this.#sessionFor(input.botId);
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:bot-${input.botId}`,
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
    try {
      wc.debugger.attach('1.3');
    } catch {
      // Already attached (should not happen for a fresh view).
    }
    this.#hostWindowLazy().contentView.addChildView(view);

    const page: PageEntry = {
      botId: input.botId,
      conversationId: input.conversationId,
      view,
      wc,
      context: input.networkContext,
      downloadsDir: input.downloadsDir,
      refs: new Map(),
      refsValid: false,
      domReady: false,
      closed: false,
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
  show(input: { botId: string; conversationId: string; title?: string }): { ok: true } {
    const page = this.#pageOf(input.botId, input.conversationId);
    const key = pairKey(input.botId, input.conversationId);
    const existing = this.#viewers.get(key);
    if (existing !== undefined && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return { ok: true };
    }
    const win = new BrowserWindow({
      width: BROWSER_VIEWPORT_WIDTH,
      height: BROWSER_VIEWPORT_HEIGHT,
      title: input.title && input.title.length > 0 ? input.title : 'Bot 浏览器',
      autoHideMenuBar: true,
    });
    win.contentView.addChildView(page.view);
    const fit = (): void => {
      if (page.closed) return;
      // contentView.bounds is undefined before first layout — the window API
      // always answers (fit() runs synchronously inside show()).
      const { width, height } = win.getContentBounds();
      page.view.setBounds({ x: 0, y: 0, width, height });
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
      this.#viewers.delete(key);
      if (page.closed) return;
      this.#hostWindowLazy().contentView.addChildView(page.view);
      page.view.setBounds({
        x: 0,
        y: 0,
        width: BROWSER_VIEWPORT_WIDTH,
        height: BROWSER_VIEWPORT_HEIGHT,
      });
    });
    this.#viewers.set(key, win);
    return { ok: true };
  }


  async navigate(input: { botId: string; conversationId: string; url: string }): Promise<{
    ok: true;
    title: string;
    url: string;
  }> {
    const page = this.#pageOf(input.botId, input.conversationId);
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
    page.refs = summary.refs;
    page.refsValid = true;
    return {
      title: await this.#title(page),
      url: page.wc.getURL(),
      elements: summary.elements,
      elementsTruncated: summary.elementsTruncated,
      text: summary.text,
      textTruncated: summary.textTruncated,
    };
  }

  async click(input: { botId: string; conversationId: string; ref: string }): Promise<{ ok: true }> {
    const page = this.#pageOf(input.botId, input.conversationId);
    const backendNodeId = this.#refNode(page, input.ref);
    await this.#settle(page);
    await this.#initDomAgent(page);
    await this.#withElement(page, backendNodeId, (objectId) =>
      this.#send(page, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration:
          'function () { this.scrollIntoView({ block: "center" }); this.click(); }',
      }),
    );
    // A click may navigate; give the load a bounded window before returning.
    await this.#settle(page, 5_000);
    return { ok: true };
  }

  async type(input: {
    botId: string;
    conversationId: string;
    ref: string;
    text: string;
  }): Promise<{ ok: true }> {
    const page = this.#pageOf(input.botId, input.conversationId);
    const backendNodeId = this.#refNode(page, input.ref);
    await this.#settle(page);
    await this.#initDomAgent(page);
    await this.#withElement(page, backendNodeId, (objectId) =>
      this.#send(page, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration:
          'function () { this.focus(); if (typeof this.select === "function") this.select(); }',
      }),
    );
    if (input.text.length > 0) {
      await this.#send(page, 'Input.insertText', { text: input.text });
    }
    await delay(100);
    return { ok: true };
  }

  async press(input: { botId: string; conversationId: string; key: string }): Promise<{ ok: true }> {
    const page = this.#pageOf(input.botId, input.conversationId);
    const keyEvent = KEY_EVENTS[input.key];
    if (!keyEvent) throw new AppError('INVALID_INPUT', `不支持的按键：${input.key}`);
    await this.#settle(page);
    // The exact event shape Playwright presses keys with: text-bearing keys
    // must dispatch as type "keyDown" (rawKeyDown never yields a keypress),
    // and keyUp repeats key/code/virtualKey without the text.
    await this.#send(page, 'Input.dispatchKeyEvent', {
      type: keyEvent.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...keyEvent,
    });
    await this.#send(page, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyEvent.key,
      code: keyEvent.code,
      windowsVirtualKeyCode: keyEvent.windowsVirtualKeyCode,
    });
    // Enter/Tab commonly navigate or move focus.
    await this.#settle(page, 5_000);
    return { ok: true };
  }

  async scroll(input: {
    botId: string;
    conversationId: string;
    direction: 'up' | 'down';
    amount: number;
  }): Promise<{ ok: true }> {
    const page = this.#pageOf(input.botId, input.conversationId);
    await this.#settle(page);
    await this.#send(page, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.floor(BROWSER_VIEWPORT_WIDTH / 2),
      y: Math.floor(BROWSER_VIEWPORT_HEIGHT / 2),
      deltaX: 0,
      deltaY: input.direction === 'down' ? input.amount : -input.amount,
    });
    await delay(150);
    return { ok: true };
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

  async back(input: { botId: string; conversationId: string }): Promise<{ ok: true }> {
    const page = this.#pageOf(input.botId, input.conversationId);
    await this.#settle(page);
    const history = page.wc.navigationHistory;
    if (!history.canGoBack()) {
      throw new AppError('INVALID_INPUT', '没有上一页可以返回');
    }
    history.goBack();
    await this.#settle(page, BROWSER_NAVIGATION_TIMEOUT_MS);
    return { ok: true };
  }

  async close(input: {
    botId: string;
    conversationId: string;
    permanent?: boolean;
  }): Promise<{ ok: true }> {
    const key = pairKey(input.botId, input.conversationId);
    const page = this.#pages.get(key);
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
    for (const page of [...this.#pages.values()]) {
      if (page.botId === input.botId) this.#destroyPage(page, { permanent: false });
    }
    this.#tombstonedBots.add(input.botId);
    const dir = partitionDir(this.#sessionRoot, input.botId);
    const botSession = session.fromPartition(`persist:bot-${input.botId}`);
    try {
      await botSession.clearStorageData();
      await botSession.clearCache();
    } catch {
      // Session may already be gone; the directory removal below still runs.
    }
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
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
    page.domReady = false;
  }

  #sessionFor(botId: string): Session {
    const botSession = session.fromPartition(`persist:bot-${botId}`);
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
      if (!page) {
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

  #refNode(page: PageEntry, ref: string): number {
    if (!page.refsValid || page.refs.size === 0) {
      throw new AppError('BROWSER_REF_UNKNOWN', '没有可用的元素引用，请先获取快照');
    }
    const nodeId = page.refs.get(ref);
    if (nodeId === undefined) {
      throw new AppError('BROWSER_REF_UNKNOWN', `引用 ${ref} 不存在或已失效，请重新获取快照`);
    }
    return nodeId;
  }

  async #withElement(
    page: PageEntry,
    backendNodeId: number,
    fn: (objectId: string) => Promise<unknown>,
  ): Promise<void> {
    const resolved = (await this.#send(page, 'DOM.resolveNode', { backendNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new AppError('BROWSER_REF_UNKNOWN', '元素已不可用，请重新获取快照');
    try {
      await fn(objectId);
    } catch (error) {
      throw toPageError(error);
    }
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
    // A visible viewer must not outlive its page: close it first (its
    // 'closed' handler sees page.closed and skips re-adopting the view).
    const viewer = this.#viewers.get(key);
    if (viewer !== undefined && !viewer.isDestroyed()) viewer.close();
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

function pairKey(botId: string, conversationId: string): string {
  return `${botId}|${conversationId}`;
}

function pageClosed(): AppError {
  return new AppError('BROWSER_PAGE_CLOSED', '浏览器页面已关闭');
}


function toPageError(error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error);
  if (/target closed|detached|destroyed/i.test(message)) {
    return pageClosed();
  }
  if (error instanceof AppError) return error;
  return new AppError('INTERNAL', message);
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
