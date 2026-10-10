import type { EnvManager } from '../../env/manager.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { McpbRuntimeKind, McpbRuntimeResolution } from './install.js';

export * from './manifest.js';
export * from './install.js';
export { ZipArchive, safeEntryPath } from './zip.js';

/**
 * Runtime lookup backed by the environment manager (D13): only an `installed` toolchain row
 * counts; the executable is located inside the row's primary bin directory.
 */
export function envManagerRuntimeResolver(
  env: Pick<EnvManager, 'installedFor' | 'activeRowFor' | 'binDirsForRow'>,
  platform: string = process.platform,
): (kind: McpbRuntimeKind) => McpbRuntimeResolution | null {
  const exe = (name: string) => (platform === 'win32' ? `${name}.exe` : name);
  return (kind) => {
    const installed = env.installedFor(kind);
    const row = env.activeRowFor(kind);
    if (installed === null || row === null) return null;
    const binDir = env.binDirsForRow(row)[0];
    if (binDir === undefined) return null;
    const names = kind === 'python' ? ['python3', 'python'] : [kind];
    for (const name of names) {
      const candidate = path.join(binDir, exe(name));
      if (existsSync(candidate)) return { command: candidate, version: installed.version };
    }
    return null;
  };
}
