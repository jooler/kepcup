import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  session,
  webContents as allWebContents,
  webFrameMain,
  type Session,
  type WebContents,
} from 'electron';
import {
  BOT_WIDGET_HEIGHT_MAX,
  MCP_APP_SCHEME,
  WIDGET_PREVIEW_HOST_PREFIX,
  WIDGET_PREVIEW_SETTLE_MAX_MS,
  WIDGET_PREVIEW_VIEWPORT_TIMEOUT_MS,
  buildAppCspHeader,
  type WidgetPreviewRunInput,
  type WidgetPreviewRunOutput,
  type WidgetPreviewViewportResult,
} from '@kepcup/shared';
import { appUiResponseHeaders, parseAppUiUrl } from './apps-ui-policy';
import {
  PREVIEW_PARTITION,
  alignAcceptance,
  isPreviewRequestAllowed,
  isUniformBitmap,
  mergeConsoleFindings,
  newPreviewResource,
  pidAlive,
  probeVerdict,
  sanitizeLinks,
  sanitizeOutline,
  sanitizeProbeFindings,
  shouldBlockPreviewNavigation,
  timeoutFinding,
  unresponsiveFinding,
  type PreviewConsoleEntry,
} from './widget-preview-policy';
import { PREVIEW_FRAME_DEFAULT_HEIGHT, buildPreviewShellHtml } from './widget-preview-shell';

/**
 * S2 预览宿主（D87 P3b，设计 32 §11.9；实测依据见 todo/bot-widgets-authoring.md §8.1）：core 经端口 B
 * 调 `widgetPreview.run`，这里在一个复用的隐藏窗口里按正式卡片的条件真跑组件，回报结构化结果。
 *
 * - **环境**：`show:false` 的 BrowserWindow（离屏仍绘制，`capturePage` 含跨进程 iframe），独立内存分区
 *   `widget-preview`（无 `persist:`，不落盘）；窗口加载临时目录里的外壳页（`file://`，组件 CSP 的
 *   `frame-ancestors` 要求），外壳按 BotWidgetCard 的属性挂 iframe。特权协议 `kepcup-app` 的处理器
 *   注册在**这个分区的 session** 上（处理器必须在嵌入方窗口的 session 上），只服务本宿主内存里登记的
 *   预览资源，响应头同正式组件（`buildAppCspHeader` 空域 + `appUiResponseHeaders`）。
 * - **隔离**：权限一律拒绝、新窗口拒绝、下载取消、子框架除首次加载预览资源外不许导航、webRequest
 *   只放行外壳与预览资源。预览从不读真实库：能力桥是外壳页里的模拟（fixtures）。
 * - **时限与回收**：每个视口硬时限 {@link WIDGET_PREVIEW_VIEWPORT_TIMEOUT_MS}（探针的预算比它少留
 *   余量，正常总能先回报）。超时 → 让外壳移除 iframe（Chromium 3s 内回收组件进程），3s 后进程仍在就
 *   `process.kill(osProcessId)`（后台进行，不拖慢结果）；外壳本身不回应 → 销毁窗口、下次重建。
 *   不用 `forcefullyCrashRenderer`（实测杀的是外壳，之后重载失败）。组件进程中途消失 → `crashed`。
 * - **错误收集**：探针（结构化，带 trigger）+ 窗口 `console-message`（防篡改对照，并入探针漏掉的未捕获
 *   异常 / promise 拒绝 / CSP 违规）。
 * - **并发**：串行队列，一次一个预览。窗口不是应用主窗口（index.ts 只认自己持有的 `window`），
 *   应用退出时 {@link WidgetPreviewHost.dispose}。
 */

