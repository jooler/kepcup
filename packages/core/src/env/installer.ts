import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppError } from '@kepcup/shared';
import type { AppPaths } from '../infra/paths.js';
import type { CoreLogger } from '../infra/logger.js';
import type { Clock } from '../infra/clock.js';
import type { CatalogEntry, CatalogPlatform } from './catalog.js';
import { isFileVerify } from './catalog.js';

/**
 * Serial environment installer (docs/dev/phases/P06-environment.md 任务 2).
 * One install at a time (in-memory FIFO, no persistence): download into
 * `cache/downloads/` → sha256 → extract into a temp dir → run the verify
 * command → atomic rename into `toolchains/{item}/{version}/`. Any failure
 * cleans up and reports; nothing is left behind (acceptance: 校验失败不留残留).
 *
 * Extraction uses the system `tar` (bsdtar on macOS/Windows also handles zip;
 * the Linux artifacts in the catalog are tar.gz only) — no new dependency.
 */

export interface InstallJob {
  installId: string;
  entry: CatalogEntry;
  platformKey: string;
  platform: CatalogPlatform;
  /** Where the version directory must land (toolchains/{item}/{version}). */
  targetDir: string;
  /**
   * P12 distro installs: the ARTIFACT's platform for layout resolution when
   * it differs from the host (a linux tarball staged on a Windows host).
   */
  binaryPlatform?: string;
  /**
   * P12 distro installs: skip the host-side verify command (linux binaries
   * cannot run on the Windows host; verification runs inside the distro).
   */
  verify?: boolean;
  /** uv-python: the uv binary to drive `python install` with (host path). */
  uvBin?: string;
  onProgress: (stage: InstallStage, extra?: ProgressExtra) => void;
  signal?: AbortSignal;
}

export type InstallStage =
  'queued' | 'downloading' | 'verifying' | 'extracting' | 'checking' | 'done' | 'failed';

export interface ProgressExtra {
  received?: number;
  total?: number;
  error?: string;
}

export interface InstallResult {
  ok: boolean;
  /** Primary bin directory of the installed item (null when failed). */
  binDir: string | null;
  error?: string;
}

export interface InstallerDeps {
  paths: AppPaths;
  logger: CoreLogger;
  clock: Clock;
  /** Env-var overrides for tests (download timeout). */
  env?: NodeJS.ProcessEnv;
}

const DOWNLOAD_TIMEOUT_DEFAULT_MS = 600_000;

function downloadTimeoutMs(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.KEPCUP_ENV_DOWNLOAD_TIMEOUT_MS;
  if (raw === undefined || raw.length === 0) return DOWNLOAD_TIMEOUT_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DOWNLOAD_TIMEOUT_DEFAULT_MS;
}

function exeName(name: string, platform: string): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/**
 * Primary executable directory of an installed item, resolved from the layout
 * on disk (also used by the doctor on rows installed by earlier runs).
 */
export function resolveBinDir(item: string, targetDir: string, platform: string): string | null {
  switch (item) {
    case 'uv':
      return existsSync(path.join(targetDir, exeName('uv', platform))) ? targetDir : null;
    case 'node':
      // Unix tarball: root/bin/node. Windows zip: root/node.exe.
      if (existsSync(path.join(targetDir, 'bin', exeName('node', platform)))) {
        return path.join(targetDir, 'bin');
      }
      return existsSync(path.join(targetDir, exeName('node', platform))) ? targetDir : null;
    case 'python':
      // uv's layout differs across versions: cpython-*/ directly under the
      // install dir, or nested under python/. Cover both.
      return (
        pythonBinIn(targetDir, platform) ?? pythonBinIn(path.join(targetDir, 'python'), platform)
      );
    case 'git':
      // MinGit: cmd/git.exe (wrapper) plus mingw64/bin for core tools.
      return existsSync(path.join(targetDir, 'cmd', exeName('git', platform)))
        ? path.join(targetDir, 'cmd')
        : null;
    case 'onnxruntime':
      // P07: the ORT Node package tree; no executable — the package root is
      // the marker (loaded via createRequire by memory/local-embedder).
      return existsSync(path.join(targetDir, 'dist', 'index.js')) ? targetDir : null;
    case 'embedding-model':
      // P07: jina-embeddings-v2-base-zh q8 ONNX export (model + vocab/merges/config).
      return existsSync(path.join(targetDir, 'model.onnx')) &&
        existsSync(path.join(targetDir, 'vocab.json')) &&
        existsSync(path.join(targetDir, 'merges.txt')) &&
        existsSync(path.join(targetDir, 'config.json'))
        ? targetDir
        : null;
    default:
      // Named executable at the root, or a uv-python style cpython layout
      // (any item name; python installs land as cpython-*/bin/python3).
      if (existsSync(path.join(targetDir, exeName(item, platform)))) return targetDir;
      return (
        pythonBinIn(targetDir, platform) ?? pythonBinIn(path.join(targetDir, 'python'), platform)
      );
  }
}

