import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';

import { resolvePaths, workspacePathFor } from '../../src/infra/paths.js';
import { ToolGateway, isGitControlPath, type GatewayDeps } from '../../src/gateway/index.js';
import { ProjectRuntime } from '../../src/project/service.js';
import { GrantsService } from '../../src/permissions/grants.js';
import { AllowlistService } from '../../src/permissions/allowlist.js';
import { resolveExecutable, riskyGitConfigKeys } from '../../src/permissions/git-config-risk.js';
import { exemptCommandEnv } from '../../src/sandbox/confirm-executor.js';
import { UnavailableSandboxBackend } from '../../src/sandbox/types.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * Review findings #2 / #4 / #5: what the read-only allowlist may run without a
 * card in confirm mode (sandbox unavailable — the command runs unsandboxed).
 */

const BOT = 'bot_al';
const CONV = 'conv_al';
const writeTask: RunIdentity = { runId: 'run_write', botId: BOT, conversationId: CONV, loopType: 'task' };
const readTask: RunIdentity = { runId: 'run_read', botId: BOT, conversationId: CONV, loopType: 'task' };

const runRows = new Map([
  ['run_write', { id: 'run_write', loopType: 'task', taskWrites: true, parentRunId: null, status: 'running' }],
  ['run_read', { id: 'run_read', loopType: 'task', taskWrites: false, parentRunId: null, status: 'running' }],
]);

let home: string;
let approvals: Array<{ kind: string; payload: Record<string, unknown> }>;
let tainted: boolean;
let allowlist: AllowlistService;

function makeGateway(): ToolGateway {
  const grantsDb = new Database(':memory:');
  grantsDb.exec(`
    create table grants (
      id text primary key, bot_id text not null, conversation_id text not null,
      path text not null, access text not null, duration text not null,
      run_id text, approval_id text, created_at integer not null, revoked_at integer
    );
  `);
  const projects = new ProjectRuntime({
    runs: { get: (id: string) => runRows.get(id) ?? null },
    conversations: { get: () => null },
    leases: { keyOf: (runId: string) => (runId === 'run_write' ? `ws:${BOT}:${CONV}` : null) },
  } as never);
  const deps: GatewayDeps = {
    paths: resolvePaths(home),
    sandbox: new UnavailableSandboxBackend('test'),
    audit: { record: () => {} } as unknown as GatewayDeps['audit'],
    secrets: { redact: (text: string) => text } as unknown as GatewayDeps['secrets'],
    logger: { info() {}, warn() {}, error() {} } as unknown as GatewayDeps['logger'],
    approvals: {
      noteGrantUsed: () => {},
      publishEvent: () => {},
      request: async (_identity: unknown, kind: string, payload: Record<string, unknown>) => {
        approvals.push({ kind, payload });
        // Deny: the command must never run in these tests.
        return { approval: { id: `apr_${approvals.length}`, decision: null }, decision: 'denied' };
      },
    } as unknown as GatewayDeps['approvals'],
    grants: new GrantsService({ db: grantsDb as never, clock: { now: () => Date.now() } }),
    allowlist,
    unattended: { effective: () => ({ enabled: false }) } as unknown as GatewayDeps['unattended'],
    projects,
    taint: {
      mark: () => {},
      guard: () => (tainted ? { firstAt: 1, expiresAt: Date.now() + 60_000 } : null),
    },
    platform: 'linux',
    readOnlyRootsOverride: [],
    sensitiveOverride: [],
  };
  return new ToolGateway(deps);
}

function workspace(): string {
  return workspacePathFor(resolvePaths(home), BOT, CONV);
}

const none = { mode: 'none' as const, allowDomains: [] };

beforeEach(() => {
  home = path.join(mkdtempSync(path.join(tmpdir(), 'kepcup-alh-')), 'data-home');
  mkdirSync(workspace(), { recursive: true });
  approvals = [];
  tainted = false;
  const db = new Database(':memory:');
  db.exec(`
    create table command_allowlist (
      id text primary key, platform text not null, pattern text not null,
      builtin integer not null, enabled integer not null, created_at integer not null
    );
  `);
  allowlist = new AllowlistService({ db: db as never, clock: { now: () => 1 }, osPlatform: 'linux' });
});

