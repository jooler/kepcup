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

function harness(): Harness {
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
