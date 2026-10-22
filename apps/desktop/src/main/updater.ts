import electronUpdater from 'electron-updater';
import {
  UPDATE_CHECK_INITIAL_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateStatusPayload,
} from '@kepcup/shared';
import { UpdateGate } from './update-gate';
import {
  GITHUB_OWNER,
  GITHUB_REPO,
  createUpdateSourceSelector,
  updateSourcesFromEnv,
  type UpdateSource,
  type UpdateSourceStore,
} from './update-sources';

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
  dispose(): void;
}

const UPDATE_STATUS_CHANNEL = 'update:status';

/** Env override for the update feed (可替换配置项). */
export function updateFeedUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
  const url = env.KEPCUP_UPDATE_URL;
  return url !== undefined && url.length > 0 ? url : null;
}

/**
 * Distribution channels whose updates the platform owns (docs/dev/06-release.md
 * 「各渠道的更新方式」): Microsoft Store (MSIX), Mac App Store and Flatpak
 * (Flathub). There electron-updater must never run — it cannot replace a
 * store-signed or sandboxed install, and a GitHub feed would fight the store.
 */
export function externalUpdateChannel(
  proc: { windowsStore?: boolean; mas?: boolean; env: NodeJS.ProcessEnv } = process,
): 'microsoft-store' | 'mac-app-store' | 'flatpak' | null {
  if (proc.windowsStore === true) return 'microsoft-store';
  if (proc.mas === true) return 'mac-app-store';
  if (proc.env.FLATPAK_ID !== undefined && proc.env.FLATPAK_ID.length > 0) return 'flatpak';
  return null;
}

export function wireUpdater(options: {
  host: UpdateHost;
  listActiveRuns: () => Promise<unknown[]>;
  cancelActiveRuns: (reason: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Test seam: skip the startup/interval checks (unit contexts). */
  scheduleChecks?: boolean;
  /** 选源赢家持久化（生产 = userData 文件，update-sources.ts）；缺省不持久化。 */
  store?: UpdateSourceStore;
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
  autoUpdater.autoDownload = true;
  // Quitting the app normally also installs a downloaded update (belt and
  // braces alongside the explicit installNow path).
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

  const gate = new UpdateGate({
    listActiveRuns: options.listActiveRuns,
    cancelActiveRuns: options.cancelActiveRuns,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    onStatus: (status) => host.broadcast(UPDATE_STATUS_CHANNEL, status),
  });

  let availableVersion: string | undefined;
  autoUpdater.on('checking-for-update', () => gate.onChecking());
  autoUpdater.on('update-available', (info) => {
    availableVersion = String(info.version);
    host.log(`update available: ${availableVersion}`);
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

  async function checkQuietly(): Promise<void> {
    if (external !== null) return;
    if (selector === null) {
      try {
        await autoUpdater.checkForUpdates();
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
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // 先不进 error 相位：镜像回退成功时用户不应看到错误一闪而过。
      host.log(`update check failed via ${picked.id}`, error);
      // 持久化的赢家坏了（镜像下线 / 配置漂移）：忘掉它，探测其余源再试一次。
      const fallback = await selector.pickAfterFailure(picked.id).catch(() => null);
      const retryError = await (async (): Promise<unknown | null> => {
        if (fallback !== null && fallback.id !== picked.id) {
          try {
            applySource(fallback);
            await autoUpdater.checkForUpdates();
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
    checkNow: checkQuietly,
    dispose() {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    },
  };
}
