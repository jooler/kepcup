import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolvePaths } from '../../src/infra/paths.js';
import { createSandboxBackend } from '../../src/sandbox/index.js';
import { buildSandboxPolicy } from '../../src/sandbox/policy.js';
import { startFileServer } from '@kepcup/testkit';
import type { Catalog } from '../../src/env/catalog.js';
import { Installer } from '../../src/env/installer.js';
import type { SandboxBackend, SandboxExecResult } from '../../src/sandbox/types.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * P06 sandbox cases (docs/dev/phases/P06-environment.md 测试要求): an
 * installed toolchain is executable inside the sandbox through the PATH
 * prefix, and the toolchains directory is READ-ONLY inside the sandbox
 * (write attempts fail and land in the srt violation log).
 */
const supported = process.platform === 'darwin' || process.platform === 'linux';
const d = supported ? describe : describe.skip;

const TIMEOUT = 180_000;
const ITEM = 'sandboxpy';
const VERSION = '9.9.9';

let home: string;
let backend: SandboxBackend;
let identity: RunIdentity;
let fileServer: { url: string; stop(): Promise<void> };
let binDir: string;

function workspace(): string {
  return path.join(home, 'bots', identity.botId!, 'workspaces', identity.conversationId!);
}

function bash(command: string, timeoutMs = 30_000): Promise<SandboxExecResult> {
  const paths = resolvePaths(home);
  const policy = buildSandboxPolicy({
    platform: process.platform,
    paths,
    workspacePath: workspace(),
    network: { mode: 'none', allowDomains: [] },
    toolchainPathPrefix: binDir,
    toolchainsRoot: paths.toolchainsDir,
  });
  return backend.exec({ command, cwd: workspace(), policy, timeoutMs });
}

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'kepcup-sandbox-env-'));
  const paths = resolvePaths(home);
  for (const dir of [paths.cacheDir, paths.cacheNpmDir, paths.cachePipDir, paths.cacheXdgDir, paths.cacheCargoDir, paths.cacheUvDir, paths.cacheDownloadsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

  // Fake toolchain served locally; installed through the real installer.
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'kepcup-sandbox-env-fixture-'));
  const root = path.join(fixtureDir, `${ITEM}-${VERSION}-bin`);
  mkdirSync(root, { recursive: true });
  const script = path.join(root, ITEM);
  writeFileSync(script, '#!/bin/sh\necho "sandboxpy 9.9.9 from toolchain"\n');
  chmodSync(script, 0o755);
  const archive = path.join(fixtureDir, `${ITEM}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', fixtureDir, `${ITEM}-${VERSION}-bin`]);
  const bytes = execFileSync('cat', [archive]);
  fileServer = await startFileServer({ [`${ITEM}.tar.gz`]: bytes });
  const catalog: Catalog = [
    {
      item: ITEM,
      version: VERSION,
      displayName: 'SandboxPy',
      source: fileServer.url,
      install: { via: 'archive' },
      platforms: {
        [`${process.platform}-${process.arch}`]: {
          url: `${fileServer.url}/${ITEM}.tar.gz`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
          kind: 'archive',
        },
      },
      verify: { command: '"{bin}" --version', expect: 'sandboxpy 9.9.9' },
    },
  ];

  const clock = { now: () => Date.now() };
  // Install through the real installer; policy wiring (PATH prefix + readonly
  // root) is exercised below through buildSandboxPolicy, and the manager-level
  // flow lives in test/integration/environment.test.ts.
  const key = `${process.platform}-${process.arch}`;
  const entry = catalog[0]!;
  const installer = new Installer({ paths, logger, clock: clock as never });
  const result = await installer.enqueue({
    installId: 'install_sandbox_test',
    entry,
    platformKey: key,
    platform: entry.platforms[key as keyof typeof entry.platforms]!,
    targetDir: path.join(paths.toolchainsDir, ITEM, VERSION),
    onProgress: () => {},
  });
  if (!result.ok) throw new Error(`fixture install failed: ${result.error}`);
  binDir = result.binDir!;

  backend = createSandboxBackend({ paths, logger, env: process.env });
  identity = {
    runId: 'run_sandbox_env',
    botId: `bot_${'C'.repeat(26)}`,
    conversationId: `conv_${'D'.repeat(26)}`,
    loopType: 'response',
  };
  mkdirSync(workspace(), { recursive: true });
}, TIMEOUT);

afterAll(async () => {
  await fileServer?.stop();
});

d('toolchain sandbox cases (P06)', () => {
  it('executes an installed toolchain binary inside the sandbox via the PATH prefix', { timeout: TIMEOUT }, async () => {
    expect(existsSync(binDir)).toBe(true);
    const result = await bash(`${ITEM} --version`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sandboxpy 9.9.9');
  }, TIMEOUT);

  it('keeps the toolchains directory read-only inside the sandbox', { timeout: TIMEOUT }, async () => {
    const target = path.join(resolvePaths(home).toolchainsDir, ITEM, VERSION, 'attempt.txt');
    const result = await bash(`echo pwned > "${target}"`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
    // srt 违规记录（写被拒）；违规流可能有延迟，与 stderr 信号取并集。
    expect(
      result.violations.length > 0 || /Operation not permitted|Read-only|denied/i.test(result.stderr),
    ).toBe(true);
    // 相反方向：workspace 照常可写。
    const ok = await bash('echo fine > sandboxed-write.txt && cat sandboxed-write.txt');
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('fine');
  }, TIMEOUT);
});
