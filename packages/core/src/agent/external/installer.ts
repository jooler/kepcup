import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { inflateRawSync } from 'node:zlib';
import {
  AGENT_INSTALL_RELATIVE_GLOB,
  AppError,
  agentIdSchema,
  agentVersionSchema,
  type AgentCatalogEntry,
  type AgentInstallKind,
  type AgentInstallProgress,
  type AgentPlatform,
  type AgentSystemCli,
} from '@kepcup/shared';
import { buildAgentEnv, findOnPath, prepareSpawn } from './host.js';
import { AGENT_NPX_LOCKFILES } from './npx-lockfiles.generated.js';

/**
 * 外部智能体安装器（docs/design/28-external-agents-acp.md §2.1「安装」，D72）。
 *
 * 三种来源，全部落在应用私有 `toolchains/agents/{id}@{version}/`：
 * - `npx`：用环境管理器的 Node 运行时 + 其自带 npm，按**随应用发布的锁文件**
 *   `npm ci --ignore-scripts`（Electron 不带 npm；npm 进程只拿白名单环境）；
 *   运行时以该 Node（缺省回落 `ELECTRON_RUN_AS_NODE=1` 的当前运行时）执行包
 *   的 bin 脚本；
 * - `binary`：下载本平台归档（空闲超时）→ **sha256 校验**（不符即丢弃、拒绝
 *   安装）→ 解压（tar.* 用系统 tar `--no-same-owner --no-same-permissions`；
 *   zip 用内置解析器，符号链接自行创建并做包含性检查，仅 zip64 回落 bsdtar）
 *   → 复检树内符号链接不越界、入口不是符号链接且真实路径在安装目录内 → 可执行位；
 * - `system`：PATH 探测用户已装的官方 CLI，按目录 `versionRange` 校验版本。
 *
 * 安装先进 staging 目录，校验通过后整体 rename 落位，失败不留残留。下载 /
 * 子进程执行 / 解压均可注入（测试用本地文件服务器与假 npm）。
 */

/** 安装目录内的落位记录（launch 解析读它，不再翻 package.json）。 */
const MARKER_FILE = '.kepcup-agent.json';

const INSTALL_TIMEOUT_DEFAULT_MS = 15 * 60_000;
const DETECT_TIMEOUT_MS = 15_000;

export type AgentDownloader = (input: {
  url: string;
  target: string;
  onProgress(received: number, total: number): void;
  signal?: AbortSignal;
  /** 无进展多久即中止（缺省 DOWNLOAD_IDLE_TIMEOUT_MS）。 */
  idleTimeoutMs?: number;
}) => Promise<void>;

export interface AgentExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type AgentExec = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal },
) => Promise<AgentExecResult>;

/** 环境管理器提供的 Node 运行时（npm 随 Node 发行版）。 */
export interface NodeRuntime {
  node: string;
  npmCli: string;
}

export interface AgentInstallerDeps {
  /** `paths.toolchainsDir`；智能体落在其下 `agents/`。 */
  toolchainsDir: string;
  /** `paths.cacheDownloadsDir`（binary 归档的临时下载位置）。 */
  downloadsDir: string;
  /** npm 缓存目录（`paths.cacheNpmDir`）。 */
  npmCacheDir?: string;
  /** 确保并返回环境管理器的 Node 运行时（缺失时由环境管理器安装）。 */
  nodeRuntime(): Promise<NodeRuntime>;
  /** 已安装的环境管理器 Node（同步，launch 解析用）；null = 未安装。 */
  installedNode?(): string | null;
  download?: AgentDownloader;
  exec?: AgentExec;
  platform?: NodeJS.Platform;
  arch?: string;
  /** PATH 等（system 探测；npm 子进程的环境同样只取其白名单部分）。 */
  env?: NodeJS.ProcessEnv;
  installTimeoutMs?: number;
  /** 随应用发布的锁文件（缺省 AGENT_NPX_LOCKFILES）；null = 没有，拒绝安装。 */
  lockfileFor?(spec: string): NpxLockfile | null;
  logger?: { warn(obj: object, message: string): void };
}

function defaultLockfileFor(spec: string): NpxLockfile | null {
  return AGENT_NPX_LOCKFILES[spec] ?? null;
}

/** 一次已落位的安装（marker 内容 + 解析后的绝对路径）。 */
export interface InstalledAgent {
  id: string;
  version: string;
  kind: 'npx' | 'binary';
  dir: string;
  /**
   * 可执行入口（不含 ACP 参数）：binary = 归档内的 cmd；npx = 包的 bin 脚本
   * （经 Node 运行）。terminal 登录命令改写用它。
   */
  entry: string;
  /** 启动 ACP 时追加的参数（目录 `distribution.*.args`）。 */
  args: string[];
  env: Record<string, string>;
}

