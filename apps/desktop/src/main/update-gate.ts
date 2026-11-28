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
  /**
   * 跨启动恢复的「用户取消并跳过」的版本（持久化见 update-skip.ts）。
   * 缺省空——被跳过的版本静默不下载，更新的版本恢复正常流程。
   */
  skippedVersions?: readonly string[];
}

export type GatePhase = UpdateStatusPayload['phase'];

const CANCEL_REASON = '用户确认更新：中断进行中的执行并安装新版本';

export class UpdateGate {
  readonly #deps: UpdateGateDeps;
  #phase: GatePhase = 'idle';
  /** 发起检查时的相位（onChecking 只从 idle/downloading 进入 checking）。 */
  #preCheckPhase: GatePhase = 'idle';
  #activeRuns = 0;
  #version: string | undefined;
  #percent: number | undefined;
  #message: string | undefined;
  /** 用户取消过的版本：后续同名版本的一切事件（进度/完成）都被静默挡掉。 */
  #skippedVersions: Set<string>;
  /** Generation counter: installNow/cancelDuringWait invalidates stale polls. */
  #generation = 0;
  #waiting = false;

  constructor(deps: UpdateGateDeps) {
    this.#deps = deps;
    this.#skippedVersions = new Set(deps.skippedVersions ?? []);
  }

  get phase(): GatePhase {
    return this.#phase;
  }

