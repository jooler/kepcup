import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AGENT_CATALOG,
  AppError,
  TASK_SETTLE_SWEEP_MS,
  findAgentEntry,
  systemInfoOutputSchema,
  systemPingOutputSchema,
  systemShutdownOutputSchema,
  unattendedGetOutputSchema,
  updateActiveRunsOutputSchema,
  updateCancelActiveInputSchema,
  updateCancelActiveOutputSchema,
  diagnosticsOutputSchema,
  type AgentCatalogEntry,
  type CoreStatus,
  type CustomModel,
} from '@kepcup/shared';
import type { DiagnosticsDatabaseRow, DiagnosticsToolRow } from '@kepcup/shared';
import { readdirSync } from 'node:fs';
import { directoryUsage, fileSizeOrNull } from './infra/disk-usage.js';
import {
  agentStateDir,
  ensureAgentProcessCwd,
  resolveBundledBinDir,
  resolvePaths,
  canonicalPath,
  type AppPaths,
} from './infra/paths.js';
import path from 'node:path';
import { createLogger, type CoreLogger } from './infra/logger.js';
import { selectKeystore, type Keystore } from './infra/keystore.js';
import { deriveKey, generateMasterKey, KEY_INFO, MASTER_KEY_BYTES } from './infra/crypto.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from './infra/db.js';
import { migrationTargetVersion, readUserVersion, runMigrations } from './infra/migrate.js';
import {
  backupBeforeMigration,
  restoreDatabaseBackup,
  type DbBackupRecord,
} from './infra/backup.js';
import './infra/test-hooks.js';
import { systemClock, type Clock, type TimerScheduler } from './infra/clock.js';
import { createEventBus, type EventBus } from './infra/events.js';
import type { RpcMethodSpec, RpcServerHandle } from './rpc/server.js';
import { SettingsService } from './domain/settings.js';
import { SecretsService } from './domain/secrets.js';
import { BotsService } from './domain/bots.js';
import { BotAvatarService } from './domain/avatars.js';
import { ConversationsService } from './domain/conversations.js';
import { MessagesService } from './domain/messages.js';
import { DraftsService } from './domain/drafts.js';
import { AttachmentsService } from './domain/attachments.js';
import { JobsService } from './domain/jobs.js';
import { RunsService } from './domain/runs.js';
import { UsageService } from './domain/usage.js';
import { LifecycleService } from './domain/lifecycle.js';
import { GroupsService } from './domain/groups.js';
import { DelegationsService } from './domain/delegations.js';
import { ProvidersService } from './domain/providers.js';
import { AuditService } from './domain/audit.js';
import { GrantsService } from './permissions/grants.js';
import { ApprovalsService } from './permissions/approvals.js';
import { AllowlistService } from './permissions/allowlist.js';
import { UnattendedService } from './permissions/unattended.js';
import { LeaseService } from './project/lease.js';
import { CheckpointService } from './project/checkpoints.js';
import { ProjectRuntime } from './project/service.js';
import { ProjectsService } from './domain/projects.js';
import {
  createSandboxBackend,
  createEnhancedSandboxBackend,
  type SandboxBackend,
} from './sandbox/index.js';
import { WslSandboxBackend } from './sandbox/backend-wsl.js';
import type { MountRegistration } from './sandbox/wsl/mounts.js';
import { WslSetup, createWslRunner, type WslRunner } from './sandbox/wsl/setup.js';
import { createWslFixtureRunner, wslFixtureScenarioFromEnv } from './sandbox/wsl/fixture-runner.js';
import { WSL_DISTRO_NAME } from './sandbox/wsl/constants.js';
import { type DistroToolchainInstaller } from './env/distro.js';
import { shQuote } from './infra/shell.js';
import { ToolGateway } from './gateway/index.js';
import { PiEngine } from './agent/pi-engine.js';
import { ExternalAgentEngine } from './agent/external/engine.js';
import { LlmRouter } from './agent/llm-router.js';
import { AgentPermissionBridge } from './agent/external/permission-bridge.js';
import { HostMcpBridge } from './agent/external/mcp-bridge.js';
import { AgentHost, type AgentSpawner } from './agent/external/host.js';
import { effectiveAgentCatalog } from './agent/external/catalog.js';
import { agentConcurrency } from './agent/external/providers/index.js';
import { AgentInstaller, nodeRuntimeFromBinDir } from './agent/external/installer.js';
import { AgentsService } from './domain/agents.js';
import type { LaunchTarget } from './agent/external/types.js';
import { Scheduler } from './scheduler/scheduler.js';
import { Orchestrator } from './dispatch/orchestrator.js';
import { JobsRunner } from './dispatch/jobs-runner.js';
import { EnvManager } from './env/manager.js';
import { ENV_CATALOG, loadCatalogOverride } from './env/catalog.js';
import type { CatalogEntry } from './env/catalog.js';
import { MemoryService } from './memory/service.js';
import { MediaService } from './media/service.js';
import { SearchService } from './search/service.js';
import { McpService } from './mcp/service.js';
import type { Embedder } from './memory/embedder.js';
import { BudgetService } from './usage/budget.js';
import { SkillImporter } from './skills/library.js';
import { SkillsService } from './skills/registry.js';
import { SkillPresetsService } from './skills/presets.js';
import { WikiService } from './wiki/service.js';
import { ScheduleService } from './schedule/service.js';
import {
  createBrowserHostRpc,
  type BrowserHostRpc,
  type DeferredBrowserHostRpc,
} from './browser/facade.js';
import { bindAppMethods } from './rpc/bindings.js';
import type { CoreEventsMap } from './start-types.js';

/** Test hooks for the environment manager's system-item guidance (P06). */
export interface EnvManagerHooks {
  /** Records/replaces the macOS `xcode-select --install` action. */
  runSystemAction?: (entry: CatalogEntry) => Promise<void>;
  /** PATH used for kind='system' detection (fixture directory in tests). */
  systemDetectionPath?: string;
}

/**
 * P12 production adapter: distro-internal toolchain installs over WslSetup
 * (Windows hosts only — wired conditionally in createCoreServices).
 * Stages the linux artifact with the normal installer (checksum verified on
 * the host), pipes a tar of the staged directory into the distro as root,
 * and runs the verify command inside the distro.
 */
function createDistroToolchainInstaller(setup: WslSetup): DistroToolchainInstaller {
  const runner = createWslRunner();
  const distroArgs = (extra: string[]): string[] => [
    '-d',
    WSL_DISTRO_NAME,
    '-u',
    'root',
    '--',
    ...extra,
  ];
  return {
    async available() {
      const report = await setup.status();
      return report.state.install.kind === 'ok' && report.state.distro.kind === 'registered';
    },
    async extractDir(hostDir: string, distroDir: string) {
      const staging = `${hostDir}.distro.tar`;
      await new Promise<void>((resolve, reject) => {
        const pack = spawn('tar', ['-C', hostDir, '-cf', staging, '.'], {
          stdio: 'ignore',
          shell: false,
        });
        pack.on('error', reject);
        pack.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`tar 打包失败（退出码 ${code}）`)),
        );
      });
      try {
        const script = `mkdir -p ${shQuote(distroDir)} && tar -C ${shQuote(distroDir)} -xf -`;
        const result = await runner.run(distroArgs(['bash', '-c', script]), {
          stdinFile: staging,
          timeoutMs: 15 * 60_000,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `解压进发行版失败：${result.stderr.toString('utf8').trim() || `退出码 ${result.exitCode}`}`,
          );
        }
      } finally {
        rmSync(staging, { force: true });
      }
    },
    async installPythonViaUv(input: { pythonVersion: string; distroDir: string }) {
      // uv ships in the rootfs (/opt/kepcup/bin/uv); UV_PYTHON_INSTALL_DIR keeps
      // the install inside the distro toolchains root (P06 mechanism parity).
      const script =
        `export UV_PYTHON_INSTALL_DIR=${shQuote(input.distroDir)} UV_CACHE_DIR=/home/kepcup/cache/uv; ` +
        `/opt/kepcup/bin/uv python install ${shQuote(input.pythonVersion)} && ` +
        `/opt/kepcup/bin/uv python find ${shQuote(input.pythonVersion)}`;
      const result = await runner.run(distroArgs(['bash', '-c', script]), {
        timeoutMs: 30 * 60_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `发行版内 uv python install 失败：${result.stderr.toString('utf8').trim() || `退出码 ${result.exitCode}`}`,
        );
      }
      const printed = result.stdout.toString('utf8').trim().split('\n').pop()?.trim() ?? '';
      if (printed.length === 0 || !printed.startsWith('/')) {
        throw new Error('发行版内 uv python find 未返回安装目录');
      }
      return printed;
    },
    async verify(input: {
      command: string;
      expect: string;
      binName: string;
      binDir: string;
      targetDir: string;
    }) {
      // Same {bin}/{dir} substitution semantics as the host verifyInstall.
      const bin = `${input.binDir}/${input.binName}`;
      const resolved = input.command
        .replaceAll('{bin}', shQuote(bin))
        .replaceAll('{dir}', shQuote(input.targetDir));
      const script = `export PATH=${shQuote(`${input.binDir}:/opt/kepcup/bin:/usr/local/bin:/usr/bin:/bin`)}; ${resolved}`;
      const result = await runner.run(
        ['-d', WSL_DISTRO_NAME, '-u', 'root', '--', 'bash', '-c', script],
        {
          timeoutMs: 120_000,
        },
      );
      const stdout = result.stdout.toString('utf8');
      if (result.exitCode !== 0 || !stdout.includes(input.expect)) {
        throw new Error(
          `发行版内验证未通过（期望输出包含 "${input.expect}"）：${stdout.trim() || `退出码 ${result.exitCode}`}`,
        );
      }
    },
    async removeDir(distroDir: string) {
      const result = await runner.run(distroArgs(['bash', '-c', `rm -rf ${shQuote(distroDir)}`]), {
        timeoutMs: 60_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(`发行版内目录删除失败（退出码 ${result.exitCode}）`);
      }
    },
  };
}

