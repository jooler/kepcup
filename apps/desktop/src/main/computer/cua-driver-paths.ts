import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// cua-driver provider 的路径解析（P-B1，todo/computer-use-cua-adapter.md WP1）。
//
// 二进制必须以完整 CuaDriver.app bundle 形态分发（裸二进制会被 AMFI SIGKILL：
// 签名校验需要 bundle 内 Info.plist，findings「架构级新发现 1」）：
// - env 覆盖：KEPCUP_CUA_DRIVER_APP_PATH（existsSync 校验）；
// - 打包：process.resourcesPath/cua-driver/CuaDriver.app
//   （electron-builder.yml mac.extraResources：from resources/cua-driver/darwin-${arch}
//   → to cua-driver）；
// - dev：apps/desktop/resources/cua-driver/darwin-<arch>/CuaDriver.app
//   （scripts/fetch-cua-driver.mjs 产物，gitignored）。
//
// 本模块源码在 src/main/computer/、构建产物在 out/main/computer/，都是 apps/desktop
// 下三级目录，从 import.meta.url 向上三级即 appDir（同 macos-native-provider-paths）。

const MODULE_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))
const DESKTOP_APP_DIRECTORY = join(MODULE_DIRECTORY, '..', '..', '..')
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
  if (override && existsSync(override)) {
    return override
  }
  const packaged = join(process.resourcesPath ?? '', 'cua-driver', BUNDLE_NAME)
  const dev = join(
    DESKTOP_APP_DIRECTORY,
    'resources/cua-driver',
    `darwin-${process.arch}`,
    BUNDLE_NAME
  )
  const candidates = process.resourcesPath ? [packaged, dev] : [dev]
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
  const dev = join(DESKTOP_APP_DIRECTORY, 'resources', name)
  if (existsSync(dev)) {
    return readFileSync(dev, 'utf8')
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
 * daemon socket 目录：优先 userData 下的私有目录（0700）；路径超上限时回退
 * TMPDIR 下的短路径（同样 0700）。调用方负责在启动前创建目录并设权限。
 */
export function resolveCuaDriverSocketDirectory(userDataDirectory: string): string {
  const preferred = join(userDataDirectory, 'cua-driver')
  if (socketPathLengthOk(join(preferred, 'driver.sock'))) {
    return preferred
  }
  const fallback = join(tmpdir(), `kepcup-cua-${process.pid}`)
  if (!socketPathLengthOk(join(fallback, 'driver.sock'))) {
    // TMPDIR 本身超长是极端环境；再退到 /tmp 的固定短名。
    return '/tmp/kepcup-cua'
  }
  return fallback
}

function socketPathLengthOk(socketPath: string): boolean {
  return Buffer.byteLength(socketPath, 'utf8') + 1 <= UNIX_SOCKET_PATH_LIMIT
}

/** 创建 socket 目录并收紧权限（0700；socket 文件本身由 daemon 以 0600 创建）。 */
export function prepareCuaDriverSocketDirectory(userDataDirectory: string): string {
  const directory = resolveCuaDriverSocketDirectory(userDataDirectory)
  mkdirSync(directory, { recursive: true })
  try {
    // mkdirSync 的 mode 只作用于新建目录；已存在时补一次 chmod。
    chmodSync(directory, 0o700)
  } catch {
    // 权限收紧失败不阻塞启动（例如目录在只读卷上）；socket 仍在用户私有目录内。
  }
  return directory
}

// --- 杂项 --------------------------------------------------------------------
// （fetch 缓存位置：~/.cache/kepcup/cua-driver/<version>/，scripts/fetch-cua-driver.mjs）
