import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from '@kepcup/shared'
import { CuaDriverDaemonClient } from './cua-driver-daemon-client'
import { cuaDriverTransportError } from './cua-driver-error-map'
import { CuaDriverObserver } from './cua-driver-observer'
import { CuaDriverActions } from './cua-driver-actions'
import { CuaDriverSnapshotStore } from './cua-driver-snapshot-store'
import {
  cleanupOrphanCuaDriverDaemon,
  CuaDriverProcessOwner
} from './cua-driver-process'
import {
  prepareCuaDriverSocketDirectory,
  readCuaDriverLock,
  resolveCuaDriverBundlePath,
  resolveCuaDriverUnavailableReason
} from './cua-driver-paths'
import { synthesizeCuaDriverCapabilities } from './cua-driver-capabilities'
import { checkCuaDriverPermissions } from './cua-driver-permissions'
import type { ComputerActionMethod } from './computer-action-method'

// cua-driver provider 客户端（P-B1/P-B2）：provider 接口（5 个方法）的 cua 实现。
//
// 生命周期：ensureStarted → 清孤儿 → spawn serve --embedded → 等 socket →
// 客户端按需连接。失败路径（二进制缺失 / 版本不符 / 启动失败）抛
// COMPUTER_UNAVAILABLE，绝不静默回落到原生 provider（WP6：避免两套 provider
// 混用导致索引/快照状态错乱）。

export type CuaDriverProviderOptions = {
  /** 注入 userData 目录（socket 目录父级）；缺省由 main 装配处提供。 */
  userDataDirectory: string
  /** 测试注入：跳过真实进程（伪 daemon 单测直连 socket）。 */
  client?: CuaDriverDaemonClient
  /** 测试注入：跳过孤儿清理。 */
  skipOrphanCleanup?: boolean
}

export class CuaDriverProviderClient {
  private readonly processOwner = new CuaDriverProcessOwner()
  private client: CuaDriverDaemonClient | null = null
  private observer: CuaDriverObserver | null = null
  private actions: CuaDriverActions | null = null
  private readonly snapshotStore = new CuaDriverSnapshotStore()
  private capabilitiesCache: ComputerProviderCapabilities | null = null
  private startPromise: Promise<void> | null = null

  constructor(private readonly options: CuaDriverProviderOptions) {}

  async capabilities(): Promise<ComputerProviderCapabilities> {
    await this.ensureStarted()
    if (!this.capabilitiesCache) {
      const version = readCuaDriverLock()?.version ?? 'unknown'
      this.capabilitiesCache = synthesizeCuaDriverCapabilities(version)
    }
    return this.capabilitiesCache
  }

  async listApps(): Promise<ComputerListAppsResult> {
    await this.ensureStarted()
    return await this.requireObserver().listApps()
  }

  async listWindows(params: unknown): Promise<ComputerListWindowsResult> {
    await this.ensureStarted()
    return await this.requireObserver().listWindows(asParams(params))
  }

  async snapshot(params: unknown): Promise<ComputerSnapshotResult> {
    await this.ensureStarted()
    return await this.requireObserver().snapshot(asParams(params))
  }

  async action(method: ComputerActionMethod, params: unknown): Promise<ComputerActionResult> {
    await this.ensureStarted()
    return await this.requireActions().action(method, asParams(params))
  }

  /** WP5：TCC 状态走 socket 的 check_permissions（embedded 只读、不弹窗）。 */
  async permissionsStatus(): Promise<{ accessibility: boolean; screenRecording: boolean; attribution: string | null }> {
    await this.ensureStarted()
    return await checkCuaDriverPermissions(this.requireClient())
  }

  shutdown(): void {
    this.client?.close()
    this.client = null
    this.observer = null
    this.actions = null
    this.capabilitiesCache = null
    this.snapshotStore.clear()
    this.startPromise = null
    // SIGTERM → 2s → SIGKILL + 删 socket 目录（CUA_DRIVER_PARENT_LIVENESS_STDIN
    // 兜底父进程死亡；显式 stop 走 orderly 语义）。
    this.processOwner.stop()
  }

  // --- 启动 ------------------------------------------------------------------

  async ensureStarted(): Promise<void> {
    if (this.client && this.observer && this.actions) {
      return
    }
    if (this.startPromise) {
      return await this.startPromise
    }
    this.startPromise = this.start()
    try {
      await this.startPromise
    } finally {
      if (this.startPromise) {
        this.startPromise = null
      }
    }
  }

  private async start(): Promise<void> {
    if (this.options.client) {
      // 伪 daemon 单测：客户端外部注入，进程生命周期与平台检查不归本类管。
      this.client = this.options.client
      this.observer = new CuaDriverObserver(this.client, this.snapshotStore, this.options.userDataDirectory)
      this.actions = new CuaDriverActions(this.client, this.observer, this.snapshotStore)
      return
    }
    const unavailableReason = resolveCuaDriverUnavailableReason()
    if (unavailableReason) {
      throw cuaDriverTransportError(unavailableReason)
    }
    const bundle = resolveCuaDriverBundlePath()
    if (!bundle) {
      throw cuaDriverTransportError('CuaDriver.app was not found')
    }
    const socketDirectory = prepareCuaDriverSocketDirectory(this.options.userDataDirectory)
    if (this.options.skipOrphanCleanup !== true) {
      await cleanupOrphanCuaDriverDaemon(bundle.executablePath, socketDirectory)
    }
    await this.processOwner.start(bundle.executablePath, socketDirectory)
    const socketPath = this.processOwner.currentSocketPath
    if (!socketPath) {
      this.processOwner.stop()
      throw cuaDriverTransportError('cua-driver daemon did not report its socket path')
    }
    this.client = new CuaDriverDaemonClient(socketPath)
    this.observer = new CuaDriverObserver(this.client, this.snapshotStore, socketDirectory)
    this.actions = new CuaDriverActions(this.client, this.observer, this.snapshotStore)
  }

  private requireClient(): CuaDriverDaemonClient {
    if (!this.client) {
      throw cuaDriverTransportError('cua-driver client is not started')
    }
    return this.client
  }

  private requireObserver(): CuaDriverObserver {
    if (!this.observer) {
      throw cuaDriverTransportError('cua-driver observer is not started')
    }
    return this.observer
  }

  private requireActions(): CuaDriverActions {
    if (!this.actions) {
      throw cuaDriverTransportError('cua-driver actions are not started')
    }
    return this.actions
  }
}

function asParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
}