export interface CoreServicesOptions {
  /** Overrides KEPCUP_HOME. */
  home?: string | undefined;
  env?: NodeJS.ProcessEnv;
  appVersion?: string | undefined;
  dev?: boolean;
  clock?: Clock;
  /** Injectable timer arming (P10 schedule timer; tests drive it virtually). */
  timers?: TimerScheduler;
  /** Overrides keystore selection (tests inject a shared memory instance). */
  keystore?: Keystore;
  /** P06 test hook: replaces the pinned catalog (local file server, no real downloads). */
  envCatalog?: typeof ENV_CATALOG;
  /** P06 test hooks: system-item action/detection overrides. */
  envManagerHooks?: EnvManagerHooks;
  /**
   * P12 test hook: replaces the enhanced-level backend (macOS Lima / Linux
   * Podman). The default probes the real CLIs; tests inject a stub.
   */
  enhancedSandbox?: SandboxBackend | undefined;
  /**
   * P12 test hook: the distro-internal toolchain installer (Windows hosts).
   * The default talks to WslSetup; tests inject a fake.
   */
  distroInstaller?: DistroToolchainInstaller | undefined;
  /**
   * P12 test hook: platform override for the environment manager (drives the
   * wslDistro install branch on a non-Windows dev machine).
   */
  platform?: string | undefined;
  /**
   * P12-B test hook: replaces the WSL runner behind the sandbox backend and
   * the setup wizard (e2e drives the state machine on non-Windows machines).
   * The default is the production wsl.exe runner; only the launcher-set
   * KEPCUP_WSL_TEST_FIXTURE env activates the fixture instead.
   */
  wslRunner?: WslRunner | undefined;
  /** P07 test hook: replaces the configured embedder (deterministic vectors). */
  memoryEmbedder?: Embedder;
  /**
   * P13 任务 5 test hook: overrides the migration directories (backup/restore
   * tests point `main` at a directory with an extra broken migration file).
   * The default is `migrationsUrl(kind)` next to the compiled module.
   */
  migrationsDirs?: Partial<Record<'main' | 'runs', string>>;
  /**
   * P11 test hook: the browser capability hosted by the main process. The
   * Electron entry binds the deferred default to the platform channel; tests
   * inject a fake directly.
   */
  browserRpc?: BrowserHostRpc;
  /**
   * P13 修复轮 test hook (BR-P13-007): wraps the pre-migration backup restore
   * so integration tests can inject a restore failure and pin the honest
   * statusReason. The default is the production restoreDatabaseBackup.
   */
  restoreBackup?: typeof restoreDatabaseBackup;
  /**
   * P13 修复轮 test hook (BR-P13-006): entry budget for the diagnostics disk
   * walk (defaults to DISK_WALK_ENTRY_BUDGET). Tests shrink it so the
   * truncation flag can be exercised without a six-figure file count.
   */
  diskUsageBudget?: number;
  /**
   * D72 test hook: extra agent catalog entries (e.g. a second fake agent),
   * appended to the curated AGENT_CATALOG before the release-gate filter.
   */
  agentCatalog?: AgentCatalogEntry[];
  /**
   * D72 test hook: how to start an entry (P1 has no installer). Returning null
   * falls back to the default resolver (system CLI on PATH).
   */
  agentLaunch?: (entry: AgentCatalogEntry) => LaunchTarget | null;
  /** D72 test hook: in-process agents instead of child processes. */
  agentSpawn?: AgentSpawner;
}

export interface CoreDomainServices {
  settings: SettingsService;
  secrets: SecretsService;
  bots: BotsService;
  avatars: BotAvatarService;
  audit: AuditService;
  conversations: ConversationsService;
  messages: MessagesService;
  drafts: DraftsService;
  attachments: AttachmentsService;
  jobs: JobsService;
  runs: RunsService;
  usage: UsageService;
  lifecycle: LifecycleService;
  groups: GroupsService;
  /** 跨 Bot 委派行（D71）。 */
  delegations: DelegationsService;
  providers: ProvidersService;
  grants: GrantsService;
  approvals: ApprovalsService;
  allowlist: AllowlistService;
  unattended: UnattendedService;
  projects: ProjectsService;
}

export interface CoreServices {
  status: CoreStatus;
  statusReason?: string | undefined;
  paths: AppPaths;
  logger: CoreLogger;
  clock: Clock;
  events: EventBus<CoreEventsMap>;
  sandbox: SandboxBackend;
  /** P12 enhanced-level backend (null on Windows — WSL serves both levels). */
  sandboxEnhanced: SandboxBackend | null;
  /**
   * P12-B Windows setup state machine behind the preparation wizard RPCs
   * (sandbox.wslStatus / wslPrepare / wslSkip). Null where there is nothing
   * to prepare: non-Windows hosts without the e2e fixture seam.
   */
  wslSetup: WslSetup | null;
  mainDb: SqliteDatabase | null;
  runsDb: SqliteDatabase | null;
  /**
   * P13 任务 6 诊断: which keystore backs the master key ('system' keychain /
   * test-only 'memory'/'file' seams) or 'unavailable' when selection failed.
   * Never exposes key material — the kind only.
   */
  keystoreKind: 'system' | 'memory' | 'file' | 'unavailable';
  /** Null while locked / errored (no business services are constructed). */
  domain: CoreDomainServices | null;
  orchestrator: Orchestrator | null;
  /** Project runtime (P04): binding, leases, checkpoints, git remote. */
  projectRuntime: ProjectRuntime | null;
  /** P06 environment manager (null while locked / errored). */
  environment: EnvManager | null;
  /** P07 memory & profile domain (null while locked / errored). */
  memory: MemoryService | null;
  /** 国内厂商媒体网关（图片/语音/视频统一调用，null while locked / errored）。 */
  media: MediaService | null;
  search: SearchService | null;
  /** MCP 网关（D65）；测试夹具缺省为 null（不注册 MCP 工具）。 */
  mcp: McpService | null;
  /**
   * 外部智能体（D72）：生效目录（按发行门禁过滤）与进程宿主（null while
   * locked / errored）。
   */
  agents: {
    catalog(): readonly AgentCatalogEntry[];
    host: AgentHost;
    /** 宿主 MCP 桥（D72 §4.4）。 */
    bridge: HostMcpBridge;
  } | null;
  /** 外部智能体的安装 / 登录 / 状态服务（D72 P4，设置页「智能体」；null likewise）。 */
  agentsService: AgentsService | null;
  /** D72 P6 后台调用路由（null while locked / errored）。 */
  llmRouter: LlmRouter | null;
  /** P07 per-bot daily background budget (null while locked / errored). */
  budget: BudgetService | null;
  /** P08 skills domain (null while locked / errored). */
  skills: SkillsService | null;
  /** P08 git import pipeline (null while locked / errored). */
  skillImporter: SkillImporter | null;
  /** P08 skill marketplace over the app-shipped preset catalog (null likewise). */
  skillPresets: SkillPresetsService | null;
  /** P09 wiki domain (null while locked / errored). */
  wiki: WikiService | null;
  /** P10 proactive-messaging domain (null while locked / errored). */
  schedules: ScheduleService | null;
  scheduler: Scheduler | null;
  jobsRunner: JobsRunner | null;
  /**
   * P11 browser capability (always present; the deferred default fails calls
   * with BROWSER_UNAVAILABLE until the process entry binds the platform port).
   */
  browserRpc: DeferredBrowserHostRpc;
  appMethods: Record<string, RpcMethodSpec>;
  platformMethods: Record<string, RpcMethodSpec>;
  /** Re-announce the current status to a freshly bound RPC client. */
  pushStatusTo(server: RpcServerHandle): void;
  /**
   * P13 任务 3: pushes the current platform-facing state (launch-at-login) to
   * a freshly bound port B channel, so the main process reconciles the OS
   * login item with the stored setting on every (re)bind.
   */
  pushPlatformStateTo(server: RpcServerHandle): void;
  /** P12: re-probes the enhanced backend for the skills verdict cache. */
  refreshEnhancedAvailability: () => void;
  close(): Promise<void>;
}

const voidInput = z.void();

/** Daily environment health check (docs/dev/phases/P06-environment.md 范围). */
const ENV_DOCTOR_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Consolidation due-check cadence (P07 任务 9: daily after 03:00 local). */
const CONSOLIDATION_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** Weekly wiki lint due-check cadence (P09; the job itself gates to one week). */
const WIKI_LINT_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** Holder so services.close() can clear the doctor timer created later. */
const envDoctorTimerRef: { timer: NodeJS.Timeout | null } = { timer: null };
/** Holder for the consolidation due-check timer (P07). */
const consolidationTimerRef: { timer: NodeJS.Timeout | null } = { timer: null };
/** Holder for the wiki lint due-check timer (P09). */
const wikiLintTimerRef: { timer: NodeJS.Timeout | null } = { timer: null };
/** Set by close() so late best-effort callbacks stop touching dead resources. */
const servicesClosed: { closed: boolean } = { closed: false };

