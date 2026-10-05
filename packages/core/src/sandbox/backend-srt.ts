import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

import { alwaysDeniedDomainEntries } from './policy.js';
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

export interface SrtBackendOptions {
  paths: AppPaths;
  logger: CoreLogger;
  platform: string;
  /** Bundled binaries directory (rg / bwrap / socat), when present. */
  bundledBinDir: string | null;
}

/** Shape of the network block handed to srt. */
interface SrtNetworkConfig {
  allowedDomains: string[];
  deniedDomains: string[];
  deniedResolvedAddresses: string[];
  strictAllowlist: boolean;
  allowLocalBinding: boolean;
}

/** Loopback entries removable when the conversation may use local ports. */
const LOOPBACK_ENTRIES = new Set(['localhost', '127.0.0.0/8', '0.0.0.0/8', '::1']);

/**
 * Filesystem block for srt (deny-then-allow read model). Exported so the P12
 * enhanced backends reuse the exact same rule layer instead of copying it
 * (docs/dev/phases/P12-windows-and-enhanced-sandbox.md 任务 6).
 */
export function srtFilesystemFor(policy: SandboxPolicy): SandboxRuntimeConfig['filesystem'] {
  return {
    denyRead: policy.denyRead,
    // srt read model: deny-then-allow. Workspace + caches must stay readable
    // even though the home directory (their ancestor) is denied.
    allowRead: [...policy.readOnly, ...policy.readWrite],
    allowWrite: policy.readWrite,
    denyWrite: [],
  };
}

/** Exposed for policy unit tests; srt shapes never leave this module. */
export function srtNetworkConfigFor(policy: SandboxPolicy): SrtNetworkConfig {
  const { domains, resolvedAddresses } = alwaysDeniedDomainEntries();
  // A project-bound conversation may listen on and reach localhost (dev
  // servers): srt's allowLocalBinding opens bind/inbound/loopback-outbound
  // in the sandbox profile, and the loopback deny entries must leave the
  // proxy blocklists. Loopback traffic itself bypasses the proxy via
  // NO_PROXY, so this pairing is what makes `curl localhost:<port>` work.
  // Intranet / link-local / metadata stays denied in every mode.
  const allowLocalhost = policy.network.allowLocalhost === true;
  const filterLoopback = (entries: string[]) =>
    allowLocalhost ? entries.filter((entry) => !LOOPBACK_ENTRIES.has(entry)) : entries;
  return {
    // Open mode relies on the sandboxAskCallback (always-allow in P02);
    // allowlist and none modes are strict so nothing falls through.
    allowedDomains: policy.network.mode === 'allowlist' ? policy.network.allowDomains : [],
    deniedDomains: filterLoopback(domains),
    deniedResolvedAddresses: filterLoopback(resolvedAddresses),
    strictAllowlist: policy.network.mode !== 'open',
    allowLocalBinding: allowLocalhost,
  };
}

/**
 * Environment variables a sandboxed command may inherit from the host
 * (BR-P02-008): identity, locale, tool lookup and the temp directory.
 * Everything else — including whatever secrets the Electron host process
 * carries — never reaches `env`/`printenv` inside the sandbox. Cache and
 * toolchain variables are overlaid separately from the sandbox policy.
 */
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'TERM',
  'TMPDIR',
] as const;

/** Builds the child process environment from the allowlist plus `policy` env. */
export function childEnvFor(base: NodeJS.ProcessEnv, policyEnv: Record<string, string>): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = base[name];
    if (value !== undefined) child[name] = value;
  }
  return { ...child, ...policyEnv };
}

/**
 * srt backend (@anthropic-ai/sandbox-runtime). Every srt import lives here;
 * the rest of the core only sees the SandboxBackend interface.
 *
 * srt exposes one global SandboxManager whose proxy enforces the *global*
 * network config, while filesystem rules are per-command (customConfig).
 * Commands with different network policies therefore cannot safely overlap:
 * the backend drains all in-flight commands before switching the active
 * network policy (`updateConfig`).
 */
export class SrtSandboxBackend implements SandboxBackend {
  readonly kind: SandboxBackendKind = 'srt';
  readonly #opts: SrtBackendOptions;
  #availability: SandboxAvailability | null = null;
  #initializePromise: Promise<void> | null = null;
  #activeNetworkKey: string | null = null;
  /** Serializes the check-switch-register sequence (see #runWithNetworkPolicy). */
  #policyMutex: Promise<unknown> = Promise.resolve();
  /** Commands currently running under the active network policy. */
  #inFlight = 0;
  #drainWaiters: Array<() => void> = [];

  constructor(opts: SrtBackendOptions) {
    this.#opts = opts;
  }

