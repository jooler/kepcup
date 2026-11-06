import { spawn, type ChildProcess } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { LIMA_SHIM_BIN, LIMA_VM_NAME } from './lima/constants.js';
import { limaInstanceState, parseLimaList } from './lima/list.js';
import { hostPathWithCommonDirs } from '../infra/paths.js';

import { srtFilesystemFor, srtNetworkConfigFor } from './backend-srt.js';
import { encodeExecRequest, parseExecResponse } from './wsl/protocol.js';
import { resolvePolicyMounts, type MountRegistration, type PolicyRejection, type ResolvedMount } from './wsl/mounts.js';
import { DISTRO_BASE_ENV, WSL_SHIM_BIN, WSL_USER } from './wsl/constants.js';
import { isInsideWindowsPath } from './wsl/paths.js';
import { isInsidePath, readOnlyRoots } from './sensitive-paths.js';
import type {
  SandboxAvailability,
  SandboxBackend,
  SandboxBackendKind,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxUnavailableState,
} from './types.js';
import type { CoreLogger } from '../infra/logger.js';

/**
 * Enhanced-level backends (docs/design/10-sandbox.md "增强级"):
 *   macOS → Lima VM (`limactl`), Linux → rootless Podman.
 *
 * They reuse the SAME rule layer as the default backend — the policy is
 * produced by buildSandboxPolicy and mapped with srtFilesystemFor /
 * srtNetworkConfigFor; the in-image shim (`/opt/kepcup/bin/kepcup-sandbox`, built
 * once by apps/desktop/scripts/build-wsl-rootfs/ and shipped in the Podman
 * image and the Lima VM as well) wraps the command with srt inside the VM
 * exactly like the WSL distro does. Only the transport differs:
 *
 *  - Podman: `podman run --rm -i … -v <host>:<host>…` — per-command binds of
 *    the resolved policy paths at IDENTICAL in-container paths (no path
 *    rewriting; docs/dev/phases/P12 任务 6 文件系统/网络规则与默认级一致);
 *  - Lima: `limactl shell --workdir … kepcup -- …` — the VM is created and
 *    provisioned by the settings-page preparation wizard (sandbox/lima,
 *    mounts at identical paths, shim + srt installed in the guest);
 *    probe() requires the VM to run AND the shim to be initialized.
 *
 * 红线 (same as the WSL backend): every host path the policy needs visible
 * inside the VM must be registered (data home / bound workdir / active
 * grants) or belong to the static read-only roots — resolvePolicyMounts
 * fails the whole command otherwise.
 *
 * Platform reality: Lima is exercised on macOS (setup wizard creates the VM
 * and initializes the guest tooling); the Podman path targets Linux and its
 * image import is still pending (todo/cross-platform-acceptance.md P12).
 * The security use-case suites still need a real Linux machine for Podman
 * (任务书 测试要求「增强级：在 macOS 与 Linux 上运行安全用例集」).
 */

/** Lima VM instance name provisioned for the app (re-exported for consumers). */
export { LIMA_VM_NAME } from './lima/constants.js';

/** Podman image tag built from the same rootfs artifact (CI 产出). */
export const PODMAN_IMAGE = 'kepcup-sandbox:1';

/** Standard PATH inside the rootfs (identical to the WSL backend). */
const DISTRO_BASE_PATH = '/opt/kepcup/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** Injectable CLI runner (same shape as the WSL runner). */
export interface CliRunner {
  run(
    argv: string[],
    options?: { timeoutMs?: number; input?: string; signal?: AbortSignal },
  ): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer; error?: string }>;
}

export interface ContainerBackendOptions {
  logger: CoreLogger;
  platform: string;
  /** 红线：registered mountable directories (shared with the WSL backend). */
  registration: MountRegistration;
  /** App data home (canonical) — the boundary for "needs a bind" paths. */
  dataHome: string;
  runner?: CliRunner;
}

/** CLI existence + version probe (injected in tests). */
async function commandAvailable(runner: CliRunner, command: string, args: string[]): Promise<boolean> {
  const result = await runner.run([command, ...args], { timeoutMs: 15_000 });
  return result.error === undefined && result.exitCode === 0;
}

/**
 * Shared implementation. Subclasses provide kind + the transport-specific
 * probe tail and argv construction.
 */
