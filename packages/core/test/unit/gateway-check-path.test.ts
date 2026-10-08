import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePaths, workspacePathFor } from '../../src/infra/paths.js';
import { ToolGateway, type GatewayDeps } from '../../src/gateway/index.js';
import { UnavailableSandboxBackend } from '../../src/sandbox/types.js';
import type { RunIdentity } from '../../src/agent/types.js';

const identity: RunIdentity = {
  runId: 'run_test',
  botId: 'bot_test',
  conversationId: 'conv_test',
  // A writable loop: the supervisor turn ('turn', formerly 'response') is read-only (D75).
  loopType: 'skill_authoring',
};

let home: string; // the data home (~/.kepcup equivalent)
let userHome: string; // the real user home (sensitive + toolchain locations)
let gateway: ToolGateway;
let sensitiveDir: string;
let toolchainDir: string;

function makeGateway(platform = 'linux'): ToolGateway {
  const paths = resolvePaths(home);
  const deps: GatewayDeps = {
    paths,
    sandbox: new UnavailableSandboxBackend('unused'),
    audit: {} as GatewayDeps['audit'],
    secrets: { redact: (text: string) => text } as unknown as GatewayDeps['secrets'],
    logger: { info() {}, warn() {}, error() {} } as unknown as GatewayDeps['logger'],
    approvals: {
      noteGrantUsed: () => {},
      publishEvent: () => {},
      request: async () => ({ approval: { decision: { duration: 'once' } }, decision: 'denied' }),
    } as unknown as GatewayDeps['approvals'],
    grants: {
      hasEffectiveGrant: () => null,
      // D75: a grant hit marks once-grant use (consumed with the tool call).
      noteOnceUse: () => {},
    } as unknown as GatewayDeps['grants'],
    allowlist: {
      match: () => ({ exempt: false, reason: 'stub' }),
    } as unknown as GatewayDeps['allowlist'],
    unattended: {
      effective: () => ({ enabled: false, until: null, enabledAt: null }),
    } as unknown as GatewayDeps['unattended'],
    projects: {
      boundProject: () => null,
      holdsLease: () => false,
      matchesProtectRule: () => false,
      policyInfo: () => null,
      denyReadGlobs: () => [],
      ensureWriteLease: async () => {
        throw new Error('no project in this fixture');
      },
      gitRemote: async () => {
        throw new Error('no project in this fixture');
      },
    } as unknown as GatewayDeps['projects'],
    platform,
    readOnlyRootsOverride: [toolchainDir],
    sensitiveOverride: [sensitiveDir],
  };
  lastGrantsStub = deps.grants as unknown as { hasEffectiveGrant: unknown };
  lastApprovalsStub = deps.approvals as unknown as typeof lastApprovalsStub;
  return new ToolGateway(deps);
}

/** The grants stub of the most recently built gateway (patched per test). */
let lastGrantsStub: { hasEffectiveGrant: unknown };

/** Replaces the grants stub on the most recently built gateway. */
function patchGrants(
  impl: (
    i: unknown,
    p: unknown,
    m: unknown,
    matches: (a: string, b: string) => boolean,
  ) => unknown,
): void {
  lastGrantsStub.hasEffectiveGrant = impl;
}

/** The approvals stub of the most recently built gateway. */
let lastApprovalsStub: {
  request: (identity: unknown, kind: string, payload: Record<string, unknown>) => Promise<unknown>;
};

/** Replaces the approvals stub on the most recently built gateway. */
function patchApprovals(
  impl: (
    identity: unknown,
    kind: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>,
): void {
  lastApprovalsStub.request = impl;
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'kepcup-gateway-'));
  home = path.join(base, 'data-home');
  userHome = path.join(base, 'user-home');
  mkdirSync(path.join(home, 'bots'), { recursive: true });
  sensitiveDir = path.join(userHome, '.ssh-like');
  toolchainDir = path.join(userHome, '.nvm-like');
  mkdirSync(sensitiveDir, { recursive: true });
  mkdirSync(toolchainDir, { recursive: true });
  writeFileSync(path.join(toolchainDir, 'bin.txt'), 'tool');
  gateway = makeGateway();
});

afterEach(() => {
  // home is a temp dir; nothing to restore.
});

const workspaceOf = () => workspacePathFor(resolvePaths(home), identity.botId!, identity.conversationId!);