/** 可执行调用（命令 + 前置参数）；ACP 启动 = 它 + 目录 args。 */
export interface AgentInvocation {
  command: string;
  prefixArgs: string[];
  args: string[];
  env: Record<string, string>;
}

interface MarkerData {
  id: string;
  version: string;
  kind: 'npx' | 'binary';
  /** Relative to the install dir. */
  entry: string;
  args: string[];
  env: Record<string, string>;
}

// --- platform / spec helpers -----------------------------------------------------

/** Node 的 platform / arch → ACP Registry 平台键。 */
export function agentPlatformKey(platform: string, arch: string): AgentPlatform | null {
  const os =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32'
          ? 'windows'
          : null;
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  if (os === null || cpu === null) return null;
  return `${os}-${cpu}` as AgentPlatform;
}

/** `@scope/name@1.2.3` / `name@1.2.3` / `name` → 包名与锁定版本。 */
export function parseNpmSpec(
  spec: string,
  fallbackVersion: string,
): { name: string; version: string } {
  const at = spec.lastIndexOf('@');
  if (at > 0) return { name: spec.slice(0, at), version: spec.slice(at + 1) };
  return { name: spec, version: fallbackVersion };
}

/**
 * binary 归档是否已锁定 sha256（P5）：Registry 未给、导入时也没算出的平台
 * 不可安装——目录 schema 要求每个归档带 sha256，这里对运行时注入 / 未经
 * schema 的条目再守一道（fail-closed）。
 */
export function hasPinnedSha256(target: { sha256?: unknown } | undefined): boolean {
  return typeof target?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(target.sha256);
}

/** 本机可用的分发方式（managed 优先 npx → binary；否则 system；都没有 = none）。 */
export function managedKindFor(
  entry: AgentCatalogEntry,
  platform: string,
  arch: string,
): 'npx' | 'binary' | null {
  if (entry.distribution.npx !== undefined) return 'npx';
  const key = agentPlatformKey(platform, arch);
  if (key !== null && hasPinnedSha256(entry.distribution.binary?.[key])) return 'binary';
  return null;
}

export function installKindFor(
  entry: AgentCatalogEntry,
  platform: string,
  arch: string,
): AgentInstallKind {
  return (
    managedKindFor(entry, platform, arch) ??
    (entry.distribution.system !== undefined ? 'system' : 'none')
  );
}

// --- semver range (system CLI) -----------------------------------------------------

interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

function parseSemver(text: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? '',
  };
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === '') return 1;
  if (b.pre === '') return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** First `x.y.z[-pre]` in a CLI's version output. */
export function extractVersion(output: string): string | null {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0] ?? null;
}

function satisfiesComparator(version: Semver, comparator: string): boolean {
  if (comparator === '*' || comparator === '') return true;
  const op = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(comparator)!;
  const operator = op[1] ?? '';
  const body = op[2]!;
  // x-ranges: 3.14.x / 3.14 / 3.x / 3
  const parts = body.replace(/^v/, '').split('.');
  const wildcard = (part: string | undefined) =>
    part === undefined || part === 'x' || part === 'X' || part === '*';
  if (operator === '' || operator === '=') {
    if (parts.length < 3 || parts.slice(0, 3).some(wildcard)) {
      const major = Number(parts[0]);
      if (!wildcard(parts[0]) && version.major !== major) return false;
      if (!wildcard(parts[1]) && version.minor !== Number(parts[1])) return false;
      if (!wildcard(parts[2]) && version.patch !== Number(parts[2])) return false;
      return true;
    }
  }
  // Partial versions after an operator (`<2`, `>=1.18`) are zero-padded.
  const padded = body.replace(/^v/, '').split('-')[0]!.split('.');
  while (padded.length < 3) padded.push('0');
  const base = parseSemver(
    `${padded.slice(0, 3).join('.')}${body.includes('-') ? body.slice(body.indexOf('-')) : ''}`,
  );
  if (base === null) return false;
  const cmp = compareSemver(version, base);
  switch (operator) {
    case '^': {
      if (cmp < 0) return false;
      if (base.major > 0) return version.major === base.major;
      if (base.minor > 0) return version.major === 0 && version.minor === base.minor;
      return version.major === 0 && version.minor === 0 && version.patch === base.patch;
    }
    case '~':
      return cmp >= 0 && version.major === base.major && version.minor === base.minor;
    case '>=':
      return cmp >= 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '<':
      return cmp < 0;
    default:
      return cmp === 0;
  }
}