  async probe(force = false): Promise<SandboxAvailability> {
    if (this.#availability !== null && !force) return this.#availability;
    const verdict = await this.#probeOnce();
    this.#availability = verdict;
    return verdict;
  }

  async #probeOnce(): Promise<SandboxAvailability> {
    if (this.#opts.platform !== 'darwin' && this.#opts.platform !== 'linux') {
      return {
        backend: 'none',
        available: false,
        reason: `当前平台（${this.#opts.platform}）暂不支持沙箱，命令不会执行`,
      };
    }
    try {
      const rgConfig = this.#ripgrepConfig();
      const deps =
        rgConfig !== undefined
          ? await SandboxManager.checkDependenciesAsync(rgConfig)
          : SandboxManager.checkDependencies();
      if (deps.errors.length > 0) {
        const isLinux = this.#opts.platform === 'linux';
        return {
          backend: 'srt',
          available: false,
          reason: `沙箱依赖缺失：${deps.errors.join('；')}`,
          fixHint: isLinux
            ? '请安装沙箱依赖：sudo apt install bubblewrap socat（Debian/Ubuntu）或 sudo dnf install bubblewrap socat（Fedora）'
            : undefined,
        };
      }
    } catch (error) {
      return {
        backend: 'srt',
        available: false,
        reason: `沙箱依赖检测失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // A minimal real command is the honest check: it exercises sandbox-exec /
    // bubblewrap end to end, including Linux user-namespace restrictions.
    try {
      const policy = this.#trialPolicy();
      await this.#initialize({
        network: srtNetworkConfigFor(policy),
        filesystem: this.#toSrtFilesystem(policy),
        ...this.#platformPaths(),
      });
      const wrapped = await SandboxManager.wrapWithSandbox('true', undefined, undefined, undefined, {
        commandId: 'kepcup-probe',
        commandText: 'true',
      });
      const trial = await this.#spawnWrapped(wrapped, os.tmpdir(), {}, 30_000, undefined, undefined);
      if (trial.exitCode !== 0) {
        return {
          backend: 'srt',
          available: false,
          reason: `沙箱自检命令失败（退出码 ${trial.exitCode}）`,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const userns = /user.?namespace|apparmor|bwrap|Operation not permitted/i.test(message);
      return {
        backend: 'srt',
        available: false,
        reason: `沙箱初始化失败：${message}`,
        fixHint:
          this.#opts.platform === 'linux' && userns
            ? 'Ubuntu 24.04 等发行版限制了用户命名空间。在终端执行：sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0，然后重新检测'
            : undefined,
      };
    }
    return { backend: 'srt', available: true };
  }

  async exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    const availability = await this.probe();
    if (!availability.available) {
      const details = availability.fixHint ? `（修复提示：${availability.fixHint}）` : '';
      throw new Error(`SANDBOX_UNAVAILABLE: ${availability.reason ?? '沙箱不可用'}${details}`);
    }

    const policy = req.policy;
    // The whole wrap+run sequence must happen under one network policy: the
    // check-and-switch is serialized by the mutex and the command registers
    // as in-flight before the mutex is released, so a concurrent policy
    // switch cannot land between check and spawn.
    return this.#runWithNetworkPolicy(JSON.stringify(srtNetworkConfigFor(policy)), policy, async () => {
      const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let wrapped: string;
      try {
        // Filesystem rules are compiled per command; network rules live in the
        // global proxy config maintained by #runWithNetworkPolicy.
        wrapped = await SandboxManager.wrapWithSandbox(
          req.command,
          undefined,
          { filesystem: this.#toSrtFilesystem(policy) },
          req.signal ?? undefined,
          { commandId, commandText: req.command },
        );
      } catch (error) {
        throw new Error(
          `SANDBOX_POLICY_DENIED: 无法生成沙箱规则：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      const exit = await this.#spawnWrapped(
        wrapped,
        req.cwd,
        policy.env,
        req.timeoutMs,
        req.signal ?? undefined,
        req.onOutput,
      );
      // Violation monitors stream asynchronously (macOS `log stream`, Linux
      // seccomp observer): a command that fails instantly can outpace its own
      // file-read deny event. Give the store a short grace period before
      // reading it, extended for FAILED commands — a denial surfaces as a
      // non-zero exit, and under load the stream event can lag the process by
      // more than the fixed grace (successful commands skip the extra wait).
      const store = SandboxManager.getSandboxViolationStore();
      let violations = store.getViolationsForCommand(commandId);
      if (violations.length === 0 && exit.exitCode !== 0 && exit.exitCode !== null) {
        const deadline = Date.now() + 2_000;
        while (violations.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 150));
          violations = store.getViolationsForCommand(commandId);
        }
      } else if (violations.length === 0) {
        await new Promise((r) => setTimeout(r, 300));
        violations = store.getViolationsForCommand(commandId);
      }
      SandboxManager.cleanupAfterCommand();
      return {
        exitCode: exit.exitCode,
        stdout: exit.stdout,
        stderr: exit.stderr,
        timedOut: exit.timedOut,
        violations: violations.map((v) => ({ line: v.line, command: v.command })),
      };
    });
  }

  // --- internals -------------------------------------------------------------

  #ripgrepConfig(): { command: string } | undefined {
    if (this.#opts.platform !== 'linux') return undefined;
    const bundled = this.#opts.bundledBinDir ? path.join(this.#opts.bundledBinDir, 'rg') : null;
    const command = bundled !== null && existsSync(bundled) ? bundled : 'rg';
    return { command };
  }

  #platformPaths(): Partial<SandboxRuntimeConfig> {
    if (this.#opts.platform !== 'linux') return {};
    const dir = this.#opts.bundledBinDir;
    const pick = (name: string): string | undefined => {
      const candidate = dir ? path.join(dir, name) : null;
      return candidate !== null && existsSync(candidate) ? candidate : undefined;
    };
    return { bwrapPath: pick('bwrap'), socatPath: pick('socat') };
  }

  #trialPolicy(): SandboxPolicy {
    return {
      readWrite: [os.tmpdir()],
      readOnly: [],
      denyRead: [this.#opts.paths.home],
      network: { mode: 'none', allowDomains: [] },
      env: {},
    };
  }

  #toSrtFilesystem(policy: SandboxPolicy): SandboxRuntimeConfig['filesystem'] {
    return srtFilesystemFor(policy);
  }

  /**
   * Serializes network-policy switching against running commands. The mutex
   * guards the check-switch-register sequence; a switch drains every command
   * that registered under the previous policy before calling updateConfig, so
   * no command is ever judged by another conversation's network rules.
   */
  async #runWithNetworkPolicy<T>(
    key: string,
    policy: SandboxPolicy,
    body: () => Promise<T>,
  ): Promise<T> {
    const gate = this.#policyMutex;
    const registration = gate.then(async () => {
      if (this.#activeNetworkKey !== key) {
        while (this.#inFlight > 0) {
          await new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
        }
        if (this.#activeNetworkKey !== key) {
          const network = srtNetworkConfigFor(policy);
          // A probe already initialized the manager (with the trial policy):
          // never re-initialize — apply this policy through updateConfig, or
          // the first command after a probe would silently keep the trial
          // network config (this is exactly how allowLocalBinding was lost).
          if (this.#initializePromise === null) {
            await this.#initialize({
              network,
              filesystem: this.#toSrtFilesystem(policy),
              ...this.#platformPaths(),
            });
          } else {
            SandboxManager.updateConfig({ network, filesystem: this.#toSrtFilesystem(policy) });
          }
          this.#activeNetworkKey = key;
        }
      }
      this.#inFlight += 1;
    });
    this.#policyMutex = registration.catch(() => {});
    await registration;
    try {
      return await body();
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0 && this.#drainWaiters.length > 0) {
        const waiters = this.#drainWaiters;
        this.#drainWaiters = [];
        for (const waiter of waiters) waiter();
      }
    }
  }

  /** Lazily starts the sandbox (proxies, violation monitors). */
  #initialize(baseConfig?: SandboxRuntimeConfig): Promise<void> {
    if (this.#initializePromise !== null) return this.#initializePromise;
    if (baseConfig === undefined) {
      // Already initialized in a previous probe/exec; nothing to await.
      return Promise.resolve();
    }
    this.#initializePromise = SandboxManager.initialize(baseConfig, async () => true, true)
      .then(() => {
        this.#opts.logger.info('sandbox initialized (srt)');
      })
      .catch((error) => {
        this.#initializePromise = null;
        this.#availability = {
          backend: 'srt',
          available: false,
          reason: `沙箱初始化失败：${error instanceof Error ? error.message : String(error)}`,
        };
        throw error;
      });
    return this.#initializePromise;
  }

  /** Spawns the wrapped command and kills the whole process tree on timeout/abort. */
  #spawnWrapped(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onOutput: ((chunk: string) => void) | undefined,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        shell: true,
        cwd,
        env: childEnvFor(process.env, env),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });

      // Bytes are accumulated raw and decoded once at the end: decoding per
      // chunk corrupts multi-byte UTF-8 sequences that straddle a chunk
      // boundary and loses binary data silently (BR-P09-006). The streaming
      // onOutput callback keeps its per-chunk approximation (progress display
      // only).
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let settled = false;

      const killTree = () => {
        if (child.pid === undefined) return;
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
      timeoutHandle.unref?.();

      const onAbort = () => {
        killTree();
      };
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout?.on('data', (data: Buffer) => {
        stdoutChunks.push(data);
        onOutput?.(data.toString('utf8'));
      });
      child.stderr?.on('data', (data: Buffer) => {
        stderrChunks.push(data);
        onOutput?.(data.toString('utf8'));
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        signal?.removeEventListener('abort', onAbort);
        resolve({
          exitCode: 127,
          stdout: decodeChunks(stdoutChunks),
          stderr: `${decodeChunks(stderrChunks)}\n${String(error)}`,
          timedOut,
        });
      });

      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        signal?.removeEventListener('abort', onAbort);
        // A SIGKILLed tree reports no code; map signals to shell convention.
        const exitCode = timedOut
          ? 124
          : (code ?? (child.signalCode ? 128 + (os.constants.signals[child.signalCode] ?? 0) : 1));
        resolve({
          exitCode,
          stdout: decodeChunks(stdoutChunks),
          stderr: decodeChunks(stderrChunks),
          timedOut,
        });
      });
    });
  }
}

/** Concatenates the raw chunks and decodes them once as UTF-8. */
function decodeChunks(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}
