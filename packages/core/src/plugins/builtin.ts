import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_MANIFEST_FILE, type PluginManifest, type PluginSummary } from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import { parsePluginManifestText } from './manifest-loader.js';
import { pluginIconDataUri } from './icon.js';

/**
 * Builtin plugin loader (D104 P0b; marketplace conversion): reads the read-only,
 * first-party plugin trees resolved by `resolveBuiltinPluginsDir` (two-level
 * `{ns}/{name}/`). Since the marketplace conversion the app ships NO builtin
 * plugins — the tree is absent and every accessor returns empty; the mechanism
 * stays for dev/test overrides (`KEPCUP_BUILTIN_PLUGINS`) and future first-party
 * preinstalls. Builtin plugins never enter the `plugins` table and never go
 * through install / uninstall; this loader is the only accessor for
 * `ConnectorCatalog` (the packaged snapshot
 * source), plus the read-only summaries `plugins.list` shows.
 *
 * Every call re-reads the manifests (they are tiny) — this keeps the
 * "shipped-content edits are visible immediately" behaviour the old
 * the ConnectorCatalog reads had. Broken plugins warn and are skipped.
 * `assertInstallablePluginId` is deliberately NOT called (builtin plugins own the
 * reserved `com.kepcup` namespace) and `checkPluginCompatibility` is not run
 * (they ship with the app itself).
 */

