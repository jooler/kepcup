import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  PLUGIN_MANIFEST_FILE,
  capabilityFactsOf,
  pluginCapabilitySummary,
  pluginCapabilitySummaryFromCategories,
  pluginFieldSummaryOf,
  isPluginIconDataUri,
  sanitizeDisplayText,
  type McpbUserConfigValue,
  type PluginFieldValue,
  type PluginItemKind,
  type PluginIndexEntry,
  type PluginInspectOutput,
  type PluginItemRef,
  type PluginManifest,
  type PluginMarketEntry,
  type PluginSource,
  type PluginSummary,
  type PluginTier,
} from '@kepcup/shared';
import { compareConnectorVersions } from '../apps/connector-utils.js';
import { validateUserConfig } from '../apps/mcpb/manifest.js';
import { MEDIA_ENGINES } from '../media/engines.js';
import { ensurePluginDataDir, pluginDataDirFor } from '../infra/paths.js';
import { assertRuntimeInstallable, runtimeDisclosureOf } from './runtime/install.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { BuiltinPlugins } from './builtin.js';
import type { MarketplaceService } from './marketplace-service.js';
import {
  describePermission,
  diffPermissions,
  permissionTokens,
  unionPermissionTokens,
  type ConsentItems,
} from './permissions.js';
import type { PluginRow, PluginStore } from './store.js';
import {
  PLUGIN_SLOT_PATTERN,
  assertInstallablePluginId,
  pluginDirName,
  pluginDirOf,
  pluginPrevDirOf,
  pluginServerId,
} from './ids.js';
import { parsePluginManifestText } from './manifest-loader.js';
import { pluginIconDataUri } from './icon.js';
import { CAPABILITY_KINDS, capabilityKindOf, mergeConsentItems } from './kinds.js';
import {
  pluginConfigSecretName,
  pluginSecretScope,
  validatePluginFieldValues,
  type PluginInstanceStore,
} from './instances.js';
import type { PluginPackager, StagedPlugin } from './package.js';
import {
  PLUGIN_PROJECTOR_ORDER,
  emptyOwned,
  type PluginIdentity,
  type PluginLedger,
  type PluginProjector,
  type PluginProjectionContext,
  type ProjectedKind,
} from './projectors/index.js';

/**
 * PluginRegistry (D104 P0a-2 步骤 8; P1-2 updates): install / update / setEnabled /
 * uninstall / inspect / list over the ledger store and the projector set. One
 * promise-chain mutex covers every mutating operation (no timeout — a stuck install
 * must finish, not fail); install writes the ledger row BEFORE each projected item so
 * a failure (or a crash) rolls back in reverse order through the same ledger.
 *
 * Updates (P1-2) are a journalled transaction: the row's `update_to` / `update_snapshot`
 * go down FIRST, then the files (.prev swap), then the projectors, then ONE store update
 * flips everything; any failure (or a crash) compensates in reverse projector order —
 * `rollbackUpdate` where implemented, a reversed `update` otherwise.
 */

export interface PluginRegistryDeps {
  store: PluginStore;
  packager: PluginPackager;
  /** `createPluginProjectors()` 的结果（顺序 = PLUGIN_PROJECTOR_ORDER）。 */
  projectors: readonly PluginProjector[];
  /**
   * Test-only projector wrapper for failure injection (P1-2); applied only under
   * `__KEPCUP_TEST_HOOKS__` and dead-code-eliminated from packaged builds.
   */
  projectorWrap?: ((projector: PluginProjector) => PluginProjector) | undefined;
  /** Builtin plugin loader (D104 P0b): read-only summaries first in `list()`, and the guard for mutating them. */
  builtin?: Pick<BuiltinPlugins, 'summaries' | 'get'> | undefined;
  /** Marketplace service (D104 P1-1): marketplace installs, revocations, update markers. Absent in P0a tests. */
  marketplace?: MarketplaceService | undefined;
  /**
   * Secrets for the update's user_config pre-validation (P1-2) and plugin config /
   * instance sensitive values (D105): a required sensitive field with a stored value
   * counts as satisfied. Optional — absent means "no stored secrets" (rigs without a
   * secrets service).
   */
  secrets?:
    | {
        hasValue(name: string): boolean;
        setValue?(name: string, value: string): void;
        removeValue?(name: string): void;
        /** 卸载时按作用域前缀清理 config / 实例 secret（D125 收口审查）。 */
        names?(): string[];
      }
    | undefined;
  /** Instance rows (D105): `list()` instance counts read it directly. */
  instanceStore?: PluginInstanceStore | undefined;
  /**
   * D105 P3: active domain accounts that are this plugin's mail instances — the truth
   * `instanceCounts.mail` reports (soft-deleted rows and legacy unowned accounts don't
   * count). Wired from the mail store in start.ts; absent in tests without mail.
   */
  mailInstanceCount?: ((pluginId: string) => number) | undefined;
  pluginsDir: string;
  /**
   * Private writable data root of execution-type plugins (D125 补丁):
   * `{home}/plugin-data/`. Install / update-of-runtime ensure the plugin's
   * directory; `#teardown` removes it. Version-independent.
   */
  pluginDataDir: string;
  /** App version for marketplace compatibility (`engines`); core `0.0.0` skips the check. */
  appVersion?: string;
  platform?: NodeJS.Platform;
  clock: Clock;
  logger: CoreLogger;
  events: { emit(name: 'plugins.changed', payload: { ids: string[] }): void };
  audit?: { recordSystem(action: string, detail: Record<string, unknown>): unknown } | undefined;
}

export interface PluginInstallInput {
  source: PluginSource;
  sha256: string;
  userConfig: Record<string, Record<string, McpbUserConfigValue>>;
  /** Derived from `source.kind` (Bot-initiated installs pass 'bot' in P1-3). */
  via: 'file' | 'folder' | 'marketplace' | 'bot';
  /** Required when the update flow expands the permission set (P1-2, additive). */
  acknowledgeDiff?: boolean | undefined;
}

/** `plugins.update` (P1-2): marketplace-source update of an installed plugin. */
export interface PluginUpdateInput {
  id: string;
  /** Absent = the highest compatible version in the current market's index. */
  version?: string | undefined;
  sha256: string;
  userConfig: Record<string, Record<string, McpbUserConfigValue>>;
  /** Required when the update expands the permission set. */
  acknowledgeDiff: boolean;
  /** Audit provenance ('marketplace' now; 'bot' when P1-3 wires the tool). */
  via: 'marketplace' | 'bot';
}

/** A source resolved to something the packager can stage (marketplace → downloaded file). */
interface ResolvedSource {
  stageSource: { kind: 'file' | 'folder'; path: string };
  /** Marketplace provenance; null for local sources. */
  marketplace: { entry: PluginIndexEntry; endpointId: string } | null;
}

interface InspectStagedResult {
  identity: PluginIdentity;
  items: ConsentItems;
  conflicts: PluginInspectOutput['conflicts'];
  blockers: string[];
}

class NullLedger implements PluginLedger {
  add(): void {}
  remove(): void {}
  list(): string[] {
    return [];
  }
}

/** The consent items of one inspection, as the permission-token derivation wants them. */
function itemsOf(inspection: { items: ConsentItems }): ConsentItems {
  return inspection.items;
}

/** D125：安装来源的层级（本地目录安装恒 developer；市场条目按其 tier）。 */
function runtimeTierOf(marketplace: ResolvedSource['marketplace']): PluginTier {
  return marketplace === null ? 'developer' : marketplace.entry.tier;
}

/** Ledger `dir` is always `{ns}/{name}@{version}` with `/`, never `path.sep`. */
function pluginLedgerDir(pluginsDir: string, absoluteDir: string): string {
  return path.relative(pluginsDir, absoluteDir).split(path.sep).join('/');
}

export class PluginRegistry {
  readonly #deps: PluginRegistryDeps;
  readonly #projectors: readonly PluginProjector[];
  #tail: Promise<void> = Promise.resolve();
  /** Manifest cache keyed by `{id}@{version}`; invalidated when the plugin goes away. */
  readonly #manifests = new Map<string, PluginManifest>();
  /** Instance teardown (D105), wired by start.ts: `PluginInstanceService.deleteAllOf`. */
  #instanceTeardown: ((pluginId: string) => Promise<void>) | null = null;
  /**
   * Reference cleanup (D105 P2): strip the plugin id from every bot's plugin_ids and
   * every project_plugins row on uninstall — write paths stay strict, nothing dangles.
   */
  #referenceCleanup: ((pluginId: string) => void) | null = null;
  /**
   * D125 P2：运行时停止钩子（停用即时 kill switch，61 §7）与卸载钩子（kill +
   * plugin_storage 清除）。start.ts 在 PluginHost 构造后接线。
   */
  #runtimeStop: ((pluginId: string) => void) | null = null;
  #runtimeTeardown: ((pluginId: string) => void) | null = null;
  /**
   * D125：停用 / 卸载进行中立即从「可消费」集合摘掉——`setEnabled(false)` 的投影
   * 回滚是异步的，若只依赖 store 行的 enabled 翻转，窗口内排队中的执行型调用会
   * 重新拉起刚被 kill switch 杀掉的进程。
   */
  #runtimeHalted = new Set<string>();
  /**
   * 已见过 runtime 段的插件 id（`manifestOf` 与安装 / 更新提交时维护）。kill switch /
   * 更新窗口的「不可消费」只对执行型插件生效——数据型插件（source: engine）在停用 /
   * 更新事务中的既有解析行为保持 D124 不变。
   */
  #runtimeManifestIds = new Set<string>();

  constructor(deps: PluginRegistryDeps) {
    // Test-only failure injection (P1-2): the wrapper applies only with test hooks on and
    // is folded away from packaged builds together with this branch.
    this.#deps = deps;
    this.#projectors =
      __KEPCUP_TEST_HOOKS__ === true && deps.projectorWrap !== undefined
        ? deps.projectors.map(deps.projectorWrap)
        : deps.projectors;
  }

  // --- mutex（等锁无超时：卡住的安装必须走完，而不是报错放弃） -------------------

