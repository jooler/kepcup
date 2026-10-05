import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeWslOutput } from './decode.js';
import { buildWslConf } from './conf.js';
import { deriveWslState, type WslState } from './parse.js';
import { sandboxWslDir, wslSetupStatePath, type AppPaths } from '../../infra/paths.js';
import {
  WSL_DISTRO_NAME,
  WSL_EXE,
  WSL_MOUNT_BIN,
  WSL_SHIM_BIN,
  WSL_USER,
} from './constants.js';

/**
 * WSL 状态检测 / 启用 / 导入与配置 (docs/dev/phases/P12 任务 2 + 3). This is
 * the ONLY module allowed to invoke wsl.exe (任务书注意事项) — the backends
 * and everything else go through WslSetup. Windows-only behavior is
 * blind-written on macOS: every wsl.exe interaction goes through the
 * injectable `WslRunner` so the whole state machine is covered by fixture
 * tests on the dev machine, and the platform-bound integration (real wsl.exe)
 * is describe.skipIf(process.platform !== 'win32')
 * (packages/core/test/integration/wsl-setup.test.ts).
 *
 * State machine (persisted in `sandbox/wsl/setup-state.json` via
 * infra/paths — plain JSON, no migration needed: nothing relational, and the
 * snapshot must survive a reboot which may happen between any two steps):
 *
 *   idle → (user starts 准备) detect
 *        → not_installed/needs_enable → requestEnable() [UAC: wsl --install
 *          --no-distribution] → awaiting_reboot (persisted)
 *        → reboot → probe → ok → ensureDistro() [import + wsl.conf + user +
 *          terminate + srt self-check] → ready
 *        → policy_disabled → terminal for this session: stays per-command
 *          confirm mode with a structured reason (任务书: 保持逐条确认模式).
 */

export type WslSetupPhase =
  | 'idle'
  | 'enabling'
  | 'awaiting_reboot'
  | 'importing'
  | 'configuring'
  | 'ready'
  | 'failed'
  | 'policy_disabled';

export interface WslSetupSnapshot {
  phase: WslSetupPhase;
  /** Set when the phase is failed / policy_disabled. */
  reason?: string;
  /**
   * P12-B: the user skipped preparation — the per-command confirm mode keeps
   * running and the first-launch prompt stays away (设置页入口 still works).
   * Carried forward across phase transitions (it is a user decision, not a
   * machine state).
   */
  skippedAt?: number;
  /** Monotonic wall time of the last transition (display only). */
  updatedAt: number;
}

export interface WslStatusReport {
  state: WslState;
  phase: WslSetupPhase;
  reason?: string;
  /** Localized fix hint for the UI (P12-B) / probe reason output. */
  fixHint?: string;
}

/** One finished wsl.exe invocation. */
export interface WslRunResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  /** Spawn-level failure (wsl.exe not found). */
  error?: string;
}

/**
 * Injectable wsl.exe runner. The production implementation spawns
 * `wsl.exe` (System32) and buffers bytes; tests feed fixture outputs shaped
 * after the real UTF-16 formats.
 */
export interface WslRunner {
  run(
    args: string[],
    options?: { timeoutMs?: number; input?: string; stdinFile?: string; signal?: AbortSignal },
  ): Promise<WslRunResult>;
  /** Elevated run through UAC (管理员授权): PowerShell Start-Process -Verb RunAs. */
  runElevated?(args: string[]): Promise<WslRunResult>;
}

export class WslSetup {
  readonly #paths: AppPaths;
  readonly #runner: WslRunner;
  readonly #now: () => number;
  readonly #env: NodeJS.ProcessEnv;
  #snapshot: WslSetupSnapshot | null = null;

  constructor(input: { paths: AppPaths; runner: WslRunner; now?: () => number; env?: NodeJS.ProcessEnv }) {
    this.#paths = input.paths;
    this.#runner = input.runner;
    this.#now = input.now ?? Date.now;
    this.#env = input.env ?? process.env;
    this.#snapshot = this.#loadSnapshot();
  }

