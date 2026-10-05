import {
  UPDATE_ACTIVE_RUNS_POLL_MS,
  UPDATE_CANCEL_SETTLE_POLL_MS,
  UPDATE_CANCEL_SETTLE_TIMEOUT_MS,
  UPDATE_WAIT_RUNS_TIMEOUT_MS,
  type UpdateStatusPayload,
} from '@kepcup/shared';

/**
 * Update gate (P13 任务 2, docs/dev/phases/P13-release.md): an update must
 * NEVER force-interrupt in-flight executions. After a download completes the
 * gate asks the core (port B) whether anything is queued/running/waiting:
 *
 * - nothing in flight  → `ready-to-install` (installing on quit is Electron's
 *   default; `installNow()` performs the immediate restart+install).
 * - runs in flight     → `waiting-runs`: poll until they drain. Poll callbacks
 *   follow the background-loop red line: try/catch + finally re-arm + give up
 *   counting (the poll itself cannot throw out of the timer).
 * - drain timeout      → `awaiting-user`: NO automatic install. Only an
 *   explicit user confirmation (`installNow()`) may cancel the runs
 *   (update.cancelActive) and then install — the escape hatch that keeps the
 *   gate from dead-waiting without ever interrupting on its own. 「继续等待」
 *   (`keepWaiting()`) re-arms the drain poll with a fresh budget instead of
 *   parking forever (BR-P13-002).
 *
 * Decision phases (`awaiting-user` / `ready-to-install`) are sticky: updater
 * noise while the gate (or the user) is deciding — a background re-check, a
 * feed 404, a download hiccup — never rewrites the phase (BR-P13-002: an
 * unrelated error must not wash away a pending user decision). Only
 * `evaluate()` (a new download finished) and the explicit user actions move
 * the gate out of them.
 *
 * The class is Electron-free; unit tests inject fake core calls and a
 * controllable delay.
 */

export interface UpdateGateDeps {
  /** Port B `update.activeRuns`: in-flight executions right now. */
  listActiveRuns(): Promise<unknown[]>;
  /** Port B `update.cancelActive`: user-confirmed interrupt of active runs. */
  cancelActiveRuns(reason: string): Promise<void>;
  /** Controllable sleep (tests inject an immediate/deferred fake). */
  delay(ms: number): Promise<void>;
  /** Status transitions are announced to the renderer (ipc push). */
  onStatus(status: UpdateStatusPayload): void;
  /** Performs the actual restart+install (autoUpdater.quitAndInstall). */
  quitAndInstall(): void;
  now?(): number;
}

export type GatePhase = UpdateStatusPayload['phase'];

const CANCEL_REASON = '用户确认更新：中断进行中的执行并安装新版本';

export class UpdateGate {
  readonly #deps: UpdateGateDeps;
  #phase: GatePhase = 'idle';
  #activeRuns = 0;
  #version: string | undefined;
  #message: string | undefined;
  /** Generation counter: installNow/cancelDuringWait invalidates stale polls. */
  #generation = 0;
  #waiting = false;

  constructor(deps: UpdateGateDeps) {
    this.#deps = deps;
  }

  get phase(): GatePhase {
    return this.#phase;
  }

