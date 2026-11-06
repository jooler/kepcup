import { spawn, type ChildProcess } from 'node:child_process';

import { hostPathWithCommonDirs } from '../../infra/paths.js';

/**
 * `limactl` 调用边界（macOS 增强沙箱的准备流程）。与 WSL 的 runner 同形，
 * 便于在非 macOS 机器上用 fixture 驱动整个状态机。
 */

export interface LimaRunResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  /** Spawn-level failure (limactl not on PATH). */
  error?: string;
}

export interface LimaRunOptions {
  timeoutMs?: number;
  /** Written to the child's stdin (provision script). */
  input?: string;
  signal?: AbortSignal;
  /** Streaming output for progress text (setup 只取最后一行). */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
}

export interface LimaRunner {
  run(argv: string[], options?: LimaRunOptions): Promise<LimaRunResult>;
}

/** Production runner: spawns `limactl` (PATH lookup, no shell). */
export function createLimaRunner(): LimaRunner {
  return {
    run(argv, options = {}) {
      return new Promise((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn('limactl', argv, {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            // Kill the whole tree (limactl spawns ssh/hostagent helpers).
            detached: process.platform !== 'win32',
            // Packaged macOS apps start with launchd's minimal PATH; brew's
            // /opt/homebrew/bin must remain reachable for limactl.
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
        const timeoutHandle =
          options.timeoutMs !== undefined ? setTimeout(killTree, options.timeoutMs) : undefined;
        timeoutHandle?.unref?.();
        const onAbort = (): void => killTree();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout.push(chunk);
          options.onOutput?.('stdout', chunk.toString('utf8'));
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr.push(chunk);
          options.onOutput?.('stderr', chunk.toString('utf8'));
        });
        const finish = (result: LimaRunResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          options.signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };
        child.on('error', (error) => {
          finish({
            exitCode: null,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            error: String(error),
          });
        });
        child.on('close', (code) => {
          finish({ exitCode: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
        });
        if (options.input !== undefined) child.stdin?.end(options.input, 'utf8');
        else child.stdin?.end();
      });
    },
  };
}
