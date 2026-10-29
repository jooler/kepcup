import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  type ConnectorCatalogEntry,
  type McpbInspectOutput,
  type McpbUserConfigField,
  type McpbUserConfigValue,
  type McpServer,
  type McpServerSource,
  type Settings,
} from '@kepcup/shared';
import type { CoreLogger } from '../../infra/logger.js';
import {
  checkCompatibility,
  formatLaunch,
  manifestAuthor,
  MCPB_NAME_PATTERN,
  MCPB_VERSION_PATTERN,
  manifestDisplayName,
  manifestFields,
  parseMcpbManifest,
  renderLaunch,
  validateUserConfig,
  type McpbManifest,
} from './manifest.js';
import { MCPB_MAX_FILE_BYTES, safeEntryPath, ZipArchive } from './zip.js';

/**
 * MCPB local bundle installer (D73 P2, todo/connected-apps.md §6.5).
 *
 * A `.mcpb` is a ZIP with `manifest.json`. Installing it means: verify (sha256 the user
 * saw, manifest, compatibility, zip-slip / symlink / size caps), extract into
 * `{toolchainsDir}/mcpb/{name}@{version}/`, store `sensitive` user_config values as
 * secrets `mcp:{serverId}:env:{KEY}` and create a custom stdio server in
 * `settings.mcpServers` that references them with `secret:env:{KEY}` placeholders.
 * Runtimes (node / python / uv) come from the environment manager — nothing is
 * downloaded here; a missing runtime is a readable `MCPB_RUNTIME_MISSING`.
 */

export const MCPB_MARKER_FILE = '.kepcup-mcpb.json';
const MANIFEST_MAX_BYTES = 1024 * 1024;

/**
 * In-memory stand-in for a sensitive value this update left empty (D104 P1-2 replace mode):
 * lets validation / launch rendering produce the `secret:env:{KEY}` placeholder while the
 * stored secret stays untouched. Tracked by field key, never persisted.
 */
const KEPT_SECRET_PLACEHOLDER = '\u0000kept';

/** Package identity used for reference counting (`toolchains/mcpb/{name}@{version}` slots). */
export interface McpbPackageRef {
  name: string;
  version: string;
  sha256: string;
}

/**
 * Normalizes any server source into the package it references: `kind: 'mcpb'` is the
 * source itself; `kind: 'plugin'` contributes its embedded `mcpb` (null without one);
 * anything else references no package.
 */
export function mcpbPackageOf(source: McpServerSource | undefined): McpbPackageRef | null {
  if (source === undefined) return null;
  if (source.kind === 'mcpb')
    return { name: source.name, version: source.version, sha256: source.sha256 };
  if (source.kind === 'plugin') return source.mcpb ?? null;
  return null;
}

/**
 * Caller-specified registration (D104 plugin projector): lets the plugin pipeline
 * install a bundle under a deterministic server id with a plugin-shaped source and
 * tier, instead of the random `mcpb_{hex}` / `{kind:'mcpb'}` defaults.
 */
export interface McpbRegistration {
  /** Overrides the random `mcpb_{hex}` id. */
  serverId: string;
  /** Overrides the `{kind:'mcpb', …}` source. */
  source: McpServerSource;
  /** Overrides the default tier (non-catalog installs default to `'developer'`). */
  tier: 'developer' | undefined;
  /** Overrides `server.name` (default: the inspection display name). */
  name?: string | undefined;
  /** Written into `server.description`. */
  description?: string | undefined;
  /**
   * Plugin update mode (D104 P1-2): the server must already exist (same id, plugin source,
   * same pluginId) and is replaced in place — `enabled` / `toolPolicies` are preserved,
   * `autoApprove` is forced to false and untouched sensitive user_config keeps its stored
   * secret. The old package tree is NOT released here (a failed update may still roll back
   * into it); the registry releases it via {@link McpbInstaller.releaseIfUnused} after commit.
   */
  replaceExisting?: boolean | undefined;
}

export type McpbRuntimeKind = 'node' | 'python' | 'uv';
export interface McpbRuntimeResolution {
  /** Absolute executable path of the managed runtime. */
  command: string;
  version: string | null;
}

/** Who asks for the approval card (an installation triggered from a conversation). */
export interface McpbApprovalContext {
  conversationId: string;
  botId?: string | null;
}

