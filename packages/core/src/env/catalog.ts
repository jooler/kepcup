import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Installable host environments (docs/dev/phases/P06-environment.md 任务 1).
 * Versions and checksums are pinned here; upgrading = a code change. Sources
 * are official release pages only (no mirrors). Platform artifact checksums
 * come from the official `.sha256` files (uv), the official SHASUMS256.txt
 * (node) or were computed from the official release artifacts (MinGit, which
 * publishes no checksum files) — see PROGRESS.md P06 for the verification
 * record of URLs + values.
 *
 * The catalog is pure data (JSON-serializable) so tests can inject a local
 * file server version via `KEPCUP_ENV_CATALOG_FILE` / CoreServicesOptions.
 */

export const CATALOG_PLATFORM_KEYS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
  'win32-arm64',
] as const;
export type CatalogPlatformKey = (typeof CATALOG_PLATFORM_KEYS)[number];

/**
 * One downloadable artifact of a `files` install (P07 向量模型 / ONNX 运行库).
 * A `files` entry lists several pinned artifacts that land in one install
 * directory — plain files are copied under `name`, archives are extracted and
 * their single root directory is moved to `extract.dest`.
 */
export interface CatalogFile {
  /** File name inside cache/downloads (and, for plain files, the install dir). */
  name: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  /**
   * Present = the artifact is a tar.gz/zip: extract it and move its single
   * root directory to `dest` (relative to the install dir; '' = the install
   * dir itself). Absent = a plain file placed at `name`.
   */
  extract?: { dest: string };
}

/** One platform artifact of a catalog entry (docs: url/sha256/sizeBytes/kind). */
export interface CatalogPlatform {
  /** Official download URL; '' when this platform is not downloaded by us. */
  url: string;
  /** sha256 of the download; '' when nothing is downloaded. */
  sha256: string;
  /** Bytes shown on the approval card (download size, or installed size for uv-python). */
  sizeBytes: number;
  /**
   * - `archive`: we download + extract the artifact.
   * - `files`: the entry downloads the per-artifact list on `install.files`
   *   (platform-independent; every platform key shares the same files).
   * - `installer-script`: reserved (scripted installers, unused in P06).
   * - `system`: installed by the OS / the user; we only detect.
   * - `uv-python`: Python provided by `uv python install` (uv downloads).
   */
  kind: 'archive' | 'installer-script' | 'system' | 'uv-python' | 'files';
}

/** How the installer materializes the entry (interpreted per item). */
export type CatalogInstall =
  | { via: 'archive' }
  | { via: 'files'; files: CatalogFile[] }
  | { via: 'uv-python'; pythonVersion: string }
  | {
      via: 'system';
      /** macOS: run `xcode-select --install` after approval (system-owned auth). */
      macAction?: 'xcode-select';
      /** Linux: show the distro install command on the card; user runs it. */
      linuxGuide: boolean;
      /**
       * P12: localized guidance for system items without a single automatic
       * action (lima: brew, podman: distro package). Shown on the card and
       * in the pending-system notice.
       */
      guide?: string;
    };

export interface CatalogEntry {
  item: string;
  version: string;
  displayName: string;
  /** Official source (release page), shown on the card. */
  source: string;
  install: CatalogInstall;
  platforms: Partial<Record<CatalogPlatformKey, CatalogPlatform>>;
  /**
   * Health check run on the host (doctor + installer verification).
   * - `{bin}` mode: `{bin}` resolves to the item's primary executable, `{dir}`
   *   to the install directory; `expect` is a substring of stdout.
   * - `files` mode: every listed path (relative to the install directory)
   *   must exist — used by items without an executable (model / runtime).
   */
  verify: CatalogVerify;
  /**
   * P12: binary name to detect when it differs from `item` (lima ships the
   * `limactl` CLI).
   */
  detectBin?: string;
  /**
   * P12: on a Windows host this item installs INTO the private WSL2 distro
   * (linux-x64 / linux-arm64 artifacts, docs/dev/phases/P12 任务书「工具链」)
   * instead of the Windows toolchains directory.
   */
  wslDistro?: boolean;
  /**
   * Placeholder entry: the artifact pinning is awaiting a decision, so the
   * entry exists for the approval flow but nothing is downloaded yet.
   * Cleared when the entry is pinned (see the DEV-007 history).
   */
  downloadPending?: boolean;
}

