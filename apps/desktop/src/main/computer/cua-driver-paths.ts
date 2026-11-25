import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// cua-driver provider 的路径解析（P-B1，todo/computer-use-cua-adapter.md WP1；
// 2026-11 三端启用修订：win32/linux 与 darwin 并列，上游同一 tag 分发三端运行时）。
//
// 形态按平台不同：
// - darwin：完整 CuaDriver.app bundle（裸二进制会被 AMFI SIGKILL：签名校验需要
//   bundle 内 Info.plist，findings「架构级新发现 1」）。
// - win32/linux：上游 release 是「运行时目录」——主二进制与同级 helper / SDK
//   库必须放在一起（win: cua-driver.exe + cua-driver-uia.exe + cua_driver_sdk.dll；
//   linux: cua-driver + cua-cursor-theme + wayland-helper/ 等）。没有 bundle 形态
//   要求，pack/fetch 校验主二进制 + 关键文件的 sha256。
//
// 路径解析（三平台同构）：
// - env 覆盖：KEPCUP_CUA_DRIVER_APP_PATH（仅当 KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE=1
//   时生效；打包版不要设置，避免启动环境被改写后执行任意运行时——embedded daemon
//   在 darwin 会继承宿主的 TCC 授权）。darwin 指向 .app；win/linux 指向运行时目录。
// - 打包：process.resourcesPath/cua-driver/<runtime>（electron-builder 平台块
//   extraResources：from resources/cua-driver/<os>-${arch} → to cua-driver，
//   每包只含本平台 arch 一份）；
// - dev：apps/desktop/resources/cua-driver/<os>-<arch>/（scripts/fetch-cua-driver.mjs
//   产物，gitignored）。
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

export type CuaDriverPlatform = 'darwin' | 'win32' | 'linux'

export function cuaDriverPlatform(platform: NodeJS.Platform = process.platform): CuaDriverPlatform | null {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    return platform
  }
  return null
}

/**
 * 分发目录前缀（lock / fetch 产物 / electron-builder 的 `<os>-<arch>` 键）：win32
 * 平台枚举对应 `win-<arch>` 目录（对齐 pack-hooks platformDirName 与 lock 资产键）。
 */
export function cuaDriverOsDirectoryName(platform: CuaDriverPlatform): string {
  return platform === 'win32' ? 'win' : platform
}

/** darwin 是 .app bundle；win/linux 是「运行时目录」（含 exe 与同级 dll/helper）。 */
export type ResolvedCuaDriverBundle = {
  appPath: string
  executablePath: string
}

function runtimeDirectoryCandidates(platform: CuaDriverPlatform): string[] {
  const osDirectory = `${cuaDriverOsDirectoryName(platform)}-${process.arch}`
  return [
    // 打包：electron-builder extraResources 把 resources/cua-driver/<os>-<arch>
    // 的内容平铺到 <resourcesPath>/cua-driver/。
    ...(process.resourcesPath ? [join(process.resourcesPath, 'cua-driver')] : []),
    // dev：fetch-cua-driver.mjs 产物按 <os>-<arch> 分目录。
    ...DESKTOP_APP_DIRECTORIES.map((directory) =>
      join(directory, 'resources/cua-driver', osDirectory)
    )
  ]
}

