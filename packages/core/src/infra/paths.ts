import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for every path inside the data directory.
 * No other module may join data-directory paths on its own (02-architecture.md).
 */
export interface AppPaths {
  /** Data directory root, `~/.kepcup/` by default. */
  home: string;
  logsDir: string;
  mainDbPath: string;
  runsDbPath: string;
  /** Pre-migration database backups (P13 任务 5): `{home}/backups/`. */
  backupsDir: string;
  /** Cache root for sandboxed toolchains: `{home}/cache/`. */
  cacheDir: string;
  cacheNpmDir: string;
  cachePipDir: string;
  cacheXdgDir: string;
  cacheCargoDir: string;
  /** PYTHONPYCACHEPREFIX target (macOS system Python pyc redirect). */
  cachePycacheDir: string;
  /** UV_CACHE_DIR target (P06). */
  cacheUvDir: string;
  /** Download staging for environment installs (P06): `{home}/cache/downloads/`. */
  cacheDownloadsDir: string;
  /** Shared toolchains installed on request (P06): `{home}/toolchains/`. */
  toolchainsDir: string;
}

export function defaultHome(): string {
  return path.join(homedir(), '.kepcup');
}

export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Realpath of `target`, resolving the deepest existing ancestor when the
 * target itself does not exist yet. Canonicalizes away /var → /private/var
 * style symlinks so path comparisons are stable.
 */