  #runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let releaseTail!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    return previous.then(async () => {
      try {
        return await task();
      } finally {
        releaseTail();
      }
    });
  }

  /**
   * The registry's ONE mutex, shared with `PluginInstanceService` (D105: instance
   * mutations must never race installs / updates / uninstalls of the same plugin).
   */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.#runExclusive(task);
  }

  /** Wires the uninstall-time instance cascade (`PluginInstanceService.deleteAllOf`). */
  attachInstanceTeardown(fn: (pluginId: string) => Promise<void>): void {
    this.#instanceTeardown = fn;
  }

  /** Wires the uninstall-time reference cleanup (bots' plugin_ids + project_plugins). */
  attachReferenceCleanup(fn: (pluginId: string) => void): void {
    this.#referenceCleanup = fn;
  }

  /** D125：插件停用（kill switch）时终止其执行型进程（PluginHost.dispose）。 */
  attachRuntimeStop(fn: (pluginId: string) => void): void {
    this.#runtimeStop = fn;
  }

  /** D125：卸载 / 回滚时终止进程并清 plugin_storage（PluginHost.dispose + bridge.clearStorage）。 */
  attachRuntimeTeardown(fn: (pluginId: string) => void): void {
    this.#runtimeTeardown = fn;
  }

  // --- lifecycle ----------------------------------------------------------------

  /** Startup: clear `.staging/`, recover interrupted installs/uninstalls, activate. */
  async start(): Promise<void> {
    try {
      await this.#deps.packager.sweepStaging();
    } catch (error) {
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'plugin staging sweep failed',
      );
    }
    const recovered = await this.recoverInterrupted();
    if (recovered > 0) {
      this.#deps.logger.info({ recovered }, 'plugin registry recovered interrupted rows');
    }
    await this.#sweepOrphanDirs();
    for (const row of this.#deps.store.list()) {
      if (row.state !== 'installed') continue;
      const manifest = await this.#readManifestFromDir(this.#dirOf(row.id, row.version));
      if (manifest === null) {
        this.#deps.logger.warn({ plugin: row.id }, 'plugin startup skipped: manifest unreadable');
        continue;
      }
      // D125 补丁：应用重启即补齐既有执行型安装的数据目录（改动前安装的行没有经过
      // install 的初始化；PluginHost 首次调用也会懒创建，但安装后第一时间初始化是
      // 约定）。失败只告警、不阻断启动；下次首次调用仍会重试。
      if (manifest.runtime !== undefined) {
        try {
          ensurePluginDataDir(this.#deps.pluginDataDir, row.id);
        } catch (error) {
          this.#deps.logger.warn(
            { plugin: row.id, error: error instanceof Error ? error.message : String(error) },
            'plugin startup: data dir init failed',
          );
        }
      }
      // Disabled rows only needed the manifest for the summary list; nothing to activate.
      if (!row.enabled) continue;
      const ctx = await this.#contextFor(row, manifest, {});
      for (const projector of this.#projectors) {
        if (projector.activate === undefined) continue;
        if (!capabilityKindOf(projector.kind).hasContribution(manifest)) continue;
        try {
          await projector.activate(ctx);
        } catch (error) {
          this.#deps.logger.warn(
            {
              plugin: row.id,
              kind: projector.kind,
              error: error instanceof Error ? error.message : String(error),
            },
            'plugin activate failed',
          );
        }
      }
    }
    // Marketplace revocations may have changed while the app was down (D104 P1-1).
    await this.applyRevocations();
  }

  /**
   * Rolls back interrupted UPDATE rows (P1-2 journal) first, then `installing` rows and
   * finishes `uninstalling` rows from a dead process.
   */
  async recoverInterrupted(): Promise<number> {
    return this.#runExclusive(async () => {
      let recovered = 0;
      for (const row of this.#deps.store.listUpdating()) {
        this.#deps.logger.info(
          { plugin: row.id, updateTo: row.updateTo },
          '恢复中断的更新（按日志回滚）',
        );
        await this.#recoverUpdatingRow(row);
        recovered += 1;
      }
      for (const row of this.#deps.store.list()) {
        if (row.state !== 'installing' && row.state !== 'uninstalling') continue;
        this.#deps.logger.info(
          { plugin: row.id, state: row.state },
          row.state === 'installing' ? '恢复中断的安装' : '继续完成卸载',
        );
        await this.#teardown(row.id, this.#identityOf(row), { throwOnError: false });
        recovered += 1;
      }
      return recovered;
    });
  }

  // --- queries ------------------------------------------------------------------

  list(): PluginSummary[] {
    // Builtin plugins first (read-only, never in the store), then installed ones.
    const builtins = this.#deps.builtin?.summaries() ?? [];
    return [...builtins, ...this.#deps.store.list().map((row) => this.#summaryOf(row))];
  }

  /** Is this id a read-only builtin plugin (disable / uninstall refused)? */
  #isBuiltin(id: string): boolean {
    return (this.#deps.builtin?.get(id) ?? null) !== null;
  }

  /**
   * D124 P4：内置第一方数据插件（只读目录型，不入 `plugins` 表）对运行时恒可消费
   * ——builtin 来源没有 enabled / state 状态可关（随目录在即在），条目有效集只由
   * Bot 勾选（`capability_entries` ∩ `plugin_ids`）决定。目录不存在（生产构建）时
   * 本分支不可达，既有 store 行为逐字节不变。
   */
  isBuiltin(id: string): boolean {
    return this.#isBuiltin(id);
  }

  ownerOf(kind: PluginItemKind, ref: string): string | null {
    return this.#deps.store.ownerOf(kind, ref);
  }

  /**
   * 插件当前是否可被运行时消费（D124 条目仓库的有效集口径，60 号设计决策 5
   * 「插件已安装启用」）：已装（state installed）、全局启用（enabled）且不在
   * 更新 / 停用 / 卸载事务中（D125：执行型进程的 kill switch 与目录切换窗口）。与
   * `#convergeDisabled` 的语义一致——停用插件 = 贡献不再进运行时面；条目的
   * 运行时状态只住在 Bot profile 与本行上，故消费侧必须查这里。
   * 诊断面（testCapabilityEntry 的条目 / 实例解析）不经过本判定。
   * 内置只读目录插件（D124 P4）恒可消费（`isBuiltin`）。
   */
  isConsumable(id: string): boolean {
    if (this.#isBuiltin(id)) return true;
    const row = this.#deps.store.get(id);
    if (row === null) return false;
    // 执行型插件在停用 / 卸载 / 更新事务窗口内不可消费；数据型插件不受影响
    // （D124 的条目解析 / 软引用语义逐字节不变）。
    if (
      this.#runtimeManifestIds.has(id) &&
      (this.#runtimeHalted.has(id) || row.updateTo !== null)
    ) {
      return false;
    }
    return row.state === 'installed' && row.enabled;
  }

  /**
   * D125 P2：执行型插件的安装目录（PluginHost fork 的 cwd 与 entry 根）。store 行 →
   * guarded slot dir；builtin 只读目录插件回退到目录加载器的 `dir`（生产构建无
   * builtin 目录时不存在，行为与从前一致）。未装 / 目录不可解析 = null。
   */
  async runtimeDirOf(id: string): Promise<string | null> {
    const row = this.#deps.store.get(id);
    if (row === null) return this.#deps.builtin?.get(id)?.dir ?? null;
    try {
      return this.#slotDirOf(row);
    } catch {
      return null;
    }
  }

  /**
   * 已装插件的完整清单（缓存 → 磁盘）；未装 / 清单损坏 = null。实例服务与 config
   * 读写用它取 `config.fields` / `instances` 声明（D105）。
   * 内置只读目录插件（D124 P4）：`plugins` 表无行，直读 builtin 加载器已校验的
   * 清单——条目投影（listCapabilityEntries）、Bot 条目写入校验、媒体条目解析与
   * 实例表单都经这里取 builtin 清单。目录不存在时与今日逐字节一致。
   */
  async manifestOf(id: string): Promise<PluginManifest | null> {
    const row = this.#deps.store.get(id);
    let manifest: PluginManifest | null;
    if (row === null) {
      manifest = this.#deps.builtin?.get(id)?.manifest ?? null;
    } else {
      const cached = this.#manifests.get(`${row.id}@${row.version}`);
      manifest =
        cached !== undefined
          ? cached
          : await this.#readManifestFromDir(this.#dirOf(row.id, row.version));
    }
    // 维护执行型插件集合（isConsumable 的 kill switch / 更新窗口判定）。
    if (manifest?.runtime !== undefined) this.#runtimeManifestIds.add(id);
    else this.#runtimeManifestIds.delete(id);
    return manifest;
  }

  /**
   * 已装插件清单的贡献（未装 / 清单损坏 = null）。P3 起邮件贡献即实例供给规范，
   * 运行时按清单直读；不再有「模板 overlay」读取口。
   */
  async contributionsOf(id: string): Promise<PluginManifest['contributions'] | null> {
    const row = this.#deps.store.get(id);
    if (row === null) return null;
    const manifest = await this.#readManifestFromDir(this.#dirOf(row.id, row.version));
    return manifest?.contributions ?? null;
  }

  /**
   * Sync display-name lookup for the mail owner decoration (P3): the cached manifest's
   * name, null when the cache is cold or the plugin unknown (caller falls back to the
   * id). Registry startup / install warm the cache for installed rows.
   */
  displayNameOf(pluginId: string): string | null {
    const row = this.#deps.store.get(pluginId);
    if (row === null) return null;
    return this.#manifests.get(`${row.id}@${row.version}`)?.name ?? null;
  }

  // --- plugin config (D105) --------------------------------------------------------

  /** Stored non-sensitive config values + which sensitive fields have a secret. */
  async getConfig(id: string): Promise<{
    values: Record<string, PluginFieldValue>;
    storedSensitiveKeys: string[];
  }> {
    return this.#runExclusive(async () => {
      const row = this.#deps.store.get(id);
      if (row === null) throw new AppError('NOT_FOUND', `没有已安装的插件：${id}`);
      const fields = await this.#configFieldsOf(id);
      let stored: Record<string, PluginFieldValue> = {};
      try {
        stored = JSON.parse(row.configJson) as Record<string, PluginFieldValue>;
      } catch {
        this.#deps.logger.warn({ plugin: id }, 'plugin config_json unreadable; treated as empty');
      }
      // Project to the CURRENT manifest's declared keys: an update that removed/renamed a
      // field leaves its old value in config_json — returning it verbatim would make the
      // auto-built form round-trip an unknown key and setConfig (full replace, unknown
      // keys rejected) would refuse every save with no way to clear it from the UI. The
      // stale key leaves config_json on the next save (form submits declared keys only).
      const declared = new Set(
        fields.filter((field) => !field.sensitive).map((field) => field.key),
      );
      const values = Object.fromEntries(
        Object.entries(stored).filter(([key]) => declared.has(key)),
      );
      const storedSensitiveKeys = fields
        .filter(
          (field) => this.#deps.secrets?.hasValue(pluginConfigSecretName(id, field.key)) === true,
        )
        .map((field) => field.key);
      return { values, storedSensitiveKeys };
    });
  }

  /**
   * Replaces the plugin config with the submitted form (D105): non-sensitive values go
   * to `config_json`, sensitive ones to secrets; sensitive fields absent from the
   * submission keep their stored secret; required fields must resolve (submitted /
   * declared default / stored secret).
   */
  setConfig(id: string, values: Readonly<Record<string, PluginFieldValue>>): Promise<void> {
    return this.#runExclusive(async () => {
      const row = this.#deps.store.get(id);
      if (row === null) throw new AppError('NOT_FOUND', `没有已安装的插件：${id}`);
      if (row.state !== 'installed') {
        throw new AppError('INVALID_INPUT', `插件当前状态（${row.state}）不允许修改配置`);
      }
      const fields = await this.#configFieldsOf(id);
      const split = validatePluginFieldValues(fields, values, {
        hasStoredSecret: (key) =>
          this.#deps.secrets?.hasValue(pluginConfigSecretName(id, key)) === true,
      });
      if (Object.keys(split.sensitive).length > 0 && this.#deps.secrets?.setValue === undefined) {
        // Better an explicit refusal than validation passing while the value vanishes.
        throw new AppError('INVALID_INPUT', '当前环境无法安全保存敏感配置');
      }
      this.#deps.store.update(id, {
        configJson: JSON.stringify(split.nonSensitive),
        updatedAt: this.#deps.clock.now(),
      });
      for (const [key, value] of Object.entries(split.sensitive)) {
        this.#deps.secrets?.setValue?.(pluginConfigSecretName(id, key), value);
      }
      // Values never reach the audit trail (only the plugin identity).
      this.#deps.audit?.recordSystem('plugin_config_set', { pluginId: id });
      this.#deps.events.emit('plugins.changed', { ids: [id] });
    });
  }

  async #configFieldsOf(id: string): Promise<NonNullable<PluginManifest['config']>['fields']> {
    const manifest = await this.manifestOf(id);
    return manifest?.config?.fields ?? [];
  }

  async inspect(source: PluginSource): Promise<PluginInspectOutput> {
    const resolved = await this.#resolveSource(source);
    const staged = await this.#deps.packager.stage(resolved.stageSource);
    try {
      this.#assertMatchesMarketplaceEntry(staged, resolved.marketplace);
      return await this.#inspectStagedOutput(staged, resolved.marketplace, source.kind);
    } finally {
      await this.#deps.packager.discard(staged);
    }
  }

  /**
   * The staged package must be exactly what the signed index describes (design 51 §5,
   * P1-1 step 4.1) — enforced for inspect (fail fast at consent time) and install alike:
   * the manifest identity must match the entry and the bytes must hash to `entry.sha256`.
   */
  #assertMatchesMarketplaceEntry(
    staged: StagedPlugin,
    marketplace: ResolvedSource['marketplace'],
  ): void {
    if (marketplace === null) return;
    const { entry } = marketplace;
    if (staged.manifest.id !== entry.id || staged.manifest.version !== entry.version) {
      throw new AppError('PLUGIN_INVALID', '包内清单与索引不符');
    }
    if (staged.packageSha256 !== entry.sha256) {
      throw new AppError('PLUGIN_INVALID', '包内容与索引的 sha256 不符');
    }
  }

  // --- marketplace (D104 P1-1) ---------------------------------------------------

  #appVersion(): string {
    return this.#deps.appVersion ?? '0.0.0';
  }

  #platform(): NodeJS.Platform {
    return this.#deps.platform ?? process.platform;
  }

  /**
   * Resolves the install source: marketplace sources download the indexed package into the
   * cache (sha256-bound) and refuse closed markets / unknown versions / revoked versions;
   * local sources pass through unchanged.
   */
  async #resolveSource(source: PluginSource): Promise<ResolvedSource> {
    if (source.kind !== 'marketplace') return { stageSource: source, marketplace: null };
    const service = this.#deps.marketplace;
    const sync = service?.current() ?? null;
    if (service === undefined || sync === null) {
      throw new AppError('PLUGIN_INVALID', '插件市场未启用');
    }
    const entry = sync.find(source.id, {
      ...(source.version !== undefined ? { version: source.version } : {}),
      appVersion: this.#appVersion(),
      platform: this.#platform(),
    });
    if (entry === null) {
      throw new AppError(
        'NOT_FOUND',
        `市场里没有这个插件版本：${source.id}${source.version !== undefined ? `@${source.version}` : ''}`,
      );
    }
    if (sync.revocationOf(entry.id, entry.version) !== null) {
      throw new AppError('PLUGIN_INVALID', '该插件版本已被撤销，不能安装');
    }
    const filePath = await sync.download(entry);
    return {
      stageSource: { kind: 'file', path: filePath },
      marketplace: { entry, endpointId: service.endpointId() },
    };
  }

  /**
   * Enforces the marketplace revocation list (D104 P1-1 step 4.4): `disable` auto-disables
   * installed plugins from the current market (same path as setEnabled(false), audited with
   * `reason: 'revoked'`). Called after every adopted index and at registry start.
   */
  applyRevocations(): Promise<void> {
    return this.#runExclusive(async () => {
      const service = this.#deps.marketplace;
      const sync = service?.current() ?? null;
      if (service === undefined || sync === null) return;
      const endpointId = service.endpointId();
      for (const row of this.#deps.store.list()) {
        if (row.origin !== 'marketplace' || row.marketplace !== endpointId) continue;
        if (sync.revocationOf(row.id, row.version) !== 'disable') continue;
        if (!row.enabled || row.state !== 'installed') continue;
        try {
          await this.#setEnabledLocked(row.id, false, { auditReason: 'revoked' });
        } catch (error) {
          this.#deps.logger.warn(
            { plugin: row.id, error: error instanceof Error ? error.message : String(error) },
            'plugin revocation disable failed',
          );
        }
      }
    });
  }

  /** Marketplace list view for `plugins.marketplace.list` (one row per id, best version). */
  marketplaceEntries(): PluginMarketEntry[] {
    const service = this.#deps.marketplace;
    const sync = service?.current() ?? null;
    if (service === undefined || sync === null) return [];
    const platform = this.#platform();
    const byId = new Map<string, PluginIndexEntry[]>();
    for (const entry of sync.entries()) {
      const list = byId.get(entry.id);
      if (list === undefined) byId.set(entry.id, [entry]);
      else list.push(entry);
    }
    const rows = new Map(this.#deps.store.list().map((row) => [row.id, row]));
    const entries: PluginMarketEntry[] = [];
    for (const [id, candidates] of byId) {
      const compatible = sync.find(id, { appVersion: this.#appVersion(), platform });
      // No compatible version: show the highest one flagged incompatible (P1-1 step 4.6).
      const chosen =
        compatible ??
        [...candidates].sort((a, b) => compareConnectorVersions(b.version, a.version) ?? -1)[0]!;
      const row = rows.get(id) ?? null;
      const revoked =
        row !== null
          ? sync.revocationOf(row.id, row.version)
          : sync.revocationOf(id, chosen.version);
      entries.push({
        id,
        version: chosen.version,
        tier: chosen.tier,
        name: chosen.summary.name,
        description: chosen.summary.description,
        author: chosen.summary.author,
        categories: chosen.categories,
        // D105 P4: index-carried line; entries signed before the field existed fall
        // back to the coarser kinds-derived summary.
        capabilitySummary:
          chosen.capabilitySummary ?? pluginCapabilitySummaryFromCategories(chosen.categories),
        // Signed-index input is untrusted relative to the renderer: only a well-formed
        // image data URI reaches the card; anything else falls back to the default icon.
        iconDataUri: isPluginIconDataUri(chosen.summary.icon) ? chosen.summary.icon : null,
        size: chosen.size,
        updatedAt: chosen.updatedAt,
        compatible: compatible !== null,
        incompatibleReason:
          compatible !== null
            ? null
            : sync.incompatibleReason(chosen, this.#appVersion(), platform),
        installed:
          row === null
            ? null
            : {
                version: row.version,
                updateAvailable: this.#marketUpdateOf(row) !== null,
              },
        revoked,
      });
    }
    return entries;
  }

  /** Update marker for an installed marketplace plugin from the current market's index. */
  #marketUpdateOf(row: PluginRow): { version: string } | null {
    const service = this.#deps.marketplace;
    const sync = service?.current() ?? null;
    if (service === undefined || sync === null) return null;
    if (row.origin !== 'marketplace' || row.marketplace !== service.endpointId()) return null;
    const latest = sync.find(row.id, {
      appVersion: this.#appVersion(),
      platform: this.#platform(),
    });
    if (latest === null) return null;
    if ((compareConnectorVersions(latest.version, row.version) ?? -1) <= 0) return null;
    if (sync.revocationOf(latest.id, latest.version) !== null) return null;
    return { version: latest.version };
  }

  /** Revocation marker for an installed marketplace plugin from the current market's index. */
  #marketRevocationOf(row: PluginRow): 'warn' | 'disable' | null {
    const service = this.#deps.marketplace;
    const sync = service?.current() ?? null;
    if (service === undefined || sync === null) return null;
    if (row.origin !== 'marketplace' || row.marketplace !== service.endpointId()) return null;
    return sync.revocationOf(row.id, row.version);
  }

  // --- mutations ----------------------------------------------------------------

  install(input: PluginInstallInput): Promise<PluginSummary> {
    return this.#runExclusive(() => this.#installLocked(input));
  }

  async #installLocked(input: PluginInstallInput): Promise<PluginSummary> {
    const resolved = await this.#resolveSource(input.source);
    const staged = await this.#deps.packager.stage(resolved.stageSource);
    try {
      if (staged.packageSha256 !== input.sha256) {
        throw new AppError('PLUGIN_INVALID', '包与确认时不一致，请重新选择');
      }
      this.#assertMatchesMarketplaceEntry(staged, resolved.marketplace);
      const manifest = staged.manifest;
      const { id, version } = manifest;
      // Reserved namespaces are rejected for marketplace / local installs.
      assertInstallablePluginId(id);
      // D124：条目绑定的引擎必须在当前版本已注册（在任何持久化写入之前拒绝）。
      this.#assertEnginesKnown(manifest);
      // D125 P2：执行型插件（runtime 段）的层级限制 / entry 存在性 / 包防护 / hostApi
      // 校验——同样在一切持久化写入之前（61 §2 / §7）。
      await assertRuntimeInstallable(manifest, {
        dir: staged.stagingDir,
        tier: runtimeTierOf(resolved.marketplace),
      });
      const row = this.#deps.store.get(id);
      if (row !== null) {
        // P1-2: reinstalling the SAME id from a local source IS the update flow (design 51
        // §6.2 — same version / lower version allowed). Every other combination conflicts.
        if (row.origin === 'local' && resolved.marketplace === null) {
          return await this.#performUpdate(row, staged, resolved, {
            sha256: input.sha256,
            userConfig: input.userConfig,
            acknowledgeDiff: input.acknowledgeDiff ?? false,
            via: input.via,
          });
        }
        throw new AppError(
          'PLUGIN_CONFLICT',
          `已安装同 id 插件（来源：${row.origin === 'marketplace' ? '市场' : '本地'}），请先卸载`,
        );
      }

      const inspection = await this.#inspectStagedOutput(staged);
      if (inspection.conflicts.length > 0) {
        const listed = inspection.conflicts
          .slice(0, 3)
          .map((conflict) => `${conflict.ref}（${conflict.withWhat}）`)
          .join('；');
        throw new AppError('PLUGIN_CONFLICT', `与现有内容冲突：${listed}`);
      }
      if (inspection.blockers.length > 0) {
        throw new AppError('PLUGIN_INCOMPATIBLE', inspection.blockers.join('；'));
      }

      // user_config pre-validation BEFORE any persistent write (keeps the MCPB error code).
      for (const contribution of manifest.contributions.mcp) {
        if (contribution.kind !== 'mcpb') continue;
        const item = inspection.mcp.find(
          (entry) => entry.kind === 'mcpb' && entry.id === contribution.id,
        );
        if (item === undefined || item.kind !== 'mcpb') continue;
        validateUserConfig(item.userConfigFields, input.userConfig[contribution.id] ?? {});
      }

      const origin = resolved.marketplace === null ? 'local' : 'marketplace';
      const tier = resolved.marketplace === null ? 'developer' : resolved.marketplace.entry.tier;
      const identity: PluginIdentity = { id, version, origin, tier };
      // Atomic落盘: rename the staged tree into the final dir (a leftover dir without a
      // row is cleared first).
      const finalDir = pluginDirOf(this.#deps.pluginsDir, id, version);
      await rm(finalDir, { recursive: true, force: true });
      await mkdir(path.dirname(finalDir), { recursive: true });
      await rename(staged.stagingDir, finalDir);
      staged.stagingDir = ''; // `discard` becomes a no-op below

      const now = this.#deps.clock.now();
      this.#deps.store.insert({
        id,
        version,
        origin,
        tier,
        state: 'installing',
        enabled: true,
        packageSha256: staged.packageSha256,
        marketplace: resolved.marketplace?.endpointId ?? null,
        dir: pluginLedgerDir(this.#deps.pluginsDir, finalDir),
        updateTo: null,
        updateSnapshot: null,
        configJson: '{}',
        installedAt: now,
        updatedAt: now,
      });

      this.#manifests.set(`${id}@${version}`, manifest);
      if (manifest.runtime !== undefined) this.#runtimeManifestIds.add(id);
      else this.#runtimeManifestIds.delete(id);
      const insertedRow = this.#deps.store.get(id)!;
      const ctx = await this.#contextFor(insertedRow, manifest, input.userConfig);
      try {
        // D125 补丁：执行型插件安装后第一时间初始化私有数据目录（0700，版本无关）。
        // 与投影同段：创建失败走下面的回滚（含目录清理），不留半装状态。
        if (manifest.runtime !== undefined) {
          ensurePluginDataDir(this.#deps.pluginDataDir, id);
        }
        for (const projector of this.#projectors) {
          if (!capabilityKindOf(projector.kind).hasContribution(manifest)) continue;
          await projector.project(ctx);
        }
      } catch (error) {
        await this.#teardown(id, identity, { throwOnError: false });
        if (error instanceof AppError) throw error;
        this.#deps.logger.error(
          { plugin: id, error: error instanceof Error ? error.message : String(error) },
          'plugin install projection failed',
        );
        throw new AppError(
          'INTERNAL',
          `插件安装失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      this.#deps.store.update(id, { state: 'installed', updatedAt: this.#deps.clock.now() });
      this.#deps.audit?.recordSystem('plugin_install', {
        pluginId: id,
        version,
        origin,
        tier,
        via: input.via,
        ...(resolved.marketplace !== null ? { marketplace: resolved.marketplace.endpointId } : {}),
      });
      this.#deps.events.emit('plugins.changed', { ids: [id] });
      return this.#summaryOf(this.#deps.store.get(id)!);
    } finally {
      await this.#deps.packager.discard(staged);
    }
  }

  // --- updates（P1-2：有日志的事务） ---------------------------------------------

  /** `plugins.update`: marketplace-source update of an installed plugin. */
  update(input: PluginUpdateInput): Promise<PluginSummary> {
    return this.#runExclusive(() => this.#updateLocked(input));
  }

  async #updateLocked(input: PluginUpdateInput): Promise<PluginSummary> {
    const row = this.#deps.store.get(input.id);
    if (row === null) throw new AppError('NOT_FOUND', `没有已安装的插件：${input.id}`);
    if (row.origin === 'local') {
      throw new AppError('INVALID_INPUT', '本地插件请重新选择文件或目录安装');
    }
    const service = this.#deps.marketplace;
    if (service === undefined || (service.current() ?? null) === null) {
      throw new AppError('PLUGIN_INVALID', '插件市场未启用');
    }
    if (row.marketplace !== service.endpointId()) {
      throw new AppError('INVALID_INPUT', '该插件来自另一个市场（当前市场地址已更改），不能更新');
    }
    const resolved = await this.#resolveSource({
      kind: 'marketplace',
      id: input.id,
      ...(input.version !== undefined ? { version: input.version } : {}),
    });
    const staged = await this.#deps.packager.stage(resolved.stageSource);
    try {
      return await this.#performUpdate(row, staged, resolved, input);
    } finally {
      await this.#deps.packager.discard(staged);
    }
  }

  /**
   * The journalled update transaction (task 5.3). STRICT order:
   * ① validate → ② dirs → ③ inspections + user_config / permission gates → ④ journal
   * (`update_to` / `update_snapshot`) → ⑤ files (.prev swap + staged rename) →
   * ⑥ projectors in order → ⑦ ONE store update flips everything + commitUpdate hooks +
   * old dir GC → any ⑥ failure runs ⑧ compensation (reverse projector order) and
   * rethrows. A crash anywhere is undone by `recoverInterrupted` from the journal.
   */
  async #performUpdate(
    row: PluginRow,
    staged: StagedPlugin,
    resolved: ResolvedSource,
    input: {
      sha256: string;
      userConfig: Record<string, Record<string, McpbUserConfigValue>>;
      acknowledgeDiff: boolean;
      via: PluginInstallInput['via'] | PluginUpdateInput['via'];
    },
  ): Promise<PluginSummary> {
    // ① validate
    const manifest = staged.manifest;
    if (manifest.id !== row.id) {
      throw new AppError('PLUGIN_INVALID', '包内清单与已装插件不符');
    }
    if (staged.packageSha256 !== input.sha256) {
      throw new AppError('PLUGIN_INVALID', '包与确认时不一致，请重新选择');
    }
    this.#assertMatchesMarketplaceEntry(staged, resolved.marketplace);
    // D124：更新同样不允许引入未注册引擎的条目（① validate 步内，先于一切写入）。
    this.#assertEnginesKnown(manifest);
    // D125 P2：更新同样过执行型插件校验（层级 / entry / 包防护 / hostApi）。
    await assertRuntimeInstallable(manifest, {
      dir: staged.stagingDir,
      tier: runtimeTierOf(resolved.marketplace),
    });
    const origin: PluginRow['origin'] = resolved.marketplace === null ? 'local' : 'marketplace';
    const tier: PluginRow['tier'] =
      resolved.marketplace === null ? 'developer' : resolved.marketplace.entry.tier;
    // Marketplace updates must move forward (already enforced as an inspect blocker; the
    // install entrypoint cannot reach here for marketplace sources).
    if (origin === 'marketplace') {
      if ((compareConnectorVersions(manifest.version, row.version) ?? -1) <= 0) {
        throw new AppError('PLUGIN_INVALID', '已是最新版本或更旧（不允许降级）');
      }
    }

    // ② directories — row.dir is the slot truth (P0a-2 review: lowercase slots).
    const oldDir = this.#slotDirOf(row);
    const newDir = pluginDirOf(this.#deps.pluginsDir, row.id, manifest.version);
    const sameDir = oldDir === newDir;

    // ③ inspections + gates (nothing persistent has been written yet)
    const owned = this.#ownedFor(row.id);
    const oldManifest = await this.#readManifestFromDir(oldDir);
    if (oldManifest === null) {
      throw new AppError('PLUGIN_INVALID', '已安装插件的内容不可读，无法更新；如需移除请卸载');
    }
    const newIdentity: PluginIdentity = { id: row.id, version: manifest.version, origin, tier };
    const newInspection = await this.#inspectContext({
      plugin: newIdentity,
      manifest,
      dir: staged.stagingDir,
      userConfig: {},
      ledger: new NullLedger(),
      owned,
    });
    if (newInspection.conflicts.length > 0) {
      const listed = newInspection.conflicts
        .slice(0, 3)
        .map((conflict) => `${conflict.ref}（${conflict.withWhat}）`)
        .join('；');
      throw new AppError('PLUGIN_CONFLICT', `与现有内容冲突：${listed}`);
    }
    if (newInspection.blockers.length > 0) {
      throw new AppError('PLUGIN_INCOMPATIBLE', newInspection.blockers.join('；'));
    }
    this.#prevalidateUpdateUserConfig(manifest, newInspection, input.userConfig, row.id);
    // D125 P4：执行型插件的网络域名 / 敏感实例字段也进扩权 diff（扩大 → 重新同意）。
    const oldRuntimeDisclosure = await runtimeDisclosureOf(oldManifest, {
      dir: oldDir,
      tier: this.#identityOf(row).tier,
    });
    const newRuntimeDisclosure = await runtimeDisclosureOf(manifest, {
      dir: staged.stagingDir,
      tier,
    });
    const diff = diffPermissions(
      unionPermissionTokens(
        permissionTokens(
          itemsOf(
            await this.#inspectContext({
              plugin: this.#identityOf(row),
              manifest: oldManifest,
              dir: oldDir,
              userConfig: {},
              ledger: new NullLedger(),
              owned,
            }),
          ),
        ),
        oldRuntimeDisclosure.runtime,
      ),
      unionPermissionTokens(permissionTokens(itemsOf(newInspection)), newRuntimeDisclosure.runtime),
    );
    if (diff.expanded && !input.acknowledgeDiff) {
      throw new AppError('INVALID_INPUT', '更新新增了权限，请先确认差异', {
        permissionsExpanded: true,
        added: diff.added,
      });
    }

    // D125 补丁：更新时确保私有数据目录存在（版本无关，安装树才换）。放在所有
    // 校验与授权差异门之后、journal / 文件替换之前：创建失败直接失败，无需补偿；
    // 被拒的更新也不会留下空目录。更新失败 / 补偿不删这个目录（旧版本仍在使用）。
    if (manifest.runtime !== undefined) {
      ensurePluginDataDir(this.#deps.pluginDataDir, row.id);
    }

    // ④ journal — from here on a crash rolls back on the next start
    const now = this.#deps.clock.now();
    const snapshots: Partial<Record<ProjectedKind, string | null>> = {};
    for (const projector of this.#projectors) {
      if (projector.beginUpdate === undefined) continue;
      const adapter = capabilityKindOf(projector.kind);
      if (!adapter.hasContribution(manifest) && !adapter.hasContribution(oldManifest)) {
        continue;
      }
      snapshots[projector.kind] = await projector.beginUpdate(this.#identityOf(row));
    }
    this.#deps.store.update(row.id, {
      updateTo: manifest.version,
      updateSnapshot: JSON.stringify(snapshots),
      updatedAt: now,
    });

    // D125：更新落盘前先终止执行型进程——目录即将被替换，旧进程继续跑旧代码会
    // 让新版清单 / 代码 / 权限在校验通过后仍不生效（下次调用懒启动新版本）。
    // 此后的 isConsumable 因 updateTo != null 为 false，排队调用不会趁机拉起旧版本；
    // 注意用 stop 而不是 teardown：更新不能清空 plugin_storage。
    try {
      this.#runtimeStop?.(row.id);
    } catch (error) {
      // 旧进程没能终止就不能继续替换目录 / 提交新版本（否则旧代码可能继续服务）。
      // 文件尚未改动，清掉 journal 即回到正常状态。
      this.#deps.store.update(row.id, { updateTo: null, updateSnapshot: null });
      throw new AppError('INTERNAL', '插件更新失败：无法终止旧的执行型进程', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    // ⑤ files: same-slot updates park the old dir at `.prev`, then the staged tree moves in
    let prevDir: string | null = null;
    try {
      if (sameDir) {
        prevDir = pluginPrevDirOf(oldDir);
        await rm(prevDir, { recursive: true, force: true });
        await rename(oldDir, prevDir);
      }
      await mkdir(path.dirname(newDir), { recursive: true });
      await rename(staged.stagingDir, newDir);
      staged.stagingDir = ''; // `discard` becomes a no-op below
    } catch (error) {
      // The journal is down but no projector ran: restore the files and clear it.
      await this.#restoreFiles({ sameDir, oldDir, prevDir, newDir });
      this.#deps.store.update(row.id, { updateTo: null, updateSnapshot: null });
      throw error;
    }
    const oldCtxDir = sameDir && prevDir !== null ? prevDir : oldDir;

    // ⑥ project
    const oldCtx: PluginProjectionContext = {
      plugin: this.#identityOf(row),
      manifest: oldManifest,
      dir: oldCtxDir,
      userConfig: {},
      ledger: this.#ledgerFor(row.id),
      owned,
    };
    const newCtx: PluginProjectionContext = {
      plugin: newIdentity,
      manifest,
      dir: newDir,
      userConfig: input.userConfig,
      ledger: this.#ledgerFor(row.id),
      owned,
    };
    try {
      for (const kind of PLUGIN_PROJECTOR_ORDER) {
        const adapter = capabilityKindOf(kind);
        if (!adapter.hasContribution(manifest) && !adapter.hasContribution(oldManifest)) {
          continue;
        }
        const projector = this.#projectorOf(kind);
        if (projector === undefined) continue;
        await projector.update(oldCtx, newCtx);
      }
    } catch (error) {
      await this.#compensateUpdate(row, {
        oldCtx,
        newCtx,
        snapshots,
        sameDir,
        oldDir,
        prevDir,
        newDir,
        newVersion: manifest.version,
        origin,
        tier,
        via: input.via,
        error,
      });
      if (error instanceof AppError) throw error;
      this.#deps.logger.error(
        { plugin: row.id, error: error instanceof Error ? error.message : String(error) },
        'plugin update projection failed',
      );
      throw new AppError(
        'INTERNAL',
        `插件更新失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // ⑦ commit — ONE store update flips everything at once
    this.#deps.store.update(row.id, {
      version: manifest.version,
      tier,
      packageSha256: staged.packageSha256,
      dir: pluginLedgerDir(this.#deps.pluginsDir, newDir),
      marketplace: origin === 'marketplace' ? resolved.marketplace!.endpointId : row.marketplace,
      updateTo: null,
      updateSnapshot: null,
      updatedAt: this.#deps.clock.now(),
    });
    this.#manifests.delete(`${row.id}@${row.version}`);
    this.#manifests.set(`${row.id}@${manifest.version}`, manifest);
    if (manifest.runtime !== undefined) this.#runtimeManifestIds.add(row.id);
    else this.#runtimeManifestIds.delete(row.id);
    for (const kind of PLUGIN_PROJECTOR_ORDER) {
      if (!(kind in snapshots)) continue;
      const projector = this.#projectorOf(kind);
      if (projector?.commitUpdate === undefined) continue;
      try {
        await projector.commitUpdate(newIdentity, snapshots[kind] ?? null);
      } catch (commitError) {
        // The update already committed: a failing release hook only logs.
        this.#deps.logger.warn(
          {
            plugin: row.id,
            kind,
            error: commitError instanceof Error ? commitError.message : String(commitError),
          },
          'plugin update commitUpdate failed',
        );
      }
    }
    if (!row.enabled) await this.#convergeDisabled(row.id, manifest);
    await rm(oldCtxDir, { recursive: true, force: true });
    this.#deps.audit?.recordSystem('plugin_update', {
      pluginId: row.id,
      from: row.version,
      to: manifest.version,
      origin,
      tier,
      via: input.via,
      permissionsExpanded: diff.expanded,
    });
    this.#deps.events.emit('plugins.changed', { ids: [row.id] });
    return this.#summaryOf(this.#deps.store.get(row.id)!);
  }

  /**
   * ⑧ compensation (task 5.3): reverse projector order — `rollbackUpdate` where
   * implemented, a reversed `update` otherwise — then the files back, then the journal
   * cleared, then the `failed` audit. Every step is best effort and logged. Recovery
   * passes null contexts when a side's manifest is unreadable: snapshot-driven
   * `rollbackUpdate` still runs, a reversed `update` is skipped for that kind (warn).
   */
  async #compensateUpdate(
    row: PluginRow,
    context: {
      oldCtx: PluginProjectionContext | null;
      newCtx: PluginProjectionContext | null;
      snapshots: Partial<Record<ProjectedKind, string | null>>;
      sameDir: boolean;
      oldDir: string;
      prevDir: string | null;
      newDir: string;
      newVersion: string;
      origin: PluginRow['origin'];
      tier: PluginRow['tier'];
      via: PluginInstallInput['via'] | PluginUpdateInput['via'];
      error: unknown;
    },
  ): Promise<void> {
    const errorCode = context.error instanceof AppError ? context.error.code : 'INTERNAL';
    const hasContribution = (kind: ProjectedKind, ctx: PluginProjectionContext | null): boolean =>
      ctx !== null && capabilityKindOf(kind).hasContribution(ctx.manifest);
    for (const kind of [...PLUGIN_PROJECTOR_ORDER].reverse()) {
      const involved =
        kind in context.snapshots ||
        hasContribution(kind, context.newCtx) ||
        hasContribution(kind, context.oldCtx);
      if (!involved) continue;
      const projector = this.#projectorOf(kind);
      if (projector === undefined) continue;
      try {
        if (projector.rollbackUpdate !== undefined) {
          await projector.rollbackUpdate(this.#identityOf(row), context.snapshots[kind] ?? null);
        } else {
          if (context.oldCtx === null || context.newCtx === null) {
            // A reversed `update` needs both manifests; recovery skips it (see below).
            this.#deps.logger.warn(
              { plugin: row.id, kind },
              'plugin update compensation skipped: manifest unreadable for reverse update',
            );
            continue;
          }
          await projector.update(context.newCtx, context.oldCtx);
        }
      } catch (compensateError) {
        this.#deps.logger.error(
          {
            plugin: row.id,
            kind,
            error:
              compensateError instanceof Error ? compensateError.message : String(compensateError),
          },
          'plugin update compensation step failed (continuing)',
        );
      }
    }
    // The projection mutated the ledger; restore exactly the pre-update refs (the reverse
    // `update` path already does most of this — the resync is idempotent and also covers
    // `rollbackUpdate` projectors, which never touch the ledger).
    if (context.oldCtx !== null) {
      this.#resyncLedgerTo(row.id, context.oldCtx.owned);
    }
    await this.#restoreFiles(context);
    this.#deps.store.update(row.id, { updateTo: null, updateSnapshot: null });
    this.#deps.audit?.recordSystem('plugin_update', {
      pluginId: row.id,
      from: row.version,
      to: context.newVersion,
      origin: context.origin,
      tier: context.tier,
      via: context.via,
      failed: true,
      error: errorCode,
    });
  }

  /** Undo the ⑤ file moves: the new dir goes, a parked `.prev` dir goes back. */
  async #restoreFiles(context: {
    sameDir: boolean;
    oldDir: string;
    prevDir: string | null;
    newDir: string;
  }): Promise<void> {
    try {
      await rm(context.newDir, { recursive: true, force: true });
    } catch (error) {
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'plugin update file restore: new dir removal failed',
      );
    }
    if (context.sameDir && context.prevDir !== null) {
      try {
        await rename(context.prevDir, context.oldDir);
      } catch (error) {
        this.#deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'plugin update file restore: prev dir swap-back failed',
        );
      }
    }
  }

  /**
   * Crash recovery for one journalled update row. A missing new dir means the crash
   * happened before the file move: only the journal is cleared (and a parked `.prev`
   * swapped back). Otherwise the full ⑧ compensation runs from the on-disk manifests.
   */
  async #recoverUpdatingRow(row: PluginRow): Promise<void> {
    const newVersion = row.updateTo;
    if (newVersion === null) {
      this.#deps.store.update(row.id, { updateTo: null, updateSnapshot: null });
      return;
    }
    const oldDir = this.#slotDirOf(row);
    let newDir: string;
    try {
      newDir = pluginDirOf(this.#deps.pluginsDir, row.id, newVersion);
    } catch (error) {
      this.#deps.logger.warn(
        { plugin: row.id, error: error instanceof Error ? error.message : String(error) },
        'plugin update recovery: invalid target version, clearing journal',
      );
      this.#deps.store.update(row.id, { updateTo: null, updateSnapshot: null });
      return;
    }
    const prevDir = pluginPrevDirOf(oldDir);
    if (!existsSync(newDir)) {
      if (existsSync(prevDir)) await rename(prevDir, oldDir);
      this.#deps.store.update(row.id, { updateTo: null, updateSnapshot: null });
      return;
    }
    const sameDir = oldDir === newDir;
    const oldCtxDir = existsSync(prevDir) ? prevDir : oldDir;
    // Manifests are read from disk; an unreadable side only skips its projectors (warn):
    // snapshot-driven `rollbackUpdate` still runs, a reversed `update` cannot.
    const oldManifest = await this.#readManifestFromDir(oldCtxDir);
    const newManifest = await this.#readManifestFromDir(newDir);
    let snapshots: Partial<Record<ProjectedKind, string | null>> = {};
    try {
      snapshots =
        row.updateSnapshot !== null
          ? (JSON.parse(row.updateSnapshot) as Partial<Record<ProjectedKind, string | null>>)
          : {};
    } catch {
      this.#deps.logger.warn(
        { plugin: row.id },
        'plugin update recovery: snapshot unreadable, compensating without projector snapshots',
      );
    }
    const origin = row.origin;
    const owned = this.#ownedFor(row.id);
    const ledger = this.#ledgerFor(row.id);
    const oldCtx: PluginProjectionContext | null =
      oldManifest === null
        ? null
        : {
            plugin: this.#identityOf(row),
            manifest: oldManifest,
            dir: oldCtxDir,
            userConfig: {},
            ledger,
            owned,
          };
    const newCtx: PluginProjectionContext | null =
      newManifest === null
        ? null
        : {
            plugin: { id: row.id, version: newVersion, origin, tier: row.tier },
            manifest: newManifest,
            dir: newDir,
            userConfig: {},
            ledger,
            owned,
          };
    if (oldCtx === null) {
      this.#deps.logger.warn(
        { plugin: row.id },
        'plugin update recovery: old manifest unreadable, reverse updates skipped',
      );
    }
    if (newCtx === null) {
      this.#deps.logger.warn(
        { plugin: row.id },
        'plugin update recovery: new manifest unreadable, reverse updates skipped',
      );
    }
    await this.#compensateUpdate(row, {
      oldCtx,
      newCtx,
      snapshots,
      sameDir,
      oldDir,
      prevDir,
      newDir,
      newVersion,
      origin,
      tier: row.tier,
      via: origin === 'marketplace' ? 'marketplace' : 'file',
      error: new AppError('INTERNAL', '更新被中断，已回滚'),
    });
  }

  /**
   * Startup sweep of directories this registry created but no row describes anymore:
   * `{name}@{version}` without a row, and `{name}@{version}.prev` whose row is not
   * updating. Anything NOT matching the pattern is never touched.
   */
  async #sweepOrphanDirs(): Promise<void> {
    const root = path.resolve(this.#deps.pluginsDir);
    let namespaces: string[];
    try {
      namespaces = await readdir(root);
    } catch {
      return;
    }
    const rows = this.#deps.store.list();
    const occupied = new Set(rows.map((row) => row.dir.toLowerCase()));
    let removed = 0;
    for (const namespace of namespaces) {
      if (namespace.startsWith('.')) continue; // `.staging` and friends
      const namespacePath = path.join(root, namespace);
      const info = await stat(namespacePath).catch(() => null);
      if (info === null || !info.isDirectory()) continue;
      for (const entry of await readdir(namespacePath)) {
        const relative = path.join(namespace, entry).split(path.sep).join('/').toLowerCase();
        // A row's own slot is never touched — including the odd-but-legal case of a
        // prerelease version that itself ends in `.prev` (e.g. `1.0.0-a.prev`), which the
        // `.prev`-parked heuristic below would otherwise strip and misread as garbage.
        if (occupied.has(relative)) continue;
        const prevMatch = /^(.+)@([^@]+)\.prev$/.exec(entry.toLowerCase());
        if (prevMatch !== null) {
          const baseSlot = `${namespace}/${prevMatch[1]}@${prevMatch[2]}`.toLowerCase();
          const row = rows.find((candidate) => candidate.dir.toLowerCase() === baseSlot);
          if (row !== undefined && row.updateTo !== null) continue; // update in flight
          await rm(path.join(namespacePath, entry), { recursive: true, force: true }).catch(
            () => undefined,
          );
          removed += 1;
          continue;
        }
        if (!PLUGIN_SLOT_PATTERN.test(entry.toLowerCase())) continue;
        await rm(path.join(namespacePath, entry), { recursive: true, force: true }).catch(
          () => undefined,
        );
        removed += 1;
      }
    }
    if (removed > 0) {
      this.#deps.logger.info({ removed }, 'plugin registry swept orphan dirs');
    }
  }

  /**
   * An update re-projects a DISABLED plugin: the skills projector installs public rows
   * again and newly added servers come back `enabled`, contradicting design 51 §7
   * (enabled=0 means every projection removed). Re-running the disable unwind after the
   * commit converges the state; idempotent for projectors that kept their disabled state.
   */
  async #convergeDisabled(pluginId: string, manifest: PluginManifest): Promise<void> {
    const row = this.#deps.store.get(pluginId);
    if (row === null || row.enabled) return;
    const ctx = await this.#contextFor(row, manifest, {});
    for (const kind of [...PLUGIN_PROJECTOR_ORDER].reverse()) {
      const refs = this.#deps.store.refs(pluginId, kind);
      if (refs.length === 0) continue;
      const projector = this.#projectorOf(kind);
      if (projector === undefined) continue;
      try {
        await projector.setEnabled(ctx, refs, false);
      } catch (error) {
        // Best effort: the update itself is committed; a failed step only logs.
        this.#deps.logger.warn(
          { plugin: pluginId, kind, error: error instanceof Error ? error.message : String(error) },
          'plugin update: disable converge failed',
        );
      }
    }
  }

  /**
   * D124 安装管线校验步（60 号文档 §2）：能力模型条目绑定的 `engine` 必须已在
   * `MEDIA_ENGINES` 注册——未知引擎拒绝安装 / 更新（PLUGIN_ENGINE_UNKNOWN，错误
   * 信息列出已注册引擎 id）。执行逻辑住在第一方引擎里：包内数据指向不存在的
   * 引擎 = 当前版本无法安全执行，不能静默忽略。
   */
  #assertEnginesKnown(manifest: PluginManifest): void {
    const unknown = new Set<string>();
    for (const entry of manifest.contributions.capabilityModels ?? []) {
      // D125 过渡：执行型条目不填 engine（61 §2，与 manifest 的 runtime 段配对），
      // 其安装期校验归 D125-P2 执行型管线；这里只校验数据型条目（有 engine）。
      if (entry.engine === undefined) continue;
      if (MEDIA_ENGINES[entry.engine] === undefined) unknown.add(entry.engine);
    }
    if (unknown.size > 0) {
      throw new AppError(
        'PLUGIN_ENGINE_UNKNOWN',
        `条目绑定的引擎未注册：${[...unknown].sort().join('、')}（已注册：${Object.keys(MEDIA_ENGINES).join('、')}）`,
        { engines: [...unknown].sort() },
      );
    }
  }

  /**
   * Required user_config fields of the NEW version's mcpb contributions must be
   * satisfiable BEFORE any persistent write: provided values count, a declared default
   * counts (same rule as `validateUserConfig` on first install), and a required sensitive
   * field with a stored secret counts as satisfied (P1-2 keep-secrets).
   */
  #prevalidateUpdateUserConfig(
    manifest: PluginManifest,
    inspection: { items: ConsentItems },
    userConfig: Record<string, Record<string, McpbUserConfigValue>>,
    pluginId: string,
  ): void {
    const isEmpty = (value: McpbUserConfigValue | undefined): boolean =>
      value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    for (const contribution of manifest.contributions.mcp) {
      if (contribution.kind !== 'mcpb') continue;
      const item = inspection.items.mcp.find(
        (entry) => entry.kind === 'mcpb' && entry.id === contribution.id,
      );
      if (item === undefined || item.kind !== 'mcpb') continue;
      const provided = userConfig[contribution.id] ?? {};
      const serverId = pluginServerId(pluginId, contribution.id);
      for (const field of item.userConfigFields) {
        if (!field.required) continue;
        if (!isEmpty(provided[field.key] ?? field.default)) continue;
        if (
          field.sensitive &&
          this.#deps.secrets?.hasValue(`mcp:${serverId}:env:${field.key}`) === true
        ) {
          continue;
        }
        throw new AppError('INVALID_INPUT', `请填写必填配置项：${field.title}`, {
          contributionId: contribution.id,
          field: field.key,
        });
      }
    }
  }

  /** The row's `dir` is the slot truth: resolve it under the plugins root (guarded). */
  #slotDirOf(row: PluginRow): string {
    const root = path.resolve(this.#deps.pluginsDir);
    const resolved = path.resolve(root, row.dir);
    const relative = path.relative(root, resolved);
    if (
      !resolved.startsWith(root + path.sep) ||
      relative.split(path.sep).length !== 2 ||
      !PLUGIN_SLOT_PATTERN.test(path.basename(resolved))
    ) {
      throw new AppError('PLUGIN_INVALID', `插件目录越界：${row.dir}`);
    }
    return resolved;
  }

  /** Restores exactly the pre-update ledger refs (idempotent; never touches other plugins). */
  #resyncLedgerTo(
    pluginId: string,
    owned: Readonly<Record<ProjectedKind, ReadonlySet<string>>>,
  ): void {
    for (const kind of PLUGIN_PROJECTOR_ORDER) {
      const desired = owned[kind];
      for (const ref of this.#deps.store.refs(pluginId, kind)) {
        if (!desired.has(ref)) this.#deps.store.removeItem(pluginId, kind, ref);
      }
      for (const ref of desired) this.#deps.store.addItem(pluginId, kind, ref);
    }
  }

  setEnabled(id: string, enabled: boolean): Promise<PluginSummary> {
    return this.#runExclusive(() => this.#setEnabledLocked(id, enabled));
  }

  async #setEnabledLocked(
    id: string,
    enabled: boolean,
    options: { auditReason?: string } = {},
  ): Promise<PluginSummary> {
    if (this.#isBuiltin(id)) {
      throw new AppError('INVALID_INPUT', '内置插件不能停用或卸载');
    }
    const row = this.#deps.store.get(id);
    if (row === null) throw new AppError('NOT_FOUND', `没有已安装的插件：${id}`);
    if (row.updateTo !== null) {
      // Unreachable under normal operation (the mutex serialises updates); a defensive
      // refusal keeps the enabled flag from drifting across a rollback.
      throw new AppError('INVALID_INPUT', '插件正在更新');
    }
    if (row.state !== 'installed') {
      throw new AppError('INVALID_INPUT', `插件当前状态（${row.state}）不允许启停`);
    }
    if (row.enabled === enabled) return this.#summaryOf(row);

    // D125 P2：停用 = kill switch 即时生效（61 §7）——先杀掉执行型进程，再做投影回滚。
    // 投影 / 行更新完成前该 id 从可消费集合摘掉：排队中的调用不得重新拉起进程。
    if (!enabled) {
      this.#runtimeHalted.add(id);
      try {
        this.#runtimeStop?.(id);
      } catch (error) {
        this.#deps.logger.warn(
          { plugin: id, error: error instanceof Error ? error.message : String(error) },
          'plugin setEnabled: runtime stop failed',
        );
      }
    }
    try {
      const manifest = await this.#readManifestFromDir(this.#dirOf(row.id, row.version));
      if (manifest === null) {
        // The flag must never drift from the projected state (design 51 §7: enabled=0
        // removes every projection). With unreadable content we cannot run the projectors
        // — refusing keeps `enabled` truthful; uninstall still works from the ledger.
        throw new AppError('PLUGIN_INVALID', '插件内容不可读，无法启停；如需移除请卸载该插件');
      }
      const ctx = await this.#contextFor(row, manifest, {});
      // Disable unwinds in reverse projection order, enable re-projects forward.
      const order = enabled ? [...PLUGIN_PROJECTOR_ORDER] : [...PLUGIN_PROJECTOR_ORDER].reverse();
      for (const kind of order) {
        const refs = this.#deps.store.refs(id, kind);
        if (refs.length === 0) continue;
        const projector = this.#projectorOf(kind);
        if (projector === undefined) continue;
        await projector.setEnabled(ctx, refs, enabled);
      }
      this.#deps.store.update(id, { enabled, updatedAt: this.#deps.clock.now() });
      this.#deps.audit?.recordSystem('plugin_set_enabled', {
        pluginId: id,
        version: row.version,
        origin: row.origin,
        tier: row.tier,
        ...(options.auditReason !== undefined ? { reason: options.auditReason } : {}),
      });
      this.#deps.events.emit('plugins.changed', { ids: [id] });
      return this.#summaryOf(this.#deps.store.get(id)!);
    } finally {
      if (!enabled) this.#runtimeHalted.delete(id);
    }
  }

  uninstall(id: string): Promise<void> {
    return this.#runExclusive(() => this.#uninstallLocked(id));
  }

  async #uninstallLocked(id: string): Promise<void> {
    if (this.#isBuiltin(id)) {
      throw new AppError('INVALID_INPUT', '内置插件不能停用或卸载');
    }
    const row = this.#deps.store.get(id);
    if (row === null) throw new AppError('NOT_FOUND', `没有已安装的插件：${id}`);
    // Best effort: the row is gone either way, so audit + event fire even when a
    // projector failed and the first error is rethrown afterwards.
    let firstError: unknown = null;
    try {
      await this.#teardown(id, this.#identityOf(row), { throwOnError: true });
    } catch (error) {
      firstError = error;
    }
    // Reference faces first (idempotent): stale ids in bot profiles / project overlays
    // would otherwise deadlock every whole-set write (write paths validate existence).
    this.#referenceCleanup?.(id);
    this.#deps.audit?.recordSystem('plugin_uninstall', {
      pluginId: id,
      version: row.version,
      origin: row.origin,
      tier: row.tier,
    });
    this.#deps.events.emit('plugins.changed', { ids: [id] });
    if (firstError !== null) throw firstError;
  }

  // --- teardown（卸载与回滚共用；幂等） ---------------------------------------------

  /**
   * Reverses the projection in reverse order strictly from the ledger, removes the
   * directory and the row. One projector failing only logs (best effort) — the rest
   * of the cleanup always completes. `throwOnError` rethrows the FIRST error at the
   * end (the uninstall path), while rollback keeps it log-only.
   */
  async #teardown(
    id: string,
    identity: PluginIdentity,
    options: { throwOnError: boolean },
  ): Promise<void> {
    // 卸载 / 回滚期间视为不可消费：目录删除与行删除之间的窗口内不允许再拉起进程。
    this.#runtimeHalted.add(id);
    // D125：执行型进程必须先终止（目录即将被删；Windows 上打开的文件句柄会阻塞 rm）。
    try {
      this.#runtimeTeardown?.(id);
    } catch (error) {
      this.#deps.logger.warn(
        { plugin: id, error: error instanceof Error ? error.message : String(error) },
        'plugin teardown: runtime dispose failed (continuing)',
      );
    }
    // D105: instances go FIRST — materializers may still read projected state, and the
    // rows must be gone before the plugin row deletes (FK CASCADE would drop them raw).
    if (this.#instanceTeardown !== null) {
      try {
        await this.#instanceTeardown(id);
      } catch (error) {
        this.#deps.logger.warn(
          { plugin: id, error: error instanceof Error ? error.message : String(error) },
          'plugin teardown: instance cascade failed (continuing)',
        );
      }
    }
    // D125 收口审查：插件级 config 敏感字段（`plugin:{scope}:config:*`）此前不在卸载
    // 清理范围（实例 secrets 由 instance teardown 按实例前缀清）。这里按插件作用域
    // 前缀兜底清掉**全部** secret（含清单改名 / 删字段后的残留）；作用域编码是单射的，
    // 前缀带结尾冒号，不会碰到其它插件。best-effort，失败只 warn。
    const pluginSecrets = this.#deps.secrets;
    if (pluginSecrets?.names !== undefined && pluginSecrets.removeValue !== undefined) {
      const prefix = `${pluginSecretScope(id)}:`;
      for (const name of pluginSecrets.names()) {
        if (!name.startsWith(prefix)) continue;
        try {
          pluginSecrets.removeValue(name);
        } catch (error) {
          this.#deps.logger.warn(
            { plugin: id, name, error: error instanceof Error ? error.message : String(error) },
            'plugin teardown: secret removal failed (continuing)',
          );
        }
      }
    }
    const row = this.#deps.store.get(id);
    if (row !== null && row.state !== 'uninstalling') {
      this.#deps.store.update(id, { state: 'uninstalling' });
    }
    const ledger = this.#ledgerFor(id);
    const errors: unknown[] = [];
    for (const kind of [...PLUGIN_PROJECTOR_ORDER].reverse()) {
      const refs = this.#deps.store.refs(id, kind);
      if (refs.length === 0) continue;
      const projector = this.#projectorOf(kind);
      if (projector === undefined) continue;
      try {
        await projector.unproject(identity, refs, ledger);
      } catch (error) {
        errors.push(error);
        this.#deps.logger.warn(
          { plugin: id, kind, error: error instanceof Error ? error.message : String(error) },
          'plugin teardown: unproject failed (continuing)',
        );
      }
    }
    try {
      // The path goes through the guarded dirOf: never rm outside the plugins root.
      await rm(this.#dirOf(identity.id, identity.version), { recursive: true, force: true });
    } catch (error) {
      this.#deps.logger.warn(
        { plugin: identity.id, error: error instanceof Error ? error.message : String(error) },
        'plugin teardown: dir removal failed',
      );
    }
    // D125 补丁：卸载 / 安装回滚清掉私有数据目录（版本无关）。尽力而为：失败只记
    // 日志，不掩盖卸载本身的错误（数据目录残留已无行引用，不影响再次安装）。
    try {
      await rm(pluginDataDirFor(this.#deps.pluginDataDir, id), { recursive: true, force: true });
    } catch (error) {
      this.#deps.logger.warn(
        { plugin: id, error: error instanceof Error ? error.message : String(error) },
        'plugin teardown: data dir removal failed',
      );
    }
    this.#deps.store.delete(id);
    this.#manifests.delete(`${id}@${identity.version}`);
    this.#runtimeHalted.delete(id);
    this.#runtimeManifestIds.delete(id);
    if (options.throwOnError && errors.length > 0) {
      const error = errors[0];
      if (error instanceof AppError) throw error;
      throw new AppError(
        'INTERNAL',
        `插件卸载未完全成功：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- helpers ------------------------------------------------------------------

  #projectorOf(kind: ProjectedKind): PluginProjector | undefined {
    return this.#projectors.find((projector) => projector.kind === kind);
  }

  #identityOf(row: PluginRow): PluginIdentity {
    return { id: row.id, version: row.version, origin: row.origin, tier: row.tier };
  }

  /** Guarded absolute install dir (the lower-cased `{ns}/{name}@{version}` slot). */
  #dirOf(id: string, version: string): string {
    return pluginDirOf(this.#deps.pluginsDir, id, version);
  }

  #ledgerFor(pluginId: string): PluginLedger {
    const store = this.#deps.store;
    return {
      add: (kind, ref) => store.addItem(pluginId, kind, ref),
      remove: (kind, ref) => store.removeItem(pluginId, kind, ref),
      list: (kind) => store.refs(pluginId, kind),
    };
  }

  async #contextFor(
    row: PluginRow,
    manifest: PluginManifest,
    userConfig: Record<string, Record<string, McpbUserConfigValue>>,
  ): Promise<PluginProjectionContext> {
    return {
      plugin: this.#identityOf(row),
      manifest,
      dir: this.#dirOf(row.id, row.version),
      userConfig,
      ledger: this.#ledgerFor(row.id),
      owned: this.#ownedFor(row.id),
    };
  }

  /** The plugin's ledger refs per projected kind — the `owned` conflict-exclusion set. */
  #ownedFor(pluginId: string): Readonly<Record<ProjectedKind, ReadonlySet<string>>> {
    const owned: Record<ProjectedKind, Set<string>> = {
      skill: new Set(),
      connector: new Set(),
      mcp: new Set(),
      mail: new Set(),
      im: new Set(),
      'capability-model': new Set(),
    };
    for (const item of this.#deps.store.items(pluginId)) {
      if (item.kind === 'disabled_connection') continue;
      owned[item.kind].add(item.ref);
    }
    return owned;
  }

  async #readManifestFromDir(dir: string): Promise<PluginManifest | null> {
    try {
      const manifest = parsePluginManifestText(
        await readFile(path.join(dir, PLUGIN_MANIFEST_FILE), 'utf8'),
      );
      this.#manifests.set(`${manifest.id}@${manifest.version}`, manifest);
      return manifest;
    } catch {
      return null;
    }
  }

  /**
   * Runs every projector's inspect for the kinds present in the manifest and merges the
   * results. Shared by `inspect`, the pre-check inside `install`, and the update flow's
   * old/new permission derivation (the latter keeps only `items`, ignoring conflicts).
   */
  async #inspectContext(ctx: PluginProjectionContext): Promise<{
    items: ConsentItems;
    conflicts: PluginInspectOutput['conflicts'];
    blockers: string[];
  }> {
    const items: ConsentItems = {
      skills: [],
      connectors: [],
      mcp: [],
      mail: [],
      im: [],
      capabilityModels: [],
    };
    const conflicts: PluginInspectOutput['conflicts'] = [];
    const blockers: string[] = [];
    for (const projector of this.#projectors) {
      const adapter = capabilityKindOf(projector.kind);
      if (!adapter.hasContribution(ctx.manifest)) continue;
      const inspection = await projector.inspect(ctx);
      mergeConsentItems(items, adapter.consentKey, adapter.consentItems(inspection));
      conflicts.push(...inspection.conflicts);
      blockers.push(...inspection.blockers);
    }
    return { items, conflicts, blockers };
  }

  async #inspectStaged(
    staged: StagedPlugin,
    identity: PluginIdentity = {
      id: staged.manifest.id,
      version: staged.manifest.version,
      origin: 'local',
      tier: 'developer',
    },
    owned: Readonly<Record<ProjectedKind, ReadonlySet<string>>> = emptyOwned(),
  ): Promise<InspectStagedResult> {
    const inspection = await this.#inspectContext({
      plugin: identity,
      manifest: staged.manifest,
      dir: staged.stagingDir,
      userConfig: {},
      ledger: new NullLedger(),
      owned,
    });
    return { identity, ...inspection };
  }

  /** Which update path applies to an already-installed id, per the P1-2 flow table. */
  #updateFlowOf(
    row: PluginRow,
    marketplace: ResolvedSource['marketplace'],
    sourceKind: PluginSource['kind'],
  ): 'local' | 'marketplace' | 'downgrade' | 'conflict' {
    if (row.origin === 'local') {
      return marketplace === null && sourceKind !== 'marketplace' ? 'local' : 'conflict';
    }
    if (
      row.origin === 'marketplace' &&
      marketplace !== null &&
      row.marketplace === marketplace.endpointId
    ) {
      return (compareConnectorVersions(marketplace.entry.version, row.version) ?? -1) > 0
        ? 'marketplace'
        : 'downgrade';
    }
    return 'conflict';
  }

  async #inspectStagedOutput(
    staged: StagedPlugin,
    marketplace: ResolvedSource['marketplace'] = null,
    sourceKind: PluginSource['kind'] = 'file',
  ): Promise<PluginInspectOutput> {
    const identity: PluginIdentity =
      marketplace === null
        ? {
            id: staged.manifest.id,
            version: staged.manifest.version,
            origin: 'local',
            tier: 'developer',
          }
        : {
            id: staged.manifest.id,
            version: staged.manifest.version,
            origin: 'marketplace',
            tier: marketplace.entry.tier,
          };
    const manifest = staged.manifest;
    const existingRow = this.#deps.store.get(manifest.id);
    const owned = existingRow === null ? emptyOwned() : this.#ownedFor(existingRow.id);
    const inspection = await this.#inspectStaged(staged, identity, owned);
    const blockers = [...inspection.blockers];
    // D125 P2：执行型插件的能力披露（同意卡数据面）+ 阻断列表（层级 / entry / 包防护 /
    // hostApi），与安装期同一份判定。
    const runtimeCheck = await runtimeDisclosureOf(manifest, {
      dir: staged.stagingDir,
      tier: runtimeTierOf(marketplace),
    });
    blockers.push(...runtimeCheck.blockers);
    // Namespace gate surfaces as a blocker in the consent view (install throws PLUGIN_INVALID).
    try {
      assertInstallablePluginId(manifest.id);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    let update: PluginInspectOutput['update'] = null;
    if (existingRow !== null) {
      const flow = this.#updateFlowOf(existingRow, marketplace, sourceKind);
      if (flow === 'conflict') {
        blockers.push(
          `已安装同 id 插件（来源：${existingRow.origin === 'marketplace' ? '市场' : '本地'}），请先卸载`,
        );
      } else if (flow === 'downgrade') {
        blockers.push('已是最新版本或更旧（不允许降级）');
      } else {
        // The update view: own conflicts were excluded via `owned`; diff the permission
        // tokens of the installed version (conflicts / blockers ignored) against staging.
        const oldManifest = await this.#readManifestFromDir(this.#slotDirOf(existingRow));
        if (oldManifest !== null) {
          const oldItems = await this.#inspectContext({
            plugin: this.#identityOf(existingRow),
            manifest: oldManifest,
            dir: this.#slotDirOf(existingRow),
            userConfig: {},
            ledger: new NullLedger(),
            owned,
          });
          const oldRuntimeDisclosure = await runtimeDisclosureOf(oldManifest, {
            dir: this.#slotDirOf(existingRow),
            tier: this.#identityOf(existingRow).tier,
          });
          const diff = diffPermissions(
            unionPermissionTokens(permissionTokens(oldItems.items), oldRuntimeDisclosure.runtime),
            unionPermissionTokens(permissionTokens(inspection.items), runtimeCheck.runtime),
          );
          update = {
            from: existingRow.version,
            permissionsExpanded: diff.expanded,
            added: diff.added.map(describePermission),
          };
        } else {
          blockers.push('已安装插件的内容不可读，无法更新；如需移除请卸载');
        }
      }
    } else {
      // The install slot is the lower-cased `{id}@{version}`: a case-variant id of a
      // DIFFERENT plugin must not rename-collide with an installed plugin's directory
      // (design 51 §5 — one slot per id on case-insensitive file systems).
      const slot = pluginDirName(manifest.id, manifest.version);
      const slotOwner = this.#deps.store.list().find((row) => row.dir === slot);
      if (slotOwner !== undefined) {
        inspection.conflicts.push({
          kind: 'plugin',
          ref: manifest.id,
          withWhat: `安装目录槽位已被插件 ${slotOwner.id} 占用（目录名仅大小写不同）`,
        });
      }
    }
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author?.name ?? null,
      homepage: manifest.homepage ?? null,
      packageSha256: staged.packageSha256,
      sizeBytes: staged.sizeBytes,
      configFields: (manifest.config?.fields ?? []).map(pluginFieldSummaryOf),
      capabilitySummary: pluginCapabilitySummary(capabilityFactsOf(manifest)),
      skills: inspection.items.skills,
      connectors: inspection.items.connectors,
      mcp: inspection.items.mcp,
      mail: inspection.items.mail,
      im: inspection.items.im,
      conflicts: inspection.conflicts,
      existing: existingRow === null ? null : { version: existingRow.version },
      update,
      installable: blockers.length === 0 && inspection.conflicts.length === 0,
      blockers,
      origin: marketplace === null ? 'local' : 'marketplace',
      tier: marketplace === null ? 'developer' : marketplace.entry.tier,
      runtime: runtimeCheck.runtime,
    };
  }

  #summaryOf(row: PluginRow): PluginSummary {
    const identity = this.#identityOf(row);
    const items: PluginItemRef[] = [];
    const counts = { skills: 0, connectors: 0, mcp: 0, mail: 0, im: 0 };
    // Connector yields come from the connectors projector (which owns the catalog view).
    const yielded = this.#yieldedSlugs();
    for (const adapter of CAPABILITY_KINDS) {
      const kind = adapter.kind;
      // D124：capability-model 条目不进插件卡的 counts / items（共享契约的固定五键），
      // 条目清单走 `plugins.listCapabilityEntries`；账本行仍由投影器维护。
      if (kind === 'capability-model') continue;
      const refs = this.#deps.store.refs(row.id, kind);
      // kind 排除 capability-model 后 consentKey 必在固定五键内（跨属性关系 TS 不可推断）。
      counts[adapter.consentKey as keyof typeof counts] = refs.length;
      if (refs.length === 0) continue;
      const missing = new Set(this.#projectorOf(kind)?.missing?.(identity, refs) ?? []);
      for (const ref of refs) {
        items.push({
          kind,
          ref,
          ...(missing.has(ref) ? { missing: true } : {}),
          ...(kind === 'connector' && yielded.has(ref) ? { yielded: true } : {}),
        });
      }
    }
    let dirPath: string | null;
    try {
      dirPath = this.#dirOf(row.id, row.version);
    } catch {
      dirPath = null;
    }
    const manifest = this.#manifests.get(`${row.id}@${row.version}`) ?? null;
    // D105 P3: the resolved instance form fields (kind built-ins + manifest
    // instanceFields), same safe projection as configFields.
    const instanceFields =
      manifest === null
        ? []
        : (manifest.instances ?? []).flatMap((kind) =>
            capabilityKindOf(kind).instanceFields(manifest).map(pluginFieldSummaryOf),
          );
    const instanceRowCounts = this.#deps.instanceStore?.countsOf(row.id) ?? {
      mail: 0,
      mcp: 0,
      im: 0,
    };
    return {
      configFields: (manifest?.config?.fields ?? []).map(pluginFieldSummaryOf),
      instanceFields,
      instanceCounts: {
        mail: this.#deps.mailInstanceCount?.(row.id) ?? instanceRowCounts.mail,
        mcp: instanceRowCounts.mcp,
        // D107：im 账号全部挂实例，行数即活跃账号数（无遗留账号口径要处理）。
        im: instanceRowCounts.im,
      },
      providesInstances: manifest?.instances ?? [],
      id: row.id,
      name: manifest?.name ?? row.id,
      iconDataUri: pluginIconDataUri(dirPath, manifest),
      version: row.version,
      description: manifest?.description ?? '',
      usage: sanitizeDisplayText(manifest?.usage ?? '', 500),
      author: manifest?.author?.name ?? null,
      origin: row.origin,
      tier: row.tier,
      state: row.state,
      enabled: row.enabled,
      dirPath,
      marketplace: row.marketplace,
      installedAt: row.installedAt,
      updatedAt: row.updatedAt,
      counts,
      items,
      updateAvailable: this.#marketUpdateOf(row),
      revoked: this.#marketRevocationOf(row),
    };
  }

  /** The connectors projector's yield set, reached structurally (no catalog dependency). */
  #yieldedSlugs(): ReadonlySet<string> {
    const connectors = this.#projectors.find(
      (projector): projector is PluginProjector & { yieldedSlugs(): ReadonlySet<string> } =>
        projector.kind === 'connector' && 'yieldedSlugs' in projector,
    );
    return connectors?.yieldedSlugs() ?? new Set<string>();
  }
}
