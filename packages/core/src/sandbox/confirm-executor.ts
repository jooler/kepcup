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

/**
 * Environment overlay for commands the read-only allowlist exempts from
 * confirmation (confirm mode: they run unsandboxed without a card). Review P0:
 *
 * - PATH loses empty / relative entries (`.`, `node_modules/.bin`): a bare
 *   `tsc --version` must never resolve to an executable inside the project;
 * - corepack / yarn / go / npm / pip are told not to fetch anything
 *   (`COREPACK_ENABLE_NETWORK=0`, `YARN_IGNORE_PATH=1`, `GOTOOLCHAIN=local`,
 *   update notifiers off) — belt and braces, the built-ins no longer contain
 *   these probes, custom entries may;
 * - git: no pager, no optional index locks, no credential prompts, and
 *   `core.fsmonitor=false` / `core.pager=cat` via `GIT_CONFIG_COUNT` (git ≥
 *   2.31; older git ignores it — the gateway's repository-config check is the
 *   primary guard, see `permissions/git-config-risk.ts`).
 *
 * The base child environment is already an allowlist (`childEnvFor`), so
 * GIT_DIR / GIT_EXTERNAL_DIFF / RUSTUP_TOOLCHAIN / NODE_OPTIONS … never reach
 * the child; nothing needs unsetting.
 */
export function exemptCommandEnv(
  overlay: Record<string, string>,
  platform: string = process.platform,
): Record<string, string> {
  const separator = platform === 'win32' ? ';' : ':';
  const rawPath = overlay['PATH'] ?? process.env['PATH'] ?? '';
  const isAbsolute = (entry: string) =>
    platform === 'win32' ? /^([a-zA-Z]:[\\/]|\\\\)/.test(entry) : entry.startsWith('/');
  const cleanPath = rawPath
    .split(separator)
    .filter((entry) => entry.length > 0 && isAbsolute(entry))
    .join(separator);
  return {
    ...overlay,
    PATH: cleanPath,
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    YARN_IGNORE_PATH: '1',
    GOTOOLCHAIN: 'local',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NO_UPDATE_NOTIFIER: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.pager',
    GIT_CONFIG_VALUE_1: 'cat',
  };
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