  // --- detection ---------------------------------------------------------------

  /** Runs both detection commands and derives the combined state. */
  async detect(): Promise<WslState> {
    const [status, list] = await Promise.all([
      this.#runner.run(['--status'], { timeoutMs: 15_000 }),
      this.#runner.run(['--list', '--verbose'], { timeoutMs: 15_000 }),
    ]);
    return deriveWslState({
      status: status.error !== undefined ? null : { exitCode: status.exitCode, text: decodeWslOutput(status.stdout) },
      list: list.error !== undefined ? null : { exitCode: list.exitCode, text: decodeWslOutput(list.stdout) },
      distroName: WSL_DISTRO_NAME,
    });
  }

  /**
   * Full status for probe()/UI: combined WSL state + our phase + a localized
   * reason/fixHint. This is the structured per-command-confirm-mode reason
   * output (任务书 任务 2 失败与策略禁用).
   */
  async status(): Promise<WslStatusReport> {
    const state = await this.detect();
    // Re-derived below (BR-P12-009: a stale persisted policy_disabled leaves
    // the phase once WSL is usable again).
    let phase = this.#snapshot?.phase ?? 'idle';
    switch (state.install.kind) {
      case 'policy_disabled': {
        const reason = 'WSL 已被企业策略禁用，沙箱不可用；命令将保持逐条确认模式';
        if (this.#snapshot?.phase !== 'ready') this.#persist({ phase: 'policy_disabled', reason, updatedAt: this.#now() });
        return { state, phase: 'policy_disabled', reason };
      }
      case 'not_installed':
        return {
          state,
          phase: phase === 'awaiting_reboot' ? 'awaiting_reboot' : phase,
          reason: `WSL2 未安装（${state.install.detail}）`,
          fixHint: '在设置页开始 Windows 沙箱准备（需要一次管理员授权与一次重启）',
        };
      case 'needs_enable':
        return {
          state,
          phase: phase === 'awaiting_reboot' ? 'awaiting_reboot' : phase,
          reason: `WSL2 组件未启用（${state.install.detail}）`,
          fixHint: '在设置页开始 Windows 沙箱准备（需要一次管理员授权与一次重启）',
        };
      case 'ok': {
        if (state.distro.kind === 'registered') {
          // P12-B: a persisted failed pass (e.g. srt self-check failed) stays
          // failed — fail-closed for the probe and visible for the wizard —
          // until a retry converges (ensureDistro re-runs configure+check).
          const snapshot = this.#snapshot;
          if (snapshot?.phase === 'failed') {
            return {
              state,
              phase: 'failed',
              ...(snapshot.reason !== undefined ? { reason: snapshot.reason } : {}),
            };
          }
          if (snapshot?.phase === 'configuring') {
            return { state, phase: 'configuring' };
          }
          return { state, phase: 'ready' };
        }
        if (state.distro.kind === 'wsl1') {
          return {
            state,
            phase: 'failed',
            reason: `${WSL_DISTRO_NAME} 发行版被注册为 WSL1，无法用于沙箱；请在设置页重新导入（WSL2）`,
            fixHint: `wsl --unregister ${WSL_DISTRO_NAME} 后重新导入（--version 2）`,
          };
        }
        if (phase === 'awaiting_reboot') {
          return { state, phase: 'awaiting_reboot', reason: '管理员授权已完成，请重启 Windows 后继续' };
        }
        // P12-B: while an import/configure pass is running, the progress phase
        // is the message — the stale "尚未导入" reason would contradict it.
        if (phase === 'importing' || phase === 'configuring' || phase === 'enabling') {
          return { state, phase };
        }
        if (phase === 'failed') {
          return {
            state,
            phase,
            reason: this.#snapshot?.reason ?? '发行版配置未完成',
          };
        }
        // BR-P12-009: a persisted policy_disabled reported the environment at
        // that time — it is not a life sentence. Once WSL is usable again
        // (install ok, distro not yet imported) the phase must leave
        // policy_disabled, or the wizard would render no prepare action
        // forever (cross-reboot dead end).
        if (phase === 'policy_disabled') {
          this.#persist({ phase: 'idle', updatedAt: this.#now() });
          phase = 'idle';
        }
        return {
          state,
          phase,
          reason: 'WSL2 已就绪，应用私有发行版尚未导入',
          fixHint: '在设置页完成沙箱准备（导入 Kepcup 发行版）',
        };
      }
    }
  }

  // --- enable (任务 2: 管理员授权 + 重启后续导) ---------------------------------

  /**
   * Runs `wsl --install --no-distribution` elevated (UAC prompt) and moves
   * the state machine to awaiting_reboot. Idempotent: components already
   * present make the command a no-op; the reboot requirement is surfaced to
   * the user regardless (a changed optional component needs the reboot).
   */
  async requestEnable(): Promise<WslStatusReport> {
    this.#persist({ phase: 'enabling', updatedAt: this.#now() });
    const result = await this.#runElevated(['--install', '--no-distribution']);
    if (result.error !== undefined || (result.exitCode !== null && result.exitCode !== 0)) {
      const reason = `启用 WSL 失败（管理员授权被拒绝或命令失败）：${result.error ?? (decodeWslOutput(result.stderr).trim() || `退出码 ${result.exitCode}`)}`;
      this.#persist({ phase: 'failed', reason, updatedAt: this.#now() });
      return { state: await this.detect(), phase: 'failed', reason };
    }
    this.#persist({ phase: 'awaiting_reboot', updatedAt: this.#now() });
    return { state: await this.detect(), phase: 'awaiting_reboot', reason: 'WSL 启用命令已完成；请重启 Windows，重启后应用会自动继续导入发行版' };
  }

  // --- import & configure (任务 3) ---------------------------------------------

  /** Path of the bundled rootfs artifact (resources/wsl/rootfs.tar, CI 产出). */
  resolveRootfsTar(env: NodeJS.ProcessEnv = this.#env): string | null {
    const override = env.KEPCUP_WSL_ROOTFS;
    if (override !== undefined && override.length > 0) return existsSync(override) ? override : null;
    // Repo checkout layout: apps/desktop/resources/wsl/rootfs.tar, resolved
    // from this module's location (mirrors resolveBundledBinDir).
    let current = path.dirname(wslSetupModuleDir());
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(current, 'apps', 'desktop', 'resources', 'wsl', 'rootfs.tar');
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  }

  /**
   * Imports + configures the private distro. Steps (任务 3): import as WSL2 →
   * write /etc/wsl.conf (automount/interop off — 安全基线，无开关) → create
   * the ordinary user → `wsl --terminate` to apply the config → verify the
   * shim/srt availability. Each step is idempotent so a retry after a
   * partial run converges.
   */
  async ensureDistro(options: { signal?: AbortSignal } = {}): Promise<WslStatusReport> {
    const before = await this.status();
    if (before.state.install.kind !== 'ok') return before;
    if (before.state.distro.kind === 'wsl1') return before;
    if (before.state.distro.kind === 'registered' && before.phase === 'ready') return before;

    const rootfs = this.resolveRootfsTar();
    if (rootfs === null) {
      const reason = '未找到应用自带的 rootfs 产物（resources/wsl/rootfs.tar）——安装包不完整';
      this.#persist({ phase: 'failed', reason, updatedAt: this.#now() });
      return { ...before, phase: 'failed', reason };
    }

    const baseDir = sandboxWslDir(this.#paths);
    mkdirSync(baseDir, { recursive: true });
    this.#persist({ phase: 'importing', updatedAt: this.#now() });
    if (before.state.distro.kind === 'absent') {
      const imported = await this.#runner.run(
        ['--import', WSL_DISTRO_NAME, baseDir, rootfs, '--version', '2'],
        { timeoutMs: 15 * 60_000, signal: options.signal },
      );
      if (imported.exitCode !== 0) {
        const reason = `导入发行版失败：${decodeWslOutput(imported.stderr).trim() || `退出码 ${imported.exitCode}`}`;
        this.#persist({ phase: 'failed', reason, updatedAt: this.#now() });
        return { ...before, phase: 'failed', reason };
      }
    }

    this.#persist({ phase: 'configuring', updatedAt: this.#now() });
    const conf = buildWslConf();
    const writeConf = await this.#runner.run(
      ['-d', WSL_DISTRO_NAME, '-u', 'root', '--', 'tee', '/etc/wsl.conf'],
      { input: conf, timeoutMs: 30_000, signal: options.signal },
    );
    if (writeConf.exitCode !== 0) {
      const reason = `写入 wsl.conf 失败：${decodeWslOutput(writeConf.stderr).trim() || `退出码 ${writeConf.exitCode}`}`;
      this.#persist({ phase: 'failed', reason, updatedAt: this.#now() });
      return { ...before, phase: 'failed', reason };
    }

    // Idempotent user creation; passwordless (no sudo needed — mounts run via
    // `-u root`, sandbox commands run as kepcup without elevation).
    const createUser = await this.#runner.run(
      [
        '-d', WSL_DISTRO_NAME, '-u', 'root', '--',
        'bash', '-c',
        `id -u ${WSL_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${WSL_USER}`,
      ],
      { timeoutMs: 30_000, signal: options.signal },
    );
    if (createUser.exitCode !== 0) {
      const reason = `创建发行版用户失败：${decodeWslOutput(createUser.stderr).trim() || `退出码 ${createUser.exitCode}`}`;
      this.#persist({ phase: 'failed', reason, updatedAt: this.#now() });
      return { ...before, phase: 'failed', reason };
    }

