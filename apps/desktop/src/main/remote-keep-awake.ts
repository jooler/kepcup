/**
 * 远程遥控连接期间的系统休眠抑制（D96 §4.4 按需连接的配套，2026-10）：
 * 中转连接只在「有用」时存在（配对码窗口 / 设备在线 / 驻留窗），但连接存续
 * 期间系统一休眠 WSS 就断，手机端等待中的连接无从保持。本模块按 anchor 状态
 * 接通 / 释放 Electron powerSaveBlocker——`prevent-app-suspension`：不点亮
 * 屏幕、只阻止空闲休眠与应用挂起（App Nap）；合盖 / 用户主动关机仍会断开，
 * 属系统能力边界。
 *
 * 状态驱动（platform.remoteState 推送 + core 就绪初值，见 index.ts 的两个
 * 汇合点）：`connecting / online / error` 都算「连接活着」——error 是退避重连
 * 中，保持唤醒才能在网络恢复时自愈重连；`idle / off` 释放，把休眠权还给系统
 * （idle 本身就是按需连接策略下的「无人使用」态）。
 */

/** Electron powerSaveBlocker 的结构子集（保持本模块可在纯 Node 单测）。 */
export interface PowerSaveBlockerApi {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
}

/** 连接是否「活着」（需要阻止休眠）：error 是退避重连中，同样算活着。 */
export function remoteConnectionAlive(enabled: boolean, anchor: string): boolean {
  return enabled && (anchor === 'connecting' || anchor === 'online' || anchor === 'error');
}

export interface RemoteKeepAwake {
  /** 按最新状态接通 / 释放休眠抑制（幂等，可随每次状态推送重复调用）。 */
  update(enabled: boolean, anchor: string): void;
}

export function createRemoteKeepAwake(blocker: PowerSaveBlockerApi): RemoteKeepAwake {
  let blockerId: number | null = null;
  return {
    update(enabled, anchor) {
      const need = remoteConnectionAlive(enabled, anchor);
      if (need && blockerId === null) {
        try {
          blockerId = blocker.start('prevent-app-suspension');
        } catch {
          // 平台不支持等：休眠抑制是尽力而为，不影响连接本身。
          blockerId = null;
        }
      } else if (!need && blockerId !== null) {
        try {
          blocker.stop(blockerId);
        } catch {
          // 已失效的 blocker id：释放意图已达成，忽略。
        }
        blockerId = null;
      }
    },
  };
}