/**
 * 最小 semver 范围判定：`||` 分隔的备选，每个备选为空格分隔的比较式（`>=`
 * `>` `<=` `<` `=` `^` `~`、精确版本、`3.14.x` 一类 x-range）。
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (parsed === null) return false;
  return range.split('||').some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .every((comparator) => satisfiesComparator(parsed, comparator)),
  );
}

// --- default IO ----------------------------------------------------------------------

/** Spawns without a shell (Windows `.cmd` via cmd.exe like the agent host). */
export const defaultAgentExec: AgentExec = (command, args, options) =>
  new Promise((resolve) => {
    const prepared = prepareSpawn({ command, args, env: {} });
    let child;
    try {
      child = spawn(prepared.command, prepared.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      });
    } catch (error) {
      resolve({
        code: 127,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = options.timeoutMs !== undefined ? setTimeout(kill, options.timeoutMs) : null;
    timer?.unref?.();
    options.signal?.addEventListener('abort', kill, { once: true });
    const finish = (result: AgentExecResult) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      options.signal?.removeEventListener('abort', kill);
      resolve(result);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) =>
      finish({ code: 127, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });

/** 下载空闲超时：这么久没有收到任何字节即中止（防止卡在 installing）。 */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

export const defaultAgentDownloader: AgentDownloader = async ({
  url,
  target,
  onProgress,
  signal,
  idleTimeoutMs = DOWNLOAD_IDLE_TIMEOUT_MS,
}) => {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason ?? new Error('已取消'));
  if (signal?.aborted === true) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let idle: NodeJS.Timeout | null = null;
  const touch = () => {
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(
      () => controller.abort(new Error(`下载超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有进展`)),
      idleTimeoutMs,
    );
    idle.unref?.();
  };
  try {
    touch();
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || response.body === null) {
      throw new AppError('ENV_INSTALL_FAILED', `下载失败（HTTP ${response.status}）：${url}`);
    }
    const total = Number(response.headers.get('content-length') ?? 0) || 0;
    let received = 0;
    let last = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        touch();
        received += chunk.byteLength;
        const now = Date.now();
        if (now - last > 400) {
          last = now;
          onProgress(received, total);
        }
        callback(null, chunk);
      },
    });
    // pipeline propagates write errors (ENOSPC / EACCES) and aborts.
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      counter,
      createWriteStream(target),
      { signal: controller.signal },
    );
    onProgress(received, total);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    throw new AppError(
      'ENV_INSTALL_FAILED',
      `下载失败：${reason instanceof Error ? reason.message : String(reason)}`,
    );
  } finally {
    if (idle !== null) clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
  }
};

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// --- archives --------------------------------------------------------------------------

export type ArchiveKind = 'zip' | 'tar' | 'raw';

export function archiveKind(url: string): ArchiveKind {
  const name = new URL(url).pathname.toLowerCase();
  if (name.endsWith('.zip')) return 'zip';
  if (/\.(tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2?)$/.test(name)) return 'tar';
  return 'raw';
}

class ZipUnsupportedError extends Error {}

/** `child` 是否位于 `root` 之内（含 root 本身）。 */
export function isInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Resolves an archive member under `dest`; rejects absolute / escaping names. */
function safeMemberPath(dest: string, name: string): string {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new AppError('ENV_INSTALL_FAILED', `归档包含绝对路径：${name}`);
  }
  if (normalized.split('/').includes('..')) {
    throw new AppError('ENV_INSTALL_FAILED', `归档包含越界路径：${name}`);
  }
  return path.join(dest, ...normalized.split('/').filter((part) => part.length > 0));
}

/**
 * A symlink at `link` with target text `target` must stay inside `root` — both
 * lexically from the link's real parent directory and after resolving any
 * further links (chains through other links are followed by realpath).
 */
function assertLinkInside(root: string, link: string, target: string): void {
  if (path.isAbsolute(target) || path.win32.isAbsolute(target)) {
    throw new AppError('ENV_INSTALL_FAILED', `归档中的符号链接指向绝对路径：${target}`);
  }
  const realRoot = realpathSync(root);
  const resolved = path.resolve(realpathSync(path.dirname(link)), target);
  let final = resolved;
  try {
    final = realpathSync(resolved);
  } catch {
    // Dangling (or not yet created) target: the lexical check decides.
  }
  if (!isInside(realRoot, resolved) || !isInside(realRoot, final)) {
    throw new AppError('ENV_INSTALL_FAILED', `归档中的符号链接指向安装目录之外：${target}`);
  }
}

