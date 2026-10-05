import electronUpdater from 'electron-updater';
import {
  UPDATE_CHECK_INITIAL_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateStatusPayload,
} from '@kepcup/shared';
import { UpdateGate } from './update-gate';

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
 * 更新源（可替换配置项）: the default feed comes from electron-builder's
 * `publish` config baked into app-update.yml (GitHub Releases placeholder —
 * the publish repository is decided with the first real release). A deployment
 * can point the updater at any generic HTTPS feed at runtime via the
 * KEPCUP_UPDATE_URL environment variable without rebuilding.
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

export function wireUpdater(options: {
  host: UpdateHost;
  listActiveRuns: () => Promise<unknown[]>;
  cancelActiveRuns: (reason: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Test seam: skip the startup/interval checks (unit contexts). */
  scheduleChecks?: boolean;
}): UpdaterWiring {
  const { host } = options;
  const feedUrl = updateFeedUrlFromEnv(options.env ?? process.env);
  if (feedUrl !== null) {
    // 可替换更新源: generic HTTPS feed wins over the baked app-update.yml.
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    host.log(`update feed override: ${feedUrl}`);
  }
  autoUpdater.autoDownload = true;
  // Quitting the app normally also installs a downloaded update (belt and
  // braces alongside the explicit installNow path).
  autoUpdater.autoInstallOnAppQuit = true;

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
    if (availableVersion !== undefined) gate.onDownloading(availableVersion);
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
  if (options.scheduleChecks !== false && process.env.NODE_ENV !== 'test') {
    const first = setTimeout(() => {
      void checkQuietly();
      const interval = setInterval(() => void checkQuietly(), UPDATE_CHECK_INTERVAL_MS);
      interval.unref?.();
      timers.push(interval);
    }, UPDATE_CHECK_INITIAL_DELAY_MS);
    first.unref?.();
    timers.push(first);
  }

  async function checkQuietly(): Promise<void> {
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      host.log('update check failed', error);
      gate.onError(error instanceof Error ? error.message : String(error));
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