export interface McpbInstallerDeps {
  paths: { toolchainsDir: string };
  settings: { get(): Settings; update(patch: Partial<Settings>): Settings };
  secrets: {
    setValue(name: string, value: string): void;
    removeByPrefix(prefix: string): string[];
    /**
     * Replace mode (D104 P1-2) consults this to keep stored secrets for sensitive
     * fields the update left empty. Optional: absent means "never treat as kept".
     */
    hasValue?(name: string): boolean;
  };
  logger: CoreLogger;
  /** Managed runtime lookup (environment manager); null = not installed. */
  resolveRuntime(kind: McpbRuntimeKind): McpbRuntimeResolution | null;
  /** Approval card (`environment` kind). Resolves true when approved. */
  requestApproval?: (
    context: McpbApprovalContext,
    payload: Record<string, unknown>,
  ) => Promise<boolean>;
  /** Drops a cached MCP connection before its files are removed. */
  closeServer?: (serverId: string) => Promise<void>;
  /** Audit sink (`audit_log`): install / uninstall records, never secrets. */
  audit?: { recordSystem(action: string, detail: Record<string, unknown>): unknown };
  /** Connector catalog lookup for `fromCatalog` installs. */
  catalogEntry?: (slug: string) => ConnectorCatalogEntry | null;
  homeDir: string;
  platform?: string;
  arch?: string;
}

export interface McpbInstallRequest {
  filePath: string;
  /** sha256 the user confirmed (from {@link McpbInstaller.inspect}). */
  sha256: string;
  userConfig?: Record<string, McpbUserConfigValue>;
  approvalContext?: McpbApprovalContext | undefined;
  fromCatalog?: { slug: string } | undefined;
  /**
   * Plugin pipeline registration (D104): fixed server id, plugin-shaped source and
   * overridden tier / name / description. Absent for the standalone `mcpb.install`
   * path, whose behaviour is unchanged.
   */
  register?: McpbRegistration | undefined;
}

export interface McpbInspection extends McpbInspectOutput {
  manifest: McpbManifest;
}

const RUNTIME_COMMANDS: Record<McpbRuntimeKind, readonly string[]> = {
  node: ['node'],
  python: ['python', 'python3'],
  uv: ['uv'],
};

function runtimeOf(manifest: McpbManifest): McpbRuntimeKind | null {
  const type = manifest.server.type;
  return type === 'node' || type === 'python' || type === 'uv' ? type : null;
}

function invalid(message: string): AppError {
  return new AppError('MCPB_INVALID', message);
}

/** A private copy of the chosen file: every later step reads this, never the user's path. */
interface Snapshot {
  path: string;
  sha256: string;
  size: number;
}

/** Lower-cased: `Foo@1` and `foo@1` must be one slot on case-insensitive file systems. */
export function mcpbPackageDirName(name: string, version: string): string {
  return `${name}@${version}`.toLowerCase();
}

function sameSlot(
  a: { name: string; version: string },
  b: { name: string; version: string },
): boolean {
  return mcpbPackageDirName(a.name, a.version) === mcpbPackageDirName(b.name, b.version);
}

export class McpbInstaller {
  readonly #deps: McpbInstallerDeps;

  constructor(deps: McpbInstallerDeps) {
    this.#deps = deps;
  }

