import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputerPermissionState } from '@kepcup/shared'
import type { CuaDriverDaemonClient } from './cua-driver-daemon-client'

// cua-driver 权限检测（P-B1，todo/computer-use-cua-adapter.md WP5，findings Q6）。
//
// - 状态读取走 socket 上的 `check_permissions`，embedded 模式下 driver 强制只读、
//   永不弹窗（`prompt:true` 会被忽略——真机复检验证，所以别指望它拉起系统同意框）。
// - 截屏可用性只能靠**真跑一次采集**判断：daemon 带
//   `CUA_DRIVER_ALLOW_CAPTURE_CONSENT_ALERT=1` 时首次采集会尝试（必要时由系统弹
//   同意框），失败则回 `screenshot_error`。`probeCuaDriverDirectCapture` 就是这条路径。
// - CLI `permissions status --json` 只认 CuaDriver.app 身份的 daemon，对我们自建的
//   embedded daemon 恒报 unknown——不用。
// - `permissions grant` 禁用：经 LaunchServices 启动 CuaDriver.app 会把授权记到
//   com.trycua.driver 而不是 KepCup。缺宿主权限时由宿主自己开系统设置面板
//（computer.permissionsOpen 既有实现）。
// - embedded 模式的正确性以 source.attribution === 'host' 为信号；授权变化后
//   daemon 必须重启（TCC 按进程缓存）——由 provider 的重启周期承担。

export type CuaDriverPermissionStatus = {
  accessibility: boolean
  screenRecording: boolean
  /** macOS 26+ 直采：'unknown' = 本次没跑采集（只读调用不会探测）。 */
  directCapture: ComputerPermissionState
  /** 'host' = embedded 正确归宿主；其它值说明 embedded 模式没生效（诊断信号）。 */
  attribution: string | null
}

export type CuaDriverCaptureProbe = {
  state: ComputerPermissionState
  /** not-granted / unknown 时的原始原因（driver 文案，便于设置页就地显示）。 */
  reason: string | null
}

export async function checkCuaDriverPermissions(
  client: CuaDriverDaemonClient
): Promise<CuaDriverPermissionStatus> {
  const result = await client.call('check_permissions', { prompt: false })
  const structured = result.structuredContent as {
    accessibility?: unknown
    screen_recording?: unknown
    screen_recording_capturable?: unknown
    direct_capture_status?: unknown
    source?: { attribution?: unknown }
  }
  return {
    accessibility: structured.accessibility === true,
    screenRecording: structured.screen_recording === true,
    directCapture: mapDirectCapture(structured),
    attribution:
      typeof structured.source?.attribution === 'string' ? structured.source.attribution : null
  }
}

/**
 * 真实采集自检：挑一个在屏窗口抓一帧（不取 AX 树），据此判断截屏是否可用。
 * 首次调用可能让系统弹出「直接采集」同意框；用户点允许后即恢复 granted。
 */
export async function probeCuaDriverDirectCapture(
  client: CuaDriverDaemonClient,
  outputDirectory?: string
): Promise<CuaDriverCaptureProbe> {
  const windowsResult = await client.call('list_windows', { on_screen_only: true })
  const windows = (windowsResult.structuredContent as { windows?: unknown }).windows
  const list = Array.isArray(windows)
    ? (windows as Array<{ pid?: unknown; window_id?: unknown; app_name?: unknown }>)
    : []
  // 优先抓宿主自己的窗口（名称同 app-brand 的 APP_NAME），少碰第三方窗口。
  const target = list.find((window) => window.app_name === 'KepCup') ?? list[0]
  if (!target || typeof target.pid !== 'number' || typeof target.window_id !== 'number') {
    return { state: 'unknown', reason: '没有可用于截屏自检的在屏窗口' }
  }

  // 自检帧同样是屏幕内容：默认用私有短命目录（0700），不落在共享 tmpdir 顶层。
  const directory = outputDirectory ?? mkdtempSync(join(tmpdir(), 'kepcup-cua-probe-'))
  const outFile = join(directory, `cua-capture-probe-${randomBytes(6).toString('hex')}.png`)
  try {
    const result = await client.call('get_window_state', {
      pid: target.pid,
      window_id: target.window_id,
      include_accessibility_tree: false,
      include_screenshot: true,
      screenshot_out_file: outFile
    })
    const structured = (result.structuredContent ?? {}) as {
      screenshot_file_path?: unknown
      screenshot_error?: { reason?: unknown } | null
    }
    if (
      typeof structured.screenshot_file_path === 'string' &&
      existsSync(structured.screenshot_file_path)
    ) {
      return { state: 'granted', reason: null }
    }
    const reason = structured.screenshot_error?.reason
    if (typeof reason === 'string') {
      return { state: 'not-granted', reason }
    }
    return { state: 'unknown', reason: null }
  } finally {
    // 清理失败（EACCES 等）不得覆盖探测结论。
    try {
      rmSync(outFile, { force: true })
      if (outputDirectory === undefined) {
        rmSync(directory, { recursive: true, force: true })
      }
    } catch {
      // 尽力而为。
    }
  }
}

/**
 * 只读调用的直采结论。`ready` 是 upstream 的探针结论；`blocked_by_screen_recording` /
 * `unavailable` 是已探明不可用；`timed_out` / `probe_failed` / `not_checked` 表示这次
 * 没得出可靠结论，保持 unknown 而不是误报未授权。
 */
function mapDirectCapture(structured: {
  screen_recording_capturable?: unknown
  direct_capture_status?: unknown
}): ComputerPermissionState {
  if (structured.screen_recording_capturable === true) {
    return 'granted'
  }
  const status = structured.direct_capture_status
  if (status === 'ready') {
    return 'granted'
  }
  if (status === 'unavailable' || status === 'blocked_by_screen_recording') {
    return 'not-granted'
  }
  return 'unknown'
}
