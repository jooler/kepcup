import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKDIR_DEFAULT_PROTECT_RULES, type Workdir } from '@kepcup/shared';

import { resolvePaths, workspacePathFor } from '../../src/infra/paths.js';
import { ToolGateway, type GatewayDeps } from '../../src/gateway/index.js';
import { matchProtectRule } from '../../src/workdir/service.js';
import type { SandboxBackend, SandboxExecRequest } from '../../src/sandbox/types.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D140-4: the gateway's two-root view — an isolated worktree task resolves
 * relative paths against its tree, needs its own lease to write, keeps the
 * workdir protect rules anchored at the tree, keeps the workdir read-only and
 * runs its commands in the tree (cwd + policy).
 */

const identity: RunIdentity = {
  runId: 'run_wt',
  botId: 'bot_test',
  conversationId: 'conv_test',
  loopType: 'task',
};

let base: string;
let dataHome: string;
let workdirPath: string;
let worktreePath: string;
let gitCommonDir: string;
let leaseHeld: boolean;
let gateway: ToolGateway;
let execs: SandboxExecRequest[];

function boundWorkdir(): Workdir {
  return {
    id: 'wkd_1',
    path: workdirPath,
    name: path.basename(workdirPath),
    protectRules: { ...WORKDIR_DEFAULT_PROTECT_RULES, denyWrite: [] },
    allowedPorts: null,
    status: 'available',
    createdAt: 0,
    lastUsedAt: 0,
  } as Workdir;
}

function taskWorktree() {
  return {
    path: worktreePath,
    workdirPath,
    gitCommonDir,
    gitWorktreeMeta: path.join(gitCommonDir, 'worktrees', 'proj-3f9a1c2d'),
    gitObjectsDir: path.join(gitCommonDir, 'objects'),
    denyReadGlobs: [
      `${worktreePath}/.env`,
      `${worktreePath}/.env.*`,
      `${worktreePath}/**/.env`,
      `${worktreePath}/**/.env.*`,
    ],
  };
}

function makeGateway(sandbox: SandboxBackend): ToolGateway {
  return new ToolGateway(makeGatewayDeps(sandbox));
}

function makeGatewayDeps(sandbox: SandboxBackend, enhanced?: SandboxBackend): GatewayDeps {
  const paths = resolvePaths(dataHome);
  const deps: GatewayDeps = {
    paths,
    sandbox,
    audit: { record() {} } as unknown as GatewayDeps['audit'],
    secrets: { redact: (text: string) => text } as unknown as GatewayDeps['secrets'],
    logger: { info() {}, warn() {}, error() {} } as unknown as GatewayDeps['logger'],
    approvals: {
      noteGrantUsed() {},
      publishEvent() {},
      request: async () => ({ approval: { id: 'apr_1', decision: null }, decision: 'denied' }),
    } as unknown as GatewayDeps['approvals'],
    grants: {
      hasEffectiveGrant: () => null,
      listEffective: () => [],
      noteOnceUse() {},
    } as unknown as GatewayDeps['grants'],
    allowlist: { match: () => ({ exempt: false, reason: 'stub' }) } as unknown as GatewayDeps['allowlist'],
    unattended: {
      effective: () => ({ enabled: false, until: null, enabledAt: null }),
    } as unknown as GatewayDeps['unattended'],
    workdirs: {
      boundWorkdir: () => boundWorkdir(),
      holdsLease: (_identity: RunIdentity, candidate: string) =>
        leaseHeld && candidate === worktreePath,
      matchesProtectRule: (
        workdir: Workdir,
        resolved: string,
        mode: 'read' | 'write',
        root?: string,
      ) => matchProtectRule(workdir.protectRules, root ?? workdir.path, resolved, mode),
      taskWorktree: () => taskWorktree(),
      taskWorktreePath: () => worktreePath,
      isWorktreeTask: () => true,
      policyInfo: () => ({
        path: workdirPath,
        hasLease: false,
        allowedPorts: null,
        denyReadGlobs: [`${workdirPath}/.env`],
        cwd: worktreePath,
        worktree: taskWorktree(),
      }),
      writeDenial: () => null,
      writeDomain: () => null,
      ensureWriteLease: async () => {
        throw new Error('unused');
      },
      gitRemote: async () => {
        throw new Error('unused');
      },
    } as unknown as GatewayDeps['workdirs'],
    ...(enhanced !== undefined
      ? { enhanced, enhancedRouting: { requiredForBot: () => true } }
      : {}),
    platform: 'linux',
    readOnlyRootsOverride: [],
    sensitiveOverride: [],
  };
  return deps;
}

