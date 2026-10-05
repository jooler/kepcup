import { mkdirSync, mkdtempSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolvePaths } from '../../src/infra/paths.js';
import { createSandboxBackend } from '../../src/sandbox/index.js';
import { buildSandboxPolicy } from '../../src/sandbox/policy.js';
import { ToolGateway } from '../../src/gateway/index.js';
import { AuditService } from '../../src/domain/audit.js';
import type { SandboxBackend, SandboxExecResult } from '../../src/sandbox/types.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * Sandbox escape and network cases from docs/dev/05-testing.md "安全用例集"
 * (P02 entries). Real sandboxing is exercised; skipped on platforms without
 * srt support (docs/dev/05-testing.md "CI 矩阵" — Ubuntu additionally needs
 * kernel.apparmor_restrict_unprivileged_userns=0).
 */
const supported = process.platform === 'darwin' || process.platform === 'linux';
const d = supported ? describe : describe.skip;

// Long timeout: the first probe initializes the sandbox (proxies + trial run).
const TIMEOUT = 180_000;

let home: string;
let backend: SandboxBackend;
let gateway: ToolGateway;
const botId = `bot_${'A'.repeat(26)}`;
const conversationId = `conv_${'B'.repeat(26)}`;
const identity: RunIdentity = { runId: 'run_sandbox_test', botId, conversationId, loopType: 'response' };

function workspace(): string {
  return gateway.ensureWorkspace(identity);
}

function bash(command: string, timeoutMs = 30_000, net: 'none' | 'allowlist' | 'open' = 'open', allowDomains: string[] = []): Promise<SandboxExecResult> {
  const policy = buildSandboxPolicy({
    platform: process.platform,
    paths: resolvePaths(home),
    workspacePath: workspace(),
    network: { mode: net, allowDomains },
  });
  return backend.exec({ command, cwd: workspace(), policy, timeoutMs });
}

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'kepcup-sandbox-test-'));
  const paths = resolvePaths(home);
  for (const dir of [paths.cacheDir, paths.cacheNpmDir, paths.cachePipDir, paths.cacheXdgDir, paths.cacheCargoDir]) {
    mkdirSync(dir, { recursive: true });
  }
  // A stand-in "database" inside the data home so read denial is provable
  // against a file that definitely exists.
  writeFileSync(paths.mainDbPath, 'not-a-real-db');
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
  backend = createSandboxBackend({ paths, logger, env: process.env });
  const audit = new AuditService({ db: { prepare: () => ({ run: () => {} }) } as never, clock: { now: () => Date.now() } });
  gateway = new ToolGateway({ paths, sandbox: backend, audit, secrets: { redact: (t) => t } as never, logger });
}, TIMEOUT);

afterAll(() => {
  if (home !== undefined && existsSync(home)) {
    // keep the tree; tmp cleanup handles it
  }
});

