import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { srtFilesystemFor, srtNetworkConfigFor } from './backend-srt.js';
import { WslSetup, createWslRunner, type WslRunner } from './wsl/setup.js';
import { encodeExecRequest, parseExecResponse } from './wsl/protocol.js';
import { encodeMountSource, isValidMountpoint, planMounts, type MountRegistration } from './wsl/mounts.js';
import { distroCachePath, distroToWindowsPath, type DistroMount } from './wsl/paths.js';
import { DISTRO_BASE_ENV, WSL_DISTRO_NAME, WSL_SHIM_BIN, WSL_USER } from './wsl/constants.js';
import { readOnlyRoots } from './sensitive-paths.js';
import type {
  SandboxAvailability,
  SandboxBackend,
  SandboxBackendKind,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxPolicy,
} from './types.js';
import type { AppPaths } from '../infra/paths.js';
import type { CoreLogger } from '../infra/logger.js';

/** Standard PATH inside the rootfs (the build script provisions /opt/kepcup/bin). */
const DISTRO_BASE_PATH = '/opt/kepcup/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export interface WslBackendOptions {
  paths: AppPaths;
  logger: CoreLogger;
  platform: string;
  /** Windows cache directories rewritten to the in-distro cache root. */
  cacheDirs: Array<{ path: string; name: string }>;
  /** 红线：registration of every mountable Windows directory (mounts.ts). */
  registration: MountRegistration;
  /**
   * P06 distro toolchains: PATH prefix of the toolchains installed INSIDE the
   * distro (EnvManager.distroToolchainPathPrefix, wired by start.ts).
   */
  distroToolchainPrefix?: () => string | null;
  /** Injectable runner (tests); defaults to the production wsl.exe runner. */
  runner?: WslRunner;
  /**
   * Shared state-machine instance (P12-B): start.ts passes the same WslSetup
   * to the backend and the wizard RPC so both read one persisted snapshot.
   * Defaults to a private instance over `runner`.
   */
  setup?: WslSetup;
  env?: NodeJS.ProcessEnv;
}

/**
 * Windows default (and enhanced) sandbox backend: the private WSL2 distro
 * runs srt over the planned drvfs mounts (docs/design/10-sandbox.md).
 *
 * probe() reports the WSL/distro state with structured reasons — an
 * unavailable backend is what keeps Windows in per-command confirm mode
 * (逐条确认模式), never silent fallback. exec() fails closed: unregistered
 * policy paths refuse the whole command (mounts.ts 红线) instead of running
 * against a narrower filesystem view.
 *
 * Platform-bound integration (real wsl.exe, real distro) is covered by
 * describe.skipIf(process.platform !== 'win32') tests —
 * packages/core/test/integration/wsl-backend.test.ts (head comment lists the
 * machine requirements); everything here is exercised on macOS through the
 * injectable runner fixtures.
 */
export class WslSandboxBackend implements SandboxBackend {
  readonly kind: SandboxBackendKind = 'wsl';
  readonly #opts: WslBackendOptions;
  readonly #runner: WslRunner;
  readonly #setup: WslSetup;
  #availability: SandboxAvailability | null = null;

  constructor(opts: WslBackendOptions) {
    this.#opts = opts;
    this.#runner = opts.runner ?? createWslRunner(opts.env);
    this.#setup = opts.setup ?? new WslSetup({ paths: opts.paths, runner: this.#runner });
  }

  /** Late wiring of the mount registration (start.ts: the domain services
   * providing the registered paths do not exist at construction time). */
  setRegistration(registration: MountRegistration): void {
    this.#opts.registration = registration;
  }