describe('custom allowlist entries are not read-only-proven (#5)', () => {
  it('a read-only run never runs a custom entry in confirm mode (RUN_READ_ONLY, no card)', async () => {
    allowlist.add('touch marker-ro');
    const gateway = makeGateway();
    await expect(
      gateway.exec(readTask, { command: 'touch marker-ro', network: none }),
    ).rejects.toMatchObject({ code: 'RUN_READ_ONLY' });
    expect(approvals).toEqual([]);
    expect(existsSync(path.join(workspace(), 'marker-ro'))).toBe(false);
    // Built-ins still run for the read-only run.
    const listed = await gateway.exec(readTask, { command: 'ls', network: none });
    expect(listed.exitCode).toBe(0);
  });

  it('a write task runs the custom entry without a card — until the conversation is tainted', async () => {
    allowlist.add('touch marker-w');
    const gateway = makeGateway();
    const result = await gateway.exec(writeTask, { command: 'touch marker-w', network: none });
    expect(result.exitCode).toBe(0);
    expect(approvals).toEqual([]);
    tainted = true;
    await expect(
      gateway.exec(writeTask, { command: 'touch marker-w2', network: none }),
    ).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect(approvals.map((a) => a.kind)).toEqual(['command']);
    expect(approvals[0]!.payload['tainted']).toBe(true);
    expect(existsSync(path.join(workspace(), 'marker-w2'))).toBe(false);
    // Built-in read-only entries stay exempt while tainted.
    const listed = await gateway.exec(writeTask, { command: 'ls', network: none });
    expect(listed.exitCode).toBe(0);
    expect(approvals).toHaveLength(1);
  });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!hasGit)('allowlisted git obeys no program-running repository config (#4)', () => {
  function gitInit(dir: string): void {
    const run = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    run('init', '-q');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 't');
    writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    run('add', 'a.txt');
    run('commit', '-q', '-m', 'init');
    writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  }

  it.skipIf(process.platform === 'win32')('a clean repository: git status / diff run without a card', async () => {
    gitInit(workspace());
    const gateway = makeGateway();
    const status = await gateway.exec(writeTask, { command: 'git status --short', network: none });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('a.txt');
    const diff = await gateway.exec(writeTask, { command: 'git diff', network: none });
    expect(diff.stdout).toContain('+two');
    expect(approvals).toEqual([]);
  });

  it('core.fsmonitor / diff.external pointing at a marker script never execute', async () => {
    gitInit(workspace());
    const marker = path.join(path.dirname(home), 'pwned');
    const script = path.join(path.dirname(home), 'hook.sh');
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    spawnSync('git', ['config', 'core.fsmonitor', script], { cwd: workspace() });
    spawnSync('git', ['config', 'diff.external', script], { cwd: workspace() });
    const gateway = makeGateway();
    for (const command of ['git status', 'git diff', 'git log -p', 'git show HEAD']) {
      await expect(gateway.exec(writeTask, { command, network: none })).rejects.toMatchObject({
        code: 'APPROVAL_DENIED',
      });
    }
    // Every one became a card (the user decides), and nothing ran the hook.
    expect(approvals.map((a) => a.kind)).toEqual(['command', 'command', 'command', 'command']);
    expect(existsSync(marker)).toBe(false);
  });

  it('textconv / filter drivers and includes make git ask; hook / editor / pager settings do not', () => {
    const scoped = (entries: Array<[string, string]>) =>
      entries.map(([scope, kv]) => `${scope}\0${kv}`).join('\0') + '\0';
    expect(
      riskyGitConfigKeys(
        scoped([
          ['global', 'core.fsmonitor\n/usr/bin/watchman-hook'],
          ['local', 'diff.pdf.textconv\npdftotext'],
          ['local', 'filter.lfs.clean\ngit-lfs clean'],
          ['local', 'include.path\n../x'],
          ['local', 'core.fsmonitor\nfalse'],
          ['worktree', 'core.fsmonitor\n./hook'],
          ['local', 'gpg.program\n./sign'],
          // Review P2 false positives: not run by read-only commands.
          ['local', 'core.hookspath\n.husky/_'],
          ['local', 'core.editor\nvim'],
          ['local', 'sequence.editor\nvim'],
          ['local', 'merge.ours.driver\ntrue'],
          ['local', 'core.sshcommand\nssh -i x'],
          ['local', 'core.pager\nless'],
          ['local', 'pager.log\nless'],
        ]),
      ),
    ).toEqual([
      'diff.pdf.textconv',
      'filter.lfs.clean',
      'include.path',
      'core.fsmonitor',
      'gpg.program',
    ]);
  });

  it.skipIf(process.platform === 'win32')('a husky-style core.hooksPath does not cost a card', async () => {
    gitInit(workspace());
    spawnSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: workspace() });
    const gateway = makeGateway();
    const status = await gateway.exec(writeTask, { command: 'git status --short', network: none });
    expect(status.exitCode).toBe(0);
    expect(approvals).toEqual([]);
  });

  it('review P1-3: a .git pointer file to a repository outside the workspace makes git ask', async () => {
    const privateRepo = path.join(path.dirname(home), 'private');
    mkdirSync(privateRepo, { recursive: true });
    gitInit(privateRepo);
    writeFileSync(path.join(privateRepo, 'secrets.env'), 'TOKEN=s3cret\n');
    spawnSync('git', ['add', 'secrets.env'], { cwd: privateRepo });
    spawnSync('git', ['commit', '-q', '-m', 'secret'], { cwd: privateRepo });
    // The Bot plants a gitdir pointer (written here directly: the file tools would ask).
    writeFileSync(path.join(workspace(), '.git'), `gitdir: ${path.join(privateRepo, '.git')}\n`);
    const gateway = makeGateway();
    for (const command of ['git show HEAD:secrets.env', 'git log -p', 'git status']) {
      await expect(gateway.exec(writeTask, { command, network: none }), command).rejects.toMatchObject({
        code: 'APPROVAL_DENIED',
      });
    }
    expect(approvals.map((a) => a.kind)).toEqual(['command', 'command', 'command']);
  });

  it('review P1-3: objects/info/alternates borrowing another repository makes git ask', async () => {
    const privateRepo = path.join(path.dirname(home), 'private2');
    mkdirSync(privateRepo, { recursive: true });
    gitInit(privateRepo);
    gitInit(workspace());
    writeFileSync(
      path.join(workspace(), '.git', 'objects', 'info', 'alternates'),
      `${path.join(privateRepo, '.git', 'objects')}\n`,
    );
    const gateway = makeGateway();
    await expect(
      gateway.exec(writeTask, { command: 'git log --oneline', network: none }),
    ).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect(approvals).toHaveLength(1);
  });
});