/** env 覆盖 → 向上最多 8 层查找旧随包目录（商店化后不存在，仅兼容旧检出）→ null。 */
export function resolveBuiltinPluginsDir(env: NodeJS.ProcessEnv): string | null {
  const override = env.KEPCUP_BUILTIN_PLUGINS;
  if (override !== undefined && override.length > 0) {
    return existsSync(override) ? path.resolve(override) : null;
  }
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(current, 'apps', 'desktop', 'resources', 'plugins');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export interface LoadedBuiltinPlugin {
  id: string;
  dir: string;
  manifest: PluginManifest;
}

/** One skill contribution of a builtin plugin, resolved to its absolute dir. */
export interface BuiltinSkillOffer {
  /** Skill preset id: `path.basename(contribution.dir)` (presets keep `dir = skills/<id>`). */
  id: string;
  /** Owning builtin plugin id (source_url marker: `plugin://{pluginId}/{id}`). */
  pluginId: string;
  /** Absolute path of the skill folder (inside the plugin dir; the loader verified it). */
  dir: string;
  section: string;
  displayName: string;
  summary: string;
  icon: string;
  version: string;
  tryIt: string;
  vendored: boolean;
}

export class BuiltinPlugins {
  readonly #deps: { env: NodeJS.ProcessEnv; logger: Pick<CoreLogger, 'warn' | 'info'> };
  readonly #rootDir: string | null;

  constructor(deps: { env: NodeJS.ProcessEnv; logger: Pick<CoreLogger, 'warn' | 'info'> }) {
    this.#deps = deps;
    this.#rootDir = resolveBuiltinPluginsDir(deps.env);
  }

  /** Resolved builtin root, or null when absent (no builtin plugins → accessors return empty). */
  get dir(): string | null {
    return this.#rootDir;
  }

  #warn(record: Record<string, unknown>, message: string): void {
    this.#deps.logger.warn(record, message);
  }

  /**
   * Re-reads and validates every plugin dir; broken plugins warn and are skipped.
   * Two layouts: `{ns}/{name}/plugin.json` (dir name = identity, must equal the
   * manifest id) and flat `{dir}/plugin.json` (identity = the manifest id itself —
   * the marketplace-era `plugins/` development tree uses this shape).
   */
  list(): LoadedBuiltinPlugin[] {
    if (this.#rootDir === null) return [];
    let namespaces: string[];
    try {
      namespaces = readdirSync(this.#rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      this.#warn(
        { dir: this.#rootDir, error: error instanceof Error ? error.message : String(error) },
        'builtin plugins directory unreadable',
      );
      return [];
    }
    const loaded: LoadedBuiltinPlugin[] = [];
    const seen = new Set<string>();
    for (const namespace of namespaces) {
      const dir = path.join(this.#rootDir, namespace);
      if (existsSync(path.join(dir, PLUGIN_MANIFEST_FILE))) {
        // Flat layout: the manifest id is the identity.
        const manifest = this.#loadOne(dir, null);
        if (manifest === null) continue;
        if (seen.has(manifest.id)) {
          this.#warn({ id: manifest.id }, 'duplicate builtin plugin id, skipped');
          continue;
        }
        seen.add(manifest.id);
        loaded.push({ id: manifest.id, dir, manifest });
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const pluginDir = path.join(dir, name);
        const manifest = this.#loadOne(pluginDir, `${namespace}/${name}`);
        if (manifest === null) continue;
        if (seen.has(manifest.id)) {
          this.#warn({ id: manifest.id }, 'duplicate builtin plugin id, skipped');
          continue;
        }
        seen.add(manifest.id);
        loaded.push({ id: manifest.id, dir: pluginDir, manifest });
      }
    }
    return loaded;
  }

  get(id: string): LoadedBuiltinPlugin | null {
    return this.list().find((plugin) => plugin.id === id) ?? null;
  }

  #loadOne(dir: string, expectedId: string | null): PluginManifest | null {
    const file = path.join(dir, PLUGIN_MANIFEST_FILE);
    let manifest: PluginManifest;
    try {
      manifest = parsePluginManifestText(readFileSync(file, 'utf8'));
    } catch (error) {
      this.#warn(
        { file, error: error instanceof Error ? error.message : String(error) },
        'builtin plugin.json rejected',
      );
      return null;
    }
    // The two-level directory layout is the identity: `{ns}/{name}` must equal `manifest.id`
    // (flat roots identify by the manifest id itself).
    if (expectedId !== null && manifest.id !== expectedId) {
      this.#warn(
        { file, manifestId: manifest.id, expectedId },
        'builtin plugin id does not match its directory',
      );
      return null;
    }
    const problem = verifyBuiltinContributionFiles(manifest, dir);
    if (problem !== null) {
      this.#warn({ id: manifest.id, problem }, 'builtin plugin contribution files incomplete');
      return null;
    }
    return manifest;
  }

  /**
   * Skill contributions of every loaded builtin plugin (aggregated; a skill
   * preset id must be unique across plugins — later plugins warn and skip on
   * collision). Entries missing required display fields warn and skip.
   */
  skillOffers(): BuiltinSkillOffer[] {
    const offers: BuiltinSkillOffer[] = [];
    const seen = new Set<string>();
    for (const plugin of this.list()) {
      for (const contribution of plugin.manifest.contributions.skills) {
        const { displayName, summary, section, version } = contribution;
        const id = path.basename(contribution.dir);
        if (
          displayName === undefined ||
          summary === undefined ||
          section === undefined ||
          version === undefined
        ) {
          this.#warn(
            { plugin: plugin.id, dir: contribution.dir },
            'builtin skill contribution missing displayName/summary/section/version',
          );
          continue;
        }
        if (seen.has(id)) {
          this.#warn({ plugin: plugin.id, id }, 'duplicate builtin skill preset id, skipped');
          continue;
        }
        seen.add(id);
        offers.push({
          id,
          pluginId: plugin.id,
          dir: path.join(plugin.dir, ...contribution.dir.split('/')),
          section,
          displayName,
          summary,
          icon: contribution.icon ?? 'puzzle',
          version,
          tryIt: contribution.tryIt ?? '',
          vendored: contribution.vendored === true,
        });
      }
    }
    return offers;
  }

  /**
   * Connector entries of every loaded builtin plugin, shaped like the old packaged
   * catalog source (raw `server.json` objects; schema validation stays in
   * `parseConnectorEntries`). `iconPaths` = slug → icon file next to `server.json`
   * (missing files are simply not in the map).
   */
  connectorSource(): {
    entries: unknown[];
    iconsDir: string | null;
    iconPaths: ReadonlyMap<string, string>;
    /** slug → owning builtin plugin id（目录条目的 pluginId 透传，D105 插件圈定管理用）。 */
    owners: ReadonlyMap<string, string>;
  } {
    const entries: unknown[] = [];
    const iconPaths = new Map<string, string>();
    const owners = new Map<string, string>();
    for (const plugin of this.list())
      for (const contribution of plugin.manifest.contributions.connectors) {
        const file = path.join(plugin.dir, ...contribution.file.split('/'));
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(file, 'utf8'));
        } catch (error) {
          this.#warn(
            { file, error: error instanceof Error ? error.message : String(error) },
            'builtin connector server.json unreadable',
          );
          continue;
        }
        entries.push(raw);
        const meta = (raw as { _meta?: Record<string, { slug?: unknown; icon?: unknown }> })
          ._meta?.['app.kepcup/connector'];
        if (typeof meta?.slug === 'string') {
          owners.set(meta.slug, plugin.manifest.id);
          if (typeof meta.icon === 'string') {
            const iconPath = path.join(path.dirname(file), meta.icon);
            if (existsSync(iconPath)) iconPaths.set(meta.slug, iconPath);
          }
        }
      }
    return { entries, iconsDir: null, iconPaths, owners };
  }

  /** Read-only `plugins.list` entries: origin/tier = builtin, state = installed, dirPath = null. */
  summaries(): PluginSummary[] {
    return this.list().map((plugin) => {
      const { manifest } = plugin;
      return {
        id: manifest.id,
        name: manifest.name,
        iconDataUri: pluginIconDataUri(plugin.dir, manifest),
        version: manifest.version,
        description: manifest.description,
        author: manifest.author?.name ?? null,
        origin: 'builtin' as const,
        tier: 'builtin' as const,
        state: 'installed' as const,
        enabled: true,
        dirPath: null,
        marketplace: null,
        installedAt: null,
        updatedAt: null,
        counts: {
          skills: manifest.contributions.skills.length,
          connectors: manifest.contributions.connectors.length,
          mcp: manifest.contributions.mcp.length,
          mail: manifest.contributions.mail.length,
        },
        items: [],
        updateAvailable: null,
        revoked: null,
        configFields: [],
        instanceFields: [],
        instanceCounts: { mail: 0, mcp: 0 },
        providesInstances: [],
      };
    });
  }
}

