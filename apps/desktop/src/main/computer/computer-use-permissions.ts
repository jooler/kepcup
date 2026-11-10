// 计算机操控的 macOS TCC 权限读取与引导（P-B2）。
//
// CuaDriver 以 embedded 模式运行：TCC 记在宿主 KepCup 名下，daemon 永不弹窗。
// 因此权限状态直接读宿主的 Electron systemPreferences（与 daemon 同一 TCC 身份），
// 不再拉起独立 helper。屏幕录制没有 Electron 的主动请求 API，只能打开系统设置
// 面板；macOS 26+ 的 direct-capture 二段同意由首次截图路径触发并如实报错。

export type ComputerPermissionId = 'accessibility' | 'screen-recording'
export type ComputerPermissionState = 'granted' | 'not-granted' | 'unknown'

/** systemPreferences 的结构化子集（便于单测注入；见 sensor-permission.ts）。 */
export interface ComputerPermissionApi {
  isTrustedAccessibilityClient(prompt: boolean): boolean
  getMediaAccessStatus(mediaType: 'screen'): string
}

export interface ComputerPermissionShell {
  openExternal(url: string): Promise<void>
}

const ACCESSIBILITY_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
const SCREEN_RECORDING_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

export type ComputerUsePermissionStatus = {
  accessibility: ComputerPermissionState
  screenRecording: ComputerPermissionState
}

export function readComputerUsePermissionStatus(
  api: ComputerPermissionApi,
  platform: NodeJS.Platform = process.platform
): ComputerUsePermissionStatus {
  if (platform !== 'darwin') {
    return { accessibility: 'unknown', screenRecording: 'unknown' }
  }
  let accessibility: ComputerPermissionState = 'unknown'
  let screenRecording: ComputerPermissionState = 'unknown'
  try {
    accessibility = api.isTrustedAccessibilityClient(false) ? 'granted' : 'not-granted'
  } catch {
    // systemPreferences 不可用时保持 unknown，交给设置页提示。
  }
  try {
    screenRecording = mapScreenRecordingStatus(api.getMediaAccessStatus('screen'))
  } catch {
    // 同上。
  }
  return { accessibility, screenRecording }
}

/**
 * 打开系统设置对应面板；AX 额外触发系统提示，让 KepCup 出现在辅助功能列表里。
 * 返回后由调用方停止 provider，确保下一次调用重建 daemon 读取新 TCC。
 */
export async function openComputerUsePermissions(
  permission: ComputerPermissionId,
  api: ComputerPermissionApi,
  shell: ComputerPermissionShell,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform !== 'darwin') {
    return
  }
  if (permission === 'accessibility') {
    try {
      api.isTrustedAccessibilityClient(true)
    } catch {
      // 提示失败不阻塞打开设置面板。
    }
    await shell.openExternal(ACCESSIBILITY_PANE)
    return
  }
  await shell.openExternal(SCREEN_RECORDING_PANE)
}

function mapScreenRecordingStatus(status: string): ComputerPermissionState {
  if (status === 'granted') {
    return 'granted'
  }
  if (status === 'denied' || status === 'restricted' || status === 'not-determined') {
    return 'not-granted'
  }
  return 'unknown'
}