/** Refuses to write through an existing symlink (a member may not reuse a link's path). */
function assertNotLink(file: string): void {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new AppError('ENV_INSTALL_FAILED', `归档成员与符号链接重名：${file}`);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    // ENOENT: nothing there yet.
  }
}

/**
 * 解压后复检：树内每个符号链接都必须指向 `root` 之内（tar 归档的链接由系统
 * tar 创建，这里统一拒绝越界链接）。
 */
export function assertTreeContained(root: string): void {
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) {
        assertLinkInside(root, full, readlinkSync(full));
      } else if (item.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
}

/**
 * Minimal zip extractor (stored / deflate, no encryption). Symlink members are
 * created here with a containment check (never handed to `unzip`, which would
 * write through links); zip64 raises ZipUnsupportedError so the caller can fall
 * back to bsdtar.
 */
export function extractZip(file: string, dest: string): void {
  const buf = readFileSync(file);
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new AppError('ENV_INSTALL_FAILED', 'zip 归档损坏（缺少目录结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipUnsupportedError('zip64');
  let pointer = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (buf.readUInt32LE(pointer) !== 0x02014b50) {
      throw new AppError('ENV_INSTALL_FAILED', 'zip 归档损坏（中央目录）');
    }
    const madeBy = buf.readUInt16LE(pointer + 4) >> 8;
    const flags = buf.readUInt16LE(pointer + 8);
    const method = buf.readUInt16LE(pointer + 10);
    const compressedSize = buf.readUInt32LE(pointer + 20);
    const nameLength = buf.readUInt16LE(pointer + 28);
    const extraLength = buf.readUInt16LE(pointer + 30);
    const commentLength = buf.readUInt16LE(pointer + 32);
    const externalAttrs = buf.readUInt32LE(pointer + 38);
    const localOffset = buf.readUInt32LE(pointer + 42);
    const name = buf.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength + extraLength + commentLength;
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipUnsupportedError('zip64');
    }
    if ((flags & 0x1) !== 0) throw new AppError('ENV_INSTALL_FAILED', 'zip 归档已加密');
    const unixMode = madeBy === 3 ? (externalAttrs >>> 16) & 0xffff : 0;
    const target = safeMemberPath(dest, name);
    // Parent directories created by earlier members must not be links that
    // lead outside (links are contained, see below) — and the member path
    // itself must not already be a link.
    assertNotLink(target);
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new AppError('ENV_INSTALL_FAILED', 'zip 归档损坏（本地头）');
    }
    const dataStart =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new ZipUnsupportedError(`method ${method}`);
    mkdirSync(path.dirname(target), { recursive: true });
    if (!isInside(realpathSync(dest), realpathSync(path.dirname(target)))) {
      throw new AppError('ENV_INSTALL_FAILED', `归档成员经符号链接越界：${name}`);
    }
    if ((unixMode & 0o170000) === 0o120000) {
      const linkTarget = data.toString('utf8');
      assertLinkInside(dest, target, linkTarget);
      symlinkSync(linkTarget, target);
      continue;
    }
    writeFileSync(target, data);
    const mode = unixMode & 0o777;
    if (mode !== 0 && process.platform !== 'win32') chmodSync(target, mode);
  }
}

// --- npm lockfiles ---------------------------------------------------------------------

/**
 * 目录条目的窄化安装后步骤（`npx.postInstall.chmodExecutable`，审查 H3）：
 * 安装根内匹配 `pattern`（`/` 分隔，段可为 `*`）的**普通文件**改为 0755；
 * 符号链接、目录、指向安装根之外的一律跳过。返回改动的文件数。
 */
export function chmodInstalledFiles(root: string, pattern: string): number {
  if (!AGENT_INSTALL_RELATIVE_GLOB.test(pattern)) return 0;
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return 0;
  }
  let current = [root];
  for (const segment of pattern.split('/')) {
    const next: string[] = [];
    for (const dir of current) {
      if (segment === '*') {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) next.push(path.join(dir, name));
      } else {
        next.push(path.join(dir, segment));
      }
    }
    current = next;
  }
  let changed = 0;
  for (const file of current) {
    let stats;
    try {
      stats = lstatSync(file);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    // A symlinked directory on the way must not lead out of the install root.
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      continue;
    }
    if (!isInside(rootReal, real)) continue;
    chmodSync(file, 0o755);
    changed += 1;
  }
  return changed;
}

