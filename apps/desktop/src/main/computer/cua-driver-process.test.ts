import { describe, expect, it } from 'vitest'
import { baseDaemonEnvironment } from './cua-driver-process'

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
