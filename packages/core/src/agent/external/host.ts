import { spawn as spawnChild } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  AGENT_IDLE_SHUTDOWN_MS,
  AGENT_INIT_TIMEOUT_MS,
  AGENT_KILL_GRACE_MS,
  AGENT_STDERR_TAIL_MAX_CHARS,
  AppError,
  type AgentCatalogEntry,
} from '@kepcup/shared';
import type { CoreLogger } from '../../infra/logger.js';
import {
  AcpConnection,
  createShimChannel,
  type AcpInitializeResponse,
  type AcpLogger,
  type AcpRequestPermissionRequest,
  type AcpSessionRouter,
  type AcpSessionUpdate,
  type AgentAuthStatus,
  type PermissionDecision,
  type PermissionVerdict,
  type SessionBridge,
} from './acp/client.js';
import { classifierFor, toAgentError } from './errors.js';
import { PROVIDERS, providerFor } from './providers/index.js';
import type {
  AgentExit,
  AgentProcess,
  AgentProvider,
  LaunchTarget,
  ProviderRegistry,
} from './types.js';

/**
 * 外部 Agent 进程管理（docs/design/28-external-agents-acp.md §10「host.ts」，
 * D72）：每个 Agent 一个子进程 + 一条 ACP 连接，多会话复用；懒启动、
 * `initialize` 结果缓存、无会话时空闲退出；进程退出 / 崩溃时其上活跃 run 以
 * failed 结算（下次使用重新拉起）。环境变量走白名单——KepCup 进程环境
 * （密钥、KEPCUP_* 开关）不透传。核心关闭（dispose）时不再通知 run：数据库
 * 已关，进行中的 run 由下次启动的 recoverInterrupted 标为 interrupted（与
 * 内置引擎一致）。
 */

/** 一个 run 在其会话上的接收端（由 ExternalAgentEngine 实现）。 */
export interface SessionSink {
  /** The host MCP bridge the session was created with (P2), or null. */
  bridge: SessionBridge | null;
  onUpdate(update: AcpSessionUpdate): void;
  onPermission(title: string, decision: PermissionDecision): void;
  /**
   * P3 权限桥：run 自己裁决权限请求（可等待审批卡）。缺省 = 按 P1 规则默认
   * 拒绝（探测 / 测试连接会话）。
   */
  requestPermission?(request: AcpRequestPermissionRequest): Promise<PermissionVerdict>;
  /** The agent process / connection is gone; the run must settle failed. */
  onClosed(error: AppError): void;
}

/** acquire() 的结果：持有期间进程不会因空闲退出。 */
export interface AgentLease {
  connection: AcpConnection;
  init: AcpInitializeResponse;
  provider: AgentProvider;
  attach(sessionId: string, sink: SessionSink): void;
  detach(sessionId: string): void;
  /**
   * P5 会话复用：本进程里仍开着、可被下一个 run 直接复用的会话及引擎为它
   * 记下的状态（不透明）。进程退出 / 崩溃 / 被替换时随之消失——下一个 run
   * 只能按 Provider 能力 resume / load 或新建。
   */
  openSession<T>(sessionId: string): T | undefined;
  /** Keeps the session open in this process with the engine's state. */
  keepSession(sessionId: string, state: unknown): void;
  /** The session is no longer reusable in this process (closed / poisoned). */
  forgetSession(sessionId: string): void;
  release(): void;
}

/** 不持有租约地访问一个仍开着的会话（删除 / 丢弃会话时尽力而为）。 */
export interface OpenAgentSession {
  connection: AcpConnection;
  init: AcpInitializeResponse;
  state: unknown;
  /** A run is attached to it right now. */
  busy: boolean;
}

export type AgentSpawner = (input: {
  entry: AgentCatalogEntry;
  launch: LaunchTarget;
  cwd: string;
  onStderr(text: string): void;
}) => AgentProcess;

