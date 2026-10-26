import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_MAX_BYTES,
  type PluginManifest,
} from '@kepcup/shared';
import {
  safeEntryPath,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY_BYTES,
  ZIP_MAX_FILE_BYTES,
  ZIP_MAX_UNPACKED_BYTES,
  ZipArchive,
  type ZipErrorFactory,
} from '@kepcup/package-guard';
import type { CoreLogger } from '../infra/logger.js';
import {
  checkPluginCompatibility,
  parsePluginManifestText,
  verifyContributionFiles,
} from './manifest-loader.js';

/**
 * Plugin packager (D104, docs/design/51-plugin-system.md §5 steps 1–2): stages a
 * `.kepcup` file or a development directory into `{pluginsDir}/.staging/{random}/` —
 * a verified, private copy plus its manifest and content hash. No user-visible state is
 * written here; the registry (P0a-2) consumes `StagedPlugin` and performs the install.
 *
 * The pipeline mirrors `McpbInstaller`: private snapshot first (TOCTOU), archive guards
 * (zip-slip / symlink / duplicate paths / size caps), manifest parsing and environment
 * compatibility, then extraction with narrowed permission bits and contribution checks.
 * Any failure removes the staging directory and snapshot before rethrowing.
 */

const error: ZipErrorFactory = (message) => new AppError('PLUGIN_INVALID', message);
const invalid = error;

export interface StagedPlugin {
  manifest: PluginManifest;
  /** Absolute path `{pluginsDir}/.staging/{random}/` — the extracted private tree. */
  stagingDir: string;
  /** file: sha256 of the `.kepcup` bytes; folder: the tree hash (see below). */
  packageSha256: string;
  sizeBytes: number;
  source: { kind: 'file' | 'folder'; path: string };
}

export interface PluginPackagerDeps {
  pluginsDir: string;
  logger: CoreLogger;
  appVersion: string;
  platform?: NodeJS.Platform;
}

function treeHashOf(entries: string[]): string {
  return createHash('sha256')
    .update([...entries].sort().join('\n'))
    .digest('hex');
}

export class PluginPackager {
  readonly #deps: PluginPackagerDeps;

  constructor(deps: PluginPackagerDeps) {
    this.#deps = deps;
  }

  get #stagingRoot(): string {
    return path.join(this.#deps.pluginsDir, '.staging');
  }