/** 窗口内容区：最宽视口（schema 上限 1600）+ 卡片最高高度。 */
const WINDOW_WIDTH = 1_620;
const WINDOW_HEIGHT = BOT_WIDGET_HEIGHT_MAX + 20;
/** 探针预算比硬时限少留的余量（回报 + 结果回传）。 */
const PROBE_MARGIN_MS = 1_200;
/** iframe `load` 之后等探针 `ready` 的宽限（探针的 DOM 静默上限 + 余量）。 */
const READY_GRACE_MS = WIDGET_PREVIEW_SETTLE_MAX_MS + 500;
/** 外壳页 / 组件框架应答探测的时限。 */
const SHELL_ANSWER_MS = 1_000;
const FRAME_ANSWER_MS = 500;
/** 移除 iframe 后等 Chromium 回收组件进程的时间，过了还在就杀。 */
const REAP_GRACE_MS = 3_000;
/** 截图首帧重试：间隔与上限。 */
const CAPTURE_RETRY_MS = 50;
const CAPTURE_MAX_MS = 1_000;
/**
 * 组件进程存活的轮询间隔。每次轮询顺带截一张 4×4 的图「推一帧」：隐藏窗口几乎不出帧，而跨进程
 * iframe 的尺寸（visual properties）要随父页面的渲染周期同步给组件进程——不推，组件文档在
 * 加载后的几百毫秒到一秒多里都是 0×0 视口（harness 实测：innerWidth 为 0、innerText 退化成含脚本
 * 源码的 textContent，体检与乱点全部失真）；`invalidate()` 实测无效，`capturePage` 会强制合成一帧。
 */
const CRASH_POLL_MS = 100;
/** 一个视口超时后的回收开销（移除 iframe / 重建窗口）；排队预算按「时限 + 回收」判断够不够跑。 */
const RECOVERY_MS = 1_500;
/** 外壳进程退出时 failed 结果的 detail 前缀（据此透明重试一次）。 */
const SHELL_EXITED = '预览外壳进程退出：';
/** 外壳临时目录的前缀；启动时清理崩溃遗留、超过一天的同前缀目录。 */
const TEMP_PREFIX = 'kepcup-widget-preview-';
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
/**
 * 预览分区的死代理（审查修复）：CSP 与请求白名单管不到 WebRTC 的 UDP（STUN / ICE）。预览会在用户
 * 确认之前跑 Bot 代码，所以给它一条硬的「无出网」：非代理 UDP 关掉、所有走网络栈的请求都指向一个
 * 不存在的代理（kepcup-app / file 不走网络栈，不受影响）。
 */
const DEAD_PROXY = 'http://127.0.0.1:9';

export interface WidgetPreviewHostOptions {
  /** 外壳页所在的临时目录根（缺省 `app.getPath('temp')`）。 */
  tempRoot?: string;
  /** 单视口硬时限（缺省 {@link WIDGET_PREVIEW_VIEWPORT_TIMEOUT_MS}；只给测试缩短）。 */
  viewportTimeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/** 外壳 `__kcPreview.run` 的返回。 */
interface ShellRunResult {
  probe: Record<string, unknown> | null;
  openedLinks: unknown;
  rect: { x: number; y: number; width: number; height: number };
  probeReady: boolean;
}

interface ShellDropStatus {
  stage: string | null;
  lastTrigger: string | null;
}

type DriveOutcome =
  | { kind: 'result'; value: ShellRunResult }
  | { kind: 'timeout' }
  | { kind: 'crashed'; detail: string }
  | { kind: 'shell-gone'; detail: string };

interface CurrentViewport {
  host: string;
  console: PreviewConsoleEntry[];
  framePid: number | null;
  shellGone: string | null;
  /** 截图握手里截到的图（加载完成、验收与乱点之前）。 */
  screenshot: string | undefined;
}

export class WidgetPreviewHost {
  readonly #options: WidgetPreviewHostOptions;
  readonly #timeoutMs: number;
  #queue: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #window: Promise<BrowserWindow> | null = null;
  #session: Session | null = null;
  #tempDir: string | null = null;
  #shellUrl: string | null = null;
  /** `${host}/${resourceId}` → 预览 HTML（视口结束即删）。 */
  readonly #resources = new Map<string, string>();
  #current: CurrentViewport | null = null;
  /** 外壳渲染进程在两次预览之间崩溃（render-process-gone 时没有进行中的视口）：下次先重建窗口。 */
  #shellCrashed = false;
  /** 进行中的视口的「立刻结束」（dispose 时调用：窗口被销毁时进行中的脚本调用不一定会 settle）。 */
  #abortDrive: ((detail: string) => void) | null = null;
  #proxyReady: Promise<void> | null = null;

