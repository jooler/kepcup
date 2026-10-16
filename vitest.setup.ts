// Windows only: test temp trees contain read-only entries (skill library files,
// git objects), which native recursive rm refuses with EPERM. Give every test's
// own cleanup the same fallback the product uses (packages/core/src/infra/fs-rm.ts).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { makeWritable } from './packages/core/src/infra/fs-rm.js';

if (process.platform === 'win32') {
  const retryable = (error: unknown): boolean => {
    const code = (error as { code?: string } | null)?.code;
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY';
  };
  // Many tests leave a SQLite connection open on a file under their temp dir, which Windows
  // refuses to delete. Leftover temp files are harmless: after the read-only fallback,
  // a failed cleanup inside the OS temp dir is ignored (anything else still throws).
  const tmpRoot = path.resolve(os.tmpdir()).toLowerCase() + path.sep;
  const inTmp = (target: fs.PathLike): boolean =>
    (path.resolve(String(target)).toLowerCase() + path.sep).startsWith(tmpRoot);
  const originalRmSync = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    try {
      return originalRmSync(target, options);
    } catch (error) {
      if (!retryable(error)) throw error;
      makeWritable(String(target));
      try {
        return originalRmSync(target, { maxRetries: 2, retryDelay: 50, ...options });
      } catch (retryError) {
        if (inTmp(target) && retryable(retryError)) return;
        throw retryError;
      }
    }
  }) as typeof fs.rmSync;
  const originalRm = fsp.rm;
  fsp.rm = (async (target: fs.PathLike, options?: fs.RmOptions) => {
    try {
      return await originalRm(target, options);
    } catch (error) {
      if (!retryable(error)) throw error;
      makeWritable(String(target));
      try {
        return await originalRm(target, { maxRetries: 2, retryDelay: 50, ...options });
      } catch (retryError) {
        if (inTmp(target) && retryable(retryError)) return;
        throw retryError;
      }
    }
  }) as typeof fsp.rm;
  syncBuiltinESMExports();
}