/**
 * Assembles the whole core service: paths, logger, keystore, master key,
 * encrypted databases, domain services and the response-loop machinery.
 * Startup order follows docs/dev/02-architecture.md ("启动、退出与崩溃恢复").
 *
 * An existing database while the master key is missing leads to `locked`;
 * a new key is never generated in that case.
 */
export async function createCoreServices(options: CoreServicesOptions = {}): Promise<CoreServices> {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  const envHome = env.KEPCUP_HOME;
  const homeOverride =
    options.home ?? (envHome !== undefined && envHome.length > 0 ? envHome : undefined);
  const paths = resolvePaths(homeOverride);

  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  for (const cacheDir of [
    paths.cacheDir,
    paths.cacheNpmDir,
    paths.cachePipDir,
    paths.cacheXdgDir,
    paths.cacheCargoDir,
    paths.cachePycacheDir,
    paths.cacheUvDir,
    paths.cacheDownloadsDir,
  ]) {
    mkdirSync(cacheDir, { recursive: true });
  }
  mkdirSync(paths.toolchainsDir, { recursive: true });

  const logger = await createLogger({ logsDir: paths.logsDir, dev: options.dev === true });
  const events = createEventBus<CoreEventsMap>();
  // BR-P13-007 test seam: production restore by default; tests inject a
  // failing wrapper to pin the honest migration-failure statusReason.
  const restoreBackup = options.restoreBackup ?? restoreDatabaseBackup;
  // Backend selection only reads paths/env; availability probing happens lazily.
  // P12: the enhanced backend is Lima (macOS) / Podman (Linux); null elsewhere.
  // The distro toolchain prefix is late-wired (EnvManager exists later).
  let distroToolchainPrefix: () => string | null = () => null;
  /**
   * P12-B: one WSL runner + state machine shared by the sandbox backend probe
   * and the wizard RPCs. The fixture runner (test seam, never active outside
   * e2e) also selects the WSL backend as the default backend so the whole
   * per-command-confirm chain is drivable on non-Windows dev machines.
   * __KEPCUP_TEST_HOOKS__ folds to `false` in the packaged artifact: the
   * seam (and this whole module import) is dead-code-eliminated there.
   */
  const wslFixtureScenario = __KEPCUP_TEST_HOOKS__ ? wslFixtureScenarioFromEnv(env) : null;
  // D72 P6 e2e seam: testkit fake ACP agent from the environment (test builds only).
  const fakeAgentSeam = __KEPCUP_TEST_HOOKS__ ? fakeAcpAgentSeamFromEnv(env) : null;
  const extraAgentEntries = options.agentCatalog ?? fakeAgentSeam?.catalog ?? [];
  const agentLaunch = options.agentLaunch ?? fakeAgentSeam?.launch;
  const wslRunner: WslRunner =
    options.wslRunner ??
    (wslFixtureScenario !== null
      ? createWslFixtureRunner(wslFixtureScenario)
      : createWslRunner(env));
  const wslSetup =
    wslFixtureScenario !== null || process.platform === 'win32'
      ? new WslSetup({ paths, runner: wslRunner })
      : null;
  const sandbox = createSandboxBackend({
    paths,
    logger,
    env,
    ...(wslFixtureScenario !== null ? { platform: 'win32' } : {}),
    ...(wslFixtureScenario !== null ? { wslRunner } : {}),
    // One state machine behind the backend probe AND the wizard RPCs (real
    // Windows included) — two instances would race on the state file.
    ...(wslSetup !== null ? { wslSetup } : {}),
    distroToolchainPrefix: () => distroToolchainPrefix(),
  });
  const sandboxEnhanced =
    options.enhancedSandbox !== undefined
      ? options.enhancedSandbox
      : createEnhancedSandboxBackend({ paths, logger, env });
  /**
   * Sync availability cache for the skills verdicts (the probe is async but
   * the registry decides synchronously). Refreshed at startup, on every
   * sandbox.status RPC and with the daily doctor; the gateway ROUTING still
   * probes the backend authoritatively per exec.
   */
  const enhancedAvailability = (() => {
    let cached = false;
    const refresh = (): void => {
      const source =
        sandboxEnhanced ??
        (process.platform === 'win32' && sandbox instanceof WslSandboxBackend ? sandbox : null);
      if (source === null) return;
      void source
        .probe()
        .then((verdict) => {
          cached = verdict.available;
        })
        .catch(() => {
          cached = false;
        });
    };
    refresh();
    return {
      available: (): boolean => cached,
      refresh,
    };
  })();
  const enhancedInstallHint = (): string => {
    if (process.platform === 'win32') {
      return 'Windows 上完成 WSL2 沙箱准备后，私有发行版同时充当增强沙箱（设置页 → 沙箱）。';
    }
    if (process.platform === 'linux') {
      return '可安装 rootless Podman 作为增强沙箱（发行版包管理器），或让 Bot 通过环境管理器申请安装（环境项 podman）。';
    }
    return '可安装 Lima 作为增强沙箱（brew install lima），或让 Bot 通过环境管理器申请安装（环境项 lima）。';
  };
  const bundledBinDir = resolveBundledBinDir(env);
  if (bundledBinDir !== null) {
    // pi's tool helpers resolve rg via PATH; make the bundled binary win.
    process.env.PATH = `${bundledBinDir}${path.delimiter}${process.env.PATH ?? ''}`;
  }

  let status: CoreStatus = 'starting';
  let statusReason: string | undefined;

  const setStatus = (next: CoreStatus, reason?: string) => {
    status = next;
    statusReason = reason;
    events.emit('core.status', reason === undefined ? { status } : { status, reason });
  };

  /** D75 §3.2 task reaper (armed after startup recovery, cleared by close()). */
  let taskSweepTimer: NodeJS.Timeout | null = null;

  /** Never logs after close: pino's sync write throw would reject unhandled. */
  const warnQuietly = (message: string, error: unknown) => {
    if (servicesClosed.closed) return;
    try {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, message);
    } catch {
      // Logger already torn down; nothing to report to.
    }
  };

  const services: CoreServices = {
    status,
    statusReason,
    paths,
    logger,
    clock,
    events,
    sandbox,
    sandboxEnhanced,
    wslSetup,
    mainDb: null,
    runsDb: null,
    keystoreKind: 'unavailable',
    domain: null,
    orchestrator: null,
    projectRuntime: null,
    environment: null,
    memory: null,
    media: null,
    search: null,
    mcp: null,
    agents: null,
    agentsService: null,
    llmRouter: null,
    budget: null,
    skills: null,
    skillImporter: null,
    skillPresets: null,
    wiki: null,
    schedules: null,
    scheduler: null,
    jobsRunner: null,
    browserRpc: createBrowserHostRpc(),
    appMethods: {},
    platformMethods: {},
    pushStatusTo(server) {
      server.pushEvent(
        'core.status',
        statusReason === undefined ? { status } : { status, reason: statusReason },
      );
    },
    pushPlatformStateTo(server) {
      // P13 任务 3: launch-at-login (settings default ON). Locked/errored
      // cores have no domain yet — the OS default stays enabled until the
      // user changes the setting in a working session.
      const enabled =
        services.domain !== null ? services.domain.settings.get().launchAtLogin : true;
      server.pushEvent('platform.autostart', { enabled });
    },
    refreshEnhancedAvailability: enhancedAvailability.refresh,
    async close() {
      servicesClosed.closed = true;
      services.jobsRunner?.stop();
      try {
        services.schedules?.stop();
      } catch {
        // Timer already gone.
      }
      envDoctorTimerRef.timer?.unref?.();
      if (envDoctorTimerRef.timer) clearInterval(envDoctorTimerRef.timer);
      if (consolidationTimerRef.timer) clearInterval(consolidationTimerRef.timer);
      if (wikiLintTimerRef.timer) clearInterval(wikiLintTimerRef.timer);
      if (taskSweepTimer !== null) clearInterval(taskSweepTimer);
      taskSweepTimer = null;
      try {
        services.memory?.closeAll();
      } catch {
        // Connections may already be gone (bot deletion race); nothing to do.
      }
      try {
        await services.mcp?.closeAll();
      } catch {
        // MCP servers may already be gone; nothing to do.
      }
      services.agentsService?.dispose();
      services.agents?.host.dispose();
      await services.agents?.bridge.stop().catch(() => undefined);
      if (services.mainDb) closeDatabase(services.mainDb);
      if (services.runsDb) closeDatabase(services.runsDb);
      services.mainDb = null;
      services.runsDb = null;
      events.clear();
      await logger.close();
    },
  };

  // P11: a test-injected in-process browser fake takes precedence; the real
  // app binds the platform channel in process-entry (services.browserRpc.bind).
  if (options.browserRpc !== undefined) services.browserRpc.bindFacade(options.browserRpc);

  const systemMethods = createSystemMethods(services, options.appVersion, options.diskUsageBudget);
  const fail = (message: string): CoreServices => {
    setStatus('error', message);
    services.status = status;
    services.statusReason = statusReason;
    services.appMethods = systemMethods;
    services.logger.error({ message }, 'core startup failed');
    return services;
  };

  services.appMethods = systemMethods;
  services.platformMethods = createPlatformMethods(services);

  logger.info({ dataDir: paths.home }, 'core starting');

  let keystore: Keystore;
  try {
    keystore = options.keystore ?? selectKeystore(env, paths.home);
    services.keystoreKind = keystore.kind;
  } catch (error) {
    services.keystoreKind = 'unavailable';
    return fail(error instanceof AppError ? error.message : 'Keystore selection failed');
  }

  try {
    const stored = keystore.getSecret();
    const mainDbExists = existsSync(paths.mainDbPath);
    let masterKey: Buffer;

    if (stored === null) {
      if (mainDbExists) {
        // Never generate a replacement key: without the original the data is
        // unrecoverable, and overwriting the keychain entry would hide that.
        return failLocked(
          services,
          setStatus,
          '无法从系统钥匙串读取主密钥，但数据目录中已存在加密数据库',
        );
      }
      masterKey = generateMasterKey();
      keystore.setSecret(masterKey.toString('base64'));
      logger.info('generated new master key');
    } else {
      masterKey = Buffer.from(stored, 'base64');
      if (masterKey.length !== MASTER_KEY_BYTES) {
        return failLocked(services, setStatus, '系统钥匙串中存储的密钥数据无效');
      }
      logger.info('loaded master key from keystore');
    }

    const mainDb = openDatabase({
      path: paths.mainDbPath,
      key: deriveKey(masterKey, KEY_INFO.mainDb),
    });
    // P13 任务 5: the backup MUST happen before ANY migration step runs. A
    // failed migration restores the backup and surfaces a structured error;
    // the outer catch turns it into core status `error` with the reason.
    const migrationDirs = {
      main: options.migrationsDirs?.main ?? migrationsUrl('main'),
      runs: options.migrationsDirs?.runs ?? migrationsUrl('runs'),
    };
    let mainDbBackup: DbBackupRecord | null = null;
    try {
      mainDbBackup = await backupBeforeMigration(mainDb, {
        dbPath: paths.mainDbPath,
        backupsDir: paths.backupsDir,
        currentVersion: readUserVersion(mainDb),
        targetVersion: migrationTargetVersion(migrationDirs.main),
        nowMs: clock.now(),
        logger,
      });
      runMigrations(mainDb, migrationDirs.main, { logger });
    } catch (error) {
      closeDatabase(mainDb);
      // BR-P13-007: whether the automatic restore succeeded is part of the
      // truth the surfaced reason must tell — a failed restore is NOT
      // reported as "your data was put back".
      let restoreFailed = false;
      if (mainDbBackup !== null) {
        try {
          restoreBackup({
            dbPath: paths.mainDbPath,
            backupPath: mainDbBackup.path,
            logger,
          });
        } catch (restoreError) {
          restoreFailed = true;
          logger.error(
            { backup: mainDbBackup.path, error: String(restoreError) },
            'restoring the pre-migration backup failed',
          );
        }
      }
      // Structured error paths (P13 任务 5 + BR-P13-007): the surfaced reason
      // states exactly what happened — restored, or restore ALSO failed (with
      // a no-further-damage instruction instead of a false reassurance).
      if (error instanceof AppError && error.code === 'MIGRATION_FAILED' && mainDbBackup !== null) {
        const backupName = path.basename(mainDbBackup.path);
        throw restoreFailed
          ? new AppError(
              'MIGRATION_FAILED',
              `数据迁移失败，且自动恢复升级前的备份未成功。请勿改动或删除数据目录（${paths.home}），可从 backups/${backupName} 手动恢复`,
              { reason: error.message },
            )
          : new AppError(
              'MIGRATION_FAILED',
              `数据迁移失败，已恢复升级前的 main.db 备份（${backupName}），应用未改动你的数据`,
              { reason: error.message },
            );
      }
      throw error;
    }
    const runsDb = openDatabase({
      path: paths.runsDbPath,
      key: deriveKey(masterKey, KEY_INFO.runsDb),
    });
    runMigrations(runsDb, migrationDirs.runs, { logger });

    // --- domain services ---------------------------------------------------
    const settings = new SettingsService(mainDb, clock);
    const secrets = new SecretsService({ db: mainDb, masterKey, clock, logger });
    // Warm the redaction cache so run-step payloads are scrubbed from boot.
    for (const name of secrets.names()) secrets.getValue(name);
    // Test/e2e-only seam: absent from the packaged artifact (P13 产物剔除).
    if (__KEPCUP_TEST_HOOKS__) seedMockLlm(settings, env, logger);

    // D72 P4：onboarding「我有订阅」写入的默认 Agent——仅在没有默认主模型、
    // 实验开关打开且该 Agent 已启用时用于新建 Bot（预览档默认 ask）。
    const bots = new BotsService(mainDb, clock, () => {
      const current = settings.get();
      const agentId = current.defaultAgentId;
      if (agentId.length === 0 || current.defaultMainModel.length > 0) return null;
      if (!current.experimental.externalAgents || current.agents[agentId]?.enabled !== true) {
        return null;
      }
      const entry = findAgentEntry(effectiveAgentCatalog(extraAgentEntries), agentId);
      if (entry === null) return null;
      return { id: agentId, permission: entry.tier === 'preview' ? 'ask' : 'workspace' };
    });
    const avatars = new BotAvatarService({ paths, clock, bots });
    const conversations = new ConversationsService(mainDb, clock);
    const messages = new MessagesService(mainDb, clock);
    // 群域服务先于 orchestrator 构造（19/D60 对话内群创建由 orchestrator 调用）；
    // removeMemberCascade 闭包引用其后的 lifecycle（仅运行期触发，无 TDZ 问题）。
    // 显式类型标注打断 groups → lifecycle → orchestrator → groups 的推断环。
    const groups: GroupsService = new GroupsService({
      db: mainDb,
      clock,
      conversations,
      bots,
      removeMemberCascade: (conversationId, botId) =>
        lifecycle.removeGroupMember(conversationId, botId),
      publishConversation: (conversationId) => {
        const conversation = conversations.get(conversationId);
        if (conversation) events.emit('conversation.updated', { conversation });
      },
    });
    const drafts = new DraftsService(mainDb, clock);
    const delegations = new DelegationsService(mainDb, clock);
    const attachments = new AttachmentsService({ db: mainDb, paths, clock });
    const jobs = new JobsService(mainDb, clock);
    const runs = new RunsService(runsDb, clock);
    const usage = new UsageService(mainDb, clock);
    // 国内厂商媒体网关先建（providers 按能力测试要路由到这里）。
    const media = new MediaService({ settings, secrets, logger });
    // 联网检索网关（docs/design/21-web-search.md）：web_search/web_fetch 工具与
    // websearch.test 的后端。
    const search = new SearchService({ settings, secrets, logger });
    // MCP 网关（docs/design/23-mcp-and-subagent.md D65）：server 连接生命周期
    // 与 tools 列表缓存；状态经 mcp.server_status 事件出站。
    const mcp = new McpService({
      settings,
      secrets,
      logger,
      clock,
      statusSink: {
        emit: (payload) => events.emit('mcp.server_status', payload),
      },
    });
    const providers = new ProvidersService({ settings, secrets, logger, media });
    const audit = new AuditService({ db: mainDb, clock });
    const grants = new GrantsService({ db: mainDb, clock });
    const allowlist = new AllowlistService({ db: mainDb, clock, osPlatform: process.platform });
    const projectsService = new ProjectsService({ db: mainDb, clock });

    // Port-B events travel on the same bus; the process entry forwards the
    // platform.* names to the main process (startCoreProcess wires this).
    const unattended = new UnattendedService({
      settings,
      clock,
      logger,
      publish: (state) => {
        events.emit('unattended.changed', { state });
        events.emit('platform.unattended', { active: state.enabled, until: state.until });
      },
    });
    const approvals = new ApprovalsService({
      db: mainDb,
      clock,
      logger,
      paths,
      homeDir: os.homedir(),
      messages,
      conversations,
      bots,
      runs,
      secrets,
      unattended,
      publish: (event, payload) => events.emit(event as never, payload as never),
      notify: (approval, description) => {
        events.emit('platform.notify', {
          conversationId: approval.conversationId,
          title: approval.botId !== null ? (bots.get(approval.botId)?.name ?? 'Bot') : 'Bot',
          body: description,
        });
      },
      audit: (identity, action, detail) => {
        audit.record(
          identity,
          action,
          JSON.parse(secrets.redact(JSON.stringify(detail))) as Record<string, unknown>,
        );
      },
    });
    const projectRuntime = new ProjectRuntime({
      db: mainDb,
      paths,
      clock,
      logger,
      projects: projectsService,
      conversations,
      messages,
      runs,
      bots,
      grants,
      leases: new LeaseService(),
      checkpoints: new CheckpointService({ paths, logger }),
      publish: (event, payload) => events.emit(event, payload as never),
      // P11: binding changes retarget the network rules of open pages at once
      // (best-effort — the tools also re-send the context on every call).
      onBindingChanged: (conversationId, allowLoopback) => {
        for (const botId of conversations.memberBotIds(conversationId)) {
          services.browserRpc
            .setNetworkContext({ botId, conversationId, networkContext: { allowLoopback } })
            .catch(() => {
              // No open page for this pair (BROWSER_PAGE_CLOSED) or no host
              // yet (BROWSER_UNAVAILABLE): the next ensurePage re-syncs.
            });
        }
      },
    });
    // P06 environment manager: before the gateway (policy PATH) and the
    // orchestrator (request_environment + event delivery).
    // P07: 本地向量模型安装完成 → MemoryService 触发向量索引重建。Memory
    // 在 environment 之后构造，用可变引用回接（回调只在安装完成时触发，
    // 那时 memory 一定已赋值）。
    let memoryForEnv: MemoryService | null = null;
    const environment = new EnvManager({
      db: mainDb,
      paths,
      clock,
      logger,
      approvals,
      bots,
      conversations,
      publish: (event, payload) => events.emit(event as never, payload as never),
      catalog: options.envCatalog ?? loadCatalogOverride(env) ?? ENV_CATALOG,
      env,
      onEmbeddingModelInstalled: () => memoryForEnv?.handleEmbeddingModelInstalled(),
      ...(options.distroInstaller !== undefined
        ? { distroInstaller: options.distroInstaller }
        : process.platform === 'win32'
          ? {
              distroInstaller: createDistroToolchainInstaller(
                new WslSetup({ paths, runner: createWslRunner(env) }),
              ),
            }
          : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.envManagerHooks?.runSystemAction !== undefined
        ? { runSystemAction: options.envManagerHooks.runSystemAction }
        : {}),
      ...(options.envManagerHooks?.systemDetectionPath !== undefined
        ? { systemDetectionPath: options.envManagerHooks.systemDetectionPath }
        : {}),
    });
    // P12: in-distro toolchains join the WSL backend's policy PATH.
    distroToolchainPrefix = () => environment.distroToolchainPathPrefix();
    // P12 红线：register the mountable directories once the domain services
    // exist (data home + bound projects + active grants).
    const mountRegistration: MountRegistration = {
      registeredWindowsPaths: () => {
        const registered = new Set<string>([paths.home]);
        for (const conversation of conversations.list()) {
          if (conversation.projectId === null) continue;
          const project = projectsService.get(conversation.projectId);
          if (project !== null) registered.add(canonicalPath(project.path));
        }
        for (const grantPath of grants.listActivePaths()) registered.add(canonicalPath(grantPath));
        return [...registered];
      },
    };
    for (const backend of [sandbox, sandboxEnhanced]) {
      if (backend !== null && 'setRegistration' in backend) {
        (backend as { setRegistration(registration: MountRegistration): void }).setRegistration(
          mountRegistration,
        );
      }
    }
    // P07 memory & profile domain: needs approvals (profile_change) and the
    // environment manager (system-initiated embedding-model request).
    const memory = new MemoryService({
      paths,
      masterKey,
      mainDb,
      runsDb,
      clock,
      logger,
      settings,
      secrets,
      // 厂商向量来源经媒体网关按适配器路由（百炼多模态/早期向量原生端点）。
      media,
      bots,
      conversations,
      messages,
      jobs,
      runs,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      environment,
      ...(options.memoryEmbedder !== undefined ? { embedderOverride: options.memoryEmbedder } : {}),
      approvals,
      ...(parseCurationDelayMs(env) !== undefined
        ? { curationDelayMs: parseCurationDelayMs(env) }
        : {}),
      // P10 commitment linkage rides the internal event bus (start-types.ts).
      publish: (event, payload) => events.emit(event as never, payload as never),
    });
    memoryForEnv = memory;
    const budget = new BudgetService({
      db: mainDb,
      settings,
      clock,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });
    // P08 skills: registry first (the gateway needs readableDirs), the
    // importer afterwards (needs approvals + registry).
    const skills = new SkillsService({
      paths,
      db: mainDb,
      clock,
      logger,
      bots,
      publish: (event, payload) => events.emit(event as never, payload as never),
      jobs,
      environment: {
        depAvailable: (dep) => environment.depAvailable(dep),
      },
      // P12: enhanced-sandbox availability for the effective verdicts.
      enhancedSandbox: {
        available: enhancedAvailability.available,
        installHint: enhancedInstallHint,
      },
    });
    const skillImporter = new SkillImporter({
      paths,
      clock,
      logger,
      approvals,
      skills,
      environment,
      // P12: the import card's compatibility verdict reflects the enhanced
      // backend state at scan time.
      enhancedSandbox: {
        available: enhancedAvailability.available,
      },
    });
    // Staged clones never survive a restart: pending approvals are cancelled
    // below (recoverInterrupted), so nothing can decide them anymore.
    skillImporter.sweepStaging();
    // 技能市场（resources/preset-skills 随应用分发）：安装复用 registry 管线；
    // 缺依赖与增强沙箱判定与导入同源。目录缺失（异常打包）时市场列表为空。
    const skillPresets = new SkillPresetsService({
      env,
      logger,
      skills,
      environment: {
        depAvailable: (dep) => environment.depAvailable(dep),
      },
      enhancedSandbox: {
        available: enhancedAvailability.available,
      },
    });
    // P09 wiki: before the gateway-independent orchestrator wiring; owns the
    // per-bot maintenance mutex, RPC reads, weekly lint scheduling and the
    // recall cascade (the ingest/lint job runners consume it in jobs-runner).
    const wiki = new WikiService({
      paths,
      clock,
      logger,
      jobs,
      bots,
      conversations,
      messages,
      memory,
    });
    const gateway = new ToolGateway({
      paths,
      sandbox,
      // P12: enhanced-level routing (Lima/Podman) for skills declaring
      // `sandbox: enhanced` — the routing predicate asks the skills service.
      enhanced: sandboxEnhanced ?? undefined,
      enhancedRouting: {
        requiredForBot: (botId) => skills.enhancedSandboxRequired(botId),
      },
      audit,
      secrets,
      logger,
      approvals,
      grants,
      allowlist,
      unattended,
      projects: projectRuntime,
      environment: {
        toolchainPathPrefix: (platform) => environment.toolchainPathPrefix(platform),
        toolchainsRoot: () => paths.toolchainsDir,
        noteToolchainUse: () => environment.noteToolchainUse(),
      },
      skills: {
        readableDirs: (botId) => skills.readableDirs(botId),
      },
      mcpAutoApprove: (serverId) =>
        settings.get().mcpServers.find((server) => server.id === serverId)?.autoApprove === true,
    });

    // --- response loop machinery --------------------------------------------
    const engine = new PiEngine({ settings, secrets, logger });
    // D72 外部智能体引擎：进程懒启动，未被 Bot 选用时不产生任何子进程。
    const agentCatalog = effectiveAgentCatalog(extraAgentEntries);
    // D72 P4: installs land in toolchains/agents/{id}@{version}; npx agents
    // run on the environment manager's Node (installed on demand).
    const agentInstaller = new AgentInstaller({
      logger,
      toolchainsDir: paths.toolchainsDir,
      downloadsDir: paths.cacheDownloadsDir,
      npmCacheDir: paths.cacheNpmDir,
      nodeRuntime: async () =>
        nodeRuntimeFromBinDir(await environment.ensureToolchain('node'), process.platform),
      installedNode: () => {
        const row = environment.activeRowFor('node');
        const binDir = row !== null ? environment.binDirsForRow(row)[0] : undefined;
        return binDir !== undefined ? nodeRuntimeFromBinDir(binDir, process.platform).node : null;
      },
    });
    let agentsService: AgentsService | null = null;
    const agentHost = new AgentHost({
      logger,
      redact: (text) => secrets.redact(text),
      appVersion: options.appVersion ?? '0.0.0',
      // AgentsService resolves installs / system CLIs, injects API keys and
      // honours the agentLaunch test seam itself. It is assigned right below,
      // before any acquire can happen; its errors (not installed …) propagate.
      resolveLaunch: (entry) => agentsService!.resolveLaunch(entry),
      ...(options.agentSpawn !== undefined ? { spawn: options.agentSpawn } : {}),
      dataHome: paths.home,
      stateDirFor: (agentId) => agentStateDir(paths, agentId),
      processCwdFor: (agentId) => ensureAgentProcessCwd(paths, agentId),
      loadUserConfigFor: (agentId) => settings.get().agents[agentId]?.loadUserConfig === true,
    });
    // D72 宿主 MCP 桥（127.0.0.1 随机端口）：外部 Agent run 的宿主工具经它注入；
    // 随 core 启停（关闭见 close()）。
    const hostBridge = new HostMcpBridge({
      logger,
      appVersion: options.appVersion ?? '0.0.0',
      audit: (identity, action, detail) => gateway.audit(identity, action, detail),
    });
    try {
      await hostBridge.start();
    } catch (error) {
      // The core (and built-in bots) must still come up; agent runs that need
      // host tools fail with a readable reason (engine checks bridge.running).
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'host mcp bridge failed to start',
      );
    }
    // D72 P3 权限桥：外部 Agent 的 request_permission 分级 + agent_tool 审批卡。
    const agentPermissions = new AgentPermissionBridge({
      paths,
      gateway,
      approvals,
      grants,
      allowlist,
      skillDirs: (botId) => skills.readableDirs(botId),
      redact: (text) => secrets.redact(text),
      logger,
    });
    const externalEngine = new ExternalAgentEngine({
      host: agentHost,
      bridge: hostBridge,
      permissions: agentPermissions,
      catalog: () => agentCatalog,
      logger,
    });
    services.agents = { catalog: () => agentCatalog, host: agentHost, bridge: hostBridge };
    agentsService = new AgentsService({
      settings,
      secrets,
      bots,
      host: agentHost,
      installer: agentInstaller,
      catalog: () => agentCatalog,
      logger,
      publish: (event, payload) => events.emit(event, payload),
      appVersion: options.appVersion ?? '0.0.0',
      workDir: path.join(paths.cacheDir, 'agent-probe'),
      dataHome: paths.home,
      stateDirFor: (agentId) => agentStateDir(paths, agentId),
      processCwdFor: (agentId) => ensureAgentProcessCwd(paths, agentId),
      ...(agentLaunch !== undefined
        ? { launchOverride: (entry: AgentCatalogEntry) => agentLaunch(entry) ?? null }
        : {}),
      ...(options.agentSpawn !== undefined ? { spawn: options.agentSpawn } : {}),
      onConcurrencyChanged: () =>
        services.scheduler?.setConcurrency(settings.get().providerConcurrency),
    });
    services.agentsService = agentsService;
    // D72 P6 后台调用路由：有内置模型照旧；没有时后台 loop 改走外部 Agent
    // （设置「后台任务」；就绪状态取 AgentsService 的状态视图）。
    const llmRouter = new LlmRouter({
      settings,
      bots,
      builtin: engine,
      external: externalEngine,
      catalog: () => agentCatalog,
      agentView: (agentId) => {
        try {
          return agentsService!.view(agentId);
        } catch {
          return null;
        }
      },
      // 审查 C2: agent triage is charged to the daily background budget.
      budgetExceeded: (botId) => budget.exceeded(botId),
    });
    services.llmRouter = llmRouter;
    // D72: `agent:{id}` limits follow features.parallelSessions (unverified
    // agents run one session at a time, overrides clamped — design 28 §7).
    const scheduler = new Scheduler(logger, {
      agentConcurrency: (agentId, config) => {
        const entry = agentCatalog.find((candidate) => candidate.id === agentId);
        return entry === undefined ? 1 : agentConcurrency(config, entry);
      },
    });
    // P10: the schedule service is constructed after the orchestrator (it
    // delivers through the orchestrator's mailboxes); the tool facade
    // delegates lazily.
    let scheduleService: ScheduleService | null = null;
    const scheduleFacade = {
      createOnce: (input: { botId: string; conversationId: string; runAt: number; note: string }) =>
        scheduleService!.createOnce(input),
      createCron: (input: {
        botId: string;
        conversationId: string;
        expression: string;
        timezone?: string;
        note: string;
      }) => scheduleService!.createCron(input),
      listForBotInConversation: (botId: string, conversationId: string) =>
        scheduleService!.listForBotInConversation(botId, conversationId),
      cancelOwn: (botId: string, scheduleId: string) =>
        scheduleService!.cancelOwn(botId, scheduleId),
    };
    const orchestrator = new Orchestrator({
      engine,
      externalEngine,
      llmRouter,
      agentCatalog: () => agentCatalog,
      agents: agentsService,
      scheduler,
      db: mainDb,
      paths,
      gateway,
      bots,
      conversations,
      groups,
      delegations,
      messages,
      drafts,
      attachments,
      jobs,
      runs,
      usage,
      settings,
      secrets,
      approvals,
      grants,
      projects: projectRuntime,
      sandbox,
      clock,
      logger,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      triageTimeoutMs: parseTriageTimeoutMs(env),
      publish: (event, payload) => events.emit(event, payload as never),
      environment,
      memory,
      media,
      search,
      mcp,
      skills: {
        promptSection: (botId) => skills.promptSection(botId),
        readableDirs: (botId) => skills.readableDirs(botId),
        // D72 P4 审查 #3 / P6：技能生成 loop 需要内置模型，或在设置「后台任务」
        // 里允许外部 Agent 生成技能（默认关）；都没有时登记前直接告诉 Bot，而不是
        // 回「已登记」后静默不做。
        requestAuthoring: (input) => {
          if (llmRouter.resolveForBot(input.botId, 'skill_authoring') === null) {
            return {
              ok: false,
              message:
                '需要内置模型：技能生成在后台起草并验证，当前没有配置内置模型（也未在设置「后台任务」中允许外部智能体生成技能），未登记。可以把做法直接告诉用户，或请用户先在设置中配置模型。',
            };
          }
          return skills.requestAuthoring(input);
        },
        recommendedSkillsSection: () => skillPresets.promptSection(),
      },
      wiki: {
        topicsSection: (botId) => wiki.topicsSection(botId),
        search: (botId, query, limit) => wiki.search(botId, query, limit),
        readPage: (botId, pagePath) => wiki.readPage(botId, pagePath),
        enqueueIngest: (input) => wiki.enqueueIngest(input),
      },
      schedule: scheduleFacade,
      browser: services.browserRpc,
      // 技能安装（docs/design/22-file-skill-routing.md）：install_skill 的
      // 两条路径——预置轻授权装公共技能；外部仓库 prepare/commit + 阻塞审批。
      skillInstall: {
        describePreset: (presetId) => skillPresets.describePreset(presetId),
        installPreset: (presetId) => {
          const info = skillPresets.describePreset(presetId);
          skillPresets.install(presetId);
          return { skillPath: skillPresets.installedSkillPath(info.name) };
        },
        prepareFromUrl: async (input) => {
          const prepared = await skillImporter.prepare({
            sourceUrl: input.sourceUrl,
            ...(input.ref !== undefined ? { ref: input.ref } : {}),
            ...(input.subdirectory !== undefined ? { subdirectory: input.subdirectory } : {}),
            botId: input.botId,
            conversationId: input.conversationId,
          });
          if (prepared.status === 'candidates') {
            throw new AppError(
              'SKILL_IMPORT_FAILED',
              `仓库包含多个技能（${prepared.candidates.map((c) => c.name).join('、')}）：请带 subdirectory 指定其一`,
            );
          }
          return prepared;
        },
        commitImport: (prepared) => skillImporter.commit(prepared),
        discardImport: (prepared) => skillImporter.discard(prepared),
        requestApproval: async (identity, kind, payload, signal) => {
          const outcome = await approvals.request(identity, kind, payload, { signal });
          return { decision: outcome.decision, approvalId: outcome.approval.id };
        },
        failApproval: (approvalId, reason) => {
          approvals.fail(approvalId, reason);
        },
      },
    });
    // P10 schedule domain: timer + guardrails + catch-up; deliveries go via
    // the orchestrator mailboxes and commitment lookups via the memory service.
    const schedules = new ScheduleService({
      db: mainDb,
      runsDb,
      clock,
      ...(options.timers !== undefined ? { timers: options.timers } : {}),
      logger,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      bots,
      conversations,
      jobs,
      runs,
      memory,
      orchestrator,
    });
    scheduleService = schedules;
    // Commitment linkage (docs/design/04-memory.md): a due-dated commitment
    // creates a one-shot task; void / retracted cancels it. Internal events.
    events.on('memory.commitment_created', (payload) => {
      schedules.onCommitmentCreated(payload);
    });
    events.on('memory.commitment_invalidated', (payload) => {
      schedules.onCommitmentInvalidated(payload.botId, payload.commitmentId);
    });
    const lifecycle = new LifecycleService({
      paths,
      logger,
      mainDb,
      runsDb,
      bots,
      conversations,
      messages,
      drafts,
      attachments,
      jobs,
      grants,
      abortRunsForConversation: (id) => orchestrator.abortRunsForConversation(id),
      abortRunsForBot: (id) => orchestrator.abortRunsForBot(id),
      abortRunsForBotInConversation: (botId, conversationId) =>
        orchestrator.abortRunsForBotInConversation(botId, conversationId),
      onGroupMemberRemoved: (botId, conversationId) =>
        orchestrator.groupMemberRemoved(botId, conversationId),
      delegations: {
        onConversationDeleted: (conversationId) =>
          orchestrator.delegationsOnConversationDeleted(conversationId),
        prepareBotDeletion: (botId) => orchestrator.delegationsOnBotDeleted(botId),
      },
      // D72 P5: kept agent sessions die with their conversation / bot / membership.
      agentSessions: {
        onConversationDeleted: (conversationId) =>
          orchestrator.agentSessionsOnConversationDeleted(conversationId),
        prepareBotDeletion: (botId) => orchestrator.agentSessionsOnBotDeleted(botId),
        onGroupMemberRemoved: (botId, conversationId) =>
          orchestrator.agentSessionsOnGroupMemberRemoved(botId, conversationId),
      },
      memory: {
        onConversationDeleted: (conversationId, memberBotIds) =>
          memory.onConversationDeleted(conversationId, memberBotIds),
        onGroupMemberRemoved: (botId, conversationId) =>
          memory.onGroupMemberRemoved(botId, conversationId),
        prepareBotDeletion: (botId) => memory.prepareBotDeletion(botId),
        memoryItemCount: (botId) => memory.memoryItemCount(botId),
      },
      skills: {
        prepareBotDeletion: (botId) => skills.prepareBotDeletion(botId),
        skillCount: (botId) => skills.skillCount(botId),
      },
      wiki: {
        prepareBotDeletion: (botId) => wiki.prepareBotDeletion(botId),
        wikiPageCount: (botId) => wiki.pageCount(botId),
      },
      schedules: {
        deleteForConversation: (conversationId) => schedules.deleteForConversation(conversationId),
        prepareBotDeletion: (botId) => schedules.prepareBotDeletion(botId),
        cancelForBotInConversation: (botId, conversationId) =>
          schedules.cancelForBotInConversation(botId, conversationId),
      },
      // P11: pages die with their conversation / bot; clearBotData also wipes
      // the partition and tombstones the bot against late ensurePage calls.
      browser: {
        closeForConversation: async (conversationId, memberBotIds) => {
          for (const botId of memberBotIds) {
            await services.browserRpc.close({ botId, conversationId, permanent: true });
          }
        },
        closeForBotInConversation: async (botId, conversationId) => {
          await services.browserRpc.close({ botId, conversationId, permanent: true });
        },
        prepareBotDeletion: async (botId) => {
          await services.browserRpc.clearBotData({ botId });
        },
      },
    });
    const jobsRunner = new JobsRunner({
      engine,
      router: llmRouter,
      scheduler,
      jobs,
      settings,
      bots,
      conversations,
      messages,
      usage,
      runs,
      secrets,
      orchestrator,
      logger,
      memory,
      budget,
      clock,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      skills,
      sandbox,
      paths,
      publish: (event, payload) => events.emit(event as never, payload as never),
      wiki,
      schedules,
      gateway,
      attachments,
    });

    jobs.resetRunningToPending();
    // D75 §7.4: task repair → blanket interruption → re-queue + reconciliation.
    orchestrator.recoverInterrupted();
    // D75 §3.2 reaper: re-deliver unconsumed task results, enforce the
    // wall-clock / token caps.
    taskSweepTimer = setInterval(() => {
      if (taskSweepTimer === null) return;
      try {
        orchestrator.tasks.sweep();
      } catch (error) {
        warnQuietly('task sweep failed', error);
      }
    }, TASK_SETTLE_SWEEP_MS);
    taskSweepTimer.unref?.();
    // D70：存量用户（升级前已完成引导）没有管家——启动时幂等补建（不访谈，
    // 只发确定性欢迎语）。新用户的管家由引导完成时的 butler.ensure 建立。
    if (settings.get().onboarding.completed) {
      try {
        orchestrator.ensureButler();
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'butler ensure at startup failed',
        );
      }
    }
    // P06: installs never survive a restart — anything stuck `installing` is
    // a dead process's work. Doctor runs at startup and once a day
    // (docs/dev/phases/P06-environment.md 范围: 体检时机), both best-effort.
    environment.recoverInterrupted();
    // 安装通报是 Bot 内部事务（事件自带 internal 标记）：照常触发 Bot 续任务，
    // 但不进用户可见对话。
    environment.setNotifier((botId, conversationId, event, text, opts) =>
      orchestrator.deliverEventToBot(botId, conversationId, event, text, opts),
    );
    const dailyDoctorTimer = setInterval(() => {
      if (servicesClosed.closed) return;
      // P12: keep the skills enhanced-verdict cache fresh with the doctor.
      services.refreshEnhancedAvailability();
      void environment.recheck().catch((error) => {
        warnQuietly('daily environment check failed', error);
      });
    }, ENV_DOCTOR_INTERVAL_MS);
    dailyDoctorTimer.unref?.();
    envDoctorTimerRef.timer = dailyDoctorTimer;
    // P07 consolidation due-check: startup catch-up + every 30 minutes; the
    // job itself runs once per bot per local day after 03:00.
    const consolidationTimer = setInterval(() => {
      if (servicesClosed.closed) return;
      try {
        memory.enqueueDueConsolidations();
      } catch (error) {
        warnQuietly('consolidation scheduling failed', error);
      }
    }, CONSOLIDATION_CHECK_INTERVAL_MS);
    consolidationTimer.unref?.();
    consolidationTimerRef.timer = consolidationTimer;
    try {
      memory.enqueueDueConsolidations();
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'startup consolidation scheduling failed',
      );
    }
    // P09 weekly lint due-check: startup catch-up + every 30 minutes; the job
    // itself runs once per bot per week since the last wiki lint (BR-P09-003:
    // ingest completions do not reset the clock).
    const wikiLintTimer = setInterval(() => {
      if (servicesClosed.closed) return;
      void wiki.enqueueDueLints().catch((error) => {
        warnQuietly('wiki lint scheduling failed', error);
      });
    }, WIKI_LINT_CHECK_INTERVAL_MS);
    wikiLintTimer.unref?.();
    wikiLintTimerRef.timer = wikiLintTimer;
    try {
      // BR-P09-009: reconcile git worktrees against wiki_fts before anything
      // schedules maintenance (a crash between commit and incremental FTS
      // update is healed here).
      await wiki.reconcileFts();
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'startup wiki fts reconciliation failed',
      );
    }
    try {
      await wiki.enqueueDueLints();
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'startup wiki lint scheduling failed',
      );
    }
    // A close racing this best-effort check must not log into a dead logger
    // (the sync throw inside pino becomes an unhandled rejection).
    void environment.recheck().catch((error) => {
      warnQuietly('environment startup check failed', error);
    });
    jobsRunner.start();
    // P10: fire tasks missed while the app was closed, then arm the single
    // schedule timer (docs/dev/phases/P10-proactive.md 范围: 错过补触发).
    try {
      schedules.catchUpMissed();
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'startup schedule catch-up failed',
      );
    }
    schedules.start();
    // Checkpoint retention sweep (docs/dev/phases/P04-project.md): background,
    // best-effort — a swept repo only makes old reverts report unavailable.
    void projectRuntime
      .applyRetention()
      .then((swept) => {
        if (swept.length > 0) logger.info({ swept }, 'checkpoint retention applied');
      })
      .catch((error) => {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'checkpoint retention failed',
        );
      });

    services.mainDb = mainDb;
    services.runsDb = runsDb;
    services.domain = {
      settings,
      secrets,
      bots,
      avatars,
      conversations,
      messages,
      drafts,
      attachments,
      jobs,
      runs,
      usage,
      lifecycle,
      groups,
      delegations,
      providers,
      audit,
      grants,
      approvals,
      allowlist,
      unattended,
      projects: projectsService,
    };
    services.orchestrator = orchestrator;
    services.projectRuntime = projectRuntime;
    services.environment = environment;
    services.memory = memory;
    services.media = media;
    services.search = search;
    services.budget = budget;
    services.skills = skills;
    services.skillImporter = skillImporter;
    services.skillPresets = skillPresets;
    services.wiki = wiki;
    services.schedules = schedules;
    services.scheduler = scheduler;
    services.jobsRunner = jobsRunner;
    services.mcp = mcp;
    services.appMethods = {
      ...systemMethods,
      ...bindAppMethods(services),
    };
    scheduler.setConcurrency(settings.get().providerConcurrency);

    setStatus('ready');
    services.status = status;
    services.statusReason = undefined;
    logger.info({ node: process.versions.node }, 'core ready');
    return services;
  } catch (error) {
    const message = error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
    return fail(message);
  }
}