d('sandbox escape cases (P02 安全用例集)', () => {
  it('blocks reading ~/.ssh, ~/.aws and the data home database from inside the sandbox', { timeout: TIMEOUT }, async () => {
    workspace();
    // Only assert against files that exist: a missing path under a denied
    // directory can surface as ENOENT (path lookup is metadata, not data).
    const probeFiles: string[] = [];
    for (const dir of [path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.aws')]) {
      if (!existsSync(dir)) continue;
      const entry = readdirSync(dir).find((f) => !f.startsWith('.'));
      if (entry !== undefined) probeFiles.push(path.join(dir, entry));
    }
    for (const probe of probeFiles) {
      const result = await bash(`cat "${probe}"`);
      expect(result.exitCode, `${probe} should be unreadable: ${result.stderr}`).not.toBe(0);
      const denied =
        result.violations.some((v) => v.line.includes('file-read')) ||
        result.stderr.includes('Operation not permitted');
      expect(denied, `expected a sandbox denial for ${probe}: ${result.stderr}`).toBe(true);
    }
    // ~/.kepcup/main.db equivalent: the test data home's main.db exists.
    const dbResult = await bash(`cat ${resolvePaths(home).mainDbPath}`);
    expect(dbResult.exitCode).not.toBe(0);
    expect(
      dbResult.violations.some((v) => v.line.includes('file-read')) || dbResult.stderr.includes('Operation not permitted'),
    ).toBe(true);
  });

  it('denies reading arbitrary locations of the user home from inside the sandbox', { timeout: TIMEOUT }, async () => {
    workspace();
    // Listing the real user home must fail with a read denial (BR-P02-001 /
    // BR-P02-004): the data home being denied does not imply home isolation.
    const ls = await bash('ls "$HOME"');
    expect(ls.exitCode, `ls "$HOME" should be denied: ${ls.stderr}`).not.toBe(0);
    expect(
      ls.violations.some((v) => v.line.includes('file-read')) || ls.stderr.includes('Operation not permitted'),
      `expected a sandbox denial for the user home: ${ls.stderr}`,
    ).toBe(true);

    // A non-sensitive, existing file directly under the home is equally denied.
    const probeFiles = ['.gitconfig', '.zshrc', '.bashrc', '.vimrc', '.profile']
      .map((name) => path.join(os.homedir(), name))
      .filter((p) => existsSync(p) && statSync(p).isFile());
    for (const probe of probeFiles) {
      const result = await bash(`cat "${probe}"`);
      expect(result.exitCode, `${probe} should be unreadable: ${result.stderr}`).not.toBe(0);
      expect(result.stdout, `${probe} content must not leak`).toBe('');
    }
  });

  it('blocks writing outside the workspace', { timeout: TIMEOUT }, async () => {
    workspace();
    const outside = path.join(resolvePaths(home).home, 'escape-probe');
    const result = await bash(`touch "${outside}"`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(outside)).toBe(false);
    const homeProbe = path.join(os.homedir(), 'kepcup-escape-probe');
    const result2 = await bash(`touch "${homeProbe}"`);
    expect(result2.exitCode).not.toBe(0);
    expect(existsSync(homeProbe)).toBe(false);
  });

  it('keeps the two workspaces of the test suite isolated from each other', { timeout: TIMEOUT }, async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, 'mine.txt'), 'mine');
    const otherIdentity: RunIdentity = { ...identity, botId: `${botId.slice(0, -1)}C` };
    const otherWs = gateway.ensureWorkspace(otherIdentity);
    writeFileSync(path.join(otherWs, 'theirs.txt'), 'theirs');

    const result = await bash(`cat "${path.join(otherWs, 'theirs.txt')}"`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('theirs');
  });

  it('reports violations for denied file reads', { timeout: TIMEOUT }, async () => {
    workspace();
    // The macOS/Linux violation monitors stream asynchronously: a fast
    // command can exit before its violation lands in the store, so retry
    // until one shows up.
    let violations: string[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      // Keep the command alive past the async monitor latency so the deny
      // event is attributed while it still runs.
      const result = await bash(`cat "${resolvePaths(home).mainDbPath}"; sleep 2`);
      violations = result.violations.map((v) => v.line);
      if (violations.some((v) => v.includes('file-read'))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('deny') && v.includes('file-read'))).toBe(true);
  });

  it('kills the whole process tree on timeout and leaves no leftovers', { timeout: TIMEOUT }, async () => {
    workspace();
    const result = await bash('sleep 25 & sleep 25', 2_500);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    await new Promise((r) => setTimeout(r, 600));
    const probe = spawn('pgrep', ['-f', 'sleep 25'], { stdio: 'pipe' });
    const leftover = await new Promise<string>((resolve) => {
      let out = '';
      probe.stdout?.on('data', (d) => (out += d));
      probe.on('exit', () => resolve(out.trim()));
    });
    expect(leftover).toBe('');
  }, TIMEOUT);

  it('aborts the running command when the abort signal fires', { timeout: TIMEOUT }, async () => {
    workspace();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_200);
    const policy = buildSandboxPolicy({
      platform: process.platform,
      paths: resolvePaths(home),
      workspacePath: workspace(),
      network: { mode: 'none', allowDomains: [] },
    });
    const result = await backend.exec({
      command: 'sleep 25',
      cwd: workspace(),
      policy,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(result.exitCode).not.toBe(0);
    await new Promise((r) => setTimeout(r, 600));
    const probe = spawn('pgrep', ['-f', 'sleep 25'], { stdio: 'pipe' });
    const leftover = await new Promise<string>((resolve) => {
      let out = '';
      probe.stdout?.on('data', (d) => (out += d));
      probe.on('exit', () => resolve(out.trim()));
    });
    expect(leftover).toBe('');
  }, TIMEOUT);

  it('points package-manager caches into the app cache directory', { timeout: TIMEOUT }, async () => {
    workspace();
    const probe = spawn('npm', ['--version'], { stdio: 'ignore' });
    if (probe.error !== undefined) {
      // npm not on PATH in this environment; the policy unit test covers the env.
      return;
    }
    const result = await bash('npm config get cache');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(resolvePaths(home).cacheNpmDir);
  }, TIMEOUT);

  describe('network modes', () => {
    it(
      'denies loopback, intranet and metadata addresses in every mode',
      { timeout: TIMEOUT },
      async () => {
        workspace();
        for (const mode of ['none', 'allowlist', 'open'] as const) {
          for (const url of ['http://127.0.0.1:9/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/']) {
            const result = await bash(`curl -sS -m 8 -o /dev/null -w '%{http_code}' "${url}"`, 30_000, mode, mode === 'allowlist' ? ['example.com'] : []);
            expect(result.exitCode, `${mode} ${url} should fail (stderr: ${result.stderr.slice(0, 200)})`).not.toBe(0);
          }
        }
      },
    );

    it('reaches the internet in open mode but not in none/allowlist modes without the domain', { timeout: TIMEOUT }, async () => {
      workspace();
      const fetchCode = async (mode: 'none' | 'allowlist' | 'open', domains: string[]) => {
        // Public-network success cases retry to ride out transient flakiness.
        const expectSuccess = mode === 'open' || (mode === 'allowlist' && domains.includes('example.com'));
        let last = '';
        for (let attempt = 0; attempt < (expectSuccess ? 3 : 1); attempt++) {
          const result = await bash(`curl -sS -m 15 -o /dev/null -w '%{http_code}' https://example.com`, 40_000, mode, domains);
          last = result.exitCode === 0 ? result.stdout.trim() : `exit:${result.exitCode}`;
          if (/^[23]/.test(last)) return last;
        }
        return last;
      };

      expect(await fetchCode('open', [])).toMatch(/^[23]/);
      expect(await fetchCode('none', [])).not.toMatch(/^[23]/);
      expect(await fetchCode('allowlist', ['github.com'])).not.toMatch(/^[23]/);
      expect(await fetchCode('allowlist', ['example.com'])).toMatch(/^[23]/);
    });
  });
});
