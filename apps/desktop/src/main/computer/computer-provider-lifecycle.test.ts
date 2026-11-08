import { afterEach, describe, expect, it } from 'vitest'
import {
  ComputerProviderLifecycle,
  configuredComputerProviderName
} from './computer-provider-lifecycle'
import { CuaDriverProviderClient } from './cua-driver-provider-client'

// P-B1 WP6：provider 选择由 KEPCUP_COMPUTER_PROVIDER 环境变量决定（cua|native|
// script，默认 native）。cua 分支不做静默回落——前置检查失败的原因由
// provider.ensureStarted 在首次调用时以 COMPUTER_UNAVAILABLE 抛出。

class FakeCuaDriverProviderClient extends CuaDriverProviderClient {
  constructor() {
    super({ userDataDirectory: '/tmp/kepcup-lifecycle-test' })
  }
}

describe('configuredComputerProviderName', () => {
  const original = process.env.KEPCUP_COMPUTER_PROVIDER

  afterEach(() => {
    if (original === undefined) {
      delete process.env.KEPCUP_COMPUTER_PROVIDER
    } else {
      process.env.KEPCUP_COMPUTER_PROVIDER = original
    }
  })

  it('缺省 → native（本期不发版默认）', () => {
    delete process.env.KEPCUP_COMPUTER_PROVIDER
    expect(configuredComputerProviderName()).toBe('native')
  })

  it.each([
    ['cua', 'cua'],
    ['native', 'native'],
    ['script', 'script'],
    ['CUA', 'cua'],
    [' cua ', 'cua'],
    ['bogus', 'native']
  ])('KEPCUP_COMPUTER_PROVIDER=%s → %s', (value, expected) => {
    process.env.KEPCUP_COMPUTER_PROVIDER = value
    expect(configuredComputerProviderName()).toBe(expected)
  })
})

describe('ComputerProviderLifecycle 分支选择', () => {
  const original = process.env.KEPCUP_COMPUTER_PROVIDER

  afterEach(() => {
    if (original === undefined) {
      delete process.env.KEPCUP_COMPUTER_PROVIDER
    } else {
      process.env.KEPCUP_COMPUTER_PROVIDER = original
    }
  })

  function makeDeps(options: { nativeAvailable?: boolean; scriptAvailable?: boolean } = {}) {
    let nativeCreated = 0
    let scriptCreated = 0
    let cuaCreated = 0
    const deps = {
      shouldUseMacOSNativeProvider: () => options.nativeAvailable ?? true,
      createMacOSNativeProvider: () => {
        nativeCreated += 1
        return { shutdown: () => {} } as never
      },
      shouldUseDesktopScriptProvider: () => options.scriptAvailable ?? false,
      createDesktopScriptProvider: () => {
        scriptCreated += 1
        return { shutdown: () => {} } as never
      },
      createCuaDriverProvider: () => {
        cuaCreated += 1
        return new FakeCuaDriverProviderClient()
      },
      resolveCuaDriverUnavailableReason: () => null
    }
    return { deps, counts: () => ({ nativeCreated, scriptCreated, cuaCreated }) }
  }

  it('默认（无环境变量）在 darwin 上选原生 provider', () => {
    delete process.env.KEPCUP_COMPUTER_PROVIDER
    const { deps, counts } = makeDeps()
    const lifecycle = new ComputerProviderLifecycle(deps)
    expect(lifecycle.current('darwin')).not.toBeNull()
    expect(counts().nativeCreated).toBe(1)
    expect(counts().cuaCreated).toBe(0)
  })

  it('KEPCUP_COMPUTER_PROVIDER=cua → cua provider（原生可用也不选）', () => {
    process.env.KEPCUP_COMPUTER_PROVIDER = 'cua'
    const { deps, counts } = makeDeps({ nativeAvailable: true })
    const lifecycle = new ComputerProviderLifecycle(deps)
    const provider = lifecycle.current('darwin')
    expect(provider).toBeInstanceOf(CuaDriverProviderClient)
    expect(counts().nativeCreated).toBe(0)
    expect(counts().cuaCreated).toBe(1)
    // 复用同一实例。
    expect(lifecycle.current('darwin')).toBe(provider)
  })

  it('KEPCUP_COMPUTER_PROVIDER=cua 且前置检查失败 → 返回 cua 实例（不静默回落），失败原因留给首次调用', () => {
    process.env.KEPCUP_COMPUTER_PROVIDER = 'cua'
    const { deps, counts } = makeDeps({ nativeAvailable: true })
    const lifecycle = new ComputerProviderLifecycle({ ...deps, resolveCuaDriverUnavailableReason: () => 'CuaDriver.app was not found' })
    const provider = lifecycle.current('darwin')
    // 不回落：返回 cua 实例，让 ensureStarted 抛可行动的 COMPUTER_UNAVAILABLE。
    expect(provider).toBeInstanceOf(CuaDriverProviderClient)
    expect(counts().nativeCreated).toBe(0)
  })

  it('KEPCUP_COMPUTER_PROVIDER=native 且原生不可用 → null（不偷换到 script）', () => {
    process.env.KEPCUP_COMPUTER_PROVIDER = 'native'
    const { deps, counts } = makeDeps({ nativeAvailable: false, scriptAvailable: true })
    const lifecycle = new ComputerProviderLifecycle(deps)
    expect(lifecycle.current('darwin')).toBeNull()
    expect(counts().scriptCreated).toBe(0)
  })

  it('KEPCUP_COMPUTER_PROVIDER=script → desktop script provider', () => {
    process.env.KEPCUP_COMPUTER_PROVIDER = 'script'
    const { deps, counts } = makeDeps({ nativeAvailable: true, scriptAvailable: true })
    const lifecycle = new ComputerProviderLifecycle(deps)
    expect(lifecycle.current('linux')).not.toBeNull()
    expect(counts().scriptCreated).toBe(1)
    expect(counts().nativeCreated).toBe(0)
  })

  it('shutdown 关停当前 provider 并允许下次重建', () => {
    process.env.KEPCUP_COMPUTER_PROVIDER = 'cua'
    const { deps, counts } = makeDeps()
    const lifecycle = new ComputerProviderLifecycle(deps)
    const provider = lifecycle.current('darwin') as CuaDriverProviderClient
    let shutDown = false
    provider.shutdown = () => {
      shutDown = true
    }
    lifecycle.shutdown()
    expect(shutDown).toBe(true)
    const next = lifecycle.current('darwin')
    expect(next).toBeInstanceOf(CuaDriverProviderClient)
    expect(next).not.toBe(provider)
    expect(counts().cuaCreated).toBe(2)
  })
})
