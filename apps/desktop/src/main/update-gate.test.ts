import { describe, expect, test } from 'vitest';
import type { UpdateStatusPayload } from '@kepcup/shared';
import { UpdateGate } from './update-gate.js';

/**
 * Update gate (P13 任务 2): an update must never force-interrupt in-flight
 * executions — it waits for them to drain, and only an explicit user
 * confirmation may cancel them before installing. The drain wait is bounded:
 * on timeout the gate parks in `awaiting-user` (no dead-wait, no auto install).
 */

interface Harness {
  gate: UpdateGate;
  statuses: UpdateStatusPayload[];
  setActiveRuns(runs: number): void;
  setActiveError(error: Error | null): void;
  setCancelError(error: Error | null): void;
  cancelledReasons: string[];
  installed: Array<unknown>;
  now: { value: number };
  flush(ms: number): Promise<void>;
}

function harness(options?: { skippedVersions?: readonly string[] }): Harness {
  let activeRuns = 0;
  let activeError: Error | null = null;
  let cancelError: Error | null = null;
  const cancelledReasons: string[] = [];
  const installed: Array<unknown> = [];
  const now = { value: 0 };
  const statuses: UpdateStatusPayload[] = [];
  const waiters: Array<{ at: number; resolve: () => void }> = [];

  const gate = new UpdateGate({
    listActiveRuns: async () => {
      if (activeError !== null && activeError !== undefined) throw activeError;
      return Array.from({ length: activeRuns }, (_, i) => ({ id: `run_${i}` }));
    },
    cancelActiveRuns: async (reason) => {
      if (cancelError !== null) throw cancelError;
      cancelledReasons.push(reason);
      activeRuns = 0;
    },
    delay: async (ms) => {
      now.value += ms;
      await new Promise<void>((resolve) => waiters.push({ at: now.value, resolve }));
    },
    quitAndInstall: () => installed.push(true),
    onStatus: (status) => statuses.push(status),
    now: () => now.value,
    skippedVersions: options?.skippedVersions,
  });

  return {
    gate,
    statuses,
    cancelledReasons,
    installed,
    now,
    setActiveRuns(runs) {
      activeRuns = runs;
    },
    setActiveError(error) {
      activeError = error;
    },
    setCancelError(error) {
      cancelError = error;
    },
    async flush(ms) {
      now.value += ms;
      for (const waiter of waiters.splice(0)) waiter.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('UpdateGate', () => {
  test('download progress is published while downloading and cleared when ready', async () => {
    const h = harness();
    h.gate.onDownloading('1.1.0', 42.4);
    expect(h.gate.status).toMatchObject({ phase: 'downloading', version: '1.1.0', percent: 42.4 });

    await h.gate.evaluate('1.1.0');
    expect(h.gate.phase).toBe('ready-to-install');
    expect(h.gate.status.percent).toBeUndefined();
  });

  test('nothing in flight goes straight to ready-to-install; installNow quits+installs', async () => {
    const h = harness();
    await h.gate.evaluate('1.1.0');
    expect(h.gate.phase).toBe('ready-to-install');
    expect(h.cancelledReasons).toEqual([]);
    await h.gate.installNow();
    expect(h.gate.phase).toBe('installing');
    expect(h.installed).toHaveLength(1);
  });

  test('runs in flight: the gate waits and never cancels on its own', async () => {
    const h = harness();
    h.setActiveRuns(2);
    const evaluation = h.gate.evaluate('1.1.0');
    await h.flush(5_000);
    expect(h.gate.phase).toBe('waiting-runs');
    expect(h.gate.status.activeRuns).toBe(2);
    expect(h.cancelledReasons).toEqual([]);

    // Runs drain on their own → ready, still without any cancellation.
    h.setActiveRuns(0);
    await h.flush(5_000);
    await evaluation;
    expect(h.gate.phase).toBe('ready-to-install');
    expect(h.cancelledReasons).toEqual([]);
    expect(h.statuses.map((s) => s.phase)).toContain('waiting-runs');
  });

  test('drain timeout parks in awaiting-user without interrupting anyone', async () => {
    const h = harness();
    h.setActiveRuns(1);
    const evaluation = h.gate.evaluate('1.1.0');
    // Advance past the 30-minute wait budget in poll steps.
    for (let i = 0; i < 400 && h.gate.phase !== 'awaiting-user'; i++) {
      await h.flush(5_000);
    }
    await evaluation;
    expect(h.gate.phase).toBe('awaiting-user');
    expect(h.cancelledReasons).toEqual([]);
    expect(h.installed).toHaveLength(0);
  });

  test('user-confirmed install cancels the runs (once), waits and installs', async () => {
    const h = harness();
    h.setActiveRuns(1);
    const evaluation = h.gate.evaluate('1.1.0');
    // Drive past the drain budget into awaiting-user (the only installable
    // phase while runs are in flight — BR-P13-005 phase guard).
    for (let i = 0; i < 400 && h.gate.phase !== 'awaiting-user'; i++) {
      await h.flush(5_000);
    }
    await evaluation;
    expect(h.gate.phase).toBe('awaiting-user');

    await h.gate.installNow();
    expect(h.cancelledReasons).toHaveLength(1);
    expect(h.cancelledReasons[0]).toContain('用户确认更新');
    expect(h.gate.phase).toBe('installing');
    expect(h.installed).toHaveLength(1);
  });

  test('installNow is a no-op outside awaiting-user/ready-to-install (BR-P13-005 guard)', async () => {
    const h = harness();
    h.setActiveRuns(3); // a naive implementation would cancel these
    await h.gate.installNow();
    expect(h.gate.phase).toBe('idle');
    expect(h.cancelledReasons).toEqual([]);
    expect(h.installed).toHaveLength(0);

    // Same from the checking phase (stale UI click mid-check).
    h.gate.onChecking();
    await h.gate.installNow();
    expect(h.cancelledReasons).toEqual([]);
    expect(h.installed).toHaveLength(0);
  });

  test('ready-to-install with runs that started afterwards downgrades to awaiting-user first', async () => {
    const h = harness();
    await h.gate.evaluate('1.1.0'); // nothing in flight → ready
    expect(h.gate.phase).toBe('ready-to-install');

    // A new execution starts after the gate stopped polling.
    h.setActiveRuns(1);
    await h.gate.installNow();
    // NO silent cancellation: the gate asks the user instead (destructive UI).
    expect(h.gate.phase).toBe('awaiting-user');
    expect(h.gate.status.activeRuns).toBe(1);
    expect(h.cancelledReasons).toEqual([]);
    expect(h.installed).toHaveLength(0);

    // The explicit confirmation is what cancels and installs.
    await h.gate.installNow();
    expect(h.cancelledReasons).toHaveLength(1);
    expect(h.gate.phase).toBe('installing');
    expect(h.installed).toHaveLength(1);
  });

  test('keepWaiting re-arms the drain poll: awaiting-user → drained → ready-to-install', async () => {
    const h = harness();
    h.setActiveRuns(1);
    const evaluation = h.gate.evaluate('1.1.0');
    for (let i = 0; i < 400 && h.gate.phase !== 'awaiting-user'; i++) {
      await h.flush(5_000);
    }
    await evaluation;
    expect(h.gate.phase).toBe('awaiting-user');

    // The user chooses to keep waiting; the runs drain on their own.
    h.setActiveRuns(0);
    const kept = h.gate.keepWaiting();
    await h.flush(5_000);
    await kept;
    expect(h.gate.phase).toBe('ready-to-install');
    expect(h.cancelledReasons).toEqual([]);
    expect(h.installed).toHaveLength(0);
  });

  test('keepWaiting times out back into awaiting-user (fresh budget, still no auto-interrupt)', async () => {
    const h = harness();
    h.setActiveRuns(1);
    const evaluation = h.gate.evaluate('1.1.0');
    for (let i = 0; i < 400 && h.gate.phase !== 'awaiting-user'; i++) {
      await h.flush(5_000);
    }
    await evaluation;
    const kept = h.gate.keepWaiting();
    // A full fresh budget of polls with the runs still in flight. NOTE: the
    // gate's first probe (awaiting-user → waiting-runs) only settles in a
    // microtask, so the phase check happens AFTER each flush, never before
    // the first one.
    let reParked = false;
    for (let i = 0; i < 400; i++) {
      await h.flush(5_000);
      if (h.gate.phase === 'awaiting-user') {
        reParked = true;
        break;
      }
    }
    expect(reParked).toBe(true);
    await kept;
    // …parks in awaiting-user again, without ever cancelling.
    expect(h.gate.phase).toBe('awaiting-user');
    expect(h.cancelledReasons).toEqual([]);
  });

  test('keepWaiting is a no-op outside awaiting-user', async () => {
    const h = harness();
    await h.gate.keepWaiting();
    expect(h.gate.phase).toBe('idle');
  });

  test('cancelDownload guards on the downloading phase and returns the version', async () => {
    const h = harness();
    // 相位守卫：idle 下的迟到点击是 no-op（BR-P13-005 同风格）。
    expect(h.gate.cancelDownload()).toBeUndefined();
    expect(h.gate.phase).toBe('idle');

    h.gate.onDownloading('1.1.0', 30);
    expect(h.gate.cancelDownload()).toBe('1.1.0');
    expect(h.gate.phase).toBe('idle');
    expect(h.gate.status.version).toBeUndefined();
    expect(h.gate.status.percent).toBeUndefined();

    // 决策相位同样不取消（下载已结束，没有下载可停）。
    await h.gate.evaluate('1.2.0');
    expect(h.gate.phase).toBe('ready-to-install');
    expect(h.gate.cancelDownload()).toBeUndefined();
    expect(h.gate.phase).toBe('ready-to-install');
  });

  test('a cancelled version is skipped: re-checks, late progress and raced downloads are all ignored', async () => {
    const h = harness();
    expect(h.gate.onUpdateAvailable('1.1.0')).toBe(true);
    expect(h.gate.phase).toBe('downloading');

    expect(h.gate.cancelDownload()).toBe('1.1.0');
    expect(h.gate.phase).toBe('idle');

    // 24h 定时重查把同一版本再报一次：静默，不重新进入下载。
    expect(h.gate.onUpdateAvailable('1.1.0')).toBe(false);
    expect(h.gate.phase).toBe('idle');

    // 取消竞态：迟到的 download-progress 与已经完成的 update-downloaded。
    h.gate.onDownloading('1.1.0', 60);
    expect(h.gate.phase).toBe('idle');
    await h.gate.evaluate('1.1.0');
    expect(h.gate.phase).toBe('idle');
    expect(h.installed).toHaveLength(0);

    // 出现更新的版本：恢复正常流程。
    expect(h.gate.onUpdateAvailable('1.2.0')).toBe(true);
    expect(h.gate.phase).toBe('downloading');
    await h.gate.evaluate('1.2.0');
    expect(h.gate.phase).toBe('ready-to-install');
  });

  test('persisted skipped versions are honored from construction', async () => {
    const h = harness({ skippedVersions: ['1.0.0'] });
    expect(h.gate.onUpdateAvailable('1.0.0')).toBe(false);
    expect(h.gate.phase).toBe('idle');
    // 其它版本不受影响。
    expect(h.gate.onUpdateAvailable('1.0.1')).toBe(true);
    expect(h.gate.phase).toBe('downloading');
  });

  test('manual check surfaces a skipped version as available-skipped; scheduled stays silent', async () => {
    const h = harness();
    h.gate.onUpdateAvailable('1.1.0');
    h.gate.cancelDownload();
    expect(h.gate.phase).toBe('idle');

    // 定时/自动检查：同版本静默，不切相位、不启动下载。
    expect(h.gate.onUpdateAvailable('1.1.0')).toBe(false);
    expect(h.gate.phase).toBe('idle');

    // 手动检查（设置-通用「检查更新」）：切 available-skipped，设置页据此
    // 提供「下载此版本」入口。
    expect(h.gate.onUpdateAvailable('1.1.0', { manual: true })).toBe(false);
    expect(h.gate.phase).toBe('available-skipped');
    expect(h.gate.status).toMatchObject({ phase: 'available-skipped', version: '1.1.0' });

    // available-skipped 同样抗 updater 噪音（定时重查失败不打掉手动入口）。
    h.gate.onChecking();
    h.gate.onError('404 not found');
    expect(h.gate.phase).toBe('available-skipped');

    // 未跳过的版本照旧：手动检查立即切 downloading 并允许启动下载。
    expect(h.gate.onUpdateAvailable('1.2.0', { manual: true })).toBe(true);
    expect(h.gate.phase).toBe('downloading');
  });

  test('scheduled check hitting a skipped version converges checking back to idle (never stuck)', async () => {
    const h = harness();
    h.gate.onUpdateAvailable('1.1.0');
    h.gate.cancelDownload();
    // 定时检查的事件序列：checking → update-available(skipped, 静默)——此后
    // 没有任何事件会再来（runCheck 静默返回、update-not-available 不来），
    // gate 必须自己把 checking 收敛回 idle，否则设置页「检查更新」永久卡在
    // 「检查中」、手动入口不可达。
    h.gate.onChecking();
    expect(h.gate.phase).toBe('checking');
    expect(h.gate.onUpdateAvailable('1.1.0')).toBe(false);
    expect(h.gate.phase).toBe('idle');
  });

  test('manual check from downloading does not surface a skipped version and converges back', async () => {
    const h = harness();
    // 先让用户取消过 1.1.0（入跳过集合），再让 2.0.0 下载在途。
    h.gate.onUpdateAvailable('1.1.0');
    h.gate.cancelDownload();
    h.gate.onDownloading('2.0.0', 40);
    // 由 downloading 发起的手动检查（托盘入口）：有下载在途，浮出会被下一个
    // 进度事件打回（闪帧）——不浮出，收敛回 downloading。
    h.gate.onChecking();
    expect(h.gate.onUpdateAvailable('1.1.0', { manual: true })).toBe(false);
    expect(h.gate.phase).toBe('downloading');
    expect(h.gate.status.version).toBe('2.0.0');
  });

  test('manual check hitting a skipped version while ready-to-install never washes the decision', async () => {
    const h = harness();
    h.gate.onUpdateAvailable('1.1.0');
    h.gate.cancelDownload();
    await h.gate.evaluate('2.0.0');
    expect(h.gate.phase).toBe('ready-to-install');
    // 决策相位进不了 checking（onChecking 守卫）：update-available 只可能被
    // 静默吞掉，available-skipped 不浮出、ready 不被冲掉。
    expect(h.gate.onUpdateAvailable('1.1.0', { manual: true })).toBe(false);
    expect(h.gate.phase).toBe('ready-to-install');
  });

  test('resume then cancel re-skips the version: scheduled silent again, manual can resurface', async () => {
    const h = harness({ skippedVersions: ['1.0.0'] });
    expect(h.gate.onUpdateAvailable('1.0.0', { manual: true })).toBe(false);
    expect(h.gate.resumeSkipped('1.0.0')).toBe(true);
    expect(h.gate.phase).toBe('downloading');

    // 用户再次取消：重新入跳过集合，gate 回 idle。
    expect(h.gate.cancelDownload()).toBe('1.0.0');
    expect(h.gate.phase).toBe('idle');

    // 定时重查静默；迟到的进度事件不把 idle 拉回 downloading；手动检查仍可
    // 重新浮出（用户随时可以反悔——这正是特性语义）。
    h.gate.onChecking();
    expect(h.gate.onUpdateAvailable('1.0.0')).toBe(false);
    expect(h.gate.phase).toBe('idle');
    h.gate.onDownloading('1.0.0', 60);
    expect(h.gate.phase).toBe('idle');
    expect(h.gate.onUpdateAvailable('1.0.0', { manual: true })).toBe(false);
    expect(h.gate.phase).toBe('available-skipped');
    expect(h.gate.resumeSkipped('1.0.0')).toBe(true);
    expect(h.gate.phase).toBe('downloading');
  });

  test('feed pulling the skipped version clears the available-skipped surface (update-not-available)', async () => {
    const h = harness({ skippedVersions: ['1.0.0'] });
    expect(h.gate.onUpdateAvailable('1.0.0', { manual: true })).toBe(false);
    expect(h.gate.phase).toBe('available-skipped');
    // 手动重查且 feed 已无该版本：入口收回 idle 是事实修正。
    h.gate.onUpToDate();
    expect(h.gate.phase).toBe('idle');
  });

  test('resumeSkipped re-arms the download and un-skips the version', async () => {
    const h = harness({ skippedVersions: ['1.0.0'] });
    expect(h.gate.onUpdateAvailable('1.0.0', { manual: true })).toBe(false);
    expect(h.gate.phase).toBe('available-skipped');

    expect(h.gate.resumeSkipped('1.0.0')).toBe(true);
    expect(h.gate.phase).toBe('downloading');
    expect(h.gate.status).toMatchObject({ phase: 'downloading', version: '1.0.0' });

    // 已移出跳过集合：后续进度 / 下载完成照常推进（不再静默）。
    h.gate.onDownloading('1.0.0', 50);
    expect(h.gate.status).toMatchObject({ phase: 'downloading', percent: 50 });
    await h.gate.evaluate('1.0.0');
    expect(h.gate.phase).toBe('ready-to-install');
  });

  test('resumeSkipped is a no-op outside available-skipped or with a stale version', async () => {
    const h = harness({ skippedVersions: ['1.0.0'] });
    // 相位守卫：available-skipped 之外的迟到点击是 no-op。
    expect(h.gate.resumeSkipped('1.0.0')).toBe(false);
    expect(h.gate.phase).toBe('idle');

    // 版本不匹配同样 no-op（gate 记录的是最后一次浮出的版本）。
    h.gate.onUpdateAvailable('1.0.0', { manual: true });
    expect(h.gate.phase).toBe('available-skipped');
    expect(h.gate.resumeSkipped('2.0.0')).toBe(false);
    expect(h.gate.phase).toBe('available-skipped');
  });

  test('onUpdateAvailable switches to downloading immediately (manual check UX)', async () => {
    const h = harness();
    expect(h.gate.onUpdateAvailable('1.1.0')).toBe(true);
    // update-available 即切 downloading：不等首个 download-progress。
    expect(h.gate.status).toMatchObject({ phase: 'downloading', version: '1.1.0' });
    h.gate.onDownloading('1.1.0', 42.4);
    expect(h.gate.status).toMatchObject({ phase: 'downloading', percent: 42.4 });
  });

  test('an unrelated error never washes away the awaiting-user decision (BR-P13-002)', async () => {
    const h = harness();
    h.setActiveRuns(1);
    const evaluation = h.gate.evaluate('1.1.0');
    for (let i = 0; i < 400 && h.gate.phase !== 'awaiting-user'; i++) {
      await h.flush(5_000);
    }
    await evaluation;

    // The 24h re-check hits a 404; a download hiccup; a re-check starts.
    h.gate.onError('404 not found');
    h.gate.onChecking();
    h.gate.onDownloading('1.1.0');
    expect(h.gate.phase).toBe('awaiting-user');
    expect(h.statuses.at(-1)?.phase).toBe('awaiting-user');
  });

  test('redundant download-progress while ready-to-install keeps the apply phase', async () => {
    const h = harness();
    await h.gate.evaluate('1.1.0');
    expect(h.gate.phase).toBe('ready-to-install');

    // A scheduled re-check re-emits progress for the already-downloaded
    // artifact; the apply button must not flip back to "downloading".
    h.gate.onDownloading('1.1.0', 77);
    expect(h.gate.phase).toBe('ready-to-install');
    expect(h.statuses.at(-1)?.phase).toBe('ready-to-install');
  });

  test('redundant download-progress while waiting-runs keeps the drain state', async () => {
    const h = harness();
    h.setActiveRuns(1);
    const evaluation = h.gate.evaluate('1.1.0');
    await h.flush(5_000);
    expect(h.gate.phase).toBe('waiting-runs');

    h.gate.onDownloading('1.1.0', 77);
    expect(h.gate.phase).toBe('waiting-runs');

    // The drain continues undisturbed and still settles on its own.
    h.setActiveRuns(0);
    await h.flush(5_000);
    await evaluation;
    expect(h.gate.phase).toBe('ready-to-install');
  });

  test('a cancel that fails to settle the runs does NOT install (error surfaced)', async () => {
    const h = harness();
    h.setActiveRuns(1);
    const evaluation = h.gate.evaluate('1.1.0');
    for (let i = 0; i < 400 && h.gate.phase !== 'awaiting-user'; i++) {
      await h.flush(5_000);
    }
    await evaluation;
    h.setCancelError(new Error('core unreachable'));
    await h.gate.installNow();
    expect(h.gate.phase).toBe('idle');
    expect(h.installed).toHaveLength(0);
    expect(h.statuses.some((s) => s.phase === 'error' && s.message?.includes('core unreachable'))).toBe(
      true,
    );
  });

  test('decision phases survive updater noise (checking / 404 while ready)', async () => {
    const h = harness();
    await h.gate.evaluate('1.1.0');
    expect(h.gate.phase).toBe('ready-to-install');

    // A scheduled re-check + feed 404 while the downloaded update sits ready.
    h.gate.onChecking();
    h.gate.onError('404 not found');
    expect(h.gate.phase).toBe('ready-to-install');
  });

  test('from checking, a "no update" result resolves back to idle (BR-P13-008)', async () => {
    const h = harness();
    h.gate.onChecking();
    expect(h.gate.phase).toBe('checking');
    // The event the manual check waits for — no wall-clock heuristic.
    h.gate.onUpToDate();
    expect(h.gate.phase).toBe('idle');

    // A failed check also lands on idle, but records the message first.
    h.gate.onChecking();
    h.gate.onError('ENOTFOUND feed.example.com');
    expect(h.gate.phase).toBe('idle');
    expect(h.statuses.some((s) => s.phase === 'error' && s.message?.includes('ENOTFOUND'))).toBe(
      true,
    );
  });

  test('a probe failure during the wait backs off and recovers (no crash, no install)', async () => {
    const h = harness();
    h.setActiveRuns(1);
    h.setActiveError(new Error('core process exited'));
    const evaluation = h.gate.evaluate('1.1.0');
    await h.flush(5_000);
    await h.flush(5_000);
    // Core comes back, runs drained meanwhile.
    h.setActiveError(null);
    h.setActiveRuns(0);
    await h.flush(5_000);
    await evaluation;
    expect(h.gate.phase).toBe('ready-to-install');
    expect(h.cancelledReasons).toEqual([]);
  });
});