/**
 * Test hook: KEPCUP_PROFILE_CURATION_DELAY_MS collapses the curation
 * merge window in tests (production default stays PROFILE_CURATION_DELAY_MS).
 */
function parseCurationDelayMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.KEPCUP_PROFILE_CURATION_DELAY_MS;
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Test hook: KEPCUP_TRIAGE_TIMEOUT_MS overrides TRIAGE_TIMEOUT_MS (the
 * constants.ts default stays the single source of truth for production).
 */
function parseTriageTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.KEPCUP_TRIAGE_TIMEOUT_MS;
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Test/e2e hook (D72 P6, docs/dev/05-testing.md): KEPCUP_FAKE_ACP_AGENT_BIN
 * (testkit `bin/fake-acp-agent.mjs`) + KEPCUP_FAKE_ACP_AGENT_SCRIPT (scripted
 * turns, JSON) [+ KEPCUP_FAKE_ACP_AGENT_RECORD (JSONL record)] run the fake
 * ACP agent on this runtime's Node (Electron with ELECTRON_RUN_AS_NODE, the
 * target testkit `fakeAcpAgentLaunch` builds) for the catalog's `fake` entry
 * and an extra `fake-sub` entry that declares subscription login (onboarding
 * 「我有订阅」branch). Both share one script.
 */
