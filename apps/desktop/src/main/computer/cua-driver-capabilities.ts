import type { ComputerProviderCapabilities } from '@kepcup/shared'

// cua-driver 能力合成（P-B1，todo/computer-use-cua-adapter.md WP5）。
//
// cua 没有 capabilities 工具：按「平台 + 版本」静态合成。对齐现役（原生
// provider）等价上报——core 会用 supports gate 工具（ensureCapability），漏报
// 会拒掉可用工具。windows.focus / moveResize / surfaces.menus 虽然 cua 支持
//（bring_to_front / set_window_frame / invoke_menu），但对应工具本期未暴露
//（P-B2 一起开）：虚报会让模型去调用不存在的能力。

export const CUA_DRIVER_PROTOCOL_VERSION = 1

export function synthesizeCuaDriverCapabilities(
  providerVersion: string,
  platform: 'darwin' | 'win32' | 'linux' = 'darwin'
): ComputerProviderCapabilities {
  return {
    platform,
    provider: 'cua-driver',
    providerVersion,
    protocolVersion: CUA_DRIVER_PROTOCOL_VERSION,
    supports: {
      apps: { list: true, bundleIds: true, pids: true },
      windows: {
        list: true,
        targetById: true,
        targetByIndex: true,
        focus: false,
        moveResize: false
      },
      observation: {
        screenshot: true,
        annotatedScreenshot: false,
        elementFrames: true,
        ocr: false
      },
      actions: {
        click: true,
        typeText: true,
        pressKey: true,
        hotkey: true,
        pasteText: true,
        scroll: true,
        drag: true,
        setValue: true,
        performAction: true
      },
      surfaces: { menus: false, dialogs: false, dock: false, menubar: false },
      input: { background: true }
    }
  }
}
