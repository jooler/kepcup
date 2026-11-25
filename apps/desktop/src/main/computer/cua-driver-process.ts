import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { runProcess } from './kepcup-process-host'
import { resolveCuaDriverSocketPath } from './cua-driver-paths'

// cua-driver daemon 生命周期（P-B1，todo/computer-use-cua-adapter.md WP1）。
//
// 启动：`serve --embedded --socket <端点>`（CUA_DRIVER_EMBEDDED=1，见上游
// EMBEDDING.md 与 findings Q6：embedded 模式 TCC 归宿主、永不弹窗、不经
// LaunchServices 自启）。端点由 cua-driver-paths 按平台解析：darwin/linux 是
// Unix socket 文件路径，win32 是 named pipe（`\\.\pipe\kepcup-cua-<hash>`）。
// stdin 保持打开（CUA_DRIVER_PARENT_LIVENESS_STDIN=1），父进程退出即 daemon
// 退出——这是孤儿防护的主通道。
//
// 孤儿清理：启动前端点已在监听时先 `<exe> stop --socket <端点>`（上一代残留），
// 2s 内不消失再 SIGKILL 兜底。退出：SIGTERM → 2s → SIGKILL，随后删 socket 目录
// （win32 pipe 随服务端关闭自动消失，目录仅承载截图等工件）。

export const CUA_DRIVER_SIGKILL_GRACE_MS = 2_000
export const CUA_DRIVER_STARTUP_TIMEOUT_MS = 15_000
export const CUA_DRIVER_PROBE_TIMEOUT_MS = 500

export type CuaDriverDaemonEnv = {
  /** 额外注入的环境变量（测试可覆盖超时类变量）。 */
  extraEnv?: Record<string, string>
}

/** WP1 约定的 daemon 环境变量（测试断言这里的键集合）。 */
export function baseDaemonEnvironment(): Record<string, string> {
  return {
    CUA_DRIVER_EMBEDDED: '1',
    CUA_DRIVER_PARENT_LIVENESS_STDIN: '1',
    CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
    CUA_DRIVER_RS_UPDATE_CHECK: '0',
    // macOS 26+ 的 ScreenCaptureKit「直接采集」同意只能由采集进程自己触发：默认
    // 不加这个变量时 driver 会一直跳过截图（px_capture_unavailable /
    // direct_capture_consent_required），宿主把屏幕录制授权给它也没用。首次截图
    // 因此会弹一次系统同意框（归 CuaDriver.app），点 Allow 后不再出现。
    CUA_DRIVER_ALLOW_CAPTURE_CONSENT_ALERT: '1',
    // 动作后窗口变化观察窗口（默认 1000ms 是后台点击延迟大头；200ms 按
    // EMBEDDING.md 的推荐折中）与键间隔（默认 8ms）。
    CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS: '200',
    CUA_DRIVER_KEY_GAP_MS: '2'
  }
}

export class CuaDriverProcessOwner {
  private child: ReturnType<typeof spawn> | null = null
  private socketDirectory: string | null = null
  private socketPath: string | null = null

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  get currentSocketPath(): string | null {
    return this.socketPath
  }

  /**
   * 启动 daemon 并等到 socket 可连。返回 stdout/stderr 供诊断。
   * 调用方先 prepareCuaDriverSocketDirectory + cleanupOrphanDaemon。
   */
  async start(
    executablePath: string,
    socketDirectory: string,
    options: CuaDriverDaemonEnv = {}
  ): Promise<{ socketPath: string }> {
    if (this.running) {
      throw new Error('cua-driver daemon is already running')
    }
    const socketPath = resolveCuaDriverSocketPath(socketDirectory)
    const child = spawn(
      executablePath,
      ['serve', '--embedded', '--socket', socketPath, '--no-overlay'],
      {
        env: {
          ...process.env,
          ...baseDaemonEnvironment(),
          ...(options.extraEnv ?? {})
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    this.child = child
    this.socketDirectory = socketDirectory
    this.socketPath = socketPath
    // stdin 保持打开：CUA_DRIVER_PARENT_LIVENESS_STDIN=1 下 daemon 死盯父进程
    // stdin，父进程死亡（含崩溃）→ 管道关闭 → daemon 自行退出。
    child.stdin?.on('error', () => {})
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    try {
      await waitForSocket(socketPath, CUA_DRIVER_STARTUP_TIMEOUT_MS, child)
    } catch (error) {
      // 启动失败（daemon 早退 / 端点一直没就绪）必须回收子进程，否则下次
      // ensureStarted 会撞上「daemon is already running」。
      this.stop()
      throw error
    }
    return { socketPath }
  }

  /** SIGTERM → CUA_DRIVER_SIGKILL_GRACE_MS → SIGKILL；随后删 socket 目录。 */
  stop(): void {
    const child = this.child
    const socketDirectory = this.socketDirectory
    this.child = null
    this.socketDirectory = null
    this.socketPath = null
    if (!child) {
      if (socketDirectory) {
        removeSocketDirectoryBestEffort(socketDirectory)
      }
      return
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      child.once('close', () => resolve())
    })
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
      }
    } catch {
      // 进程已退出时 kill 可能抛错；忽略。
    }
    // sidecar 收到 SIGTERM 会同步 process.exit()，'close' 事件等不到——同步删一次，
    // 否则 socket 目录（含 computer-screenshots 里的截图）会留在磁盘上。删除必须
    // 尽力而为：daemon 可能还握着目录内文件句柄（Windows 上 EBUSY/EPERM 不被
    // force 吞），抛错会跳过下面的 SIGKILL 兜底注册，泄漏 daemon。
    if (socketDirectory) {
      removeSocketDirectoryBestEffort(socketDirectory)
    }
    const escalation = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
      } catch {
        // 同上。
      }
    }, CUA_DRIVER_SIGKILL_GRACE_MS)
    escalation.unref?.()
    void exited.then(() => {
      clearTimeout(escalation)
      if (socketDirectory) {
        removeSocketDirectoryBestEffort(socketDirectory)
      }
    })
  }

  /** 进程被外部杀死（崩溃）时通知调用方；返回是否真的发生了外部退出。 */
  adoptExternalExit(handler: () => void): void {
    const child = this.child
    if (!child) {
      return
    }
    child.once('close', () => {
      if (this.child === child) {
        handler()
      }
    })
  }
}