export type Catalog = CatalogEntry[];

/**
 * Verify step of a catalog entry: either a host command (`{bin}`/`{dir}`
 * placeholders, `expect` substring of stdout) or a file-existence list
 * (relative to the install directory) for executable-less items.
 */
export type CatalogVerify = { command: string; expect: string } | { files: string[] };

export function isFileVerify(verify: CatalogVerify): verify is { files: string[] } {
  return Object.keys(verify).length === 1 && 'files' in verify;
}

const platformSchema = z.object({
  url: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().int().min(0),
  kind: z.enum(['archive', 'installer-script', 'system', 'uv-python', 'files']),
});

export const catalogFileSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive(),
  extract: z.object({ dest: z.string() }).optional(),
});

export const catalogVerifySchema = z.union([
  z.object({ command: z.string().min(1), expect: z.string().min(1) }),
  z.object({ files: z.array(z.string().min(1)).min(1) }),
]);

export const catalogEntrySchema = z.object({
  item: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().min(1),
  source: z.string(),
  install: z.union([
    z.object({ via: z.literal('archive') }),
    z.object({ via: z.literal('files'), files: z.array(catalogFileSchema).min(1) }),
    z.object({ via: z.literal('uv-python'), pythonVersion: z.string().min(1) }),
    z.object({
      via: z.literal('system'),
      macAction: z.literal('xcode-select').optional(),
      linuxGuide: z.boolean(),
      guide: z.string().optional(),
    }),
  ]),
  platforms: z.record(z.string(), platformSchema),
  verify: catalogVerifySchema,
  detectBin: z.string().min(1).optional(),
  wslDistro: z.boolean().optional(),
  downloadPending: z.boolean().optional(),
});

export const catalogSchema = z.array(catalogEntrySchema);

/**
 * Per-kind field completeness (unit-tested): archive entries carry a real URL
 * + checksum; uv-python/system entries are not downloaded by us and leave
 * them empty. Every entry must list the platforms its item supports.
 */
export function validateCatalog(catalog: Catalog): string[] {
  const errors: string[] = [];
  const items = new Set<string>();
  for (const entry of catalog) {
    if (items.has(entry.item)) errors.push(`duplicate item: ${entry.item}`);
    items.add(entry.item);
    const parsed = catalogEntrySchema.safeParse(entry);
    if (!parsed.success) {
      errors.push(`${entry.item}: schema mismatch: ${parsed.error.message}`);
      continue;
    }
    if (
      !isFileVerify(entry.verify) &&
      entry.verify.command.includes('{bin}') === false &&
      entry.verify.command.includes('{dir}') === false &&
      entry.item !== 'git'
    ) {
      errors.push(`${entry.item}: verify command must reference {bin} or {dir}`);
    }
    const keys = Object.keys(entry.platforms) as CatalogPlatformKey[];
    if (keys.length === 0) errors.push(`${entry.item}: no platform entries`);
    for (const key of keys) {
      if (!CATALOG_PLATFORM_KEYS.includes(key)) {
        errors.push(`${entry.item}: unknown platform ${key}`);
        continue;
      }
      const platform = entry.platforms[key];
      if (!platform) continue;
      // downloadPending entries (placeholder) carry a sizeBytes placeholder
      // and no pinned artifact yet — nothing is downloaded.
      if (entry.downloadPending === true) {
        if (platform.url.length > 0 || platform.sha256.length > 0) {
          errors.push(`${entry.item}/${key}: downloadPending must not carry url/sha256`);
        }
        continue;
      }
      if (platform.kind === 'files') {
        // The artifact list lives on install.files (platform-independent);
        // the platform entry only records the total download size per key.
        if (entry.install.via !== 'files') {
          errors.push(`${entry.item}/${key}: kind=files requires install.via=files`);
        }
        if (platform.url.length > 0 || platform.sha256.length > 0) {
          errors.push(`${entry.item}/${key}: files kind must not carry url/sha256`);
        }
        if (platform.sizeBytes <= 0)
          errors.push(`${entry.item}/${key}: files kind without sizeBytes`);
        continue;
      }
      if (platform.kind === 'archive' || platform.kind === 'installer-script') {
        if (platform.url.length === 0) errors.push(`${entry.item}/${key}: archive without url`);
        if (!/^[0-9a-f]{64}$/.test(platform.sha256)) {
          errors.push(`${entry.item}/${key}: archive without sha256`);
        }
        if (platform.sizeBytes <= 0) errors.push(`${entry.item}/${key}: archive without sizeBytes`);
      } else if (platform.url.length > 0 || platform.sha256.length > 0) {
        errors.push(`${entry.item}/${key}: ${platform.kind} must not carry url/sha256`);
      }
    }
    // The approval card shows one size per item — it must equal the artifact
    // sum so the user isn't shown a made-up number.
    if (entry.install.via === 'files') {
      const total = entry.install.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      for (const [key, platform] of Object.entries(entry.platforms)) {
        if (platform && platform.kind === 'files' && platform.sizeBytes !== total) {
          errors.push(
            `${entry.item}/${key}: sizeBytes ${platform.sizeBytes} != sum(files) ${total}`,
          );
        }
      }
      // name 是缓存文件名与平铺落位路径：不允许路径分隔符。extract.dest 是
      // 安装目录内的相对路径：不允许绝对路径与 ..（防落位逃出安装目录）。
      // dest='' 表示归档单根即安装目录本身——一个条目至多一个，两个会互相
      // 覆盖（installer 顺序 rename）。
      const names = new Set<string>();
      let rootExtracts = 0;
      for (const file of entry.install.files) {
        if (names.has(file.name)) errors.push(`${entry.item}: duplicate file name ${file.name}`);
        names.add(file.name);
        if (/[/\\]/.test(file.name)) {
          errors.push(`${entry.item}: file name must not contain path separators: ${file.name}`);
        }
        if (file.extract !== undefined) {
          const dest = file.extract.dest;
          if (path.posix.isAbsolute(dest) || /^[a-zA-Z]:/.test(dest)) {
            errors.push(`${entry.item}: extract.dest must be relative: ${dest}`);
          }
          if (dest.split('/').includes('..')) {
            errors.push(`${entry.item}: extract.dest must not traverse up: ${dest}`);
          }
          if (dest === '') rootExtracts += 1;
        }
      }
      if (rootExtracts > 1) {
        errors.push(`${entry.item}: at most one file may extract to the install dir root`);
      }
    }
  }
  return errors;
}