function resolveCuaDriverAppPath(platform: CuaDriverPlatform): string | null {
  const override = process.env.KEPCUP_CUA_DRIVER_APP_PATH
  // 测试 / CI 专用逃生口：打包版忽略路径覆盖，防止启动环境被改写后执行任意
  // 运行时（darwin 上 embedded daemon 继承宿主 TCC，危害等同完整桌面控制）。
  if (
    override &&
    process.env.KEPCUP_CUA_DRIVER_ALLOW_APP_PATH_OVERRIDE === '1' &&
    existsSync(override)
  ) {
    return override
  }
  const candidates = runtimeDirectoryCandidates(platform).map((directory) => {
    if (platform === 'darwin') {
      return join(directory, BUNDLE_NAME)
    }
    // win/linux：运行时目录本身就是候选（exe 在目录顶层）。
    return directory
  })
  if (platform !== 'darwin') {
    // win/linux 的候选是裸目录：apps/、仓库根这类上层目录必然存在，不能因
    // existsSync 就命中——目录里必须真的装着主二进制才算解析成功。
    const executableName = runtimeExecutableName(platform)
    return candidates.find((candidate) => existsSync(join(candidate, executableName))) ?? null
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function resolveCuaDriverBundlePath(
  platform: NodeJS.Platform = process.platform
): ResolvedCuaDriverBundle | null {
  const resolvedPlatform = cuaDriverPlatform(platform)
  if (!resolvedPlatform) {
    return null
  }
  const appPath = resolveCuaDriverAppPath(resolvedPlatform)
  if (!appPath) {
    return null
  }
  const executablePath =
    resolvedPlatform === 'darwin'
      ? join(appPath, 'Contents', 'MacOS', EXECUTABLE_NAME)
      : join(appPath, resolvedPlatform === 'win32' ? `${EXECUTABLE_NAME}.exe` : EXECUTABLE_NAME)
  if (!existsSync(executablePath)) {
    return null
  }
  return { appPath, executablePath }
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

/** 启动前置检查（WP6）：运行时可执行体存在 + lock 版本可读即认为可启动；二进制哈希由 fetch 保证。 */
export function resolveCuaDriverUnavailableReason(platform: NodeJS.Platform = process.platform): string | null {
  const resolvedPlatform = cuaDriverPlatform(platform)
  if (!resolvedPlatform) {
    return `cua-driver provider is unavailable on ${platform} (no pinned runtime for this platform)`
  }
  if (!resolveCuaDriverBundlePath(platform)) {
    const expected =
      resolvedPlatform === 'darwin' ? BUNDLE_NAME : runtimeExecutableName(resolvedPlatform)
    return (
      `cua-driver provider is unavailable: ${expected} was not found. ` +
      'Run `node apps/desktop/scripts/fetch-cua-driver.mjs` and restart KepCup.'
    )
  }
  if (!readCuaDriverLock()) {
    return 'cua-driver provider is unavailable: resources/cua-driver.lock.json is missing or malformed'
  }
  return null
}

function runtimeExecutableName(platform: CuaDriverPlatform): string {
  return platform === 'win32' ? `${EXECUTABLE_NAME}.exe` : EXECUTABLE_NAME
}

// --- socket 端点（darwin/linux：Unix socket，104 字节路径上限，findings WP1；
//     win32：named pipe——Node net 对 `\\.\pipe\` 路径与 Unix socket 同一套 API） ----

export const UNIX_SOCKET_PATH_LIMIT = 104
const PIPE_NAME_PREFIX = '\\\\.\\pipe\\kepcup-cua-'
const PIPE_NAME_HASH_LENGTH = 12

/**
 * daemon socket 端点目录：
 * - darwin/linux 优先 userData 下的私有目录（0700）；Unix socket 路径超上限时用
 *   `mkdtemp` 在 TMPDIR 下分配唯一短目录（不用固定 /tmp 路径，避免本地进程预创建
 *   或替换 socket）。调用方负责在启动前创建目录并校验权限。
 * - win32 同样返回 userData 下的目录（承载截图等 daemon 工件），但 socket 本身
 *   不落在文件系统——`resolveCuaDriverSocketPath` 给出 pipe 名。
 */
export function resolveCuaDriverSocketDirectory(userDataDirectory: string): string {
  const preferred = join(userDataDirectory, 'cua-driver')
  if (process.platform === 'win32') {
    return preferred
  }
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

/**
 * daemon 监听端点：darwin/linux 为 `<dir>/driver.sock`（Unix socket，受 104 字节
 * 上限约束）；win32 为 named pipe，名字从 socket 目录哈希派生（全局命名空间，
 * 按 userData 去重 + 跨重启稳定，孤儿清理据此找到上一代 daemon）。
 */
export function resolveCuaDriverSocketPath(socketDirectory: string): string {
  if (process.platform !== 'win32') {
    return join(socketDirectory, 'driver.sock')
  }
  const digest = createHash('sha256')
    .update(socketDirectory, 'utf8')
    .digest('hex')
    .slice(0, PIPE_NAME_HASH_LENGTH)
  return `${PIPE_NAME_PREFIX}${digest}`
}

function socketPathLengthOk(socketPath: string): boolean {
  return Buffer.byteLength(socketPath, 'utf8') + 1 <= UNIX_SOCKET_PATH_LIMIT
}

/**
 * 创建 socket 目录并收紧权限（0700；socket 文件本身由 daemon 以 0600 创建）。
 * 目录必须是当前用户拥有的真实目录；chmod 失败直接抛错（fail closed），
 * 不允许 socket 目录比 0700 更宽。win32 没有属主/权限位语义：只确保目录存在
 * （chmod/getuid 校验是 POSIX 概念，NTFS 上无意义，跳过）。
 */
export function prepareCuaDriverSocketDirectory(userDataDirectory: string): string {
  const directory = resolveCuaDriverSocketDirectory(userDataDirectory)
  mkdirSync(directory, { recursive: true })
  if (process.platform === 'win32') {
    return directory
  }
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
