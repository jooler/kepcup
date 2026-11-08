import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MacOSNativeProviderClient } from './macos-native-provider-client'
import { shouldUseMacOSNativeProvider } from './macos-native-provider-availability'
import {
  DesktopScriptProviderClient,
  shouldUseDesktopScriptProvider
} from './desktop-script-provider-client'
import { CuaDriverProviderClient } from './cua-driver-provider-client'
import { resolveCuaDriverUnavailableReason } from './cua-driver-paths'

// provider 选择（P-B1 WP6）：KEPCUP_COMPUTER_PROVIDER=cua|native|script（默认
// native，本期不发版默认）。选择顺序由开关决定；cua 分支的启动前置检查
//（bundle 存在 + lock 版本可读）不满足时**不得回落到原生 provider 而不告知**
//——返回 cua 客户端本身，让首次调用在 ensureStarted 里抛出可行动的
// COMPUTER_UNAVAILABLE 原因（避免两套 provider 混用导致索引/快照状态错乱）。

export type ComputerProviderName = 'cua' | 'native' | 'script'

export function configuredComputerProviderName(): ComputerProviderName {
  const value = process.env.KEPCUP_COMPUTER_PROVIDER?.trim().toLowerCase()
  if (value === 'cua' || value === 'native' || value === 'script') {
    return value
  }
  return 'native'
}

type ComputerProvider = MacOSNativeProviderClient | DesktopScriptProviderClient | CuaDriverProviderClient

type ComputerProviderLifecycleDeps = {
  shouldUseMacOSNativeProvider: () => boolean
  createMacOSNativeProvider: () => MacOSNativeProviderClient
  shouldUseDesktopScriptProvider: () => boolean
  createDesktopScriptProvider: () => DesktopScriptProviderClient
  createCuaDriverProvider: () => CuaDriverProviderClient
  resolveCuaDriverUnavailableReason: () => string | null
}

/** sidecar 进程里没有 userData 路径：main fork 时经环境变量传入（sidecar-client）。 */
function defaultCuaDriverUserDataDirectory(): string {
  return process.env.KEPCUP_COMPUTER_USER_DATA_DIR ?? join(tmpdir(), 'kepcup-cua')
}

const defaultDeps: ComputerProviderLifecycleDeps = {
  shouldUseMacOSNativeProvider,
  createMacOSNativeProvider: () => new MacOSNativeProviderClient(),
  shouldUseDesktopScriptProvider,
  createDesktopScriptProvider: () => new DesktopScriptProviderClient(),
  createCuaDriverProvider: () =>
    new CuaDriverProviderClient({ userDataDirectory: defaultCuaDriverUserDataDirectory() }),
  resolveCuaDriverUnavailableReason
}

export class ComputerProviderLifecycle {
  private nativeMacOSProvider: MacOSNativeProviderClient | null = null
  private desktopScriptProvider: DesktopScriptProviderClient | null = null
  private cuaDriverProvider: CuaDriverProviderClient | null = null

  constructor(private readonly deps: ComputerProviderLifecycleDeps = defaultDeps) {}

  current(platform: NodeJS.Platform = process.platform): ComputerProvider | null {
    const selection = configuredComputerProviderName()
    if (selection === 'cua') {
      return this.cuaDriver(platform)
    }
    if (platform === 'darwin') {
      if (this.nativeMacOSProvider) {
        return this.nativeMacOSProvider
      }
      if (this.deps.shouldUseMacOSNativeProvider()) {
        this.nativeMacOSProvider = this.deps.createMacOSNativeProvider()
        return this.nativeMacOSProvider
      }
    }
    if (selection === 'native' && platform === 'darwin') {
      // 显式 KEPCUP_COMPUTER_PROVIDER=native：原生不可用时不偷换到 script。
      return null
    }
    if (this.desktopScriptProvider) {
      return this.desktopScriptProvider
    }
    if (this.deps.shouldUseDesktopScriptProvider()) {
      this.desktopScriptProvider = this.deps.createDesktopScriptProvider()
      return this.desktopScriptProvider
    }
    return null
  }

  private cuaDriver(platform: NodeJS.Platform): ComputerProvider | null {
    if (platform !== 'darwin') {
      // P-B1 只验 macOS；其它平台维持原判定链（P-B2 再启用 cua）。
      return null
    }
    if (this.cuaDriverProvider) {
      return this.cuaDriverProvider
    }
    // 启动前置检查在 provider.ensureStarted 里做（bundle + lock + socket）；
    // 这里只拦「结构上不可能」的缺失（给出可行动原因，不静默回落）。
    this.cuaDriverProvider = this.deps.createCuaDriverProvider()
    return this.cuaDriverProvider
  }

  shutdown(): void {
    this.nativeMacOSProvider?.shutdown()
    this.nativeMacOSProvider = null
    this.desktopScriptProvider?.shutdown()
    this.desktopScriptProvider = null
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
