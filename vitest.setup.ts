// Windows only: test temp trees contain read-only entries (skill library files,
// git objects), which native recursive rm refuses with EPERM. Give every test's
// own cleanup the same fallback the product uses (packages/core/src/infra/fs-rm.ts).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { makeWritable } from './packages/core/src/infra/fs-rm.js';

if (process.platform === 'win32') {
  const retryable = (error: unknown): boolean => {
    const code = (error as { code?: string } | null)?.code;
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY';
  };
  const originalRmSync = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    try {
      return originalRmSync(target, options);
    } catch (error) {
      if (!retryable(error)) throw error;
      makeWritable(String(target));
      return originalRmSync(target, { maxRetries: 5, retryDelay: 100, ...options });
    }
  }) as typeof fs.rmSync;
  const originalRm = fsp.rm;
  fsp.rm = (async (target: fs.PathLike, options?: fs.RmOptions) => {
    try {
      return await originalRm(target, options);
    } catch (error) {
      if (!retryable(error)) throw error;
      makeWritable(String(target));
      return originalRm(target, { maxRetries: 5, retryDelay: 100, ...options });
    }
  }) as typeof fsp.rm;
  syncBuiltinESMExports();
}