export function platformKey(platform: string, arch: string): CatalogPlatformKey | null {
  switch (`${platform}-${arch}`) {
    case 'darwin-arm64':
    case 'darwin-x64':
    case 'linux-x64':
    case 'linux-arm64':
    case 'win32-x64':
    case 'win32-arm64':
      return `${platform}-${arch}` as CatalogPlatformKey;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pinned catalog (verified against official release pages on 2026-09-30,
// see PROGRESS.md P06 "catalog 核对记录").
// ---------------------------------------------------------------------------

const UV_VERSION = '0.12.21';
const NODE_VERSION = '24.21.0';
const PYTHON_VERSION = '3.12.11';
const GIT_VERSION = '2.56.0';
/** ONNX Runtime（本地向量推理的运行库）版本，与 onnxruntime-common 同版。 */
export const ONNXRUNTIME_VERSION = '1.30.0';
/** 本地向量模型（bge-small-zh-v1.5 ONNX 导出）版本。 */
export const EMBEDDING_MODEL_VERSION = '1.5';

/** sizeBytes are the exact artifact sizes from the official servers (HEAD). */
export const ENV_CATALOG: Catalog = [
  {
    item: 'uv',
    version: UV_VERSION,
    displayName: 'uv',
    source: 'https://github.com/astral-sh/uv/releases',
    install: { via: 'archive' },
    platforms: {
      'darwin-arm64': {
        url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`,
        sha256: 'b88bda573e566ef9bced66b155fe0408626fbbc053aee1c30ba686f0728c9447',
        sizeBytes: 17_001_427,
        kind: 'archive',
      },
      'darwin-x64': {
        url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-apple-darwin.tar.gz`,
        sha256: '2b336763b396ec6afa20c5a8b083538ca7402445b868311979d740a4344c17d8',
        sizeBytes: 20_741_769,
        kind: 'archive',
      },
      'linux-x64': {
        url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz`,
        sha256: '23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0',
        sizeBytes: 19_782_662,
        kind: 'archive',
      },
      'linux-arm64': {
        url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz`,
        sha256: '030b69227b40af8c1981b7301793dc66e71ed3c796ea8688209dd268bd91ec51',
        sizeBytes: 18_943_621,
        kind: 'archive',
      },
      'win32-x64': {
        url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
        sha256: '5d223efa0bf00208c3853246af09420419dfbd352536aa6bb8163d6170e23890',
        sizeBytes: 17_992_232,
        kind: 'archive',
      },
      'win32-arm64': {
        url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-pc-windows-msvc.zip`,
        sha256: '93ed53b94e9cec000cacdfd18ca67bc4cb2b6a5f5ec041edd7f2a3dae365ce79',
        sizeBytes: 19_274_675,
        kind: 'archive',
      },
    },
    verify: { command: '"{bin}" --version', expect: `uv ${UV_VERSION}` },
  },
  {
    // Python is materialized by `uv python install` (python-build-standalone
    // via uv's own registry); we set UV_PYTHON_INSTALL_DIR into the toolchain
    // directory and never download Python artifacts ourselves.
    // P12: on a Windows host the install goes INTO the WSL2 distro (uv ships
    // in the rootfs); see EnvManager's distro branch.
    item: 'python',
    version: PYTHON_VERSION,
    displayName: 'Python',
    source: 'https://github.com/astral-sh/python-build-standalone/releases (via uv)',
    install: { via: 'uv-python', pythonVersion: PYTHON_VERSION },
    wslDistro: true,
    platforms: {
      'darwin-arm64': { url: '', sha256: '', sizeBytes: 49_434_624, kind: 'uv-python' },
      'darwin-x64': { url: '', sha256: '', sizeBytes: 52_000_000, kind: 'uv-python' },
      'linux-x64': { url: '', sha256: '', sizeBytes: 57_000_000, kind: 'uv-python' },
      'linux-arm64': { url: '', sha256: '', sizeBytes: 55_000_000, kind: 'uv-python' },
      'win32-x64': { url: '', sha256: '', sizeBytes: 60_000_000, kind: 'uv-python' },
      'win32-arm64': { url: '', sha256: '', sizeBytes: 58_000_000, kind: 'uv-python' },
    },
    verify: { command: '"{bin}" --version', expect: `Python ${PYTHON_VERSION}` },
  },
  {
    item: 'node',
    version: NODE_VERSION,
    displayName: 'Node.js',
    source: 'https://nodejs.org/dist/',
    install: { via: 'archive' },
    // P12: on a Windows host the linux tarball installs INTO the WSL2 distro.
    wslDistro: true,
    platforms: {
      'darwin-arm64': {
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
        sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
        sizeBytes: 52_909_993,
        kind: 'archive',
      },
      'darwin-x64': {
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`,
        sha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
        sizeBytes: 54_203_979,
        kind: 'archive',
      },
      'linux-x64': {
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz`,
        sha256: '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
        sizeBytes: 58_088_022,
        kind: 'archive',
      },
      'linux-arm64': {
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.gz`,
        sha256: '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
        sizeBytes: 57_824_078,
        kind: 'archive',
      },
      'win32-x64': {
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
        sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
        sizeBytes: 37_618_919,
        kind: 'archive',
      },
      // Node upstream publishes no win32-arm64 builds.
    },
    verify: { command: '"{bin}" --version', expect: `v${NODE_VERSION}` },
  },
  {
    // Windows: official MinGit portable archive. macOS: xcode-select (system
    // authorization). Linux: distro package manager, user-run (shown on card).
    item: 'git',
    version: GIT_VERSION,
    displayName: 'Git',
    source: 'https://git-scm.com/',
    install: { via: 'system', macAction: 'xcode-select', linuxGuide: true },
    platforms: {
      'darwin-arm64': { url: '', sha256: '', sizeBytes: 0, kind: 'system' },
      'darwin-x64': { url: '', sha256: '', sizeBytes: 0, kind: 'system' },
      'linux-x64': { url: '', sha256: '', sizeBytes: 0, kind: 'system' },
      'linux-arm64': { url: '', sha256: '', sizeBytes: 0, kind: 'system' },
      'win32-x64': {
        url: `https://github.com/git-for-windows/git/releases/download/v${GIT_VERSION}.windows.1/MinGit-${GIT_VERSION}-64-bit.zip`,
        sha256: '064b440ff870ed5198527e8f3a92cdf5bd2fd0fedf5e718af95e3fdaddeff718',
        sizeBytes: 39_602_073,
        kind: 'archive',
      },
      'win32-arm64': {
        url: `https://github.com/git-for-windows/git/releases/download/v${GIT_VERSION}.windows.1/MinGit-${GIT_VERSION}-arm64.zip`,
        sha256: 'cb3b0f2d486ea52673227151a5baf5bc13861ff80e74e94e46d614d1bfcd5c06',
        sizeBytes: 37_900_737,
        kind: 'archive',
      },
    },
    // System kind: {bin} = the system `git` on PATH. MinGit installs verify via
    // their own {bin} (resolved under the toolchain root).
    verify: { command: '"{bin}" --version', expect: 'git version' },
  },
  {
    // P12 增强级 (macOS): Lima VM runtime, installed by the user (brew) —
    // we only detect. The VM itself is provisioned separately (see the
    // build-wsl-rootfs scripts header). Detected via the `limactl` CLI.
    item: 'lima',
    version: 'latest',
    displayName: 'Lima（增强沙箱）',
    source: 'https://lima-vm.io/',
    install: {
      via: 'system',
      linuxGuide: false,
      guide: 'brew install lima（官方文档：https://lima-vm.io/docs/installation/）',
    },
    platforms: {
      'darwin-arm64': { url: '', sha256: '', sizeBytes: 0, kind: 'system' },
      'darwin-x64': { url: '', sha256: '', sizeBytes: 0, kind: 'system' },
    },
    detectBin: 'limactl',
    verify: { command: '"{bin}" --version', expect: 'limactl version' },
  },
  {
    // P12 增强级 (Linux): rootless Podman, installed by the user via the
    // distro package manager — we only detect.
    item: 'podman',
    version: 'latest',
    displayName: 'Podman（增强沙箱）',
    source: 'https://podman.io/',
    install: {
      via: 'system',
      linuxGuide: true,
      guide:
        '安装 rootless Podman：sudo apt install podman（Debian/Ubuntu）或 sudo dnf install podman（Fedora），并按官方文档配置 rootless（subuid/subgid）。',
    },
    platforms: {
      'linux-x64': { url: '', sha256: '', sizeBytes: 0, kind: 'system' },
      'linux-arm64': { url: '', sha256: '', sizeBytes: 0, kind: 'system' },
    },
    verify: { command: '"{bin}" --version', expect: 'podman version' },
  },
  {
    // P07 本地向量运行库（DEV-007 已落实，见 docs/dev/DEVIATIONS.md）：ONNX
    // Runtime 的 Node 绑定，以 npm 官方 tarball 形式安装到私有 toolchains
    // （不入应用安装包）。registry.npmmirror.com 与 registry.npmjs.org 的
    // tarball 字节一致（sha512 integrity 与 registry 元数据核对一致，
    // 2026-10-04），国内环境可直达；GPU 组件随包分发——macOS 内置 CoreML
    // EP（链接进 libonnxruntime），Windows 带 DirectML.dll（任意 DX12 显卡：
    // NVIDIA/AMD/Intel），Linux 包未携带 CUDA EP（CPU）。onnxruntime-common
    // 是运行期 require 依赖，落在 node_modules/ 下供解析；其余 package.json
    // 声明的依赖（adm-zip/global-agent）在发布代码中未被 require。
    item: 'onnxruntime',
    version: ONNXRUNTIME_VERSION,
    displayName: 'ONNX 运行库（本地推理）',
    source: 'https://registry.npmjs.org/onnxruntime-node',
    install: {
      via: 'files',
      files: [
        {
          name: `onnxruntime-node-${ONNXRUNTIME_VERSION}.tgz`,
          url: `https://registry.npmmirror.com/onnxruntime-node/-/onnxruntime-node-${ONNXRUNTIME_VERSION}.tgz`,
          sha256: '6e3390d6b783e7be946fad629292799da28d0b42f84856e50d2c1b0383291e75',
          sizeBytes: 113_507_888,
          // tarball 单根目录 package/ → 即安装目录本身（包根）。
          extract: { dest: '' },
        },
        {
          name: `onnxruntime-common-${ONNXRUNTIME_VERSION}.tgz`,
          url: `https://registry.npmmirror.com/onnxruntime-common/-/onnxruntime-common-${ONNXRUNTIME_VERSION}.tgz`,
          sha256: '7906c439e0d3e0f4048caa23b64cdfadc0f455c377f579ce1ab2a4b778f07d5f',
          sizeBytes: 66_795,
          extract: { dest: 'node_modules/onnxruntime-common' },
        },
      ],
    },
    platforms: {
      'darwin-arm64': { url: '', sha256: '', sizeBytes: 113_574_683, kind: 'files' },
      'darwin-x64': { url: '', sha256: '', sizeBytes: 113_574_683, kind: 'files' },
      'linux-x64': { url: '', sha256: '', sizeBytes: 113_574_683, kind: 'files' },
      'linux-arm64': { url: '', sha256: '', sizeBytes: 113_574_683, kind: 'files' },
      'win32-x64': { url: '', sha256: '', sizeBytes: 113_574_683, kind: 'files' },
      'win32-arm64': { url: '', sha256: '', sizeBytes: 113_574_683, kind: 'files' },
    },
    verify: {
      files: ['package.json', 'dist/index.js', 'node_modules/onnxruntime-common/package.json'],
    },
  },
  {
    // P07 本地向量模型（DEV-007 已落实）：bge-small-zh-v1.5 的 ONNX 导出
    // （BAAI 官方权重的 Xenova 移植，HF 社区标准转换；MIT 许可）。BAAI
    // 官方仓库只发布 pytorch/safetensors，未提供 ONNX，故钉住移植导出；
    // ModelScope 分发（国内可达）。512 维 / 中文 BERT 词表 / CLS 池化 /
    // 单位归一，规格见 docs/design/16-capability-models.md「向量来源」。
    // 换模型 = 改本条目 + LocalEmbedder 的 MODEL_ID/维度，向量索引按
    // embedder id 变化自动重建（memory_vec_rebuild）。
    item: 'embedding-model',
    version: EMBEDDING_MODEL_VERSION,
    displayName: '本地向量模型（bge-small-zh-v1.5）',
    source: 'https://www.modelscope.cn/models/Xenova/bge-small-zh-v1.5',
    install: {
      via: 'files',
      files: [
        {
          name: 'model.onnx',
          url: `https://www.modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/onnx/model.onnx`,
          sha256: '69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a',
          sizeBytes: 94_851_877,
        },
        {
          name: 'vocab.txt',
          url: `https://www.modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/vocab.txt`,
          sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c',
          sizeBytes: 109_540,
        },
        {
          name: 'config.json',
          url: `https://www.modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/config.json`,
          sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
          sizeBytes: 716,
        },
      ],
    },
    platforms: {
      'darwin-arm64': { url: '', sha256: '', sizeBytes: 94_962_133, kind: 'files' },
      'darwin-x64': { url: '', sha256: '', sizeBytes: 94_962_133, kind: 'files' },
      'linux-x64': { url: '', sha256: '', sizeBytes: 94_962_133, kind: 'files' },
      'linux-arm64': { url: '', sha256: '', sizeBytes: 94_962_133, kind: 'files' },
      'win32-x64': { url: '', sha256: '', sizeBytes: 94_962_133, kind: 'files' },
      'win32-arm64': { url: '', sha256: '', sizeBytes: 94_962_133, kind: 'files' },
    },
    verify: { files: ['model.onnx', 'vocab.txt', 'config.json'] },
  },
];

/**
 * 本地向量模型的运行前置（DEV-007 落地形态）：`embedding-model` 从不单独
 * 安装，EnvManager 把两个条目合成一张审批卡，批准后先装运行库再装模型
 * （见 EnvManager#ensureChainedItem）。
 */
export function embeddingBundleEntries(
  catalog: Catalog,
): { runtime: CatalogEntry; model: CatalogEntry } | null {
  const runtime = catalog.find((entry) => entry.item === 'onnxruntime');
  const model = catalog.find((entry) => entry.item === 'embedding-model');
  return runtime !== undefined && model !== undefined ? { runtime, model } : null;
}

/**
 * Loads a catalog override for tests / e2e (never hits official URLs). Only
 * meant for local development and the automated tests; ignored when unset.
 */
export function loadCatalogOverride(env: NodeJS.ProcessEnv): Catalog | null {
  const file = env.KEPCUP_ENV_CATALOG_FILE;
  if (file === undefined || file.length === 0) return null;
  const parsed = catalogSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  return parsed as Catalog;
}
