import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// cua-driver provider 的路径解析（P-B1，todo/computer-use-cua-adapter.md WP1）。
//
// 二进制必须以完整 CuaDriver.app bundle 形态分发（裸二进制会被 AMFI SIGKILL：
// 签名校验需要 bundle 内 Info.plist，findings「架构级新发现 1」）：
// - env 覆盖：KEPCUP_CUA_DRIVER_APP_PATH（仅当 KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE=1
//   时生效；打包版不要设置，避免启动环境被改写后执行任意 bundle——embedded daemon
//   会继承宿主的 TCC 授权）；
// - 打包：process.resourcesPath/cua-driver/CuaDriver.app
//   （electron-builder.yml mac.extraResources：from resources/cua-driver/darwin-${arch}
//   → to cua-driver）；
// - dev：apps/desktop/resources/cua-driver/darwin-<arch>/CuaDriver.app
//   （scripts/fetch-cua-driver.mjs 产物，gitignored）。
//
// 本模块源码在 src/main/computer/、构建产物在 out/main/（sidecar 入口）或
// out/main/chunks/（共享 chunk）——三种布局到 apps/desktop 的层级不同，全部列为
// appDir 候选，避免打包后按源码层级回溯到 apps/ 根目录。

const MODULE_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))
const DESKTOP_APP_DIRECTORIES = [
  ...new Set([
    join(MODULE_DIRECTORY, '..', '..', '..'),
    join(MODULE_DIRECTORY, '..', '..'),
    join(MODULE_DIRECTORY, '..', '..', '..', '..')
  ])
]
const BUNDLE_NAME = 'CuaDriver.app'
const EXECUTABLE_NAME = 'cua-driver'
const LOCK_FILENAME = 'cua-driver.lock.json'

export type ResolvedCuaDriverBundle = {
  appPath: string
  executablePath: string
}

export function resolveCuaDriverBundlePath(): ResolvedCuaDriverBundle | null {
  const appPath = resolveCuaDriverAppPath()
  if (!appPath) {
    return null
  }
  const executablePath = join(appPath, 'Contents', 'MacOS', EXECUTABLE_NAME)
  if (!existsSync(executablePath)) {
    return null
  }
  return { appPath, executablePath }
}

function resolveCuaDriverAppPath(): string | null {
  const override = process.env.KEPCUP_CUA_DRIVER_APP_PATH
  // 测试 / CI 专用逃生口：打包版忽略路径覆盖，防止启动环境被改写后执行任意
  // bundle（embedded daemon 继承宿主 TCC，危害等同完整桌面控制）。
  if (
    override &&
    process.env.KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE === '1' &&
    existsSync(override)
  ) {
    return override
  }
  const candidates = [
    ...(process.resourcesPath
      ? [join(process.resourcesPath, 'cua-driver', BUNDLE_NAME)]
      : []),
    ...DESKTOP_APP_DIRECTORIES.map((directory) =>
      join(directory, 'resources/cua-driver', `darwin-${process.arch}`, BUNDLE_NAME)
    )
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

// --- lock pin（版本唯一事实来源；tarball/可执行哈希校验在 fetch 脚本，启动时只核对版本） ----

export type CuaDriverLock = {
  version: string
}

export function readCuaDriverLock(): CuaDriverLock | null {
  try {
    const raw = JSON.parse(readDesktopResourceFile(LOCK_FILENAME)) as Record<string, unknown>
    if (typeof raw.version !== 'string' || raw.version.length === 0) {
      return null
    }
    return { version: raw.version }
  } catch {
    return null
  }
}

function readDesktopResourceFile(name: string): string {
  for (const directory of DESKTOP_APP_DIRECTORIES) {
    const dev = join(directory, 'resources', name)
    if (existsSync(dev)) {
      return readFileSync(dev, 'utf8')
    }
  }
  const packaged = join(process.resourcesPath ?? '', name)
  if (existsSync(packaged)) {
    return readFileSync(packaged, 'utf8')
  }
  throw new Error(`cua-driver lock file ${name} was not found`)
}

/** 启动前置检查（WP6）：bundle 存在 + lock 版本可读即认为可启动；二进制哈希由 fetch 保证。 */
export function resolveCuaDriverUnavailableReason(): string | null {
  if (process.platform !== 'darwin') {
    return `cua-driver provider is macOS-only (this host is ${process.platform})`
  }
  if (!resolveCuaDriverBundlePath()) {
    return (
      'cua-driver provider is unavailable: CuaDriver.app was not found. ' +
      'Run `node apps/desktop/scripts/fetch-cua-driver.mjs` and restart KepCup.'
    )
  }
  if (!readCuaDriverLock()) {
    return 'cua-driver provider is unavailable: resources/cua-driver.lock.json is missing or malformed'
  }
  return null
}

// --- socket 路径（Unix socket 有 104 字节路径上限，findings WP1） --------------------

export const UNIX_SOCKET_PATH_LIMIT = 104

/**
 * daemon socket 目录：优先 userData 下的私有目录（0700）；路径超上限时用
 * `mkdtemp` 在 TMPDIR 下分配唯一短目录（不用固定 /tmp 路径，避免本地进程预创建
 * 或替换 socket）。调用方负责在启动前创建目录并校验权限。
 */
export function resolveCuaDriverSocketDirectory(userDataDirectory: string): string {
  const preferred = join(userDataDirectory, 'cua-driver')
  if (socketPathLengthOk(join(preferred, 'driver.sock'))) {
    return preferred
  }
  const fallback = mkdtempSync(join(tmpdir(), 'kepcup-cua-'))
  if (!socketPathLengthOk(join(fallback, 'driver.sock'))) {
    // TMPDIR 本身超长是极端环境；/tmp 是 macOS 上的短路径。
    return mkdtempSync('/tmp/kepcup-cua-')
  }
  return fallback
}

function socketPathLengthOk(socketPath: string): boolean {
  return Buffer.byteLength(socketPath, 'utf8') + 1 <= UNIX_SOCKET_PATH_LIMIT
}

/**
 * 创建 socket 目录并收紧权限（0700；socket 文件本身由 daemon 以 0600 创建）。
 * 目录必须是当前用户拥有的真实目录；chmod 失败直接抛错（fail closed），
 * 不允许 socket 目录比 0700 更宽。
 */
export function prepareCuaDriverSocketDirectory(userDataDirectory: string): string {
  const directory = resolveCuaDriverSocketDirectory(userDataDirectory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory()) {
    throw new Error(`cua-driver socket path is not a real directory: ${directory}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`cua-driver socket directory is owned by another user: ${directory}`)
  }
  chmodSync(directory, 0o700)
  return directory
}

// --- 杂项 --------------------------------------------------------------------
// （fetch 缓存位置：~/.cache/kepcup/cua-driver/<version>/，scripts/fetch-cua-driver.mjs）