describe('resolving git without the current directory (review P1-4)', () => {
  it('searches only absolute PATH entries, with PATHEXT on win32', () => {
    const present = new Set(['C:\\Git\\cmd\\git.exe', '/usr/bin/git', 'D:\\tools\\git.cmd']);
    const exists = (candidate: string) => present.has(candidate);
    expect(resolveExecutable('git', '.;bin;C:\\Git\\cmd', 'win32', { exists })).toBe(
      'C:\\Git\\cmd\\git.exe',
    );
    // `\foo` (drive-relative) and relative entries are skipped.
    expect(resolveExecutable('git', '\\tools;D:\\tools', 'win32', { exists, pathExt: '.EXE;.CMD' })).toBe(
      'D:\\tools\\git.cmd',
    );
    expect(resolveExecutable('git', '', 'win32', { exists })).toBeNull();
    expect(resolveExecutable('git', '.:node_modules/.bin:/usr/bin', 'linux', { exists })).toBe('/usr/bin/git');
    expect(resolveExecutable('git', '.:bin', 'linux', { exists: () => true })).toBeNull();
  });

  it('the hardened env drops PATH entries inside Bot-writable roots and sets the Windows guard', () => {
    const env = exemptCommandEnv(
      { PATH: '/w/space/bin:/w/space:/usr/bin:/w/spaceship/bin' },
      'linux',
      ['/w/space'],
    );
    expect(env['PATH']).toBe('/usr/bin:/w/spaceship/bin');
    expect(env['VOLTA_BYPASS']).toBe('1');
    expect(env['NoDefaultCurrentDirectoryInExePath']).toBeUndefined();
    const win = exemptCommandEnv({ PATH: 'C:\\W\\Space\\bin;C:\\Git\\cmd' }, 'win32', ['c:\\w\\space']);
    expect(win['PATH']).toBe('C:\\Git\\cmd');
    expect(win['NoDefaultCurrentDirectoryInExePath']).toBe('1');
  });
});

