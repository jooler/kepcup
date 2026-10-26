import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  PLUGIN_MANIFEST_FILE,
  type McpbUserConfigValue,
  type PluginItemKind,
  type PluginConsentConnector,
  type PluginConsentMail,
  type PluginConsentMcp,
  type PluginConsentSkill,
  type PluginInspectOutput,
  type PluginItemRef,
  type PluginManifest,
  type PluginSource,
  type PluginSummary,
} from '@kepcup/shared';
import { validateUserConfig } from '../apps/mcpb/manifest.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { BuiltinPlugins } from './builtin.js';
import type { PluginRow, PluginStore } from './store.js';
import { assertInstallablePluginId, pluginDirName, pluginDirOf } from './ids.js';
import { parsePluginManifestText } from './manifest-loader.js';
import type { PluginPackager, StagedPlugin } from './package.js';
import {
  PLUGIN_PROJECTOR_ORDER,
  type PluginIdentity,
  type PluginLedger,
  type PluginProjector,
  type PluginProjectionContext,
  type ProjectedKind,
} from './projectors/index.js';

/**
 * PluginRegistry (D104 P0a-2 步骤 8): install / setEnabled / uninstall / inspect /
 * list over the ledger store and the projector set. One promise-chain mutex covers
 * every mutating operation (no timeout — a stuck install must finish, not fail);
 * install writes the ledger row BEFORE each projected item so a failure (or a crash)
 * rolls back in reverse order through the same ledger.
 */

export interface PluginRegistryDeps {
  store: PluginStore;
  packager: PluginPackager;
  /** `createPluginProjectors()` 的结果（顺序 = PLUGIN_PROJECTOR_ORDER）。 */
  projectors: readonly PluginProjector[];
  /** Builtin plugin loader (D104 P0b): read-only summaries first in `list()`, and the guard for mutating them. */
  builtin?: Pick<BuiltinPlugins, 'summaries' | 'get'> | undefined;
  pluginsDir: string;
  clock: Clock;
  logger: CoreLogger;
  events: { emit(name: 'plugins.changed', payload: { ids: string[] }): void };
  audit?: { recordSystem(action: string, detail: Record<string, unknown>): unknown } | undefined;
}

export interface PluginInstallInput {
  source: PluginSource;
  sha256: string;
  userConfig: Record<string, Record<string, McpbUserConfigValue>>;
  via: 'file' | 'folder' | 'bot';
}

interface InspectStagedResult {
  identity: PluginIdentity;
  skills: PluginConsentSkill[];
  connectors: PluginConsentConnector[];
  mcp: PluginConsentMcp[];
  mail: PluginConsentMail[];
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

export class PluginRegistry {
  readonly #deps: PluginRegistryDeps;
  #tail: Promise<void> = Promise.resolve();
  /** Manifest cache keyed by `{id}@{version}`; invalidated when the plugin goes away. */
  readonly #manifests = new Map<string, PluginManifest>();