  get status(): UpdateStatusPayload {
    return {
      phase: this.#phase,
      ...(this.#version !== undefined ? { version: this.#version } : {}),
      ...(this.#phase === 'waiting-runs' || this.#phase === 'awaiting-user'
        ? { activeRuns: this.#activeRuns }
        : {}),
      ...(this.#message !== undefined ? { message: this.#message } : {}),
    };
  }

  #emit(): void {
    this.#deps.onStatus(this.status);
  }

  #setPhase(phase: GatePhase, extra?: { version?: string; message?: string }): void {
    this.#phase = phase;
    if (extra?.version !== undefined) this.#version = extra.version;
    if (extra?.message !== undefined) this.#message = extra.message;
    else if (phase !== 'error') this.#message = undefined;
    this.#emit();
  }

  /** Feed events from electron-updater. */
  onChecking(): void {
    // BR-P13-002: a re-check must not wash away a pending decision — the
    // decision phases stay exactly as they are (see the header comment).
    if (this.#phase !== 'idle' && this.#phase !== 'downloading') return;
    this.#setPhase('checking');
  }

  onDownloading(version: string): void {
    if (this.#phase === 'installing' || this.#phase === 'awaiting-user') return;
    this.#setPhase('downloading', { version });
  }

  /** Feed "no update" results (electron-updater update-not-available). */
  onUpToDate(): void {
    if (this.#phase !== 'checking') return;
    this.#setPhase('idle');
  }

  /**
   * Feed check/download failures: logged phase, never fatal for the app.
   * BR-P13-002: the awaiting-user decision is never downgraded by an
   * unrelated failure (e.g. the 24h re-check hitting a 404) — only logged.
   */
  onError(message: string): void {
    if (
      this.#phase === 'installing' ||
      this.#phase === 'waiting-runs' ||
      this.#phase === 'awaiting-user' ||
      this.#phase === 'ready-to-install'
    ) {
      return;
    }
    this.#setPhase('error', { message });
    this.#setPhase('idle');
  }

  /**
   * A download finished: run the gate decision. Resolves when the gate reached
   * a terminal-for-now phase (ready / awaiting-user / error).
   */
  async evaluate(version: string): Promise<void> {
    if (this.#phase === 'installing') return;
    this.#version = version;
    await this.#waitForDrain({ deadline: UPDATE_WAIT_RUNS_TIMEOUT_MS });
  }

  /**
   * User escape hatch (also the confirmed-interrupt path). Cancels in-flight
   * executions (explicit user consent, update.cancelActive), waits for them
   * to become terminal, then quits and installs. Throws when the runs refuse
   * to settle — the caller surfaces the error instead of killing the app.
   *
   * BR-P13-005 phase guard: only `awaiting-user` (the user is confirming an
   * interrupt) and `ready-to-install` (a downloaded update sits at the gate)
   * may install — a stale UI click in any other phase is a no-op, never a
   * cancellation source. And a `ready-to-install` whose re-probe finds NEW
   * runs (started after the gate stopped polling) downgrades to
   * `awaiting-user`: interrupting them needs the explicit destructive
   * confirmation, never a plain-styled surprise.
   */
  async installNow(): Promise<void> {
    if (this.#phase === 'installing') return;
    if (this.#phase !== 'awaiting-user' && this.#phase !== 'ready-to-install') return;
    this.#generation += 1;
    const generation = this.#generation;
    this.#waiting = false; // stop any drain poll

    if (this.#phase === 'ready-to-install') {
      // A failed probe counts as "unknown, assume busy" (→ ask the user; the
      // safe direction — an extra confirmation instead of a silent cancel).
      const active = await this.#probeRuns();
      if (generation !== this.#generation) return; // superseded meanwhile
      if (active > 0) {
        this.#activeRuns = active;
        this.#setPhase('awaiting-user');
        return;
      }
    }

    try {
      const drained = await this.#cancelAndDrain(generation);
      if (!drained) {
        this.#setPhase('error', { message: '执行未能及时结束，更新已取消；可稍后重试' });
        this.#setPhase('idle');
        return;
      }
    } catch (error) {
      this.#setPhase('error', {
        message: error instanceof Error ? error.message : String(error),
      });
      this.#setPhase('idle');
      return;
    }
    this.#setPhase('installing');
    this.#deps.quitAndInstall();
  }

  /**
   * 「继续等待」(BR-P13-002): re-arms the drain poll from `awaiting-user`.
   * Chosen semantics: each confirmation grants a fresh full
   * UPDATE_WAIT_RUNS_TIMEOUT_MS budget — on expiry the gate parks in
   * `awaiting-user` again with the buttons back (no silent dead-wait, never
   * an automatic interrupt; the user keeps the escape hatch at all times).
   * No-op from any other phase.
   */
  async keepWaiting(): Promise<void> {
    if (this.#phase !== 'awaiting-user') return;
    await this.#waitForDrain({ deadline: UPDATE_WAIT_RUNS_TIMEOUT_MS });
  }

  /**
   * Waits until no runs are active or the deadline passes. Emits
   * waiting-runs → (ready | awaiting-user). Red line: the poll loop re-arms
   * in finally and never lets a rejected probe escape the timer.
   */
  async #waitForDrain(options: { deadline: number }): Promise<void> {
    const generation = ++this.#generation;
    this.#waiting = true;
    const start = this.#deps.now?.() ?? Date.now();
    const elapsed = (): number => (this.#deps.now?.() ?? Date.now()) - start;
    try {
      while (this.#waiting && generation === this.#generation) {
        let runs: unknown[];
        try {
          runs = await this.#deps.listActiveRuns();
        } catch (error) {
          // The core may be mid-restart; back off and retry until the deadline.
          if (elapsed() > options.deadline) {
            this.#setPhase('error', {
              message: `无法确认执行状态：${error instanceof Error ? error.message : String(error)}`,
            });
            this.#setPhase('idle');
            return;
          }
          await this.#deps.delay(UPDATE_ACTIVE_RUNS_POLL_MS);
          continue;
        }
        if (!this.#waiting || generation !== this.#generation) return;
        this.#activeRuns = runs.length;
        if (runs.length === 0) {
          this.#setPhase('ready-to-install');
          return;
        }
        this.#setPhase('waiting-runs');
        if (elapsed() >= options.deadline) {
          // NOT a deadline to interrupt: park and ask the user (任务书红线).
          this.#setPhase('awaiting-user');
          return;
        }
        await this.#deps.delay(UPDATE_ACTIVE_RUNS_POLL_MS);
      }
    } finally {
      if (generation === this.#generation) this.#waiting = false;
    }
  }

  /** cancelActive + bounded wait for the runs to become terminal. */
  async #cancelAndDrain(generation: number): Promise<boolean> {
    // Nothing in flight: no cancellation RPC at all.
    if ((await this.#probeRuns()) === 0) return true;
    await this.#deps.cancelActiveRuns(CANCEL_REASON);
    const start = this.#deps.now?.() ?? Date.now();
    for (;;) {
      const count = await this.#probeRuns();
      if (generation !== this.#generation) return false;
      if (count === 0) return true;
      if ((this.#deps.now?.() ?? Date.now()) - start >= UPDATE_CANCEL_SETTLE_TIMEOUT_MS) {
        return false;
      }
      await this.#deps.delay(UPDATE_CANCEL_SETTLE_POLL_MS);
    }
  }

  /** Active-run count; a failed probe counts as "unknown, assume busy" (1+). */
  async #probeRuns(): Promise<number> {
    try {
      return (await this.#deps.listActiveRuns()).length;
    } catch {
      return 1;
    }
  }
}