function pythonBinIn(base: string, platform: string): string | null {
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('cpython-')) continue;
    const binDir =
      platform === 'win32' ? path.join(base, entry.name) : path.join(base, entry.name, 'bin');
    if (existsSync(path.join(binDir, exeName('python3', platform)))) return binDir;
  }
  return null;
}

export class Installer {
  readonly #deps: InstallerDeps;
  readonly #queue: InstallJob[] = [];
  readonly #resolvers = new Map<string, (result: InstallResult) => void>();
  #running = false;

  constructor(deps: InstallerDeps) {
    this.#deps = deps;
  }

  get busy(): boolean {
    return this.#running;
  }

  /** Enqueues one install; the promise settles when the job finishes either way. */
  enqueue(job: InstallJob): Promise<InstallResult> {
    return new Promise<InstallResult>((resolve) => {
      this.#resolvers.set(job.installId, resolve);
      this.#queue.push(job);
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#running) return;
    const job = this.#queue.shift();
    if (!job) return;
    this.#running = true;
    void this.#run(job).finally(() => {
      this.#running = false;
      this.#drain();
    });
  }

  async #run(job: InstallJob): Promise<void> {
    const resolve = this.#resolvers.get(job.installId);
    this.#resolvers.delete(job.installId);
    const startedAt = this.#deps.clock.now();
    try {
      const binDir =
        job.platform.kind === 'uv-python'
          ? await this.#installUvPython(job)
          : job.platform.kind === 'files'
            ? await this.#installFiles(job)
            : await this.#installArchive(job);
      this.#deps.logger.info(
        {
          item: job.entry.item,
          version: job.entry.version,
          ms: this.#deps.clock.now() - startedAt,
        },
        'environment installed',
      );
      job.onProgress('done');
      resolve?.({ ok: true, binDir });
    } catch (error) {
      const message = error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
      // Never leave a half-written version directory behind.
      rmSync(job.targetDir, { recursive: true, force: true });
      this.#deps.logger.warn(
        { item: job.entry.item, error: message },
        'environment install failed',
      );
      job.onProgress('failed', { error: message });
      resolve?.({ ok: false, binDir: null, error: message });
    }
  }

  // --- archive kind ----------------------------------------------------------

  async #installArchive(job: InstallJob): Promise<string> {
    const { paths } = this.#deps;
    if (job.platform.url.length === 0 || job.platform.sha256.length === 0) {
      throw new AppError('ENV_INSTALL_FAILED', '目录条目缺少下载地址或校验值');
    }
    mkdirSync(paths.cacheDownloadsDir, { recursive: true });
    const ext = job.platform.url.endsWith('.zip') ? '.zip' : '.tar.gz';
    const downloadPath = path.join(
      paths.cacheDownloadsDir,
      `${job.entry.item}-${job.entry.version}-${job.platformKey}${ext}`,
    );
    try {
      job.onProgress('downloading', { total: job.platform.sizeBytes });
      const hash = await this.#download(
        job.platform.url,
        job.platform.sizeBytes,
        downloadPath,
        job,
      );
      job.onProgress('verifying');
      const actual = hash.digest('hex');
      if (actual !== job.platform.sha256) {
        throw new AppError(
          'ENV_CHECKSUM_MISMATCH',
          `下载内容校验失败（期望 ${job.platform.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），已丢弃`,
        );
      }
      job.onProgress('extracting');
      const tmpDir = `${downloadPath}.extract`;
      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(tmpDir, { recursive: true });
      try {
        await extractArchive(downloadPath, tmpDir);
        const root = singleRootDir(tmpDir) ?? tmpDir;
        mkdirSync(path.dirname(job.targetDir), { recursive: true });
        // Atomic within the data volume; a previous attempt never lingers.
        rmSync(job.targetDir, { recursive: true, force: true });
        try {
          statSync(root);
        } catch {
          throw new AppError('ENV_INSTALL_FAILED', `解压结果不存在：${root}`);
        }
        try {
          renameSync(root, job.targetDir);
        } catch (error) {
          throw new AppError(
            'ENV_INSTALL_FAILED',
            `落位失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(downloadPath, { force: true });
    }

    job.onProgress('checking');
    const binDir = resolveBinDir(
      job.entry.item,
      job.targetDir,
      job.binaryPlatform ?? process.platform,
    );
    if (binDir === null) {
      throw new AppError('ENV_VERIFY_FAILED', '安装后未找到可执行文件，目录布局与预期不符');
    }
    if (job.verify !== false) {
      await verifyInstall(job.entry, binDir, job.targetDir, {
        timeoutMs: 60_000,
        signal: job.signal,
      });
    }
    return binDir;
  }

  // --- files kind ---------------------------------------------------------------

  /**
   * kind='files' (P07 运行库/模型): the entry's `install.files` list is
   * materialized into a fresh temp dir — plain files renamed in, archives
   * extracted with their single root moved to `extract.dest` — the file
   * verify runs against the temp dir, then the whole dir is renamed into
   * place atomically (same failure semantics as #installArchive).
   */
  async #installFiles(job: InstallJob): Promise<string> {
    const { paths } = this.#deps;
    if (job.entry.install.via !== 'files') {
      throw new AppError('ENV_INSTALL_FAILED', '目录条目安装方式与平台类型不符');
    }
    mkdirSync(paths.cacheDownloadsDir, { recursive: true });
    const staging = `${path.join(paths.cacheDownloadsDir, `${job.entry.item}-${job.entry.version}-${job.platformKey}`)}.staging`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      for (const file of job.entry.install.files) {
        job.onProgress('downloading', { total: job.platform.sizeBytes });
        const ext =
          file.extract !== undefined ? (file.url.endsWith('.zip') ? '.zip' : '.tar.gz') : '';
        const downloadPath = path.join(
          paths.cacheDownloadsDir,
          `${job.entry.item}-${file.name}${ext}`,
        );
        try {
          const hash = await this.#download(file.url, file.sizeBytes, downloadPath, job);
          job.onProgress('verifying');
          const actual = hash.digest('hex');
          if (actual !== file.sha256) {
            throw new AppError(
              'ENV_CHECKSUM_MISMATCH',
              `下载内容校验失败（${file.name}，期望 ${file.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），已丢弃`,
            );
          }
          if (file.extract === undefined) {
            renameSync(downloadPath, path.join(staging, file.name));
          } else {
            const extractDir = `${downloadPath}.extract`;
            rmSync(extractDir, { recursive: true, force: true });
            mkdirSync(extractDir, { recursive: true });
            try {
              await extractArchive(downloadPath, extractDir);
              const root = singleRootDir(extractDir) ?? extractDir;
              const dest =
                file.extract.dest === '' ? staging : path.join(staging, file.extract.dest);
              mkdirSync(path.dirname(dest), { recursive: true });
              try {
                if (file.extract.dest === '') {
                  // Root becomes the staging dir itself (it is empty here).
                  rmSync(staging, { recursive: true, force: true });
                }
                renameSync(root, dest);
              } catch (error) {
                throw new AppError(
                  'ENV_INSTALL_FAILED',
                  `解压落位失败（${file.name}）：${error instanceof Error ? error.message : String(error)}`,
                );
              }
            } finally {
              rmSync(extractDir, { recursive: true, force: true });
            }
          }
        } finally {
          rmSync(downloadPath, { force: true });
        }
        // received/total 是字节语义（下载进度条），逐文件阶段不带这两个字段。
        job.onProgress('extracting');
      }

      job.onProgress('checking');
      if (isFileVerify(job.entry.verify)) {
        for (const rel of job.entry.verify.files) {
          if (!existsSync(path.join(staging, rel))) {
            throw new AppError('ENV_VERIFY_FAILED', `安装后缺少文件：${rel}`);
          }
        }
      }
      mkdirSync(path.dirname(job.targetDir), { recursive: true });
      rmSync(job.targetDir, { recursive: true, force: true });
      renameSync(staging, job.targetDir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }

    job.onProgress('checking');
    const binDir = resolveBinDir(
      job.entry.item,
      job.targetDir,
      job.binaryPlatform ?? process.platform,
    );
    if (binDir === null) {
      throw new AppError('ENV_VERIFY_FAILED', '安装后目录布局与预期不符');
    }
    return binDir;
  }

  // --- uv-python kind --------------------------------------------------------

  async #installUvPython(job: InstallJob): Promise<string> {
    if (job.entry.install.via !== 'uv-python') {
      throw new AppError('ENV_INSTALL_FAILED', '目录条目安装方式与平台类型不符');
    }
    if (job.uvBin === undefined) {
      throw new AppError('ENV_INSTALL_FAILED', '安装 Python 需要先安装 uv');
    }
    job.onProgress('extracting'); // uv downloads and unpacks internally
    const uvEnv = {
      UV_PYTHON_INSTALL_DIR: job.targetDir,
      UV_CACHE_DIR: this.#deps.paths.cacheUvDir,
      PATH: `${path.dirname(job.uvBin)}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    await runCommand(job.uvBin, ['python', 'install', job.entry.install.pythonVersion], {
      timeoutMs: downloadTimeoutMs(this.#deps.env),
      signal: job.signal,
      env: uvEnv,
    });
    job.onProgress('checking');
    // Ask uv where it landed instead of guessing the layout.
    const found = await runCommand(job.uvBin, ['python', 'find', job.entry.install.pythonVersion], {
      timeoutMs: 30_000,
      signal: job.signal,
      env: uvEnv,
    });
    if (found.code !== 0) {
      throw new AppError(
        'ENV_VERIFY_FAILED',
        `uv python find 失败：${found.stderr.trim() || `(退出码 ${found.code})`}`,
      );
    }
    const printed = found.stdout.trim().split('\n').pop()?.trim() ?? '';
    const pythonBinDir = printed.length > 0 ? path.dirname(printed) : '';
    if (pythonBinDir.length === 0 || !existsSync(pythonBinDir)) {
      throw new AppError('ENV_VERIFY_FAILED', '安装后未找到 Python 可执行文件');
    }
    await verifyInstall(job.entry, pythonBinDir, job.targetDir, {
      timeoutMs: 60_000,
      signal: job.signal,
    });
    return pythonBinDir;
  }

  // --- download ----------------------------------------------------------------

  async #download(url: string, sizeBytes: number, target: string, job: InstallJob): Promise<Hash> {
    const timeoutMs = downloadTimeoutMs(this.#deps.env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('下载超时')), timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort(new Error('已取消'));
    job.signal?.addEventListener('abort', onAbort, { once: true });
    let lastReport = 0;
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok || response.body === null) {
        throw new AppError('ENV_INSTALL_FAILED', `下载失败（HTTP ${response.status}）：${url}`);
      }
      const total = Number(response.headers.get('content-length') ?? sizeBytes) || sizeBytes;
      const hash = createHash('sha256');
      const out = createWriteStream(target);
      let received = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        received += chunk.byteLength;
        if (!out.write(chunk)) {
          await new Promise<void>((resolve) => out.once('drain', resolve));
        }
        const now = Date.now();
        if (now - lastReport > 400) {
          lastReport = now;
          job.onProgress('downloading', { received, total });
        }
        if (job.signal?.aborted) throw new AppError('ENV_INSTALL_FAILED', '安装已取消');
      }
      out.end();
      await new Promise<void>((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
      });
      job.onProgress('downloading', { received, total });
      return hash;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (job.signal?.aborted) throw new AppError('ENV_INSTALL_FAILED', '安装已取消');
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError('ENV_INSTALL_FAILED', `下载失败：${message}`);
    } finally {
      clearTimeout(timer);
      job.signal?.removeEventListener('abort', onAbort);
    }
  }
}