export abstract class ContainerSandboxBackend implements SandboxBackend {
  abstract readonly kind: SandboxBackendKind;
  protected readonly opts: ContainerBackendOptions;
  protected readonly runner: CliRunner;
  #availability: SandboxAvailability | null = null;

  constructor(opts: ContainerBackendOptions) {
    this.opts = opts;
    this.runner = opts.runner ?? spawnCliRunner();
  }

  /** Late wiring (start.ts) — mirrors the WSL backend. */
  setRegistration(registration: MountRegistration): void {
    this.opts.registration = registration;
  }

  async probe(force = false): Promise<SandboxAvailability> {
    if (this.#availability !== null && !force) return this.#availability;
    this.#availability = await this.#probeOnce();
    return this.#availability;
  }

  lastAvailability(): SandboxAvailability | null {
    return this.#availability;
  }

  async #probeOnce(): Promise<SandboxAvailability> {
    const cli = await this.cliAvailable();
    if (!cli.available) {
      return {
        backend: this.kind,
        available: false,
        reason: cli.reason,
        fixHint: cli.fixHint,
        state: cli.state ?? 'cli_missing',
      };
    }
    return this.instanceReady();
  }

  async exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    const availability = await this.probe();
    if (!availability.available) {
      const details = availability.fixHint ? `（修复提示：${availability.fixHint}）` : '';
      throw new Error(`SANDBOX_UNAVAILABLE: ${availability.reason ?? '增强沙箱不可用'}${details}`);
    }

    // 红线：authorization walk + cwd coverage; rejections refuse the command.
    const resolved = resolvePolicyMounts(req.policy, {
      cwd: req.cwd,
      registration: this.opts.registration,
      trustedReadOnlyRoots: readOnlyRoots(this.opts.platform),
      // macOS policy re-allows this one file out of the denied home (srt does
      // the same). It is already visible through the home mount — no bind and
      // no rejection (same carve-out as the WSL image-owned roots).
      ...(this.opts.platform === 'darwin'
        ? { skipReadOnlyRoots: [path.join(homedir(), '.CFUserTextEncoding')] }
        : {}),
    });
    const rejections = cwdCoverageRejections(req.cwd, resolved.entries, this.opts.platform);
    if (resolved.rejections.length > 0 || rejections.length > 0) {
      const detail = [...resolved.rejections, ...rejections]
        .map((entry) => `${entry.kind}:${entry.path}（${entry.reason}）`)
        .join('；');
      throw new Error(`SANDBOX_POLICY_DENIED: 策略中包含未登记的主机路径，拒绝在增强沙箱内执行：${detail}`);
    }

    const env = this.#distroEnv(req.policy);
    // BR-P12-005: the result record must echo this one-time nonce — command
    // output alone cannot forge a result.
    const nonce = randomBytes(16).toString('hex');
    const request = encodeExecRequest({
      command: req.command,
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
      filesystem: srtFilesystemFor({ ...req.policy, env }),
      network: srtNetworkConfigFor(req.policy),
      env,
      nonce,
    });

    const argv = this.execArgv(req, resolved.entries);
    const run = await this.runner.run(argv, {
      input: request,
      timeoutMs: req.timeoutMs + 60_000,
      signal: req.signal,
    });
    if (run.error !== undefined) {
      throw new Error(`SANDBOX_EXEC_FAILED: 无法启动增强沙箱进程：${run.error}`);
    }
    const { result, stdout, stderr } = parseExecResponse({ stdout: run.stdout, stderr: run.stderr }, { expectedNonce: nonce });
    return {
      exitCode: result.exitCode,
      stdout,
      stderr,
      timedOut: result.timedOut,
      violations: result.violations,
    };
  }

  // --- subclass contract -------------------------------------------------------

  /** CLI presence check with a localized install hint when absent. */
  protected abstract cliAvailable(): Promise<{
    available: boolean;
    reason: string;
    fixHint: string;
    state?: SandboxUnavailableState;
  }>;
  /** VM / image readiness (after the CLI exists). */
  protected abstract instanceReady(): Promise<SandboxAvailability>;
  /** Transport argv; the shim receives the request on stdin. */
  protected abstract execArgv(req: SandboxExecRequest, mounts: readonly ResolvedMount[]): string[];

  /**
   * Base env inside the guest (identity/locale/temp). WSL/Podman use the
   * dedicated `kepcup` account from the rootfs/image; Lima runs as the Lima
   * default user (the host user), so it overrides HOME/USER/LOGNAME.
   */
  protected baseEnv(): Record<string, string> {
    return { ...DISTRO_BASE_ENV };
  }

  // --- internals ---------------------------------------------------------------

  /** Env over the image base env (BR-P12-006, same as the WSL backend): the
   * shim replaces the child env wholesale, so identity/locale/temp basics
   * travel in the request; the policy's own PATH and cache variables win. */
  #distroEnv(policy: SandboxExecRequest['policy']): Record<string, string> {
    const env: Record<string, string> = this.baseEnv();
    for (const [key, value] of Object.entries(policy.env)) {
      if (key === 'PATH') {
        // The policy PATH starts with the mounted toolchain bins (host paths
        // that are also the in-VM paths through the 1:1 binds); the host
        // PATH tail is replaced — host directories do not exist inside the VM.
        const entries = value.split(path.delimiter);
        const prefix = entries[0] ?? '';
        const looksLikeToolchainDir = prefix.startsWith('/') && prefix.includes('/toolchains/');
        env[key] = looksLikeToolchainDir ? `${prefix}:${DISTRO_BASE_PATH}` : DISTRO_BASE_PATH;
        continue;
      }
      env[key] = value;
    }
    return env;
  }
}

