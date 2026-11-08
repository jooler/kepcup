import type { CuaDriverDaemonClient } from './cua-driver-daemon-client'

// cua-driver 权限检测（P-B1，todo/computer-use-cua-adapter.md WP5，findings Q6）。
//
// - TCC 状态走 socket 上的 `check_permissions` 工具（embedded 模式下强制只读、
//   永不弹窗，prompt 参数被忽略）；CLI `permissions status --json` 只认
//   CuaDriver.app 身份的 daemon，对我们自建的 embedded daemon 恒报 unknown——不用。
// - `permissions grant` 禁用：经 LaunchServices 启动 CuaDriver.app 会把授权记到
//   com.trycua.driver 而不是 KepCup。缺权限时由宿主自己开系统设置面板
//（computer.permissionsOpen 既有实现）。
// - embedded 模式的正确性以 source.attribution === 'host' 为信号；授权变化后
//   daemon 必须重启（TCC 按进程缓存）——由 provider 的重启周期承担。

export type CuaDriverPermissionStatus = {
  accessibility: boolean
  screenRecording: boolean
  /** 'host' = embedded 正确归宿主；其它值说明 embedded 模式没生效（诊断信号）。 */
  attribution: string | null
}

export async function checkCuaDriverPermissions(
  client: CuaDriverDaemonClient
): Promise<CuaDriverPermissionStatus> {
  const result = await client.call('check_permissions', { prompt: false })
  const structured = result.structuredContent as {
    accessibility?: unknown
    screen_recording?: unknown
    source?: { attribution?: unknown }
  }
  return {
    accessibility: structured.accessibility === true,
    screenRecording: structured.screen_recording === true,
    attribution:
      typeof structured.source?.attribution === 'string' ? structured.source.attribution : null
  }
}
