import net from 'node:net'
import { cuaDriverToolError, cuaDriverTransportError } from './cua-driver-error-map'

// cua-driver daemon socket 客户端（P-B1，todo/computer-use-cua-adapter.md WP2）。
//
// 协议（findings「daemon 协议」）：unix socket 上一行一个 JSON 对象、无请求 id、
// 按序应答。请求：{"method":"call","name":<tool>,"args":{…},"session_id":…,
// "client_kind":"cli"}；另有 sessions_list / session_end。
// 响应：{"ok":true,"result":{content,structuredContent,isError?}}。工具级失败 =
// ok:true + isError:true（driver 不用传输层错误表达业务拒绝）；这里统一转成
// 带正确大写 code 的 AppError（见 cua-driver-error-map.ts）。
//
// 传输纪律：单连接、请求串行（一期不做并发）；行缓冲上限 32MB（树可达 MB 级）；
// 读超时默认 5s，get_window_state 单独 30s（AX 走查官方上限 20s + 截图）。

export const CUA_DRIVER_LINE_LIMIT_BYTES = 32 * 1024 * 1024
export const CUA_DRIVER_REQUEST_TIMEOUT_MS = 5_000
export const CUA_DRIVER_WINDOW_STATE_TIMEOUT_MS = 30_000

export const CUA_DRIVER_SESSION_ID = 'kepcup-computer'

export type CuaDriverToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  structuredContent: Record<string, unknown>
  isError?: boolean
}

export type CuaDriverCallOptions = {
  timeoutMs?: number
}

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export function cuaDriverCallTimeoutMs(toolName: string): number {
  return toolName === 'get_window_state'
    ? CUA_DRIVER_WINDOW_STATE_TIMEOUT_MS
    : CUA_DRIVER_REQUEST_TIMEOUT_MS
}

export class CuaDriverDaemonClient {
  private socketPath: string | null = null
  private socket: net.Socket | null = null
  /**
   * 连接存活的自有标记：Node 24 上 `socket.destroy()` 后 `destroyed` 不保证同步
   * 置位（'close' 事件异步），只用它会把已销毁的连接当活的复用（挂死下一次
   * 调用）。failConnection / close 置 false，onConnect 置 true。
   */
  private connectionAlive = false
  private connectPromise: Promise<net.Socket> | null = null
  private readonly lineBuffer = new CuaDriverLineBuffer()
  private listenerCleanup: (() => void) | null = null
  private queueTail: Promise<unknown> = Promise.resolve()
  private closed = false

  /** 预先绑定 socket 路径；call 时按需连接。 */
  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  /** 调一个 driver 工具；串行执行。isError 响应转成 AppError（错误映射表）。 */
  async call(toolName: string, args: Record<string, unknown>, options: CuaDriverCallOptions = {}): Promise<CuaDriverToolResult> {
    return await this.enqueue(() => this.sendCall(toolName, args, options))
  }

  /** 所有请求共用一条串行队列（一期不做并发，见模块注释）。 */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queueTail.then(run, run)
    this.queueTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async sessionsList(): Promise<unknown> {
    return await this.enqueue(() =>
      this.rawRequest(
        { method: 'sessions_list', client_kind: 'cli' },
        { timeoutMs: CUA_DRIVER_REQUEST_TIMEOUT_MS }
      )
    )
  }

  async sessionEnd(): Promise<unknown> {
    return await this.enqueue(() =>
      this.rawRequest(
        { method: 'session_end', session_id: CUA_DRIVER_SESSION_ID, client_kind: 'cli' },
        { timeoutMs: CUA_DRIVER_REQUEST_TIMEOUT_MS }
      )
    )
  }

  /** 关闭连接（不停止 daemon；daemon 生命周期归 CuaDriverProcessOwner）。 */
  close(): void {
    this.closed = true
    this.connectionAlive = false
    const socket = this.socket
    this.socket = null
    this.connectPromise = null
    this.lineBuffer.clear()
    this.listenerCleanup?.()
    this.listenerCleanup = null
    socket?.destroy()
  }

  private async sendCall(
    toolName: string,
    args: Record<string, unknown>,
    options: CuaDriverCallOptions
  ): Promise<CuaDriverToolResult> {
    const result = (await this.rawRequest(
      {
        method: 'call',
        name: toolName,
        args,
        session_id: CUA_DRIVER_SESSION_ID,
        client_kind: 'cli'
      },
      { timeoutMs: options.timeoutMs ?? cuaDriverCallTimeoutMs(toolName) }
    )) as CuaDriverToolResult
    if (result.isError === true) {
      const { code, message } = extractDriverError(result)
      throw cuaDriverToolError(code, message)
    }
    return result
  }