  constructor(options: WidgetPreviewHostOptions = {}) {
    this.#options = options;
    this.#timeoutMs = options.viewportTimeoutMs ?? WIDGET_PREVIEW_VIEWPORT_TIMEOUT_MS;
  }

  /** 平台方法 `widgetPreview.run`：串行执行（排队），逐视口回报。 */
  run(input: WidgetPreviewRunInput): Promise<WidgetPreviewRunOutput> {
    if (this.#disposed) return Promise.reject(new Error('widget preview host disposed'));
    // 调用方的预算从收到请求起算（含排队）：等不及的视口不跑，不占队列，也不把宿主繁忙冒充成组件超时。
    const deadline = input.budgetMs !== undefined ? Date.now() + input.budgetMs : Infinity;
    const task = this.#queue.then(() => this.#runAll(input, deadline));
    this.#queue = task.catch(() => undefined);
    return task;
  }

  /** 应用退出：销毁窗口、删除外壳临时文件；之后的 run 一律拒绝。 */
  dispose(): void {
    this.#disposed = true;
    this.#abortDrive?.('预览宿主已关闭');
    void this.#destroyWindow();
    this.#resources.clear();
    if (this.#tempDir !== null) {
      try {
        rmSync(this.#tempDir, { recursive: true, force: true });
      } catch {
        // Temp dir cleanup is best effort.
      }
      this.#tempDir = null;
    }
  }

  async #runAll(input: WidgetPreviewRunInput, deadline: number): Promise<WidgetPreviewRunOutput> {
    const viewports: WidgetPreviewViewportResult[] = [];
    for (const viewport of input.viewports) {
      if (this.#disposed) {
        viewports.push(failed(viewport, '预览宿主已关闭'));
        continue;
      }
      if (deadline - Date.now() < this.#timeoutMs + RECOVERY_MS) {
        viewports.push(failed(viewport, '预览宿主繁忙（排队超时）'));
        continue;
      }
      try {
        let result = await this.#runViewport(viewport, input);
        // 外壳进程在这个视口里退出（与组件无关的宿主故障，例如两次预览之间崩溃、通知晚到）：
        // 在新窗口上透明重试一次，不把宿主的问题报给组件。
        if (
          result.status === 'failed' &&
          result.detail.startsWith(SHELL_EXITED) &&
          !this.#disposed &&
          deadline - Date.now() >= this.#timeoutMs + RECOVERY_MS
        ) {
          result = await this.#runViewport(viewport, input);
        }
        viewports.push(result);
        // 一个视口超时（死循环 / 长阻塞）：同一份代码换个视口照样会挂，不再白等第二个时限——
        // 两个视口各超时一次（约 2 × 9.5s）会顶到 core 的单次检查时限（20s）。
        if (result.status === 'timeout') break;
      } catch (error) {
        this.#log('widget preview viewport failed', error);
        viewports.push(failed(viewport, error instanceof Error ? error.message : String(error)));
      }
    }
    return { viewports };
  }

  async #runViewport(
    viewport: WidgetPreviewRunInput['viewports'][number],
    input: WidgetPreviewRunInput,
  ): Promise<WidgetPreviewViewportResult> {
    const win = await this.#ensureWindow();
    const wc = win.webContents;
    const resource = newPreviewResource();
    const key = `${resource.host}/${resource.resourceId}`;
    this.#resources.set(key, viewport.html);
    const current: CurrentViewport = {
      host: resource.host,
      console: [],
      framePid: null,
      shellGone: null,
      screenshot: undefined,
    };
    this.#current = current;
    const config = {
      url: resource.url,
      width: viewport.width,
      height: PREVIEW_FRAME_DEFAULT_HEIGHT,
      theme: viewport.theme,
      fixtures: input.fixtures,
      acceptance: input.acceptance ?? [],
      monkeyMax: input.monkeyMax,
      budgetMs: Math.max(1_000, this.#timeoutMs - PROBE_MARGIN_MS),
      readyGraceMs: READY_GRACE_MS,
      holdForCapture: input.screenshots,
    };
    try {
      const outcome = await this.#drive(wc, current, config);
      const base = { width: viewport.width, theme: viewport.theme };
      if (outcome.kind === 'result') {
        // console-message 与外壳的回报走不同的通道：给迟到的几条一点时间。
        await delay(50);
        const raw = outcome.value;
        const probe = raw.probe ?? {};
        const findings = mergeConsoleFindings(
          sanitizeProbeFindings(probe['findings']),
          current.console,
        );
        const screenshot = current.screenshot;
        await this.#dropFrame(wc);
        const verdict = probeVerdict({
          probeReady: raw.probeReady,
          viewport: probe['viewport'],
          error: probe['error'],
        });
        return {
          ...base,
          status: verdict.status,
          detail: verdict.detail,
          findings,
          acceptance: alignAcceptance(input.acceptance, probe['acceptance']),
          outline: sanitizeOutline(probe['outline']),
          openedLinks: sanitizeLinks(raw.openedLinks),
          ...(screenshot !== undefined ? { screenshot } : {}),
        };
      }
      if (outcome.kind === 'timeout') {
        return await this.#recoverFromTimeout(wc, current, base, input.acceptance);
      }
      // 组件进程消失 / 外壳进程消失：前者是组件的问题（core 记 runtime.error），后者是宿主的问题。
      if (outcome.kind === 'crashed') await this.#dropFrame(wc);
      else await this.#destroyWindow();
      return {
        ...base,
        status: outcome.kind === 'crashed' ? 'crashed' : 'failed',
        detail: outcome.detail,
        findings: mergeConsoleFindings([], current.console),
        acceptance: alignAcceptance(input.acceptance, null, '组件进程崩溃，未执行'),
        outline: '',
        openedLinks: [],
      };
    } finally {
      this.#resources.delete(key);
      if (this.#current === current) this.#current = null;
    }
  }

  /** 让外壳跑一个视口；与硬时限、组件进程存活、外壳进程存活三者竞速。 */
  async #drive(
    wc: WebContents,
    current: CurrentViewport,
    config: Record<string, unknown>,
  ): Promise<DriveOutcome> {
    const timers: NodeJS.Timeout[] = [];
    let pumping = false;
    try {
      return await new Promise<DriveOutcome>((resolve) => {
        // 配置以 JSON 文本交给 JSON.parse（而不是当对象字面量求值：`__proto__` 键不会变成原型）。
        const literal = JSON.stringify(JSON.stringify(config));
        wc.executeJavaScript(`window.__kcPreview.run(JSON.parse(${literal}))`).then(
          // 被 drop() 提前结束的运行回 null（只会发生在已超时 / 已结束之后，这里只是兜底）。
          (value: unknown) =>
            resolve(
              value !== null && typeof value === 'object'
                ? { kind: 'result', value: value as ShellRunResult }
                : { kind: 'shell-gone', detail: '预览外壳没有返回结果' },
            ),
          (error: unknown) =>
            resolve({
              kind: 'shell-gone',
              detail: `预览外壳执行失败：${error instanceof Error ? error.message : String(error)}`,
            }),
        );
        timers.push(setTimeout(() => resolve({ kind: 'timeout' }), this.#timeoutMs));
        this.#abortDrive = (detail) => resolve({ kind: 'shell-gone', detail });
        if (config['holdForCapture'] === true) void this.#captureHandshake(wc, current);
        const poll = (): void => {
          if (!pumping) {
            pumping = true;
            wc.capturePage({ x: 0, y: 0, width: 4, height: 4 }).then(
              () => (pumping = false),
              () => (pumping = false),
            );
          }
          if (current.shellGone !== null) {
            resolve({ kind: 'shell-gone', detail: `${SHELL_EXITED}${current.shellGone}` });
            return;
          }
          const pid = this.#framePid(wc, current.host);
          if (pid !== null) current.framePid = pid;
          if (current.framePid !== null && !pidAlive(current.framePid)) {
            resolve({ kind: 'crashed', detail: '组件进程在预览中途退出' });
            return;
          }
          timers.push(setTimeout(poll, CRASH_POLL_MS));
        };
        poll();
      });
    } finally {
      this.#abortDrive = null;
      for (const timer of timers) clearTimeout(timer);
    }
  }

  /** 截图握手：外壳在 ready 后停住 → 截 iframe → go() 继续验收与乱点。任何一步失败都不截图、照常继续。 */
  async #captureHandshake(wc: WebContents, current: CurrentViewport): Promise<void> {
    try {
      const rect = (await wc.executeJavaScript('window.__kcPreview.whenReady()')) as
        ShellRunResult['rect'] | null;
      if (rect !== null && this.#current === current)
        current.screenshot = await this.#capture(wc, rect);
    } catch (error) {
      this.#log('widget preview capture handshake failed', error);
    } finally {
      try {
        await wc.executeJavaScript('window.__kcPreview.go()');
      } catch {
        // Shell gone: the drive loop reports it.
      }
    }
  }

  /**
   * 超时：先分清是「组件卡死」还是「页面一直不回报」（组件框架还能应答：长任务占满事件循环，或组件
   * 弄坏了探针——对用户同样是卡，记阻断的 preview.timeout，保留 console-message 兜到的问题），再回收：
   * 外壳移除 iframe → 3s 后补刀；外壳本身不应答 → 那是宿主的问题（failed），重建窗口。
   */
  async #recoverFromTimeout(
    wc: WebContents,
    current: CurrentViewport,
    base: Pick<WidgetPreviewViewportResult, 'width' | 'theme'>,
    acceptance: WidgetPreviewRunInput['acceptance'],
  ): Promise<WidgetPreviewViewportResult> {
    const pid = this.#framePid(wc, current.host) ?? current.framePid;
    const frameAnswers = await this.#frameAnswers(wc, current.host);
    const status = await withTimeout(
      wc.executeJavaScript('window.__kcPreview.drop()') as Promise<ShellDropStatus>,
      SHELL_ANSWER_MS,
    ).catch(() => null);
    if (status === null) {
      this.#log('widget preview shell unresponsive; recreating the window');
      await this.#destroyWindow();
      if (pid !== null) this.#kill(pid, null);
    } else if (pid !== null) {
      this.#scheduleReap(pid, wc);
    }
    const consoleFindings = mergeConsoleFindings([], current.console);
    if (status === null) {
      // 组件跑在独立进程里，外壳不应答说明是宿主自己出了问题：不记到组件头上。
      return {
        ...failed(base, '预览外壳无响应，窗口已重建'),
        findings: consoleFindings,
      };
    }
    if (frameAnswers) {
      return {
        ...base,
        status: 'timeout',
        detail: '页面在时限内没有完成检查（仍能应答）',
        findings: [
          unresponsiveFinding({ timeoutMs: this.#timeoutMs, lastTrigger: status.lastTrigger }),
          ...consoleFindings,
        ].slice(0, 200),
        acceptance: alignAcceptance(acceptance, null, '页面无响应，未执行完'),
        outline: '',
        openedLinks: [],
      };
    }
    return {
      ...base,
      status: 'timeout',
      detail: '',
      findings: [
        timeoutFinding({
          timeoutMs: this.#timeoutMs,
          stage: status.stage,
          lastTrigger: status.lastTrigger,
        }),
        ...consoleFindings,
      ].slice(0, 200),
      acceptance: [],
      outline: '',
      openedLinks: [],
    };
  }

  /** 组件框架能否在短时限内执行一句脚本（卡死的进程不会应答）。 */
  async #frameAnswers(wc: WebContents, host: string): Promise<boolean> {
    const frame = this.#frame(wc, host);
    if (frame === null) return false;
    const answer = await withTimeout(
      frame.executeJavaScript('1') as Promise<unknown>,
      FRAME_ANSWER_MS,
    ).catch(() => null);
    return answer === 1;
  }

  #frame(wc: WebContents, host: string): Electron.WebFrameMain | null {
    try {
      const prefix = `${MCP_APP_SCHEME}://${host}/`;
      return wc.mainFrame.framesInSubtree.find((frame) => frame.url.startsWith(prefix)) ?? null;
    } catch {
      return null;
    }
  }

  #framePid(wc: WebContents, host: string): number | null {
    try {
      const frame = this.#frame(wc, host);
      if (frame === null) return null;
      const pid = frame.osProcessId;
      return pid > 0 && pid !== wc.mainFrame.osProcessId ? pid : null;
    } catch {
      return null;
    }
  }

  /** 移除 iframe 后等 Chromium 自己回收；{@link REAP_GRACE_MS} 后还在就杀（后台，不阻塞结果）。 */
  #scheduleReap(pid: number, wc: WebContents): void {
    let shellPid: number | null = null;
    try {
      shellPid = wc.mainFrame.osProcessId;
    } catch {
      shellPid = null;
    }
    const timer = setTimeout(() => this.#kill(pid, shellPid), REAP_GRACE_MS);
    timer.unref();
  }

  /**
   * 只杀「确实是本应用的渲染进程、且不是外壳 / 主进程」的 pid：pid 在 3s 里被系统复用的极端情况
   * 下，app 指标里找不到它就不动。
   */
  #kill(pid: number, shellPid: number | null): void {
    if (pid === process.pid || pid === shellPid || !pidAlive(pid)) return;
    const ours = app.getAppMetrics().some((metric) => metric.pid === pid && metric.type === 'Tab');
    if (!ours || this.#hostsLiveFrame(pid)) return;
    try {
      process.kill(pid, 'SIGKILL');
      this.#log(`widget preview: killed hung widget process ${pid}`);
    } catch (error) {
      this.#log('widget preview: kill failed', error);
    }
  }

  /**
   * 这个 pid 眼下是否还承载着任何活着的框架（审查修复）：3s 宽限里 pid 可能被系统复用给我们自己的
   * 另一个渲染进程（Windows 复用得快），那时绝不能杀。
   */
  #hostsLiveFrame(pid: number): boolean {
    try {
      return allWebContents.getAllWebContents().some(
        (contents) =>
          !contents.isDestroyed() &&
          contents.mainFrame.framesInSubtree.some((frame) => {
            try {
              return frame.osProcessId === pid;
            } catch {
              return false;
            }
          }),
      );
    } catch {
      // Can't tell: don't kill.
      return true;
    }
  }