  async probe(force = false): Promise<SandboxAvailability> {
    if (this.#opts.platform !== 'win32') {
      return { backend: 'none', available: false, reason: 'WSL2 沙箱仅在 Windows 上可用' };
    }
    if (this.#availability !== null && !force) return this.#availability;
    const report = await this.#setup.status();
    const verdict: SandboxAvailability =
      report.state.install.kind !== 'ok'
        ? {
            backend: 'wsl',
            available: false,
            ...(report.reason !== undefined ? { reason: report.reason } : {}),
            ...(report.fixHint !== undefined ? { fixHint: report.fixHint } : {}),
          }
        : report.state.distro.kind !== 'registered'
          ? {
              backend: 'wsl',
              available: false,
              ...(report.reason !== undefined ? { reason: report.reason } : {}),
              ...(report.fixHint !== undefined ? { fixHint: report.fixHint } : {}),
            }
          : report.phase === 'failed'
            ? {
                backend: 'wsl',
                available: false,
                reason: report.reason ?? '发行版配置未完成',
                ...(report.fixHint !== undefined ? { fixHint: report.fixHint } : {}),
              }
            : { backend: 'wsl', available: true };
    this.#availability = verdict;
    return verdict;
  }

  async exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    const availability = await this.probe();
    if (!availability.available) {
      const details = availability.fixHint ? `（修复提示：${availability.fixHint}）` : '';
      throw new Error(`SANDBOX_UNAVAILABLE: ${availability.reason ?? 'WSL2 沙箱不可用'}${details}`);
    }

    // 红线：plan the mounts against the registration; any rejection refuses
    // the whole command (mounts.ts).
    const plan = planMounts(req.policy, {
      cwd: req.cwd,
      registration: this.#opts.registration,
      cacheDirs: this.#opts.cacheDirs,
      // BR-P12-003: the host's home toolchain directories (readOnlyRoots on
      // win32: ~/.cargo, ~/go, …) are NOT projected into the distro — it
      // ships its own toolchains and the in-distro PATH points at them, so
      // these policy entries are skipped instead of rejecting every command
      // on machines that happen to have them.
      skipReadOnlyRoots: readOnlyRoots(this.#opts.platform),
    });
    if (plan.rejections.length > 0 || plan.distroCwd === null) {
      const detail = plan.rejections.map((entry) => `${entry.kind}:${entry.path}（${entry.reason}）`).join('；');
      throw new Error(`SANDBOX_POLICY_DENIED: 策略中包含未登记的 Windows 路径，拒绝在发行版内执行：${detail}`);
    }

    await this.#ensureMounts(plan.mounts, req.signal);
    // BR-P12-001: the mount lives exactly as long as some command's plan
    // includes it — the release below unmounts as soon as the last user is
    // done, so revoked one-time grants do not linger in the shared VM. The
    // distro-side srt config denies /mnt/kepcup wholesale in the meantime, so a
    // still-mounted leftover is unreadable by any command whose plan does
    // not re-expose it.
    try {
      const distroPolicy: SandboxPolicy = {
        readWrite: plan.distroReadWrites,
        readOnly: plan.distroReadOnlys,
        denyRead: plan.distroDenyReads,
        network: req.policy.network,
        env: this.#distroEnv(req.policy),
      };

      // BR-P12-005: the result record must echo this one-time nonce —
      // command output alone cannot forge a result.
      const nonce = randomBytes(16).toString('hex');
      const request = encodeExecRequest({
        command: req.command,
        cwd: plan.distroCwd,
        timeoutMs: req.timeoutMs,
        filesystem: srtFilesystemFor(distroPolicy),
        network: srtNetworkConfigFor(distroPolicy),
        env: distroPolicy.env,
        nonce,
      });

      // argv is a fixed array (no shell on either side): the command text and
      // the policy travel inside the stdin JSON, never through wsl.exe's
      // argument parsing.
      const run = await this.#runner.run(
        ['-d', WSL_DISTRO_NAME, '-u', WSL_USER, '--', WSL_SHIM_BIN],
        { input: request, timeoutMs: req.timeoutMs + 60_000, signal: req.signal },
      );
      if (run.error !== undefined) {
        throw new Error(`SANDBOX_EXEC_FAILED: 无法启动发行版内沙箱进程：${run.error}`);
      }
      const { result, stdout, stderr } = parseExecResponse({ stdout: run.stdout, stderr: run.stderr }, { expectedNonce: nonce });
      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
        timedOut: result.timedOut,
        // Violation lines carry distro paths; map mount points back to their
        // Windows spelling so the model's access hints stay meaningful.
        violations: result.violations.map((violation) => ({
          line: this.#remapViolationLine(violation.line, plan.mounts),
          ...(violation.command !== undefined ? { command: violation.command } : {}),
        })),
      };
    } finally {
      await this.#releaseMounts(plan.mounts);
    }
  }

  // --- internals -------------------------------------------------------------

  /** Live references per mountpoint: unmount only when the last user leaves. */
  readonly #mountRefs = new Map<string, number>();

  /** Idempotently mounts every planned directory (root script via kepcup-mount). */
  async #ensureMounts(
    mounts: readonly DistroMount[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const mount of mounts) {
      if (!isValidMountpoint(mount.mountpoint)) {
        throw new Error(`SANDBOX_POLICY_DENIED: 挂载点形状非法：${mount.mountpoint}`);
      }
      const result = await this.#setup.runMount(
        ['mount', '--src-b64', encodeMountSource(mount.source), '--mountpoint', mount.mountpoint, '--mode', mount.mode],
        { signal },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `SANDBOX_MOUNT_FAILED: 挂载 ${mount.source} 失败：${result.stderr.toString('utf8').trim() || `退出码 ${result.exitCode}`}`,
        );
      }
      this.#mountRefs.set(mount.mountpoint, (this.#mountRefs.get(mount.mountpoint) ?? 0) + 1);
    }
  }

  /**
   * Drops one reference per planned mountpoint and unmounts it when the
   * last user is gone (BR-P12-001 cleanup: revoked grants / one-time grants
   * leave no mounted residue behind once their command finished). Best
   * effort by design — a busy mount cannot be unmounted, and a failure here
   * must never mask the command's own outcome (the srt config keeps the
   * leftover unreadable either way).
   */
  async #releaseMounts(mounts: readonly DistroMount[]): Promise<void> {
    for (const mount of mounts) {
      const refs = this.#mountRefs.get(mount.mountpoint);
      if (refs === undefined) continue; // mount never acquired (earlier failure)
      if (refs > 1) {
        this.#mountRefs.set(mount.mountpoint, refs - 1);
        continue;
      }
      this.#mountRefs.delete(mount.mountpoint);
      try {
        const result = await this.#setup.runMount(['umount', '--mountpoint', mount.mountpoint]);
        if (result.exitCode !== 0) {
          this.#opts.logger.warn(
            { mountpoint: mount.mountpoint, exitCode: result.exitCode },
            'kepcup-mount umount failed (best-effort cleanup; the mount stays denied by the distro policy)',
          );
        }
      } catch (error) {
        try {
          this.#opts.logger.warn(
            { mountpoint: mount.mountpoint, error: error instanceof Error ? error.message : String(error) },
            'kepcup-mount umount failed (best-effort cleanup)',
          );
        } catch {
          // Logger already torn down — cleanup stays best-effort.
        }
      }
    }
  }

  /** Policy env over the distro base env (BR-P12-006): the shim replaces the
   * child env wholesale, so identity/locale/temp basics must travel in the
   * request — the policy's own PATH and cache variables win, and the host
   * PATH never crosses into the distro. Same allowlist semantics as the srt
   * backend's childEnvFor (BR-P02-008). */
  #distroEnv(policy: SandboxPolicy): Record<string, string> {
    const env: Record<string, string> = { ...DISTRO_BASE_ENV };
    for (const [key, value] of Object.entries(policy.env)) {
      if (key === 'PATH') {
        // In-distro PATH: distro toolchain bins (P06 linux entries) + the
        // rootfs system paths. The Windows PATH never crosses into the
        // distro (interop.appendWindowsPath=false also hides it).
        const prefix = this.#opts.distroToolchainPrefix?.() ?? null;
        env[key] = prefix !== null ? `${prefix}:${DISTRO_BASE_PATH}` : DISTRO_BASE_PATH;
        continue;
      }
      const cache = this.#opts.cacheDirs.find(
        (entry) => entry.path === value || path.normalize(entry.path) === path.normalize(value),
      );
      env[key] = cache !== undefined ? distroCachePath(cache.name) : value;
    }
    return env;
  }

  #remapViolationLine(line: string, mounts: readonly DistroMount[]): string {
    let remapped = line;
    for (const mount of [...mounts].sort((a, b) => b.mountpoint.length - a.mountpoint.length)) {
      if (remapped.includes(mount.mountpoint)) {
        const windows = distroToWindowsPath(mount.mountpoint, mounts) ?? mount.source;
        remapped = remapped.split(mount.mountpoint).join(windows);
      }
    }
    return remapped;
  }
}
