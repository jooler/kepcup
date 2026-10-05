#!/opt/kepcup/bin/node
/**
 * kepcup-sandbox — in-VM sandbox shim (P12). Built into every sandbox image:
 * the WSL rootfs (Debian), the Podman image and the Lima VM (see
 * build-rootfs.sh). One protocol for all three transports:
 *
 *   stdin  : JSON KepcupExecRequest (packages/core/src/sandbox/wsl/protocol.ts)
 *   stdout : the command's own stdout, then one terminal record
 *            `__KEPCUP_RESULT_V1__<base64url json>__KEPCUP_RESULT_END__`
 *   stderr : the command's own stderr
 *
 * The record carries { exitCode, timedOut, violations } (violations from
 * srt's violation store). The wrapper wraps the command with srt INSIDE the
 * VM — the same @anthropic-ai/sandbox-runtime the default backend uses on
 * macOS/Linux, so filesystem/network semantics are identical by
 * construction (docs/dev/phases/P12 任务 6: 规则与默认级一致).
 *
 * --selfcheck: minimal end-to-end proof that srt works in this image
 * (wraps `true`, expects exit 0) — the import flow's "srt 可用性验证" step
 * and the entry point for the distro-side validation of the rootfs.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const KEPCUP_RESULT_BEGIN = '__KEPCUP_RESULT_V1__';
const KEPCUP_RESULT_END = '__KEPCUP_RESULT_END__';
const SRT_ROOT = '/opt/kepcup/node_modules';

function loadSrt() {
  // srt is installed under /opt/kepcup/node_modules at image build time; resolve
  // from there instead of the script location so the shim can live in /usr
  ///local/bin too.
  const { createRequire } = require('node:module');
  const requireFrom = createRequire(path.join(SRT_ROOT, 'noop.js'));
  return requireFrom('@anthropic-ai/sandbox-runtime');
}

function readStdinJson() {
  const chunks = [];
  const fd = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function emitResult(result) {
  process.stdout.write(
    `${KEPCUP_RESULT_BEGIN}${Buffer.from(JSON.stringify(result), 'utf8').toString('base64url')}${KEPCUP_RESULT_END}\n`,
  );
}

/** Mirrors backend-srt: buffered raw bytes, decoded once (BR-P09-006). */
function collect(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  return chunks;
}

function run(request) {
  const srt = loadSrt();
  const { SandboxManager } = srt;
  const commandId = `br_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const config = {
    filesystem: request.filesystem,
    network: request.network,
  };
  return SandboxManager.initialize(config, async () => true, true)
    .then(() => SandboxManager.wrapWithSandbox(request.command, undefined, undefined, undefined, {
      commandId,
      commandText: request.command,
    }))
    .then((wrapped) => new Promise((resolve) => {
      const child = spawn(wrapped, {
        shell: true,
        cwd: request.cwd,
        env: request.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      const stdoutChunks = collect(child.stdout);
      const stderrChunks = collect(child.stderr);
      let timedOut = false;
      let settled = false;
      const killTree = () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killTree();
      }, request.timeoutMs);
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve({ exitCode: 127, stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat([Buffer.concat(stderrChunks), Buffer.from(`\n${String(error)}`)]), timedOut });
      });
      child.on('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        const exitCode = timedOut ? 124 : (code ?? (signal ? 143 : 1));
        resolve({ exitCode, stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks), timedOut });
      });
    }))
    .then((run) => {
      // Violations stream asynchronously; a failing command gets the same
      // bounded grace the srt backend grants (2s on failure, 300ms success).
      const store = SandboxManager.getSandboxViolationStore();
      let violations = store.getViolationsForCommand(commandId);
      const deadline = Date.now() + (run.exitCode !== 0 ? 2000 : 300);
      while (violations.length === 0 && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        violations = store.getViolationsForCommand(commandId);
      }
      try {
        SandboxManager.cleanupAfterCommand();
      } catch {
        // cleanup is best-effort.
      }
      return {
        stdout: run.stdout,
        stderr: run.stderr,
        result: {
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          violations: violations.map((v) => ({ line: v.line, command: v.command })),
        },
      };
    });
}

async function main() {
  if (process.argv.includes('--selfcheck')) {
    const run = await run({
      command: 'true',
      cwd: '/tmp',
      timeoutMs: 30_000,
      filesystem: { denyRead: ['/root'], allowRead: ['/usr', '/bin'], allowWrite: ['/tmp'], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: ['localhost'], deniedResolvedAddresses: ['127.0.0.0/8'], strictAllowlist: true, allowLocalBinding: false },
      env: { PATH: '/opt/kepcup/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/home/kepcup' },
    });
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    if (run.result.exitCode !== 0) {
      process.stderr.write('selfcheck failed: sandboxed `true` exited non-zero\n');
      process.exit(1);
    }
    process.stdout.write('selfcheck ok: srt wrapped a command in this image\n');
    return;
  }

  const request = readStdinJson();
  if (typeof request.command !== 'string' || typeof request.cwd !== 'string') {
    process.stderr.write('bad request: command/cwd required\n');
    process.exit(2);
  }
  const run = await run(request);
  // Command output first (the host accumulates it), result record last. The
  // record echoes the request's one-time nonce (BR-P12-005): the host only
  // accepts the record carrying the nonce of ITS request, so the command's
  // own output cannot forge a result by printing marker text.
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  emitResult(typeof request.nonce === 'string' ? { ...run.result, nonce: request.nonce } : run.result);
}

main().catch((error) => {
  process.stderr.write(`kepcup-sandbox failed: ${error && error.stack ? error.stack : String(error)}\n`);
  // No result record: the host treats a missing record as a failed exec —
  // never as exit 0 (protocol.ts fail-closed).
  process.exit(1);
});
