import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CuaDriverProviderClient } from './cua-driver-provider-client'

// provider 选择（P-B2，2026-11 三端启用修订）：计算机操控只使用 CuaDriver，
// darwin / win32 / linux 三端启用（上游同一 tag 分发三端运行时）。cua 的启动
// 前置检查（运行时 + lock + socket 端点）在 provider.ensureStarted 里做，失败
// 原因由首次调用以 COMPUTER_UNAVAILABLE 抛出，不做静默回落。

type ComputerProvider = CuaDriverProviderClient

type ComputerProviderLifecycleDeps = {
  createCuaDriverProvider: () => CuaDriverProviderClient
}

/** sidecar 进程里没有 userData 路径：main fork 时经环境变量传入（sidecar-client）。 */
function defaultCuaDriverUserDataDirectory(): string {
  return process.env.KEPCUP_COMPUTER_USER_DATA_DIR ?? join(tmpdir(), 'kepcup-cua')
}

const defaultDeps: ComputerProviderLifecycleDeps = {
  createCuaDriverProvider: () =>
    new CuaDriverProviderClient({ userDataDirectory: defaultCuaDriverUserDataDirectory() })
}

export class ComputerProviderLifecycle {
  private cuaDriverProvider: CuaDriverProviderClient | null = null

  constructor(private readonly deps: ComputerProviderLifecycleDeps = defaultDeps) {}

  current(platform: NodeJS.Platform = process.platform): ComputerProvider | null {
    if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
      return null
    }
    if (this.cuaDriverProvider) {
      return this.cuaDriverProvider
    }
    this.cuaDriverProvider = this.deps.createCuaDriverProvider()
    return this.cuaDriverProvider
  }

  shutdown(): void {
    this.cuaDriverProvider?.shutdown()
    this.cuaDriverProvider = null
  }
}

const lifecycle = new ComputerProviderLifecycle()

export function currentComputerProvider(): ComputerProvider | null {
  return lifecycle.current()
}

export function shutdownComputerProviders(): void {
  lifecycle.shutdown()
}