  get #platform(): string {
    return this.#deps.platform ?? process.platform;
  }

  get root(): string {
    return path.join(this.#deps.paths.toolchainsDir, 'mcpb');
  }

  installDirOf(name: string, version: string): string {
    const root = path.resolve(this.root);
    const dir = path.resolve(root, mcpbPackageDirName(name, version));
    // Defence in depth: name / version come from a manifest or from stored settings.
    if (
      !MCPB_NAME_PATTERN.test(name) ||
      !MCPB_VERSION_PATTERN.test(version) ||
      !dir.startsWith(root + path.sep) ||
      path.dirname(dir) !== root ||
      path.basename(dir) !== mcpbPackageDirName(name, version)
    ) {
      throw invalid(`安装目录越界：${name}@${version}`);
    }
    return dir;
  }

  /**
   * Copies the file once into a private temp file (mode 0600, inside the mcpb root) while
   * hashing the same bytes, enforcing the size cap before and during the copy. The returned
   * copy is what gets inspected / extracted; `fn` runs against it and it is deleted afterwards.
   */
  async #withSnapshot<T>(filePath: string, fn: (snapshot: Snapshot) => Promise<T>): Promise<T> {
    if (!path.isAbsolute(filePath)) throw invalid('请提供 .mcpb 文件的绝对路径');
    let info;
    try {
      info = await stat(filePath);
    } catch {
      throw new AppError('NOT_FOUND', `找不到文件：${filePath}`);
    }
    if (!info.isFile()) throw invalid('所选路径不是文件');
    if (info.size > MCPB_MAX_FILE_BYTES) throw invalid('包文件过大');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const copy = path.join(this.root, `.snap-${randomBytes(8).toString('hex')}.mcpb`);
    const hash = createHash('sha256');
    let size = 0;
    const out = await open(copy, 'wx', 0o600);
    try {
      for await (const chunk of createReadStream(filePath)) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MCPB_MAX_FILE_BYTES) throw invalid('包文件过大');
        hash.update(buffer);
        await out.write(buffer);
      }
    } catch (error) {
      await out.close();
      await rm(copy, { force: true });
      throw error;
    }
    await out.close();
    try {
      return await fn({ path: copy, sha256: hash.digest('hex'), size });
    } finally {
      await rm(copy, { force: true });
    }
  }

  // --- inspect -------------------------------------------------------------

  async inspect(filePath: string): Promise<McpbInspection> {
    return this.#withSnapshot(filePath, (snapshot) => this.#inspectSnapshot(snapshot));
  }

  async #inspectSnapshot({ path: filePath, sha256, size }: Snapshot): Promise<McpbInspection> {
    const zip = await ZipArchive.open(filePath);
    try {
      const names = new Set<string>();
      for (const entry of zip.entries) {
        const safe = safeEntryPath(entry.name);
        if (entry.isSymlink) throw invalid(`包内含符号链接，已拒绝：${entry.name}`);
        const key = safe.toLowerCase();
        if (names.has(key)) throw invalid(`包内有重复路径：${entry.name}`);
        names.add(key);
        if (safe === MCPB_MARKER_FILE) throw invalid(`包内含保留文件名：${MCPB_MARKER_FILE}`);
      }
      const manifestEntry = zip.entries.find((entry) => entry.name === 'manifest.json');
      if (manifestEntry === undefined) throw invalid('包里没有 manifest.json（不是 .mcpb 文件？）');
      if (manifestEntry.size > MANIFEST_MAX_BYTES) throw invalid('manifest.json 过大');
      const manifest = parseMcpbManifest((await zip.read(manifestEntry)).toString('utf8'));
      const type = manifest.server.type;
      if (type !== 'uv') {
        const entryPoint = manifest.server.entry_point;
        let normalized: string;
        try {
          normalized = safeEntryPath(entryPoint.replace(/^\.\//, ''));
        } catch {
          throw invalid(`server.entry_point 路径不安全：${entryPoint}`);
        }
        if (!names.has(normalized.toLowerCase())) {
          throw invalid(`server.entry_point 指向的文件不在包内：${entryPoint}`);
        }
      }
      const runtimeKind = runtimeOf(manifest);
      const resolution = runtimeKind === null ? null : this.#deps.resolveRuntime(runtimeKind);
      const compat = checkCompatibility(manifest, {
        platform: this.#platform,
        arch: this.#deps.arch ?? process.arch,
        runtimes: {
          node: runtimeKind === 'node' ? (resolution?.version ?? undefined) : undefined,
          python: runtimeKind === 'python' ? (resolution?.version ?? undefined) : undefined,
        },
      });
      const dir = this.installDirOf(manifest.name, manifest.version);
      const launch = renderLaunch(manifest, {
        dir,
        home: this.#deps.homeDir,
        platform: this.#platform,
        mode: 'preview',
        commandOverride: this.#commandOverride(manifest, resolution),
      });
      return {
        manifest,
        name: manifest.name,
        displayName: manifestDisplayName(manifest),
        version: manifest.version,
        description: manifest.description ?? '',
        author: manifestAuthor(manifest),
        serverType: (MCPB_TYPES.has(type) ? type : 'binary') as McpbInspectOutput['serverType'],
        sha256,
        size,
        unpackedSize: zip.unpackedSize,
        launchCommand: formatLaunch(launch),
        installDir: dir,
        compatible: compat.ok,
        ...(compat.ok ? {} : { incompatibleReason: compat.reason }),
        runtime:
          runtimeKind === null ? null : { kind: runtimeKind, available: resolution !== null },
        userConfigFields: manifestFields(manifest),
      };
    } finally {
      await zip.close();
    }
  }

  /** The managed runtime's path when `mcp_config.command` names the runtime itself. */
  #commandOverride(
    manifest: McpbManifest,
    resolution: McpbRuntimeResolution | null,
  ): string | undefined {
    const kind = runtimeOf(manifest);
    if (kind === null || resolution === null) return undefined;
    const config = manifest.server.mcp_config;
    const command =
      config?.platform_overrides?.[this.#platform]?.command ?? config?.command ?? kind;
    return RUNTIME_COMMANDS[kind].includes(command) ? resolution.command : undefined;
  }

  // --- install -------------------------------------------------------------

  async install(input: McpbInstallRequest): Promise<{ serverId: string }> {
    return this.#withSnapshot(input.filePath, (snapshot) => this.#installSnapshot(input, snapshot));
  }

  async #installSnapshot(
    input: McpbInstallRequest,
    snapshot: Snapshot,
  ): Promise<{ serverId: string }> {
    const inspection = await this.#inspectSnapshot(snapshot);
    if (inspection.sha256 !== input.sha256) {
      throw invalid('包文件与确认时不一致（sha256 不符），请重新选择文件');
    }
    if (!inspection.compatible) {
      throw new AppError(
        'MCPB_INCOMPATIBLE',
        inspection.incompatibleReason ?? '此包与当前环境不兼容',
      );
    }
    if (input.fromCatalog !== undefined) this.#checkCatalog(input.fromCatalog.slug, inspection);

    const manifest = inspection.manifest;
    const fields = inspection.userConfigFields;
    for (const field of fields) {
      if (field.sensitive && field.multiple) {
        throw invalid(`敏感配置项 ${field.key} 不能是多值`);
      }
    }

    // Replace mode (D104 P1-2 plugin update): the target must exist, be plugin-sourced and
    // belong to the same plugin — otherwise NOT_FOUND (this path never reports ALREADY_EXISTS).
    const replacing =
      input.register?.replaceExisting === true
        ? this.#existingPluginServerFor(input.register)
        : null;
    // Sensitive fields the update left empty keep the stored secret: validate against an
    // in-memory placeholder (only so `validateUserConfig` / `renderLaunch` see a value and
    // emit the `secret:env:{KEY}` placeholder); it is never persisted — see the write loop.
    const kept = new Set<string>(
      replacing === null ? [] : this.#keptSecretKeys(fields, input.userConfig ?? {}, replacing.id),
    );
    const provided: Record<string, McpbUserConfigValue> = { ...(input.userConfig ?? {}) };
    for (const key of kept) provided[key] = KEPT_SECRET_PLACEHOLDER;
    const values = validateUserConfig(fields, provided);

    // Fresh registration: fail before any extraction when the caller-specified id is taken.
    if (input.register !== undefined && replacing === null) {
      const taken = this.#deps.settings
        .get()
        .mcpServers.some((server) => server.id === input.register!.serverId);
      if (taken) {
        throw new AppError('ALREADY_EXISTS', `MCP 服务器 ID 已存在：${input.register.serverId}`);
      }
    }

    const runtimeKind = runtimeOf(manifest);
    const resolution = runtimeKind === null ? null : this.#deps.resolveRuntime(runtimeKind);
    if (runtimeKind !== null && resolution === null) {
      throw new AppError(
        'MCPB_RUNTIME_MISSING',
        `此包需要 ${runtimeLabel(runtimeKind)} 运行时，环境管理器里尚未安装。请先在「设置 → 环境」安装后重试。`,
      );
    }
    const dir = inspection.installDir;
    const spec = renderLaunch(manifest, {
      dir,
      home: this.#deps.homeDir,
      platform: this.#platform,
      mode: 'install',
      values,
      commandOverride: this.#commandOverride(manifest, resolution),
    });

    const conflicts = this.#findSlotConflicts(manifest.name, manifest.version, inspection.sha256)
      // The server being replaced holds its own slot (possibly the same name@version with
      // different content); anything else occupying the slot still conflicts.
      .filter((conflict) => conflict.serverId !== replacing?.id);
    if (conflicts.length > 0) {
      throw invalid(
        `已安装同名同版本（${manifest.name}@${manifest.version}）但内容不同的包，请先卸载再安装`,
      );
    }

    // Replace mode with a same-slot (same name@version) but different-content old package:
    // extraction below would delete the old tree, which a failed update's rollback still
    // needs at this exact path. Park the intact old tree beside the slot; the projector
    // restores it via `restoreRollbackBackup` or discards it via `discardRollbackBackups`.
    if (replacing !== null) {
      const oldPkg = mcpbPackageOf(replacing.source);
      if (
        oldPkg !== null &&
        sameSlot(oldPkg, { name: manifest.name, version: manifest.version }) &&
        oldPkg.sha256 !== inspection.sha256
      ) {
        await this.#parkReplacedTree(
          { name: manifest.name, version: manifest.version },
          oldPkg.sha256,
        );
      }
    }

    if (input.approvalContext !== undefined) {
      if (this.#deps.requestApproval === undefined) {
        throw new AppError('NOT_IMPLEMENTED', '审批服务未就绪');
      }
      const sensitiveKeys = new Set(fields.filter((f) => f.sensitive).map((f) => f.key));
      const command = formatLaunch(spec, sensitiveKeys);
      const approved = await this.#deps.requestApproval(input.approvalContext, {
        item: `mcpb:${manifest.name}`,
        version: manifest.version,
        displayName: inspection.displayName,
        sizeBytes: inspection.size,
        source: input.filePath,
        obtain: 'archive',
        reason: `将在本机以此命令启动该本地包（来源未经审核）：${command}；sha256：${inspection.sha256}；解包到：${dir}`,
      });
      if (!approved) throw new AppError('APPROVAL_DENIED', '已拒绝安装该 MCPB 包');
    }

    const extracted = await this.#extract(snapshot.path, manifest, inspection.sha256);
    const serverId = input.register?.serverId ?? `mcpb_${randomBytes(6).toString('hex')}`;
    const source: McpServerSource = input.register?.source ?? {
      kind: 'mcpb',
      name: manifest.name,
      version: manifest.version,
      sha256: inspection.sha256,
    };
    const server: McpServer = {
      id: serverId,
      name: input.register?.name ?? inspection.displayName,
      transport: 'stdio',
      command: spec.command,
      args: spec.args,
      ...(Object.keys(spec.env).length > 0 ? { env: spec.env } : {}),
      ...(input.register?.description !== undefined
        ? { description: input.register.description }
        : {}),
      enabled: replacing !== null ? replacing.enabled : true,
      autoApprove: false,
      auth: 'none',
      source,
      ...(input.register !== undefined
        ? input.register.tier !== undefined
          ? { tier: input.register.tier }
          : {}
        : input.fromCatalog === undefined
          ? { tier: 'developer' as const }
          : {}),
    };
    // Replace mode preserves the user's per-tool policies (only the bundle changes).
    if (replacing?.toolPolicies !== undefined) server.toolPolicies = replacing.toolPolicies;
    try {
      for (const field of fields) {
        const value = values[field.key];
        if (!field.sensitive || value === undefined) continue;
        if (kept.has(field.key)) continue; // in-memory placeholder — the stored secret stays
        this.#deps.secrets.setValue(`mcp:${serverId}:env:${field.key}`, String(value));
      }
      const current = this.#deps.settings.get();
      this.#deps.settings.update({
        // Replace mode swaps the entry in place (array order and position unchanged).
        mcpServers:
          replacing !== null
            ? current.mcpServers.map((entry) => (entry.id === serverId ? server : entry))
            : [...current.mcpServers, server],
      });
    } catch (error) {
      // Replace mode must never wipe the stored secrets (kept fields were not rewritten and
      // the old values stay authoritative for the rolled-back server).
      if (replacing === null) this.#deps.secrets.removeByPrefix(`mcp:${serverId}:`);
      if (extracted.created) await rm(dir, { recursive: true, force: true });
      throw error;
    }
    this.#deps.logger.info(
      { serverId, name: manifest.name, version: manifest.version, sha256: inspection.sha256 },
      'mcpb package installed',
    );
    this.#audit(
      'mcpb_install',
      serverId,
      { name: manifest.name, version: manifest.version, sha256: inspection.sha256 },
      input.fromCatalog === undefined ? 'developer' : 'catalog',
      replacing !== null ? { replaced: true } : undefined,
    );
    return { serverId };
  }

  /**
   * Servers occupying the same `name@version` package slot with different content.
   * Counts every source kind that references an MCPB package (`mcpbPackageOf`), so a
   * plugin-registered server also holds its slot. Shared by the install-time rejection
   * and the registry's pre-check ({@link slotConflict}).
   */
  #findSlotConflicts(name: string, version: string, sha256: string): Array<{ serverId: string }> {
    return this.#deps.settings
      .get()
      .mcpServers.filter((server) => {
        const pkg = mcpbPackageOf(server.source);
        return pkg !== null && sameSlot(pkg, { name, version }) && pkg.sha256 !== sha256;
      })
      .map((server) => ({ serverId: server.id }));
  }

  /** Public pre-check for the plugin registry: an occupied slot with different content. */
  slotConflict(name: string, version: string, sha256: string): { serverId: string } | null {
    return this.#findSlotConflicts(name, version, sha256)[0] ?? null;
  }

  #checkCatalog(slug: string, inspection: McpbInspection): void {
    const entry = this.#deps.catalogEntry?.(slug) ?? null;
    if (entry === null) throw new AppError('NOT_FOUND', `目录里没有条目：${slug}`);
    const packages = entry.packages.filter((pkg) => pkg.registryType === 'mcpb');
    if (packages.length === 0) throw invalid(`目录条目 ${slug} 没有 MCPB 包`);
    const pinned = packages.filter((pkg) => pkg.fileSha256 !== undefined);
    if (pinned.length === 0 || !pinned.some((pkg) => pkg.fileSha256 === inspection.sha256)) {
      throw invalid('包文件与目录登记的 sha256 不符');
    }
  }

  async #extract(
    filePath: string,
    manifest: McpbManifest,
    sha256: string,
  ): Promise<{ created: boolean }> {
    const root = this.root;
    await mkdir(root, { recursive: true });
    const finalDir = this.installDirOf(manifest.name, manifest.version);
    const staging = path.join(root, `.staging-${randomBytes(6).toString('hex')}`);
    const zip = await ZipArchive.open(filePath);
    try {
      await mkdir(staging, { recursive: true });
      const treeEntries: string[] = [];
      let files = 0;
      for (const entry of zip.entries) {
        const relative = safeEntryPath(entry.name);
        const target = path.resolve(staging, ...relative.split('/'));
        if (!target.startsWith(staging + path.sep)) throw invalid(`包内路径越界：${entry.name}`);
        if (entry.isDirectory) {
          await mkdir(target, { recursive: true });
          continue;
        }
        const data = await zip.read(entry);
        await mkdir(path.dirname(target), { recursive: true });
        // Never group/world-writable: only the executable bit of the archive is honoured.
        const mode = (entry.unixMode & 0o111) !== 0 ? 0o755 : 0o644;
        await writeFile(target, data, { mode });
        treeEntries.push(`${relative}\0${createHash('sha256').update(data).digest('hex')}`);
        files += 1;
      }
      if (manifest.server.type === 'binary' && this.#platform !== 'win32') {
        const entryPoint = safeEntryPath(manifest.server.entry_point.replace(/^\.\//, ''));
        await chmod(path.join(staging, ...entryPoint.split('/')), 0o755);
      }
      await writeFile(
        path.join(staging, MCPB_MARKER_FILE),
        JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          sha256,
          treeHash: treeHashOf(treeEntries),
          files,
        }),
      );
      const existing = await readMarker(finalDir);
      if (
        existing !== null &&
        existing.sha256 === sha256 &&
        (
          await this.verify({
            kind: 'mcpb',
            name: manifest.name,
            version: manifest.version,
            sha256,
          })
        ).ok
      ) {
        // Same bundle already installed and its tree still matches the marker: reuse it.
        await rm(staging, { recursive: true, force: true });
        return { created: false };
      }
      await rm(finalDir, { recursive: true, force: true });
      await rename(staging, finalDir);
      return { created: true };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    } finally {
      await zip.close();
    }
  }

  // --- verify / uninstall ----------------------------------------------------

  /** Re-hashes the extracted tree against the marker written at install time. */
  async verify(
    source: McpbPackageRef | McpServerSource,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Normalize first: a full server source counts only when it references a package.
    const pkg = 'kind' in source ? mcpbPackageOf(source) : source;
    if (pkg === null) return { ok: false, reason: '该来源不引用 MCPB 包' };
    const dir = this.installDirOf(pkg.name, pkg.version);
    const marker = await readMarker(dir);
    if (marker === null) return { ok: false, reason: '安装目录缺失或标记文件损坏' };
    if (marker.sha256 !== pkg.sha256) return { ok: false, reason: '安装目录与记录的包不一致' };
    const entries: string[] = [];
    await walkFiles(dir, '', async (relative, absolute) => {
      if (relative === MCPB_MARKER_FILE) return;
      const data = await readFile(absolute);
      entries.push(`${relative}\0${createHash('sha256').update(data).digest('hex')}`);
    });
    return treeHashOf(entries) === marker.treeHash
      ? { ok: true }
      : { ok: false, reason: '安装目录内容与安装时的哈希不符（文件被改动）' };
  }

  /** Removes the server entry, its secrets and (when unused) the extracted directory. */
  async uninstall(serverId: string): Promise<boolean> {
    const current = this.#deps.settings.get();
    const server = current.mcpServers.find((entry) => entry.id === serverId);
    if (server === undefined || server.source?.kind !== 'mcpb') return false;
    await this.#deps.closeServer?.(serverId);
    this.#deps.settings.update({
      mcpServers: current.mcpServers.filter((entry) => entry.id !== serverId),
    });
    this.#deps.secrets.removeByPrefix(`mcp:${serverId}:`);
    await this.releaseIfUnused(server.source);
    this.#audit('mcpb_uninstall', serverId, server.source, server.tier ?? 'catalog');
    return true;
  }

  /**
   * `mcp.removeServer` / settings-replacement hook: the settings entry is already gone (and
   * the generic path removed the secrets); drop the extracted directory when no other server
   * (of either source kind — `mcpbPackageOf` counts both) uses the package.
   */
  async afterServerRemoved(previous: readonly McpServer[], serverId: string): Promise<void> {
    const removed = previous.find((server) => server.id === serverId);
    const pkg = mcpbPackageOf(removed?.source);
    if (pkg === null) return;
    await this.#deps.closeServer?.(serverId);
    await this.releaseIfUnused(pkg);
    this.#audit('mcpb_uninstall', serverId, pkg, removed?.tier ?? 'catalog');
  }

  /** Audit details: package identity and tier only — never user_config values. */
  #audit(
    action: string,
    serverId: string,
    source: McpbPackageRef,
    tier: string,
    extra?: Record<string, unknown>,
  ): void {
    try {
      this.#deps.audit?.recordSystem(action, {
        serverId,
        name: source.name,
        version: source.version,
        sha256: source.sha256,
        tier,
        ...extra,
      });
    } catch (error) {
      this.#deps.logger.warn({ err: error, action }, 'mcpb audit write failed');
    }
  }

  /**
   * Releases the extracted tree of `pkg` when no server references the package any more
   * (D104 P1-2 made this public: the plugin registry calls it in `commitUpdate` for the
   * OLD package after the update committed). Behaviour unchanged from the private helper:
   * reference-counted via `mcpbPackageOf`, and only a directory this installer created for
   * exactly this package (marker check) is ever removed.
   */
  async releaseIfUnused(pkg: McpbPackageRef): Promise<void> {
    const stillUsed = this.#deps.settings.get().mcpServers.some((server) => {
      const used = mcpbPackageOf(server.source);
      return used !== null && sameSlot(used, pkg);
    });
    if (stillUsed) return;
    let dir: string;
    try {
      dir = this.installDirOf(pkg.name, pkg.version);
    } catch {
      return;
    }
    // Only ever delete a directory this installer created for exactly this package.
    const marker = await readMarker(dir);
    if (marker === null || marker.sha256 !== pkg.sha256 || !sameSlot(marker, pkg)) {
      this.#deps.logger.warn(
        { name: pkg.name, version: pkg.version },
        'mcpb dir not removed: marker mismatch',
      );
      return;
    }
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * Renames the extracted tree of `slot` (only when it is the intact tree of
   * `expectedSha256` per its marker) to a sibling `{slot}.rb-{hex}` backup. A no-op when
   * the tree is missing or its content no longer matches (nothing restorable would be
   * lost by a later overwrite).
   */
  async #parkReplacedTree(
    slot: { name: string; version: string },
    expectedSha256: string,
  ): Promise<void> {
    let dir: string;
    try {
      dir = this.installDirOf(slot.name, slot.version);
    } catch {
      return;
    }
    const marker = await readMarker(dir);
    if (marker === null || marker.sha256 !== expectedSha256) return;
    const backupDir = path.join(
      path.dirname(dir),
      `${path.basename(dir)}.rb-${randomBytes(4).toString('hex')}`,
    );
    await rename(dir, backupDir);
  }

  /**
   * Rollback support for same-slot replaces (D104 P1-2): makes sure the extracted tree of
   * `pkg` holds `pkg`'s content again. An intact tree is left alone; otherwise a parked
   * `{slot}.rb-{hex}` sibling whose marker matches `pkg` is swapped back in. True when the
   * slot now holds `pkg`'s tree.
   */
  async restoreRollbackBackup(pkg: McpbPackageRef): Promise<boolean> {
    let dir: string;
    try {
      dir = this.installDirOf(pkg.name, pkg.version);
    } catch {
      return false;
    }
    const marker = await readMarker(dir);
    if (marker !== null && marker.sha256 === pkg.sha256) return true;
    const parent = path.dirname(dir);
    const prefix = `${path.basename(dir)}.rb-`;
    for (const entry of await readdir(parent).catch(() => [] as string[])) {
      if (!entry.startsWith(prefix)) continue;
      const backup = path.join(parent, entry);
      const backupMarker = await readMarker(backup);
      if (backupMarker === null || backupMarker.sha256 !== pkg.sha256) continue;
      await rm(dir, { recursive: true, force: true });
      await rename(backup, dir);
      return true;
    }
    return false;
  }

  /**
   * Post-commit GC for same-slot replace backups: removes every parked `{slot}.rb-{hex}`
   * sibling of `pkg`'s slot whose marker matches `pkg` (the update committed, so the old
   * tree will never be needed again).
   */
  async discardRollbackBackups(pkg: McpbPackageRef): Promise<void> {
    let dir: string;
    try {
      dir = this.installDirOf(pkg.name, pkg.version);
    } catch {
      return;
    }
    const parent = path.dirname(dir);
    const prefix = `${path.basename(dir)}.rb-`;
    for (const entry of await readdir(parent).catch(() => [] as string[])) {
      if (!entry.startsWith(prefix)) continue;
      const backup = path.join(parent, entry);
      const backupMarker = await readMarker(backup);
      if (backupMarker === null || backupMarker.sha256 !== pkg.sha256) continue;
      await rm(backup, { recursive: true, force: true });
    }
  }

  /** The existing plugin server a replace-mode registration targets, or a NOT_FOUND throw. */
  #existingPluginServerFor(register: McpbRegistration): McpServer {
    const existing = this.#deps.settings
      .get()
      .mcpServers.find((server) => server.id === register.serverId);
    const source = existing?.source;
    const expected = register.source.kind === 'plugin' ? register.source.pluginId : undefined;
    if (
      existing === undefined ||
      source?.kind !== 'plugin' ||
      expected === undefined ||
      source.pluginId !== expected
    ) {
      throw new AppError('NOT_FOUND', `没有可替换的插件 MCP 服务器：${register.serverId}`);
    }
    return existing;
  }

  /** Sensitive keys left empty in this update whose stored secret should survive it. */
  #keptSecretKeys(
    fields: readonly McpbUserConfigField[],
    provided: Record<string, McpbUserConfigValue>,
    serverId: string,
  ): string[] {
    const kept: string[] = [];
    for (const field of fields) {
      if (!field.sensitive) continue;
      const value = provided[field.key];
      const empty =
        value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
      if (!empty) continue;
      if (this.#deps.secrets.hasValue?.(`mcp:${serverId}:env:${field.key}`) === true) {
        kept.push(field.key);
      }
    }
    return kept;
  }
}

const MCPB_TYPES = new Set(['node', 'python', 'binary', 'uv']);

function runtimeLabel(kind: McpbRuntimeKind): string {
  return kind === 'node' ? 'Node.js' : kind === 'python' ? 'Python' : 'uv';
}

function treeHashOf(entries: string[]): string {
  return createHash('sha256')
    .update([...entries].sort().join('\n'))
    .digest('hex');
}

interface Marker {
  name: string;
  version: string;
  sha256: string;
  treeHash: string;
  files: number;
}

async function readMarker(dir: string): Promise<Marker | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, MCPB_MARKER_FILE), 'utf8')) as Marker;
    return typeof parsed.sha256 === 'string' && typeof parsed.treeHash === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

async function walkFiles(
  root: string,
  relative: string,
  visit: (relative: string, absolute: string) => Promise<void>,
): Promise<void> {
  const dir = path.join(root, relative);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) await walkFiles(root, rel, visit);
    else if (entry.isFile()) await visit(rel, path.join(root, rel));
  }
}