  private async rawRequest(
    request: Record<string, unknown>,
    options: CuaDriverCallOptions
  ): Promise<unknown> {
    if (this.closed) {
      throw cuaDriverTransportError('cua-driver client is closed')
    }
    const socket = await this.ensureConnected()
    const line = `${JSON.stringify(request)}\n`
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时后连接状态不可信：销毁连接让下一次调用重连。
        this.failConnection(
          cuaDriverToolError('action_timeout', `cua-driver daemon did not answer '${String(request.name ?? request.method)}' within ${options.timeoutMs ?? 0}ms`)
        )
      }, options.timeoutMs ?? CUA_DRIVER_REQUEST_TIMEOUT_MS)
      this.pending = { resolve, reject, timer }
      socket.write(line, (writeError) => {
        if (!writeError) {
          return
        }
        clearTimeout(timer)
        this.pending = null
        this.failConnection(cuaDriverTransportError(`cua-driver socket write failed: ${writeError.message}`))
      })
    })
  }

  private pending: PendingCall | null = null

  private async ensureConnected(): Promise<net.Socket> {
    if (this.socket && this.connectionAlive && !this.socket.destroyed) {
      return this.socket
    }
    if (this.connectPromise) {
      return await this.connectPromise
    }
    this.connectPromise = this.connect()
    try {
      return await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private connect(): Promise<net.Socket> {
    const socketPath = this.socketPath
    if (!socketPath) {
      return Promise.reject(cuaDriverTransportError('cua-driver socket path is not set'))
    }
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(socketPath)
      const onConnect = (): void => {
        cleanup()
        socket.setEncoding('utf8')
        this.socket = socket
        this.connectionAlive = true
        this.lineBuffer.clear()
        this.listenerCleanup = attach(socket, {
          data: (chunk) => this.handleData(socket, chunk),
          close: () => this.handleClose(socket),
          error: (error) => this.handleError(socket, error)
        })
        resolve(socket)
      }
      const onError = (error: Error): void => {
        cleanup()
        socket.destroy()
        reject(cuaDriverTransportError(`cua-driver socket connect failed: ${error.message}`))
      }
      const cleanup = (): void => {
        socket.off('connect', onConnect)
        socket.off('error', onError)
      }
      socket.once('connect', onConnect)
      socket.once('error', onError)
    })
  }

  private handleData(socket: net.Socket, chunk: string): void {
    if (this.socket !== socket) {
      // 旧连接的迟到数据不进新缓冲。
      return
    }
    try {
      this.lineBuffer.push(chunk, (line) => this.handleLine(line))
    } catch (error) {
      this.failConnection(
        cuaDriverTransportError(
          error instanceof Error ? error.message : 'cua-driver socket line buffer overflowed'
        )
      )
    }
  }

  private handleLine(line: string): void {
    const pending = this.pending
    this.pending = null
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      pending.reject(cuaDriverTransportError('cua-driver daemon sent a non-JSON line'))
      return
    }
    const record = parsed as { ok?: unknown; result?: unknown; error?: unknown }
    if (record.ok !== true) {
      const detail =
        typeof record.error === 'object' && record.error !== null
          ? JSON.stringify(record.error)
          : 'no error detail'
      pending.reject(cuaDriverTransportError(`cua-driver daemon request failed: ${detail}`))
      return
    }
    pending.resolve(record.result)
  }

  private handleClose(socket: net.Socket): void {
    if (this.socket !== socket) {
      return
    }
    this.failConnection(cuaDriverTransportError('cua-driver daemon connection closed'))
  }

  private handleError(socket: net.Socket, error: Error): void {
    if (this.socket !== socket) {
      return
    }
    this.failConnection(cuaDriverTransportError(`cua-driver socket error: ${error.message}`))
  }

  private failConnection(error: Error): void {
    this.listenerCleanup?.()
    this.listenerCleanup = null
    this.connectionAlive = false
    const socket = this.socket
    this.socket = null
    this.lineBuffer.clear()
    if (socket && !socket.destroyed) {
      socket.destroy()
    }
    const pending = this.pending
    this.pending = null
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }
}

function attach(
  socket: net.Socket,
  handlers: {
    data: (chunk: string) => void
    close: () => void
    error: (error: Error) => void
  }
): () => void {
  socket.on('data', handlers.data)
  socket.on('close', handlers.close)
  socket.on('error', handlers.error)
  return () => {
    socket.off('data', handlers.data)
    socket.off('close', handlers.close)
    socket.off('error', handlers.error)
  }
}

// --- 行缓冲（与 macos-native-provider-transport 的 NativeProviderLineBuffer 同语义） ----

export class CuaDriverLineBuffer {
  private buffer = ''

  push(chunk: string, onLine: (line: string) => void): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > CUA_DRIVER_LINE_LIMIT_BYTES) {
      this.clear()
      throw new Error(`cua-driver line exceeded ${CUA_DRIVER_LINE_LIMIT_BYTES} bytes without a newline`)
    }
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.trim().length > 0) {
        onLine(line)
      }
      newlineIndex = this.buffer.indexOf('\n')
    }
  }

  clear(): void {
    this.buffer = ''
  }
}

/**
 * 从 isError 响应里取（code, message）：refusal.code 优先（快照 stale），其次
 * 平铺 code（window_not_found 等），再 ActionError.error.code（refused 动作）；
 * message 取人类可读文本（content[].text 或 structuredContent.reason/message）。
 */
export function extractDriverError(result: CuaDriverToolResult): { code: string | null; message: string } {
  const structured = result.structuredContent ?? {}
  const refusal = structured.refusal as { code?: unknown; message?: unknown } | undefined
  const error = structured.error as { code?: unknown; hint?: unknown } | undefined
  const code =
    asCode(refusal?.code) ??
    asCode(structured.code) ??
    asCode(error?.code) ??
    null
  const text = result.content.find((item) => typeof item.text === 'string')?.text
  const message =
    asString(refusal?.message) ??
    asString(structured.reason) ??
    asString(structured.message) ??
    asString(error?.hint) ??
    text ??
    ''
  return { code, message }
}

function asCode(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}
