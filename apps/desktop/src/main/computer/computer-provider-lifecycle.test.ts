import { describe, expect, it } from 'vitest'
import { ComputerProviderLifecycle } from './computer-provider-lifecycle'
import { CuaDriverProviderClient } from './cua-driver-provider-client'

// P-B2：计算机操控只使用 CuaDriver（macOS）。其它平台返回 null，由 sidecar
// 给出「尚未启用」的可行动原因；不再有 KEPCUP_COMPUTER_PROVIDER 开关。

class FakeCuaDriverProviderClient extends CuaDriverProviderClient {
  shutdownCalled = false

  constructor() {
    super({ userDataDirectory: '/tmp/kepcup-lifecycle-test' })
  }

  override shutdown(): void {
    this.shutdownCalled = true
  }
}

describe('ComputerProviderLifecycle（CuaDriver-only）', () => {
  function makeLifecycle() {
    let created = 0
    const lifecycle = new ComputerProviderLifecycle({
      createCuaDriverProvider: () => {
        created += 1
        return new FakeCuaDriverProviderClient()
      }
    })
    return { lifecycle, counts: () => ({ created }) }
  }

  it('darwin → cua provider，并复用同一实例', () => {
    const { lifecycle, counts } = makeLifecycle()
    const provider = lifecycle.current('darwin')
    expect(provider).toBeInstanceOf(CuaDriverProviderClient)
    expect(lifecycle.current('darwin')).toBe(provider)
    expect(counts().created).toBe(1)
  })

  it.each(['win32', 'linux'] as const)('%s → null（本期只接 macOS）', (platform) => {
    const { lifecycle, counts } = makeLifecycle()
    expect(lifecycle.current(platform)).toBeNull()
    expect(counts().created).toBe(0)
  })

  it('shutdown 关停当前 provider 并允许下次重建', () => {
    const { lifecycle, counts } = makeLifecycle()
    const provider = lifecycle.current('darwin') as FakeCuaDriverProviderClient
    lifecycle.shutdown()
    expect(provider.shutdownCalled).toBe(true)
    const next = lifecycle.current('darwin')
    expect(next).toBeInstanceOf(CuaDriverProviderClient)
    expect(next).not.toBe(provider)
    expect(counts().created).toBe(2)
  })
})
