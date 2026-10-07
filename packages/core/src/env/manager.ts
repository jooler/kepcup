import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  AppError,
  environmentApprovalPayloadSchema,
  newId,
  type EnvInstall,
  type EnvSystemStatus,
} from '@kepcup/shared';
import { toolchainPathFor, type AppPaths } from '../infra/paths.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { RunIdentity } from '../agent/types.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { ApprovalsService } from '../permissions/approvals.js';
import {
  detectSystemItem,
  linuxGitInstallCommand,
  locateSystemItem,
  checkInstallHealth,
} from './doctor.js';
import { directorySize, Installer, resolveBinDir, runCommand } from './installer.js';
import {
  embeddingBundleEntries,
  isFileVerify,
  platformKey,
  type Catalog,
  type CatalogEntry,
  type CatalogPlatform,
} from './catalog.js';
import { distroToolchainDir, isDistroRow, type DistroToolchainInstaller } from './distro.js';

/** 体积的卡片/日志展示（MB，一位小数）。 */
function mbLabel(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Environment manager (docs/design/07-local-runtime.md "宿主层"): shared,
 * host-level tools installed on request. Requests go through a NON-BLOCKING
 * `environment` approval (the tool returns immediately; docs 任务 3), the
 * serial installer runs the job, and the outcome is delivered to the
 * requesting bot's mailbox as an `event` trigger via #notifyBot (wired to
 * Orchestrator.deliverEventToBot after construction). 环境是 Bot 自己的运行
 * 体：安装全过程的通报都是 Bot 内部事务（internal 事件），只进 Bot 的上下文，
 * 不作为对话内容展示；用户可见的面是审批卡片与设置页的环境列表。
 *
 * Deletion semantics (docs/dev/03-data-model.md): toolchains are shared by
 * all bots — requested_by is a record, not an owner. Bot deletion and
 * conversation deletion never delete installs; `environment.remove` is the
 * only removal path (status removed + directory deleted).
 */

interface InstallRow {
  id: string;
  item: string;
  version: string;
  rel_path: string;
  size_bytes: number | null;
  status: EnvInstall['status'];
  requested_by: string | null;
  approval_id: string | null;
  installed_at: number | null;
  last_used_at: number | null;
}

export interface EnvManagerDeps {
  db: SqliteDatabase;
  paths: AppPaths;
  clock: Clock;
  logger: CoreLogger;
  approvals: ApprovalsService;
  bots: BotsService;
  conversations: ConversationsService;
  /** Core event bus (environment.progress / environment.changed). */
  publish: (event: string, payload: unknown) => void;
  catalog: Catalog;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /**
   * P12: distro-internal toolchain installer (Windows hosts). Undefined on
   * other platforms and in stripped unit setups — a `wslDistro` request on
   * such a machine fails with a clear reason instead of silently installing
   * to the wrong place.
   */
  distroInstaller?: DistroToolchainInstaller | undefined;
  /**
   * kind='system' guidance (docs 任务 1 git): macOS opens the OS installer
   * (xcode-select — the system owns the authorization). Injectable so tests
   * record the call instead of spawning the real installer dialog.
   */
  runSystemAction?: (entry: CatalogEntry) => Promise<void>;
  /** PATH for kind='system' detection (tests point at a fixture directory). */
  systemDetectionPath?: string;
  /**
   * P07: 本地向量模型（含前置运行库）安装完成后的回调（start.ts 转接到
   * MemoryService#handleEmbeddingModelInstalled，触发一次向量索引重建）。
   */
  onEmbeddingModelInstalled?: () => void;
}

export type RequestOutcome =
  | { status: 'installed'; item: string; version: string; path: string; system: boolean }
  | { status: 'installing'; item: string }
  | { status: 'submitted'; item: string; approvalId: string };

interface SystemWaiter {
  botId: string;
  conversationId: string;
  item: string;
}

/** Installed toolchains exposed to the sandbox policy / prompt. */
export interface InstalledToolchain {
  item: string;
  version: string;
  binDirs: string[];
  rootDir: string;
}

const LAST_USED_THROTTLE_MS = 60_000;
/** ensureToolchain: polling cadence / cap while another flow installs the item. */
const ENSURE_POLL_MS = 1_000;
const ENSURE_WAIT_MAX_MS = 30 * 60_000;

