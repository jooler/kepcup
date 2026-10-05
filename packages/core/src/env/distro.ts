import { WSL_TOOLCHAINS_ROOT as WSL_TOOLCHAINS_PREFIX } from '../sandbox/wsl/constants.js';

/**
 * Injection boundary for P12 distro-internal toolchain installs
 * (docs/dev/phases/P12 任务书「工具链」): on a Windows host, `wslDistro`
 * catalog items (node / python) land INSIDE the private WSL2 distro instead
 * of the Windows toolchains directory. The production adapter lives in
 * start.ts (wired onto WslSetup); tests inject a fake.
 *
 * 红线不变：the adapter only ever writes under the distro toolchains root —
 * the manager computes every target with distroToolchainPath, never from
 * user input.
 */

/** In-distro toolchains root (sandbox/wsl/constants.ts, re-exported). */
export const DISTRO_TOOLCHAINS_PREFIX = WSL_TOOLCHAINS_PREFIX;

/** Absolute in-distro directory of one toolchain item version. */
export function distroToolchainDir(item: string, version: string): string {
  return `${WSL_TOOLCHAINS_PREFIX}/${item}/${version}`;
}

export interface DistroToolchainInstaller {
  /** False while the distro is not imported/configured (installs fail then). */
  available(): Promise<boolean>;
  /**
   * Moves a staged HOST directory (downloaded + extracted linux artifact)
   * into the distro at `distroDir` (tar pipe over stdin, run as root). The
   * caller removes the staging directory afterwards.
   */
  extractDir(hostDir: string, distroDir: string): Promise<void>;
  /**
   * Runs `uv python install <version>` inside the distro (uv ships in the
   * rootfs at /opt/kepcup/bin/uv) with UV_PYTHON_INSTALL_DIR = `distroDir` and
   * returns the resolved bin directory (uv python find, host form stripped).
   */
  installPythonViaUv(input: { pythonVersion: string; distroDir: string }): Promise<string>;
  /**
   * Runs the entry's verify command inside the distro and asserts the expect
   * substring appears in stdout (任务 3: 验证工具链可用 — same semantics as
   * the host verifyInstall: `{bin}` = primary executable under binDir,
   * `{dir}` = the version directory).
   */
  verify(input: {
    command: string;
    expect: string;
    /** Primary executable name (item, or python3 for uv-python installs). */
    binName: string;
    binDir: string;
    targetDir: string;
  }): Promise<void>;
  /** Removes one distro directory (environment.remove cascade). */
  removeDir(distroDir: string): Promise<void>;
}

/** True for env_installs rows that live inside the distro (rel_path prefix). */
export function isDistroRow(relPath: string): boolean {
  return relPath.startsWith(`${WSL_TOOLCHAINS_PREFIX}/`);
}
