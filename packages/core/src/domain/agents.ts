import { mkdirSync } from 'node:fs';
import {
  AGENT_KILL_GRACE_MS,
  AppError,
  agentApiKeySecretName,
  agentEngineKey,
  agentSettingSchema,
  environmentApprovalPayloadSchema,
  findAgentEntry,
  type EnvironmentApprovalPayload,
  type AgentBotRef,
  type AgentCatalogEntry,
  type AgentInstallProgress,
  type AgentLoginState,
  type AgentOptionChoice,
  type AgentOptions,
  type AgentSetting,
  type AgentStatus,
  type AgentSystemCli,
  type AgentTestResult,
  type AgentView,
  type AgentInstallKind,
} from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import type { SettingsService } from './settings.js';
import type { SecretsService } from './secrets.js';
import type { BotsService } from './bots.js';
import {
  buildAgentEnv,
  spawnAgentProcess,
  type AgentHost,
  type AgentSpawner,
} from '../agent/external/host.js';
import { AcpControlSession } from '../agent/external/acp/control-session.js';
import type { AcpSessionConfigOption } from '../agent/external/acp/client.js';
import { agentErrorInfo, classifierFor, toAgentError } from '../agent/external/errors.js';
import { agentConcurrency, PROVIDERS, providerFor } from '../agent/external/providers/index.js';
import { agentBackgroundBlocker } from '../agent/llm-router.js';
import type { AgentInstaller, AgentInvocation } from '../agent/external/installer.js';
import {
  describeAuthMethods,
  terminalLoginCommand,
  type AgentLoginMethod,
} from '../agent/external/terminal-auth.js';
import type {
  AgentProcess,
  AgentProvider,
  LaunchTarget,
  ProviderRegistry,
} from '../agent/external/types.js';

/**
 * 外部智能体服务（docs/design/28-external-agents-acp.md §2.2 / §3 / §9.1，
 * D72 P4）：目录（经发行门禁过滤）+ 本机状态合成视图、启用（安装）/ 停用 /
 * 卸载、测试连接、登录 / 退出、模型与推理强度选项（缓存）。
 *
 * 不变量：
 * - **不读取任何 Agent 的凭据文件**——登录态只来自 Agent 自己的反馈（ACP
 *   `auth_required` 错误、`_auth/status_update` 通知、登录命令退出码）；
 *   API key 类的 key 只进 secrets（`agent:{id}:api-key`），启动时按目录
 *   `auth.apiKeyEnv` 注入环境变量；
 * - 安装、登录在后台进行（RPC 超时 60 s），进度 / 输出经 `agent.status` 推送；
 * - 登录 / 退出 / 安装 / 停用后让 AgentHost 重启该 Agent 的空闲进程，使新
 *   状态生效（有 run 在跑时等它结束后按空闲退出）。
 */

/** 测试连接发给 Agent 的一句话。 */
const PING_PROMPT = 'This is a connectivity check from KepCup. Reply with the single word: pong';
const TEST_TIMEOUT_MS = 45_000;
const PROBE_TIMEOUT_MS = 45_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_OUTPUT_MAX_CHARS = 8_000;
const REPLY_MAX_CHARS = 500;
const SYSTEM_DETECT_TTL_MS = 30_000;

type AuthState = 'ok' | 'required' | 'unknown';

/** 状态合成的输入（纯数据，便于单测）。 */
export interface AgentStatusInput {
  /** 当前来源在本平台是否可用（`none` = 无可用分发）。 */
  kind: AgentInstallKind;
  enabled: boolean;
  installing: boolean;
  error: string | null;
  source: 'managed' | 'system';
  /** managed 来源当前可用的已安装版本；null = 未安装。 */
  installedVersion: string | null;
  catalogVersion: string;
  /** system 来源的探测结论；null = 尚未探测。 */
  systemCompatible: boolean | null;
  systemDetail: string | null;
  auth: AuthState;
  /** `auth.kinds` 含 `anonymous`：未登录也可用。 */
  anonymous: boolean;
}

/**
 * 状态机（§2.2）：installing > incompatible（本平台无分发）> error（未启用时
 * 也展示最近的失败）> available（未启用）> incompatible（系统 CLI 版本不在
 * 范围）> error（已启用但未安装 / 安装损坏）> needs_auth > update_available
 * > ready。
 */
export function synthesizeAgentStatus(input: AgentStatusInput): {
  status: AgentStatus;
  detail: string | null;
} {
  if (input.installing) return { status: 'installing', detail: null };
  if (input.kind === 'none') {
    return { status: 'incompatible', detail: '本平台暂无可用的安装方式' };
  }
  if (input.error !== null && !input.enabled) return { status: 'error', detail: input.error };
  if (!input.enabled) return { status: 'available', detail: null };
  if (input.error !== null) return { status: 'error', detail: input.error };
  if (input.source === 'system' && input.systemCompatible === false) {
    return { status: 'incompatible', detail: input.systemDetail };
  }
  if (input.source === 'managed' && input.installedVersion === null) {
    return { status: 'error', detail: '未安装或安装已损坏：请重新启用' };
  }
  if (input.auth === 'required' && !input.anonymous) return { status: 'needs_auth', detail: null };
  if (input.source === 'managed' && input.installedVersion !== input.catalogVersion) {
    return { status: 'update_available', detail: null };
  }
  return { status: 'ready', detail: null };
}

/** `session/new` 的 config options → 模型 / 推理强度选项。 */
export function agentOptionsFrom(
  configOptions: readonly AcpSessionConfigOption[] | null | undefined,
  fetchedAt: number,
): AgentOptions {
  const choices = (category: string): AgentOptionChoice[] => {
    const option = (configOptions ?? []).find((candidate) => candidate.category === category);
    if (option === undefined || option.type !== 'select') return [];
    const flat = option.options.flatMap((item) =>
      'group' in item ? item.options : [item],
    ) as Array<{ value: string; name: string; description?: string | null }>;
    return flat.map((item) => ({
      value: item.value,
      name: item.name,
      description: item.description ?? '',
    }));
  };
  return { models: choices('model'), efforts: choices('thought_level'), fetchedAt, error: null };
}

/** 登录子进程（可注入：测试不起真实进程）。 */
export type LoginRunner = (input: {
  entry: AgentCatalogEntry;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  onOutput(text: string): void;
}) => { exited: Promise<number | null>; write(line: string): void; kill(): void };