export class EnvManager {
  readonly #deps: EnvManagerDeps;
  readonly #installer: Installer;
  /** kind='system' live detection, refreshed by doctor/recheck. */
  readonly #systemStatus = new Map<string, EnvSystemStatus>();
  /** Bots waiting for a kind='system' item the user must install manually. */
  readonly #systemWaiters = new Map<string, SystemWaiter[]>();
  /**
   * Late-wired internal event delivery (Orchestrator.deliverEventToBot with
   * internal: true — 安装通报是 Bot 内部事务，不进对话).
   */
  #notifyBot: (
    botId: string,
    conversationId: string,
    event: string,
    text: string,
    options?: { internal?: boolean },
  ) => void = () => {};
  #lastUseNote = 0;
  /** ensureToolchain installs in flight, per item. */
  readonly #ensuring = new Map<string, Promise<string>>();

  constructor(deps: EnvManagerDeps) {
    this.#deps = deps;
    this.#installer = new Installer({
      paths: deps.paths,
      logger: deps.logger,
      clock: deps.clock,
      ...(deps.env !== undefined ? { env: deps.env } : {}),
    });
    mkdirSync(deps.paths.toolchainsDir, { recursive: true });
  }

  /** Called by start.ts once the orchestrator exists. */
  setNotifier(
    fn: (
      botId: string,
      conversationId: string,
      event: string,
      text: string,
      options?: { internal?: boolean },
    ) => void,
  ): void {
    this.#notifyBot = fn;
  }

  get #db(): SqliteDatabase {
    return this.#deps.db;
  }

  /** Catalog items offered on this machine (unknown-item listing for the tool). */
  offeredItems(): string[] {
    const key = platformKey(process.platform, process.arch);
    return this.#deps.catalog
      .filter((entry) => key !== null && entry.platforms[key] !== undefined)
      .map((entry) => `${entry.item}（${entry.displayName} ${entry.version}）`);
  }

  // --- requesting -----------------------------------------------------------

  /** `request_environment` (docs 任务 3): never blocks on approval or install. */
  async request(
    identity: RunIdentity,
    input: { item: string; version?: string; reason: string },
  ): Promise<RequestOutcome> {
    if (identity.conversationId === null) {
      // The approval card lives in a conversation (docs 07 "宿主层" 流程).
      throw new AppError('INVALID_INPUT', '环境申请需要对话上下文');
    }
    const entry = this.catalogEntry(input.item);
    const key = platformKey(process.platform, process.arch);
    if (key === null || entry.platforms[key] === undefined) {
      throw new AppError(
        'ENV_ITEM_UNSUPPORTED_PLATFORM',
        `当前平台（${process.platform}-${process.arch}）暂不提供 ${input.item} 的自动安装`,
      );
    }
    const platform = entry.platforms[key]!;

    // Already usable? Installed rows first, then system items.
    const existing = this.activeRowFor(input.item);
    if (existing) {
      if (existing.status === 'installed') {
        return {
          status: 'installed',
          item: existing.item,
          version: existing.version,
          path:
            this.binDirsForRow(existing)[0] ??
            toolchainPathFor(this.#deps.paths, existing.item, existing.version),
          system: false,
        };
      }
      if (existing.status === 'installing') {
        return { status: 'installing', item: existing.item };
      }
    }
    if (platform.kind === 'system') {
      const detection = await detectSystemItem(entry);
      if (detection.available) {
        const located = await locateSystemItem(input.item, entry.detectBin);
        return {
          status: 'installed',
          item: input.item,
          version: entry.version,
          path: located ?? input.item,
          system: true,
        };
      }
    }

    // Version override: only the catalog version is ever fetched.
    if (input.version !== undefined && input.version !== entry.version) {
      this.#deps.logger.info(
        { item: input.item, requested: input.version, catalog: entry.version },
        'ignoring requested version, using catalog version',
      );
    }

    // One undecided card per item: a second request reuses the first (BR-P06-004).
    const pending = this.#deps.approvals.pendingEnvironmentFor(input.item);
    if (pending !== null) {
      return { status: 'submitted', item: input.item, approvalId: pending.id };
    }

    const payload = this.#bundleAwarePayload(entry, platform, input.reason);
    const approval = this.#deps.approvals.submitNonBlocking(
      identity,
      'environment',
      payload,
      (outcome) => {
        // outcome.approval (not the outer const): unattended mode fires the
        // callback synchronously before the const initializes.
        if (outcome.decision === 'approved') {
          if (platform.kind === 'system') {
            void this.#handleSystemApproval(identity, entry);
          } else {
            void this.#installAfterApproval(identity, entry, { approvalId: outcome.approval.id });
          }
          return;
        }
        // The tool promised "you'll hear back" — a refusal is that signal too
        // (BR-P06-003): the bot must stop waiting and adjust. 内部事务：决定是
        // 用户在卡片上亲手做的，通报只进 Bot 的上下文，不再向对话播报。
        const event =
          outcome.decision === 'denied'
            ? 'environment_install_denied'
            : 'environment_install_cancelled';
        this.#notifyBot(
          identity.botId ?? '',
          identity.conversationId ?? '',
          event,
          outcome.decision === 'denied'
            ? `你申请的环境 ${entry.displayName} 被用户拒绝了。不要重复申请同一环境，改用 workspace 内可完成的方案，或向用户确认替代做法。`
            : `环境 ${entry.displayName} 的安装申请已取消（执行被中止或对话被删除）。`,
          { internal: true },
        );
      },
    );
    return { status: 'submitted', item: input.item, approvalId: approval.id };
  }

  /**
   * System-initiated request (P07 首次需要向量时): botId is null — the card
   * is posted to one conversation by the system, not by a bot. Same
   * non-blocking flow as `request` (docs 任务 3). 决定与安装结果不再向对话
   * 通报（内部事务原则）：用户可见的面是审批卡片与设置页环境列表；批准/
   * 拒绝/取消只留日志。
   */
  async requestAsSystem(input: {
    conversationId: string;
    item: string;
    reason: string;
  }): Promise<RequestOutcome> {
    const identity: RunIdentity = {
      runId: '',
      botId: null,
      conversationId: input.conversationId,
      loopType: 'response',
    };
    if (this.#deps.conversations.get(input.conversationId) === null) {
      throw new AppError('NOT_FOUND', `Conversation ${input.conversationId} does not exist`);
    }
    const entry = this.catalogEntry(input.item);
    const key = platformKey(process.platform, process.arch);
    if (key === null || entry.platforms[key] === undefined) {
      throw new AppError(
        'ENV_ITEM_UNSUPPORTED_PLATFORM',
        `当前平台（${process.platform}-${process.arch}）暂不提供 ${input.item} 的自动安装`,
      );
    }
    const platform = entry.platforms[key]!;

    const existing = this.activeRowFor(input.item);
    if (existing?.status === 'installed') {
      return {
        status: 'installed',
        item: existing.item,
        version: existing.version,
        path:
          this.binDirsForRow(existing)[0] ??
          toolchainPathFor(this.#deps.paths, existing.item, existing.version),
        system: false,
      };
    }
    if (existing?.status === 'installing') {
      return { status: 'installing', item: existing.item };
    }

    const pending = this.#deps.approvals.pendingEnvironmentFor(input.item);
    if (pending !== null) {
      return { status: 'submitted', item: input.item, approvalId: pending.id };
    }

    const payload = this.#bundleAwarePayload(entry, platform, input.reason);
    const approval = this.#deps.approvals.submitNonBlocking(
      identity,
      'environment',
      payload,
      (outcome) => {
        if (outcome.decision === 'approved') {
          if (platform.kind === 'system') {
            void this.#handleSystemApproval(identity, entry);
          } else {
            void this.#installAfterApproval(identity, entry, { approvalId: outcome.approval.id });
          }
          return;
        }
        this.#deps.logger.info(
          { item: entry.item, decision: outcome.decision },
          'system-initiated environment request decided',
        );
      },
    );
    return { status: 'submitted', item: input.item, approvalId: approval.id };
  }

  /**
   * kind='system' approval (macOS/Linux git): nothing is downloaded and no
   * install row is created. macOS opens the OS installer (xcode-select — the
   * system owns the authorization, docs 任务 1); Linux only ever had the card
   * command. The waiter is notified as soon as a detection (startup, daily,
   * or the settings-page recheck) finds the item available.
   */
  async #handleSystemApproval(identity: RunIdentity, entry: CatalogEntry): Promise<void> {
    const detectionOptions = this.#detectionOptions();
    if (
      process.platform === 'darwin' &&
      entry.install.via === 'system' &&
      entry.install.macAction === 'xcode-select'
    ) {
      const runAction =
        this.#deps.runSystemAction ??
        (async (systemEntry) => {
          await runCommand('xcode-select', ['--install'], { timeoutMs: 30_000 });
          void systemEntry;
        });
      try {
        await runAction(entry);
      } catch (error) {
        // Non-zero (already requested / already installed) must not fail the
        // flow: the user completes the dialog and recheck settles the state.
        this.#deps.logger.info(
          { item: entry.item, error: error instanceof Error ? error.message : String(error) },
          'xcode-select --install returned non-zero',
        );
      }
    }

    const waiters = this.#systemWaiters.get(entry.item) ?? [];
    waiters.push({
      botId: identity.botId ?? '',
      conversationId: identity.conversationId ?? '',
      item: entry.item,
    });
    this.#systemWaiters.set(entry.item, waiters);

    const detection = await detectSystemItem(entry, detectionOptions);
    if (detection.available) {
      this.#resolveSystemWaiters(entry.item, detection);
      return;
    }
    this.#systemStatus.set(entry.item, { item: entry.item, ...detection });
    const guidance = this.#systemGuidance(entry);
    this.#notifyBot(
      identity.botId ?? '',
      identity.conversationId ?? '',
      'environment_pending_system',
      `已为你发起 ${entry.displayName}（系统级）安装：${guidance}环境体检（或设置页「重新检测」）发现它可用时会通知你；期间不要重复申请同一环境。`,
      { internal: true },
    );
    this.#deps.publish('environment.changed', {
      installs: this.listInstalls(),
      system: this.systemStatuses(),
    });
  }

  #detectionOptions(): { PATH?: string } {
    return this.#deps.systemDetectionPath !== undefined
      ? { PATH: this.#deps.systemDetectionPath }
      : {};
  }

  #systemGuidance(entry: CatalogEntry): string {
    // P12: system items with explicit guidance (lima/podman) carry it on the
    // entry — no automatic action exists for them.
    if (entry.install.via === 'system' && entry.install.guide !== undefined) {
      return entry.install.guide;
    }
    if (process.platform === 'darwin') {
      return '系统安装器已打开（可能要求安装开发者工具，由系统完成授权），请在弹出的窗口中完成安装。';
    }
    return `请在终端执行：${linuxGitInstallCommand()}，然后到设置页「环境」点击「重新检测」。`;
  }

  /** Notifies waiters whose system item has become available (recheck hook). */
  #resolveSystemWaiters(item: string, detection: { available: boolean; detail: string }): void {
    const waiters = this.#systemWaiters.get(item);
    if (!waiters || waiters.length === 0) return;
    this.#systemWaiters.delete(item);
    if (!detection.available) return;
    for (const waiter of waiters) {
      this.#notifyBot(
        waiter.botId,
        waiter.conversationId,
        'environment_installed',
        `环境 ${item} 已在系统中可用（${detection.detail}）。如果有因等待它而搁置的任务，继续完成；没有的话不必向用户汇报环境状态。`,
        { internal: true },
      );
    }
  }

  /** Reuses an existing row so the settings list keeps one entry per item. */
  async reinstall(rowId: string): Promise<EnvInstall | null> {
    const row = this.getRow(rowId);
    if (!row) return null;
    const entry = this.catalogEntry(row.item);
    const identity: RunIdentity = {
      runId: '',
      botId: row.requested_by,
      conversationId: null,
      loopType: 'response',
    };
    this.#updateRow(row.id, { status: 'installing' });
    this.#publishChanged();
    void this.#installAfterApproval(identity, entry, { existingRowId: row.id });
    return this.getInstall(row.id);
  }

  async #installAfterApproval(
    identity: RunIdentity,
    entry: CatalogEntry,
    links: { approvalId?: string; existingRowId?: string } = {},
  ): Promise<void> {
    const { paths, clock } = this.#deps;
    const key = platformKey(process.platform, process.arch)!;
    const platform = entry.platforms[key]!;
    // kind='system' never downloads — approvals route to #handleSystemApproval.
    // Reaching here would fabricate a failed install row (BR-P06-001).
    if (platform.kind === 'system') {
      this.#deps.logger.warn(
        { item: entry.item },
        'system item reached the archive installer; ignoring',
      );
      return;
    }
    // P12: wslDistro items on a Windows host install INTO the private distro.
    if (entry.wslDistro === true && (this.#deps.platform ?? process.platform) === 'win32') {
      return this.#installIntoDistro(identity, entry, links);
    }
    const rowId = links.existingRowId ?? this.#createRow(entry, identity, links.approvalId ?? null);
    const targetDir = toolchainPathFor(paths, entry.item, entry.version);

    try {
      // P07: embedding-model 的前置运行库（共用一张审批卡）：先确保
      // onnxruntime 就绪，再装模型——与 uv→python 的链式模式一致。
      if (entry.item === 'embedding-model') {
        await this.#ensureChainedItem('onnxruntime', identity, rowId);
      }

      // python requires uv; ensure it first (docs 任务 1: 先确保 uv).
      let uvBin: string | undefined;
      if (entry.install.via === 'uv-python') {
        uvBin = await this.#ensureUv(entry, identity, rowId);
      }

      const result = await this.#installer.enqueue({
        installId: rowId,
        entry,
        platformKey: key,
        platform,
        targetDir,
        ...(uvBin !== undefined ? { uvBin } : {}),
        onProgress: (stage, extra) => this.#onProgress(rowId, entry, stage, extra),
      });
      if (!result.ok || result.binDir === null) {
        this.#updateRow(rowId, { status: 'failed' });
        this.#notifyBot(
          identity.botId ?? '',
          identity.conversationId ?? '',
          'environment_install_failed',
          `环境 ${entry.displayName} ${entry.version} 安装失败：${result.error ?? '未知原因'}。如果有因等待它而搁置的任务，改用其它可行方案完成；必要时用一句话向用户说明任务受到的影响，不要复述安装细节。`,
          { internal: true },
        );
        this.#publishChanged();
        return;
      }
      this.#updateRow(rowId, {
        status: 'installed',
        installed_at: clock.now(),
        size_bytes: directorySize(targetDir),
      });
      this.#notifyBot(
        identity.botId ?? '',
        identity.conversationId ?? '',
        'environment_installed',
        `环境 ${entry.displayName} ${entry.version} 已就绪。如果有因等待它而搁置的任务，继续完成；没有的话不必向用户汇报环境状态。`,
        { internal: true },
      );
      // P07: 本地向量模型落位后触发一次向量索引重建（旧条目此前只有 FTS）。
      if (entry.item === 'embedding-model') {
        try {
          this.#deps.onEmbeddingModelInstalled?.();
        } catch (error) {
          this.#deps.logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'onEmbeddingModelInstalled callback failed',
          );
        }
      }
      this.#publishChanged();
    } catch (error) {
      // Orchestration exceptions (e.g. the uv prerequisite) are failures the
      // requesting bot must hear about — the tool promised a notification.
      const message = error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
      this.#updateRow(rowId, { status: 'failed' });
      this.#deps.logger.warn({ item: entry.item, error: message }, 'install orchestration failed');
      this.#notifyBot(
        identity.botId ?? '',
        identity.conversationId ?? '',
        'environment_install_failed',
        `环境 ${entry.displayName} ${entry.version} 安装失败：${message}。如果有因等待它而搁置的任务，改用其它可行方案完成；必要时用一句话向用户说明任务受到的影响，不要复述安装细节。`,
        { internal: true },
      );
      this.#publishChanged();
    }
  }

  /**
   * P07: 链式前置安装（embedding-model → onnxruntime，模式同 #ensureUv）：
   * 已安装则复用；否则自建一行（toolchains 共享，设置页能看到独立条目），
   * 进度并到父行的卡片上。失败抛出，由父安装流程标 failed。
   */
  async #ensureChainedItem(
    item: string,
    identity: RunIdentity,
    parentRowId: string,
  ): Promise<void> {
    const entry = this.catalogEntry(item);
    const existing = this.activeRowFor(item);
    if (existing?.status === 'installed') return;
    const key = platformKey(process.platform, process.arch);
    const platform = key !== null ? entry.platforms[key] : undefined;
    if (key === null || platform === undefined) {
      throw new AppError('ENV_ITEM_UNSUPPORTED_PLATFORM', `当前平台无法安装 ${entry.displayName}`);
    }
    const rowId = existing?.id ?? this.#createRow(entry, identity, null);
    if (existing === undefined) this.#updateRow(rowId, { status: 'installing' });
    this.#publishChanged();
    const targetDir = toolchainPathFor(this.#deps.paths, entry.item, entry.version);
    const result = await this.#installer.enqueue({
      installId: `${parentRowId}:${item}`,
      entry,
      platformKey: key,
      platform,
      targetDir,
      onProgress: (stage, extra) => {
        // Report under the parent row so the card shows one coherent progress.
        this.#onProgress(parentRowId, entry, stage, extra);
      },
    });
    if (!result.ok || result.binDir === null) {
      this.#updateRow(rowId, { status: 'failed' });
      this.#publishChanged();
      throw new AppError(
        'ENV_INSTALL_FAILED',
        `前置依赖 ${entry.displayName} 安装失败：${result.error ?? '未知原因'}`,
      );
    }
    this.#updateRow(rowId, {
      status: 'installed',
      installed_at: this.#deps.clock.now(),
      size_bytes: directorySize(targetDir),
    });
    this.#publishChanged();
  }

  /** uv for python installs: reuse an installed uv or install it inline. */
  async #ensureUv(
    entry: CatalogEntry,
    identity: RunIdentity,
    parentRowId: string,
  ): Promise<string> {
    const uvEntry = this.catalogEntry('uv');
    const existing = this.activeRowFor('uv');
    if (existing?.status === 'installed') {
      const dirs = this.binDirsForRow(existing);
      const bin =
        dirs[0] !== undefined
          ? path.join(dirs[0], process.platform === 'win32' ? 'uv.exe' : 'uv')
          : null;
      if (bin !== null && existsSync(bin)) return bin;
    }
    const key = platformKey(process.platform, process.arch)!;
    const platform = uvEntry.platforms[key];
    if (platform === undefined) {
      throw new AppError('ENV_ITEM_UNSUPPORTED_PLATFORM', '当前平台无法安装 uv');
    }
    // The chained uv install gets its own row: toolchains are shared, so the
    // PATH prefix and the settings list must include it (approval covered by
    // the python card, docs 任务 1 "先确保 uv").
    const uvRowId = existing?.id ?? this.#createRow(uvEntry, identity, null);
    if (existing === undefined) this.#updateRow(uvRowId, { status: 'installing' });
    const targetDir = toolchainPathFor(this.#deps.paths, uvEntry.item, uvEntry.version);
    const result = await this.#installer.enqueue({
      installId: `${parentRowId}:uv`,
      entry: uvEntry,
      platformKey: key,
      platform,
      targetDir,
      onProgress: (stage, extra) => {
        // Report under the python row so the card shows one coherent progress.
        this.#onProgress(parentRowId, uvEntry, stage, extra);
      },
    });
    if (!result.ok || result.binDir === null) {
      this.#updateRow(uvRowId, { status: 'failed' });
      throw new AppError(
        'ENV_INSTALL_FAILED',
        `前置依赖 uv 安装失败：${result.error ?? '未知原因'}`,
      );
    }
    this.#updateRow(uvRowId, {
      status: 'installed',
      installed_at: this.#deps.clock.now(),
      size_bytes: directorySize(targetDir),
    });
    this.#publishChanged();
    return path.join(result.binDir, process.platform === 'win32' ? 'uv.exe' : 'uv');
  }

  /**
   * P12: installs a `wslDistro` item INTO the private WSL2 distro
   * (docs/dev/phases/P12 任务书「工具链」). node: stage the linux tarball on
   * the host (checksum verified; host-run verification skipped — linux
   * binaries cannot execute there), move it into the distro, verify
   * in-distro. python: `uv python install` runs inside the distro (uv ships
   * in the rootfs). The row's rel_path carries the resolved DISTRO bin dir
   * so the WSL backend's PATH prefix finds it.
   */
  async #installIntoDistro(
    identity: RunIdentity,
    entry: CatalogEntry,
    links: { approvalId?: string; existingRowId?: string } = {},
  ): Promise<void> {
    const { clock, paths } = this.#deps;
    const installer = this.#deps.distroInstaller;
    const rowId = links.existingRowId ?? this.#createRow(entry, identity, links.approvalId ?? null);
    const fail = async (message: string): Promise<void> => {
      this.#updateRow(rowId, { status: 'failed' });
      this.#deps.logger.warn({ item: entry.item, error: message }, 'distro install failed');
      this.#notifyBot(
        identity.botId ?? '',
        identity.conversationId ?? '',
        'environment_install_failed',
        `环境 ${entry.displayName} ${entry.version} 安装失败：${message}。如果有因等待它而搁置的任务，改用其它可行方案完成；必要时用一句话向用户说明任务受到的影响，不要复述安装细节。`,
        { internal: true },
      );
      this.#publishChanged();
    };
    if (installer === undefined || !(await installer.available())) {
      await fail('WSL2 发行版未就绪，无法安装发行版内工具链（先在设置页完成 Windows 沙箱准备）');
      return;
    }
    const linuxKey = platformKey('linux', process.arch);
    const linuxPlatform = linuxKey !== null ? entry.platforms[linuxKey] : undefined;
    if (linuxPlatform === undefined) {
      await fail(`目录缺少 ${`linux-${process.arch}`} 产物，无法安装到发行版`);
      return;
    }
    try {
      this.#onProgress(rowId, entry, 'downloading', { total: linuxPlatform.sizeBytes });
      let distroBinDir: string;
      if (entry.install.via === 'uv-python') {
        const distroDir = distroToolchainDir(entry.item, entry.version);
        this.#onProgress(rowId, entry, 'extracting');
        distroBinDir = await installer.installPythonViaUv({
          pythonVersion: entry.install.pythonVersion,
          distroDir,
        });
      } else {
        const staged = toolchainPathFor(paths, entry.item, entry.version);
        const result = await this.#installer.enqueue({
          installId: rowId,
          entry,
          platformKey: linuxKey!,
          platform: linuxPlatform,
          targetDir: staged,
          binaryPlatform: 'linux',
          verify: false,
          onProgress: (stage, extra) => this.#onProgress(rowId, entry, stage, extra),
        });
        if (!result.ok) {
          await fail(result.error ?? '未知原因');
          return;
        }
        const distroDir = distroToolchainDir(entry.item, entry.version);
        this.#onProgress(rowId, entry, 'extracting');
        await installer.extractDir(staged, distroDir);
        rmSync(staged, { recursive: true, force: true });
        distroBinDir = `${distroDir}/bin`;
        this.#onProgress(rowId, entry, 'checking');
        if (!isFileVerify(entry.verify)) {
          await installer.verify({
            command: entry.verify.command,
            expect: entry.verify.expect,
            binName: entry.item,
            binDir: distroBinDir,
            targetDir: distroDir,
          });
        }
      }
      this.#db
        .prepare('update env_installs set status = ?, rel_path = ?, installed_at = ? where id = ?')
        .run('installed', distroBinDir, clock.now(), rowId);
      this.#notifyBot(
        identity.botId ?? '',
        identity.conversationId ?? '',
        'environment_installed',
        `环境 ${entry.displayName} ${entry.version} 已在 Windows 沙箱（WSL2 发行版）中就绪。如果有因等待它而搁置的任务，继续完成；没有的话不必向用户汇报环境状态。`,
        { internal: true },
      );
      this.#publishChanged();
    } catch (error) {
      await fail(error instanceof AppError ? `${error.code}: ${error.message}` : String(error));
    }
  }

  #onProgress(
    rowId: string,
    entry: CatalogEntry,
    stage: string,
    extra?: { received?: number; total?: number; error?: string },
  ): void {
    this.#deps.publish('environment.progress', {
      installId: rowId,
      item: entry.item,
      version: entry.version,
      stage,
      ...(extra?.received !== undefined ? { receivedBytes: extra.received } : {}),
      ...(extra?.total !== undefined ? { totalBytes: extra.total } : {}),
      ...(extra?.error !== undefined ? { error: extra.error } : {}),
    });
  }

  // --- health / doctor ------------------------------------------------------

  /** Startup recovery: an interrupted process can't have finished an install. */
  recoverInterrupted(): number {
    const rows = this.#db
      .prepare("select * from env_installs where status = 'installing'")
      .all() as InstallRow[];
    for (const row of rows) {
      this.#updateRow(row.id, { status: 'failed' });
      rmSync(toolchainPathFor(this.#deps.paths, row.item, row.version), {
        recursive: true,
        force: true,
      });
    }
    if (rows.length > 0) {
      this.#deps.logger.info({ rows: rows.length }, 'recovered interrupted env installs');
      this.#publishChanged();
    }
    return rows.length;
  }

  /** Doctor run: verify installed rows + re-detect system items. */
  async recheck(): Promise<EnvInstall[]> {
    const rows = this.listRows().filter((row) => row.status === 'installed');
    for (const row of rows) {
      // P12 distro rows are verified in-distro at install time; the host
      // cannot execute their binaries, so the doctor skips them.
      if (isDistroRow(row.rel_path)) continue;
      const entry = this.#deps.catalog.find((e) => e.item === row.item);
      const targetDir = toolchainPathFor(this.#deps.paths, row.item, row.version);
      const binDirs = this.binDirsForRow(row);
      const binDir = binDirs[0] ?? targetDir;
      if (entry === undefined) {
        this.#updateRow(row.id, { status: 'failed' });
        continue;
      }
      const health = await checkInstallHealth(entry, binDir, targetDir);
      // A broken install becomes a failed row: the settings page offers
      // reinstall (docs 任务 6), PATH injection drops it automatically.
      this.#updateRow(row.id, { status: health.healthy ? 'installed' : 'failed' });
    }
    await this.#refreshSystemStatus();
    // Users finish the OS installer asynchronously — every recheck (startup,
    // daily, settings page) is the moment waiting bots learn the outcome.
    for (const [item, status] of this.#systemStatus) {
      this.#resolveSystemWaiters(item, status);
    }
    this.#publishChanged();
    return this.listInstalls();
  }

  async #refreshSystemStatus(): Promise<void> {
    const key = platformKey(process.platform, process.arch);
    if (key === null) return;
    const detectionOptions = this.#detectionOptions();
    for (const entry of this.#deps.catalog) {
      const platform = entry.platforms[key];
      if (platform === undefined || platform.kind !== 'system') continue;
      const detection = await detectSystemItem(entry, detectionOptions);
      this.#systemStatus.set(entry.item, { item: entry.item, ...detection });
    }
  }

  // --- queries --------------------------------------------------------------

  listRows(): InstallRow[] {
    return this.#db
      .prepare('select * from env_installs order by installed_at is not null desc, rowid desc')
      .all() as InstallRow[];
  }

  getRow(id: string): InstallRow | null {
    return (
      (this.#db.prepare('select * from env_installs where id = ?').get(id) as
        InstallRow | undefined) ?? null
    );
  }

  getInstall(id: string): EnvInstall | null {
    const row = this.getRow(id);
    return row ? this.toInstall(row) : null;
  }

  listInstalls(): EnvInstall[] {
    return this.listRows().map((row) => this.toInstall(row));
  }

  toInstall(row: InstallRow): EnvInstall {
    const healthy = row.status === 'installed' ? true : row.status === 'failed' ? false : null;
    return {
      id: row.id,
      item: row.item,
      version: row.version,
      relPath: row.rel_path,
      sizeBytes: row.size_bytes,
      status: row.status,
      requestedBy: row.requested_by,
      approvalId: row.approval_id,
      installedAt: row.installed_at,
      lastUsedAt: row.last_used_at,
      binDirs: row.status === 'installed' ? this.binDirsForRow(row) : [],
      healthy,
    };
  }

  systemStatuses(): EnvSystemStatus[] {
    return [...this.#systemStatus.values()];
  }

  /** Installed toolchains for the sandbox policy and the workspace prompt. */
  installedToolchains(): InstalledToolchain[] {
    const result: InstalledToolchain[] = [];
    for (const row of this.listRows()) {
      if (row.status !== 'installed') continue;
      const binDirs = this.binDirsForRow(row);
      if (binDirs.length === 0) continue;
      result.push({
        item: row.item,
        version: row.version,
        binDirs,
        rootDir: toolchainPathFor(this.#deps.paths, row.item, row.version),
      });
    }
    return result;
  }

  /**
   * P08 dependency check for scanned skills: `bash` is the host shell; other
   * dependencies are satisfied by an installed toolchain row, a system item
   * detected by the doctor, or — as a last resort — a live `--version` probe
   * (an unknown dependency is reported missing so the bot/user can request it
   * via request_environment).
   */
  depAvailable(dep: string): boolean {
    if (dep === 'bash' || dep === 'sh') return process.platform !== 'win32';
    const row = this.activeRowFor(dep);
    if (row !== null && row.status === 'installed') return true;
    if (this.#systemStatus.get(dep)?.available === true) return true;
    // Live probe for common system runtimes: keeps the check honest when the
    // doctor has not run yet (its result lands in #systemStatus afterwards).
    if (dep === 'git' || dep === 'python' || dep === 'node') {
      const probe = spawnSync(dep === 'python' ? 'python3' : dep, ['--version'], {
        stdio: 'ignore',
      });
      return probe.error === undefined && probe.status === 0;
    }
    return false;
  }

  /** PATH prefix for sandbox + confirm mode; null when nothing is installed. */
  toolchainPathPrefix(platform: string): string | null {
    const dirs = this.installedToolchains().flatMap((toolchain) =>
      toolchain.binDirs.filter((dir) => existsSync(dir)),
    );
    if (dirs.length === 0) return null;
    return dirs.join(platform === 'win32' ? ';' : ':');
  }

  /** Throttled last_used_at bump (policy builds are per command). */
  noteToolchainUse(): void {
    const now = this.#deps.clock.now();
    if (now - this.#lastUseNote < LAST_USED_THROTTLE_MS) return;
    this.#lastUseNote = now;
    this.#db
      .prepare("update env_installs set last_used_at = ? where status = 'installed'")
      .run(now);
  }

  // --- removal ---------------------------------------------------------------

  /** `environment.remove`: the only removal path; toolchains are shared. */
  remove(id: string): void {
    const row = this.getRow(id);
    if (!row) throw new AppError('NOT_FOUND', `安装记录 ${id} 不存在`);
    if (row.status === 'installing') {
      throw new AppError('INVALID_INPUT', '该项正在安装，请等待完成后再删除');
    }
    if (row.status === 'removed') return;
    this.#updateRow(id, { status: 'removed' });
    if (isDistroRow(row.rel_path)) {
      // P12: distro rows are removed inside the distro (best-effort — a
      // removed row always drops out of PATH injection and the list).
      void this.#deps.distroInstaller
        ?.removeDir(row.rel_path.endsWith('/bin') ? path.dirname(row.rel_path) : row.rel_path)
        .catch((error: unknown) => {
          this.#deps.logger.warn(
            { item: row.item, error: error instanceof Error ? error.message : String(error) },
            'distro toolchain removal failed',
          );
        });
    } else {
      rmSync(toolchainPathFor(this.#deps.paths, row.item, row.version), {
        recursive: true,
        force: true,
      });
    }
    this.#deps.logger.info({ item: row.item, version: row.version }, 'environment removed');
    this.#publishChanged();
  }

  // --- internals -------------------------------------------------------------

  catalogEntry(item: string): CatalogEntry {
    const entry = this.#deps.catalog.find((e) => e.item === item);
    if (entry === undefined) {
      const available = this.#deps.catalog
        .map((e) => `${e.item}（${e.displayName} ${e.version}）`)
        .join('、');
      throw new AppError('ENV_ITEM_UNKNOWN', `未知的环境项：${item}。可申请的项有：${available}`, {
        available: this.#deps.catalog.map((e) => e.item),
      });
    }
    return entry;
  }

  activeRowFor(item: string): InstallRow | null {
    const row = this.#db
      .prepare(
        "select * from env_installs where item = ? and status in ('installed', 'installing') order by rowid desc limit 1",
      )
      .get(item) as InstallRow | undefined;
    return row ?? null;
  }

  /**
   * P07: 已安装条目的落位目录与版本（MemoryService 组装 LocalEmbedder 用）。
   * 仅认 'installed' 行；安装中/失败/未装返回 null——调用方以未安装处理。
   */
  installedFor(item: string): { dir: string; version: string } | null {
    const row = this.activeRowFor(item);
    if (row === null || row.status !== 'installed') return null;
    return {
      dir: toolchainPathFor(this.#deps.paths, row.item, row.version),
      version: row.version,
    };
  }

  /**
   * D72 外部智能体（`agent:{id}` 条目）的前置工具链：npx 来源需要 Node 运行时
   * 与其自带的 npm。用户在设置页「智能体」的安装确认卡上已看到该前置（体积、
   * 来源）并同意，这里不再另发审批卡——已安装则复用，否则按 uv→python 的
   * 链式模式就地安装（自建一行，设置页「环境」可见）。返回主 bin 目录。
   */
  async ensureToolchain(item: string): Promise<string> {
    // Concurrent callers (two agent installs) share one install.
    const inflight = this.#ensuring.get(item);
    if (inflight !== undefined) return inflight;
    const job = this.#ensureToolchainOnce(item).finally(() => {
      if (this.#ensuring.get(item) === job) this.#ensuring.delete(item);
    });
    this.#ensuring.set(item, job);
    return job;
  }

  async #ensureToolchainOnce(item: string): Promise<string> {
    // An install started elsewhere (approval card / reinstall): wait for it.
    const deadline = Date.now() + ENSURE_WAIT_MAX_MS;
    while (this.activeRowFor(item)?.status === 'installing') {
      if (Date.now() > deadline) {
        throw new AppError('ENV_INSTALL_FAILED', `等待 ${item} 安装超时`);
      }
      await new Promise((resolve) => setTimeout(resolve, ENSURE_POLL_MS));
    }
    if (this.activeRowFor(item)?.status !== 'installed') {
      const identity: RunIdentity = {
        runId: '',
        botId: null,
        conversationId: null,
        loopType: 'response',
      };
      await this.#ensureChainedItem(item, identity, `prereq:${item}`);
    }
    const row = this.activeRowFor(item);
    const binDir = row !== null ? this.binDirsForRow(row)[0] : undefined;
    if (binDir === undefined) {
      throw new AppError('ENV_VERIFY_FAILED', `${item} 安装后未找到可执行目录`);
    }
    return binDir;
  }

  binDirsForRow(row: InstallRow): string[] {
    if (row.status !== 'installed') return [];
    // P12 distro rows: rel_path stores the resolved in-distro bin directory
    // (the host cannot stat distro paths — the value is authoritative).
    if (isDistroRow(row.rel_path)) {
      return [row.rel_path.endsWith('/bin') ? row.rel_path : `${row.rel_path}/bin`];
    }
    const targetDir = toolchainPathFor(this.#deps.paths, row.item, row.version);
    const binDir = resolveBinDir(row.item, targetDir, this.#deps.platform ?? process.platform);
    if (binDir === null) return [];
    if (row.item === 'git') {
      // MinGit also needs mingw64/bin on PATH for its core tools.
      const mingw = path.join(path.dirname(binDir), 'mingw64', 'bin');
      return this.#deps.platform === 'win32' && existsSync(mingw) ? [binDir, mingw] : [binDir];
    }
    return [binDir];
  }

  /**
   * P12: PATH prefix of the toolchains installed INSIDE the WSL distro
   * (POSIX separator) — wired onto the WSL backend for its in-distro policy.
   */
  distroToolchainPathPrefix(): string | null {
    const dirs = this.listRows()
      .filter((row) => row.status === 'installed' && isDistroRow(row.rel_path))
      .flatMap((row) => this.binDirsForRow(row));
    return dirs.length > 0 ? dirs.join(':') : null;
  }

  #createRow(entry: CatalogEntry, identity: RunIdentity, approvalId: string | null): string {
    const id = newId('env');
    this.#db
      .prepare(
        "insert into env_installs (id, item, version, rel_path, status, requested_by, approval_id) values (?, ?, ?, ?, 'installing', ?, ?)",
      )
      .run(
        id,
        entry.item,
        entry.version,
        `${entry.item}/${entry.version}`,
        identity.botId,
        approvalId,
      );
    return id;
  }

  #updateRow(
    id: string,
    patch: Partial<Pick<InstallRow, 'status' | 'installed_at' | 'size_bytes'>>,
  ): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.installed_at !== undefined) {
      sets.push('installed_at = ?');
      params.push(patch.installed_at);
    }
    if (patch.size_bytes !== undefined) {
      sets.push('size_bytes = ?');
      params.push(patch.size_bytes);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.#db.prepare(`update env_installs set ${sets.join(', ')} where id = ?`).run(...params);
  }

  approvalPayload(
    entry: CatalogEntry,
    platform: CatalogPlatform,
    reason: string,
  ): Record<string, unknown> {
    const payload = environmentApprovalPayloadSchema.parse({
      item: entry.item,
      version: entry.version,
      reason,
      displayName: entry.displayName,
      sizeBytes: platform.sizeBytes,
      source: entry.source,
      obtain:
        platform.kind === 'uv-python'
          ? 'uv-python'
          : platform.kind === 'system'
            ? 'system'
            : 'archive',
      systemCommand:
        platform.kind === 'system' && process.platform === 'linux' ? linuxGitInstallCommand() : '',
    });
    return payload as Record<string, unknown>;
  }

  /**
   * P07：embedding-model 的审批卡合并其运行前置（onnxruntime）——体积为
   * 两组件合计，明细写入 reason；其余条目原样透传。
   */
  #bundleAwarePayload(
    entry: CatalogEntry,
    platform: CatalogPlatform,
    reason: string,
  ): Record<string, unknown> {
    if (entry.item !== 'embedding-model') return this.approvalPayload(entry, platform, reason);
    const bundle = embeddingBundleEntries(this.#deps.catalog);
    const key = platformKey(process.platform, process.arch);
    const runtimeEntry = bundle?.runtime;
    const runtimePlatform = key !== null ? runtimeEntry?.platforms[key] : undefined;
    if (runtimeEntry === undefined || runtimePlatform === undefined || key === null) {
      return this.approvalPayload(entry, platform, reason);
    }
    return {
      ...this.approvalPayload(entry, platform, reason),
      sizeBytes: platform.sizeBytes + runtimePlatform.sizeBytes,
      reason: `${reason}（组件：${entry.displayName} ${mbLabel(platform.sizeBytes)}；${runtimeEntry.displayName} ${mbLabel(runtimePlatform.sizeBytes)}。按宿主平台自动启用 GPU 加速——macOS CoreML / Windows DirectML，不可用时回退 CPU）`,
    };
  }

  #publishChanged(): void {
    this.#deps.publish('environment.changed', { installs: this.listInstalls() });
  }
}
