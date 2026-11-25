import type { EnvManager } from '../../env/manager.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { hostPathWithCommonDirs } from '../../infra/paths.js';
import type { McpbRuntimeKind, McpbRuntimeResolution } from './install.js';

export * from './manifest.js';
export * from './install.js';
export { ZipArchive, safeEntryPath } from './zip.js';

const EXE_NAMES: Record<McpbRuntimeKind, readonly string[]> = {
  node: ['node'],
  python: ['python3', 'python'],
  uv: ['uv'],
};

/**
 * 系统（非受管）运行时的同步探测：环境管理器没有已安装行时，按 PATH 找用户自装的
 * 运行时（Windows 官方安装器 / nvm、macOS Homebrew 等都会落进 PATH）。GUI 进程的
 * PATH 是启动时的快照——装完运行时不重启应用也该找得到，所以 Windows 再补官方默认
 * 安装目录兜底；win32 跳过 `WindowsApps`（微软商店的应用执行别名是占位文件，存在
 * 但一执行就拉起商店）。版本未知返回 null：兼容检查把缺席的版本视为「不阻断」。
 */
export function systemRuntimeResolution(
  kind: McpbRuntimeKind,
  options: { platform?: string; path?: string } = {},
): McpbRuntimeResolution | null {
  const platform = options.platform ?? process.platform;
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs = (options.path ?? hostPathWithCommonDirs())
    .split(delimiter)
    .map((entry) => entry.trim().replaceAll('"', ''))
    .filter((entry) => entry.length > 0);
  if (platform === 'win32') {
    // nodejs.org 安装器与 nvm-windows 的默认落位（PATH 快照过期时的兜底）。
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
      const base = process.env[key];
      if (base !== undefined && base.length > 0) dirs.push(path.join(base, 'nodejs'));
    }
  }
  const suffix = platform === 'win32' ? '.exe' : '';
  for (const dir of dirs) {
    // 仅按路径段匹配段首/独立段，不误伤名字里恰好含 windowsapps 的普通目录。
    if (platform === 'win32' && /[\\/]WindowsApps([\\/]|$)/i.test(dir)) continue;
    for (const name of EXE_NAMES[kind]) {
      const candidate = path.join(dir, `${name}${suffix}`);
      if (existsSync(candidate)) return { command: path.resolve(candidate), version: null };
    }
  }
  return null;
}

/**
 * Runtime lookup backed by the environment manager (D13): an `installed` toolchain row
 * counts first; when none exists, a system-installed runtime found on PATH does (version
 * unknown — see {@link systemRuntimeResolution}).
 */
export function envManagerRuntimeResolver(
  env: Pick<EnvManager, 'installedFor' | 'activeRowFor' | 'binDirsForRow'>,
  platform: string = process.platform,
): (kind: McpbRuntimeKind) => McpbRuntimeResolution | null {
  const exe = (name: string) => (platform === 'win32' ? `${name}.exe` : name);
  return (kind) => {
    const installed = env.installedFor(kind);
    const row = env.activeRowFor(kind);
    if (installed !== null && row !== null) {
      const binDir = env.binDirsForRow(row)[0];
      if (binDir !== undefined) {
        for (const name of EXE_NAMES[kind]) {
          const candidate = path.join(binDir, exe(name));
          if (existsSync(candidate)) return { command: candidate, version: installed.version };
        }
      }
    }
    return systemRuntimeResolution(kind, { platform });
  };
}
