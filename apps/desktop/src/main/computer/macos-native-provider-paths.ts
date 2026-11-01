import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// KepCup 版（解耦点 5）：helper 候选与 orca 不同——
// - env 覆盖：KEPCUP_COMPUTER_MACOS_HELPER_APP_PATH（existsSync 校验）；
// - 打包：process.resourcesPath/computer-use/KepCup Computer Use.app
//   （electron-builder.yml mac.extraResources 已有
//   `from: resources/computer-use/darwin-${arch}` → `to: computer-use`）；
// - dev：apps/desktop/resources/computer-use/darwin-<arch>/KepCup Computer Use.app。
//   本模块源码在 src/main/computer/、构建产物在 out/main/computer/，都是 apps/desktop
//   下三级目录，从 import.meta.url 向上三级即 appDir（不用 __dirname：vitest 直跑
//   源码时 ESM 下未定义）。
// 可执行名保持 orca-computer-use-macos（vendored helper 不改名）。

const MODULE_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))
const DESKTOP_APP_DIRECTORY = join(MODULE_DIRECTORY, '..', '..', '..')
const MACOS_HELPER_APP_NAME = 'KepCup Computer Use.app'

export function resolveMacOSComputerUseAppPath(): string | null {
  const override = process.env.KEPCUP_COMPUTER_MACOS_HELPER_APP_PATH
  if (override && existsSync(override)) {
    return override
  }

  const packaged = join(process.resourcesPath ?? '', 'computer-use', MACOS_HELPER_APP_NAME)
  const dev = join(
    DESKTOP_APP_DIRECTORY,
    'resources/computer-use',
    `darwin-${process.arch}`,
    MACOS_HELPER_APP_NAME
  )
  const candidates = process.resourcesPath ? [packaged, dev] : [dev]

  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

export function resolveMacOSComputerUseExecutablePath(): string | null {
  const appPath = resolveMacOSComputerUseAppPath()
  if (!appPath) {
    return null
  }
  const executablePath = join(appPath, 'Contents', 'MacOS', 'orca-computer-use-macos')
  return existsSync(executablePath) ? executablePath : null
}