  /** 正常结束：外壳移除 iframe（组件进程随之回收）。外壳不应答就重建窗口。 */
  async #dropFrame(wc: WebContents): Promise<void> {
    const ok = await withTimeout(
      wc.executeJavaScript('window.__kcPreview.drop()') as Promise<unknown>,
      SHELL_ANSWER_MS,
    )
      .then(() => true)
      .catch(() => false);
    if (!ok) await this.#destroyWindow();
  }

  /** 截取 iframe 矩形；整幅一个颜色（首帧未合成）时每 50ms 重试，至多 1s。 */
  async #capture(wc: WebContents, rect: ShellRunResult['rect']): Promise<string | undefined> {
    const area = {
      x: Math.max(0, Math.floor(rect.x)),
      y: Math.max(0, Math.floor(rect.y)),
      width: Math.min(WINDOW_WIDTH, Math.ceil(rect.width)),
      height: Math.min(WINDOW_HEIGHT, Math.ceil(rect.height)),
    };
    if (area.width <= 0 || area.height <= 0) return undefined;
    const deadline = Date.now() + CAPTURE_MAX_MS;
    let image: Electron.NativeImage | null = null;
    try {
      for (;;) {
        image = await wc.capturePage(area);
        if (!image.isEmpty() && !isUniformBitmap(image.toBitmap())) break;
        if (Date.now() + CAPTURE_RETRY_MS > deadline) break;
        await delay(CAPTURE_RETRY_MS);
      }
    } catch (error) {
      this.#log('widget preview capture failed', error);
    }
    return image !== null && !image.isEmpty() ? image.toPNG().toString('base64') : undefined;
  }

  async #ensureWindow(): Promise<BrowserWindow> {
    if (this.#window !== null) {
      const existing = await this.#window.catch(() => null);
      if (
        existing !== null &&
        !existing.isDestroyed() &&
        !this.#shellCrashed &&
        !existing.webContents.isCrashed()
      ) {
        return existing;
      }
      if (existing !== null && !existing.isDestroyed()) existing.destroy();
    }
    this.#shellCrashed = false;
    const created = this.#createWindow();
    this.#window = created;
    try {
      return await created;
    } catch (error) {
      if (this.#window === created) this.#window = null;
      throw error;
    }
  }

  async #createWindow(): Promise<BrowserWindow> {
    const shellPath = this.#shellPath();
    this.#prepareSession();
    await this.#proxyReady;
    const win = new BrowserWindow({
      show: false,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      useContentSize: true,
      skipTaskbar: true,
      webPreferences: {
        partition: PREVIEW_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: false,
      },
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-frame-navigate', (event) => {
      let frameUrl: string | undefined;
      try {
        frameUrl = event.frame?.url;
      } catch {
        frameUrl = undefined;
      }
      if (
        shouldBlockPreviewNavigation({
          isMainFrame: event.isMainFrame,
          frameUrl,
          targetUrl: event.url,
          shellUrl: this.#shellUrl,
        })
      ) {
        event.preventDefault();
      }
    });
    wc.on('console-message', (event) => {
      const current = this.#current;
      if (current === null || event.level !== 'error') return;
      let source: string;
      try {
        source = event.frame?.url ?? '';
      } catch {
        source = '';
      }
      if (source === '') source = event.sourceId;
      if (!source.startsWith(`${MCP_APP_SCHEME}://${current.host}/`)) return;
      if (current.console.length < 200) {
        current.console.push({
          level: event.level,
          message: String(event.message),
          line: event.lineNumber,
        });
      }
    });
    // 组件框架提交导航时立刻记下它的进程（不等轮询：进程可能在两次轮询之间就没了）。
    wc.on(
      'did-frame-navigate',
      (_event, url, _code, _status, isMainFrame, frameProcessId, frameRoutingId) => {
        const current = this.#current;
        if (isMainFrame || current === null) return;
        if (!url.startsWith(`${MCP_APP_SCHEME}://${current.host}/`)) return;
        try {
          const pid = webFrameMain.fromId(frameProcessId, frameRoutingId)?.osProcessId ?? 0;
          if (pid > 0 && pid !== wc.mainFrame.osProcessId) current.framePid = pid;
        } catch {
          // Frame already gone; polling covers it.
        }
      },
    );
    wc.on('render-process-gone', (_event, details) => {
      if (this.#current !== null) this.#current.shellGone = details.reason;
      else this.#shellCrashed = true;
    });
    // WebRTC 只许走代理（代理是死的）：没有 UDP 出网。
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    try {
      if (this.#disposed) throw new Error('widget preview host disposed');
      await win.loadFile(shellPath);
      if (this.#disposed) throw new Error('widget preview host disposed');
      const ready = (await wc.executeJavaScript(
        "typeof window.__kcPreview === 'object' && window.__kcPreview !== null",
      )) as unknown;
      if (ready !== true) throw new Error('预览外壳页没有就绪');
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
    return win;
  }

  async #destroyWindow(): Promise<void> {
    const pending = this.#window;
    this.#window = null;
    const win = pending === null ? null : await pending.catch(() => null);
    if (win !== null && !win.isDestroyed()) win.destroy();
  }

  /** 外壳页写进临时目录一次（之后复用）。 */
  #shellPath(): string {
    if (this.#tempDir === null || !existsSync(this.#tempDir)) {
      const root = this.#options.tempRoot ?? app.getPath('temp');
      if (this.#tempDir === null) sweepStaleTempDirs(root);
      this.#tempDir = mkdtempSync(join(root, TEMP_PREFIX));
      this.#shellUrl = null;
    }
    const shellPath = join(this.#tempDir, 'shell.html');
    // 临时目录可能被系统清理工具删掉：文件不在就重写（URL 随之更新）。
    if (this.#shellUrl === null || !existsSync(shellPath)) {
      writeFileSync(shellPath, buildPreviewShellHtml(), 'utf8');
      this.#shellUrl = pathToFileURL(shellPath).href;
    }
    return shellPath;
  }

  /** 分区 session 的一次性装配：权限、下载、请求白名单与预览资源的协议处理器。 */
  #prepareSession(): void {
    if (this.#session !== null) return;
    const ses = session.fromPartition(PREVIEW_PARTITION);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    this.#proxyReady = ses
      .setProxy({ proxyRules: DEAD_PROXY, proxyBypassRules: '' })
      .catch((error: unknown) => this.#log('widget preview proxy setup failed', error));
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isPreviewRequestAllowed(details.url, this.#shellUrl) });
    });
    const headers = appUiResponseHeaders(
      buildAppCspHeader({ connectDomains: [], resourceDomains: [] }),
    );
    ses.protocol.handle(MCP_APP_SCHEME, (request) => {
      const ref = request.method === 'GET' ? parseAppUiUrl(request.url) : null;
      const html =
        ref !== null && ref.host.startsWith(WIDGET_PREVIEW_HOST_PREFIX)
          ? this.#resources.get(`${ref.host}/${ref.resourceId}`)
          : undefined;
      if (html === undefined) return new Response('not found', { status: 404 });
      return new Response(html, { status: 200, headers });
    });
    this.#session = ses;
  }

  #log(message: string, error?: unknown): void {
    if (this.#options.log !== undefined) this.#options.log(message, error);
    else {
      const detail = error instanceof Error ? ` — ${error.message}` : '';
      console.warn(`[widget-preview] ${message}${detail}`);
    }
  }
}

/** 清理崩溃遗留的外壳临时目录（只动本前缀、超过一天的）。 */
function sweepStaleTempDirs(root: string): void {
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const dir = join(root, name);
      try {
        if (Date.now() - statSync(dir).mtimeMs > STALE_TEMP_MS)
          rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  } catch {
    // Unreadable temp root: nothing to sweep.
  }
}

function failed(
  viewport: Pick<WidgetPreviewViewportResult, 'width' | 'theme'>,
  detail: string,
): WidgetPreviewViewportResult {
  return {
    width: viewport.width,
    theme: viewport.theme,
    status: 'failed',
    detail: detail.slice(0, 500),
    findings: [],
    acceptance: [],
    outline: '',
    openedLinks: [],
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