export interface AgentHostDeps {
  logger: CoreLogger;
  /** secrets.redact：stderr 进日志前脱敏。 */
  redact(text: string): string;
  appVersion: string;
  /** 解析目录条目的启动方式（P4 为安装器；P1 为 system 来源 / 测试注入）。 */
  resolveLaunch(entry: AgentCatalogEntry): LaunchTarget;
  providers?: ProviderRegistry;
  /** Test hook: in-process agents instead of child processes. */
  spawn?: AgentSpawner;
  /** Neutral working directory of agent processes (sessions carry their own cwd). */
  processCwd?: string;
  /**
   * Per-agent private process cwd (审查 M1; start.ts: `agents/{id}/cwd`, 0700);
   * wins over `processCwd`. Never the shared temp directory in production.
   */
  processCwdFor?(agentId: string): string;
  /** 「加载我的个人配置」（进程级，`LaunchContext.loadUserConfig`）。 */
  loadUserConfigFor?(agentId: string): boolean;
  /** 应用数据目录（Provider 的进程级隔离配置用，`LaunchContext.dataHome`）。 */
  dataHome?: string;
  /** 每个 Agent 的私有状态目录（`LaunchContext.stateDir`）。 */
  stateDirFor?(agentId: string): string;
  idleShutdownMs?: number;
  initTimeoutMs?: number;
}

interface LiveAgent {
  entry: AgentCatalogEntry;
  provider: AgentProvider;
  process: AgentProcess;
  connection: AcpConnection;
  ready: Promise<AcpInitializeResponse>;
  sessions: Map<string, SessionSink>;
  /** Sessions kept open between runs (P5 reuse) → the engine's state. */
  openSessions: Map<string, unknown>;
  /** The `initialize` result once known (for lease-less session access). */
  init: AcpInitializeResponse | null;
  leases: number;
  idleTimer: NodeJS.Timeout | null;
  gone: boolean;
  /**
   * Superseded by `stop()` while busy: new acquires start a fresh process;
   * this one closes once its last lease / session is gone.
   */
  retiring: boolean;
}

/**
 * 透传给 Agent 进程的环境变量白名单：系统路径、用户目录、区域、代理与证书，
 * 以及官方登录 / 系统钥匙串需要的会话变量（D-Bus、图形会话）。Agent 的凭据
 * 由其官方登录流程自管（存在其自身目录），KepCup 不注入。
 */
const ENV_WHITELIST: readonly string[] = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
];

/** 白名单内的宿主环境 + Provider 声明的变量（后者优先）。纯函数。 */
export function buildAgentEnv(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_WHITELIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return withLoopbackNoProxy({ ...env, ...extra });
}

const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/**
 * With a proxy configured, loopback must bypass it: the host MCP bridge
 * (127.0.0.1) carries a session Bearer token that must never reach the
 * user's proxy. Both spellings get the user's entries plus loopback.
 */
function withLoopbackNoProxy(env: Record<string, string>): Record<string, string> {
  if (!PROXY_KEYS.some((key) => (env[key] ?? '').length > 0)) return env;
  const entries = [env.NO_PROXY, env.no_proxy]
    .flatMap((value) => (value ?? '').split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const merged = [...new Set([...entries, ...LOOPBACK_HOSTS])].join(',');
  return { ...env, NO_PROXY: merged, no_proxy: merged };
}

export interface FindOnPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test hook (simulated file systems). */
  isExecutable?: (file: string, platform: NodeJS.Platform) => boolean;
}

/**
 * Looks a bare command up on PATH; null when absent. On Windows only the
 * PATHEXT extensions are tried, in order — the extension-less file next to
 * an npm `.cmd` shim is a POSIX sh script that cannot be spawned there.
 */
export function findOnPath(command: string, options: FindOnPathOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.isExecutable ?? isExecutable;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((extension) => extension.length > 0)
      : [''];
  const candidatesFor = (base: string): string[] => {
    if (platform !== 'win32') return [base];
    const own = paths.extname(base).toLowerCase();
    // An explicit, executable extension ("codex.cmd") is used as given.
    if (own.length > 0 && extensions.some((extension) => extension.toLowerCase() === own)) {
      return [base];
    }
    return extensions.map((extension) => `${base}${extension}`);
  };
  if (paths.isAbsolute(command)) {
    return candidatesFor(command).find((candidate) => exists(candidate, platform)) ?? null;
  }
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    for (const candidate of candidatesFor(paths.join(dir, command))) {
      if (exists(candidate, platform)) return candidate;
    }
  }
  return null;
}