function fakeAcpAgentSeamFromEnv(env: NodeJS.ProcessEnv): {
  catalog: AgentCatalogEntry[];
  launch: (entry: AgentCatalogEntry) => LaunchTarget | null;
} | null {
  const bin = env.KEPCUP_FAKE_ACP_AGENT_BIN;
  const script = env.KEPCUP_FAKE_ACP_AGENT_SCRIPT;
  if (bin === undefined || bin.length === 0 || script === undefined || script.length === 0) {
    return null;
  }
  const record = env.KEPCUP_FAKE_ACP_AGENT_RECORD;
  const fake = AGENT_CATALOG.find((entry) => entry.id === 'fake');
  const ids = new Set(['fake', 'fake-sub']);
  return {
    catalog:
      fake === undefined
        ? []
        : [
            {
              ...fake,
              id: 'fake-sub',
              name: 'Fake Subscription',
              tier: 'supported',
              auth: { kinds: ['subscription'], note: '订阅登录（e2e 假智能体）' },
            },
          ],
    launch: (entry) =>
      ids.has(entry.id)
        ? {
            command: process.execPath,
            args: [bin, script, ...(record !== undefined && record.length > 0 ? [record] : [])],
            env: { ELECTRON_RUN_AS_NODE: '1' },
          }
        : null,
  };
}

