import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runCommand, verifyInstall } from './installer.js';
import type { CatalogEntry } from './catalog.js';

/**
 * Environment health check (docs/dev/phases/P06-environment.md 任务 6).
 * Runs on the host layer (no sandbox, no admin rights): the catalog verify
 * command per installed item, plus live detection for kind='system' items.
 * A broken install (e.g. a deleted file) fails the verify command → the
 * settings page marks the row unhealthy and offers reinstall.
 */

export interface InstallHealth {
  healthy: boolean;
  detail: string;
}

/** Re-runs the catalog verify command for one installed row. */
export async function checkInstallHealth(
  entry: CatalogEntry,
  binDir: string,
  targetDir: string,
): Promise<InstallHealth> {
  if (!existsSync(binDir)) {
    return { healthy: false, detail: '安装目录不存在' };
  }
  try {
    await verifyInstall(entry, binDir, targetDir, { timeoutMs: 30_000 });
    return { healthy: true, detail: '正常' };
  } catch (error) {
    return {
      healthy: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface SystemDetection {
  available: boolean;
  detail: string;
}

/** Live probe of a kind='system' item (git on macOS/Linux: `git --version`). */
export async function detectSystemItem(
  entry: CatalogEntry,
  options: { PATH?: string } = {},
): Promise<SystemDetection> {
  const binary = entry.detectBin ?? entry.item;
  const which = process.platform === 'win32' ? 'where' : 'command -v';
  const probe = await runCommand(which, [binary], {
    shell: process.platform !== 'win32',
    timeoutMs: 10_000,
    env: options.PATH !== undefined ? { ...process.env, PATH: options.PATH } : undefined,
  });
  if (probe.code !== 0) {
    return { available: false, detail: `未在系统 PATH 中找到 ${binary}` };
  }
  const result = await runCommand(probe.stdout.trim().split('\n')[0] ?? binary, ['--version'], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    return { available: false, detail: `${binary} 存在但无法执行` };
  }
  return { available: true, detail: result.stdout.trim().split('\n')[0] ?? '' };
}

/** Resolves where a system item's executable lives (PATH lookup), or null. */
export async function locateSystemItem(item: string, detectBin?: string): Promise<string | null> {
  const binary = detectBin ?? item;
  const which = process.platform === 'win32' ? 'where' : 'command -v';
  const probe = await runCommand(which, [binary], {
    shell: process.platform !== 'win32',
    timeoutMs: 10_000,
  });
  if (probe.code !== 0) return null;
  const first = probe.stdout.trim().split('\n')[0] ?? '';
  return first.length > 0 && existsSync(first) ? first : path.dirname(first);
}

/**
 * Reads /etc/os-release to pick the distro package-manager command shown on
 * the Linux git approval card (docs: apt / dnf / pacman 由用户执行).
 */
export function linuxGitInstallCommand(): string {
  try {
    const content = readFileSync('/etc/os-release', 'utf8');
    const id = /^ID=(.*)$/m.exec(content)?.[1]?.replace(/"/g, '') ?? '';
    if (id === 'ubuntu' || id === 'debian' || id === 'linuxmint') return 'sudo apt install git';
    if (id === 'fedora' || id === 'rhel' || id === 'centos' || id === 'rocky' || id === 'almalinux') {
      return 'sudo dnf install git';
    }
    if (id === 'arch' || id === 'manjaro') return 'sudo pacman -S git';
    if (id === 'alpine') return 'sudo apk add git';
    if (id === 'opensuse-leap' || id === 'opensuse-tumbleweed') return 'sudo zypper install git';
    return 'sudo apt install git';
  } catch {
    return 'sudo apt install git';
  }
}
