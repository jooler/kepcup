import { AppError } from '@kepcup/shared'
import { RuntimeClientError } from './runtime-client-error'

// cua-driver 错误码 → KepCup 模型可见引导码（P-B1，todo/computer-use-cua-adapter.md WP2）。
//
// driver 用小写下划线码；KepCup 的 computerErrorHint（packages/core/tools/
// computer-tools.ts）只认识大写 AppError 码。B 口 channel 只保留 AppError 的
// code——RuntimeClientError 一律被压成 INTERNAL（「现役的坑」），所以本映射表
// 必须抛 AppError。未知码落 accessibility_error + 原始码进 message（模型拿得到
// 引导文案，也不透传原始小写码为 code）。

/** 映射表：driver 小写码（含前缀族）→ AppError 大写码。 */
const DRIVER_CODE_TO_KEPCUP: Readonly<Record<string, string>> = {
  permission_denied: 'PERMISSION_DENIED',
  accessibility_denied: 'PERMISSION_DENIED',
  app_not_found: 'APP_NOT_FOUND',
  window_id_not_found: 'WINDOW_NOT_FOUND',
  window_owner_pid_mismatch: 'WINDOW_NOT_FOUND',
  window_not_found: 'WINDOW_NOT_FOUND',
  // sheet / 换 Space 的窗口能进 list_windows，但背景输入会被拒（AX 面解析不出）——
  // 语义等同「这个窗口不是可操作目标」，让上层重新选窗。
  off_space_or_ax_unresolved: 'WINDOW_NOT_FOUND',
  px_window_not_found: 'WINDOW_NOT_FOUND',
  bring_to_front_window_not_found: 'WINDOW_NOT_FOUND',
  bring_to_front_pid_not_found: 'WINDOW_NOT_FOUND',
  bring_to_front_window_pid_mismatch: 'WINDOW_NOT_FOUND',
  stale_element_token: 'ELEMENT_NOT_FOUND',
  screenshot_context_missing: 'ELEMENT_NOT_FOUND',
  element_not_found: 'ELEMENT_NOT_FOUND',
  background_unavailable: 'BACKGROUND_UNAVAILABLE',
  action_timeout: 'action_timeout',
  invalid_argument: 'invalid_argument',
  value_not_settable: 'value_not_settable',
  element_not_clickable: 'element_not_clickable',
  unsupported: 'action_not_supported',
  menu_path_unavailable: 'action_not_supported'
}

/** 这些 KepCup 码上 computerErrorHint 有专门引导文案；未知 driver 码不许伪装成它们。 */
export function mapCuaDriverErrorCode(driverCode: string | null): string {
  if (driverCode) {
    const mapped = DRIVER_CODE_TO_KEPCUP[driverCode]
    if (mapped) {
      return mapped
    }
  }
  return 'accessibility_error'
}

/**
 * 把 driver 工具级失败（isError:true 的 structuredContent）转成带正确 code 的
 * AppError。message 取 driver 的人类可读文本（含 owner_pid 等引导线索）；
 * 未知码把原始小写码附进 message，不作为 code 暴露。
 */
export function cuaDriverToolError(
  driverCode: string | null,
  message: string
): AppError {
  const code = mapCuaDriverErrorCode(driverCode)
  const detail = message.trim().length > 0 ? message : 'cua-driver tool call failed'
  const finalMessage =
    code === 'accessibility_error' && driverCode
      ? `${detail} (cua-driver code: ${driverCode})`
      : detail
  return new AppError(code, finalMessage)
}

/** 传输层失败（二进制缺失 / socket 断连 / 超时）→ COMPUTER_UNAVAILABLE 族。 */
export function cuaDriverTransportError(message: string): AppError {
  return new AppError('COMPUTER_UNAVAILABLE', message)
}

/**
 * RuntimeClientError 兼容出口：既有编排层（treeBaselines / 侧车分发）按
 * Error.code 序列化错误，工具级失败统一走 AppError；这里只为连接级内部
 * 错误保留同构形状（code 原样保留大写，不会被 channel 压平）。
 */
export function asCuaDriverInternalError(error: unknown): Error {
  if (error instanceof AppError) {
    return error
  }
  if (error instanceof RuntimeClientError) {
    return new AppError('accessibility_error', error.message)
  }
  return new AppError(
    'accessibility_error',
    error instanceof Error ? error.message : String(error)
  )
}