  constructor(deps: PluginRegistryDeps) {
    this.#deps = deps;
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
      for (const projector of this.#deps.projectors) {
        if (projector.activate === undefined) continue;
        if (!this.#hasContribution(manifest, projector.kind)) continue;
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
  }

  /** Rolls back `installing` rows and finishes `uninstalling` rows from a dead process. */
  async recoverInterrupted(): Promise<number> {
    return this.#runExclusive(async () => {
      let recovered = 0;
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

  /** 已装插件清单的贡献（P1 的邮件模板 overlay 读取用）；未装 / 清单损坏 = null。 */
  async contributionsOf(id: string): Promise<PluginManifest['contributions'] | null> {
    const row = this.#deps.store.get(id);
    if (row === null) return null;
    const manifest = await this.#readManifestFromDir(this.#dirOf(row.id, row.version));
    return manifest?.contributions ?? null;
  }

  async inspect(source: PluginSource): Promise<PluginInspectOutput> {
    const staged = await this.#deps.packager.stage(source);
    try {
      return await this.#inspectStagedOutput(staged);
    } finally {
      await this.#deps.packager.discard(staged);
    }
  }

  // --- mutations ----------------------------------------------------------------

  install(input: PluginInstallInput): Promise<PluginSummary> {
    return this.#runExclusive(() => this.#installLocked(input));
  }

  async #installLocked(input: PluginInstallInput): Promise<PluginSummary> {
    const staged = await this.#deps.packager.stage(input.source);
    try {
      if (staged.packageSha256 !== input.sha256) {
        throw new AppError('PLUGIN_INVALID', '包与确认时不一致，请重新选择');
      }
      const manifest = staged.manifest;
      const { id, version } = manifest;
      // Reserved namespaces are rejected for marketplace / local installs.
      assertInstallablePluginId(id);
      if (this.#deps.store.get(id) !== null) {
        throw new AppError(
          'PLUGIN_CONFLICT',
          `已安装同 id 插件（v${this.#deps.store.get(id)!.version}），请先卸载（更新流在后续版本提供）`,
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

      const identity: PluginIdentity = { id, version, origin: 'local', tier: 'developer' };
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
        origin: 'local',
        tier: 'developer',
        state: 'installing',
        enabled: true,
        packageSha256: staged.packageSha256,
        marketplace: null,
        dir: path.relative(this.#deps.pluginsDir, finalDir),
        installedAt: now,
        updatedAt: now,
      });

      this.#manifests.set(`${id}@${version}`, manifest);
      const row = this.#deps.store.get(id)!;
      const ctx = await this.#contextFor(row, manifest, input.userConfig);
      try {
        for (const projector of this.#deps.projectors) {
          if (!this.#hasContribution(manifest, projector.kind)) continue;
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
        origin: 'local',
        tier: 'developer',
        via: input.via,
      });
      this.#deps.events.emit('plugins.changed', { ids: [id] });
      return this.#summaryOf(this.#deps.store.get(id)!);
    } finally {
      await this.#deps.packager.discard(staged);
    }
  }

  setEnabled(id: string, enabled: boolean): Promise<PluginSummary> {
    return this.#runExclusive(() => this.#setEnabledLocked(id, enabled));
  }

  async #setEnabledLocked(id: string, enabled: boolean): Promise<PluginSummary> {
    if (this.#isBuiltin(id)) {
      throw new AppError('INVALID_INPUT', '内置插件不能停用或卸载');
    }
    const row = this.#deps.store.get(id);
    if (row === null) throw new AppError('NOT_FOUND', `没有已安装的插件：${id}`);
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
    return this.#deps.projectors.find((projector) => projector.kind === kind);
  }

  #hasContribution(manifest: PluginManifest, kind: ProjectedKind): boolean {
    switch (kind) {
      case 'skill':
        return manifest.contributions.skills.length > 0;
      case 'connector':
        return manifest.contributions.connectors.length > 0;
      case 'mcp':
        return manifest.contributions.mcp.length > 0;
      case 'mail':
        return manifest.contributions.mail.length > 0;
    }
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
    };
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
   * Runs every projector's inspect for the kinds present in the manifest and merges
   * the results (shared by `inspect` and the pre-check inside `install`).
   */
  async #inspectStaged(staged: StagedPlugin): Promise<InspectStagedResult> {
    const identity: PluginIdentity = {
      id: staged.manifest.id,
      version: staged.manifest.version,
      origin: 'local',
      tier: 'developer',
    };
    const ctx: PluginProjectionContext = {
      plugin: identity,
      manifest: staged.manifest,
      dir: staged.stagingDir,
      userConfig: {},
      ledger: new NullLedger(),
    };
    const result: InspectStagedResult = {
      identity,
      skills: [],
      connectors: [],
      mcp: [],
      mail: [],
      conflicts: [],
      blockers: [],
    };
    for (const projector of this.#deps.projectors) {
      if (!this.#hasContribution(staged.manifest, projector.kind)) continue;
      const inspection = await projector.inspect(ctx);
      switch (projector.kind) {
        case 'skill':
          result.skills.push(...(inspection.items as PluginConsentSkill[]));
          break;
        case 'connector':
          result.connectors.push(...(inspection.items as PluginConsentConnector[]));
          break;
        case 'mcp':
          result.mcp.push(...(inspection.items as PluginConsentMcp[]));
          break;
        case 'mail':
          result.mail.push(...(inspection.items as PluginConsentMail[]));
          break;
      }
      result.conflicts.push(...inspection.conflicts);
      result.blockers.push(...inspection.blockers);
    }
    return result;
  }

  async #inspectStagedOutput(staged: StagedPlugin): Promise<PluginInspectOutput> {
    const inspection = await this.#inspectStaged(staged);
    const manifest = staged.manifest;
    const existingRow = this.#deps.store.get(manifest.id);
    const blockers = [...inspection.blockers];
    // Namespace gate surfaces as a blocker in the consent view (install throws PLUGIN_INVALID).
    try {
      assertInstallablePluginId(manifest.id);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    if (existingRow !== null) {
      blockers.push(
        `已安装同 id 插件（v${existingRow.version}），请先卸载（更新流在后续版本提供）`,
      );
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
      origin: 'local',
      tier: 'developer',
      packageSha256: staged.packageSha256,
      sizeBytes: staged.sizeBytes,
      skills: inspection.skills,
      connectors: inspection.connectors,
      mcp: inspection.mcp,
      mail: inspection.mail,
      conflicts: inspection.conflicts,
      existing: existingRow === null ? null : { version: existingRow.version },
      update: null,
      installable: blockers.length === 0 && inspection.conflicts.length === 0,
      blockers,
    };
  }

  static readonly #COUNT_KEYS: Record<ProjectedKind, keyof PluginSummary['counts']> = {
    skill: 'skills',
    connector: 'connectors',
    mcp: 'mcp',
    mail: 'mail',
  };

  #summaryOf(row: PluginRow): PluginSummary {
    const identity = this.#identityOf(row);
    const items: PluginItemRef[] = [];
    const counts = { skills: 0, connectors: 0, mcp: 0, mail: 0 };
    // Connector yields come from the connectors projector (which owns the catalog view).
    const yielded = this.#yieldedSlugs();
    for (const kind of ['skill', 'connector', 'mcp', 'mail'] as const) {
      const refs = this.#deps.store.refs(row.id, kind);
      counts[PluginRegistry.#COUNT_KEYS[kind]] = refs.length;
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
      updateAvailable: null,
    };
  }

  /** The connectors projector's yield set, reached structurally (no catalog dependency). */
  #yieldedSlugs(): ReadonlySet<string> {
    const connectors = this.#deps.projectors.find(
      (projector): projector is PluginProjector & { yieldedSlugs(): ReadonlySet<string> } =>
        projector.kind === 'connector' && 'yieldedSlugs' in projector,
    );
    return connectors?.yieldedSlugs() ?? new Set<string>();
  }
}
