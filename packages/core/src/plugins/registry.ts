import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  PLUGIN_MANIFEST_FILE,
  capabilityFactsOf,
  pluginCapabilitySummary,
  pluginFieldSummaryOf,
  type McpbUserConfigValue,
  type PluginFieldValue,
  type PluginItemKind,
  type PluginConsentConnector,
  type PluginConsentMail,
  type PluginConsentMcp,
  type PluginConsentSkill,
  type PluginIndexEntry,
  type PluginInspectOutput,
  type PluginItemRef,
  type PluginManifest,
  type PluginMarketEntry,
  type MailProviderTemplate,
  type PluginSource,
  type PluginSummary,
} from '@kepcup/shared';
import { compareConnectorVersions } from '../apps/connector-utils.js';
import { validateUserConfig } from '../apps/mcpb/manifest.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { BuiltinPlugins } from './builtin.js';
import type { MarketplaceService } from './marketplace-service.js';
import {
  describePermission,
  diffPermissions,
  permissionTokens,
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
import {
  CAPABILITY_KINDS,
  capabilityKindOf,
  mergeConsentItems,
  type ConsentItem,
} from './kinds.js';
import {
  pluginConfigSecretName,
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
      }
    | undefined;
  /** Instance rows (D105): `list()` instance counts read it directly. */
  instanceStore?: PluginInstanceStore | undefined;
  pluginsDir: string;
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

export class PluginRegistry {
  readonly #deps: PluginRegistryDeps;
  readonly #projectors: readonly PluginProjector[];
  #tail: Promise<void> = Promise.resolve();
  /** Manifest cache keyed by `{id}@{version}`; invalidated when the plugin goes away. */
  readonly #manifests = new Map<string, PluginManifest>();
  /** Instance teardown (D105), wired by start.ts: `PluginInstanceService.deleteAllOf`. */
  #instanceTeardown: ((pluginId: string) => Promise<void>) | null = null;

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

  ownerOf(kind: PluginItemKind, ref: string): string | null {
    return this.#deps.store.ownerOf(kind, ref);
  }

  /**
   * 已装插件的完整清单（缓存 → 磁盘）；未装 / 清单损坏 = null。实例服务与 config
   * 读写用它取 `config.fields` / `instances` 声明（D105）。
   */
  async manifestOf(id: string): Promise<PluginManifest | null> {
    const row = this.#deps.store.get(id);
    if (row === null) return null;
    const cached = this.#manifests.get(`${row.id}@${row.version}`);
    if (cached !== undefined) return cached;
    return this.#readManifestFromDir(this.#dirOf(row.id, row.version));
  }

  /** 已装插件清单的贡献（P1 的邮件模板 overlay 读取用）；未装 / 清单损坏 = null。 */
  async contributionsOf(id: string): Promise<PluginManifest['contributions'] | null> {
    const row = this.#deps.store.get(id);
    if (row === null) return null;
    const manifest = await this.#readManifestFromDir(this.#dirOf(row.id, row.version));
    return manifest?.contributions ?? null;
  }

  /**
   * 已启用插件贡献的邮件预填模板（D104 P1-3，`mail.providerTemplates.list`）：遍历
   * `installed && enabled` 的行读清单 `contributions.mail`；清单读不到的插件跳过。
   */
  async mailTemplates(): Promise<MailProviderTemplate[]> {
    const templates: MailProviderTemplate[] = [];
    for (const row of this.#deps.store.list()) {
      if (row.state !== 'installed' || !row.enabled) continue;
      const manifest = await this.#readManifestFromDir(this.#dirOf(row.id, row.version));
      if (manifest === null) {
        this.#deps.logger.warn(
          { plugin: row.id },
          'plugin mail templates skipped: manifest unreadable',
        );
        continue;
      }
      for (const contribution of manifest.contributions.mail) {
        templates.push({
          id: `${manifest.id}#${contribution.id}`,
          pluginId: manifest.id,
          pluginName: manifest.name,
          label: contribution.label,
          imap: { ...contribution.imap },
          smtp: { ...contribution.smtp },
          defaultMode: contribution.defaultMode,
          defaultPollSec: contribution.defaultPollSec,
          minPollSec: contribution.minPollSec,
          helpUrl: contribution.helpUrl ?? null,
        });
      }
    }
    return templates;
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
      let values: Record<string, PluginFieldValue> = {};
      try {
        values = JSON.parse(row.configJson) as Record<string, PluginFieldValue>;
      } catch {
        this.#deps.logger.warn({ plugin: id }, 'plugin config_json unreadable; treated as empty');
      }
      const storedSensitiveKeys = fields
        .filter((field) => this.#deps.secrets?.hasValue(pluginConfigSecretName(id, field.key)) === true)
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
        dir: path.relative(this.#deps.pluginsDir, finalDir),
        updateTo: null,
        updateSnapshot: null,
        configJson: '{}',
        installedAt: now,
        updatedAt: now,
      });

      this.#manifests.set(`${id}@${version}`, manifest);
      const insertedRow = this.#deps.store.get(id)!;
      const ctx = await this.#contextFor(insertedRow, manifest, input.userConfig);
      try {
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
    const diff = diffPermissions(
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
      permissionTokens(itemsOf(newInspection)),
    );
    if (diff.expanded && !input.acknowledgeDiff) {
      throw new AppError('INVALID_INPUT', '更新新增了权限，请先确认差异', {
        permissionsExpanded: true,
        added: diff.added,
      });
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
      dir: path.relative(this.#deps.pluginsDir, newDir),
      marketplace: origin === 'marketplace' ? resolved.marketplace!.endpointId : row.marketplace,
      updateTo: null,
      updateSnapshot: null,
      updatedAt: this.#deps.clock.now(),
    });
    this.#manifests.delete(`${row.id}@${row.version}`);
    this.#manifests.set(`${row.id}@${manifest.version}`, manifest);
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
        const relative = path.join(namespace, entry).toLowerCase();
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
    this.#deps.store.delete(id);
    this.#manifests.delete(`${id}@${identity.version}`);
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
    const items: ConsentItems = { skills: [], connectors: [], mcp: [], mail: [] };
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
          const diff = diffPermissions(
            permissionTokens(oldItems.items),
            permissionTokens(inspection.items),
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
      conflicts: inspection.conflicts,
      existing: existingRow === null ? null : { version: existingRow.version },
      update,
      installable: blockers.length === 0 && inspection.conflicts.length === 0,
      blockers,
      origin: marketplace === null ? 'local' : 'marketplace',
      tier: marketplace === null ? 'developer' : marketplace.entry.tier,
    };
  }

  #summaryOf(row: PluginRow): PluginSummary {
    const identity = this.#identityOf(row);
    const items: PluginItemRef[] = [];
    const counts = { skills: 0, connectors: 0, mcp: 0, mail: 0 };
    // Connector yields come from the connectors projector (which owns the catalog view).
    const yielded = this.#yieldedSlugs();
    for (const adapter of CAPABILITY_KINDS) {
      const kind = adapter.kind;
      const refs = this.#deps.store.refs(row.id, kind);
      counts[adapter.consentKey] = refs.length;
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
    return {
      configFields: (manifest?.config?.fields ?? []).map(pluginFieldSummaryOf),
      instanceCounts: this.#deps.instanceStore?.countsOf(row.id) ?? { mail: 0, mcp: 0 },
      providesInstances: manifest?.instances ?? [],
      id: row.id,
      name: manifest?.name ?? row.id,
      version: row.version,
      description: manifest?.description ?? '',
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
