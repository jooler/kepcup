import electronUpdater from 'electron-updater';
import { autoUpdater as nativeAutoUpdater } from 'electron';
import {
  UPDATE_CHECK_INITIAL_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateStatusPayload,
} from '@kepcup/shared';
import { UpdateGate } from './update-gate';
import { externalUpdateChannel } from './update-channel';
import {
  GITHUB_OWNER,
  GITHUB_REPO,
  createUpdateSourceSelector,
  updateSourcesFromEnv,
  type UpdateSource,
  type UpdateSourceStore,
} from './update-sources';
import { appendSkippedVersion, removeSkippedVersion, type UpdateSkipStore } from './update-skip';

// electron-updater is CommonJS and exposes autoUpdater via an
// Object.defineProperty getter, which Node's CJS named-export detection cannot
// see — an ESM named import would crash the main process at startup with
// "Named export 'autoUpdater' not found" before any handler runs.
const { autoUpdater } = electronUpdater;

/**
 * electron-updater integration (P13 任务 2, docs/design/09-tech-stack.md
 * "桌面壳：Electron"). Sits in the MAIN process; the core only answers the
 * gate's questions (update.activeRuns / update.cancelActive over port B).
 *
 * 更新源（可替换配置项）: 优先级从高到低——
 *   1. `KEPCUP_UPDATE_URL`：整源覆盖（generic HTTPS），设了就完全跳过选源；
 *   2. 多源探测（update-sources.ts）：GitHub Releases（烘焙的 app-update.yml，
 *      jooler/kepcup）→ R2 → OSS，按实际可达性选，赢家持久化到 userData；
 *   3. 什么都没配：只剩 GitHub，行为与单源时代完全一致。
 *
 * 本机/未发布状态: with no released version the feed returns 404/network
 * errors — every failure is logged and swallowed (phase 'error' → 'idle'),
 * never surfaced as a modal.
 */

export interface UpdateHost {
  /** Push a status snapshot to the renderer (ipcRenderer broadcast). */
  broadcast(channel: string, payload: UpdateStatusPayload): void;
  log(message: string, error?: unknown): void;
}

export interface UpdaterWiring {
  gate: UpdateGate;
  /** Manual re-check (settings/update UI action; failures are quiet). */
  checkNow(): Promise<void>;
  /** 「取消更新」：停下本次下载并把该版本记入跳过集合（相位守卫在 gate：
   * 只有 downloading 相位有效；跳过版本持久化，更新的版本恢复正常流程）。 */
  cancelDownload(): void;
  /** 「下载此版本」：把用户跳过的版本移出跳过集合并手动启动下载（设置页
   * 手动检查查到 available-skipped 后的显式入口）。失败经 { ok, message? }
   * 回传，由渲染层提示；相位守卫失败的过期点击按成功返回（no-op）。 */
  resumeSkippedDownload(version: string): Promise<{ ok: boolean; message?: string }>;
  dispose(): void;
}

const UPDATE_STATUS_CHANNEL = 'update:status';

/** Env override for the update feed (可替换配置项). */
export function updateFeedUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
  const url = env.KEPCUP_UPDATE_URL;
  return url !== undefined && url.length > 0 ? url : null;
}

/**
 * Distribution channels whose updates the platform owns. 判定实现放在
 * Electron-free 的 update-channel.ts（本文件会加载 electron-updater，不能单测）。
 */
export { externalUpdateChannel } from './update-channel';

