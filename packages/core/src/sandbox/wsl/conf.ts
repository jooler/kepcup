import { WSL_USER } from './constants.js';

/**
 * /etc/wsl.conf of the private distro (docs/design/10-sandbox.md): automount
 * and interop are the security baseline — automount would expose every
 * Windows drive (C:\) inside the distro, interop would let distro processes
 * start Windows executables outside the sandbox. There is deliberately no
 * switch to keep either enabled (红线: 关闭是安全基线，不得留开关旁路).
 */

export interface WslConfOptions {
  /** Default user for `wsl -d …` sessions without `-u`. */
  user?: string;
}

/** Exact /etc/wsl.conf content (unit-tested snapshot). */
export function buildWslConf(options: WslConfOptions = {}): string {
  const user = options.user ?? WSL_USER;
  return [
    '[automount]',
    'enabled = false',
    // Nothing mounts at boot: the only mounts inside the distro are the
    // runtime drvfs mounts performed by kepcup-mount for registered directories.
    'mountFsTab = false',
    '',
    '[interop]',
    'enabled = false',
    'appendWindowsPath = false',
    '',
    '[user]',
    `default = ${user}`,
    '',
  ].join('\n');
}
