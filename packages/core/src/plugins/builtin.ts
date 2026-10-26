import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_MANIFEST_FILE, type PluginManifest, type PluginSummary } from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import { parsePluginManifestText } from './manifest-loader.js';

/**
 * Builtin plugin loader (D104 P0b): reads the read-only, first-party plugin trees
 * shipped under `apps/desktop/resources/plugins/{ns}/{name}/` (no version suffix —
 * they release with the app). Builtin plugins never enter the `plugins` table and
 * never go through install / uninstall; this loader is the only accessor for
 * `SkillPresetsService` (skill offers) and `ConnectorCatalog` (the packaged snapshot
 * source), plus the read-only summaries `plugins.list` shows.
 *
 * Every call re-reads the manifests (they are tiny) — this keeps the
 * "shipped-content edits are visible immediately" behaviour the old
 * `SkillPresetsService` catalog reads had. Broken plugins warn and are skipped.
 * `assertInstallablePluginId` is deliberately NOT called (builtin plugins own the
 * reserved `com.kepcup` namespace) and `checkPluginCompatibility` is not run
 * (they ship with the app itself).
 */

/** env 覆盖 → 向上最多 8 层查找 `apps/desktop/resources/plugins` → null（照 resolveBundledBinDir 的写法）。 */
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

/** One skill contribution of the builtin starter-skills plugin, resolved to its absolute dir. */
export interface BuiltinSkillOffer {
  /** Skill preset id: `path.basename(contribution.dir)` (presets keep `dir = skills/<id>`). */
  id: string;
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

/** The builtin ids the skill / connector accessors read from (design 51 §12). */
const SKILLS_PLUGIN_ID = 'com.kepcup/starter-skills';
const CONNECTORS_PLUGIN_ID = 'com.kepcup/connections';

export class BuiltinPlugins {
  readonly #deps: { env: NodeJS.ProcessEnv; logger: Pick<CoreLogger, 'warn' | 'info'> };
  readonly #rootDir: string | null;

  constructor(deps: { env: NodeJS.ProcessEnv; logger: Pick<CoreLogger, 'warn' | 'info'> }) {
    this.#deps = deps;
    this.#rootDir = resolveBuiltinPluginsDir(deps.env);
  }

  /** Resolved builtin root (`resources/plugins`), or null when absent (marketplace lists nothing). */
  get dir(): string | null {
    return this.#rootDir;
  }

  #warn(record: Record<string, unknown>, message: string): void {
    this.#deps.logger.warn(record, message);
  }

  /** Re-reads and validates every two-level `{ns}/{name}/plugin.json`; broken plugins warn and are skipped. */
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
    for (const namespace of namespaces) {
      let names: string[];
      try {
        names = readdirSync(path.join(this.#rootDir, namespace), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const dir = path.join(this.#rootDir, namespace, name);
        const manifest = this.#loadOne(dir, `${namespace}/${name}`);
        if (manifest === null) continue;
        loaded.push({ id: manifest.id, dir, manifest });
      }
    }
    return loaded;
  }

  get(id: string): LoadedBuiltinPlugin | null {
    return this.list().find((plugin) => plugin.id === id) ?? null;
  }

  #loadOne(dir: string, expectedId: string): PluginManifest | null {
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
    // The directory layout is the identity: `{ns}/{name}` must equal `manifest.id`.
    if (manifest.id !== expectedId) {
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

  /** Skill contributions of `com.kepcup/starter-skills`; entries missing required display fields warn and skip. */
  skillOffers(): BuiltinSkillOffer[] {
    const plugin = this.get(SKILLS_PLUGIN_ID);
    if (plugin === null) return [];
    const offers: BuiltinSkillOffer[] = [];
    for (const contribution of plugin.manifest.contributions.skills) {
      const { displayName, summary, section, version } = contribution;
      if (
        displayName === undefined ||
        summary === undefined ||
        section === undefined ||
        version === undefined
      ) {
        this.#warn(
          { plugin: SKILLS_PLUGIN_ID, dir: contribution.dir },
          'builtin skill contribution missing displayName/summary/section/version',
        );
        continue;
      }
      offers.push({
        id: path.basename(contribution.dir),
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
    return offers;
  }

  /**
   * Connector entries of `com.kepcup/connections`, shaped like the old packaged catalog
   * source (raw `server.json` objects in `plugin.json` order; schema validation stays in
   * `parseConnectorEntries`). `iconPaths` = slug → icon file next to `server.json`
   * (missing files are simply not in the map).
   */
  connectorSource(): {
    entries: unknown[];
    iconsDir: string | null;
    iconPaths: ReadonlyMap<string, string>;
  } {
    const plugin = this.get(CONNECTORS_PLUGIN_ID);
    if (plugin === null) return { entries: [], iconsDir: null, iconPaths: new Map() };
    const entries: unknown[] = [];
    const iconPaths = new Map<string, string>();
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
      const meta = (raw as { _meta?: Record<string, { slug?: unknown; icon?: unknown }> })._meta?.[
        'app.kepcup/connector'
      ];
      if (typeof meta?.slug === 'string' && typeof meta?.icon === 'string') {
        const iconPath = path.join(path.dirname(file), meta.icon);
        if (existsSync(iconPath)) iconPaths.set(meta.slug, iconPath);
      }
    }
    return { entries, iconsDir: null, iconPaths };
  }

  /** Read-only `plugins.list` entries: origin/tier = builtin, state = installed, dirPath = null. */
  summaries(): PluginSummary[] {
    return this.list().map((plugin) => {
      const { manifest } = plugin;
      return {
        id: manifest.id,
        name: manifest.name,
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
      };
    });
  }
}

/**
 * Synchronous on-disk check for the read-only builtin trees (same rules as the async
 * `verifyContributionFiles`: regular files / skill dirs with SKILL.md, no symlinks,
 * nothing resolving outside the plugin dir). Sync because the loader's readers
 * (`SkillPresetsService.#resolveAll`) are synchronous by contract.
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
