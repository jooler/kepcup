import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from './kepcup-process-host'

// cua-driver daemon 生命周期（P-B1，todo/computer-use-cua-adapter.md WP1）。
//
// 启动：`serve --embedded --socket <dir>/driver.sock`（CUA_DRIVER_EMBEDDED=1，
// 见上游 EMBEDDING.md 与 findings Q6：embedded 模式 TCC 归宿主、永不弹窗、
// 不经 LaunchServices 自启）。stdin 保持打开（CUA_DRIVER_PARENT_LIVENESS_STDIN=1），
// 父进程退出即 daemon 退出——这是孤儿防护的主通道。
//
// 孤儿清理：启动前 socket 已存在时先 `<exe> stop --socket <path>`（上一代残留），
// 2s 内不消失再 SIGKILL 兜底。退出：SIGTERM → 2s → SIGKILL，随后删 socket 目录。

export const CUA_DRIVER_SIGKILL_GRACE_MS = 2_000
export const CUA_DRIVER_STARTUP_TIMEOUT_MS = 15_000

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
    const socketPath = join(socketDirectory, 'driver.sock')
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
    await waitForSocket(socketPath, CUA_DRIVER_STARTUP_TIMEOUT_MS, child)
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
        rmSync(socketDirectory, { recursive: true, force: true })
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
        rmSync(socketDirectory, { recursive: true, force: true })
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
    if (existsSync(socketPath)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`cua-driver daemon socket did not appear within ${timeoutMs}ms`)
}

/**
 * 启动前清理上一代残留：socket 文件存在 → `<exe> stop --socket <path>`；
 * 2s 内 socket 仍在则视为陈旧（daemon 已死但 socket 未清理），直接删文件。
 * 返回是否执行了清理（诊断用）。
 */
export async function cleanupOrphanCuaDriverDaemon(
  executablePath: string,
  socketDirectory: string
): Promise<boolean> {
  const socketPath = join(socketDirectory, 'driver.sock')
  if (!existsSync(socketPath)) {
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
  while (existsSync(socketPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (existsSync(socketPath)) {
    // daemon 已不在监听但 socket 文件残留；删掉让新一代绑定。
    rmSync(socketPath, { force: true })
  }
  rmSync(socketDirectory, { recursive: true, force: true })
  return true
}