export function canonicalPath(target: string): string {
  let current = path.resolve(target);
  let rest = '';
  for (;;) {
    try {
      return rest.length === 0 ? realpathSync(current) : path.join(realpathSync(current), rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      rest = path.join(path.basename(current), rest);
      current = parent;
    }
  }
}

export function resolvePaths(homeOverride?: string): AppPaths {
  const home = canonicalPath(homeOverride ? expandTilde(homeOverride) : defaultHome());
  const cacheDir = path.join(home, 'cache');
  return {
    home,
    logsDir: path.join(home, 'logs'),
    mainDbPath: path.join(home, 'main.db'),
    runsDbPath: path.join(home, 'runs.db'),
    backupsDir: path.join(home, 'backups'),
    cacheDir,
    cacheNpmDir: path.join(cacheDir, 'npm'),
    cachePipDir: path.join(cacheDir, 'pip'),
    cacheXdgDir: path.join(cacheDir, 'xdg'),
    cacheCargoDir: path.join(cacheDir, 'cargo'),
    cachePycacheDir: path.join(cacheDir, 'pycache'),
    cacheUvDir: path.join(cacheDir, 'uv'),
    cacheDownloadsDir: path.join(cacheDir, 'downloads'),
    toolchainsDir: path.join(home, 'toolchains'),
  };
}

/** Install directory of one toolchain item version: `toolchains/{item}/{version}/`. */
export function toolchainPathFor(paths: AppPaths, item: string, version: string): string {
  return path.join(paths.toolchainsDir, item, version);
}

/** Workspace of one bot in one conversation: `bots/{botId}/workspaces/{conversationId}/`. */
export function workspacePathFor(paths: AppPaths, botId: string, conversationId: string): string {
  return path.join(paths.home, 'bots', botId, 'workspaces', conversationId);
}

/** Encrypted per-bot memory database: `bots/{botId}/memory.db` (P07). */
export function botMemoryDbPath(paths: AppPaths, botId: string): string {
  return path.join(paths.home, 'bots', botId, 'memory.db');
}

/** Shared read-only skill library root (P08): `{home}/skills-library/`. */
export function skillsLibraryDir(paths: AppPaths): string {
  return path.join(paths.home, 'skills-library');
}

/** Library directory of one skill version: `skills-library/{name}@{hash}/`. */
export function librarySkillDir(paths: AppPaths, name: string, contentHash: string): string {
  return path.join(skillsLibraryDir(paths), `${name}@${contentHash}`);
}

/** Root of a bot's authored skills (es-git versioned): `bots/{id}/skills/`. */
export function botSkillsRoot(paths: AppPaths, botId: string): string {
  return path.join(paths.home, 'bots', botId, 'skills');
}

/** Draft workspace of the skill generation loop: `bots/{id}/skills/_drafts/`. */
export function botSkillDraftsDir(paths: AppPaths, botId: string): string {
  return path.join(botSkillsRoot(paths, botId), '_drafts');
}

/** One draft's directory: `bots/{id}/skills/_drafts/{name}/`. */
export function botSkillDraftDir(paths: AppPaths, botId: string, name: string): string {
  return path.join(botSkillDraftsDir(paths, botId), name);
}

/** Installed authored skill: `bots/{id}/skills/{name}/`. */
export function botSkillDir(paths: AppPaths, botId: string, name: string): string {
  return path.join(botSkillsRoot(paths, botId), name);
}

// --- wiki (P09) ---------------------------------------------------------------

/** Root of a bot's wiki (es-git versioned): `bots/{id}/wiki/`. */
export function botWikiRoot(paths: AppPaths, botId: string): string {
  return path.join(paths.home, 'bots', botId, 'wiki');
}

/** Raw source material (append-only): `bots/{id}/wiki/raw/`. */
export function botWikiRawDir(paths: AppPaths, botId: string): string {
  return path.join(botWikiRoot(paths, botId), 'raw');
}

/** LLM-maintained knowledge pages: `bots/{id}/wiki/pages/`. */
export function botWikiPagesDir(paths: AppPaths, botId: string): string {
  return path.join(botWikiRoot(paths, botId), 'pages');
}

/**
 * Checkpoint (shadow) repository of one project:
 * `projects/{projectId}/checkpoints.git` (docs/dev/phases/P04-project.md).
 * Its `core.worktree` points at the project directory; nothing of the shadow
 * repo ever lives inside the project itself.
 */
export function projectCheckpointsPath(paths: AppPaths, projectId: string): string {
  return path.join(paths.home, 'projects', projectId, 'checkpoints.git');
}

/** Every workspace directory of a bot (all conversations). */
export function botWorkspacesRoot(paths: AppPaths, botId: string): string {
  return path.join(paths.home, 'bots', botId, 'workspaces');
}

// --- Windows WSL2 private distro (P12) ---------------------------------------

/**
 * Base directory of the imported private WSL2 distro:
 * `wsl --import Kepcup <sandboxWslDir> rootfs.tar --version 2`
 * (docs/dev/phases/P12-windows-and-enhanced-sandbox.md 任务 3).
 */
export function sandboxWslDir(paths: AppPaths): string {
  return path.join(paths.home, 'sandbox', 'wsl');
}

/** Persisted state machine snapshot of the WSL setup (enable → reboot → import). */
export function wslSetupStatePath(paths: AppPaths): string {
  return path.join(sandboxWslDir(paths), 'setup-state.json');
}

/**
 * Binaries shipped with the app (rg, bwrap, socat) under
 * `apps/desktop/resources/bin/{platform}-{arch}/`. Resolution order: explicit
 * env override → nearest `apps/` ancestor of this package (repo checkout) →
 * null (callers fall back to system PATH).
 */
export function resolveBundledBinDir(env: NodeJS.ProcessEnv): string | null {
  const override = env.KEPCUP_BUNDLED_BIN;
  if (override !== undefined && override.length > 0) return path.resolve(override);

  const dir = `${process.platform}-${process.arch}`;
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(current, 'apps', 'desktop', 'resources', 'bin', dir);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Preset skills shipped with the app (`apps/desktop/resources/preset-skills/`,
 * the skill-marketplace catalog, packaged as extraResources). Resolution
 * mirrors resolveBundledBinDir: explicit env override (KEPCUP_PRESET_SKILLS,
 * injected by core-host for the packaged app) → nearest `apps/` ancestor of
 * this package (repo checkout) → null (the marketplace simply lists nothing).
 */
export function resolvePresetSkillsDir(env: NodeJS.ProcessEnv): string | null {
  const override = env.KEPCUP_PRESET_SKILLS;
  if (override !== undefined && override.length > 0) {
    return existsSync(override) ? path.resolve(override) : null;
  }
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(current, 'apps', 'desktop', 'resources', 'preset-skills');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