  get status(): UpdateStatusPayload {
    return {
      phase: this.#phase,
      ...(this.#version !== undefined ? { version: this.#version } : {}),
      ...(this.#phase === 'downloading' && this.#percent !== undefined
        ? { percent: this.#percent }
        : {}),
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
    if (phase !== 'downloading') this.#percent = undefined;
    if (extra?.message !== undefined) this.#message = extra.message;
    else if (phase !== 'error') this.#message = undefined;
    this.#emit();
  }

  /** Feed events from electron-updater. */
  onChecking(): void {
    // BR-P13-002: a re-check must not wash away a pending decision — the
    // decision phases stay exactly as they are (see the header comment).
    if (this.#phase !== 'idle' && this.#phase !== 'downloading') return;
    // 记住检查发起时的相位：available-skipped 只在「idle 发起的手动检查」
    // 浮出（#canSurfaceSkipped）；updater 层把检查串行化，一次检查只有一条
    // 事件流，这个前置相位在 update-available 到达时仍然可靠。
    this.#preCheckPhase = this.#phase;
    this.#setPhase('checking');
  }

  /**
   * electron-updater update-available（自动下载时代由 updater 层直接
   * onDownloading；如今下载按此返回值手动启动）。被用户取消过的版本：
   * 自动/定时检查静默跳过（否则 24h 定时重查会立刻把同一版本下回来，
   * 「取消更新」就名存实亡）；手动检查则切 `available-skipped`——设置页
   * 显示该版本并提供手动下载入口（下载仍需用户显式点，resumeSkipped）。
   * 其它版本立即切 downloading（手动检查查到更新后，检查按钮马上让位
   * 给进度，不等首包）并返回 true = 允许开始下载。决策相位的 sticky 语义见
   * onDownloading：此时切换被忽略，但允许下载新版本顶替（下载完成后
   * evaluate 会重新走排空决策）；available-skipped 的切换同样只在
   * idle/error/checking（含已在 available-skipped）时发生，不打断进行中的
   * 下载/决策流。
   */
  onUpdateAvailable(version: string, options?: { manual?: boolean }): boolean {
    if (!this.#skippedVersions.has(version)) {
      this.onDownloading(version);
      return true;
    }
    if (options?.manual === true && this.#canSurfaceSkipped()) {
      this.#setPhase('available-skipped', { version });
      return false;
    }
    // 未浮出（定时检查一律静默；手动检查但门控不空闲）：把 checking 收敛回
    // 发起前的相位。update-available 之后不会再有任何事件收敛 checking——
    // updater 层对被跳过版本静默返回、update-not-available 也不来——放任不管
    // 设置页会永久停在「检查中」、手动入口不可达。收敛绝不触碰决策相位：它
    // 们根本进不了 checking（onChecking 守卫），符合 BR-P13-002。
    if (this.#phase === 'checking') {
      if (this.#preCheckPhase === 'downloading' && this.#version !== undefined) {
        // 有下载在途：收敛回 downloading（percent 由下一个进度事件补上）。
        this.#setPhase('downloading', { version: this.#version });
      } else {
        this.onUpToDate();
      }
    }
    return false;
  }

  /** available-skipped 只在静默态发起的手动检查时浮出（相位守卫同 onChecking）。 */
  #canSurfaceSkipped(): boolean {
    // checking 需前置相位是 idle：由 downloading 发起的检查说明有下载在途，
    // 浮出会被下一个进度事件打回。idle 与已浮出（重复手动检查幂等刷新）直接
    // 放行；error 从不停留（onError 同步 error→idle），无需列入。
    return (
      this.#phase === 'idle' ||
      this.#phase === 'available-skipped' ||
      (this.#phase === 'checking' && this.#preCheckPhase === 'idle')
    );
  }

  /**
   * 用户在设置页对被跳过的版本点了「下载此版本」：把该版本移出跳过集合，
   * 切 downloading（后续进度/完成事件随之放行，下载本体由 updater 层用
   * 手动检查留下的 token 启动）。相位守卫同 BR-P13-005 风格——只在
   * available-skipped 且版本匹配时有效，过期的点击是 no-op。
   */
  resumeSkipped(version: string): boolean {
    if (this.#phase !== 'available-skipped' || this.#version !== version) return false;
    this.#skippedVersions.delete(version);
    this.#setPhase('downloading', { version });
    return true;
  }

  onDownloading(version: string, percent?: number): void {
    // 取消后迟到的进度事件：同名版本的一切后续推送都静默忽略（见
    // cancelDownload）。
    if (this.#skippedVersions.has(version)) return;
    // Decision/drain phases are sticky (header comment): a redundant
    // download-progress event — e.g. the 24h scheduled re-check re-emitting
    // progress for the already-downloaded artifact — must not knock the apply
    // button back to "downloading". A genuinely new download still transitions
    // through evaluate() when its update-downloaded event fires.
    if (
      this.#phase === 'installing' ||
      this.#phase === 'awaiting-user' ||
      this.#phase === 'ready-to-install' ||
      this.#phase === 'waiting-runs'
    ) {
      return;
    }
    if (percent !== undefined) this.#percent = percent;
    this.#setPhase('downloading', { version });
  }

  /** Feed "no update" results (electron-updater update-not-available). */
  onUpToDate(): void {
    // available-skipped 也收敛：feed 明确撤下了该版本时，把手动入口收回 idle
    // 是事实修正（available-skipped 非决策相位，不涉 BR-P13-002 的 sticky 面）。
    if (this.#phase !== 'checking' && this.#phase !== 'available-skipped') return;
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
      this.#phase === 'ready-to-install' ||
      this.#phase === 'available-skipped'
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
    // 取消的竞态尾巴：token 取消时下载其实已经完成，update-downloaded 照样
    // 到达。跳过的版本绝不进入 ready（用户已经明确表达过「不要这个版本」）。
    if (this.#skippedVersions.has(version)) return;
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
   * 「取消更新」（用户在 downloading 相位点）：停下、回 idle、把这个版本
   * 记入跳过集合（持久化由 updater 层负责）。返回被跳过的版本，其它相位返回
   * undefined（相位守卫，与 installNow 的 BR-P13-005 同风格——任何迟到/过期
   * 的点击都是 no-op，绝不作为取消源）。跳过集合挡住该版本的一切后续事件：
   * 迟到的 download-progress 不把 idle 拉回 downloading，取消竞态下到达的
   * update-downloaded（evaluate）不产生 ready。
   */
  cancelDownload(): string | undefined {
    if (this.#phase !== 'downloading') return undefined;
    const version = this.#version;
    this.#setPhase('idle');
    this.#version = undefined;
    if (version !== undefined) this.#skippedVersions.add(version);
    return version;
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