/** 随应用发布的 npx 锁文件（`npm ci` 用）：键为 `包名@版本`。 */
export interface NpxLockfile {
  packageJson: unknown;
  lockfile: unknown;
}

/** npm 子进程的环境：白名单（不带 KepCup 进程的密钥 / NODE_OPTIONS）+ npm 配置。 */
export function npmEnv(
  source: NodeJS.ProcessEnv,
  nodeDir: string,
  platform: NodeJS.Platform,
  npmCacheDir: string | undefined,
): Record<string, string> {
  const base = buildAgentEnv(source, {});
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathKey = platform === 'win32' && base.Path !== undefined ? 'Path' : 'PATH';
  return {
    ...base,
    [pathKey]: `${nodeDir}${delimiter}${base[pathKey] ?? ''}`,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_ignore_scripts: 'true',
    ...(npmCacheDir !== undefined ? { npm_config_cache: npmCacheDir } : {}),
  };
}

/** `npm ci`：按随应用发布的锁文件安装，不跑生命周期脚本、不装 devDependencies。 */
export function npmCiArgs(npmCli: string, prefix: string): string[] {
  return [
    npmCli,
    'ci',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ];
}

// --- installer ------------------------------------------------------------------------

export class AgentInstaller {
  readonly #deps: AgentInstallerDeps;

  constructor(deps: AgentInstallerDeps) {
    this.#deps = deps;
  }

