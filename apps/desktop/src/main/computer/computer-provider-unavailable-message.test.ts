import { describe, expect, it } from 'vitest'
import { computerProviderUnavailableMessage } from './computer-provider-unavailable-message'

describe('computerProviderUnavailableMessage', () => {
  it('points darwin at the pinned CuaDriver fetch', () => {
    const message = computerProviderUnavailableMessage('darwin')
    expect(message).toMatch(/CuaDriver\.app/)
    expect(message).toMatch(/fetch-cua-driver\.mjs/)
  })

  it.each(['win32', 'linux'] as const)('names %s and points at the pinned runtime fetch', (platform) => {
    const message = computerProviderUnavailableMessage(platform)
    expect(message).toMatch(new RegExp(`no provider on ${platform}`))
    expect(message).toMatch(/pinned cua-driver runtime was not found/)
    expect(message).toMatch(/fetch-cua-driver\.mjs/)
  })

  it('says unsupported (not fetch guidance) for platforms outside the three targets', () => {
    const message = computerProviderUnavailableMessage('freebsd')
    expect(message).toMatch(/not supported on freebsd/)
    expect(message).not.toMatch(/fetch-cua-driver\.mjs/)
  })
})