export function wireUpdater(options: {
  host: UpdateHost;
  listActiveRuns: () => Promise<unknown[]>;
  cancelActiveRuns: (reason: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Test seam: skip the startup/interval checks (unit contexts). */
  scheduleChecks?: boolean;
  /** 选源赢家持久化（生产 = userData 文件，update-sources.ts）；缺省不持久化。 */
  store?: UpdateSourceStore;
  /** 「取消更新 = 跳过该版本」的持久化（生产 = userData 文件）；缺省不持久化。 */
  skipStore?: UpdateSkipStore;
  /** Test seam: probe timeout override (unit contexts). */
  probeTimeoutMs?: number;
  /**
   * Dev-only：未打包的 dev 壳里 electron-updater 会直接跳过检查（"Skip
   * checkForUpdates because application is not packed"）。置 true 即
   * `forceDevUpdateConfig = true`，让 dev 也能真查 feed——只做检查/下载可行，
   * 安装仍需要打包产物。由 index.ts 以 `KEPCUP_DEV_UPDATE_CHECK=1` 门控，
   * 平时 `pnpm dev` 不会后台偷跑更新下载。
   */
  forceDevUpdateConfig?: boolean;
  /**
   * Called when the updater is about to close the app's windows for install.
   * Electron's native autoUpdater (macOS Squirrel; electron-updater on all
   * platforms emits it too) closes windows BEFORE `before-quit`, so the
   * window-close handler would otherwise hide the main window and block the
   * restart. Main process uses this to flip its quitting flag first.
   */
  beforeQuitForUpdate?: () => void;
}): UpdaterWiring {
  const { host } = options;
  const external = externalUpdateChannel();
  const feedUrl = updateFeedUrlFromEnv(options.env ?? process.env);
  type Selector = ReturnType<typeof createUpdateSourceSelector>;
  let selector: Selector | null = null;
  if (external !== null) {
    // Store / Flatpak build: the gate stays wired (the ipc surface expects it)
    // but no feed is configured and nothing is ever checked — phase stays idle.
    host.log(`updates managed by ${external}; in-app updater disabled`);
  } else if (feedUrl !== null) {
    // 可替换更新源: generic HTTPS feed wins over everything (baked app-update.yml
    // and the multi-source probe below are both bypassed).
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    host.log(`update feed override: ${feedUrl}`);
  } else {
    // 多源探测选源（docs/dev/06-release.md「更新镜像与选源」）。
    selector = createUpdateSourceSelector({
      sources: () => updateSourcesFromEnv(options.env ?? process.env),
      store: options.store ?? { load: () => null, save: () => undefined, clear: () => undefined },
      probeTimeoutMs: options.probeTimeoutMs,
    });
  }
  // 自动下载关闭（下载中可见进度、可取消，见 runCheck/cancelDownload）：
  // update-available 后由 runCheck 拿 checkForUpdates 返回的 token 手动
  // downloadUpdate；决策相位的 sticky 语义不变（BR-P13-002）。
  autoUpdater.autoDownload = false;
  // Quitting the app normally also installs a downloaded update (belt and
  // braces alongside the explicit installNow path). 「取消的会话内不自动装」
  // 的临时保险在 cancelDownload 里置回 false，正常下载完成时恢复。
  autoUpdater.autoInstallOnAppQuit = true;
  if (options.forceDevUpdateConfig === true) {
    autoUpdater.forceDevUpdateConfig = true;
    host.log('dev update check forced (KEPCUP_DEV_UPDATE_CHECK=1)');
  }
  // electron-updater 默认静默；接上主进程日志，差量下载的块数/字节数才能被看到
  // （端到端验证与排障都靠它，docs/dev/06-release.md「自动更新端到端」）。
  const text = (message: unknown): string =>
    typeof message === 'string' ? message : String(message);
  autoUpdater.logger = {
    debug: (message?: unknown) => host.log(text(message)),
    info: (message?: unknown) => host.log(text(message)),
    warn: (message?: unknown) => host.log(text(message)),
    // electron-updater 的 Logger 接口只声明单参，但运行时会多传一个 error 实参。
    error: (message?: unknown, ...rest: unknown[]) => host.log(text(message), rest[0]),
  };

  const skipStore = options.skipStore ?? {
    load: (): string[] => [],
    save: () => undefined,
  };

  const gate = new UpdateGate({
    listActiveRuns: options.listActiveRuns,
    cancelActiveRuns: options.cancelActiveRuns,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    onStatus: (status) => host.broadcast(UPDATE_STATUS_CHANNEL, status),
    // 跨启动恢复的跳过版本（用户上次取消过的）：同名版本静默不下载。
    skippedVersions: skipStore.load(),
  });

  // macOS: quitAndInstall 走 Electron 原生 autoUpdater，先关窗口再发
  // before-quit（docs: autoUpdater 'before-quit-for-update'）；Windows/Linux:
  // electron-updater 在 app.quit() 前手动 emit 同一事件。两种路径都在窗口
  // 关闭前通知到宿主，否则主窗口的「关闭即隐藏」会卡住安装。
  if (options.beforeQuitForUpdate !== undefined) {
    nativeAutoUpdater?.on('before-quit-for-update', options.beforeQuitForUpdate);
  }

  let availableVersion: string | undefined;
  /** update-available 后待启动的下载版本（由 runCheck 消费）。 */
  let downloadRequest: string | null = null;
  /**
   * 本次 checkForUpdates 的模式：定时静默、手动检查可浮出被跳过的版本。事件
   * 处理器在 checkForUpdates 的 await 期间读取——checkQueue 串行化保证同一
   * 时刻只有一个 runCheck 在途，没有并发覆写。
   */
  let checkMode: 'manual' | 'scheduled' = 'scheduled';
  /**
   * 检查串行化队列：electron-updater 把并发 checkForUpdates 合并成同一
   * promise/事件流（结果与 update-available 等事件只发一次），并发调用读不到
   * 独立结果——排队串行执行，手动检查不被在途定时检查吞掉，检查也绝不与
   * 在途下载交错。队列元素吞错（runCheck 的错误由 checkQuietly 捕获上报）。
   */
  let checkQueue: Promise<unknown> = Promise.resolve();
  autoUpdater.on('checking-for-update', () => gate.onChecking());
  autoUpdater.on('update-available', (info) => {
    availableVersion = String(info.version);
    host.log(`update available: ${availableVersion}`);
    // gate 判定跳过集合：定时/自动检查对被用户取消过的版本静默忽略（否则
    // 24h 定时重查会立刻把同一版本下回来，「取消更新」名存实亡）；手动检查
    // 则切 available-skipped，让设置页提供「下载此版本」的显式入口。
    if (!gate.onUpdateAvailable(availableVersion, { manual: checkMode === 'manual' })) {
      host.log(
        `update skipped (user cancelled earlier${checkMode === 'manual' ? '; manual check' : ''}): ${availableVersion}`,
      );
      return;
    }
    // 手动下载不在事件里直接启动：downloadUpdate 需要 checkForUpdates 返回
    // 的 cancellationToken（该类不随 electron-updater 导出，跨包直引是幽灵
    // 依赖），由 runCheck 在检查返回后统一取 token 启动。
    downloadRequest = availableVersion;
  });
  // BR-P13-008: "no update" is a real result — the gate resolves checking →
  // idle so the manual check can settle event-driven (no wall-clock guess).
  autoUpdater.on('update-not-available', () => {
    host.log('update not available');
    gate.onUpToDate();
  });
  autoUpdater.on('download-progress', (progress) => {
    const percent = Number.isFinite(progress.percent)
      ? Math.min(100, Math.max(0, progress.percent))
      : undefined;
    if (availableVersion !== undefined) gate.onDownloading(availableVersion, percent);
    host.log(`download progress: ${Math.round(progress.percent)}%`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    host.log(`update downloaded: ${String(info.version)}`);
    // 「取消的会话内不自动装」的保险解除：一次新的完整下载回到默认语义。
    autoUpdater.autoInstallOnAppQuit = true;
    void gate.evaluate(String(info.version)).catch((error) => {
      host.log('update gate failed', error);
      gate.onError(error instanceof Error ? error.message : String(error));
    });
  });
  autoUpdater.on('error', (error) => {
    // Expected while no release exists (404 / ENOTFOUND). Silent for the user.
    host.log('updater error', error);
    gate.onError(error instanceof Error ? error.message : String(error));
  });

  const timers: NodeJS.Timeout[] = [];
  // e2e (NODE_ENV=test) never contacts the update feed: no check scheduling,
  // deterministic runs. The ipc surface stays available for tests.
  if (external === null && options.scheduleChecks !== false && process.env.NODE_ENV !== 'test') {
    const first = setTimeout(() => {
      void checkQuietly();
      const interval = setInterval(() => void checkQuietly(), UPDATE_CHECK_INTERVAL_MS);
      interval.unref?.();
      timers.push(interval);
    }, UPDATE_CHECK_INITIAL_DELAY_MS);
    first.unref?.();
    timers.push(first);
  }

  /** 把 autoUpdater 的源切到给定候选（github = 烘焙的 provider，镜像 = generic）。 */
  function applySource(source: UpdateSource): void {
    autoUpdater.setFeedURL(
      source.feedUrl === null
        ? { provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO }
        : { provider: 'generic', url: source.feedUrl },
    );
    host.log(`update source: ${source.id}`);
  }

  /** checkForUpdates 的返回：autoDownload=false 时 cancellationToken 未被自动
   * 下载占用，正是手动 downloadUpdate 需要传的取消句柄。 */
  type CheckResult = NonNullable<Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>>;
  type CheckToken = NonNullable<CheckResult['cancellationToken']>;
  /** 在途下载的取消句柄（cancelDownload 里取消）。 */
  let activeDownloadToken: CheckToken | null = null;
  /** 手动检查查到被跳过的版本时留下的句柄，供「下载此版本」恢复下载。 */
  let skippedResume: { version: string; token: CheckToken } | null = null;

  /** 入队一次检查（串行执行）；错误沿返回的 promise 交给调用方捕获。 */
  function queueCheck(mode: 'manual' | 'scheduled'): Promise<void> {
    const next = checkQueue.then(
      () => runCheck(mode),
      () => runCheck(mode),
    );
    checkQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * 检查更新；查到且未被跳过的更新由这里手动启动下载（autoDownload=false）。
   * 被跳过的版本只在手动检查时留下取消句柄（skippedResume）：设置页随后可
   * 经 resumeSkippedDownload 让用户显式启动该版本的下载。
   */
  async function runCheck(mode: 'manual' | 'scheduled'): Promise<void> {
    checkMode = mode;
    const result = await autoUpdater.checkForUpdates();
    const version = downloadRequest;
    if (result === null || !result.isUpdateAvailable) return;
    if (version !== null) {
      downloadRequest = null;
      // 决策相位（waiting/ready/awaiting）下 artifact 已下载完成，而定时重查
      // 仍会报 isUpdateAvailable——重复下载纯属浪费；只有真实 downloading
      // 相位才启动。
      if (gate.phase !== 'downloading') return;
      // resumeSkippedDownload 的恢复下载不经本队列：在途时不重复启动，否则
      // electron-updater 直接复用在途 promise、新 token 挂不上，「取消更新」
      // 就取消不到真实下载。
      if (activeDownloadToken !== null && !activeDownloadToken.cancelled) return;
      const token = result.cancellationToken;
      // 类型上可选（运行时 checkForUpdates 恒建 token）；万一未来实现不给，
      // 宁可静默不下载也不带 undefined 传参。
      if (token === undefined) return;
      activeDownloadToken = token;
      try {
        await autoUpdater.downloadUpdate(token);
      } catch (error) {
        if (token.cancelled) {
          // 用户取消：gate 已在 cancelDownload 里切回 idle；CancellationError 不
          // 进 autoUpdater 的 error 事件，这里静默吸收，不抖 error 相位。
          host.log(`update download cancelled: ${version}`);
        } else {
          host.log('update download failed', error);
          gate.onError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (activeDownloadToken === token) activeDownloadToken = null;
      }
      return;
    }
    // downloadRequest 为 null 但 feed 报有更新 → 该版本被跳过（gate 拦下了
    // 下载启动）。只留手动检查的句柄；定时检查保持完全静默（相位收敛由
    // gate 的 onUpdateAvailable 负责）。
    if (mode !== 'manual') return;
    const token = result.cancellationToken;
    if (token === undefined || availableVersion === undefined) return;
    skippedResume = { version: availableVersion, token };
  }

  /**
   * 「取消更新」：停下本次下载并把该版本记入跳过集合（相位守卫在 gate，仅
   * downloading 有效）。跳过集合持久化到 userData；出现更新的版本自动恢复
   * 正常流程。本会话内同时关掉 autoInstallOnAppQuit：取消后退出应用绝不把
   * 该版本自动装上（正常下载完成时恢复）。
   */
  function cancelDownload(): void {
    const version = gate.cancelDownload();
    if (version === undefined) return;
    // 迟到的 downloadRequest（update-available 已过、token 尚未取到时取消）。
    downloadRequest = null;
    appendSkippedVersion(skipStore, version);
    autoUpdater.autoInstallOnAppQuit = false;
    if (activeDownloadToken !== null) activeDownloadToken.cancel();
    host.log(`update cancelled by user: ${version} (skipped until a newer version)`);
  }

  /**
   * 「下载此版本」：用户在设置页对手动检查查到的被跳过版本显式点了下载。
   * gate 把版本移出跳过集合并切 downloading；持久化同步移除；会话内恢复
   * 「退出即装」（用户已重新选择要这个版本）。下载用手动检查留下的句柄
   * 直接启动；句柄不在（如重启后没查过就点）则重查一次——版本已出跳过
   * 集合，update-available 会照常自动启动下载。返回 { ok, message? } 给
   * 渲染层提示（BR-P13-008 失败可见）；相位守卫失败的过期点击是 no-op
   * （渲染层状态早已被状态推送纠正），按成功返回、不提示。
   */
  async function resumeSkippedDownload(
    version: string,
  ): Promise<{ ok: boolean; message?: string }> {
    if (!gate.resumeSkipped(version)) return { ok: true };
    removeSkippedVersion(skipStore, version);
    autoUpdater.autoInstallOnAppQuit = true;
    host.log(`update resumed by user: ${version}`);
    const stashed = skippedResume;
    if (stashed === null || stashed.version !== version) {
      await checkQuietly('manual');
      return { ok: true };
    }
    skippedResume = null;
    activeDownloadToken = stashed.token;
    try {
      await autoUpdater.downloadUpdate(stashed.token);
    } catch (error) {
      if (stashed.token.cancelled) {
        // 与 runCheck 同路：CancellationError 静默吸收（gate 已在 cancelDownload
        // 里切回 idle，这里不会走到——句柄只在用户主动取消时才 cancelled）。
        host.log(`update download cancelled: ${version}`);
        return { ok: true };
      }
      host.log('update download failed', error);
      gate.onError(error instanceof Error ? error.message : String(error));
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
      if (activeDownloadToken === stashed.token) activeDownloadToken = null;
    }
    return { ok: true };
  }

  async function checkQuietly(mode: 'manual' | 'scheduled' = 'scheduled'): Promise<void> {
    if (external !== null) return;
    if (selector === null) {
      try {
        await queueCheck(mode);
      } catch (error) {
        host.log('update check failed', error);
        gate.onError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const picked = await selector.pick();
    if (picked === null) {
      // 全部源不可达（典型：离线）。与既有的网络失败同路：log + error → idle，静默。
      host.log('update check skipped: no reachable source');
      gate.onError('所有更新源不可达');
      return;
    }
    try {
      applySource(picked);
      await queueCheck(mode);
    } catch (error) {
      // 先不进 error 相位：镜像回退成功时用户不应看到错误一闪而过。
      host.log(`update check failed via ${picked.id}`, error);
      // 持久化的赢家坏了（镜像下线 / 配置漂移）：忘掉它，探测其余源再试一次。
      const fallback = await selector.pickAfterFailure(picked.id).catch(() => null);
      const retryError = await (async (): Promise<unknown | null> => {
        if (fallback !== null && fallback.id !== picked.id) {
          try {
            applySource(fallback);
            await queueCheck(mode);
            return null;
          } catch (error2) {
            host.log(`update check failed via ${fallback.id}`, error2);
            return error2;
          }
        }
        return error;
      })();
      if (retryError !== null) {
        gate.onError(retryError instanceof Error ? retryError.message : String(retryError));
      }
    }
  }

  return {
    gate,
    checkNow: () => checkQuietly('manual'),
    cancelDownload,
    resumeSkippedDownload,
    dispose() {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      if (options.beforeQuitForUpdate !== undefined) {
        nativeAutoUpdater?.off('before-quit-for-update', options.beforeQuitForUpdate);
      }
    },
  };
}
