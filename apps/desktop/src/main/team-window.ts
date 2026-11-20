import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { remoteProfileHash, resolveRemoteMode } from './remote-mode';

/**
 * 「连接团队服务器」启动器（T5 步骤 5，62.08 §3 桌面 P0 过渡）：以远程模式另起一个
 * 独立进程加载团队服务器托管的 web 构建。同进程开第二个远程窗口不可行（remoteMode /
 * 窗口 / 权限策略 / userData / 单实例锁均为进程全局），现成做法就是另起进程。
 *
 * 多实例冲突交给单实例锁：子进程带 `KEPCUP_REMOTE_PROFILE`（地址哈希）→ 其 userData
 * 是 `<userData>/remote/<profile>`，锁与 localStorage / Cookie 都以它为作用域。
 * 同一 profile 已有实例时，子进程 `requestSingleInstanceLock` 失败自然退出（spawn 后
 * 立即退出正是该路径的行为），持有锁的一方收到 `second-instance` 事件聚焦已有窗口——
 * 本模块不做「已打开」检测，交给 Electron 的锁。
 *
 * 本模块刻意不 import electron：spawn 参数与 env 的组装是纯函数
 * （`buildTeamServerSpawnArgs`），spawn 经注入替换，测试不真起进程。
 */

/** 当前 app 的启动上下文（dev 壳与打包版的差异，同 setAsDefaultProtocolClient 的 seam）。 */
export interface TeamServerLaunchContext {
  /** The Electron executable running the current process (process.execPath). */
  execPath: string;
  /**
   * Resolved app entry path when the dev Electron shell loads this app
   * (process.defaultApp + argv[1]); null in packaged builds where execPath IS
   * the app and must be spawned without extra args.
   */
  devAppPath: string | null;
}

/** A complete detached-spawn spec for one team server shell (pure data). */
export interface TeamServerSpawnPlan {
  command: string;
  args: string[];
  options: {
    env: NodeJS.ProcessEnv;
    detached: true;
    stdio: 'ignore';
  };
}

/** Minimal structural face of child_process.spawn (tests inject a spy). */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore' },
) => { unref(): void };

/**
 * Pure builder: the full spawn spec for a team server shell. `env` is the
 * parent's environment snapshot; `url` must already be validated / normalized
 * (the caller runs it through `resolveRemoteMode`). The child inherits
 * everything plus the remote-mode switches; the profile is the stable URL hash
 * so the same server always lands on the same single-instance lock and data
 * partition.
 */
export function buildTeamServerSpawnArgs(
  env: NodeJS.ProcessEnv,
  url: string,
  launch: TeamServerLaunchContext,
): TeamServerSpawnPlan {
  return {
    command: launch.execPath,
    args: launch.devAppPath !== null ? [launch.devAppPath] : [],
    options: {
      env: { ...env, KEPCUP_REMOTE_URL: url, KEPCUP_REMOTE_PROFILE: remoteProfileHash(url) },
      detached: true,
      stdio: 'ignore',
    },
  };
}

/** The launch context of THIS process (main process only; tests inject instead). */
function currentLaunchContext(): TeamServerLaunchContext {
  return {
    execPath: process.execPath,
    devAppPath:
      process.defaultApp && process.argv.length >= 2 ? resolve(process.argv[1] as string) : null,
  };
}

export interface OpenTeamServerOptions {
  /** Environment snapshot the child inherits (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Launch context of the current app (defaults to this process's own). */
  launch?: TeamServerLaunchContext;
  /** Injectable spawn (tests pass a spy; production uses node:child_process.spawn). */
  spawn?: SpawnFn;
}

/**
 * 校验 URL（同 `resolveRemoteMode` 规则：http/https、无内嵌凭据，query/hash 剥离）
 * 并以远程模式另起一个 detached 进程。fire-and-forget：子进程的成败由它自己的
 * 单实例锁与窗口装配决定，本进程只负责拉起。
 */
export function openTeamServer(rawUrl: string, options: OpenTeamServerOptions = {}): void {
  // 校验即规范化：错误的地址（非 http、内嵌凭据、空串）在这里抛错，绝不悄悄回落本地模式。
  const target = resolveRemoteMode({ KEPCUP_REMOTE_URL: rawUrl });
  if (target === null) throw new Error(`KEPCUP_REMOTE_URL 不是合法 URL：${rawUrl}`);
  const plan = buildTeamServerSpawnArgs(
    options.env ?? process.env,
    target.url,
    options.launch ?? currentLaunchContext(),
  );
  (options.spawn ?? spawn)(plan.command, plan.args, plan.options).unref();
}