/**
 * 生产实现：复用 Agent 进程的 spawner——POSIX 下子进程自成进程组，kill 发给
 * 整组（浏览器授权助手等孙进程一并结束），SIGTERM 在 AGENT_KILL_GRACE_MS 后
 * 升级为 SIGKILL；Windows 用 `taskkill /T /F`。stdout / stderr 都回传。
 */
export const defaultLoginRunner: LoginRunner = ({ entry, command, args, env, cwd, onOutput }) => {
  const proc = spawnAgentProcess({
    entry,
    launch: { command, args, env },
    cwd,
    onStderr: onOutput,
  });
  void (async () => {
    const reader = proc.channel.readable.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onOutput(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Stream torn down with the process.
    }
  })();
  const writer = proc.channel.writable.getWriter();
  const encoder = new TextEncoder();
  return {
    exited: proc.exited.then((exit) => (exit.error !== undefined ? 127 : exit.code)),
    write: (line) => {
      void writer.write(encoder.encode(`${line}\n`)).catch(() => undefined);
    },
    kill: () => proc.kill(),
  };
};

export interface AgentsServiceDeps {
  settings: SettingsService;
  secrets: SecretsService;
  bots: BotsService;
  host: AgentHost;
  installer: AgentInstaller;
  catalog(): readonly AgentCatalogEntry[];
  logger: CoreLogger;
  publish(event: 'agent.status', payload: { agent: AgentView }): void;
  appVersion: string;
  /** 探测 / 测试 / 登录子进程的中性工作目录（应用缓存内的空目录）。 */
  workDir: string;
  /** 应用数据目录与每个 Agent 的私有状态目录（与 AgentHost 相同，P5）。 */
  dataHome?: string;
  stateDirFor?(agentId: string): string;
  /** Per-agent private process cwd (审查 M1), shared with AgentHost. */
  processCwdFor?(agentId: string): string;
  providers?: ProviderRegistry;
  /** Same spawner as the AgentHost (tests: in-process fake agents). */
  spawn?: AgentSpawner;
  /**
   * 测试缝（core `agentLaunch`）：返回非 null 即视为已安装、按该方式启动。
   */
  launchOverride?: (entry: AgentCatalogEntry) => LaunchTarget | null;
  runLogin?: LoginRunner;
  /** providerConcurrency 改动后让调度器生效（start.ts 装配）。 */
  onConcurrencyChanged?(): void;
  timeouts?: { testMs?: number; probeMs?: number; loginMs?: number; forceSettleMs?: number };
  now?: () => number;
}

interface LoginSession extends AgentLoginState {
  kill?: () => void;
  write?: (line: string) => void;
  /** Settles the session exactly once (exit, forced timeout or dispose). */
  finish?: (code: number | null) => void;
}

interface InstallJob {
  controller: AbortController;
  /** Set by disable / uninstall / dispose: the result is discarded. */
  cancelled: boolean;
}

