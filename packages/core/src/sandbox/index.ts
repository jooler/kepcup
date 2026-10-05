import { resolveBundledBinDir, type AppPaths } from '../infra/paths.js';
import type { CoreLogger } from '../infra/logger.js';
import { SrtSandboxBackend } from './backend-srt.js';
import { WslSandboxBackend } from './backend-wsl.js';
import type { WslRunner, WslSetup } from './wsl/setup.js';
import { LimaSandboxBackend, PodmanSandboxBackend, type ContainerBackendOptions } from './backend-container.js';
import { UnavailableSandboxBackend, type SandboxBackend } from './types.js';

export type { SandboxAvailability, SandboxBackend, SandboxPolicy } from './types.js';
export type { MountRegistration } from './wsl/mounts.js';
export { UnavailableSandboxBackend } from './types.js';
export { buildSandboxPolicy, alwaysDeniedAddresses } from './policy.js';
export { readOnlyRoots, sensitivePaths, isInsidePath } from './sensitive-paths.js';
export { WslSetup, createWslRunner, type WslRunner } from './wsl/setup.js';

/** Test/ops hook: `KEPCUP_SANDBOX=off` disables command execution entirely. */
function sandboxDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.KEPCUP_SANDBOX === 'off';
}

export interface CreateSandboxBackendInput {
  paths: AppPaths;
  logger: CoreLogger;
  env: NodeJS.ProcessEnv;
  platform?: string;
  /**
   * 红线（P12 任务 5）: registration of mountable directories. Required for
   * the Windows WSL backend; start.ts late-wires it via
   * `setRegistration` once the domain services exist, and until then the
   * default registration is empty (probe-independent; exec fails closed).
   */
  mountRegistration?: { registeredWindowsPaths(): readonly string[] };
  /** P06 distro toolchain PATH prefix provider (WSL backend, Windows). */
  distroToolchainPrefix?: () => string | null;
  /**
   * P12-B test seam (e2e): replaces the production wsl.exe runner so the
   * wizard state machine is drivable on non-Windows dev machines. The default
   * is the real runner; production never sets this.
   */
  wslRunner?: WslRunner;
  /**
   * P12-B: one shared state machine for the backend probe and the wizard RPC
   * (start.ts constructs it; defaults to a backend-private instance).
   */
  wslSetup?: WslSetup;
}

/**
 * Picks the default sandbox backend for this machine: srt on macOS/Linux,
 * the private WSL2 distro backend on Windows (probe stays lazy — an
 * unconfigured WSL reports unavailable and keeps the per-command confirm
 * mode), an always-unavailable backend when disabled via env.
 */
export function createSandboxBackend(input: CreateSandboxBackendInput): SandboxBackend {
  const platform = input.platform ?? process.platform;
  if (sandboxDisabled(input.env)) {
    return new UnavailableSandboxBackend('沙箱已在环境中被禁用（KEPCUP_SANDBOX=off），命令不会执行');
  }
  if (platform === 'win32') {
    return new WslSandboxBackend({
      paths: input.paths,
      logger: input.logger,
      platform,
      cacheDirs: wslCacheDirs(input.paths),
      registration: input.mountRegistration ?? { registeredWindowsPaths: () => [] },
      ...(input.distroToolchainPrefix !== undefined
        ? { distroToolchainPrefix: input.distroToolchainPrefix }
        : {}),
      ...(input.wslRunner !== undefined ? { runner: input.wslRunner } : {}),
      ...(input.wslSetup !== undefined ? { setup: input.wslSetup } : {}),
      env: input.env,
    });
  }
  return new SrtSandboxBackend({
    paths: input.paths,
    logger: input.logger,
    platform,
    bundledBinDir: resolveBundledBinDir(input.env),
  });
}

/**
 * Enhanced-level backend for this machine (docs/design/10-sandbox.md
 * "增强级"): Lima on macOS, rootless Podman on Linux. Windows returns null —
 * there the WSL2 distro serves both levels. Null means "not applicable on
 * this platform"; an installed-but-unready backend returns a real backend
 * whose probe reports the fixHint (安装提示).
 */
export function createEnhancedSandboxBackend(input: {
  paths: AppPaths;
  logger: CoreLogger;
  env: NodeJS.ProcessEnv;
  platform?: string;
  mountRegistration?: { registeredWindowsPaths(): readonly string[] };
}): SandboxBackend | null {
  const platform = input.platform ?? process.platform;
  if (sandboxDisabled(input.env)) return null;
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const containerOpts: ContainerBackendOptions = {
    logger: input.logger,
    platform,
    registration: input.mountRegistration ?? { registeredWindowsPaths: () => [] },
    dataHome: input.paths.home,
  };
  return platform === 'darwin' ? new LimaSandboxBackend(containerOpts) : new PodmanSandboxBackend(containerOpts);
}

/** Windows cache directories rewritten to the in-distro cache root (WSL). */
function wslCacheDirs(paths: AppPaths): Array<{ path: string; name: string }> {
  return [
    { path: paths.cacheNpmDir, name: 'npm' },
    { path: paths.cachePipDir, name: 'pip' },
    { path: paths.cacheXdgDir, name: 'xdg' },
    { path: paths.cacheCargoDir, name: 'cargo' },
    { path: paths.cacheUvDir, name: 'uv' },
    { path: paths.cachePycacheDir, name: 'pycache' },
  ];
}
