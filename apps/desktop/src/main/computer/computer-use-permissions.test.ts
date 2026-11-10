import { describe, expect, it, vi } from 'vitest'
import {
  openComputerUsePermissions,
  readComputerUsePermissionStatus,
  type ComputerPermissionApi,
  type ComputerPermissionShell
} from './computer-use-permissions'

const ACCESSIBILITY_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
const SCREEN_RECORDING_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

function api(overrides: Partial<ComputerPermissionApi> = {}): ComputerPermissionApi {
  return {
    isTrustedAccessibilityClient: vi.fn(() => true),
    getMediaAccessStatus: vi.fn(() => 'granted'),
    ...overrides
  }
}

function shell(): ComputerPermissionShell & { openExternal: ReturnType<typeof vi.fn> } {
  return { openExternal: vi.fn(async () => undefined) }
}

describe('readComputerUsePermissionStatus', () => {
  it('maps granted host TCC', () => {
    expect(readComputerUsePermissionStatus(api(), 'darwin')).toEqual({
      accessibility: 'granted',
      screenRecording: 'granted'
    })
  })

  it('maps denied AX and every non-granted screen state', () => {
    expect(
      readComputerUsePermissionStatus(
        api({
          isTrustedAccessibilityClient: () => false,
          getMediaAccessStatus: () => 'denied'
        }),
        'darwin'
      )
    ).toEqual({ accessibility: 'not-granted', screenRecording: 'not-granted' })

    for (const status of ['restricted', 'not-determined']) {
      expect(
        readComputerUsePermissionStatus(
          api({ getMediaAccessStatus: () => status }),
          'darwin'
        ).screenRecording
      ).toBe('not-granted')
    }
  })

  it('keeps unknown values unknown', () => {
    expect(
      readComputerUsePermissionStatus(
        api({ getMediaAccessStatus: () => 'something-else' }),
        'darwin'
      ).screenRecording
    ).toBe('unknown')
  })

  it('falls back to unknown when the APIs throw', () => {
    expect(
      readComputerUsePermissionStatus(
        {
          isTrustedAccessibilityClient: () => {
            throw new Error('boom')
          },
          getMediaAccessStatus: () => {
            throw new Error('boom')
          }
        },
        'darwin'
      )
    ).toEqual({ accessibility: 'unknown', screenRecording: 'unknown' })
  })

  it('keeps the successful field when the other API throws', () => {
    expect(
      readComputerUsePermissionStatus(
        {
          isTrustedAccessibilityClient: () => true,
          getMediaAccessStatus: () => {
            throw new Error('boom')
          }
        },
        'darwin'
      )
    ).toEqual({ accessibility: 'granted', screenRecording: 'unknown' })
  })

  it('is unknown off macOS', () => {
    expect(readComputerUsePermissionStatus(api(), 'linux')).toEqual({
      accessibility: 'unknown',
      screenRecording: 'unknown'
    })
  })
})

describe('openComputerUsePermissions', () => {
  it('prompts for accessibility and opens the Privacy pane', async () => {
    const permissionApi = api()
    const permissionShell = shell()

    await openComputerUsePermissions('accessibility', permissionApi, permissionShell, 'darwin')

    expect(permissionApi.isTrustedAccessibilityClient).toHaveBeenCalledWith(true)
    expect(permissionShell.openExternal).toHaveBeenCalledWith(ACCESSIBILITY_PANE)
  })

  it('opens the screen-recording pane without prompting AX', async () => {
    const permissionApi = api()
    const permissionShell = shell()

    await openComputerUsePermissions('screen-recording', permissionApi, permissionShell, 'darwin')

    expect(permissionApi.isTrustedAccessibilityClient).not.toHaveBeenCalled()
    expect(permissionShell.openExternal).toHaveBeenCalledWith(SCREEN_RECORDING_PANE)
  })

  it('does nothing off macOS', async () => {
    const permissionApi = api()
    const permissionShell = shell()

    await openComputerUsePermissions('accessibility', permissionApi, permissionShell, 'linux')

    expect(permissionApi.isTrustedAccessibilityClient).not.toHaveBeenCalled()
    expect(permissionShell.openExternal).not.toHaveBeenCalled()
  })
})