describe('ToolGateway.checkPath', () => {
  it('allows read and write inside the workspace (relative and absolute)', () => {
    const ws = workspaceOf();
    mkdirSync(ws, { recursive: true });
    for (const input of ['notes.txt', './sub/a.md', ws, path.join(ws, 'deep/file.txt')]) {
      expect(gateway.checkPath(identity, input, 'read')).toMatchObject({ kind: 'allowed' });
      expect(gateway.checkPath(identity, input, 'write')).toMatchObject({ kind: 'allowed' });
    }
  });

  it('marks paths outside the workspace as needing a grant (P03)', () => {
    mkdirSync(workspaceOf(), { recursive: true });
    const decision = gateway.checkPath(identity, path.join(tmpdir(), 'elsewhere'), 'read');
    expect(decision.kind).toBe('needs_grant');
  });

  it('resolves .. without leaving the workspace semantics', () => {
    mkdirSync(workspaceOf(), { recursive: true });
    // `..` lands in the data home (bots/ parent) — forbidden, never grantable.
    const decision = gateway.checkPath(identity, '../outside.txt', 'read');
    expect(decision.kind).toBe('forbidden');
    // Staying inside after .. traversal is allowed.
    const inside = gateway.checkPath(identity, 'sub/../keep.txt', 'write');
    expect(inside.kind).toBe('allowed');
  });

  it('denies symlinks inside the workspace pointing outside (escape)', () => {
    const ws = workspaceOf();
    mkdirSync(ws, { recursive: true });
    const outside = path.join(home, 'outside-target');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const link = path.join(ws, 'escape');
    symlinkSync(outside, link);

    const read = gateway.checkPath(identity, link, 'read');
    expect(read.kind).toBe('forbidden');
    const deep = gateway.checkPath(identity, path.join(link, 'secret.txt'), 'read');
    expect(deep.kind).toBe('forbidden');
    const write = gateway.checkPath(identity, link, 'write');
    expect(write.kind).toBe('forbidden');
  });

  it('denies hard links inside the workspace pointing outside (escape)', () => {
    const ws = workspaceOf();
    mkdirSync(ws, { recursive: true });
    const outside = path.join(home, 'outside-target');
    mkdirSync(outside, { recursive: true });
    const target = path.join(outside, 'secret-by-hardlink.txt');
    writeFileSync(target, 'secret-by-hardlink');

    const link = path.join(ws, 'leak.txt');
    linkSync(target, link);

    // A hard link's realpath is the link path itself; only the link-count
    // check (BR-P02-002) can see through it.
    for (const mode of ['read', 'write'] as const) {
      const decision = gateway.checkPath(identity, link, mode);
      expect(decision.kind, `${mode} through an external hard link`).toBe('forbidden');
      if (decision.kind === 'forbidden') expect(decision.reason).toContain('硬链接');
    }
  });

  it('allows hard links that only have entries inside the workspace', () => {
    const ws = workspaceOf();
    mkdirSync(ws, { recursive: true });
    const first = path.join(ws, 'twin-a.txt');
    const second = path.join(ws, 'twin-b.txt');
    writeFileSync(first, 'twin');
    linkSync(first, second);

    expect(gateway.checkPath(identity, first, 'read').kind).toBe('allowed');
    expect(gateway.checkPath(identity, first, 'write').kind).toBe('allowed');
    expect(gateway.checkPath(identity, second, 'write').kind).toBe('allowed');
  });

  it('allows ordinary single-link workspace files and not-yet-existing paths', () => {
    const ws = workspaceOf();
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'plain.txt'), 'plain');
    expect(gateway.checkPath(identity, 'plain.txt', 'read').kind).toBe('allowed');
    expect(gateway.checkPath(identity, 'fresh.txt', 'write').kind).toBe('allowed');
  });

  it('resolves a not-yet-existing target via its nearest existing parent', () => {
    const ws = workspaceOf();
    const parent = path.join(ws, 'newdir');
    mkdirSync(parent, { recursive: true });
    const decision = gateway.checkPath(identity, path.join('newdir', 'file.txt'), 'write');
    expect(decision.kind).toBe('allowed');
    expect(decision.kind === 'allowed' && decision.resolvedPath).toBe(path.join(parent, 'file.txt'));
  });

  it('denies every location in the data home except the current workspace', () => {
    const ws = workspaceOf();
    mkdirSync(ws, { recursive: true });
    const otherWorkspace = workspacePathFor(resolvePaths(home), identity.botId!, 'conv_other');
    expect(gateway.checkPath(identity, otherWorkspace, 'read').kind).toBe('forbidden');
    expect(gateway.checkPath(identity, resolvePaths(home).mainDbPath, 'read').kind).toBe('forbidden');
    expect(gateway.checkPath(identity, path.join(home, 'cache', 'npm'), 'write').kind).toBe('forbidden');
  });

  it('marks sensitive locations as needs_grant with the sensitive flag', () => {
    mkdirSync(workspaceOf(), { recursive: true });
    const decision = gateway.checkPath(identity, sensitiveDir, 'read');
    expect(decision.kind).toBe('needs_grant');
    expect(decision.kind === 'needs_grant' && decision.sensitive).toBe(true);
  });

  it('treats toolchain roots as read-only without a grant (write needs a grant)', () => {
    mkdirSync(workspaceOf(), { recursive: true });
    expect(gateway.checkPath(identity, path.join(toolchainDir, 'bin.txt'), 'read').kind).toBe('allowed');
    const write = gateway.checkPath(identity, path.join(toolchainDir, 'bin.txt'), 'write');
    expect(write.kind).toBe('needs_grant');
    expect(write.kind === 'needs_grant' && write.sensitive).toBe(false);
  });

  it('data home locations stay forbidden even when a grant would cover them', () => {
    mkdirSync(workspaceOf(), { recursive: true });
    const gw = makeGateway();
    // Simulate an (illegitimate) grant covering everything: checkPath must
    // still refuse for the data home because that check runs BEFORE grants.
    patchGrants((_i, _p, _m, matches) => (matches('/', '/anything') ? { id: 'grt_fake' } : null));
    expect(gw.checkPath(identity, resolvePaths(home).mainDbPath, 'read').kind).toBe('forbidden');
  });

  it('an active grant covering the path turns needs_grant into allowed', () => {
    mkdirSync(workspaceOf(), { recursive: true });
    const gw = makeGateway();
    const outside = path.join(path.dirname(home), 'granted-dir');
    patchGrants(() => ({ id: 'grt_ok' }));
    const decision = gw.checkPath(identity, outside, 'write');
    expect(decision.kind).toBe('allowed');
  });

  it('flags access requests as sensitive when the path covers a sensitive location (BR-P03-002)', async () => {
    mkdirSync(workspaceOf(), { recursive: true });
    const gw = makeGateway();
    // A grant on the user home would silently cover the sensitive dir; the
    // approval card must carry the prominent warning anyway.
    const requested = path.dirname(userHome); // an ancestor of sensitiveDir
    const requests: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    patchApprovals(async (_identity, kind, payload) => {
      requests.push({ kind, payload });
      return { approval: { decision: { duration: 'once' } }, decision: 'denied' };
    });
    await expect(gw.ensurePathAccess(identity, requested, 'read', '测试')).rejects.toMatchObject({
      code: 'APPROVAL_DENIED',
    });
    expect(requests[0]!.kind).toBe('access');
    expect(requests[0]!.payload['sensitive']).toBe(true);
  });

  it('does not flag sensitive for ordinary out-of-scope paths (BR-P03-002)', async () => {
    mkdirSync(workspaceOf(), { recursive: true });
    const gw = makeGateway();
    const requested = path.join(path.dirname(userHome), 'plain-dir');
    const payloads: Array<Record<string, unknown>> = [];
    patchApprovals(async (_identity, _kind, payload) => {
      payloads.push(payload);
      return { approval: { decision: { duration: 'once' } }, decision: 'denied' };
    });
    await expect(gw.ensurePathAccess(identity, requested, 'read', '测试')).rejects.toMatchObject({
      code: 'APPROVAL_DENIED',
    });
    expect(payloads[0]!['sensitive']).toBe(false);
  });

  it('compares case-insensitively on darwin', () => {
    const gw = makeGateway('darwin');
    const ws = workspaceOf();
    mkdirSync(ws, { recursive: true });
    const upper = path.join(ws, 'SUB', 'File.TXT');
    const decision = gw.checkPath(identity, upper, 'write');
    expect(decision.kind).toBe('allowed');
  });

  it('rejects identities without a conversation', () => {
    const decision = gateway.checkPath(
      { ...identity, conversationId: null, botId: null },
      '/somewhere',
      'read',
    );
    expect(decision.kind).toBe('forbidden');
  });
});
