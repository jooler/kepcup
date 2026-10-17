import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileReadState } from '../../src/tools/fs-state.js';
import { matchProtectRule, globMatch } from '../../src/workdir/service.js';
import type { Workdir } from '@kepcup/shared';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'p04-unit-'));
  dirs.push(dir);
  return dir;
}

const RULES = {
  denyRead: ['.env', '.env.*', '*.pem', '*.key', '*.p12', 'id_rsa*', '.git/config'],
  denyWrite: ['important.txt'],
};

describe('protect rule matching (保护规则)', () => {
  const workdir = tmpWorkdir();

  it('denies .env at the workdir root', () => {
    expect(matchProtectRule(RULES, workdir, path.join(workdir, '.env'), 'read')).toBe(true);
  });

  it('denies .env in nested directories (name rules match any depth)', () => {
    expect(matchProtectRule(RULES, workdir, path.join(workdir, 'src', 'deep', '.env.local'), 'read')).toBe(true);
  });

  it('denies key material by extension and prefix', () => {
    expect(matchProtectRule(RULES, workdir, path.join(workdir, 'server.pem'), 'read')).toBe(true);
    expect(matchProtectRule(RULES, workdir, path.join(workdir, 'certs', 'api.key'), 'read')).toBe(true);
    expect(matchProtectRule(RULES, workdir, path.join(workdir, 'id_rsa'), 'read')).toBe(true);
    expect(matchProtectRule(RULES, workdir, path.join(workdir, 'id_rsa.pub'), 'read')).toBe(true);
  });

  it('denies anchored rules only beneath their directory', () => {
    expect(matchProtectRule(RULES, workdir, path.join(workdir, '.git', 'config'), 'read')).toBe(true);
    expect(matchProtectRule(RULES, workdir, path.join(workdir, 'config'), 'read')).toBe(false);
  });

  it('allows ordinary files and honours mode separation', () => {
    expect(matchProtectRule(RULES, workdir, path.join(workdir, 'src', 'index.ts'), 'read')).toBe(false);
    expect(matchProtectRule(RULES, workdir, path.join(workdir, '.env'), 'write')).toBe(false);
    expect(matchProtectRule(RULES, workdir, path.join(workdir, 'important.txt'), 'write')).toBe(true);
    expect(matchProtectRule(RULES, workdir, path.join(workdir, 'important.txt'), 'read')).toBe(false);
  });

  it('ignores paths outside the workdir', () => {
    expect(matchProtectRule(RULES, workdir, path.join(path.dirname(workdir), '.env'), 'read')).toBe(false);
  });
});

describe('globMatch', () => {
  it('supports star within a segment', () => {
    expect(globMatch('*.ts', 'index.ts')).toBe(true);
    expect(globMatch('*.ts', 'dir/index.ts')).toBe(false);
    expect(globMatch('.env.*', '.env.local')).toBe(true);
  });

  it('supports double star across segments', () => {
    expect(globMatch('**/*.pem', 'a/b/c.pem')).toBe(true);
    expect(globMatch('**/*.pem', 'c.pem')).toBe(true);
  });

  it('escapes regex metacharacters', () => {
    expect(globMatch('a+b.txt', 'a+b.txt')).toBe(true);
    expect(globMatch('a+b.txt', 'aab.txt')).toBe(false);
  });
});

describe('FileReadState (过期检测)', () => {
  it('flags files modified after the run read them', () => {
    const file = path.join(tmpWorkdir(), 'a.txt');
    writeFileSync(file, 'v1');
    const state = new FileReadState();
    state.record('run_1', file, Buffer.from('v1'));
    expect(state.isStale('run_1', file)).toBe(false);

    writeFileSync(file, 'v2-external-edit');
    expect(state.isStale('run_1', file)).toBe(true);

    // The run's own write re-baselines the hash (disk already carries v3).
    writeFileSync(file, 'v3');
    state.recordWrite('run_1', file, 'v3');
    expect(state.isStale('run_1', file)).toBe(false);

    // Other runs are unaffected; unread files are never stale.
    expect(state.isStale('run_2', file)).toBe(false);
  });

  it('treats a vanished file as stale and forgets per-run state', () => {
    const file = path.join(tmpWorkdir(), 'b.txt');
    writeFileSync(file, 'x');
    const state = new FileReadState();
    state.record('run_1', file, Buffer.from('x'));
    rmSync(file);
    expect(state.isStale('run_1', file)).toBe(true);

    state.release('run_1');
    writeFileSync(file, 'x');
    expect(state.isStale('run_1', file)).toBe(false);
  });
});

describe('workdir policy input', () => {
  it('joins the workdir into the sandbox policy per lease state', async () => {
    const { buildSandboxPolicy } = await import('../../src/sandbox/policy.js');
    const { resolvePaths } = await import('../../src/infra/paths.js');
    const { canonicalPath } = await import('../../src/infra/paths.js');
    const paths = resolvePaths(tmpWorkdir());
    const workdirPath = canonicalPath(tmpWorkdir());
    const base = {
      platform: 'darwin',
      paths,
      workspacePath: path.join(paths.home, 'bots', 'b', 'workspaces', 'c'),
      network: { mode: 'open' as const, allowDomains: [] },
    };

    const readonly = buildSandboxPolicy({
      ...base,
      workdir: { path: workdirPath, hasLease: false, denyReadGlobs: [`${workdirPath}/**/.env`] },
    });
    expect(readonly.readOnly).toContain(workdirPath);
    expect(readonly.readWrite).not.toContain(workdirPath);
    expect(readonly.denyRead).toContain(`${workdirPath}/**/.env`);

    const leased = buildSandboxPolicy({
      ...base,
      workdir: { path: workdirPath, hasLease: true, denyReadGlobs: [] },
    });
    expect(leased.readWrite).toContain(workdirPath);
    // The workdir under the (denied) user home is re-exposed.
    expect(leased.denyRead).not.toContain(workdirPath);
  });

  it('flips srt network config for workdir conversations (本机端口)', async () => {
    const { srtNetworkConfigFor } = await import('../../src/sandbox/backend-srt.js');
    const unbound = srtNetworkConfigFor({
      readWrite: [], readOnly: [], denyRead: [],
      network: { mode: 'open', allowDomains: [] },
      env: {},
    });
    expect(unbound.allowLocalBinding).toBe(false);
    expect(unbound.deniedDomains).toContain('localhost');

    const bound = srtNetworkConfigFor({
      readWrite: [], readOnly: [], denyRead: [],
      network: { mode: 'open', allowDomains: [], allowLocalhost: true },
      env: {},
    });
    expect(bound.allowLocalBinding).toBe(true);
    expect(bound.deniedDomains).not.toContain('localhost');
    expect(bound.deniedDomains).not.toContain('127.0.0.0/8');
    // Intranet / metadata stays denied in every mode.
    expect(bound.deniedDomains).toContain('192.168.0.0/16');
    expect(bound.deniedDomains).toContain('169.254.0.0/16');
  });
});

type _WorkdirShape = Workdir;
void (0 as unknown as _WorkdirShape | null);