// --- helpers -------------------------------------------------------------------

/**
 * Runs the catalog verify step (doctor + installer). File-mode entries check
 * the listed paths exist; command-mode entries run the command with {bin}/{dir}
 * resolved and match `expect` against stdout. Throws on mismatch.
 */
export async function verifyInstall(
  entry: CatalogEntry,
  binDir: string,
  targetDir: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  if (isFileVerify(entry.verify)) {
    for (const rel of entry.verify.files) {
      if (!existsSync(path.join(targetDir, rel))) {
        throw new AppError('ENV_VERIFY_FAILED', `校验失败：安装目录缺少 ${rel}`);
      }
    }
    return;
  }
  const { command, expect } = entry.verify;
  // uv-python items expose python3 regardless of their catalog item name.
  const binName = entry.install.via === 'uv-python' ? 'python3' : entry.item;
  const bin = primaryExecutable(binName, binDir);
  if (bin === null) {
    throw new AppError(
      'ENV_VERIFY_FAILED',
      `验证命令的可执行文件不存在（${binName} 于 ${binDir}）`,
    );
  }
  const resolved = command.replaceAll('{bin}', bin).replaceAll('{dir}', targetDir);
  const result = await runCommand(resolved, [], {
    shell: true,
    timeoutMs: options.timeoutMs ?? 60_000,
    signal: options.signal,
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  if (result.code !== 0 || !result.stdout.includes(expect)) {
    throw new AppError(
      'ENV_VERIFY_FAILED',
      `验证命令未通过（期望输出包含 "${expect}"）：${result.stdout.trim() || `(退出码 ${result.code})`}`,
    );
  }
}

/** The path the {bin} placeholder resolves to for a bin name in a bin dir. */
export function primaryExecutable(binName: string, binDir: string): string | null {
  const exe = exeName(binName, process.platform);
  if (existsSync(path.join(binDir, exe))) return path.join(binDir, exe);
  return null;
}

/** The single top-level directory of an extracted archive, if there is one. */
export function singleRootDir(dir: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0]!.isDirectory()) return path.join(dir, entries[0]!.name);
  return null;
}

/** tar/bsdtar handles tar.gz everywhere; zip via bsdtar (macOS, Windows 10+). */
export async function extractArchive(archivePath: string, targetDir: string): Promise<void> {
  const args =
    process.platform === 'win32'
      ? ['-xf', archivePath, '-C', targetDir]
      : ['-xzf', archivePath, '-C', targetDir];
  const result = await runCommand('tar', args, { timeoutMs: 300_000 });
  if (result.code !== 0) {
    throw new AppError(
      'ENV_INSTALL_FAILED',
      `解压失败：${result.stderr.trim() || `(退出码 ${result.code})`}`,
    );
  }
}

export interface RunCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Host-layer command runner for installer/doctor steps (not sandboxed). */
export function runCommand(
  command: string,
  args: string[],
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    shell?: boolean;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: options.shell === true,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // already gone
            }
          }, options.timeoutMs);
    timer?.unref?.();
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Recursive on-disk size (installer bookkeeping + settings display). */
export function directorySize(dir: string): number | null {
  let total = 0;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += statSync(full).size;
        } catch {
          // raced away; skip
        }
      }
    }
  };
  try {
    statSync(dir);
  } catch {
    return null;
  }
  walk(dir);
  return total;
}
