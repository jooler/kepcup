import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WikiOwner } from '@kepcup/shared';

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
  /** Installed plugin trees and the staging root (D104): `{home}/plugins/`. */
  pluginsDir: string;
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
    pluginsDir: path.join(home, 'plugins'),
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

/**
 * 分享中转目录（D94 §7.1）：`{home}/inbox/share/`。主进程把 App Group inbox
 * 里的批次目录移到这里，core 再消费。批次目录 `{intakeId}/` 里带
 * `manifest.json` 与 `files/`。
 */
export function shareInboxRoot(paths: AppPaths): string {
  return path.join(paths.home, 'inbox', 'share');
}

/** 一个分享批次的 core inbox 目录：`{home}/inbox/share/{intakeId}/`。 */
export function shareInboxDir(paths: AppPaths, intakeId: string): string {
  return path.join(shareInboxRoot(paths), intakeId);
}

/**
 * Private state of one external agent (D72 P5): `agents/{agentId}/` — e.g. the
 * relocated config home of an agent whose global config must not be shared
 * with the user's own installation (Antigravity `GEMINI_HOME`).
 */
export function agentStateDir(paths: AppPaths, agentId: string): string {
  return path.join(paths.home, 'agents', agentId);
}

/**
 * Working directory of an external agent's processes (D72 P5 审查 M1):
 * `agents/{agentId}/cwd`, private (0700). Never the shared temp directory —
 * agents resolve configuration relative to their process cwd (Cursor looks
 * for `.cursor/cli.json` from there, and a world-writable `/tmp/.cursor/`
 * would become its command allowlist). Created on demand.
 */
export function ensureAgentProcessCwd(paths: AppPaths, agentId: string): string {
  const dir = path.join(agentStateDir(paths, agentId), 'cwd');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  return dir;
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

// --- widget drafts (D87) -------------------------------------------------------

/** Drafts of the widget authoring loop: `bots/{id}/widget-drafts/` (design 32 §11.5). */
export function botWidgetDraftsDir(paths: AppPaths, botId: string): string {
  return path.join(paths.home, 'bots', botId, 'widget-drafts');
}

/** One craft's draft directory: `bots/{id}/widget-drafts/{craftId}/`. */
export function botWidgetDraftDir(paths: AppPaths, botId: string, craftId: string): string {
  return path.join(botWidgetDraftsDir(paths, botId), craftId);
}

// --- wiki (P09; owners generalized in D92 T1b WP9) ------------------------------

/** Data root of one project team (D92 §4.14): `projects/{projectId}/`. The project id is its root conversation id. */
export function projectRoot(paths: AppPaths, projectId: string): string {
  return path.join(paths.home, 'projects', projectId);
}

/** Root of a project's shared wiki (es-git versioned): `projects/{id}/wiki/`. */
export function projectWikiRoot(paths: AppPaths, projectId: string): string {
  return path.join(projectRoot(paths, projectId), 'wiki');
}

/** Out-of-git binary asset store of a project's wiki (D85): `projects/{id}/wiki-store/`. Reserved; unused this phase. */
export function projectWikiStoreRoot(paths: AppPaths, projectId: string): string {
  return path.join(projectRoot(paths, projectId), 'wiki-store');
}

/** Project-level encrypted FTS database of a project's wiki: `projects/{id}/wiki.db` (only `wiki_fts`). */
export function projectWikiDbPath(paths: AppPaths, projectId: string): string {
  return path.join(projectRoot(paths, projectId), 'wiki.db');
}

/** Root of one owner's wiki (es-git versioned): bots `bots/{id}/wiki/`, projects `projects/{id}/wiki/`. */
export function wikiRoot(paths: AppPaths, owner: WikiOwner): string {
  return owner.kind === 'bot' ? botWikiRoot(paths, owner.id) : projectWikiRoot(paths, owner.id);
}

/** Raw source material (append-only): `{wikiRoot}/raw/`. */
export function wikiRawDir(paths: AppPaths, owner: WikiOwner): string {
  return path.join(wikiRoot(paths, owner), 'raw');
}

/** LLM-maintained knowledge pages: `{wikiRoot}/pages/`. */
export function wikiPagesDir(paths: AppPaths, owner: WikiOwner): string {
  return path.join(wikiRoot(paths, owner), 'pages');
}

/** Out-of-git binary asset store of one owner's wiki (D85): bots `bots/{id}/wiki-store/`, projects `projects/{id}/wiki-store/`. */
export function wikiStoreRoot(paths: AppPaths, owner: WikiOwner): string {
  return owner.kind === 'bot'
    ? botWikiStoreRoot(paths, owner.id)
    : projectWikiStoreRoot(paths, owner.id);
}

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
 * Out-of-git binary asset store of a bot's wiki (D85, design 36 §3.1):
 * `bots/{id}/wiki-store/{assetId}/`. Content-addressed (assetId from sha256); the wiki
 * repository only holds the `raw/_assets/{assetId}.json` pointers.
 */
export function botWikiStoreRoot(paths: AppPaths, botId: string): string {
  return path.join(paths.home, 'bots', botId, 'wiki-store');
}

/**
 * Checkpoint (shadow) repository of one workdir:
 * `workdirs/{workdirId}/checkpoints.git` (docs/dev/phases/P04-project.md).
 * Its `core.worktree` points at the workdir directory; nothing of the shadow
 * repo ever lives inside the workdir itself.
 */
export function workdirCheckpointsPath(paths: AppPaths, workdirId: string): string {
  return path.join(paths.home, 'workdirs', workdirId, 'checkpoints.git');
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

// Preset skills shipped with the app moved to the builtin plugin loader (D104 P0b):
// see plugins/builtin.ts (`resolveBuiltinPluginsDir`, env `KEPCUP_BUILTIN_PLUGINS`).