/**
 * cwd coverage rejection shared by the exec path and unit tests. Exported so
 * the coverage semantics (the container flavor of the mounts.ts 红线) are
 * unit-testable directly. BR-P12-007: built on the standard path primitives
 * (isInsidePath / isInsideWindowsPath) — the previous hand-written prefix
 * compare violated the path red line convention (P09 先例).
 */
export function cwdCoverageRejections(cwd: string, mounts: readonly ResolvedMount[], platform: string): PolicyRejection[] {
  const posix = platform !== 'win32';
  // The "not absolute" escape hatch must use the flavor's own rules: the
  // default `path` module is the HOST's (a Windows path is not absolute on a
  // POSIX host), so the win32 flavor asks path.win32.
  const absolute = posix ? path.isAbsolute(cwd) : path.win32.isAbsolute(cwd);
  const covered =
    mounts.some((entry) =>
      posix ? isInsidePath(cwd, entry.source) : isInsideWindowsPath(cwd, entry.source),
    ) || !absolute;
  return covered
    ? []
    : [{ path: cwd, kind: 'cwd', reason: '工作目录不在任何已登记挂载之内，拒绝执行' }];
}

/** Podman enhanced backend (Linux). */
export class PodmanSandboxBackend extends ContainerSandboxBackend {
  readonly kind: SandboxBackendKind = 'podman';

  protected async cliAvailable(): Promise<{
    available: boolean;
    reason: string;
    fixHint: string;
    state?: SandboxUnavailableState;
  }> {
    const ok = await commandAvailable(this.runner, 'podman', ['--version']);
    return ok
      ? { available: true, reason: '', fixHint: '' }
      : {
          available: false,
          reason: '未安装 rootless Podman，增强沙箱不可用',
          fixHint: '安装 rootless Podman（如 sudo apt install podman / sudo dnf install podman），或经设置页的环境管理器安装',
          state: 'cli_missing',
        };
  }

  protected async instanceReady(): Promise<SandboxAvailability> {
    const image = await this.runner.run(['podman', 'image', 'exists', PODMAN_IMAGE], { timeoutMs: 15_000 });
    if (image.exitCode !== 0) {
      return {
        backend: 'podman',
        available: false,
        reason: '增强沙箱镜像尚未导入',
        fixHint: '在设置页导入增强沙箱镜像（podman import rootfs.tar）',
        state: 'instance_missing',
      };
    }
    return { backend: 'podman', available: true };
  }

  protected execArgv(req: SandboxExecRequest, mounts: readonly ResolvedMount[]): string[] {
    const argv = ['podman', 'run', '--rm', '-i', '--user', WSL_USER];
    for (const mount of mounts) {
      // Identical paths: the policy needs no rewriting inside the container.
      argv.push('-v', `${mount.source}:${mount.source}:${mount.mode === 'rw' ? 'rw' : 'ro'}`);
    }
    argv.push('-w', req.cwd, PODMAN_IMAGE, WSL_SHIM_BIN);
    return argv;
  }
}

/** Lima enhanced backend (macOS). */
export class LimaSandboxBackend extends ContainerSandboxBackend {
  readonly kind: SandboxBackendKind = 'lima';