function isExecutable(file: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(file, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// cmd.exe metacharacters (cross-spawn's escaping rules).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArgument(arg: string): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`;
  // npm .cmd shims re-parse their arguments once more: escape twice.
  return escaped.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/**
 * How to spawn a launch target. Windows `.cmd` / `.bat` cannot be spawned
 * with `shell:false` (Node ≥ 20.12 rejects them with EINVAL): they run
 * through `cmd.exe /d /s /c` with every argument escaped for cmd.
 */
export function prepareSpawn(
  launch: LaunchTarget,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(launch.command)) {
    return { command: launch.command, args: [...launch.args], windowsVerbatimArguments: false };
  }
  const line = [
    launch.command.replace(CMD_META, '^$1'),
    ...launch.args.map(escapeCmdArgument),
  ].join(' ');
  return {
    command: launch.env.ComSpec ?? process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * P1 的启动解析：只有 `system` 来源（用户已装的官方 CLI，按 PATH 查找）；
 * npx / binary 由 P4 的安装器解析到 `toolchains/agents/{id}@{version}/`。
 */
export function defaultLaunchResolver(entry: AgentCatalogEntry): LaunchTarget {
  const system = entry.distribution.system;
  if (system !== undefined) {
    const command = findOnPath(system.cmd);
    if (command !== null) return { command, args: [...(system.args ?? [])], env: {} };
  }
  throw new AppError('AGENT_UNAVAILABLE', `智能体「${entry.name}」未安装`);
}

/**
 * Production spawner: the agent as a child process speaking ACP over stdio.
 * POSIX children lead their own process group so the kill reaches the whole
 * tree (npx → node → agent grandchildren); Windows uses `taskkill /T /F`.
 * SIGTERM escalates to SIGKILL after AGENT_KILL_GRACE_MS.
 */
export const spawnAgentProcess: AgentSpawner = ({ launch, cwd, onStderr }) => {
  const prepared = prepareSpawn(launch);
  const posix = process.platform !== 'win32';
  const child = spawnChild(prepared.command, prepared.args, {
    cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
    detached: posix,
  });
  let exitedNow = false;
  const exited = new Promise<AgentExit>((resolve) => {
    child.once('exit', (code, signal) => {
      exitedNow = true;
      resolve({ code, signal });
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      exitedNow = true;
      onStderr(`spawn failed: ${error.message}\n`);
      resolve({
        code: null,
        signal: null,
        error: {
          ...(error.code !== undefined ? { code: error.code } : {}),
          message: error.message,
        },
      });
    });
  });
  // A dead child turns pending writes into EPIPE; the exit path reports it.
  child.stdin.on('error', () => undefined);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => onStderr(chunk));
  const signalTree = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      if (posix) process.kill(-child.pid, signal);
      else spawnChild('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // Already gone.
    }
  };
  let killing = false;
  return {
    channel: {
      readable: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      writable: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    },
    exited,
    kill: () => {
      if (exitedNow || killing) return;
      killing = true;
      signalTree('SIGTERM');
      if (posix) {
        const timer = setTimeout(() => {
          if (!exitedNow) signalTree('SIGKILL');
        }, AGENT_KILL_GRACE_MS);
        timer.unref?.();
      }
    },
  };
};

const STDERR_LINE_MAX_CHARS = 500;

export class AgentHost {
  readonly #deps: AgentHostDeps;
  readonly #agents = new Map<string, LiveAgent>();
  readonly #authStatus = new Map<string, AgentAuthStatus & { at: number }>();
  /** Processes retired by `stop()` while still serving runs. */
  readonly #retiring = new Set<LiveAgent>();
  #disposed = false;
  /**
   * Process exits and stderr arrive asynchronously, possibly after core
   * shutdown closed the logger (pino would throw): log quietly then.
   */
  readonly #log: AcpLogger;

  constructor(deps: AgentHostDeps) {
    this.#deps = deps;
    const quiet =
      (level: 'debug' | 'info' | 'warn' | 'error') =>
      (obj: object, message: string): void => {
        if (this.#disposed) return;
        try {
          deps.logger[level](obj, message);
        } catch {
          // Logger already torn down; nothing to report to.
        }
      };
    this.#log = {
      debug: quiet('debug'),
      info: quiet('info'),
      warn: quiet('warn'),
      error: quiet('error'),
    } as AcpLogger;
  }

  /** Set once the core is shutting down: nothing may settle runs any more. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** Starts (or reuses) the entry's process and waits for `initialize`. */
  async acquire(entry: AgentCatalogEntry): Promise<AgentLease> {
    if (this.#disposed) throw new AppError('AGENT_UNAVAILABLE', '核心服务正在关闭');
    let live = this.#agents.get(entry.id);
    if (live === undefined || live.gone) live = this.#start(entry);
    live.leases += 1;
    if (live.idleTimer !== null) {
      clearTimeout(live.idleTimer);
      live.idleTimer = null;
    }
    let init: AcpInitializeResponse;
    try {
      init = await live.ready;
    } catch (error) {
      live.leases -= 1;
      this.#shutdown(live, 'initialize failed');
      throw toAgentError(error, entry.name, classifierFor(live.provider), 'initialize');
    }
    const agent = live;
    let released = false;
    return {
      connection: agent.connection,
      init,
      provider: agent.provider,
      attach: (sessionId, sink) => {
        agent.sessions.set(sessionId, sink);
      },
      detach: (sessionId) => {
        agent.sessions.delete(sessionId);
        if (agent.retiring) this.#armIdle(agent);
      },
      openSession: <T>(sessionId: string) =>
        agent.gone ? undefined : (agent.openSessions.get(sessionId) as T | undefined),
      keepSession: (sessionId, state) => {
        if (!agent.gone) agent.openSessions.set(sessionId, state);
      },
      forgetSession: (sessionId) => {
        agent.openSessions.delete(sessionId);
      },
      release: () => {
        if (released) return;
        released = true;
        agent.leases -= 1;
        this.#armIdle(agent);
      },
    };
  }

  /**
   * A session still open in the entry's current process — kept between runs
   * or attached to a run (`busy`) — without taking a lease (P5: conversation /
   * bot deletion closes or deletes it best effort). Null when no live process
   * has it.
   */
  openSession(agentId: string, sessionId: string): OpenAgentSession | null {
    const live = this.#agents.get(agentId);
    if (live === undefined || live.gone || live.init === null) return null;
    if (!live.openSessions.has(sessionId) && !live.sessions.has(sessionId)) return null;
    return {
      connection: live.connection,
      init: live.init,
      state: live.openSessions.get(sessionId),
      busy: live.sessions.has(sessionId),
    };
  }

  /** Drops a kept session from the process bookkeeping (it was closed / deleted). */
  forgetSession(agentId: string, sessionId: string): void {
    this.#agents.get(agentId)?.openSessions.delete(sessionId);
    for (const live of this.#retiring) {
      if (live.entry.id === agentId) live.openSessions.delete(sessionId);
    }
  }

  /** Whether the entry currently has a live process (tests / diagnostics). */
  isRunning(agentId: string): boolean {
    const live = this.#agents.get(agentId);
    return live !== undefined && !live.gone;
  }

  /**
   * Stops the entry's process when nothing uses it (P4: after login / logout /
   * install / disable the next acquire starts a fresh process with the new
   * state). Returns false while runs or leases still hold it — it then exits
   * through the regular idle path once they are done.
   */
  stop(agentId: string): boolean {
    const live = this.#agents.get(agentId);
    if (live === undefined || live.gone) return true;
    if (live.leases > 0 || live.sessions.size > 0) {
      // Retire: the next acquire starts a fresh process (new login / key);
      // this one keeps serving its runs and closes after the last release.
      live.retiring = true;
      this.#agents.delete(agentId);
      this.#retiring.add(live);
      this.#log.info({ agentId, activeRuns: live.sessions.size }, 'agent process retiring');
      return false;
    }
    this.#shutdown(live, 'stopped');
    return true;
  }

  /** Whether any process of the entry (current or retiring) still serves a lease / run. */
  inUse(agentId: string): boolean {
    const busy = (live: LiveAgent) => !live.gone && (live.leases > 0 || live.sessions.size > 0);
    const current = this.#agents.get(agentId);
    if (current !== undefined && busy(current)) return true;
    return [...this.#retiring].some((live) => live.entry.id === agentId && busy(live));
  }

  /**
   * Latest `_auth/status_update` the agent pushed (P4 state machine input);
   * null until it sent one. Survives process restarts.
   */
  authStatus(agentId: string): (AgentAuthStatus & { at: number }) | null {
    return this.#authStatus.get(agentId) ?? null;
  }

  /** Kills every agent process (core shutdown); active runs are not settled. */
  dispose(): void {
    this.#disposed = true;
    for (const live of [...this.#agents.values(), ...this.#retiring]) {
      this.#shutdown(live, 'core shutdown');
    }
  }

  #start(entry: AgentCatalogEntry): LiveAgent {
    const logger = this.#log;
    const provider = providerFor(entry, this.#deps.providers ?? PROVIDERS);
    if (entry.transport === 'shim' && provider.connect === undefined) {
      // Checked before anything is spawned.
      throw new AppError('AGENT_INCOMPATIBLE', `智能体「${entry.name}」缺少协议垫片`);
    }
    const target = this.#deps.resolveLaunch(entry);
    const launch = provider.launch({
      entry,
      target,
      platform: process.platform,
      ...(this.#deps.dataHome !== undefined ? { dataHome: this.#deps.dataHome } : {}),
      ...(this.#deps.stateDirFor !== undefined
        ? { stateDir: this.#deps.stateDirFor(entry.id) }
        : {}),
      loadUserConfig: this.#deps.loadUserConfigFor?.(entry.id) === true,
    });
    const spawn = this.#deps.spawn ?? spawnAgentProcess;
    let stderrTail = '';
    const logStderrLine = (line: string) => {
      if (line.trim().length === 0) return;
      logger.info(
        { agentId: entry.id, line: this.#deps.redact(line).slice(0, STDERR_LINE_MAX_CHARS) },
        'agent stderr',
      );
    };
    const proc = spawn({
      entry,
      launch: { ...launch, env: buildAgentEnv(process.env, launch.env) },
      cwd: this.#deps.processCwdFor?.(entry.id) ?? this.#deps.processCwd ?? os.tmpdir(),
      onStderr: (text) => {
        const lines = (stderrTail + text).split(/\r?\n/);
        // A newline-less flood must not grow without bound.
        stderrTail = (lines.pop() ?? '').slice(-AGENT_STDERR_TAIL_MAX_CHARS);
        for (const line of lines) logStderrLine(line);
      },
    });

    const live = {
      entry,
      provider,
      process: proc,
      sessions: new Map<string, SessionSink>(),
      openSessions: new Map<string, unknown>(),
      init: null,
      leases: 0,
      idleTimer: null,
      gone: false,
      retiring: false,
    } as Omit<LiveAgent, 'connection' | 'ready'> as LiveAgent;
    const router: AcpSessionRouter = {
      deliver: (notification) => {
        const sink = live.sessions.get(notification.sessionId);
        if (sink === undefined) return false;
        sink.onUpdate(notification.update);
        return true;
      },
      hasRun: (sessionId) => live.sessions.has(sessionId),
      bridgeOf: (sessionId) => live.sessions.get(sessionId)?.bridge ?? null,
      notePermission: (sessionId, title, decision) => {
        live.sessions.get(sessionId)?.onPermission(title, decision);
      },
      requestPermission: (sessionId, request) =>
        live.sessions.get(sessionId)?.requestPermission?.(request) ?? null,
    };
    // shim 型 Provider（无 ACP 的 Agent，如 ZCode）：进程讲私有协议，垫片在
    // 进程内把它翻译为 ACP，宿主照常经 ACP 连接驱动。
    let channel = proc.channel;
    if (entry.transport === 'shim' && provider.connect !== undefined) {
      const shim = createShimChannel((client) => provider.connect!(proc, client));
      channel = shim.channel;
      void proc.exited.then(() => shim.close());
      void shim.closed.then(
        () => proc.kill(),
        () => proc.kill(),
      );
    }
    live.connection = new AcpConnection({
      agentId: entry.id,
      channel,
      provider,
      router,
      appVersion: this.#deps.appVersion,
      logger,
      onAuthStatus: (status) => this.#authStatus.set(entry.id, { ...status, at: Date.now() }),
    });

    let rejectGone!: (error: AppError) => void;
    const gone = new Promise<never>((_, reject) => {
      rejectGone = reject;
    });
    gone.catch(() => undefined);
    const initTimeoutMs = this.#deps.initTimeoutMs ?? AGENT_INIT_TIMEOUT_MS;
    let initTimer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      initTimer = setTimeout(
        () =>
          reject(new AppError('TIMEOUT', `智能体「${entry.name}」启动超时（${initTimeoutMs} ms）`)),
        initTimeoutMs,
      );
      initTimer.unref?.();
    });
    timeout.catch(() => undefined);
    live.ready = Promise.race([live.connection.initialize(), gone, timeout]).finally(() => {
      if (initTimer !== null) clearTimeout(initTimer);
    });
    void live.ready.then(
      (init) => {
        live.init = init;
      },
      () => undefined,
    );
    live.ready.catch(() => undefined);

    const onGone = (exit: AgentExit) => {
      if (live.gone) return;
      live.gone = true;
      if (this.#agents.get(entry.id) === live) this.#agents.delete(entry.id);
      this.#retiring.delete(live);
      if (live.idleTimer !== null) clearTimeout(live.idleTimer);
      logStderrLine(stderrTail);
      stderrTail = '';
      const error =
        exit.error?.code === 'ENOENT' || exit.error?.code === 'EACCES'
          ? new AppError(
              'AGENT_UNAVAILABLE',
              `智能体「${entry.name}」无法启动（${exit.error.code}）：请检查安装`,
            )
          : new AppError(
              'AGENT_PROCESS_EXITED',
              `智能体「${entry.name}」进程已退出${exit.code !== null ? `（退出码 ${exit.code}）` : exit.signal !== null ? `（信号 ${exit.signal}）` : ''}`,
            );
      rejectGone(error);
      const sinks = [...live.sessions.values()];
      live.sessions.clear();
      // Kept sessions die with the process: the next run resumes / loads them
      // (provider permitting) in a fresh process, or starts over.
      live.openSessions.clear();
      // During core shutdown the databases are already closed: leave the runs
      // unsettled (restart recovery marks them interrupted, as for pi runs).
      if (!this.#disposed) for (const sink of sinks) sink.onClosed(error);
      proc.kill();
      logger.info(
        { agentId: entry.id, code: exit.code, signal: exit.signal, activeRuns: sinks.length },
        'agent process gone',
      );
    };
    void proc.exited.then(onGone);
    void live.connection.closed.then(
      () => onGone({ code: null, signal: null }),
      () => onGone({ code: null, signal: null }),
    );

    this.#agents.set(entry.id, live);
    logger.info({ agentId: entry.id, version: entry.version }, 'agent process started');
    return live;
  }

  #armIdle(live: LiveAgent): void {
    if (live.gone || live.leases > 0 || live.sessions.size > 0) return;
    if (live.retiring) {
      this.#shutdown(live, 'retired');
      return;
    }
    if (live.idleTimer !== null) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => {
      live.idleTimer = null;
      if (live.leases === 0 && live.sessions.size === 0) this.#shutdown(live, 'idle');
    }, this.#deps.idleShutdownMs ?? AGENT_IDLE_SHUTDOWN_MS);
    live.idleTimer.unref?.();
  }

  #shutdown(live: LiveAgent, reason: string): void {
    if (live.idleTimer !== null) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    if (this.#agents.get(live.entry.id) === live) this.#agents.delete(live.entry.id);
    this.#retiring.delete(live);
    this.#log.info({ agentId: live.entry.id, reason }, 'agent process shutdown');
    live.process.kill();
  }
}
