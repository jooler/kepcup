import { existsSync, mkdirSync } from 'node:fs';
import { rmSync } from './infra/fs-rm.js';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AGENT_CATALOG,
  AppError,
  CONNECTOR_INDEX_MAX_BYTES,
  CONNECTOR_INDEX_PUBLIC_KEYS,
  SETTING_CARD_RESOLVED_EVENT,
  TASK_SETTLE_SWEEP_MS,
  findAgentEntry,
  systemInfoOutputSchema,
  systemPingOutputSchema,
  systemShutdownOutputSchema,
  unattendedGetOutputSchema,
  remoteStatusOutputSchema,
  remoteCreatePairingOutputSchema,
  remoteConfigSetInputSchema,
  remoteConfigSetOutputSchema,
  updateActiveRunsOutputSchema,
  updateCancelActiveInputSchema,
  browserControlReturnedInputSchema,
  browserControlReturnedOutputSchema,
  updateCancelActiveOutputSchema,
  diagnosticsOutputSchema,
  chatModelOptions,
  shareConsumeInputSchema,
  shareConsumeOutputSchema,
  shareTargetsSchema,
  type AgentCatalogEntry,
  type AppNoticePayload,
  type Bot,
  type CoreStatus,
  type CustomModel,
  type ShareConsumeInput,
  type ShareConsumeOutput,
  type ShareTargets,
} from '@kepcup/shared';
import type {
  ConnectorIndexPublicKey,
  DiagnosticsDatabaseRow,
  DiagnosticsToolRow,
  PreregisteredClientTable,
} from '@kepcup/shared';
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
import { realTimerScheduler, systemClock, type Clock, type TimerScheduler } from './infra/clock.js';
import { createEventBus, type EventBus } from './infra/events.js';
import { withDirectConversationBots } from './infra/conversation-events.js';
import type { RpcMethodSpec, RpcServerHandle } from './rpc/server.js';
import { SettingsService } from './domain/settings.js';
import { SecretsService } from './domain/secrets.js';
import { BotsService } from './domain/bots.js';
import { BotAvatarService } from './domain/avatars.js';
import { BotTemplateService } from './domain/bot-templates.js';
import { ConversationsService } from './domain/conversations.js';
import { MessagesService } from './domain/messages.js';
import { StickiesService } from './domain/stickies.js';
import { AttachmentsService } from './domain/attachments.js';
import { JobsService } from './domain/jobs.js';
import { RunsService } from './domain/runs.js';
import { UsageService } from './domain/usage.js';
import { LifecycleService } from './domain/lifecycle.js';
import { ProjectsService } from './domain/projects.js';
import { DelegationsService } from './domain/delegations.js';
import { ProvidersService } from './domain/providers.js';
import { AuditService } from './domain/audit.js';
import { GrantsService } from './permissions/grants.js';
import { PermissionRevocations } from './permissions/revocations.js';
import { BrowserProfilesService } from './browser/profiles.js';
import { ApprovalsService } from './permissions/approvals.js';
import { AllowlistService } from './permissions/allowlist.js';
import { UnattendedService } from './permissions/unattended.js';
import { CheckpointService } from './workdir/checkpoints.js';
import { WorkdirRuntime } from './workdir/service.js';
import { WorkdirsService } from './domain/workdirs.js';
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
import { ToolEffectsStore } from './agent/effects/store.js';
import { createEffectRecorder } from './agent/effects/recorder.js';
import { modelRetryPolicyFromEnv } from './agent/model-retry.js';
import { ExternalAgentEngine } from './agent/external/engine.js';
import { LlmRouter } from './agent/llm-router.js';
import { AgentPermissionBridge } from './agent/external/permission-bridge.js';
import { HostMcpBridge } from './agent/external/mcp-bridge.js';
import { AgentHost, withUserPath, type AgentSpawner } from './agent/external/host.js';
import { assertAgentSelectable, effectiveAgentCatalog } from './agent/external/catalog.js';
import { agentConcurrency } from './agent/external/providers/index.js';
import { AgentInstaller, nodeRuntimeFromBinDir } from './agent/external/installer.js';
import { AgentsService } from './domain/agents.js';
import type { LaunchTarget } from './agent/external/types.js';
import { Scheduler } from './scheduler/scheduler.js';
import { SlotYieldingLeaseService } from './scheduler/slot-yielding-lease.js';
import { Orchestrator } from './dispatch/orchestrator.js';
import { ShareIntakeService } from './share/service.js';
import { episodeLimitsFromEnv } from './dispatch/episodes.js';
import { JobsRunner } from './dispatch/jobs-runner.js';
import { EnvManager } from './env/manager.js';
import { ENV_CATALOG, loadCatalogOverride } from './env/catalog.js';
import type { CatalogEntry } from './env/catalog.js';
import { MemoryService } from './memory/service.js';
import { MediaService } from './media/service.js';
import { SearchService } from './search/service.js';
import { McpService } from './mcp/service.js';
import { decideMcpTool, type McpToolDecision } from './mcp/policy.js';
import type { Embedder } from './memory/embedder.js';
import { SkillImporter } from './skills/library.js';
import { SkillsService } from './skills/registry.js';
import { SkillPresetsService } from './skills/presets.js';
import { WikiService } from './wiki/service.js';
import { WikiIndexManager } from './wiki/index-manager.js';
import { ScheduleService } from './schedule/service.js';
import { MemoService } from './workbench/memo-service.js';
import { TodoService } from './workbench/todo-service.js';
import { buildWorkbenchSection, describeTime } from './workbench/context.js';
import { WatchService } from './watch/service.js';
import { MailService } from './mail/service.js';
import { HandoverHost } from './dispatch/handover.js';
import { SettingsCatalogHost } from './settings/host.js';
import { applyBotProfileUpdate, createPermissionEffects } from './settings/bot-profile-update.js';
import { SettingsWriteLock } from './settings/write-lock.js';
import { HandoverRegistry } from './handover/registry.js';
import { HandoverStore } from './handover/store.js';
import { ModelAdapter, type HandoverAgentPolicy } from './handover/adapters/model.js';
import { AppAdapter } from './handover/adapters/app.js';
import { McpAdapter } from './handover/adapters/mcp.js';
import { MailAdapter } from './handover/adapters/mail.js';
import { ScheduleAdapter } from './handover/adapters/schedule.js';
import { WatchAdapter } from './handover/adapters/watch.js';
import { SkillAdapter } from './handover/adapters/skill.js';
import { MemoryAdapter, type HandoverMemoryPort } from './handover/adapters/memory.js';
import { WikiAdapter } from './handover/adapters/wiki.js';
import { WidgetAdapter } from './handover/adapters/widget.js';
import type { HandoverBotWriter } from './handover/adapters/common.js';
import type { HandoverToolFacade } from './tools/handover-tools.js';
import type { OrchestratorTodoFacade, OrchestratorWatchFacade } from './dispatch/orchestrator.js';
import type { ScheduleToolFacade } from './tools/schedule-tools.js';
import type { WorkbenchToolFacade } from './tools/workbench-tools.js';
import {
  createBrowserHostRpc,
  type BrowserHostRpc,
  type DeferredBrowserHostRpc,
} from './browser/facade.js';
import { createAppServices, type AppServices } from './apps/index.js';
import { createAppRuntime, type AppRuntime } from './apps/runtime.js';
import { McpbInstaller, envManagerRuntimeResolver } from './apps/mcpb/index.js';
import { AppToolGrants } from './apps/grants.js';
import { GitRemoteGrants } from './permissions/git-remote-grants.js';
import { TaintService } from './apps/taint.js';
import { McpAppUiService } from './apps/ui/service.js';
import { bindAppsUiMethods } from './rpc/apps-ui-bindings.js';
import { WidgetService } from './widgets/service.js';
import { WidgetQueryRunner } from './widgets/query-runner.js';
import { WidgetCraftService } from './widgets/craft/service.js';
import {
  createWidgetPreviewRpc,
  createWidgetPreviewRunner,
  type DeferredWidgetPreviewRpc,
  type WidgetPreviewHostRpc,
} from './widgets/preview.js';
import { bindWidgetsUiMethods } from './rpc/widgets-ui-bindings.js';
import { bindFilesPreviewMethods } from './rpc/files-preview-bindings.js';
import { ConnectorCatalog } from './apps/catalog.js';
import { createGuardedMcpFetch, LocalConnectors } from './apps/local-connectors.js';
import { DirectorySync } from './apps/directory-sync.js';
import { createSafeFetch } from './apps/auth/safe-fetch.js';
import { ConnectedApps, isExposableStatus } from './apps/exposure.js';
import { AppConnectionsService, createBotAppGrantWriter } from './apps/connections.js';
import { AppSkillsOffers } from './apps/skills-offer.js';
import { ToolLockService } from './apps/tool-lock.js';
import {
  createShellHostRpc,
  type DeferredShellHostRpc,
  type ShellHostRpc,
} from './apps/shell-facade.js';
import { bindAppMethods } from './rpc/bindings.js';
import { RemoteHub, type RemoteHostOptions } from './remote/hub.js';
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
   * D73 test hook: the system-shell capability hosted by the main process
   * (`shell.openExternal`). The Electron entry binds the deferred default to
   * the platform channel; tests inject a fake (typically driving testkit's
   * `simulateBrowser`) and count the calls.
   */
  shellRpc?: ShellHostRpc;
  /**
   * D87 P3b test hook: the widget preview host (`widgetPreview.run`, S2). The Electron entry
   * binds the deferred default to the platform channel; tests may inject a fake.
   */
  widgetPreviewRpc?: Pick<WidgetPreviewHostRpc, 'run'>;
  /**
   * D73 test hooks for the OAuth engine (all honoured only when NODE_ENV=test in
   * a test-hooks build, like KEPCUP_KEYSTORE): extra loopback hosts the SSRF-safe
   * fetch may reach over plain http (`hostname` or `host:port`, e.g. the fake
   * OAuth server), the CIMD client_id URL (a testkit file-server document), the
   * fixed callback port candidates and the flow time limit.
   */
  oauthLoopbackAllowlist?: string[];
  oauthCimdUrl?: string;
  oauthCallbackPorts?: number[];
  oauthFlowTimeoutMs?: number;
  /** D73 P2 test hook: pre-registered OAuth client table (replaces oauth-clients.json). */
  oauthPreregisteredClients?: PreregisteredClientTable;
  /**
   * D73 P3 §7.6 test hook (NODE_ENV=test in a test-hooks build only): maps a catalog entry's
   * declared https skill source to a local fixture repository (the catalog schema rejects local
   * paths, so tests can only get one in through here).
   */
  appSkillSourceOverride?: (source: string) => string;
  /**
   * D73 P3 §7.1 test hook (NODE_ENV=test in a test-hooks build only): the signed-directory
   * public key list (production list lives in shared `CONNECTOR_INDEX_PUBLIC_KEYS`, empty
   * until the real key exists), the directory base URL (a loopback fake; its host is added
   * to the SSRF-safe fetch allowlist) and the timer cadence. Without `keys` here the
   * production list applies.
   */
  directorySync?: {
    keys?: ConnectorIndexPublicKey[];
    baseUrl?: string;
    intervalMs?: number;
    initialDelayMs?: number;
  };
  /**
   * D94 test hook (NODE_ENV=test in a test-hooks build only): overrides the
   * share intake daily sweep cadence so integration tests can observe the
   * timer firing without waiting a real day.
   */
  shareSweepIntervalMs?: number;
  /**
   * D73 P1 test hook (NODE_ENV=test in a test-hooks build only): tools seen for the
   * first time are approved straight away, like the stored-server baseline — so
   * fixtures that add a server through `settings.update` keep working. A tool whose
   * definition later *changes* is still locked.
   */
  toolLockTrustFirstList?: boolean;
  /**
   * D73 P2 test hook (test-hooks builds only): managed runtimes the MCPB installer resolves
   * without the environment manager (e.g. `{ node: { command: process.execPath } }`).
   */
  mcpbRuntimes?: Partial<Record<'node' | 'python' | 'uv', { command: string; version?: string }>>;
  /**
   * D73 P1 test hook (NODE_ENV=test in a test-hooks build only): the connector catalog the
   * Bots' `<available_apps>` / app tools are built from. Test-hook builds default to an
   * EMPTY catalog (so unrelated suites do not see the shipped entries in their prompts).
   */
  connectorCatalog?: ConnectorCatalog;
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
  /**
   * D102 远程宿主形态（headless 服务端）：注入直连监听适配层（替代默认的
   * RelayClient 出站中连）并启用常驻连接语义。桌面 / 测试缺省 undefined，
   * RemoteHub 走既有路径。
   */
  remote?: RemoteHostOptions;
}