  get #platform(): NodeJS.Platform {
    return this.#deps.platform ?? process.platform;
  }

  get #arch(): string {
    return this.#deps.arch ?? process.arch;
  }

  get #exec(): AgentExec {
    return this.#deps.exec ?? defaultAgentExec;
  }

  /** `toolchains/agents/`。 */
  get rootDir(): string {
    return path.join(this.#deps.toolchainsDir, 'agents');
  }

  /** 安装目录；id / 版本不合法或拼出的路径不在 rootDir 内时抛错。 */
  dirFor(agentId: string, version: string): string {
    if (
      !agentIdSchema.safeParse(agentId).success ||
      !agentVersionSchema.safeParse(version).success
    ) {
      throw new AppError('INVALID_INPUT', `非法的智能体版本：${agentId}@${version}`);
    }
    const dir = path.join(this.rootDir, `${agentId}@${version}`);
    if (path.dirname(dir) !== this.rootDir) {
      throw new AppError('INVALID_INPUT', `非法的智能体安装目录：${agentId}@${version}`);
    }
    return dir;
  }

  kindFor(entry: AgentCatalogEntry): AgentInstallKind {
    return installKindFor(entry, this.#platform, this.#arch);
  }

  managedKind(entry: AgentCatalogEntry): 'npx' | 'binary' | null {
    return managedKindFor(entry, this.#platform, this.#arch);
  }

  /** 安装来源说明（安装确认卡）。 */
  sourceText(entry: AgentCatalogEntry): string {
    const kind = this.kindFor(entry);
    if (kind === 'npx') {
      const spec = parseNpmSpec(entry.distribution.npx!.package, entry.version);
      return `npm: ${spec.name}@${spec.version}`;
    }
    if (kind === 'binary') {
      const key = agentPlatformKey(this.#platform, this.#arch)!;
      return entry.distribution.binary![key]!.archive;
    }
    if (kind === 'system') return entry.distribution.system!.cmd;
    return '';
  }

  // --- queries ----------------------------------------------------------------

  /**
   * 某版本的落位记录；目录缺失、入口文件丢失、入口是符号链接或解析到安装
   * 目录之外 = null。
   */
  installed(agentId: string, version: string): InstalledAgent | null {
    let dir: string;
    try {
      dir = this.dirFor(agentId, version);
    } catch {
      return null;
    }
    let marker: MarkerData;
    try {
      marker = JSON.parse(readFileSync(path.join(dir, MARKER_FILE), 'utf8')) as MarkerData;
    } catch {
      return null;
    }
    if (marker.id !== agentId || marker.version !== version) return null;
    if (typeof marker.entry !== 'string') return null;
    const entry = path.resolve(dir, marker.entry);
    if (!isInside(dir, entry) || entry === dir) return null;
    try {
      if (lstatSync(entry).isSymbolicLink()) return null;
      if (!isInside(realpathSync(dir), realpathSync(entry))) return null;
    } catch {
      return null;
    }
    return {
      id: marker.id,
      version: marker.version,
      kind: marker.kind,
      dir,
      entry,
      args: Array.isArray(marker.args) ? [...marker.args] : [],
      env: { ...(marker.env ?? {}) },
    };
  }

  /** 已落位的版本（含旧版本，用于卸载与 update_available）。 */
  installedVersions(agentId: string): string[] {
    let names: string[];
    try {
      names = readdirSync(this.rootDir);
    } catch {
      return [];
    }
    const prefix = `${agentId}@`;
    return names
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
      .filter((version) => this.installed(agentId, version) !== null);
  }

  /** 已安装条目的启动方式（npx 的 bin 脚本经 Node 运行）。 */
  invocation(installed: InstalledAgent): AgentInvocation {
    if (installed.kind === 'binary') {
      return { command: installed.entry, prefixArgs: [], args: installed.args, env: installed.env };
    }
    const node = this.#deps.installedNode?.() ?? null;
    return {
      command: node ?? process.execPath,
      prefixArgs: [installed.entry],
      args: installed.args,
      env: node === null ? { ...installed.env, ELECTRON_RUN_AS_NODE: '1' } : installed.env,
    };
  }

  /** system 来源的启动方式（同步 PATH 查找）；未找到 = null。 */
  systemInvocation(entry: AgentCatalogEntry): AgentInvocation | null {
    const system = entry.distribution.system;
    if (system === undefined) return null;
    const command = findOnPath(system.cmd, {
      ...(this.#deps.env !== undefined ? { env: this.#deps.env } : {}),
      platform: this.#platform,
    });
    if (command === null) return null;
    return { command, prefixArgs: [], args: [...(system.args ?? [])], env: {} };
  }

  /** 探测用户已装的官方 CLI 与版本范围（「使用系统已安装的 CLI」）。 */
  async detectSystem(entry: AgentCatalogEntry): Promise<AgentSystemCli | null> {
    const system = entry.distribution.system;
    if (system === undefined) return null;
    const versionRange = system.versionRange ?? null;
    const invocation = this.systemInvocation(entry);
    if (invocation === null) {
      return { found: false, path: null, version: null, versionRange, compatible: false };
    }
    const result = await this.#exec(invocation.command, system.detect, {
      timeoutMs: DETECT_TIMEOUT_MS,
      ...(this.#deps.env !== undefined ? { env: this.#deps.env } : {}),
    });
    const version = result.code === 0 ? extractVersion(`${result.stdout}\n${result.stderr}`) : null;
    const compatible =
      result.code === 0 &&
      (versionRange === null || (version !== null && satisfiesRange(version, versionRange)));
    return { found: true, path: invocation.command, version, versionRange, compatible };
  }

  // --- install / uninstall ---------------------------------------------------------

  /** 安装目录条目的锁定版本（managed：npx / binary）；成功返回落位记录。 */
  async install(
    entry: AgentCatalogEntry,
    options: { onProgress?(progress: AgentInstallProgress): void; signal?: AbortSignal } = {},
  ): Promise<InstalledAgent> {
    const kind = this.managedKind(entry);
    if (kind === null) {
      throw new AppError(
        'AGENT_INCOMPATIBLE',
        `智能体「${entry.name}」没有适用于本平台（${this.#platform}-${this.#arch}）的安装包`,
      );
    }
    const finalDir = this.dirFor(entry.id, entry.version);
    const staging = path.join(this.rootDir, `.staging-${entry.id}@${entry.version}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const progress = options.onProgress ?? (() => undefined);
    try {
      const marker =
        kind === 'npx'
          ? await this.#installNpx(entry, staging, progress, options.signal)
          : await this.#installBinary(entry, staging, progress, options.signal);
      if (options.signal?.aborted === true) throw new AppError('ENV_INSTALL_FAILED', '安装已取消');
      progress({ stage: 'checking' });
      writeFileSync(path.join(staging, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
      rmSync(finalDir, { recursive: true, force: true });
      renameSync(staging, finalDir);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (error instanceof AppError) throw error;
      throw new AppError(
        'ENV_INSTALL_FAILED',
        `智能体「${entry.name}」安装失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const installed = this.installed(entry.id, entry.version);
    if (installed === null) {
      throw new AppError('ENV_VERIFY_FAILED', `智能体「${entry.name}」安装后未找到入口文件`);
    }
    return installed;
  }

  /** 删除该 Agent 的全部版本（及残留 staging）。 */
  uninstall(agentId: string): void {
    let names: string[];
    try {
      names = readdirSync(this.rootDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(`${agentId}@`) || name.startsWith(`.staging-${agentId}@`)) {
        rmSync(path.join(this.rootDir, name), { recursive: true, force: true });
      }
    }
  }

  /** The entry file must be a regular file whose real path stays inside `root`. */
  #assertEntry(root: string, entryPath: string, label: string): void {
    let stat;
    try {
      stat = lstatSync(entryPath);
    } catch {
      throw new AppError('ENV_VERIFY_FAILED', `安装包中未找到入口 ${label}`);
    }
    if (stat.isSymbolicLink()) {
      throw new AppError('ENV_VERIFY_FAILED', `安装包的入口 ${label} 是符号链接，已拒绝`);
    }
    if (!stat.isFile()) throw new AppError('ENV_VERIFY_FAILED', `安装包中未找到入口 ${label}`);
    if (!isInside(realpathSync(root), realpathSync(entryPath))) {
      throw new AppError('ENV_VERIFY_FAILED', `安装包的入口 ${label} 位于安装目录之外，已拒绝`);
    }
  }

  async #installNpx(
    entry: AgentCatalogEntry,
    staging: string,
    progress: (progress: AgentInstallProgress) => void,
    signal?: AbortSignal,
  ): Promise<MarkerData> {
    const npx = entry.distribution.npx!;
    const spec = parseNpmSpec(npx.package, entry.version);
    // Exact versions with the app-shipped lockfile only (`npm ci`): a semver
    // range in a transitive dependency must not drift between installs.
    const lock = (this.#deps.lockfileFor ?? defaultLockfileFor)(`${spec.name}@${spec.version}`);
    if (lock === null) {
      throw new AppError(
        'AGENT_INCOMPATIBLE',
        `智能体「${entry.name}」缺少随应用发布的锁文件（${spec.name}@${spec.version}）：请运行 scripts/generate-agent-lockfiles.mjs`,
      );
    }
    progress({ stage: 'preparing' });
    const runtime = await this.#deps.nodeRuntime();
    writeFileSync(
      path.join(staging, 'package.json'),
      `${JSON.stringify(lock.packageJson, null, 2)}\n`,
    );
    writeFileSync(
      path.join(staging, 'package-lock.json'),
      `${JSON.stringify(lock.lockfile, null, 2)}\n`,
    );
    progress({ stage: 'installing' });
    const result = await this.#exec(runtime.node, npmCiArgs(runtime.npmCli, staging), {
      cwd: staging,
      env: npmEnv(
        this.#deps.env ?? process.env,
        path.dirname(runtime.node),
        this.#platform,
        this.#deps.npmCacheDir,
      ),
      timeoutMs: this.#deps.installTimeoutMs ?? INSTALL_TIMEOUT_DEFAULT_MS,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim())
        .split('\n')
        .slice(-5)
        .join('\n');
      throw new AppError(
        'ENV_INSTALL_FAILED',
        `npm 安装 ${spec.name}@${spec.version} 失败（退出码 ${result.code}）：${detail}`,
      );
    }
    if (this.#platform !== 'win32') {
      for (const pattern of npx.postInstall?.chmodExecutable ?? []) {
        // Zero matches = the package layout changed: the step silently did
        // nothing, worth a look (审查 #15).
        if (chmodInstalledFiles(staging, pattern) === 0) {
          this.#deps.logger?.warn(
            { agentId: entry.id, pattern },
            'agent post-install chmod matched no file',
          );
        }
      }
    }
    const packageDir = path.join(staging, 'node_modules', ...spec.name.split('/'));
    const bin = packageBin(packageDir, spec.name);
    if (bin === null) {
      throw new AppError('ENV_VERIFY_FAILED', `npm 包 ${spec.name} 未声明可执行入口（bin）`);
    }
    const entryPath = path.resolve(packageDir, bin);
    if (!isInside(packageDir, entryPath)) {
      throw new AppError('ENV_VERIFY_FAILED', `npm 包 ${spec.name} 的入口位于包目录之外：${bin}`);
    }
    this.#assertEntry(staging, entryPath, bin);
    return {
      id: entry.id,
      version: entry.version,
      kind: 'npx',
      entry: path.relative(staging, entryPath),
      args: [...(npx.args ?? [])],
      env: { ...(npx.env ?? {}) },
    };
  }

  async #installBinary(
    entry: AgentCatalogEntry,
    staging: string,
    progress: (progress: AgentInstallProgress) => void,
    signal?: AbortSignal,
  ): Promise<MarkerData> {
    const key = agentPlatformKey(this.#platform, this.#arch)!;
    const target = entry.distribution.binary![key]!;
    if (!hasPinnedSha256(target)) {
      // Never download / run an archive whose checksum is not pinned.
      throw new AppError(
        'AGENT_INCOMPATIBLE',
        `智能体「${entry.name}」在本平台（${key}）的安装包未锁定 sha256，拒绝安装`,
      );
    }
    mkdirSync(this.#deps.downloadsDir, { recursive: true });
    const kind = archiveKind(target.archive);
    const download = path.join(
      this.#deps.downloadsDir,
      `agent-${entry.id}-${entry.version}-${key}${kind === 'zip' ? '.zip' : kind === 'tar' ? '.tar' : '.bin'}`,
    );
    rmSync(download, { force: true });
    try {
      // `sizeBytes` is the unpacked size (approval card), not the download:
      // the progress total comes from the response's Content-Length (审查 LOW).
      progress({ stage: 'downloading' });
      await (this.#deps.download ?? defaultAgentDownloader)({
        url: target.archive,
        target: download,
        onProgress: (received, total) =>
          progress({
            stage: 'downloading',
            receivedBytes: received,
            ...(total > 0 ? { totalBytes: total } : {}),
          }),
        ...(signal !== undefined ? { signal } : {}),
      });
      progress({ stage: 'verifying' });
      const actual = await sha256File(download);
      if (actual !== target.sha256) {
        throw new AppError(
          'ENV_CHECKSUM_MISMATCH',
          `智能体「${entry.name}」下载内容校验失败（期望 ${target.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），已丢弃`,
        );
      }
      progress({ stage: 'extracting' });
      const extracted = path.join(staging, 'dist');
      mkdirSync(extracted, { recursive: true });
      if (kind === 'raw') {
        renameSync(download, safeMemberPath(extracted, path.posix.basename(target.cmd)));
      } else {
        await this.#extract(download, kind, extracted);
      }
      assertTreeContained(extracted);
      let entryPath = safeMemberPath(extracted, target.cmd);
      if (!existsSync(entryPath)) {
        // Archives with a single root directory: cmd is relative to that root.
        const roots = readdirSync(extracted, { withFileTypes: true });
        if (roots.length === 1 && roots[0]!.isDirectory()) {
          entryPath = safeMemberPath(path.join(extracted, roots[0]!.name), target.cmd);
        }
      }
      this.#assertEntry(extracted, entryPath, target.cmd);
      if (this.#platform !== 'win32') chmodSync(entryPath, 0o755);
      return {
        id: entry.id,
        version: entry.version,
        kind: 'binary',
        entry: path.relative(staging, entryPath),
        args: [...(target.args ?? [])],
        env: {},
      };
    } finally {
      rmSync(download, { force: true });
    }
  }

  async #extract(archive: string, kind: 'zip' | 'tar', dest: string): Promise<void> {
    if (kind === 'zip') {
      try {
        extractZip(archive, dest);
        return;
      } catch (error) {
        if (!(error instanceof ZipUnsupportedError)) throw error;
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(dest, { recursive: true });
      }
      // zip64 only: bsdtar (macOS / Windows 10+) reads it and refuses to
      // write through links; `unzip` is never used (it follows links).
    }
    // GNU tar / bsdtar detect the compression themselves with -x; never keep
    // the archive's owners or exact permissions.
    const result = await this.#exec(
      'tar',
      ['-xf', archive, '-C', dest, '--no-same-owner', '--no-same-permissions'],
      { timeoutMs: 600_000 },
    );
    if (result.code !== 0) {
      throw new AppError(
        'ENV_INSTALL_FAILED',
        `解压失败：${result.stderr.trim() || `(退出码 ${result.code})`}`,
      );
    }
  }
}

/** package.json `bin`：字符串，或与（去 scope 的）包名同名 / 唯一的条目。 */
function packageBin(packageDir: string, name: string): string | null {
  let manifest: { bin?: unknown };
  try {
    manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      bin?: unknown;
    };
  } catch {
    return null;
  }
  const bin = manifest.bin;
  if (typeof bin === 'string') return bin;
  if (bin === null || typeof bin !== 'object') return null;
  const entries = Object.entries(bin as Record<string, unknown>).filter(
    (pair): pair is [string, string] => typeof pair[1] === 'string',
  );
  const bare = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  return (
    entries.find(([key]) => key === bare)?.[1] ?? (entries.length === 1 ? entries[0]![1] : null)
  );
}

/** 环境管理器 Node 安装目录 → node 与 npm-cli.js（Unix: bin/node；Windows: node.exe）。 */
export function nodeRuntimeFromBinDir(binDir: string, platform: NodeJS.Platform): NodeRuntime {
  const node = path.join(binDir, platform === 'win32' ? 'node.exe' : 'node');
  const root = platform === 'win32' ? binDir : path.dirname(binDir);
  const npmCli =
    platform === 'win32'
      ? path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return { node, npmCli };
}