  get #platform(): NodeJS.Platform {
    return this.#deps.platform ?? process.platform;
  }

  stage(source: { kind: 'file' | 'folder'; path: string }): Promise<StagedPlugin> {
    return source.kind === 'file' ? this.#stageFile(source.path) : this.#stageFolder(source.path);
  }

  /** Removes a staged tree; idempotent. */
  async discard(staged: StagedPlugin): Promise<void> {
    await rm(staged.stagingDir, { recursive: true, force: true });
  }

  /** Empties `.staging/` at startup — nothing in flight can survive a restart. */
  async sweepStaging(): Promise<void> {
    await rm(this.#stagingRoot, { recursive: true, force: true });
  }

  // --- file (.kepcup archive) ------------------------------------------------

  async #stageFile(filePath: string): Promise<StagedPlugin> {
    if (!path.isAbsolute(filePath)) throw invalid('请提供插件包的绝对路径');
    let info;
    try {
      info = await stat(filePath);
    } catch {
      throw new AppError('NOT_FOUND', `找不到文件：${filePath}`);
    }
    if (!info.isFile()) throw invalid('所选路径不是文件');
    if (info.size > ZIP_MAX_FILE_BYTES) throw invalid('包文件过大');

    const stagingRoot = this.#stagingRoot;
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    // Private snapshot: every later step reads this copy, never the user's path.
    const snapshot = path.join(stagingRoot, `.snap-${randomBytes(8).toString('hex')}.kepcup`);
    const hash = createHash('sha256');
    let size = 0;
    const out = await open(snapshot, 'wx', 0o600);
    try {
      for await (const chunk of createReadStream(filePath)) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > ZIP_MAX_FILE_BYTES) throw invalid('包文件过大');
        hash.update(buffer);
        await out.write(buffer);
      }
    } catch (streamError) {
      await out.close();
      await rm(snapshot, { force: true });
      throw streamError;
    }
    await out.close();
    const sha256 = hash.digest('hex');

    let stagingDir: string | null = null;
    try {
      const zip = await ZipArchive.open(snapshot, { error, label: '.kepcup' });
      try {
        const names = new Set<string>();
        for (const entry of zip.entries) {
          const safe = safeEntryPath(entry.name, error);
          if (entry.isSymlink) throw invalid(`包内含符号链接，已拒绝：${entry.name}`);
          const key = safe.toLowerCase();
          if (names.has(key)) throw invalid(`包内有重复路径：${entry.name}`);
          names.add(key);
        }
        const manifestEntry = zip.entries.find((entry) => entry.name === PLUGIN_MANIFEST_FILE);
        if (manifestEntry === undefined) {
          throw invalid(`包里没有 ${PLUGIN_MANIFEST_FILE}（不是 .kepcup 插件包？）`);
        }
        if (manifestEntry.size > PLUGIN_MANIFEST_MAX_BYTES) {
          throw invalid(`${PLUGIN_MANIFEST_FILE} 过大`);
        }
        const manifest = parsePluginManifestText((await zip.read(manifestEntry)).toString('utf8'));
        checkPluginCompatibility(manifest, {
          appVersion: this.#deps.appVersion,
          platform: this.#platform,
        });
        stagingDir = await this.#extract(zip, manifest);
        this.#deps.logger.info({ source: filePath, sha256, size }, 'plugin package staged');
        return {
          manifest,
          stagingDir,
          packageSha256: sha256,
          sizeBytes: size,
          source: { kind: 'file', path: filePath },
        };
      } finally {
        await zip.close();
      }
    } catch (stageError) {
      if (stagingDir !== null) await rm(stagingDir, { recursive: true, force: true });
      throw stageError;
    } finally {
      await rm(snapshot, { force: true });
    }
  }

  async #extract(zip: ZipArchive, manifest: PluginManifest): Promise<string> {
    const stagingDir = path.join(this.#stagingRoot, randomBytes(8).toString('hex'));
    await mkdir(stagingDir, { recursive: true });
    for (const entry of zip.entries) {
      const relative = safeEntryPath(entry.name, error);
      const target = path.resolve(stagingDir, ...relative.split('/'));
      if (!target.startsWith(stagingDir + path.sep)) throw invalid(`包内路径越界：${entry.name}`);
      if (entry.isDirectory) {
        await mkdir(target, { recursive: true });
        continue;
      }
      const data = await zip.read(entry);
      await mkdir(path.dirname(target), { recursive: true });
      // Never group/world-writable: only the executable bit of the archive is honoured.
      const mode = (entry.unixMode & 0o111) !== 0 ? 0o755 : 0o644;
      await writeFile(target, data, { mode });
    }
    await verifyContributionFiles(manifest, stagingDir);
    return stagingDir;
  }

  // --- folder (development directory) -----------------------------------------

  async #stageFolder(dirPath: string): Promise<StagedPlugin> {
    if (!path.isAbsolute(dirPath)) throw invalid('请提供插件目录的绝对路径');
    let rootInfo;
    try {
      rootInfo = await lstat(dirPath);
    } catch {
      throw new AppError('NOT_FOUND', `找不到目录：${dirPath}`);
    }
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw invalid('所选路径不是目录');

    const stagingRoot = this.#stagingRoot;
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const stagingDir = path.join(stagingRoot, randomBytes(8).toString('hex'));
    await mkdir(stagingDir, { recursive: true });
    const treeEntries: string[] = [];
    let entryCount = 0;
    let sizeBytes = 0;
    try {
      // Validate while walking the source, but only ever use the staged copy afterwards
      // (the user may change the source right after a check otherwise).
      const walk = async (relative: string): Promise<void> => {
        const absolute = relative === '' ? dirPath : path.join(dirPath, ...relative.split('/'));
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw invalid(`目录里含符号链接，已拒绝：${relative}`);
        if (info.isDirectory()) {
          if (relative !== '') {
            safeEntryPath(relative, error);
            entryCount += 1;
            if (entryCount > ZIP_MAX_ENTRIES) {
              throw invalid(`目录条目过多（上限 ${ZIP_MAX_ENTRIES}）`);
            }
            await mkdir(path.join(stagingDir, ...relative.split('/')), { recursive: true });
          }
          for (const child of await readdir(absolute)) {
            await walk(relative === '' ? child : `${relative}/${child}`);
          }
          return;
        }
        if (!info.isFile()) throw invalid(`目录里含非常规文件，已拒绝：${relative}`);
        safeEntryPath(relative, error);
        entryCount += 1;
        if (entryCount > ZIP_MAX_ENTRIES) throw invalid(`目录条目过多（上限 ${ZIP_MAX_ENTRIES}）`);
        if (info.size > ZIP_MAX_ENTRY_BYTES) throw invalid(`目录里文件过大：${relative}`);
        sizeBytes += info.size;
        if (sizeBytes > ZIP_MAX_UNPACKED_BYTES) throw invalid('目录体积超过上限');
        const target = path.resolve(stagingDir, ...relative.split('/'));
        if (!target.startsWith(stagingDir + path.sep)) throw invalid(`目录里路径越界：${relative}`);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(absolute, target);
        const mode = (info.mode & 0o111) !== 0 ? 0o755 : 0o644;
        await chmod(target, mode);
        // Hash the staged copy, not the source: the source may change between copyFile and
        // hashing, and `packageSha256` must bind the bytes that are actually staged.
        treeEntries.push(
          `${relative}\0${createHash('sha256')
            .update(await readFile(target))
            .digest('hex')}`,
        );
      };
      await walk('');

      const manifest = parsePluginManifestText(
        await readFile(path.join(stagingDir, PLUGIN_MANIFEST_FILE), 'utf8'),
      );
      checkPluginCompatibility(manifest, {
        appVersion: this.#deps.appVersion,
        platform: this.#platform,
      });
      await verifyContributionFiles(manifest, stagingDir);
      this.#deps.logger.info(
        { source: dirPath, treeHash: treeHashOf(treeEntries), sizeBytes },
        'plugin directory staged',
      );
      return {
        manifest,
        stagingDir,
        packageSha256: treeHashOf(treeEntries),
        sizeBytes,
        source: { kind: 'folder', path: dirPath },
      };
    } catch (stageError) {
      await rm(stagingDir, { recursive: true, force: true });
      throw stageError;
    }
  }
}