  protected async cliAvailable(): Promise<{
    available: boolean;
    reason: string;
    fixHint: string;
    state?: SandboxUnavailableState;
  }> {
    const ok = await commandAvailable(this.runner, 'limactl', ['--version']);
    return ok
      ? { available: true, reason: '', fixHint: '' }
      : {
          available: false,
          reason: '未安装 Lima，增强沙箱不可用',
          fixHint: '安装 Lima（brew install lima），或经设置页的环境管理器安装增强沙箱',
          state: 'cli_missing',
        };
  }

  protected async instanceReady(): Promise<SandboxAvailability> {
    const list = await this.runner.run(['limactl', 'list', '--json'], { timeoutMs: 20_000 });
    if (list.exitCode !== 0) {
      return {
        backend: 'lima',
        available: false,
        reason: 'Lima 已安装但增强沙箱虚拟机尚未创建',
        fixHint: '在设置页的沙箱准备向导中创建增强沙箱虚拟机',
        state: 'instance_missing',
      };
    }
    const state = limaInstanceState(parseLimaList(list.stdout.toString('utf8')));
    // `limactl list --json` exits 0 with empty output when no instance exists:
    // that is "not created yet", not "installed but stopped".
    if (state === 'missing') {
      return {
        backend: 'lima',
        available: false,
        reason: 'Lima 已安装但增强沙箱虚拟机尚未创建',
        fixHint: '在设置页的沙箱准备向导中创建增强沙箱虚拟机',
        state: 'instance_missing',
      };
    }
    if (state === 'stopped') {
      return {
        backend: 'lima',
        available: false,
        reason: '增强沙箱虚拟机未在运行',
        fixHint: '在设置页的沙箱准备向导中启动增强沙箱虚拟机',
        state: 'instance_stopped',
      };
    }
    // Running is not enough: the guest must have the sandbox shim and its
    // runtime (provisioned by the setup wizard). Without this check the
    // backend would advertise "available" while every exec fails.
    const shim = await this.runner.run(
      ['limactl', 'shell', '--tty=false', LIMA_VM_NAME, '--', 'test', '-x', LIMA_SHIM_BIN],
      { timeoutMs: 20_000 },
    );
    if (shim.exitCode !== 0 || shim.error !== undefined) {
      return {
        backend: 'lima',
        available: false,
        reason: '增强沙箱虚拟机已运行，但沙箱工具尚未初始化',
        fixHint: '在设置页的沙箱准备向导中初始化沙箱工具',
        state: 'instance_unprovisioned',
      };
    }
    return { backend: 'lima', available: true };
  }

  /**
   * Lima uses the host-matching default user (the VM mounts `~` with the host
   * UID), so the WSL rootfs account does not exist there.
   */
  protected override baseEnv(): Record<string, string> {
    let username = DISTRO_BASE_ENV.USER!;
    try {
      username = userInfo().username;
    } catch {
      // keep the WSL default in odd environments
    }
    return {
      ...DISTRO_BASE_ENV,
      ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
      USER: username,
      LOGNAME: username,
    };
  }

  protected execArgv(req: SandboxExecRequest, _mounts: readonly ResolvedMount[]): string[] {
    // Lima mounts are provisioned at VM creation (identical paths); exec
    // only needs the workdir. `limactl shell` is the Lima 2.x command (there
    // is no `limactl exec`); stdin carries the shim protocol.
    void _mounts;
    return ['limactl', 'shell', '--tty=false', '--workdir', req.cwd, LIMA_VM_NAME, '--', LIMA_SHIM_BIN];
  }
}

/** Production runner over plain argv (no shell), kill-tree on timeout/abort. */
export function spawnCliRunner(): CliRunner {
  return {
    run(argv, options = {}) {
      return new Promise((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn(argv[0]!, argv.slice(1), {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            detached: process.platform !== 'win32',
            env: { ...process.env, PATH: hostPathWithCommonDirs() },
          });
        } catch (error) {
          resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: String(error) });
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let settled = false;
        const killTree = (): void => {
          if (child.pid === undefined) return;
          try {
            if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        };
        const timeoutHandle = options.timeoutMs !== undefined ? setTimeout(killTree, options.timeoutMs) : undefined;
        timeoutHandle?.unref?.();
        const onAbort = (): void => killTree();
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
        if (options.input !== undefined) child.stdin?.end(options.input, 'utf8');
        else child.stdin?.end();
      });
    },
  };
}