beforeEach(() => {
  // Canonical base: the gateway resolves existing ancestors through realpath
  // (`/var` vs `/private/var` on macOS), like production workdirs.
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'kepcup-wt-gateway-')));
  dataHome = path.join(base, 'data-home');
  mkdirSync(dataHome, { recursive: true });
  workdirPath = path.join(base, 'proj');
  worktreePath = path.join(base, '.worktree', 'proj-3f9a1c2d');
  gitCommonDir = path.join(workdirPath, '.git');
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(gitCommonDir, { recursive: true });
  mkdirSync(workspacePathFor(resolvePaths(dataHome), identity.botId!, identity.conversationId!), {
    recursive: true,
  });
  writeFileSync(path.join(worktreePath, '.env'), 'SECRET=1\n');
  leaseHeld = true;
  execs = [];
  gateway = makeGateway(makeGatewayBackend());
});

describe('D140-4 gateway worktree branch', () => {
  it('resolves relative paths against the tree and reads/writes it under the task lease', () => {
    const read = gateway.checkPath(identity, 'src/app.ts', 'read');
    expect(read).toMatchObject({ kind: 'allowed', resolvedPath: path.join(worktreePath, 'src/app.ts') });
    const write = gateway.checkPath(identity, 'src/app.ts', 'write');
    expect(write).toMatchObject({ kind: 'allowed', resolvedPath: path.join(worktreePath, 'src/app.ts') });
    leaseHeld = false;
    const unleased = gateway.checkPath(identity, 'src/app.ts', 'write');
    expect(unleased.kind).toBe('needs_lease');
    if (unleased.kind === 'needs_lease') expect(unleased.reason).toContain('隔离目录');
    // Reads never need the lease.
    expect(gateway.checkPath(identity, 'src/app.ts', 'read').kind).toBe('allowed');
  });

  it('keeps the workdir protect rules anchored at the tree (.env unreadable, workdir write not granted by the tree lease)', () => {
    const readEnv = gateway.checkPath(identity, '.env', 'read');
    expect(readEnv.kind).toBe('forbidden');
    expect(readEnv.kind === 'forbidden' ? readEnv.reason : '').toContain('保护规则');
    // The default protect rules only deny reads; writes follow the workdir
    // semantics (allowed under the lease) — parity with a plain workdir task.
    expect(gateway.checkPath(identity, '.env', 'write').kind).toBe('allowed');
    // Nested sensitive files are covered at any depth.
    const nested = gateway.checkPath(identity, 'apps/api/.env.local', 'read');
    expect(nested.kind).toBe('forbidden');
    // A normal file is still fine.
    expect(gateway.checkPath(identity, 'apps/api/main.ts', 'read').kind).toBe('allowed');
    // The workdir itself: readable, but writes go through the apply card —
    // never a lease (the tree lease is keyed on the tree).
    expect(gateway.checkPath(identity, workdirPath, 'read').kind).toBe('allowed');
    const workdirWrite = gateway.checkPath(identity, path.join(workdirPath, 'x.ts'), 'write');
    expect(workdirWrite.kind).toBe('forbidden');
    expect(workdirWrite.kind === 'forbidden' ? workdirWrite.reason : '').toContain('隔离目录');
  });

  it('routes writes to the tree git-control files through the grant decision', () => {
    const pointer = gateway.checkPath(identity, '.git', 'write');
    expect(pointer.kind).toBe('needs_grant');
    if (pointer.kind === 'needs_grant') expect(pointer.sensitive).toBe(true);
    // Reading the pointer file is fine.
    expect(gateway.checkPath(identity, '.git', 'read').kind).toBe('allowed');
  });

  it('runs the command in the tree with the two-root policy', async () => {
    await gateway.exec(identity, { command: 'git status', network: { mode: 'none', allowDomains: [] } });
    expect(execs).toHaveLength(1);
    const request = execs[0]!;
    expect(request.cwd).toBe(worktreePath);
    expect(request.policy.readWrite).toContain(worktreePath);
    expect(request.policy.readWrite).toContain(path.join(gitCommonDir, 'worktrees', 'proj-3f9a1c2d'));
    expect(request.policy.readWrite).toContain(path.join(gitCommonDir, 'objects'));
    expect(request.policy.readOnly).toContain(workdirPath);
    expect(request.policy.denyRead).toContain(`${worktreePath}/.env`);
  });

  it('does not route a worktree task to the enhanced backend', async () => {
    const enhancedRequests: string[] = [];
    const enhanced: SandboxBackend = {
      kind: 'lima',
      probe: async () => ({ backend: 'lima', available: true }),
      lastAvailability: () => ({ backend: 'lima', available: true }),
      exec: async (request) => {
        enhancedRequests.push(request.command);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, violations: [] };
      },
    };
    const routed = new ToolGateway(makeGatewayDeps(makeGatewayBackend(), enhanced));
    await routed.exec(identity, {
      command: 'git status',
      network: { mode: 'none', allowDomains: [] },
    });
    expect(enhancedRequests).toEqual([]);
  });

  it('never lets a worktree task write the main workdir (the apply card is the only path)', () => {
    // Absolute, relative and `..` variants all resolve to the workdir.
    for (const candidate of [
      path.join(workdirPath, 'x.ts'),
      path.join(workdirPath, 'src', 'x.ts'),
      '../../proj/x.ts',
    ]) {
      const write = gateway.checkPath(identity, candidate, 'write');
      expect(write.kind, candidate).toBe('forbidden');
      expect(write.kind === 'forbidden' ? write.reason : '').toContain('隔离目录');
    }
    // Reads stay allowed (the workdir is the read-only reference).
    expect(gateway.checkPath(identity, path.join(workdirPath, 'x.ts'), 'read').kind).toBe(
      'allowed',
    );
    expect(gateway.checkPath(identity, '../../proj/x.ts', 'read').kind).toBe('allowed');
    // A path escaping the tree in the other direction is grantable, never
    // silently allowed by the tree branch.
    expect(gateway.checkPath(identity, '../../elsewhere/x.ts', 'write').kind).toBe('needs_grant');
  });

  it('refuses a tree that resolves inside the data home (red line holds in this branch too)', () => {
    const inside = path.join(dataHome, '.worktree', 'proj-deadbeef');
    mkdirSync(inside, { recursive: true });
    writeFileSync(path.join(inside, '.env'), 'SECRET=1\n');
    worktreePath = inside;
    const read = gateway.checkPath(identity, 'x.ts', 'read');
    expect(read.kind).toBe('forbidden');
    expect(read.kind === 'forbidden' ? read.reason : '').toContain('应用数据目录');
    const write = gateway.checkPath(identity, 'x.ts', 'write');
    expect(write.kind).toBe('forbidden');
    expect(write.kind === 'forbidden' ? write.reason : '').toContain('应用数据目录');
  });

  it('forbids the shared .worktree home of the bound workdir (another task’s tree)', () => {
    const own = gateway.checkPath(identity, 'x.ts', 'read');
    expect(own.kind).toBe('allowed');
    const sibling = path.join(base, '.worktree', 'other-abcd1234', 'copied.env');
    for (const mode of ['read', 'write'] as const) {
      const verdict = gateway.checkPath(identity, sibling, mode);
      expect(verdict.kind, mode).toBe('forbidden');
      expect(verdict.kind === 'forbidden' ? verdict.reason : '').toContain('其他任务');
    }
  });
});

/** A recording default backend (srt). */
function makeGatewayBackend(): SandboxBackend {
  return {
    kind: 'srt',
    probe: async () => ({ backend: 'srt', available: true }),
    lastAvailability: () => ({ backend: 'srt', available: true }),
    exec: async (request) => {
      execs.push(request);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, violations: [] };
    },
  };
}