async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
  child: ReturnType<typeof spawn>
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `cua-driver daemon exited during startup (code ${child.exitCode}, signal ${child.signalCode})`
      )
    }
    if (await isSocketEndpointLive(socketPath)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`cua-driver daemon socket did not appear within ${timeoutMs}ms`)
}

/**
 * 端点就绪探测：unix socket 用 existsSync；win32 named pipe 的 fs 探测恒为
 * false（stat 抛错），只能真连一次——连上即视为就绪（daemon-client 复用同一
 * 通道语义，连上立即断开不占用会话）。连接必须带超时：pipe 不存在时部分
 * Windows 版本的 connect 既不报错也不完成，会挂死调用方。导出供单测。
 */
export async function isSocketEndpointLive(socketPath: string): Promise<boolean> {
  if (!socketPath.startsWith('\\\\.\\pipe\\')) {
    return existsSync(socketPath)
  }
  return await new Promise((resolve) => {
    let settled = false
    const settle = (value: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(guard)
      connection.destroy()
      resolve(value)
    }
    const guard = setTimeout(() => settle(false), CUA_DRIVER_PROBE_TIMEOUT_MS)
    guard.unref?.()
    const connection = createConnection(socketPath)
    connection.once('connect', () => settle(true))
    connection.once('error', () => settle(false))
    connection.once('close', () => settle(false))
  })
}

/**
 * 启动前清理上一代残留：端点已在监听 → `<exe> stop --socket <端点>`；
 * 2s 内仍在则视为陈旧（daemon 已死但端点未清理）：unix socket 直接删文件；
 * win32 named pipe 无文件可删，等不到消失时按残留处理（新一代绑定会因管道
 * 已存在而失败，由 start 失败路径暴露）。
 * 返回是否执行了清理（诊断用）。
 */
export async function cleanupOrphanCuaDriverDaemon(
  executablePath: string,
  socketDirectory: string
): Promise<boolean> {
  const socketPath = resolveCuaDriverSocketPath(socketDirectory)
  if (!(await isSocketEndpointLive(socketPath))) {
    return false
  }
  try {
    await runProcess({
      program: executablePath,
      args: ['stop', '--socket', socketPath],
      timeoutMs: 5_000
    })
  } catch {
    // spawn 失败（二进制缺失等）按陈旧 socket 处理。
  }
  const deadline = Date.now() + CUA_DRIVER_SIGKILL_GRACE_MS
  while ((await isSocketEndpointLive(socketPath)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (process.platform !== 'win32' && existsSync(socketPath)) {
    // daemon 已不在监听但 socket 文件残留；删掉让新一代绑定。
    try {
      rmSync(socketPath, { force: true })
    } catch {
      // 删除失败（Windows 句柄未释放等）不阻塞启动——新一代绑定失败时
      // 由 start 的失败路径如实报错。
    }
  }
  removeSocketDirectoryBestEffort(socketDirectory)
  return true
}

/**
 * socket 目录删除是尽力而为：目录可能被垂死的 daemon 短暂占着句柄（Windows
 * EBUSY/EPERM 不被 force 吞），删不掉时留给下次启动或退出路径清理，不向上抛。
 */
function removeSocketDirectoryBestEffort(socketDirectory: string): void {
  try {
    rmSync(socketDirectory, { recursive: true, force: true })
  } catch {
    // 尽力而为，见上方注释。
  }
}