describe('Bot writes to repository control files need a grant (#4)', () => {
  it('classifies .git/config, hooks, info/attributes; other .git files and look-alikes are not', () => {
    expect(isGitControlPath('/w/.git/config')).toBe(true);
    expect(isGitControlPath('/w/.git/config.worktree')).toBe(true);
    expect(isGitControlPath('/w/.git/hooks/pre-commit')).toBe(true);
    expect(isGitControlPath('/w/.git/hooks')).toBe(true);
    expect(isGitControlPath('/w/.git/info/attributes')).toBe(true);
    expect(isGitControlPath('/w/.git/modules/sub/config')).toBe(true);
    // Review P1-3: files that re-point git at another repository.
    expect(isGitControlPath('/w/.git')).toBe(true);
    expect(isGitControlPath('/w/sub/.git')).toBe(true);
    expect(isGitControlPath('/w/.git/commondir')).toBe(true);
    expect(isGitControlPath('/w/.git/worktrees/x/gitdir')).toBe(true);
    expect(isGitControlPath('/w/.git/objects/info/alternates')).toBe(true);
    expect(isGitControlPath('/w/.git/modules/sub/info/attributes')).toBe(true);
    expect(isGitControlPath('/w/.git/modules/sub/hooks/post-checkout')).toBe(true);
    expect(isGitControlPath('/w/.git/HEAD')).toBe(false);
    expect(isGitControlPath('/w/.gitignore')).toBe(false);
    expect(isGitControlPath('/w/src/config')).toBe(false);
    expect(isGitControlPath('/w/.github/hooks/x')).toBe(false);
  });

  it('checkPath: workspace writes there are a sensitive grant request; reads stay allowed', () => {
    const gateway = makeGateway();
    const config = path.join(workspace(), '.git', 'config');
    expect(gateway.checkPath(writeTask, config, 'write')).toMatchObject({
      kind: 'needs_grant',
      sensitive: true,
    });
    expect(gateway.checkPath(writeTask, path.join(workspace(), '.git', 'hooks', 'post-checkout'), 'write'))
      .toMatchObject({ kind: 'needs_grant' });
    expect(gateway.checkPath(writeTask, path.join(workspace(), 'sub', '.git'), 'write')).toMatchObject({
      kind: 'needs_grant',
      sensitive: true,
    });
    expect(gateway.checkPath(writeTask, config, 'read').kind).toBe('allowed');
    expect(gateway.checkPath(writeTask, path.join(workspace(), 'src', 'a.ts'), 'write').kind).toBe(
      'allowed',
    );
  });
});

describe('exempt command environment (#2)', () => {
  it('drops relative PATH entries and switches off toolchain downloads, pagers and fsmonitor', () => {
    const env = exemptCommandEnv({ PATH: '/opt/tc/bin:node_modules/.bin::.:/usr/bin' }, 'linux');
    expect(env['PATH']).toBe('/opt/tc/bin:/usr/bin');
    expect(env).toMatchObject({
      COREPACK_ENABLE_NETWORK: '0',
      YARN_IGNORE_PATH: '1',
      GOTOOLCHAIN: 'local',
      GIT_PAGER: 'cat',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
    });
    expect(exemptCommandEnv({ PATH: 'C:\\Tools;bin;D:\\x' }, 'win32')['PATH']).toBe('C:\\Tools;D:\\x');
  });
});
