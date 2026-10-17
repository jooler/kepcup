import { spawn, spawnSync } from 'node:child_process';

export type GitRemoteOperation = 'push' | 'pull' | 'fetch' | 'clone' | 'remote_add' | 'init';

export interface GitRemoteResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const GIT_REMOTE_TIMEOUT_MS = 300_000;

/** True when a system `git` CLI exists (needed for credential helpers). */
export function gitCliAvailable(): boolean {
  const probe = spawnSync('git', ['--version'], { stdio: 'ignore' });
  return probe.error === undefined;
}

/** Tool operation → git CLI argv (remote_add is `git remote add`). */
const GIT_ARGV: Record<GitRemoteOperation, string[]> = {
  push: ['push'],
  pull: ['pull'],
  fetch: ['fetch'],
  clone: ['clone'],
  remote_add: ['remote', 'add'],
  init: ['init'],
};

/**
 * Runs one git remote operation with the **system** git CLI and the user's
 * full environment (credential helpers, ssh agent — docs/design/10-sandbox.md
 * "git": credentials never enter the sandbox). Arguments are passed as an
 * argv array; the child is never spawned through a shell.
 */
export function runGitRemote(input: {
  cwd: string;
  operation: GitRemoteOperation;
  args: string[];
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  timeoutMs?: number;
}): Promise<GitRemoteResult> {
  const argv = ['git', ...GIT_ARGV[input.operation], ...input.args];
  const command = argv[0];
  if (command === undefined) throw new Error('git command is empty');
  return new Promise((resolve) => {
    const child = spawn(command, argv.slice(1), {
      cwd: input.cwd,
      // Full user environment on purpose: git credential helpers and the ssh
      // agent live there. Output is redacted by the caller before it reaches
      // the model or the audit log.
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const timeoutHandle = setTimeout(
      () => {
        timedOut = true;
        killTree();
      },
      input.timeoutMs ?? GIT_REMOTE_TIMEOUT_MS,
    );
    timeoutHandle.unref?.();

    const onAbort = () => killTree();
    if (input.signal !== undefined) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      stdout += text;
      input.onOutput?.(text);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      stderr += text;
      input.onOutput?.(text);
    });

    child.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: 127, stdout, stderr: `${stderr}\n${String(error)}`, timedOut });
    });

    child.on('exit', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}