/**
 * Test/e2e hook (docs/dev/05-testing.md): when KEPCUP_MOCK_LLM_URL is set,
 * register (or re-point) the mock custom provider and default models. E2e
 * restarts get a fresh mock port, so the URL is aligned on every boot.
 */
function seedMockLlm(settings: SettingsService, env: NodeJS.ProcessEnv, logger: CoreLogger): void {
  const url = env.KEPCUP_MOCK_LLM_URL;
  if (url === undefined || url.length === 0) return;
  const current = settings.get();
  const mockModels: CustomModel[] = [
    // P11: the mock main model declares image input so browser_screenshot
    // payloads reach the recorded request bodies (e2e can verify them).
    { id: 'mock-main', name: 'Mock Main', contextWindow: 128_000, input: ['text', 'image'] },
    { id: 'mock-light', name: 'Mock Light', contextWindow: 32_000 },
  ];
  const existing = current.customProviders.find((c) => c.id === 'mock');
  const unchanged =
    existing !== undefined &&
    existing.baseUrl === url &&
    current.defaultMainModel === 'custom:mock/mock-main' &&
    current.defaultLightModel === 'custom:mock/mock-light';
  if (unchanged) return;
  const next = settings.update({
    customProviders: [
      ...current.customProviders.filter((c) => c.id !== 'mock'),
      { id: 'mock', name: 'Mock LLM', baseUrl: url, models: mockModels },
    ],
    defaultMainModel: 'custom:mock/mock-main',
    defaultLightModel: 'custom:mock/mock-light',
  });
  logger.info({ url }, 'mock LLM provider seeded');
  void next;
}