/** 取消 / 超时后最多等这么久，进程仍未退出也强制结束登录会话。 */
const LOGIN_FORCE_SETTLE_MS = AGENT_KILL_GRACE_MS + 2_000;
/** 登录输出没有换行时，空闲这么久后把残行（整行脱敏后）显示出来。 */
const LOGIN_TAIL_FLUSH_MS = 1_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppError('TIMEOUT', message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function withoutTimestamp(cli: AgentSystemCli & { at: number }): AgentSystemCli {
  const { at: _at, ...rest } = cli;
  return rest;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentsService {
  readonly #deps: AgentsServiceDeps;
  readonly #installing = new Map<string, AgentInstallProgress>();
  readonly #errors = new Map<string, string>();
  readonly #auth = new Map<string, AuthState>();
  /** When `noteRunError` marked an agent logged out (vs. the host's pushes). */
  readonly #authNotedAt = new Map<string, number>();
  readonly #methods = new Map<string, AgentLoginMethod[]>();
  readonly #logins = new Map<string, LoginSession>();
  readonly #options = new Map<string, AgentOptions>();
  readonly #systemCli = new Map<string, AgentSystemCli & { at: number }>();
  readonly #publishTimers = new Map<string, NodeJS.Timeout>();
  readonly #installJobs = new Map<string, InstallJob>();
  readonly #probes = new Map<string, Promise<void>>();
  /** Live control processes (probe / authenticate / logout), killed on dispose. */
  readonly #controls = new Set<AgentProcess>();
  #disposed = false;

  constructor(deps: AgentsServiceDeps) {
    this.#deps = deps;
  }

  get #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  get #providers(): ProviderRegistry {
    return this.#deps.providers ?? PROVIDERS;
  }

  // --- catalog / views -------------------------------------------------------

  catalog(): readonly AgentCatalogEntry[] {
    return this.#deps.catalog();
  }

  #entry(agentId: string): AgentCatalogEntry {
    const entry = findAgentEntry(this.#deps.catalog(), agentId);
    if (entry === null) throw new AppError('NOT_FOUND', `智能体「${agentId}」不在目录中`);
    return entry;
  }

  #requireExperimental(): void {
    if (!this.#deps.settings.get().experimental.externalAgents) {
      throw new AppError(
        'INVALID_INPUT',
        '外部智能体是实验功能：请先在设置中开启「外部智能体（实验）」',
      );
    }
  }

  #setting(agentId: string): AgentSetting | null {
    return this.#deps.settings.get().agents[agentId] ?? null;
  }

  #saveSetting(agentId: string, patch: Partial<AgentSetting> | null): void {
    const agents = { ...this.#deps.settings.get().agents };
    if (patch === null) {
      delete agents[agentId];
    } else {
      agents[agentId] = agentSettingSchema.parse({ ...(agents[agentId] ?? {}), ...patch });
    }
    this.#deps.settings.update({ agents });
  }

  /** 生效来源：没有本平台 managed 分发而有 system 分发时只能是 system。 */
  #source(entry: AgentCatalogEntry, setting: AgentSetting | null): 'managed' | 'system' {
    const managed = this.#deps.installer.managedKind(entry);
    const system = entry.distribution.system !== undefined;
    if (managed === null && system) return 'system';
    if (!system) return 'managed';
    return setting?.source ?? 'managed';
  }

  #hasApiKey(entry: AgentCatalogEntry): boolean {
    return (
      entry.auth.apiKeyEnv !== undefined &&
      this.#deps.secrets.hasValue(agentApiKeySecretName(entry.id))
    );
  }

  #authState(entry: AgentCatalogEntry): AuthState {
    if (entry.auth.kinds.length === 0) return 'ok';
    const apiKeyOnly = entry.auth.kinds.every((kind) => kind === 'api-key');
    if (apiKeyOnly && entry.auth.apiKeyEnv !== undefined && !this.#hasApiKey(entry)) {
      return 'required';
    }
    const own = this.#auth.get(entry.id);
    const pushed = this.#deps.host.authStatus(entry.id);
    // A later `_auth/status_update` that is not `none` supersedes a logout
    // noted from a run failure (the agent knows it logged in since).
    const noted = this.#authNotedAt.get(entry.id);
    if (
      own === 'required' &&
      noted !== undefined &&
      pushed !== null &&
      pushed.kind !== 'none' &&
      pushed.at > noted
    ) {
      this.#auth.delete(entry.id);
      this.#authNotedAt.delete(entry.id);
      return 'ok';
    }
    if (own !== undefined && own !== 'unknown') return own;
    if (pushed !== null) return pushed.kind === 'none' ? 'required' : 'ok';
    return apiKeyOnly && this.#hasApiKey(entry) ? 'ok' : 'unknown';
  }

  /** managed 来源当前可用的已安装版本（设置记录的版本优先，其次目录版本）。 */
  #installedVersion(entry: AgentCatalogEntry, setting: AgentSetting | null): string | null {
    if (this.#deps.launchOverride?.(entry)) return entry.version;
    const installer = this.#deps.installer;
    for (const version of [setting?.installedVersion, entry.version]) {
      if (version !== undefined && installer.installed(entry.id, version) !== null) return version;
    }
    return null;
  }

  #usedBy(agentId: string): AgentBotRef[] {
    return this.#deps.bots
      .listActive()
      .filter((bot) => bot.profile.runtime.agent.id === agentId)
      .map((bot) => ({ id: bot.id, name: bot.profile.identity.name || bot.id }));
  }

  view(agentId: string): AgentView {
    const entry = this.#entry(agentId);
    const settings = this.#deps.settings.get();
    const setting = settings.agents[agentId] ?? null;
    const source = this.#source(entry, setting);
    const installer = this.#deps.installer;
    // `#source` only yields 'system' when the entry has a system distribution.
    const kind: AgentInstallKind =
      this.#deps.launchOverride?.(entry) || source === 'system'
        ? 'system'
        : (installer.managedKind(entry) ?? 'none');
    const installedVersion = source === 'managed' ? this.#installedVersion(entry, setting) : null;
    const overridden = Boolean(this.#deps.launchOverride?.(entry));
    const systemCli = overridden ? null : (this.#systemCli.get(agentId) ?? null);
    const auth = this.#authState(entry);
    const { status, detail } = synthesizeAgentStatus({
      kind,
      enabled: setting?.enabled === true,
      installing: this.#installing.has(agentId),
      error: this.#errors.get(agentId) ?? null,
      source,
      installedVersion,
      catalogVersion: entry.version,
      systemCompatible: systemCli === null ? null : systemCli.compatible,
      systemDetail:
        systemCli === null
          ? null
          : !systemCli.found
            ? `未在系统中找到 ${entry.distribution.system?.cmd ?? ''}`
            : `系统 CLI 版本 ${systemCli.version ?? '未知'} 不在兼容范围 ${systemCli.versionRange ?? ''}`,
      auth,
      anonymous: entry.auth.kinds.includes('anonymous'),
    });
    const login = this.#logins.get(agentId);
    const installKind = installer.kindFor(entry);
    return {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      description: entry.description,
      license: entry.license,
      icon: entry.icon,
      tier: entry.tier,
      website: entry.website ?? null,
      repository: entry.repository ?? null,
      authKinds: [...entry.auth.kinds],
      authNote: entry.auth.note,
      apiKeyEnv: entry.auth.apiKeyEnv ?? null,
      termsNoticeKey: entry.terms?.noticeKey ?? null,
      nativeCapabilities: Object.fromEntries(
        Object.entries(entry.nativeCapabilities).map(([key, tools]) => [key, [...(tools ?? [])]]),
      ),
      status,
      statusDetail: detail,
      enabled: setting?.enabled === true,
      installedVersion: setting?.installedVersion ?? installedVersion,
      source,
      loadUserConfig: setting?.loadUserConfig === true,
      // Effective limit (the scheduler's): 1 for agents without parallel sessions.
      concurrency: agentConcurrency(
        settings.providerConcurrency,
        entry,
        this.#deps.providers ?? PROVIDERS,
      ),
      hasApiKey: this.#hasApiKey(entry),
      install: {
        item: agentEngineKey(entry.id),
        kind: installKind,
        version: entry.version,
        sizeBytes: entry.sizeBytes ?? 0,
        source: installer.sourceText(entry),
        license: entry.license,
        termsNoticeKey: entry.terms?.noticeKey ?? null,
        prerequisites: installKind === 'npx' ? ['node'] : [],
      },
      progress: this.#installing.get(agentId) ?? null,
      systemCli: systemCli === null ? null : withoutTimestamp(systemCli),
      authMethods: (this.#methods.get(agentId) ?? []).map((method) => ({
        id: method.id,
        name: method.name,
        description: method.description,
        type: method.type,
      })),
      login:
        login === undefined
          ? null
          : {
              methodId: login.methodId,
              running: login.running,
              output: login.output,
              exitCode: login.exitCode,
              error: login.error,
            },
      usedBy: this.#usedBy(agentId),
      probing: this.#probes.has(agentId),
      backgroundBlocker: agentBackgroundBlocker(settings, entry, this.#deps.providers ?? PROVIDERS),
    };
  }

  /**
   * 环境管理器审批卡载荷（`environment` 审批、条目 `agent:{id}`）：体积、
   * 来源、许可、条款提示。设置页的安装确认卡展示同样的信息（`view().install`）；
   * 对话内设置卡（D58，P4 后续）发起安装时用它提交审批。
   */
  approvalPayload(agentId: string, reason: string): EnvironmentApprovalPayload {
    const view = this.view(agentId);
    return environmentApprovalPayloadSchema.parse({
      item: view.install.item,
      version: view.version,
      reason,
      displayName: view.name,
      sizeBytes: view.install.sizeBytes,
      source: view.install.source,
      obtain:
        view.install.kind === 'npx' ? 'npm' : view.install.kind === 'system' ? 'system' : 'archive',
      license: view.license,
      termsNoticeKey: view.termsNoticeKey ?? '',
    });
  }

  async list(): Promise<{ experimental: boolean; agents: AgentView[] }> {
    const experimental = this.#deps.settings.get().experimental.externalAgents;
    if (!experimental) return { experimental, agents: [] };
    const entries = this.#deps.catalog();
    await Promise.all(entries.map((entry) => this.#refreshSystemCli(entry, false)));
    return { experimental, agents: entries.map((entry) => this.view(entry.id)) };
  }

  async #refreshSystemCli(
    entry: AgentCatalogEntry,
    force: boolean,
  ): Promise<AgentSystemCli | null> {
    if (entry.distribution.system === undefined || this.#deps.launchOverride?.(entry)) return null;
    const cached = this.#systemCli.get(entry.id);
    if (!force && cached !== undefined && this.#now - cached.at < SYSTEM_DETECT_TTL_MS) {
      return cached;
    }
    try {
      const detected = await this.#deps.installer.detectSystem(entry);
      if (detected === null) return null;
      this.#systemCli.set(entry.id, { ...detected, at: this.#now });
      return detected;
    } catch (error) {
      this.#deps.logger.warn(
        { agentId: entry.id, error: errorMessage(error) },
        'agent system cli detection failed',
      );
      return null;
    }
  }

  #publish(agentId: string): void {
    if (this.#disposed) return;
    try {
      this.#deps.publish('agent.status', { agent: this.view(agentId) });
    } catch (error) {
      this.#deps.logger.warn(
        { agentId, error: errorMessage(error) },
        'agent status publish failed',
      );
    }
  }

  /** Coalesces bursts (download progress, login output) to ≤ 1 event / 250 ms. */
  #publishSoon(agentId: string): void {
    if (this.#publishTimers.has(agentId)) return;
    const timer = setTimeout(() => {
      this.#publishTimers.delete(agentId);
      this.#publish(agentId);
    }, 250);
    timer.unref?.();
    this.#publishTimers.set(agentId, timer);
  }

  // --- launch ---------------------------------------------------------------------

  /** 可执行调用（不含 API key）；未安装 / 未找到抛 AGENT_UNAVAILABLE。 */
  #invocation(entry: AgentCatalogEntry): AgentInvocation {
    const override = this.#deps.launchOverride?.(entry);
    if (override)
      return { command: override.command, prefixArgs: [], args: override.args, env: override.env };
    const setting = this.#setting(entry.id);
    const installer = this.#deps.installer;
    if (this.#source(entry, setting) === 'system') {
      const invocation = installer.systemInvocation(entry);
      if (invocation !== null) return invocation;
      throw new AppError(
        'AGENT_UNAVAILABLE',
        `智能体「${entry.name}」未在系统中找到 ${entry.distribution.system?.cmd ?? ''}：请先安装其官方 CLI，或改用应用内安装`,
      );
    }
    const version = this.#installedVersion(entry, setting);
    const installed = version === null ? null : installer.installed(entry.id, version);
    if (installed === null) {
      throw new AppError(
        'AGENT_UNAVAILABLE',
        `智能体「${entry.name}」未安装：请在设置的「智能体」中启用`,
      );
    }
    return installer.invocation(installed);
  }

  #apiKeyEnv(entry: AgentCatalogEntry): Record<string, string> {
    const name = entry.auth.apiKeyEnv;
    if (name === undefined) return {};
    const value = this.#deps.secrets.getValue(agentApiKeySecretName(entry.id));
    return value === null ? {} : { [name]: value };
  }

  /**
   * AgentHost 的启动解析（start.ts 装配）：已安装可执行入口 + 目录参数，
   * 外加 API key 环境变量（按目录 `auth.apiKeyEnv`）。
   */
  resolveLaunch(entry: AgentCatalogEntry): LaunchTarget {
    const invocation = this.#invocation(entry);
    return {
      command: invocation.command,
      args: [...invocation.prefixArgs, ...invocation.args],
      env: { ...invocation.env, ...this.#apiKeyEnv(entry) },
    };
  }

  /** A short-lived agent process for control traffic (probe / authenticate / logout). */
  #spawnControl(entry: AgentCatalogEntry): AgentProcess {
    const provider = providerFor(entry, this.#providers);
    const target = this.resolveLaunch(entry);
    const launch = provider.launch({
      entry,
      target,
      platform: process.platform,
      ...(this.#deps.dataHome !== undefined ? { dataHome: this.#deps.dataHome } : {}),
      ...(this.#deps.stateDirFor !== undefined
        ? { stateDir: this.#deps.stateDirFor(entry.id) }
        : {}),
      loadUserConfig: this.#deps.settings.get().agents[entry.id]?.loadUserConfig === true,
    });
    const spawn = this.#deps.spawn ?? spawnAgentProcess;
    // Same private cwd as the run processes (审查 M1).
    let cwd = this.#deps.processCwdFor?.(entry.id);
    if (cwd === undefined) {
      mkdirSync(this.#deps.workDir, { recursive: true });
      cwd = this.#deps.workDir;
    }
    return spawn({
      entry,
      launch: { ...launch, env: buildAgentEnv(process.env, launch.env) },
      cwd,
      onStderr: (text) =>
        this.#deps.logger.debug(
          { agentId: entry.id, line: this.#deps.secrets.redact(text).slice(0, 500) },
          'agent control stderr',
        ),
    });
  }

  async #withControl<T>(
    entry: AgentCatalogEntry,
    timeoutMs: number,
    body: (session: AcpControlSession, pushed: { kind: string | null }) => Promise<T>,
    onProcess?: (proc: AgentProcess) => void,
  ): Promise<T> {
    if (this.#disposed) throw new AppError('AGENT_UNAVAILABLE', '核心服务正在关闭');
    const proc = this.#spawnControl(entry);
    this.#controls.add(proc);
    onProcess?.(proc);
    const pushed: { kind: string | null } = { kind: null };
    const session = new AcpControlSession({
      channel: proc.channel,
      appVersion: this.#deps.appVersion,
      onAuthStatus: (kind) => {
        pushed.kind = kind;
      },
    });
    const gone = proc.exited.then((exit) => {
      throw new AppError(
        exit.error?.code === 'ENOENT' ? 'AGENT_UNAVAILABLE' : 'AGENT_PROCESS_EXITED',
        `智能体「${entry.name}」进程已退出${exit.error ? `（${exit.error.message}）` : ''}`,
      );
    });
    gone.catch(() => undefined);
    try {
      return await withTimeout(
        Promise.race([body(session, pushed), gone]),
        timeoutMs,
        `智能体「${entry.name}」响应超时（${Math.round(timeoutMs / 1000)} 秒）`,
      );
    } finally {
      this.#controls.delete(proc);
      proc.kill();
    }
  }

  /**
   * 探测 / 测试会话的 `_meta`（经 Provider，与 run 同样不加载 Agent 侧配置、
   * 只读档、不注入能力）。
   */
  #probeSessionMeta(
    entry: AgentCatalogEntry,
    provider: AgentProvider,
  ): Record<string, unknown> | undefined {
    return provider.sessionNew({
      entry,
      cwd: this.#deps.workDir,
      permission: 'read_only',
      capabilities: [],
      sessionPrompt: null,
      maxTurns: 1,
      loadUserConfig: this.#setting(entry.id)?.loadUserConfig === true,
    })._meta;
  }

  /**
   * 探测：initialize（拿登录方式）+ 一次 `session/new`（判定登录态、读取
   * 模型 / 推理强度选项）。不发 prompt。
   */
  async #probe(entry: AgentCatalogEntry): Promise<void> {
    const provider = providerFor(entry, this.#providers);
    await this.#withControl(
      entry,
      this.#deps.timeouts?.probeMs ?? PROBE_TIMEOUT_MS,
      async (session, pushed) => {
        const init = await session.initialize();
        const advertised = init.authMethods ?? [];
        this.#methods.set(
          entry.id,
          describeAuthMethods(provider.authMethods ? provider.authMethods(advertised) : advertised),
        );
        try {
          const meta = this.#probeSessionMeta(entry, provider);
          const created = await session.newSession(this.#deps.workDir, meta);
          this.#options.set(entry.id, agentOptionsFrom(created.configOptions, this.#now));
          try {
            await session.closeSession(created.sessionId);
          } catch {
            // Optional capability; the process is killed right after anyway.
          }
          // Claude answers session/new while logged out and pushes kind 'none'.
          await new Promise((resolve) => setTimeout(resolve, 50));
          this.#auth.set(entry.id, pushed.kind === 'none' ? 'required' : 'ok');
          this.#authNotedAt.delete(entry.id);
        } catch (error) {
          const kind = classifierFor(provider)(agentErrorInfo(error), 'session_new');
          if (kind !== 'auth_required')
            throw toAgentError(error, entry.name, classifierFor(provider), 'session_new');
          this.#auth.set(entry.id, 'required');
          this.#authNotedAt.delete(entry.id);
        }
      },
    );
  }

  /** 同一 Agent 的并发探测复用进行中的那一次。 */
  #probeQuietly(entry: AgentCatalogEntry): Promise<void> {
    const running = this.#probes.get(entry.id);
    if (running !== undefined) return running;
    const probe = this.#probeOnce(entry).finally(() => {
      if (this.#probes.get(entry.id) === probe) this.#probes.delete(entry.id);
    });
    this.#probes.set(entry.id, probe);
    return probe;
  }

  async #probeOnce(entry: AgentCatalogEntry): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#probe(entry);
    } catch (error) {
      if (this.#disposed) return;
      this.#deps.logger.info(
        { agentId: entry.id, error: errorMessage(error) },
        'agent probe failed',
      );
      const options = this.#options.get(entry.id);
      this.#options.set(entry.id, {
        models: options?.models ?? [],
        efforts: options?.efforts ?? [],
        fetchedAt: options?.fetchedAt ?? null,
        error: errorMessage(error),
      });
    }
  }

  // --- enable / disable / uninstall --------------------------------------------------

  async enable(agentId: string, source?: 'managed' | 'system'): Promise<AgentView> {
    this.#requireExperimental();
    const entry = this.#entry(agentId);
    // Concurrent enables share the one install in flight.
    if (this.#installJobs.has(agentId)) return this.view(agentId);
    const setting = this.#setting(agentId);
    const wanted = this.#source(entry, {
      ...(setting ?? agentSettingSchema.parse({})),
      ...(source !== undefined ? { source } : {}),
    });
    this.#errors.delete(agentId);

    if (wanted === 'system' && !this.#deps.launchOverride?.(entry)) {
      const detected = await this.#refreshSystemCli(entry, true);
      if (detected === null || !detected.found) {
        throw new AppError(
          'AGENT_UNAVAILABLE',
          `未在系统中找到 ${entry.distribution.system?.cmd ?? entry.name}：请先安装其官方 CLI，或改用应用内安装`,
        );
      }
      if (!detected.compatible) {
        throw new AppError(
          'AGENT_INCOMPATIBLE',
          `系统中的 ${entry.distribution.system?.cmd} 版本 ${detected.version ?? '未知'} 不在兼容范围 ${detected.versionRange ?? ''}`,
        );
      }
      this.#saveSetting(agentId, { enabled: true, source: 'system', installedVersion: undefined });
      this.#afterChange(entry);
      return this.view(agentId);
    }

    if (
      this.#deps.launchOverride?.(entry) ||
      this.#deps.installer.installed(agentId, entry.version) !== null
    ) {
      this.#saveSetting(agentId, {
        enabled: true,
        source: wanted,
        installedVersion: entry.version,
      });
      this.#afterChange(entry);
      return this.view(agentId);
    }
    if (this.#deps.installer.managedKind(entry) === null) {
      throw new AppError('AGENT_INCOMPATIBLE', `智能体「${entry.name}」没有适用于本平台的安装包`);
    }
    const job: InstallJob = { controller: new AbortController(), cancelled: false };
    this.#installJobs.set(agentId, job);
    this.#installing.set(agentId, { stage: 'preparing' });
    void this.#install(entry, job);
    return this.view(agentId);
  }

  async #install(entry: AgentCatalogEntry, job: InstallJob): Promise<void> {
    this.#publish(entry.id);
    let failed = false;
    try {
      await this.#deps.installer.install(entry, {
        signal: job.controller.signal,
        onProgress: (progress) => {
          if (job.cancelled) return;
          this.#installing.set(entry.id, progress);
          this.#publishSoon(entry.id);
        },
      });
      // Older versions stay on disk (a running process may still use one);
      // uninstall removes every version. A disable / dispose that arrived
      // meanwhile wins: the finished install must not re-enable the agent.
      if (!job.cancelled && !this.#disposed) {
        this.#saveSetting(entry.id, {
          enabled: true,
          source: 'managed',
          installedVersion: entry.version,
        });
        this.#deps.logger.info({ agentId: entry.id, version: entry.version }, 'agent installed');
      }
    } catch (error) {
      failed = true;
      if (!job.cancelled && !this.#disposed) {
        this.#errors.set(entry.id, errorMessage(error));
        this.#deps.logger.warn(
          { agentId: entry.id, error: errorMessage(error) },
          'agent install failed',
        );
      }
    } finally {
      // A cancelled job was already removed (and a newer one may run now).
      if (this.#installJobs.get(entry.id) === job) {
        this.#installJobs.delete(entry.id);
        this.#installing.delete(entry.id);
      }
    }
    if (this.#disposed) return;
    if (failed || job.cancelled) {
      this.#publish(entry.id);
      return;
    }
    this.#afterChange(entry);
  }

  /** Cancels an install in flight (its result is discarded). */
  #cancelInstall(agentId: string): void {
    const job = this.#installJobs.get(agentId);
    if (job === undefined) return;
    job.cancelled = true;
    job.controller.abort(new Error('安装已取消'));
    this.#installJobs.delete(agentId);
    this.#installing.delete(agentId);
  }

  /**
   * Restart the idle process and re-probe in the background. The probe is
   * registered before the first publish, so the view carries `probing: true`
   * (the in-chat setup card does not treat a not-yet-probed `ready` as usable:
   * the login state is still unknown right after an install / login).
   */
  #afterChange(entry: AgentCatalogEntry): void {
    if (this.#disposed) return;
    this.#deps.host.stop(entry.id);
    const probe = this.#probeQuietly(entry);
    this.#publish(entry.id);
    void probe.then(() => this.#publish(entry.id));
  }

  async #affecting(
    agentId: string,
    confirm: boolean | undefined,
    apply: (entry: AgentCatalogEntry) => void,
  ): Promise<{ agent: AgentView; affectedBots: AgentBotRef[]; applied: boolean }> {
    const entry = this.#entry(agentId);
    const affectedBots = this.#usedBy(agentId);
    if (affectedBots.length > 0 && confirm !== true) {
      return { agent: this.view(agentId), affectedBots, applied: false };
    }
    apply(entry);
    this.#deps.host.stop(agentId);
    this.#publish(agentId);
    return { agent: this.view(agentId), affectedBots, applied: true };
  }

  /**
   * 停用：保留安装，Bot 不可选；有 Bot 在用时须确认（受影响的 Bot 走对话内
   * 设置卡）。安装进行中则取消安装。不要求实验开关：关闭实验功能后仍可清理。
   */
  disable(agentId: string, confirm?: boolean) {
    return this.#affecting(agentId, confirm, () => {
      this.#cancelInstall(agentId);
      this.#errors.delete(agentId);
      if (this.#setting(agentId) !== null) this.#saveSetting(agentId, { enabled: false });
    });
  }

  /**
   * 卸载：删除全部版本、API key 与本机记录。该 Agent 的进程仍在服务 run 时
   * 拒绝（删除正被执行的文件在 Windows 上会半删）；安装中则先取消安装。不
   * 要求实验开关（同停用）。
   */
  uninstall(agentId: string, confirm?: boolean) {
    return this.#affecting(agentId, confirm, (entry) => {
      if (this.#deps.host.inUse(agentId)) {
        throw new AppError('INVALID_INPUT', '该智能体正在执行任务，请等任务结束后再卸载');
      }
      this.#cancelInstall(agentId);
      this.#cancelLogin(agentId);
      this.#deps.host.stop(agentId);
      this.#deps.installer.uninstall(agentId);
      if (this.#deps.secrets.hasValue(agentApiKeySecretName(agentId))) {
        this.#deps.secrets.removeValue(agentApiKeySecretName(agentId));
      }
      this.#saveSetting(agentId, null);
      for (const cache of [this.#errors, this.#auth, this.#methods, this.#logins, this.#options]) {
        cache.delete(agentId);
      }
      this.#deps.logger.info({ agentId, name: entry.name }, 'agent uninstalled');
    });
  }

  /** 高级设置（逐 Agent 合并写入，不经渲染端整表回写 settings.agents）。 */
  configure(input: {
    id: string;
    loadUserConfig?: boolean | undefined;
    concurrency?: number | undefined;
  }): AgentView {
    this.#requireExperimental();
    const entry = this.#entry(input.id);
    if (input.loadUserConfig !== undefined) {
      this.#saveSetting(entry.id, { loadUserConfig: input.loadUserConfig });
      // The process-level config of a running agent depends on it.
      this.#deps.host.stop(entry.id);
    }
    if (input.concurrency !== undefined) {
      const current = this.#deps.settings.get().providerConcurrency;
      this.#deps.settings.update({
        providerConcurrency: { ...current, [agentEngineKey(entry.id)]: input.concurrency },
      });
      this.#deps.onConcurrencyChanged?.();
    }
    this.#publish(entry.id);
    return this.view(entry.id);
  }

  // --- login / logout -----------------------------------------------------------------

  async login(input: {
    id: string;
    methodId?: string | undefined;
    apiKey?: string | undefined;
    input?: string | undefined;
  }): Promise<AgentView> {
    this.#requireExperimental();
    const entry = this.#entry(input.id);
    const running = this.#logins.get(entry.id);

    if (input.input !== undefined) {
      if (running?.running !== true || running.write === undefined) {
        throw new AppError('INVALID_INPUT', '没有进行中的登录');
      }
      running.write(input.input);
      return this.view(entry.id);
    }

    if (input.apiKey !== undefined) {
      if (entry.auth.apiKeyEnv === undefined) {
        throw new AppError('INVALID_INPUT', `智能体「${entry.name}」不经 KepCup 配置 API key`);
      }
      const key = input.apiKey.trim();
      if (key.length === 0) throw new AppError('INVALID_INPUT', 'API key 不能为空');
      this.#deps.secrets.setValue(agentApiKeySecretName(entry.id), key);
      // An api-key-only agent is usable once the key is stored; others keep
      // their state until the next probe / run tells. The old process (old
      // key in its environment) retires after its current runs.
      this.#auth.delete(entry.id);
      this.#afterChange(entry);
      return this.view(entry.id);
    }

    if (running?.running === true) throw new AppError('INVALID_INPUT', '正在登录，请先完成或取消');
    if (input.methodId === undefined) {
      // No method chosen yet: discover the methods the agent advertises.
      await this.#probeQuietly(entry);
      return this.view(entry.id);
    }
    if (!this.#methods.has(entry.id)) await this.#probeQuietly(entry);
    const method = (this.#methods.get(entry.id) ?? []).find((item) => item.id === input.methodId);
    if (method === undefined) {
      throw new AppError(
        'INVALID_INPUT',
        `智能体「${entry.name}」没有登录方式「${input.methodId}」`,
      );
    }
    const session: LoginSession = {
      methodId: method.id,
      running: true,
      output: '',
      exitCode: null,
      error: null,
    };
    this.#logins.set(entry.id, session);
    if (method.type === 'terminal') this.#runTerminalLogin(entry, method, session);
    else void this.#runAgentLogin(entry, method, session);
    return this.view(entry.id);
  }

  #runTerminalLogin(
    entry: AgentCatalogEntry,
    method: AgentLoginMethod,
    session: LoginSession,
  ): void {
    let command: { command: string; args: string[]; env: Record<string, string> };
    try {
      command = terminalLoginCommand(this.#invocation(entry), method);
    } catch (error) {
      session.running = false;
      session.error = errorMessage(error);
      this.#publish(entry.id);
      return;
    }
    mkdirSync(this.#deps.workDir, { recursive: true });
    const env = buildAgentEnv(process.env, { ...command.env, ...this.#apiKeyEnv(entry) });
    this.#deps.logger.info(
      { agentId: entry.id, methodId: method.id },
      'agent terminal login started',
    );
    // Output is redacted per complete line (a secret split across chunks is
    // still caught); a newline-less tail shows after LOGIN_TAIL_FLUSH_MS idle.
    let pending = '';
    let tailTimer: NodeJS.Timeout | null = null;
    const append = (text: string) => {
      session.output = (session.output + this.#deps.secrets.redact(text)).slice(
        -LOGIN_OUTPUT_MAX_CHARS,
      );
      this.#publishSoon(entry.id);
    };
    const flushTail = () => {
      if (tailTimer !== null) clearTimeout(tailTimer);
      tailTimer = null;
      if (pending.length === 0) return;
      const tail = pending;
      pending = '';
      append(tail);
    };
    const handle = (this.#deps.runLogin ?? defaultLoginRunner)({
      entry,
      command: command.command,
      args: command.args,
      env,
      cwd: this.#deps.workDir,
      onOutput: (text) => {
        if (!session.running) return;
        pending += text;
        const cut = pending.lastIndexOf('\n');
        if (cut !== -1) {
          const lines = pending.slice(0, cut + 1);
          pending = pending.slice(cut + 1);
          append(lines);
        }
        if (tailTimer !== null) clearTimeout(tailTimer);
        tailTimer = setTimeout(flushTail, LOGIN_TAIL_FLUSH_MS);
        tailTimer.unref?.();
      },
    });
    session.write = handle.write;
    let timeout: NodeJS.Timeout | null = null;
    let forced: NodeJS.Timeout | null = null;
    session.finish = (code) => {
      if (!session.running) return;
      if (timeout !== null) clearTimeout(timeout);
      if (forced !== null) clearTimeout(forced);
      flushTail();
      session.running = false;
      session.exitCode = code;
      delete session.kill;
      delete session.write;
      delete session.finish;
      if (code === 0 && session.error === null) {
        this.#auth.set(entry.id, 'ok');
        this.#authNotedAt.delete(entry.id);
      } else if (session.error === null) {
        session.error = `登录命令退出码 ${code ?? '（被终止）'}`;
      }
      this.#deps.logger.info(
        { agentId: entry.id, methodId: method.id, code },
        'agent terminal login finished',
      );
      if (this.#disposed) return;
      if (code === 0 && session.error === null) this.#afterChange(entry);
      else this.#publish(entry.id);
    };
    // Kill the whole tree; if it still has not exited after the SIGKILL
    // escalation window, settle the session anyway (never stuck "running").
    session.kill = () => {
      handle.kill();
      if (forced === null) {
        forced = setTimeout(
          () => session.finish?.(null),
          this.#deps.timeouts?.forceSettleMs ?? LOGIN_FORCE_SETTLE_MS,
        );
        forced.unref?.();
      }
    };
    timeout = setTimeout(() => {
      session.error = '登录超时，已取消';
      session.kill?.();
    }, this.#deps.timeouts?.loginMs ?? LOGIN_TIMEOUT_MS);
    timeout.unref?.();
    void handle.exited.then((code) => session.finish?.(code));
  }

  async #runAgentLogin(
    entry: AgentCatalogEntry,
    method: AgentLoginMethod,
    session: LoginSession,
  ): Promise<void> {
    this.#publish(entry.id);
    try {
      await this.#withControl(
        entry,
        this.#deps.timeouts?.loginMs ?? LOGIN_TIMEOUT_MS,
        async (control) => {
          await control.initialize();
          await control.authenticate(method.id);
        },
        (proc) => {
          // Cancel (logout / uninstall / dispose) ends the control process.
          session.kill = () => proc.kill();
        },
      );
      if (session.error === null) {
        session.exitCode = 0;
        this.#auth.set(entry.id, 'ok');
        this.#authNotedAt.delete(entry.id);
        this.#deps.logger.info({ agentId: entry.id, methodId: method.id }, 'agent authenticated');
      }
    } catch (error) {
      session.error ??= errorMessage(error);
      this.#deps.logger.info(
        { agentId: entry.id, methodId: method.id, error: session.error },
        'agent authenticate failed',
      );
    } finally {
      session.running = false;
      delete session.kill;
    }
    if (this.#disposed) return;
    if (session.error === null) this.#afterChange(entry);
    else this.#publish(entry.id);
  }

  #cancelLogin(agentId: string): void {
    const session = this.#logins.get(agentId);
    if (session?.running === true) {
      session.error = '已取消';
      session.kill?.();
    }
  }

  /**
   * 退出：取消进行中的登录、删除 KepCup 保存的 API key、请 Agent 经 ACP
   * `logout` 退出其官方登录（Agent 不支持时只记日志——其登录态归厂商 CLI
   * 管理，KepCup 不碰凭据文件）。
   */
  async logout(agentId: string): Promise<AgentView> {
    this.#requireExperimental();
    const entry = this.#entry(agentId);
    this.#cancelLogin(agentId);
    if (this.#deps.secrets.hasValue(agentApiKeySecretName(agentId))) {
      this.#deps.secrets.removeValue(agentApiKeySecretName(agentId));
    }
    if (entry.auth.kinds.some((kind) => kind !== 'api-key' && kind !== 'anonymous')) {
      try {
        await this.#withControl(
          entry,
          this.#deps.timeouts?.probeMs ?? PROBE_TIMEOUT_MS,
          async (control) => {
            await control.initialize();
            await control.logout();
          },
        );
      } catch (error) {
        this.#deps.logger.info(
          { agentId, error: errorMessage(error) },
          'agent logout not supported or failed',
        );
      }
    }
    this.#logins.delete(agentId);
    this.#auth.set(agentId, entry.auth.kinds.length === 0 ? 'ok' : 'required');
    this.#deps.host.stop(agentId);
    this.#publish(agentId);
    return this.view(agentId);
  }

  // --- test / options ---------------------------------------------------------------------

  /** 测试连接：经 AgentHost 建会话、以只读档发一句 ping，回传回复。 */
  async test(agentId: string): Promise<{ agent: AgentView; result: AgentTestResult }> {
    this.#requireExperimental();
    const entry = this.#entry(agentId);
    const provider = providerFor(entry, this.#providers);
    const classify = classifierFor(provider);
    const started = this.#now;
    const timeoutMs = this.#deps.timeouts?.testMs ?? TEST_TIMEOUT_MS;
    let phase: 'initialize' | 'session_new' | 'prompt' = 'initialize';
    let result: AgentTestResult;
    try {
      const reply = await withTimeout(
        (async () => {
          const lease = await this.#deps.host.acquire(entry);
          let sessionId: string | null = null;
          try {
            phase = 'session_new';
            mkdirSync(this.#deps.workDir, { recursive: true });
            const created = await lease.connection.newSession({
              cwd: this.#deps.workDir,
              mcpServers: [],
              ...(() => {
                const meta = this.#probeSessionMeta(entry, lease.provider);
                return meta !== undefined ? { _meta: meta } : {};
              })(),
            });
            sessionId = created.sessionId;
            this.#options.set(entry.id, agentOptionsFrom(created.configOptions, this.#now));
            const id = created.sessionId;
            await lease.provider.applyPermissionTier('read_only', {
              sessionId: id,
              modes: created.modes ?? null,
              configOptions: created.configOptions ?? [],
              setMode: (modeId) => lease.connection.setMode(id, modeId),
              setConfigOption: (configId, value) =>
                lease.connection.setConfigOption(id, configId, value),
            });
            let text = '';
            lease.attach(id, {
              bridge: null,
              onUpdate: (update) => {
                if (
                  update.sessionUpdate === 'agent_message_chunk' &&
                  update.content.type === 'text'
                ) {
                  text += update.content.text;
                }
              },
              onPermission: () => undefined,
              onClosed: () => undefined,
            });
            phase = 'prompt';
            const response = await lease.connection.prompt(id, [
              { type: 'text', text: PING_PROMPT },
            ]);
            if (response.stopReason !== 'end_turn') {
              throw new AppError('AGENT_FAILED', `智能体结束于 ${response.stopReason}`);
            }
            return text.trim();
          } finally {
            if (sessionId !== null) {
              lease.detach(sessionId);
              const closing = sessionId;
              void lease.connection.cancel(closing).catch(() => undefined);
              void lease.connection.closeSession(closing).catch(() => undefined);
            }
            lease.release();
          }
        })(),
        timeoutMs,
        `智能体「${entry.name}」响应超时（${Math.round(timeoutMs / 1000)} 秒）`,
      );
      this.#auth.set(entry.id, 'ok');
      this.#authNotedAt.delete(entry.id);
      this.#errors.delete(entry.id);
      result = {
        ok: true,
        reply: reply.slice(0, REPLY_MAX_CHARS),
        elapsedMs: Math.max(0, this.#now - started),
        error: null,
        errorCode: null,
      };
    } catch (error) {
      const appError = toAgentError(error, entry.name, classify, phase);
      if (appError.code === 'AGENT_AUTH_REQUIRED') this.#auth.set(entry.id, 'required');
      result = {
        ok: false,
        reply: '',
        elapsedMs: Math.max(0, this.#now - started),
        error: appError.message,
        errorCode: appError.code,
      };
    }
    this.#publish(entry.id);
    return { agent: this.view(entry.id), result };
  }

  /**
   * 外部 Agent run 的失败回写（D72 P4，orchestrator 调用）：`auth_required`
   * 记为未登录（需要登录的条目），状态变为 `needs_auth` 并推送——对话内设置卡
   * 据此展示登录入口，下一次发消息在开跑前即被门禁拦下。
   */
  noteRunError(agentId: string, code: string): void {
    if (code !== 'AGENT_AUTH_REQUIRED') return;
    const entry = findAgentEntry(this.#deps.catalog(), agentId);
    if (entry === null || entry.auth.kinds.length === 0) return;
    this.#authNotedAt.set(agentId, Date.now());
    if (this.#auth.get(agentId) === 'required') return;
    this.#auth.set(agentId, 'required');
    this.#publish(agentId);
  }

  /** 模型 / 推理强度选项（缓存；`refresh` 或未读取过时经探测会话读取）。 */
  async options(agentId: string, refresh = false): Promise<AgentOptions> {
    this.#requireExperimental();
    const entry = this.#entry(agentId);
    const cached = this.#options.get(agentId);
    if (!refresh && cached !== undefined && cached.fetchedAt !== null) return cached;
    await this.#probeQuietly(entry);
    this.#publish(agentId);
    return this.#options.get(agentId) ?? { models: [], efforts: [], fetchedAt: null, error: null };
  }

  /**
   * Core shutdown: abort installs, kill login and control processes, drop
   * pending publishes. Nothing starts a process afterwards (`#afterChange` /
   * `#withControl` check `#disposed`).
   */
  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#publishTimers.values()) clearTimeout(timer);
    this.#publishTimers.clear();
    for (const agentId of [...this.#installJobs.keys()]) this.#cancelInstall(agentId);
    for (const agentId of this.#logins.keys()) this.#cancelLogin(agentId);
    for (const proc of this.#controls) proc.kill();
    this.#controls.clear();
  }

  /** Test / diagnostics: whether an install of the agent is in flight. */
  isInstalling(agentId: string): boolean {
    return this.#installJobs.has(agentId);
  }
}