/**
 * Synchronous on-disk check for the read-only builtin trees (same rules as the async
 * `verifyContributionFiles`: regular files / skill dirs with SKILL.md, no symlinks,
 * nothing resolving outside the plugin dir). Sync because the loader's readers
 * (the catalog read paths) are synchronous by contract.
 */
function verifyBuiltinContributionFiles(manifest: PluginManifest, dir: string): string | null {
  const rootReal = realpathSync(dir);
  const check = (relative: string, expect: 'file' | 'dir'): string | null => {
    const target = path.join(dir, ...relative.split('/'));
    let info;
    try {
      info = lstatSync(target);
    } catch {
      return `包内缺少贡献文件：${relative}`;
    }
    if (info.isSymbolicLink()) return `包内含符号链接，已拒绝：${relative}`;
    if (expect === 'file' && !info.isFile()) return `包内贡献不是普通文件：${relative}`;
    if (expect === 'dir' && !info.isDirectory()) return `包内技能贡献不是目录：${relative}`;
    let resolved: string;
    try {
      resolved = realpathSync(target);
    } catch {
      return `包内贡献无法解析：${relative}`;
    }
    if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
      return `包内路径越界（符号链接逃逸）：${relative}`;
    }
    return null;
  };
  for (const skill of manifest.contributions.skills) {
    const problem = check(skill.dir, 'dir') ?? check(`${skill.dir}/SKILL.md`, 'file');
    if (problem !== null) return problem;
  }
  for (const connector of manifest.contributions.connectors) {
    const problem = check(connector.file, 'file');
    if (problem !== null) return problem;
  }
  for (const contribution of manifest.contributions.mcp) {
    if (contribution.kind !== 'mcpb') continue;
    const problem = check(contribution.file, 'file');
    if (problem !== null) return problem;
  }
  return null;
}
