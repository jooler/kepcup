import { Menu, Tray } from 'electron';
import type { RemoteAnchorState } from '@kepcup/shared';
import { APP_NAME, loadTrayIcon } from './app-brand';

/** 托盘可见的远程遥控快照（core `platform.remoteState` 事件推送）。 */
export interface TrayRemoteState {
  enabled: boolean;
  anchor: RemoteAnchorState;
  onlineDevices: number;
}

export interface TrayController {
  destroy(): void;
  /** Reflects unattended mode (P03): suffix in the tooltip + checkmark. */
  setUnattended(active: boolean): void;
  /** P13 任务 2: shows an update-ready hint in the tooltip. */
  setUpdateReady(version: string): void;
  /** D96 远程遥控：开关勾选态 + 中转状态后缀（未开 / 已连 (n) / 重连中 / 异常）。 */
  setRemote(state: TrayRemoteState): void;
}

/**
 * Tray / menu-bar presence. Labels are duplicated from the renderer i18n
 * module on purpose: the main process has no dependency on renderer code.
 */
export function createTray(options: {
  onOpenWindow: () => void;
  onQuit: () => void;
  onToggleUnattended: () => void;
  onCheckUpdates: () => void;
  /** D96: 勾选「远程遥控」→ 切总开关（菜单动作 = 明确用户意图，core 回推新状态）。 */
  onToggleRemote: () => void;
  /** D96: 「连接手机…」→ 打开窗口并弹出二维码小窗。 */
  onPairPhone: () => void;
}): TrayController {
  const icon = loadTrayIcon();
  if (icon.isEmpty()) {
    // 产物里由 pack-hooks afterPack 硬校验托盘资源存在；这里只兜 dev 场景。
    console.warn('[tray] 托盘图标加载为空（resources/tray/ 缺失或损坏）');
  }

  const tray = new Tray(icon);
  let unattended = false;
  let updateReadyVersion: string | null = null;
  let remote: TrayRemoteState = { enabled: false, anchor: 'off', onlineDevices: 0 };

  /** 状态文案（设计 §3.1）：未开不带后缀；已连 (n) / 重连中 / 异常。 */
  const remoteStatusSuffix = (): string => {
    if (!remote.enabled) return '';
    switch (remote.anchor) {
      case 'online':
        return remote.onlineDevices > 0
          ? `（手机已连接 (${remote.onlineDevices})）`
          : '（中转已连接）';
      case 'connecting':
        return '（中转重连中…）';
      case 'error':
        return '（中转连接异常）';
      case 'off':
        return '';
    }
  };

  const rebuild = () => {
    const suffix = [
      unattended ? '（无人值守模式开启）' : '',
      updateReadyVersion !== null ? `（新版本 ${updateReadyVersion} 待安装）` : '',
      remoteStatusSuffix(),
    ].join('');
    tray.setToolTip(`${APP_NAME}${suffix}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开窗口', click: () => options.onOpenWindow() },
        { label: '检查更新…', click: () => options.onCheckUpdates() },
        { type: 'separator' },
        {
          label: unattended ? '关闭无人值守模式' : '开启无人值守模式',
          type: 'checkbox',
          checked: unattended,
          click: () => options.onToggleUnattended(),
        },
        // D96 远程遥控：开关 + 连接手机（关闭时禁用）。
        {
          label: '远程遥控',
          type: 'checkbox',
          checked: remote.enabled,
          click: () => options.onToggleRemote(),
        },
        {
          label: '连接手机…',
          enabled: remote.enabled,
          click: () => options.onPairPhone(),
        },
        { type: 'separator' },
        { label: '退出', click: () => options.onQuit() },
      ]),
    );
  };
  rebuild();
  tray.on('click', () => options.onOpenWindow());

  return {
    destroy() {
      tray.destroy();
    },
    setUnattended(active: boolean) {
      unattended = active;
      rebuild();
    },
    setUpdateReady(version: string) {
      updateReadyVersion = version;
      rebuild();
    },
    setRemote(next) {
      remote = next;
      rebuild();
    },
  };
}