    // wsl.conf only applies after a terminate.
    await this.#runner.run(['--terminate', WSL_DISTRO_NAME], { timeoutMs: 30_000, signal: options.signal });

    // Verify the shim/srt inside the distro (任务 3: 验证 srt 可用).
    const selfCheck = await this.#runner.run(
      ['-d', WSL_DISTRO_NAME, '-u', WSL_USER, '--', WSL_SHIM_BIN, '--selfcheck'],
      { timeoutMs: 120_000, signal: options.signal },
    );
    if (selfCheck.exitCode !== 0) {
      const reason = `发行版内 srt 自检失败：${decodeWslOutput(selfCheck.stderr).trim() || decodeWslOutput(selfCheck.stdout).trim() || `退出码 ${selfCheck.exitCode}`}（srt 依赖在该发行版中的可用性见 rootfs 构建说明）`;
      this.#persist({ phase: 'failed', reason, updatedAt: this.#now() });
      return { ...before, phase: 'failed', reason };
    }

    this.#persist({ phase: 'ready', updatedAt: this.#now() });
    return { state: await this.detect(), phase: 'ready' };
  }

  /**
   * Runs one mount action via the fixed root-side script. The source path is
   * transported base64-encoded and the mountpoint/mode are strictly
   * validated by kepcup-mount itself — the args here are never user input
   * (mounts.ts is the validation layer).
   */
  async runMount(args: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WslRunResult> {
    return this.#runner.run(['-d', WSL_DISTRO_NAME, '-u', 'root', '--', WSL_MOUNT_BIN, ...args], {
      timeoutMs: options.timeoutMs ?? 60_000,
      signal: options.signal,
    });
  }

  /** Current persisted snapshot (phase for the UI). */
  snapshot(): WslSetupSnapshot | null {
    return this.#snapshot;
  }

  /** P12-B: whether the user skipped the preparation (first-launch prompt). */
  get skipped(): boolean {
    return this.#snapshot?.skippedAt !== undefined;
  }

  /** P12-B: records the skip decision (persisted, survives phase changes). */
  markSkipped(): void {
    this.#persist({
      phase: this.#snapshot?.phase ?? 'idle',
      ...(this.#snapshot?.reason !== undefined ? { reason: this.#snapshot.reason } : {}),
      skippedAt: this.#now(),
      updatedAt: this.#now(),
    });
  }

  // --- persistence ---------------------------------------------------------------

  #loadSnapshot(): WslSetupSnapshot | null {
    const file = wslSetupStatePath(this.#paths);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        phase?: string;
        reason?: string;
        skippedAt?: number;
        updatedAt?: number;
      };
      if (typeof parsed.phase !== 'string') return null;
      return {
        phase: parsed.phase as WslSetupPhase,
        ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
        ...(typeof parsed.skippedAt === 'number' ? { skippedAt: parsed.skippedAt } : {}),
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      };
    } catch {
      return null;
    }
  }

  #persist(snapshot: WslSetupSnapshot): void {
    // The skip decision is the user's, not the machine's: phase transitions
    // carry it forward instead of clearing it.
    const carried =
      snapshot.skippedAt === undefined && this.#snapshot?.skippedAt !== undefined
        ? { skippedAt: this.#snapshot.skippedAt }
        : {};
    this.#snapshot = { ...snapshot, ...carried };
    try {
      mkdirSync(sandboxWslDir(this.#paths), { recursive: true });
      writeFileSync(wslSetupStatePath(this.#paths), JSON.stringify(this.#snapshot), 'utf8');
    } catch {
      // Best-effort persistence; the state machine re-derives from wsl.exe
      // on the next probe even without the file.
    }
  }

  // --- runner helpers -------------------------------------------------------------

  async #runElevated(args: string[]): Promise<WslRunResult> {
    if (this.#runner.runElevated !== undefined) return this.#runner.runElevated(args);
    return this.#runner.run(args);
  }
}

// --- production runner -------------------------------------------------------------

/** Production WslRunner: spawns wsl.exe directly (argv array, no shell). */
export function createWslRunner(env: NodeJS.ProcessEnv = process.env): WslRunner {
  void env;
  return {
    run(args, options = {}) {
      return runWslProcess(WSL_EXE, args, options);
    },
    // UAC elevation: PowerShell Start-Process -Verb RunAs spawns wsl.exe in a
    // separate elevated process; -Wait blocks until it exits and -PassThru
    // forwards its exit code. Every argument is a fixed constant here.
    runElevated(args) {
      const argumentList = args.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(',');
      const psCommand = `$p = Start-Process -FilePath '${WSL_EXE}' -ArgumentList ${argumentList} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
      return runWslProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
        timeoutMs: 30 * 60_000,
      });
    },
  };
}

function runWslProcess(
  command: string,
  args: string[],
  options: { timeoutMs?: number; input?: string; stdinFile?: string; signal?: AbortSignal },
): Promise<WslRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // wsl.exe on PATH (System32); never through a shell — every argument
        // here is a constant or a validated path.
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: String(error) });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timeoutHandle =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill('SIGKILL');
          }, options.timeoutMs)
        : undefined;
    timeoutHandle?.unref?.();
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error: String(error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    if (options.stdinFile !== undefined) {
      // Streamed stdin (P12 distro toolchain extraction: a host tar file
      // piped into the distro) — never buffered whole in memory.
      const stream = createReadStream(options.stdinFile);
      stream.on('error', () => child.stdin?.end());
      stream.pipe(child.stdin!);
    } else if (options.input !== undefined) {
      child.stdin?.end(options.input, 'utf8');
    } else {
      child.stdin?.end();
    }
  });
}

/** Directory of this module at runtime (repo checkout rootfs resolution). */
function wslSetupModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}
