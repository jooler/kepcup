import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { baseDaemonEnvironment, isSocketEndpointLive } from './cua-driver-process'

describe('cua-driver daemon 环境', () => {
  it('允许首次截图触发直采同意框', () => {
    // 不设这个变量时 driver 会一直跳过截图（px_capture_unavailable），宿主把
    // 屏幕录制授权给它也没用——P-B2 真机复检实测。
    expect(baseDaemonEnvironment().CUA_DRIVER_ALLOW_CAPTURE_CONSENT_ALERT).toBe('1')
  })

  it('保留 embedded 与父进程存活的既有约定', () => {
    const env = baseDaemonEnvironment()
    expect(env.CUA_DRIVER_EMBEDDED).toBe('1')
    expect(env.CUA_DRIVER_PARENT_LIVENESS_STDIN).toBe('1')
  })
})

// 三端启用修订：端点就绪探测（unix existsSync / win32 named pipe 真连 + 超时兜底）。
describe('isSocketEndpointLive', () => {
  const cleanup: Array<() => void> = []

  afterEach(() => {
    for (const dispose of cleanup.splice(0)) {
      dispose()
    }
  })

  it('unix socket：文件存在即就绪，不存在即未就绪', async () => {
    if (process.platform === 'win32') {
      return
    }
    const dir = mkdtempSync(join(tmpdir(), 'kepcup-cua-probe-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const socketPath = join(dir, 'driver.sock')

    expect(await isSocketEndpointLive(socketPath)).toBe(false)
    writeFileSync(socketPath, '')
    expect(await isSocketEndpointLive(socketPath)).toBe(true)
  })

  it('win32 named pipe：有服务端监听即就绪，无服务端即未就绪（fs 探测恒 false）', async () => {
    if (process.platform !== 'win32') {
      return
    }
    const pipeName = `\\\\.\\pipe\\kepcup-cua-probe-${process.pid}-${Date.now()}`
    expect(await isSocketEndpointLive(pipeName)).toBe(false)

    const server = createServer()
    await new Promise<void>((resolve) => server.listen(pipeName, resolve))
    cleanup.push(() => server.close())
    expect(await isSocketEndpointLive(pipeName)).toBe(true)
  })
})