export interface CoreDomainServices {
  /** W2 外部副作用台账（runs.db tool_effects）。 */
  effects: ToolEffectsStore;
  /** W3 用户撤销授权的内部事件（permission.revoked）：TaskHost 据此中断进行中的任务。 */
  revocations: PermissionRevocations;
  /** W8 共享浏览器资料（settings.browserProfiles）与 Bot 的资料切换。 */
  browserProfiles: BrowserProfilesService;
  settings: SettingsService;
  secrets: SecretsService;
  bots: BotsService;
  avatars: BotAvatarService;
  /** D48 Bot 模板导出/导入（`bots.template.*` RPC）。 */
  botTemplates: BotTemplateService;
  audit: AuditService;
  conversations: ConversationsService;
  messages: MessagesService;
  /** 辅助阅读便签（main.db stickies）。 */
  stickies: StickiesService;
  attachments: AttachmentsService;
  jobs: JobsService;
  runs: RunsService;
  usage: UsageService;
  lifecycle: LifecycleService;
  projects: ProjectsService;
  /** 跨 Bot 委派行（D71）。 */
  delegations: DelegationsService;
  providers: ProvidersService;
  grants: GrantsService;
  approvals: ApprovalsService;
  allowlist: AllowlistService;
  unattended: UnattendedService;
  workdirs: WorkdirsService;
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
  /** D94 分享接收（Share Extension）：null while locked / errored. */
  share: ShareIntakeService | null;
  /** Workdir runtime (P04): binding, leases, checkpoints, git remote. */
  workdirRuntime: WorkdirRuntime | null;
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
  /** P08 skills domain (null while locked / errored). */
  skills: SkillsService | null;
  /** P08 git import pipeline (null while locked / errored). */
  skillImporter: SkillImporter | null;
  /** P08 skill marketplace over the app-shipped preset catalog (null likewise). */
  skillPresets: SkillPresetsService | null;
  /** P09 wiki domain (null while locked / errored). */
  wiki: WikiService | null;
  /** D92 T1b WP9: project wiki wiki.db connection pool (null with the wiki domain). */
  wikiIndexes: WikiIndexManager | null;
  /** P10 proactive-messaging domain (null while locked / errored). */
  schedules: ScheduleService | null;
  /** D90 工作台事项 (null while locked / errored). */
  todos: TodoService | null;
  /** D90 工作台备忘 (null while locked / errored). */
  memos: MemoService | null;
  /** W7 确定性监看 (null while locked / errored). */
  watches: WatchService | null;
  /** D84 邮件通道 (null while locked / errored). */
  mail: MailService | null;
  /** D88 Bot 资产移交 (null while locked / errored). */
  handover: HandoverHost | null;
  /**
   * 对话内应用设置（todo/conversational-app-setup.md）：目录适配器、条目级 CAS 写入与设置卡
   * (null while locked / errored)。
   */
  settingsCatalog: SettingsCatalogHost | null;
  scheduler: Scheduler | null;
  jobsRunner: JobsRunner | null;
  /**
   * P11 browser capability (always present; the deferred default fails calls
   * with BROWSER_UNAVAILABLE until the process entry binds the platform port).
   */
  browserRpc: DeferredBrowserHostRpc;
  /** D73 system shell (open the browser for OAuth consent); same deferred pattern as browserRpc. */
  shellRpc: DeferredShellHostRpc;
  /** D87 P3b widget preview host (S2 of the authoring loop); same deferred pattern as shellRpc. */
  widgetPreviewRpc: DeferredWidgetPreviewRpc;
  /** D73 connected apps: Token Vault, connection rows, interactive auth flows (null while locked / errored). */
  apps: AppServices | null;
  /** D73 runtime auth (provider registry, disconnect / removal, audit); null with `apps`. */
  appRuntime: AppRuntime | null;
  /** D73 P2 §6.5 MCPB local bundle installer; null with `apps`. */
  mcpb: McpbInstaller | null;
  /** D73 P1 tool-definition lock (all MCP servers); null with `apps`. */
  toolLock: ToolLockService | null;
  /** D73 P1 persistent per-(bot, connection, tool) grants; null with `apps`. */
  appToolGrants: AppToolGrants | null;
  /** D73 P2 taint state ((bot, conversation) read connected-app data → egress approvals). */
  taint: TaintService | null;
  /** D73 P3 §7.5 MCP Apps rendering (UI resources, UI-initiated tool calls, links); null with `apps`. */
  appUi: McpAppUiService | null;
  /** D81 Bot 自制交互组件（制作 loop 交付落库发卡 + 沙箱资源登记，D87）；null with `apps`. */
  widgets: WidgetService | null;
  /** D87 组件制作 loop（widget_craft 的执行体；基准评测直接调用）；null with `widgets`. */
  widgetCraft: WidgetCraftService | null;
  /** D73 P1 connection → tool exposure facade (catalog connections as synthesized servers). */
  connectedApps: ConnectedApps | null;
  /** D73 P1 connector catalog (gate-filtered). */
  connectorCatalog: ConnectorCatalog | null;
  /** 本机连接（Bot 读文档生成、只存本机的目录条目）：提案 / 确认 / 删除；null with `apps`. */
  localConnectors: LocalConnectors | null;
  /** D73 P3 signed directory sync (daily pull of the signed index; null before ready). */
  directorySync: DirectorySync | null;
  /** D73 P1 catalog connection service (connect flow host, tools / policy / grants management). */
  appConnections: AppConnectionsService | null;
  /** D73 P3 §7.6 bundled-skills offers after a catalog connection (installs go through skill_import). */
  appSkills: AppSkillsOffers | null;
  appMethods: Record<string, RpcMethodSpec>;
  platformMethods: Record<string, RpcMethodSpec>;
  /** D96 远程遥控收发中枢（端点注册表 / 事件扇出 / remote.* 处理）；成功启动后非空。 */
  remote: RemoteHub | null;
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

/** D94 §6.7：分享清扫「启动 + 每日」的每日间隔。 */
const SHARE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Consolidation due-check cadence (P07 任务 9: daily after 03:00 local). */
const CONSOLIDATION_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** Weekly wiki lint due-check cadence (P09; the job itself gates to one week). */
const WIKI_LINT_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Assembles the whole core service: paths, logger, keystore, master key,
 * encrypted databases, domain services and the response-loop machinery.
 * Startup order follows docs/dev/02-architecture.md ("启动、退出与崩溃恢复").
 *
 * An existing database while the master key is missing leads to `locked`;
 * a new key is never generated in that case.
 */
export async function createCoreServices(options: CoreServicesOptions = {}): Promise<CoreServices> {
  // Per-instance (not module state): every core built later in the same process —
  // each test builds many — must not inherit an earlier core's close().
  /** Holder so services.close() can clear the doctor timer created later. */
  const envDoctorTimerRef: { timer: NodeJS.Timeout | null } = { timer: null };
  /** Holder for the consolidation due-check timer (P07). */
  const consolidationTimerRef: { timer: NodeJS.Timeout | null } = { timer: null };
  /** Holder for the wiki lint due-check timer (P09). */
  const wikiLintTimerRef: { timer: NodeJS.Timeout | null } = { timer: null };
  /** Holder for the share intake daily sweep timer (D94 §6.7). */
  const shareSweepTimerRef: { timer: NodeJS.Timeout | null } = { timer: null };
  /** Set by close() so late best-effort callbacks stop touching dead resources. */
  const servicesClosed: { closed: boolean } = { closed: false };
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
  // 单聊 conversation.updated 出核前补 bot（见 conversation-events.ts）；
  // 查询函数在域服务建好后赋值，锁定/未解锁期间原样放行。
  let lookupDirectBot: ((botId: string) => Bot | null) | null = null;
  const events = withDirectConversationBots(createEventBus<CoreEventsMap>(), () => lookupDirectBot);
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
  // D92 T1a WP8 e2e seam: KEPCUP_TEST_EPISODE_LIMITS="hops,pair" overrides the
  // episode breaker thresholds (episode-breaker.spec scripts a short ping-pong
  // instead of 12/8 live mentions). Test-hook builds only: the packaged
  // artifact folds this whole expression away.
  const episodeLimitsSeam = __KEPCUP_TEST_HOOKS__ === true ? episodeLimitsFromEnv(env) : undefined;
  const extraAgentEntries = options.agentCatalog ?? fakeAgentSeam?.catalog ?? [];
  const agentLaunch = options.agentLaunch ?? fakeAgentSeam?.launch;
  const wslRunner: WslRunner =
    options.wslRunner ??
    (wslFixtureScenario !== null
      ? createWslFixtureRunner(wslFixtureScenario)
      : createWslRunner(env));
  // KEPCUP_WSL_PROMPT=off（e2e seam，同 KEPCUP_ONBOARDING）：真实 Windows CI
  // runner 上 WSL 未就绪时首启「沙箱准备」提示框常开，盖住 backdrop 拦掉后续
  // 一切点击；off 即不创建 WslSetup（`sandbox.wslStatus` 回 applicable=false，
  // 提示框与向导走平台降级展示）。fixture 场景不读这个 seam，sandbox-wizard
  // 用例照常走真实路径。字符串必须留在 start.ts（打包产物 FORBIDDEN_MARKERS
  // 依赖 __KEPCUP_TEST_HOOKS__ 折叠把它 DCE 掉）。
  const wslSetupSuppressedByTestSeam =
    __KEPCUP_TEST_HOOKS__ === true && env.KEPCUP_WSL_PROMPT === 'off';
  const wslSetup =
    wslFixtureScenario !== null || (process.platform === 'win32' && !wslSetupSuppressedByTestSeam)
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
  // Dock / Finder launches omit `~/.local/bin` and Homebrew — system Agent
  // CLIs (InkCop `inkcop-acp`) and `#!/usr/bin/env node` shebangs need them.
  process.env.PATH = withUserPath(process.env).PATH ?? process.env.PATH;

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
    share: null,
    workdirRuntime: null,
    environment: null,
    memory: null,
    media: null,
    search: null,
    mcp: null,
    agents: null,
    agentsService: null,
    llmRouter: null,
    skills: null,
    skillImporter: null,
    skillPresets: null,
    wiki: null,
    wikiIndexes: null,
    schedules: null,
    todos: null,
    memos: null,
    watches: null,
    mail: null,
    handover: null,
    settingsCatalog: null,
    scheduler: null,
    jobsRunner: null,
    browserRpc: createBrowserHostRpc(),
    shellRpc: createShellHostRpc(),
    widgetPreviewRpc: createWidgetPreviewRpc(),
    apps: null,
    appRuntime: null,
    mcpb: null,
    toolLock: null,
    appToolGrants: null,
    taint: null,
    appUi: null,
    widgets: null,
    widgetCraft: null,
    connectedApps: null,
    connectorCatalog: null,
    localConnectors: null,
    directorySync: null,
    appConnections: null,
    appSkills: null,
    appMethods: {},
    platformMethods: {},
    remote: null,
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
      await services.remote?.close();
      services.jobsRunner?.stop();
      services.directorySync?.stop();
      services.appSkills?.stop();
      try {
        services.schedules?.stop();
      } catch {
        // Timer already gone.
      }
      try {
        services.watches?.stop();
      } catch {
        // Timer already gone.
      }
      try {
        services.mail?.stop();
      } catch {
        // Session already gone.
      }
      envDoctorTimerRef.timer?.unref?.();
      if (envDoctorTimerRef.timer) clearInterval(envDoctorTimerRef.timer);
      if (consolidationTimerRef.timer) clearInterval(consolidationTimerRef.timer);
      if (wikiLintTimerRef.timer) clearInterval(wikiLintTimerRef.timer);
      if (shareSweepTimerRef.timer) clearInterval(shareSweepTimerRef.timer);
      if (taskSweepTimer !== null) clearInterval(taskSweepTimer);
      taskSweepTimer = null;
      try {
        services.memory?.closeAll();
      } catch {
        // Connections may already be gone (bot deletion race); nothing to do.
      }
      try {
        services.wikiIndexes?.closeAll();
      } catch {
        // Same posture as memory: nothing to do on a close race.
      }
      try {
        await services.apps?.shutdown();
      } catch {
        // Auth flows may already be gone; nothing to do.
      }
      try {
        await services.mcp?.closeAll();
      } catch {
        // MCP servers may already be gone; nothing to do.
      }
      services.agentsService?.dispose();
      services.agents?.host.dispose();
      await services.agents?.bridge.stop().catch(() => undefined);
      // D81：杀掉组件查询子进程（它另开了一条到 main.db 的只读连接）。
      services.widgets?.dispose();
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
  if (options.shellRpc !== undefined) services.shellRpc.bindFacade(options.shellRpc);
  if (options.widgetPreviewRpc !== undefined) {
    services.widgetPreviewRpc.bindFacade(options.widgetPreviewRpc);
  }

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
    const settings = new SettingsService(mainDb, clock, logger);
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
      return {
        id: agentId,
        permission: entry.tier === 'preview' ? 'ask' : 'workspace',
        model: current.agents[agentId]?.model ?? '',
      };
    });
    lookupDirectBot = (botId) => bots.get(botId);
    const avatars = new BotAvatarService({ paths, clock, bots });
    const conversations = new ConversationsService(mainDb, clock);
    const messages = new MessagesService(mainDb, clock);
    // 项目组域服务先于 orchestrator 构造；removeMemberCascade 闭包引用其后的
    // lifecycle（仅运行期触发，无 TDZ 问题）。显式类型标注打断 projects →
    // lifecycle → orchestrator → projects 的推断环。
    const projects: ProjectsService = new ProjectsService({
      db: mainDb,
      clock,
      conversations,
      bots,
      removeMemberCascade: (conversationId, botId) =>
        lifecycle.removeProjectMember(conversationId, botId),
      publishConversation: (conversationId) => {
        const conversation = conversations.get(conversationId);
        if (!conversation) return;
        // 项目组带上成员头像预览：通讯录里的项目组卡片要画头像堆叠
        //（members 变动、更名、负责人更换都走这条推送）。
        events.emit('conversation.updated', {
          conversation:
            conversation.type === 'project'
              ? { ...conversation, memberPreviews: projects.memberPreviews(conversationId) }
              : conversation,
        });
      },
      // 可见系统消息（负责人更换 / 成员加入）：与 workdir/service.ts 的
      // #systemMessage 同一写法与发布方式。
      appendSystemEvent: ({ conversationId, event, text }) => {
        const message = messages.append({
          conversationId,
          senderType: 'system',
          kind: 'system_event',
          event,
          text,
        });
        events.emit('message.created', { conversationId, message });
      },
      workdirLabelOf: (conversationId) => {
        const conversation = conversations.get(conversationId);
        if (conversation === null || conversation.workdirId === null) return null;
        return workdirsService.get(conversation.workdirId)?.name ?? null;
      },
    });
    bots.attachLeadProjectGuard((botId) => projects.ledProjectsOf(botId));
    const stickies = new StickiesService(mainDb, clock);
    const delegations = new DelegationsService(mainDb, clock);
    const attachments = new AttachmentsService({ db: mainDb, paths, clock });
    const jobs = new JobsService(mainDb, clock);
    const runs = new RunsService(runsDb, clock, logger);
    // W2 外部副作用台账（runs.db tool_effects）：store 供恢复 / RPC，recorder
    // 注入两个工具执行入口（PiEngine、宿主 MCP 桥）。
    const effects = new ToolEffectsStore(runsDb, clock);
    const usage = new UsageService(mainDb, clock);
    // 国内厂商媒体网关先建（providers 按能力测试要路由到这里）。
    const media = new MediaService({ settings, secrets, logger, usage });
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
    // D73 连接应用：Token Vault + 连接行 + 交互授权流程（运行时 registry 由 McpService 一侧接入）。
    const apps = createAppServices({
      db: mainDb,
      secrets,
      settings,
      clock,
      logger,
      events,
      shell: services.shellRpc,
      env,
      testHooks: __KEPCUP_TEST_HOOKS__ === true,
      test: {
        cimdUrl: options.oauthCimdUrl,
        // e2e（真实 Electron，没有 createCore 选项可传）：KEPCUP_TEST_OAUTH_LOOPBACK=host[,host…]；
        // 同样只在测试钩子构建里存在，`createAppServices` 另要求 NODE_ENV=test。
        loopbackAllowlist:
          options.oauthLoopbackAllowlist ??
          (__KEPCUP_TEST_HOOKS__ === true
            ? env.KEPCUP_TEST_OAUTH_LOOPBACK?.split(',')
                .map((host) => host.trim())
                .filter((host) => host.length > 0)
            : undefined),
        callbackPorts: options.oauthCallbackPorts,
        flowTimeoutMs: options.oauthFlowTimeoutMs,
        preregisteredClients: options.oauthPreregisteredClients,
      },
    });
    const providers = new ProvidersService({ settings, secrets, logger, media });
    const audit = new AuditService({ db: mainDb, clock });
    // D73 runtime auth: McpService ← registry (OAuth server tokens), interactive flows → registry.
    const appRuntime = createAppRuntime({ apps, mcp, secrets, audit, logger, clock, events });
    // D73 P1: tool-definition lock for every MCP server + persistent app-tool grants. The lock
    // registers each fresh tools/list (McpService) and filters what a Bot is offered.
    // D73 P1: the connector catalog + the exposure facade (catalog connections → synthesized
    // servers, risk overlay, Bot prompt sections). The tool lock reads catalog `toolPolicy`
    // through it, so it is declared first and filled right after the lock exists.
    // D73 P3 §7.1: signed directory index (daily pull → verify → merge with the bundled
    // snapshot). An empty production key list = disabled, snapshot only.
    const directoryTest = __KEPCUP_TEST_HOOKS__ === true && env.NODE_ENV === 'test';
    const directoryBase = directoryTest ? options.directorySync?.baseUrl : undefined;
    const directorySync = new DirectorySync({
      dir: path.join(paths.cacheDir, 'directory'),
      keys:
        (directoryTest ? options.directorySync?.keys : undefined) ?? CONNECTOR_INDEX_PUBLIC_KEYS,
      fetch: createSafeFetch({
        maxBytes: CONNECTOR_INDEX_MAX_BYTES,
        ...(directoryBase !== undefined ? { loopbackHosts: [new URL(directoryBase).host] } : {}),
      }),
      clock,
      logger,
      enabled: () => settings.get().apps.directorySync,
      ...(directoryBase !== undefined ? { baseUrl: directoryBase } : {}),
      ...(directoryTest && options.directorySync?.intervalMs !== undefined
        ? { intervalMs: options.directorySync.intervalMs }
        : {}),
      ...(directoryTest && options.directorySync?.initialDelayMs !== undefined
        ? { initialDelayMs: options.directorySync.initialDelayMs }
        : {}),
    });
    const connectorCatalog =
      options.connectorCatalog ??
      new ConnectorCatalog({
        env,
        logger,
        directory: directorySync,
        ...(__KEPCUP_TEST_HOOKS__ === true && env.NODE_ENV === 'test' && !env.KEPCUP_CONNECTORS
          ? { source: { entries: [], iconsDir: null } }
          : {}),
      });
    // 本机连接（todo/local-connector-authoring.md）：目录的第三个来源。无论目录是内部构造还是
    // 测试注入的，都在这里接上；冲突检查需要目录，所以事后互相接入。
    const localConnectors = new LocalConnectors({
      settings,
      clock,
      logger,
      events,
      auditor: appRuntime.auditor,
      store: apps.store,
      disconnector: appRuntime.disconnector,
      loopbackAllowlist: apps.loopbackAllowlist,
    });
    connectorCatalog.attachLocal(localConnectors);
    localConnectors.attachCatalog(connectorCatalog);
    // 本机条目的地址由 Bot 提供：其 MCP 流量同样走 SSRF 守卫（连接时校验解析地址、同源重定向）。
    const guardedMcpFetch = createGuardedMcpFetch(apps.loopbackAllowlist);
    mcp.attachHttpFetch((server) => {
      const row = apps.store.get(server.id);
      return row !== null && connectorCatalog.isLocal(row.connectorId)
        ? guardedMcpFetch
        : undefined;
    });
    const connectedAppsRef: { current?: ConnectedApps } = {};
    const toolLock = new ToolLockService({
      db: mainDb,
      clock,
      store: apps.store,
      logger,
      settings,
      catalogPolicyFor: (connectionId) => connectedAppsRef.current?.catalogPolicyFor(connectionId),
      onStatus: (payload) => events.emit('apps.connection_status', payload),
      hasTokens: (connectionId) => apps.vault.getTokens(connectionId) !== null,
      trustFirstList:
        __KEPCUP_TEST_HOOKS__ === true &&
        env.NODE_ENV === 'test' &&
        options.toolLockTrustFirstList === true,
    });
    mcp.attachToolLock(toolLock);
    const connectedApps = new ConnectedApps({
      store: apps.store,
      mcp,
      catalog: connectorCatalog,
      toolLock,
    });
    connectedAppsRef.current = connectedApps;
    // D73: Bot profiles may only authorize existing catalog connections (one per connector).
    bots.attachAppConnections(apps.store);
    try {
      toolLock.runBaseline();
    } catch (error) {
      // Retried on the next start; until then unmarked servers simply stay locked (fail-closed).
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'tool lock baseline failed',
      );
    }
    const appToolGrants = new AppToolGrants({ db: mainDb, clock });
    const gitRemoteGrants = new GitRemoteGrants({ db: mainDb, clock });
    // D73 P2 (design 29 §8.3): taint state for egress control; expired rows swept at start.
    const taint = new TaintService({ db: mainDb, clock, settings });
    taint.sweepExpired();
    // Taint travels with a cross-bot handoff (design 29 §8.3, 不可被「转交」洗掉): A's task text
    // reaching B's DM taints (B, that DM); B's result card landing in A's conversation taints
    // (A, that conversation). Group chats are covered by the conversation-level check.
    delegations.onMoved((delegation) => {
      if (delegation.toConversationId === null) return;
      const fromA = { botId: delegation.fromBotId, conversationId: delegation.fromConversationId };
      const toB = { botId: delegation.toBotId, conversationId: delegation.toConversationId };
      if (delegation.status === 'working') taint.inherit(fromA, toB);
      else if (delegation.status === 'completed' && delegation.intent !== 'fyi') {
        taint.inherit(toB, fromA);
      }
    });
    // D73 P1 (§5.4): catalog connections — the McpService's second server source, the catalog end of
    // the interactive flow (account identification, same-account reuse, first-connect tool review)
    // and connection management. Bot authorization goes through the bots domain layer.
    const appConnections = new AppConnectionsService({
      store: apps.store,
      vault: apps.vault,
      catalog: connectorCatalog,
      preregistered: apps.preregistered,
      toolLock,
      grants: appToolGrants,
      mcp,
      registry: appRuntime.registry,
      disconnector: appRuntime.disconnector,
      auditor: appRuntime.auditor,
      botGrants: createBotAppGrantWriter(bots, events),
      bots,
      settings,
      events,
      logger,
      clock,
    });
    mcp.attachConnections(appConnections.mcpSource());
    apps.flows.attachCatalogHost(appConnections.flowHost());
    // W3（D78）: user revocations (grants.revoke, MCP settings / bot selection)
    // interrupt the affected running tasks — TaskHost subscribes below.
    const revocations = new PermissionRevocations();
    const grants = new GrantsService({ db: mainDb, clock, revocations });
    // W8 共享浏览器资料：CRUD over settings.browserProfiles + the profile switch
    // (interrupt the bot's browser-using tasks, close its pages).
    const browserProfiles = new BrowserProfilesService({
      settings,
      bots,
      browser: services.browserRpc,
      clock,
      revocations,
      logger,
      publishBotUpdated: (bot) => events.emit('bot.updated', { bot }),
    });
    const allowlist = new AllowlistService({ db: mainDb, clock, osPlatform: process.platform });
    const workdirsService = new WorkdirsService({ db: mainDb, clock });

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
      ...(options.timers !== undefined ? { timers: options.timers } : {}),
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
      // W4: approval cards carry their tool call's ledger outcome (receipt).
      effects,
    });
    // D75 审查 H2: lease waits give their scheduler slot back (attached below).
    const leases = new SlotYieldingLeaseService();
    const workdirRuntime = new WorkdirRuntime({
      db: mainDb,
      paths,
      clock,
      logger,
      workdirs: workdirsService,
      conversations,
      messages,
      runs,
      bots,
      grants,
      leases,
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
    // D73 P2 §6.5 MCPB bundles: runtimes come from the environment manager; installs started
    // from a conversation go through an `environment`-kind approval card (D41 rules).
    const envRuntimeResolver = envManagerRuntimeResolver(environment, options.platform);
    const mcpb = new McpbInstaller({
      paths,
      settings,
      secrets,
      logger,
      homeDir: os.homedir(),
      audit,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      resolveRuntime: (kind) => {
        const forced = __KEPCUP_TEST_HOOKS__ === true ? options.mcpbRuntimes?.[kind] : undefined;
        return forced !== undefined
          ? { command: forced.command, version: forced.version ?? null }
          : envRuntimeResolver(kind);
      },
      requestApproval: (context, payload) =>
        new Promise<boolean>((resolve) => {
          approvals.submitNonBlocking(
            {
              runId: '',
              botId: context.botId ?? null,
              conversationId: context.conversationId,
              loopType: 'host',
            },
            'environment',
            payload,
            (outcome) => resolve(outcome.decision === 'approved'),
          );
        }),
      closeServer: (serverId) => mcp.closeServer(serverId),
      catalogEntry: (slug) => connectorCatalog.get(slug),
    });
    // P12 红线：register the mountable directories once the domain services
    // exist (data home + bound workdirs + active grants).
    const mountRegistration: MountRegistration = {
      registeredWindowsPaths: () => {
        const registered = new Set<string>([paths.home]);
        for (const conversation of conversations.list()) {
          if (conversation.workdirId === null) continue;
          const workdir = workdirsService.get(conversation.workdirId);
          if (workdir !== null) registered.add(canonicalPath(workdir.path));
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
      ...(parseReflectionDebounceMs(env) !== undefined
        ? { reflectionDebounceMs: parseReflectionDebounceMs(env) }
        : {}),
      // P10 commitment linkage rides the internal event bus (start-types.ts).
      publish: (event, payload) => events.emit(event as never, payload as never),
    });
    memoryForEnv = memory;
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
    // per-owner maintenance mutex, RPC reads and weekly lint scheduling (the
    // ingest/lint job runners consume it in jobs-runner).
    const wikiIndexes = new WikiIndexManager({
      paths,
      masterKey,
      clock: () => clock.now(),
      logger,
    });
    const wiki = new WikiService({
      paths,
      clock,
      logger,
      jobs,
      bots,
      conversations,
      indexFor: (owner) =>
        owner.kind === 'bot' ? memory.storeFor(owner.id) : wikiIndexes.forProject(owner.id),
      publish: (event, payload) => events.emit(event as never, payload as never),
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
      workdirs: workdirRuntime,
      environment: {
        toolchainPathPrefix: (platform) => environment.toolchainPathPrefix(platform),
        toolchainsRoot: () => paths.toolchainsDir,
        noteToolchainUse: () => environment.noteToolchainUse(),
      },
      skills: {
        readableDirs: (botId) => skills.readableDirs(botId),
      },
      // W5: risk re-resolved at call time from the server's current tool
      // annotations; policy / autoApprove re-read from settings. A server the
      // user switched off, or the bot no longer selects, is refused (enabled
      // false) so running tasks stop calling it.
      appGrants: appToolGrants,
      gitRemoteGrants,
      taint,
      mcpToolDecision: async ({ botId, serverId, toolName, signal }) => {
        // D73 P1: a catalog connection's tool (server id = connection id). Same gates as a
        // custom server — the bot must have the connection selected, the connection must be
        // in a usable state — plus the tool lock and the catalog risk overlay.
        const appView = connectedApps.view(serverId);
        if (appView !== null) {
          const appServer = mcp.serverFor(serverId) ?? null;
          const selectedByBot =
            botId !== null &&
            (bots.get(botId)?.profile.runtime.app_connection_ids.includes(serverId) ?? false);
          const denied: McpToolDecision = {
            risk: 'destructive',
            riskSource: 'default',
            approval: 'ask',
            approvalSource: 'default',
            enabled: false,
          };
          if (
            appServer === null ||
            !selectedByBot ||
            !isExposableStatus(appView.connection.status)
          ) {
            return denied;
          }
          const base = await mcp.resolveRisk(
            appServer,
            toolName,
            signal !== undefined ? { signal } : {},
          );
          const appDecision = connectedApps.decisionFor(serverId, toolName, base) ?? denied;
          return mcp.toolApproved(appServer, toolName)
            ? appDecision
            : { ...appDecision, enabled: false };
        }
        const server = settings.get().mcpServers.find((entry) => entry.id === serverId);
        const selected =
          botId !== null &&
          (bots.get(botId)?.profile.runtime.mcp_server_ids.includes(serverId) ?? false);
        if (server === undefined || !server.enabled || !selected) {
          return {
            risk: 'destructive',
            riskSource: 'default',
            approval: 'ask',
            approvalSource: 'default',
            enabled: false,
          };
        }
        const risk = await mcp.resolveRisk(
          server,
          toolName,
          signal !== undefined ? { signal } : {},
        );
        const decision = decideMcpTool(server, toolName, risk);
        // D73 P1: a tool whose definition is unreviewed (new / changed since it was offered, e.g.
        // mid-run) is not callable — same refusal as a tool the user switched off.
        return mcp.toolApproved(server, toolName) ? decision : { ...decision, enabled: false };
      },
    });

    // --- turn / task loop machinery ----------------------------------------
    const effectRecorder = createEffectRecorder({
      store: effects,
      redact: (text) => secrets.redact(text),
      logger,
      mcpRiskOf: (serverId, toolName) =>
        connectedApps.decisionFor(serverId, toolName, mcp.riskOf(serverId, toolName))?.risk ??
        mcp.riskOf(serverId, toolName).risk,
      // W4: a settled row linked to an approval refreshes that card's receipt.
      onSettled: (effect) => {
        if (effect.approvalId !== null) approvals.publishEffect(effect.approvalId);
      },
      // W4 复查 B1: only a hand-made refusal makes a denied row a duplicate.
      userDeniedApprovals: (ids) => approvals.userDeniedIds(ids),
    });
    const engine = new PiEngine({
      settings,
      secrets,
      logger,
      modelRetry: modelRetryPolicyFromEnv(env),
      effects: effectRecorder,
    });
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
      effects: effectRecorder,
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
      taint,
      taintGuardEnabled: () => settings.get().apps.taintGuard,
      gateway,
      approvals,
      grants,
      allowlist,
      skillDirs: (botId) => skills.readableDirs(botId),
      redact: (text) => secrets.redact(text),
      // D75 审查 M2: the bound workdir when this run does not hold its lease.
      unleasedWorkdir: (identity) => {
        const workdir = workdirRuntime.boundWorkdir(identity.conversationId);
        if (workdir === null || workdir.status !== 'available') return null;
        return workdirRuntime.holdsLease(identity, workdir.path) ? null : workdir.path;
      },
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
      // 审查 C2: agent triage is opt-in via backgroundTasks.projectMentionOnly.
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
    leases.attachScheduler(scheduler);
    // P10: the schedule service is constructed after the orchestrator (it
    // delivers through the orchestrator's mailboxes); the tool facade
    // delegates lazily.
    let scheduleService: ScheduleService | null = null;
    // D90: the workbench todo service is constructed after the orchestrator and the schedule
    // service; the orchestrator's delivery tracking reaches it through this lazy facade.
    let todoService: TodoService | null = null;
    const todoFacade: OrchestratorTodoFacade = {
      titleOf: (todoId) => todoService?.titleOf(todoId) ?? null,
      settleDelivered: (todoRunId, resultMessageId) => {
        if (resultMessageId !== null) todoService?.settleDelivered(todoRunId, resultMessageId);
      },
      settleUnclaimed: (todoRunId) => todoService?.settleUnclaimed(todoRunId),
      settleFailed: (todoRunId, outcome) => todoService?.settleFailed(todoRunId, outcome),
    };
    // D90: the butler's workbench tools + <workbench> section (lazy: the services are built after
    // the orchestrator; the butler check is the host's second look at the caller).
    let memoService: MemoService | null = null;
    const workbenchTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const workbenchFacade: WorkbenchToolFacade = {
      isButler: (botId) => bots.get(botId)?.systemRole === 'butler',
      listTodos: (filter) => todoService!.list(filter),
      getTodo: (id) => todoService!.get(id).todo,
      createTodo: (input) => todoService!.create(input),
      updateTodo: (id, input) => todoService!.update(id, input),
      startTodo: (id, actor) => todoService!.start(id, actor),
      completeTodo: (id) => todoService!.complete(id),
      cancelTodo: (id) => todoService!.cancel(id),
      listMemos: (filter) => memoService!.list(filter),
      createMemo: (input) => memoService!.create(input),
      updateMemo: (id, patch) => memoService!.update(id, patch),
      deleteMemo: (id) => memoService!.delete(id),
      describeWhen: (row) => scheduleService!.describeWhen(row),
      isTainted: (botId, conversationId) => taint.isTainted(botId, conversationId),
      now: () => clock.now(),
      describeTime: (ms) => describeTime(ms, clock.now(), workbenchTimeZone),
      contextSection: () => {
        if (todoService === null || memoService === null) return '';
        return buildWorkbenchSection({
          todos: todoService.list({ statuses: ['draft', 'scheduled', 'in_progress', 'delivered'] }),
          memos: memoService.list(),
          now: clock.now(),
          timeZone: workbenchTimeZone,
        });
      },
    };
    const scheduleFacade: ScheduleToolFacade = {
      createFromWhen: (input) => scheduleService!.createFromWhen(input),
      validateWhen: (when, timezone) => scheduleService!.validateWhen(when, timezone),
      describeWhen: (row) => scheduleService!.describeWhen(row),
      fireabilityWarnings: (row) => scheduleService!.fireabilityWarnings(row),
      listForBotInConversation: (botId, conversationId) =>
        scheduleService!.listForBotInConversation(botId, conversationId),
      cancelOwn: (botId, scheduleId) => scheduleService!.cancelOwn(botId, scheduleId),
      createOffer: (input) => scheduleService!.createOffer(input),
      contextSection: (botId, conversationId) =>
        scheduleService?.contextSection(botId, conversationId) ?? '',
      displayTitle: (scheduleId) => scheduleService?.displayTitle(scheduleId) ?? null,
    };
    // W7: the watch service is constructed after the orchestrator (alerts
    // wake turns through its mailboxes); the tool facade delegates lazily.
    let watchService: WatchService | null = null;
    let mailService: MailService | null = null;
    // D88: the handover host is constructed after mail / schedules (its adapters use
    // them); the butler's tools reach it through this lazy facade.
    let handoverHost: HandoverHost | null = null;
    const handoverFacade: HandoverToolFacade = {
      inspect: (identity, input) => handoverHost!.inspect(identity, input),
      propose: (identity, input) => handoverHost!.propose(identity, input),
      validateRoutineWhen: (when, timezone) => handoverHost!.validateRoutineWhen(when, timezone),
      modelOptions: () => handoverHost?.modelOptions() ?? [],
    };
    const watchFacade: OrchestratorWatchFacade = {
      create: (input) => watchService!.create(input),
      listForBotInConversation: (botId, conversationId) =>
        watchService!.listForBotInConversation(botId, conversationId),
      stopOwn: (botId, conversationId, watchId) =>
        watchService!.stopOwn(botId, conversationId, watchId),
      contextSection: (botId, conversationId) =>
        watchService?.contextSection(botId, conversationId) ?? '',
      renderContextLine: (message) =>
        watchService?.renderContextLine(message) ?? '（监看记录已清理）',
    };
    // D73 P3 §7.5: MCP Apps cards (tool results with `_meta.ui.resourceUri`) + UI-initiated calls.
    const appUi = new McpAppUiService({
      mcp,
      gateway,
      messages,
      publishMessage: (message) =>
        events.emit('message.created', { conversationId: message.conversationId, message }),
      appContextFor: (serverId) => {
        const view = connectedApps.view(serverId);
        return view === null ? undefined : connectedApps.contextOf(view);
      },
      // 本机连接 / developer 分级的条目声明 `ui: false`：不渲染它们返回的界面（评审 A4）。
      uiAllowed: (serverId) => {
        const view = connectedApps.view(serverId);
        return view === null || (view.tier !== 'developer' && !connectorCatalog.isLocal(view.slug));
      },
      secrets,
      shell: services.shellRpc,
      clock,
      logger,
    });
    // D73 P3: a closed / removed / disconnected app's UI resources die with it (pending approvals cancelled).
    mcp.onServerClosed((serverId) => appUi.store.invalidateServer(serverId));

    // D81 Bot 自制交互组件：任务工具落库发卡 + 沙箱资源登记（复用 kepcup-app:// 管线）。
    const widgetService = new WidgetService({
      db: mainDb,
      messages,
      publishMessage: (message) =>
        events.emit('message.created', { conversationId: message.conversationId, message }),
      secrets,
      shell: services.shellRpc,
      // 组件查询模板只在独立只读子进程里执行（时限 / 内存上限，设计 32 §6.1）。
      queryRunner: new WidgetQueryRunner({
        database: { path: paths.mainDbPath, key: deriveKey(masterKey, KEY_INFO.mainDb) },
        logger,
      }),
      clock,
      logger,
    });

    // D87 组件制作 loop：widget_craft 的宿主状态机（阶段 run 嵌套在任务 run 下，交付凭检查回执）。
    // S2 预览宿主由主进程经端口 B 绑定（`widgetPreview.run`）；未绑定（无界面装配）时 S2 记
    // skipped，交付为「未经运行验证」。
    const widgetCraft = new WidgetCraftService({
      engine,
      router: llmRouter,
      settings,
      bots,
      runs,
      usage,
      secrets,
      widgets: widgetService,
      paths,
      logger,
      clock,
      publishRunStatus: (run) => events.emit('run.status', { run }),
      // 审查模型可用性：厂商在、有 key、模型登记了（换了厂商 / 删了 key 时退回制作的模型）。
      modelUsable: (modelRef) => {
        const slash = modelRef.indexOf('/');
        if (slash <= 0) return false;
        const providerId = modelRef.slice(0, slash);
        const modelId = modelRef.slice(slash + 1);
        try {
          const provider = providers.list().find((info) => info.id === providerId);
          return (
            provider !== undefined &&
            provider.hasKey &&
            provider.models.some((m) => m.id === modelId)
          );
        } catch {
          return false;
        }
      },
      preview: (opts) =>
        createWidgetPreviewRunner({
          rpc: services.widgetPreviewRpc,
          screenshots: opts.screenshots,
        }),
    });
    try {
      widgetCraft.sweepDrafts();
    } catch (error) {
      logger.warn({ error: String(error) }, 'widget draft sweep failed');
    }

    // 对话内应用设置（todo/conversational-app-setup.md）：目录适配器 + 三个工具 + 设置卡的宿主。
    // 设置卡落定后经 orchestrator 唤醒出卡 Bot（晚绑定：orchestrator 在下面构造）。
    // Bot 条目写入与 `bots.update` RPC 同一个 applyBotProfileUpdate（校验、中断任务、收回授权）。
    const settingsPermissionEffects = createPermissionEffects({
      revocations,
      publish: (event, payload) => events.emit(event as never, payload as never),
      listBots: () => bots.listActive(),
      mcpRiskOf: (serverId, toolName) => mcp.riskOf(serverId, toolName).risk,
      mcpKnownTools: (serverId) => mcp.knownToolNames(serverId),
    });
    // 定时 / 监看服务同样在下面才构造；这里先占位，构造完再换上只回条数的读法。
    const linkCounts = {
      schedules: (_botId: string): number => 0,
      watches: (_botId: string): number => 0,
    };
    const settingsCatalog = new SettingsCatalogHost({
      db: mainDb,
      messages,
      clock,
      logger,
      lock: new SettingsWriteLock(),
      settings,
      secrets,
      providers,
      bots,
      botProfiles: {
        apply: (botId, profile) =>
          applyBotProfileUpdate(
            {
              bots,
              settings,
              agentCatalog: () => agentCatalog,
              browserProfiles,
              effects: settingsPermissionEffects,
              publish: (event, payload) => events.emit(event as never, payload as never),
            },
            botId,
            profile,
          ),
      },
      mcpServers: {
        revokeChanges: (previous, next) =>
          settingsPermissionEffects.revokeMcpServerChanges(previous, next),
      },
      conversations,
      projects: {
        update: (conversationId, patch) => {
          projects.update(conversationId, patch);
        },
        setLead: (conversationId, botId) => {
          projects.setLead(conversationId, botId);
        },
      },
      workdirs: {
        get: (id) => workdirsService.get(id),
      },
      appConnections: {
        list: () => appConnections.catalogConnectionOptions(),
        peekTool: (connectionId, toolName) =>
          appConnections.peekCatalogTool(connectionId, toolName),
      },
      unattended,
      agentCatalog: () => agentCatalog,
      agentOptions: (agentId) => agentsService.optionsCached(agentId),
      embedding: {
        configure: (input) => {
          memory.configureEmbedding(input);
        },
      },
      skills: {
        list: (botId) => skills.listForBot(botId),
        enable: (botId, name) => {
          skills.enable(botId, name);
        },
        disable: (botId, name) => {
          skills.disable(botId, name);
        },
      },
      environment: {
        listInstalls: () => environment.listInstalls(),
        systemStatuses: () => environment.systemStatuses(),
      },
      sandbox: {
        lastAvailability: () => {
          const cached = sandbox.lastAvailability();
          return cached === null ? null : { available: cached.available };
        },
      },
      allowlist: {
        list: () => allowlist.list(),
      },
      oauthClients: {
        count: () => apps.oauthClients.list().length,
      },
      fileGrants: {
        countForBot: (botId) => grants.countActiveForBot(botId),
      },
      schedules: {
        countForBot: (botId) => linkCounts.schedules(botId),
      },
      watches: {
        countForBot: (botId) => linkCounts.watches(botId),
      },
      // D96：remoteHub 在后面才构造，闭包晚绑定（读快照时它已就位）。
      remote: {
        devices: () =>
          services.remote === null
            ? []
            : services.remote.devices().devices.map((device) => ({
                online: device.online === true,
                revoked: device.revokedAt !== null,
              })),
      },
      taint,
      publish: (event, payload) => events.emit(event as never, payload as never),
      wake: (input) =>
        orchestrator.deliverEventToBot(
          input.botId,
          input.conversationId,
          SETTING_CARD_RESOLVED_EVENT,
          input.text,
          { internal: true, settingResolved: input.resolved },
        ),
    });
    services.settingsCatalog = settingsCatalog;

    const orchestrator = new Orchestrator({
      engine,
      effects,
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
      projects,
      delegations,
      messages,
      attachments,
      jobs,
      runs,
      usage,
      settings,
      secrets,
      approvals,
      grants,
      workdirs: workdirRuntime,
      sandbox,
      clock,
      logger,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      judgementTimeoutMs: parseTriageTimeoutMs(env),
      // The e2e seam (test-hook builds only) wins over the per-part integration seam.
      episodeLimits:
        episodeLimitsSeam !== undefined && Object.keys(episodeLimitsSeam).length > 0
          ? episodeLimitsSeam
          : parseEpisodeLimits(env),
      publish: (event, payload) => events.emit(event, payload as never),
      environment,
      memory,
      media,
      search,
      mcp,
      connectedApps,
      localConnectors,
      appUi,
      widgets: {
        craft: (input) => widgetCraft.craft(input),
        publish: (input) => widgetService.publish(input),
        readState: (input) => widgetService.readState(input),
      },
      widgetCraft,
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
        topicsSection: (owner, options) => wiki.topicsSection(owner, options),
        search: (owner, query, limit) => wiki.search(owner, query, limit),
        readPage: (owner, pagePath) => wiki.readPage(owner, pagePath),
        enqueueIngest: (input) => wiki.enqueueIngest(input),
        enqueueRemoveSource: (input) => wiki.enqueueRemoveSource(input),
        listSources: (owner) =>
          wiki.listSources(owner).map((entry) => ({
            id: entry.id,
            createdBy: entry.createdBy,
          })),
        botName: (botId) => bots.get(botId)?.name ?? null,
        projectContext: (conversationId) => {
          const conversation = conversations.get(conversationId);
          if (conversation === null || conversation.type !== 'project') return null;
          return {
            conversationId,
            leadBotId: conversation.leadBotId ?? null,
            memberBotIds: conversations.memberBotIds(conversationId),
          };
        },
      },
      schedule: scheduleFacade,
      watch: watchFacade,
      get mail() {
        return mailService ?? undefined;
      },
      handover: handoverFacade,
      todos: todoFacade,
      workbench: workbenchFacade,
      settingsCatalog,
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
    // W3（D78）: a user revocation interrupts the affected running tasks (turns are not).
    revocations.on((event) => orchestrator.tasks.interruptForRevocation(event));
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
      // D80: receipt / offer cards and the schedules.changed refresh event.
      messages,
      publish: (event, payload) => events.emit(event as never, payload as never),
    });
    scheduleService = schedules;
    // D90 workbench: todos (CRUD, scheduling, dispatch, delivery tracking, reconciliation) and
    // memos. A due workbench schedule dispatches through TodoService (no proactive guardrails).
    const publishEvent = (event: string, payload: unknown): void =>
      events.emit(event as never, payload as never);
    const todos = new TodoService({
      db: mainDb,
      clock,
      logger,
      bots,
      conversations,
      schedules,
      dispatcher: {
        dispatch: (input) => orchestrator.dispatchWorkbenchMessage(input),
        dispatchUpdate: (input) => orchestrator.dispatchWorkbenchUpdate(input),
        hasTurnModel: (botId) => orchestrator.hasTurnModel(botId),
      },
      publish: publishEvent,
      timers: options.timers ?? realTimerScheduler,
    });
    todoService = todos;
    schedules.attachWorkbench(todos);
    const memos = new MemoService({
      store: todos.memos,
      clock,
      logger,
      publish: publishEvent,
    });
    memoService = memos;
    // A schedule cancelled / ended outside the todo flows (the receipt's cancel button, a
    // deleted conversation's cascade) leaves its todo `scheduled` without a schedule: reconcile.
    // Only workbench rows matter, and a burst of events in one tick collapses into one pass.
    let reconcileQueued = false;
    events.on('schedules.changed', ({ scheduleId }) => {
      if (schedules.store.get(scheduleId)?.origin !== 'workbench') return;
      if (reconcileQueued) return;
      reconcileQueued = true;
      queueMicrotask(() => {
        reconcileQueued = false;
        try {
          todos.reconcile();
        } catch (error) {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'todo reconcile after schedules.changed failed',
          );
        }
      });
    });
    // 应用状态提示（邮件连接中断、监看被暂停…）：推给界面弹一条轻量提示，不落库。
    // 需要用户处理的错误级提示在窗口不在前台时还发一条系统通知。
    const publishAppNotice = (notice: AppNoticePayload): void => {
      events.emit('app.notice', notice);
      if (notice.level === 'error' && notice.dismiss !== true) {
        events.emit('platform.notify', {
          conversationId: null,
          title: 'KepCup',
          body: notice.text,
        });
      }
    };
    // W7 确定性监看：一个进程内 worker 按 next_check_at 检查；后台页经端口 B
    // （browser.fetchText），用 Bot 的生效浏览器资料（W8）；本机地址只在对话
    // 绑定了 workdir 时可访问（与浏览器工具同一规则）。
    const watches = new WatchService({
      db: mainDb,
      clock,
      ...(options.timers !== undefined ? { timers: options.timers } : {}),
      logger,
      bots,
      conversations,
      messages,
      jobs,
      fetcher: services.browserRpc,
      profileKeyFor: (botId) => browserProfiles.profileKeyFor(botId),
      allowLoopback: (conversationId) => {
        const workdir = workdirRuntime.boundWorkdir(conversationId);
        return workdir !== null && workdir.status === 'available';
      },
      deliverAlert: (input) => orchestrator.deliverWatchAlertToBot(input),
      publish: (event, payload) => events.emit(event as never, payload as never),
      notice: publishAppNotice,
    });
    watchService = watches;
    linkCounts.schedules = (botId) => schedules.listActiveForBot(botId).length;
    linkCounts.watches = (botId) => watches.listLiveForBot(botId).length;
    const mail = new MailService({
      db: mainDb,
      clock,
      logger,
      secrets,
      bots,
      conversations,
      messages,
      jobs,
      taint,
      requestApproval: (identity, kind, payload, options) =>
        approvals.request(identity, kind, payload, options),
      deliverAlert: (input) => orchestrator.deliverMailAlertToBot(input),
      publishAccount: (account, accountId) =>
        events.emit('mail.account_updated', { accountId, account }),
      publishMessage: (message) =>
        events.emit('message.created', { conversationId: message.conversationId, message }),
      notice: publishAppNotice,
    });
    mail.start();
    mailService = mail;
    // D88 Bot 资产移交：适配器框架 + 宿主（移交卡、确定性执行、恢复）。
    const handoverBotWriter: HandoverBotWriter = {
      get: (botId) => bots.get(botId),
      updateProfile: (botId, mutate) => {
        const updated = bots.update(botId, mutate(bots.getOrThrow(botId).profile));
        events.emit('bot.updated', { bot: updated });
        return updated;
      },
    };
    const handoverRevoke = (serverId: string, botIds: string[]): void => {
      const count = revocations.emit({ scope: 'mcp', botIds, serverId });
      if (count > 0) {
        events.emit('tasks.interrupted', { count, reason: 'permission_revoked', scope: 'mcp' });
      }
    };
    const handoverModelOptions = () => chatModelOptions(providers.list());
    // 换外部智能体时的规则与 bots.update / 新建 Bot 同源（实验开关、目录、默认权限档）。
    const handoverAgents: HandoverAgentPolicy = {
      selectable: (agentId) => {
        try {
          assertAgentSelectable(settings.get(), agentCatalog, agentId);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      defaultPermission: (agentId) =>
        findAgentEntry(agentCatalog, agentId)?.tier === 'preview' ? 'ask' : 'workspace',
    };
    // P1：记忆按条复制、承诺随定时任务迁移（每个 Bot 一个 memory.db，按 Bot 取库）。
    const handoverMemory: HandoverMemoryPort = {
      get: (botId, itemId) => memory.getItemFor(botId, itemId),
      activeItems: (botId) => memory.activeItemsFor(botId),
      search: (botId, query, limit) => memory.searchActiveFor(botId, query, limit),
      findCopy: (botId, handoverId, fromItemId) =>
        memory.findHandoverCopy(botId, handoverId, fromItemId),
      activeWithContent: (botId, content) => memory.activeWithContentFor(botId, content),
      insertCopy: (botId, item) => memory.insertHandoverCopy(botId, item),
      embed: (botId, item) => memory.embedItem(botId, item),
      voidCommitment: (botId, itemId) => memory.voidCommitment(botId, itemId),
    };
    const handoverConversations = {
      get: (conversationId: string) => conversations.get(conversationId),
      memberBotIds: (conversationId: string) => conversations.memberBotIds(conversationId),
      directIdFor: (botId: string) => conversations.openDirect(botId).conversation.id,
    };
    const handover = new HandoverHost({
      db: mainDb,
      logger,
      bots,
      conversations,
      messages,
      approvals,
      store: new HandoverStore({ db: mainDb, clock }),
      registry: new HandoverRegistry([
        new ModelAdapter({
          bots: handoverBotWriter,
          modelOptions: handoverModelOptions,
          agents: handoverAgents,
        }),
        new AppAdapter({
          bots: handoverBotWriter,
          connections: apps.store,
          appName: (connectionId) => connectedApps.view(connectionId)?.appName ?? null,
          revoke: handoverRevoke,
        }),
        new McpAdapter({
          bots: handoverBotWriter,
          servers: () => settings.get().mcpServers,
          revoke: handoverRevoke,
        }),
        new MailAdapter({
          mail: {
            accountsForBot: (botId) => mail.accountsForBot(botId),
            boundBotIds: (accountId) =>
              mail.store.get(accountId) === null
                ? null
                : mail.store.bindings(accountId).map((binding) => binding.botId),
            addBinding: (accountId, botId) => mail.addBinding(accountId, botId),
            removeBinding: (accountId, botId) => mail.removeBinding(accountId, botId),
            retargetPendingAlerts: (accountId, fromBotId, toBotId) =>
              mail.retargetPendingAlerts(accountId, fromBotId, toBotId),
          },
        }),
        new ScheduleAdapter({
          todos: { onScheduleTransferred: (moved) => todos.onScheduleTransferred(moved) },
          schedules: {
            listActiveForBot: (botId) => schedules.listActiveForBot(botId),
            get: (scheduleId) => schedules.store.get(scheduleId),
            transferTo: (scheduleId, target) => schedules.transferTo(scheduleId, target),
            transferredTo: (scheduleId, botId) => schedules.transferredTo(scheduleId, botId),
            describeWhen: (row) => schedules.describeWhen(row),
          },
          conversations: handoverConversations,
          memory: handoverMemory,
        }),
        new WatchAdapter({
          watches: {
            listLiveForBot: (botId) => watches.listLiveForBot(botId),
            get: (watchId) => watches.get(watchId),
            countLiveForBot: (botId) => watches.countLiveForBot(botId),
            transferTo: (watchId, target) => watches.transferTo(watchId, target),
            profileKeyFor: (botId) => watches.profileKeyFor(botId),
            allowsLoopback: (conversationId) => watches.allowsLoopback(conversationId),
          },
          conversations: handoverConversations,
        }),
        new SkillAdapter({
          skills: {
            privateEntries: (botId) =>
              skills.listForBot(botId).filter((entry) => entry.scope === 'private'),
            privateEntry: (botId, name) =>
              skills.botSkillRow(botId, name) === null ? null : skills.entryFor(botId, name),
            contentAvailable: (botId, name) => {
              const row = skills.botSkillRow(botId, name);
              return row !== null && skills.dirOf(row) !== null;
            },
            isHandoverCopy: (fromBotId, toBotId, name) =>
              skills.isHandoverCopy(fromBotId, toBotId, name),
            copyForHandover: (input) => skills.copyForHandover(input),
          },
        }),
        new MemoryAdapter({ memory: handoverMemory, clock: () => clock.now() }),
        // P2：Wiki 与组件在后台 handover_copy 作业里复制。
        new WikiAdapter({
          // D92 T1b WP9: handover stays bot-only — every call pins the bot owner.
          wiki: {
            exists: (botId) => wiki.exists({ kind: 'bot', id: botId }),
            pageStats: (botId) => wiki.pageStats(botId),
            tree: (botId) => wiki.tree({ kind: 'bot', id: botId }),
            pageTitle: (botId, pagePath) => {
              try {
                return wiki.readPage({ kind: 'bot', id: botId }, pagePath).title;
              } catch {
                return pagePath;
              }
            },
            search: (botId, query, limit) => wiki.search({ kind: 'bot', id: botId }, query, limit),
            copySize: (botId, pages) => wiki.copySize(botId, pages),
            pageConflict: (fromBotId, toBotId, pagePath) =>
              wiki.pageConflict(fromBotId, toBotId, pagePath),
            copyForHandover: (input) => wiki.copyForHandover(input),
          },
          publish: (event, payload) => events.emit(event as never, payload as never),
        }),
        new WidgetAdapter({
          widgets: {
            candidates: (botId) => widgetService.handoverCandidates(botId),
            conversationScopedCount: (botId) => widgetService.conversationScopedCount(botId),
            findCopy: (widgetId, toBotId) => widgetService.findHandoverCopy(widgetId, toBotId),
            blocker: (widgetId, toBotId, toName) =>
              widgetService.handoverCopyBlocker(widgetId, toBotId, toName),
            copy: (widgetId, toBotId, toName) =>
              widgetService.copyForHandover(widgetId, toBotId, toName),
          },
        }),
      ]),
      modelOptions: handoverModelOptions,
      agents: handoverAgents,
      updateProfile: handoverBotWriter.updateProfile,
      schedule: scheduleFacade,
      jobs,
      copyLeftovers: {
        discard: (handoverId, toBotId) => wiki.discardHandoverLeftovers(handoverId, toBotId),
        sweep: (keep) => wiki.sweepHandoverLeftovers(keep),
      },
      assetCounts: (botId) => ({
        memory: memory.activeItemsFor(botId).length,
        wikiPages: wiki.pageStats(botId).length,
        skills: skills.skillCount(botId),
        widgets: widgetService.listForBot(botId).length,
      }),
      publish: (event, payload) => events.emit(event as never, payload as never),
      deliverEvent: (botId, conversationId, event, text, opts) =>
        orchestrator.deliverEventToBot(botId, conversationId, event, text, opts),
    });
    handoverHost = handover;
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
      projects,
      messages,
      attachments,
      jobs,
      grants,
      abortRunsForConversation: (id) => orchestrator.abortRunsForConversation(id),
      abortRunsForBot: (id) => orchestrator.abortRunsForBot(id),
      abortRunsForBotInConversation: (botId, conversationId) =>
        orchestrator.abortRunsForBotInConversation(botId, conversationId),
      onProjectMemberRemoved: (botId, conversationId) =>
        orchestrator.projectMemberRemoved(botId, conversationId),
      delegations: {
        onConversationDeleted: (conversationId) =>
          orchestrator.delegationsOnConversationDeleted(conversationId),
        prepareBotDeletion: (botId) => orchestrator.delegationsOnBotDeleted(botId),
      },
      // D73 P2: taint rows follow their conversation / the bot's own direct chats.
      taint: {
        deleteForConversation: (conversationId) => taint.deleteForConversation(conversationId),
        deleteForBotInConversations: (botId, ids) => taint.deleteForBotInConversations(botId, ids),
      },
      // D73 P1: the bot's persistent app-tool grants are revoked with the bot / its membership.
      appGrants: {
        revokeForBot: (botId) => appToolGrants.revokeForBot(botId),
        revokeForBotInConversation: (botId, conversationId) =>
          appToolGrants.revokeForBotInConversation(botId, conversationId),
      },
      // git 远程操作的持续授权同上（本对话内 / 对该 Bot）。
      gitRemoteGrants: {
        revokeForBot: (botId) => gitRemoteGrants.revokeForBot(botId),
        revokeForBotInConversation: (botId, conversationId) =>
          gitRemoteGrants.revokeForBotInConversation(botId, conversationId),
      },
      // D72 P5: kept agent sessions die with their conversation / bot / membership.
      agentSessions: {
        onConversationDeleted: (conversationId) =>
          orchestrator.agentSessionsOnConversationDeleted(conversationId),
        prepareBotDeletion: (botId) => orchestrator.agentSessionsOnBotDeleted(botId),
        onProjectMemberRemoved: (botId, conversationId) =>
          orchestrator.agentSessionsOnProjectMemberRemoved(botId, conversationId),
      },
      memory: {
        onConversationDeleted: (conversationId, memberBotIds) =>
          memory.onConversationDeleted(conversationId, memberBotIds),
        onProjectMemberRemoved: (botId, conversationId) =>
          memory.onProjectMemberRemoved(botId, conversationId),
        prepareBotDeletion: (botId) => memory.prepareBotDeletion(botId),
        memoryItemCount: (botId) => memory.memoryItemCount(botId),
      },
      skills: {
        prepareBotDeletion: (botId) => skills.prepareBotDeletion(botId),
        skillCount: (botId) => skills.skillCount(botId),
      },
      wiki: {
        prepareBotDeletion: (botId) => wiki.prepareBotDeletion(botId),
        prepareProjectDeletion: (projectId) => wiki.prepareProjectDeletion(projectId),
        wikiPageCount: (botId) => wiki.pageCount({ kind: 'bot', id: botId }),
      },
      wikiIndex: {
        closeProject: (projectId) => wikiIndexes.closeProject(projectId),
      },
      schedules: {
        deleteForConversation: (conversationId) => schedules.deleteForConversation(conversationId),
        prepareBotDeletion: (botId) => schedules.prepareBotDeletion(botId),
        cancelForBotInConversation: (botId, conversationId) =>
          schedules.cancelForBotInConversation(botId, conversationId),
      },
      // D90: todos fall back to draft when their executor / group / schedule's conversation goes.
      workbench: {
        onConversationDeleting: (conversationId) => todos.onConversationDeleting(conversationId),
        onExecutorChanged: () => todos.onExecutorChanged(),
      },
      // W7: watches of a deleted conversation / bot (or a bot removed from the group) are removed.
      watches: {
        deleteForConversation: (conversationId) => watches.deleteForConversation(conversationId),
        prepareBotDeletion: (botId) => watches.prepareBotDeletion(botId),
        removeForBotInConversation: (botId, conversationId) =>
          watches.removeForBotInConversation(botId, conversationId),
      },
      mail: {
        prepareBotDeletion: (botId) => mail.prepareBotDeletion(botId),
      },
      // D81: a deleted bot's widgets (conversation deletion cascades through the FK).
      widgets: {
        prepareBotDeletion: (botId) => widgetService.deleteForBot(botId),
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
      clock,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      skills,
      sandbox,
      paths,
      publish: (event, payload) => events.emit(event as never, payload as never),
      wiki,
      wikiIndexFor: (owner) =>
        owner.kind === 'bot' ? memory.storeFor(owner.id) : wikiIndexes.forProject(owner.id),
      schedules,
      watches,
      mail,
      handover,
      gateway,
      attachments,
    });

    jobs.resetRunningToPending();
    // Provider limits apply before recovery launches anything (re-queued
    // tasks, wake runs — D75 审查 LOW-5).
    scheduler.setConcurrency(settings.get().providerConcurrency);
    // D75 W3 (design 30 §4.3): every status change of a task — whoever
    // publishes it (task host, executor, lease waits) — redraws its card.
    events.on('run.status', ({ run }) => {
      if (run.loopType === 'task') orchestrator.tasks.publishUpdate(run.id);
    });
    // D75 §7.4: task repair → blanket interruption → re-queue + reconciliation.
    orchestrator.recoverInterrupted();
    // D88: after the pending cards were cancelled above — cancelled cards close their
    // handovers, interrupted executions continue with their remaining items.
    try {
      handover.recover();
    } catch (error) {
      warnQuietly('handover recovery failed', error);
    }
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
    environment.setNotifier((botId, conversationId, event, text, opts) => {
      // System-approval / install callbacks can race stack.cleanup() (CI macOS
      // saw "database connection is not open" as an unhandled rejection after
      // every test had already passed). Skip once services are closing.
      if (servicesClosed.closed) return;
      try {
        orchestrator.deliverEventToBot(botId, conversationId, event, text, opts);
      } catch (error) {
        warnQuietly('environment notify failed', error);
      }
    });
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
    // D90: memos trashed longer than the retention window go for good; todos whose executor /
    // schedule vanished while the app was closed fall back to draft BEFORE catch-up dispatches.
    try {
      memos.purgeExpired();
    } catch (error) {
      warnQuietly('startup memo purge failed', error);
    }
    try {
      todos.reconcile();
    } catch (error) {
      warnQuietly('startup todo reconcile failed', error);
    }
    try {
      schedules.catchUpMissed();
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'startup schedule catch-up failed',
      );
    }
    schedules.start();
    // W7: overdue watches check right away, then the worker follows next_check_at.
    // In the app port B is bound after this (process-entry): checks that found
    // no browser host are deferred without counting a failure, and binding
    // the host wakes the worker.
    watches.start();
    services.browserRpc.onBound(() => watches.wake());
    // Checkpoint retention sweep (docs/dev/phases/P04-project.md): background,
    // best-effort — a swept repo only makes old reverts report unavailable.
    void workdirRuntime
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

    // Orphaned attachments (rows never bound to a message past their TTL, and
    // files no row references — e.g. the pre-D86 send queue's leftovers):
    // best-effort, conservative, logged.
    try {
      const swept = attachments.sweepOrphans();
      if (swept.expiredRows > 0 || swept.orphanFiles > 0) {
        logger.info(swept, 'orphaned attachments swept');
      }
    } catch (error) {
      warnQuietly('attachment orphan sweep failed', error);
    }

    services.mainDb = mainDb;
    services.runsDb = runsDb;
    // D48 Bot 模板：导入时外部智能体引擎在本机不可用（实验开关/目录）→ 回退内置。
    const botTemplates = new BotTemplateService({
      paths,
      clock,
      logger,
      bots,
      avatars,
      skills,
      agentSelectable: (agentId) => {
        try {
          assertAgentSelectable(settings.get(), agentCatalog, agentId);
          return true;
        } catch {
          return false;
        }
      },
    });
    services.domain = {
      settings,
      secrets,
      bots,
      avatars,
      botTemplates,
      conversations,
      messages,
      stickies,
      attachments,
      jobs,
      runs,
      usage,
      lifecycle,
      projects,
      delegations,
      providers,
      audit,
      grants,
      approvals,
      allowlist,
      unattended,
      workdirs: workdirsService,
      effects,
      revocations,
      browserProfiles,
    };
    services.orchestrator = orchestrator;
    // D94 分享接收：Share Extension 投递的目标解析、附件落盘与失败恢复。
    const shareIntake = new ShareIntakeService({
      db: mainDb,
      paths,
      clock,
      logger,
      attachments,
      conversations,
      bots,
      orchestrator,
      publish: (event, payload) => events.emit(event, payload),
    });
    services.share = shareIntake;

    // D94 §6.7：清扫「启动 + 每日」——超时的 processing、过期失败/done/received
    // 行、无主残留目录；随后 scanInbox 把「主进程移动后崩溃」的残留和 sweep 打
    // 回的 received 批次补消费掉（文件不丢，received 不滞留成黑洞）。
    const runShareIntakeMaintenance = (): void => {
      const swept = shareIntake.sweep();
      if (
        swept.resetProcessing > 0 ||
        swept.expiredFailed > 0 ||
        swept.expiredDone > 0 ||
        swept.expiredReceived > 0 ||
        swept.orphanInboxDirs > 0
      ) {
        logger.info(swept, 'share intakes swept');
      }
      const recovered = shareIntake.scanInbox();
      if (recovered.length > 0) {
        logger.info({ recovered }, 'share intakes recovered from core inbox');
      }
    };
    try {
      runShareIntakeMaintenance();
    } catch (error) {
      warnQuietly('share intake sweep failed', error);
    }
    const shareTestHooks = __KEPCUP_TEST_HOOKS__ === true && env.NODE_ENV === 'test';
    const shareSweepTimer = setInterval(
      () => {
        if (servicesClosed.closed) return;
        try {
          runShareIntakeMaintenance();
        } catch (error) {
          // 每日清扫是尽力而为：失败只记日志，不打断进程。
          warnQuietly('share intake sweep failed', error);
        }
      },
      shareTestHooks && options.shareSweepIntervalMs !== undefined
        ? options.shareSweepIntervalMs
        : SHARE_SWEEP_INTERVAL_MS,
    );
    shareSweepTimer.unref?.();
    shareSweepTimerRef.timer = shareSweepTimer;
    // D94 §5.2: Bot / 项目 / 归档变化时通知主进程重写目标快照（主进程侧防抖）。
    events.on('bot.updated', () => events.emit('share.targets.changed', { reason: 'bot' }));
    events.on('bot.deleted', () => events.emit('share.targets.changed', { reason: 'bot' }));
    events.on('conversation.updated', (payload) => {
      const conversation = payload.conversation;
      if (conversation.type !== 'project') return;
      events.emit('share.targets.changed', { reason: 'project' });
    });
    // 项目组被删：快照里的项目条目要消失（payload 只有 id，删除后已查不到
    // 类型；多刷一次主进程会防抖合并，无害）。
    events.on('conversation.deleted', () =>
      events.emit('share.targets.changed', { reason: 'project' }),
    );
    services.workdirRuntime = workdirRuntime;
    services.environment = environment;
    services.memory = memory;
    services.media = media;
    services.search = search;
    services.skills = skills;
    services.skillImporter = skillImporter;
    services.skillPresets = skillPresets;
    services.wiki = wiki;
    services.wikiIndexes = wikiIndexes;
    services.schedules = schedules;
    services.todos = todos;
    services.memos = memos;
    services.watches = watches;
    services.mail = mail;
    services.handover = handover;
    services.scheduler = scheduler;
    services.jobsRunner = jobsRunner;
    services.mcp = mcp;
    services.apps = apps;
    services.appRuntime = appRuntime;
    services.mcpb = mcpb;
    services.toolLock = toolLock;
    services.appToolGrants = appToolGrants;
    services.taint = taint;
    services.appUi = appUi;
    services.widgets = widgetService;
    services.widgetCraft = widgetCraft;
    services.connectedApps = connectedApps;
    services.connectorCatalog = connectorCatalog;
    services.localConnectors = localConnectors;
    services.directorySync = directorySync;
    directorySync.start();
    services.appConnections = appConnections;
    // D73 P3 §7.6: bundled skills of a catalog entry are offered after the connection completes;
    // installing goes through the existing skill_import approval (never automatic).
    const appSkills = new AppSkillsOffers({
      catalog: connectorCatalog,
      store: apps.store,
      skills,
      importer: skillImporter,
      approvals,
      bots,
      conversations,
      events,
      logger,
      clock,
      ...(__KEPCUP_TEST_HOOKS__ === true &&
      env.NODE_ENV === 'test' &&
      options.appSkillSourceOverride !== undefined
        ? { resolveSource: options.appSkillSourceOverride }
        : {}),
    });
    appSkills.start();
    services.appSkills = appSkills;
    // D96 远程遥控：收发中枢（端点注册表 / 事件扇出 / remote.* 处理）。handlers
    // 经 getter 取与本机 renderer 同一份 appMethods（此时 bindAppMethods 尚未跑，
    // 端点只会在 ready 后建立）。开关关闭时零连接零端点。
    const remoteHub = new RemoteHub({
      db: mainDb,
      secrets,
      settings,
      events,
      audit,
      clock,
      logger,
      appMethods: () => services.appMethods,
      ...(options.remote ?? {}),
      pushInitialEventsTo: (server) => {
        services.pushStatusTo(server);
        services.pushPlatformStateTo(server);
      },
    });
    services.remote = remoteHub;
    remoteHub.start();
    services.appMethods = {
      ...systemMethods,
      ...bindAppMethods(services),
      // e2e 测试缝（打包产物 DCE 掉）：模拟手机发来配对请求，走真实配对路径。
      ...(__KEPCUP_TEST_HOOKS__
        ? {
            'remote.testInjectPairing': {
              input: z.object({
                deviceId: z.string().min(1),
                deviceName: z.string().min(1),
                userAgent: z.string().min(1),
                pskMode: z.enum(['x25519', 'psk']).optional(),
              }),
              output: z.object({ requestId: z.string() }),
              handle: async (input) =>
                remoteHub.pairing.testInjectPairingRequest(
                  input as {
                    deviceId: string;
                    deviceName: string;
                    userAgent: string;
                    pskMode?: 'x25519' | 'psk';
                  },
                ),
            },
          }
        : {}),
    };

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
 * Test hook: KEPCUP_REFLECTION_DEBOUNCE_MS overrides the turn-reflection
 * debounce window (production default stays REFLECTION_TURN_DEBOUNCE_MS);
 * 0 disables debouncing and reflects each turn separately.
 */
function parseReflectionDebounceMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.KEPCUP_REFLECTION_DEBOUNCE_MS;
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Test hook: KEPCUP_TRIAGE_TIMEOUT_MS overrides TRIAGE_TIMEOUT_MS for the
 * routing judgements (D92 T1a: the continuation check and the lead gate; the
 * constants.ts default stays the single source of truth for production).
 */
function parseTriageTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.KEPCUP_TRIAGE_TIMEOUT_MS;
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Test hook (D92 T1a WP2): KEPCUP_EPISODE_HOP_BREAKER / KEPCUP_EPISODE_PAIR_BREAKER
 * override the episode breaker thresholds (integration tests script a short
 * ping-pong instead of 12/8 live mentions). Unset parts fall back to the
 * shared constants.
 */
function parseEpisodeLimits(env: NodeJS.ProcessEnv): { hops?: number; pair?: number } | undefined {
  const hops = Number(env.KEPCUP_EPISODE_HOP_BREAKER);
  const pair = Number(env.KEPCUP_EPISODE_PAIR_BREAKER);
  const limits: { hops?: number; pair?: number } = {};
  if (Number.isFinite(hops) && hops > 0) limits.hops = Math.floor(hops);
  if (Number.isFinite(pair) && pair > 0) limits.pair = Math.floor(pair);
  return limits.hops !== undefined || limits.pair !== undefined ? limits : undefined;
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
    // D94 §5.5: 分享目标快照（主进程写进 App Group 供 Share Extension 读）。
    'share.targets': {
      input: voidInput,
      output: shareTargetsSchema,
      handle: async (): Promise<ShareTargets> => {
        if (services.share === null) {
          throw new AppError('NOT_FOUND', '分享服务尚未就绪');
        }
        return services.share.targets();
      },
    },
    // D94 §5.5: 消费一个分享批次（主进程把 App Group inbox 移进 core inbox 后调）。
    'share.consume': {
      input: shareConsumeInputSchema,
      output: shareConsumeOutputSchema,
      handle: async (input): Promise<ShareConsumeOutput> => {
        if (services.share === null) {
          throw new AppError('NOT_FOUND', '分享服务尚未就绪');
        }
        return services.share.consume(input as ShareConsumeInput);
      },
    },
    'unattended.disable': {
      input: voidInput,
      output: unattendedGetOutputSchema,
      handle: async () => services.domain!.unattended.disable('tray'),
    },
    // D96 远程遥控：托盘读状态 / 切开关 / 发起配对（端口 B）。与 app 侧同一 hub。
    'remote.status': {
      input: voidInput,
      output: remoteStatusOutputSchema,
      handle: async () => {
        if (services.remote === null) throw new AppError('NOT_IMPLEMENTED', '远程遥控服务未就绪');
        return services.remote.status();
      },
    },
    'remote.createPairing': {
      input: voidInput,
      output: remoteCreatePairingOutputSchema,
      handle: async () => {
        if (services.remote === null) throw new AppError('NOT_IMPLEMENTED', '远程遥控服务未就绪');
        return services.remote.createPairing();
      },
    },
    'remote.config.set': {
      input: remoteConfigSetInputSchema,
      output: remoteConfigSetOutputSchema,
      handle: async (input) => {
        if (services.remote === null) throw new AppError('NOT_IMPLEMENTED', '远程遥控服务未就绪');
        return services.remote.configSet(input as { enabled?: boolean; relayUrl?: string });
      },
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
        // W7: watch timers stalled with the OS too — check what is due now
        // (non-blocking: the pass runs in the background).
        services.watches?.wake();
        services.mail?.wake();
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
    // W8 自动接管 · 交还：the main process reports that the user handed a bot
    // page back; its running browser-using tasks get "先 browser_snapshot".
    'browser.controlReturned': {
      input: browserControlReturnedInputSchema,
      output: browserControlReturnedOutputSchema,
      handle: async (input) => {
        const { botId, conversationId, reason } = input as {
          botId: string;
          conversationId: string;
          reason: string;
        };
        if (services.orchestrator === null) return { injected: 0 };
        const injected = services.orchestrator.tasks.notifyBrowserHandback(botId, conversationId);
        services.logger.info(
          { botId, conversationId, reason, injected },
          'browser control returned',
        );
        return { injected };
      },
    },
    // D73 P3 §7.5: the protocol handler fetches a registered MCP App page.
    ...bindAppsUiMethods(services).platform,
    // D81: the same protocol handler fetches a registered bot-widget page (host prefix `widget-`).
    ...bindWidgetsUiMethods(services).platform,
    // kepcup-file 协议处理器（docs/design/47）：按会话 token 取目录内文件。
    ...bindFilesPreviewMethods(services).platform,
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
