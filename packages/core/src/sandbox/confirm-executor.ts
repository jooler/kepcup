import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

import { childEnvFor } from './backend-srt.js';
import type { SandboxExecResult } from './types.js';

/**
 * Executes one command outside the sandbox — the only two paths here are the
 * confirm mode (sandbox unavailable, user approves every command) and
 * `request_unsandboxed` (user approves every single command). Never called
 * implicitly: docs/design/13-permissions.md "绝不悄悄在无沙箱的情况下运行".
 *
 * The child environment is the same allowlist the srt backend uses, so no
 * secret-bearing variable ever reaches an unsandboxed command.
 */

/** On Windows the confirm mode runs commands through PowerShell (pwsh first). */
export function resolveWindowsShell(): string {
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    const probe = spawnSync('where', [candidate], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return 'powershell.exe';
}

export interface UnsandboxedExecRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  /**
   * Policy-env overlay (P06: toolchain PATH prefix + cache dirs). Merged over
   * the allowlisted base by the same childEnvFor the srt backend uses.
   */
  envOverlay?: Record<string, string>;
}

export function executeUnsandboxed(req: UnsandboxedExecRequest): Promise<SandboxExecResult> {
  const isWindows = process.platform === 'win32';
  // PowerShell single-quote escaping: the only special char inside '...' is '.
  const command = isWindows
    ? `${resolveWindowsShell()} -NoProfile -NonInteractive -Command '${req.command.replaceAll("'", "''")}'`
    : req.command;

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: req.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,
      // Minimal environment: identity, locale, tool lookup. The parent's
      // secrets (env vars) never reach the unsandboxed child.
      env: childEnvFor(process.env, req.envOverlay ?? {}),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        if (!isWindows) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killTree();
    }, req.timeoutMs);
    timeoutHandle.unref?.();

    const onAbort = () => killTree();
    if (req.signal !== undefined) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      stdout += text;
      req.onOutput?.(text);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      stderr += text;
      req.onOutput?.(text);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      req.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: 127, stdout, stderr: `${stderr}\n${String(error)}`, timedOut, violations: [] });
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      req.signal?.removeEventListener('abort', onAbort);
      const exitCode = timedOut
        ? 124
        : (code ?? (child.signalCode ? 128 + (os.constants.signals[child.signalCode] ?? 0) : 1));
      resolve({ exitCode, stdout, stderr, timedOut, violations: [] });
    });
  });
}
