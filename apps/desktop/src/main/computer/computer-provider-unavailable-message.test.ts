import { describe, expect, it } from 'vitest'
import { computerProviderUnavailableMessage } from './computer-provider-unavailable-message'

describe('computerProviderUnavailableMessage', () => {
  it('points darwin at the pinned CuaDriver fetch', () => {
    const message = computerProviderUnavailableMessage('darwin')
    expect(message).toMatch(/CuaDriver\.app/)
    expect(message).toMatch(/fetch-cua-driver\.mjs/)
  })

  it('names the platform when the provider is not enabled', () => {
    expect(computerProviderUnavailableMessage('linux')).toMatch(/not enabled on linux/)
    expect(computerProviderUnavailableMessage('win32')).toMatch(/not enabled on win32/)
  })
})