function failLocked(
  services: CoreServices,
  setStatus: (status: CoreStatus, reason?: string) => void,
  reason: string,
): CoreServices {
  setStatus('locked', reason);
  services.status = 'locked';
  services.statusReason = reason;
  services.logger.warn({ reason }, 'core locked');
  return services;
}

function createSystemMethods(
  services: CoreServices,
  appVersion?: string,
  /** BR-P13-006 test hook: diagnostics disk-walk entry budget (default 200k). */
  diskUsageBudget?: number,
): Record<string, RpcMethodSpec> {
  return {
    'system.ping': {
      input: voidInput,
      output: systemPingOutputSchema,
      handle: async () => ({ pong: true, ts: services.clock.now() }),
    },
    'system.info': {
      input: voidInput,
      output: systemInfoOutputSchema,
      handle: async () => ({
        version: appVersion ?? '0.0.0',
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node ?? '',
        dataDir: services.paths.home,
        coreStatus: services.status,
      }),
    },
    // P13 任务 6 诊断页（设置页「诊断」）: one read-only aggregated snapshot.
    // Registered among the SYSTEM methods (not the domain bindings) so it
    // stays reachable on locked/errored cores — exactly when diagnostics
    // matters. `probe(false)` keeps it on cached verdicts; nothing here opens
    // per-bot stores (P07 lazy-open) or mutates state.
    'diagnostics.get': {
      input: voidInput,
      output: diagnosticsOutputSchema,
      handle: async () => {
        const paths = services.paths;
        const sandboxAvailability = await services.sandbox.probe(false);
        const enhancedAvailability =
          services.sandboxEnhanced !== null ? await services.sandboxEnhanced.probe(false) : null;

        const databases: DiagnosticsDatabaseRow[] = [
          {
            name: 'main.db',
            open: services.mainDb !== null,
            ...(services.mainDb !== null ? { version: readUserVersion(services.mainDb) } : {}),
            targetVersion: migrationTargetVersion(migrationsUrl('main')),
            ...fileSizeEntry(paths.mainDbPath),
            ...(services.mainDb === null && services.statusReason !== undefined
              ? { detail: services.statusReason }
              : {}),
          },
          {
            name: 'runs.db',
            open: services.runsDb !== null,
            ...(services.runsDb !== null ? { version: readUserVersion(services.runsDb) } : {}),
            targetVersion: migrationTargetVersion(migrationsUrl('runs')),
            ...fileSizeEntry(paths.runsDbPath),
          },
          {
            // Per-bot encrypted stores: report how many exist on disk and how
            // many connections the pool holds — never open them here just to
            // read a version (P07 lazy-open semantics).
            name: 'memory.db（每 Bot）',
            open: (services.memory?.openMemoryStores ?? 0) > 0,
            ...memoryStoresEntry(paths.home),
          },
        ];

        const toolchain: DiagnosticsToolRow[] = [];
        if (services.environment !== null) {
          for (const install of services.environment.listInstalls()) {
            toolchain.push({
              id: install.id,
              kind: install.item,
              healthy: install.healthy === true,
              detail:
                install.healthy === null
                  ? '尚未体检'
                  : install.healthy
                    ? '正常'
                    : '异常（可在环境页重新安装）',
            });
          }
          for (const system of services.environment.systemStatuses()) {
            toolchain.push({
              id: `system:${system.item}`,
              kind: system.item,
              healthy: system.available,
              detail: system.detail,
            });
          }
        }

        const logsUsage = directoryUsage(paths.logsDir, diskUsageBudget);
        // BR-P13-006: keep the truncation flag (a lower-bound marker) instead
        // of dropping it — the schema/UI surface it explicitly.
        const homeUsage = directoryUsage(paths.home, diskUsageBudget);
        return {
          core: {
            status: services.status,
            ...(services.statusReason !== undefined ? { statusReason: services.statusReason } : {}),
            nodeVersion: process.versions.node ?? '',
            platform: process.platform,
            arch: process.arch,
            uptimeSec: Math.round(process.uptime()),
          },
          dataDir: paths.home,
          dataDirBytes: homeUsage.bytes,
          ...(homeUsage.truncated ? { dataDirTruncated: true } : {}),
          logsDir: paths.logsDir,
          logsBytes: logsUsage.bytes,
          ...(logsUsage.truncated ? { logsTruncated: true } : {}),
          keystore: {
            kind: services.keystoreKind,
            ok: services.domain !== null,
            ...(services.domain === null && services.statusReason !== undefined
              ? { reason: services.statusReason }
              : {}),
          },
          databases,
          sandbox: {
            backend: sandboxAvailability.backend,
            available: sandboxAvailability.available,
            ...(sandboxAvailability.reason !== undefined
              ? { reason: sandboxAvailability.reason }
              : {}),
            enhancedBackend:
              enhancedAvailability !== null &&
              (enhancedAvailability.backend === 'lima' ||
                enhancedAvailability.backend === 'podman' ||
                enhancedAvailability.backend === 'wsl')
                ? enhancedAvailability.backend
                : null,
            enhancedAvailable: enhancedAvailability?.available ?? null,
          },
          toolchain,
        };
      },
    },
  };
}

