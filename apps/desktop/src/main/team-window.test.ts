import { describe, expect, it, vi } from 'vitest';
import { buildTeamServerSpawnArgs, openTeamServer } from './team-window';
import { remoteProfileHash } from './remote-mode';

/**
 * T5 步骤 5：连接团队服务器 = 另起一个远程模式壳进程。这里只测 URL 校验与
 * spawn 参数 / env 组装（spawn 注入 spy），绝不真起进程（Electron 由用户跑 e2e）。
 */

const LAUNCH = { execPath: '/opt/kepcup/kepcup', devAppPath: null };
const PACKAGED_ENV = { PATH: '/usr/bin', KEPCUP_HOME: '/tmp/data' } as NodeJS.ProcessEnv;

describe('buildTeamServerSpawnArgs', () => {
  it('spawns the current executable with the remote switches in env', () => {
    const plan = buildTeamServerSpawnArgs(PACKAGED_ENV, 'http://127.0.0.1:8643/', LAUNCH);
    expect(plan.command).toBe('/opt/kepcup/kepcup');
    expect(plan.args).toEqual([]);
    expect(plan.options.detached).toBe(true);
    expect(plan.options.stdio).toBe('ignore');
    // 父进程 env 全量继承，再叠远程模式开关（profile = 地址哈希）。
    expect(plan.options.env).toEqual({
      PATH: '/usr/bin',
      KEPCUP_HOME: '/tmp/data',
      KEPCUP_REMOTE_URL: 'http://127.0.0.1:8643/',
      KEPCUP_REMOTE_PROFILE: remoteProfileHash('http://127.0.0.1:8643/'),
    });
  });

  it('carries the dev-shell app path so `electron <app>` launches this app', () => {
    const plan = buildTeamServerSpawnArgs(PACKAGED_ENV, 'http://127.0.0.1:8643/', {
      execPath: '/electron',
      devAppPath: '/repo/apps/desktop',
    });
    expect(plan.command).toBe('/electron');
    expect(plan.args).toEqual(['/repo/apps/desktop']);
  });

  it('the profile is the stable url hash — same server, same partition', () => {
    const a = buildTeamServerSpawnArgs({}, 'http://127.0.0.1:8643/', LAUNCH);
    const b = buildTeamServerSpawnArgs({}, 'http://127.0.0.1:8643/', LAUNCH);
    const c = buildTeamServerSpawnArgs({}, 'http://127.0.0.1:8644/', LAUNCH);
    expect(a.options.env['KEPCUP_REMOTE_PROFILE']).toBe(b.options.env['KEPCUP_REMOTE_PROFILE']);
    expect(a.options.env['KEPCUP_REMOTE_PROFILE']).not.toBe(c.options.env['KEPCUP_REMOTE_PROFILE']);
  });
});

describe('openTeamServer', () => {
  it('validates the url with the resolveRemoteMode rules before spawning', () => {
    const spawn = vi.fn(() => ({ unref: () => {} }));
    expect(() => openTeamServer('not a url', { spawn })).toThrow(/合法 URL/);
    expect(() => openTeamServer('ftp://127.0.0.1:8643', { spawn })).toThrow(/http/);
    expect(() => openTeamServer('http://user:pw@host:1', { spawn })).toThrow(/不能内嵌/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns detached with the normalized url and profile env, then unrefs', () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));
    openTeamServer('http://127.0.0.1:8643/?token=x#y', { spawn, env: PACKAGED_ENV, launch: LAUNCH });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; detached: boolean; stdio: string },
    ];
    expect(command).toBe(LAUNCH.execPath);
    expect(args).toEqual([]);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    // 校验即规范化：query / hash 剥离后才进 env，profile 按规范化地址哈希。
    expect(options.env['KEPCUP_REMOTE_URL']).toBe('http://127.0.0.1:8643/');
    expect(options.env['KEPCUP_REMOTE_PROFILE']).toBe(
      remoteProfileHash('http://127.0.0.1:8643/'),
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