/** P13 诊断: file size entry (omitted when the file does not exist yet). */
function fileSizeEntry(filePath: string): { bytes?: number } {
  const bytes = fileSizeOrNull(filePath);
  return bytes === undefined ? {} : { bytes };
}

/**
 * P13 诊断: size + count of the per-bot memory stores (`bots/{id}/memory.db`).
 * Read-only directory scan — the stores are NOT opened (P07 lazy-open).
 */
function memoryStoresEntry(home: string): { bytes?: number; detail?: string } {
  const botsRoot = path.join(home, 'bots');
  let entries;
  try {
    entries = readdirSync(botsRoot, { withFileTypes: true });
  } catch {
    return { detail: '尚无 Bot 记忆库' };
  }
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const size = fileSizeOrNull(path.join(botsRoot, entry.name, 'memory.db'));
    if (size !== undefined) {
      count += 1;
      bytes += size;
    }
  }
  return count === 0 ? { detail: '尚无 Bot 记忆库' } : { bytes, detail: `${count} 个 Bot 记忆库` };
}

function createPlatformMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  const powerOutput = z.object({ ok: z.literal(true) });
  return {
    'system.shutdown': {
      input: voidInput,
      output: systemShutdownOutputSchema,
      handle: async () => {
        await services.close();
        return { ok: true as const };
      },
    },
    'unattended.disable': {
      input: voidInput,
      output: unattendedGetOutputSchema,
      handle: async () => services.domain!.unattended.disable('tray'),
    },
    // P10: powerMonitor bridge (docs/dev/phases/P10-proactive.md 接口与数据).
    // Suspend needs no action — timers stall with the OS and resume catch-up
    // re-fires everything missed.
    'power.resume': {
      input: voidInput,
      output: powerOutput,
      handle: async () => {
        const missed = services.schedules?.catchUpMissed() ?? 0;
        services.logger.info({ missed }, 'power resume: schedule catch-up done');
        return { ok: true as const };
      },
    },
    'power.suspend': {
      input: voidInput,
      output: powerOutput,
      handle: async () => {
        services.logger.info('power suspend');
        return { ok: true as const };
      },
    },
    // --- P13 任务 2: update gate (docs/dev/phases/P13-release.md) -------------
    // The main process's electron-updater asks before installing: in-flight
    // executions are never force-interrupted — the gate waits, and only an
    // explicit user confirmation may cancel them (update.cancelActive).
    'update.activeRuns': {
      input: voidInput,
      output: updateActiveRunsOutputSchema,
      handle: async () => {
        // Fail-closed (红线「不得强制中断」): while the core is starting /
        // locked / errored the in-flight state is UNKNOWN — throwing makes
        // the main-process gate treat it as busy instead of empty.
        if (services.domain === null || services.orchestrator === null) {
          throw new AppError('INTERNAL', 'core services not ready');
        }
        return {
          runs: services.domain.runs.listActive().map((run) => ({
            id: run.id,
            botId: run.botId,
            conversationId: run.conversationId,
            loopType: run.loopType,
            status: run.status,
          })),
        };
      },
    },
    'update.cancelActive': {
      input: updateCancelActiveInputSchema,
      output: updateCancelActiveOutputSchema,
      // The RPC server validated input against updateCancelActiveInputSchema.
      handle: async (input) => {
        const { reason } = input as { reason: string };
        if (services.orchestrator === null || services.domain === null) {
          // Nothing can be in flight before services exist.
          return { cancelled: [], failed: [] };
        }
        return services.orchestrator.cancelAllActive(reason);
      },
    },
  };
}

/**
 * Migration files live under `packages/core/migrations/{main,runs}/`; this
 * module sits at `src/` (tests) or `dist/` (built), both one level below the
 * package root.
 */
export function migrationsUrl(kind: 'main' | 'runs' | 'memory'): string {
  return fileURLToPath(new URL(`../migrations/${kind}/`, import.meta.url));
}
