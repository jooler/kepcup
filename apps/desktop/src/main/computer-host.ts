import type {
  ComputerInvokeMethod,
  ComputerPermissionsStatus,
  ComputerProviderCapabilities,
} from '@kepcup/shared';
import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
  setComputerSidecarUserDataDirectory,
  shutdownComputerSidecar,
} from './computer/sidecar-client';
import {
  openComputerUsePermissions,
  readComputerUsePermissionStatus,
  type ComputerPermissionApi,
  type ComputerPermissionShell,
  type ComputerUsePermissionStatus,
} from './computer/computer-use-permissions';
import {
  readCapabilitiesRecord,
  writeCapabilitiesRecord,
  type ComputerCapabilitiesRecord,
} from './computer/capabilities-record';
import { isHostShuttingDown } from './computer/host-shutdown-state';

/**
 * 计算机操控的 main 侧宿主（D105 / P-B2，docs/design/52 §3）：B 口 `computer.*` 的
 * serverMethods 与 renderer 的 IPC（kill switch / 权限引导）都指向这一个聚合，
 * 薄封装编排层（src/main/computer/）：
 * - 数据面 `invoke` 白名单透传 sidecar（core 的 computer_* 工具调用）；
 * - 控制面 capabilities（结果落盘 userData，见 computer/capabilities-record.ts）/
 *   capabilitiesStatus（设置页可用性行）/ permissionsStatus / permissionsOpen / stop；
 * - `shutdown()` 进 beginQuit：杀掉 sidecar，其 disconnect 处理终止 CuaDriver daemon；
 *   下一次调用按需重建。
 */

export interface ComputerHost {
  invoke(method: ComputerInvokeMethod, params: Record<string, unknown>): Promise<unknown>;
  capabilities(): Promise<ComputerProviderCapabilities | null>;
  /**
   * 设置页可用性状态（2026-10-31 冒烟反馈）：重新握手并把结果（含失败原因）落盘，
   * 「本次能不能用」与 TCC 权限状态分开呈现。
   */
  capabilitiesStatus(): Promise<ComputerCapabilitiesRecord>;
  permissionsStatus(): Promise<ComputerPermissionsStatus>;
  permissionsOpen(permission: 'accessibility' | 'screen-recording'): Promise<void>;
  stop(reason?: string): { stopped: boolean };
  /** app 退出收尾（beginQuit / will-quit 调用；与 BrowserHost.closeAll 同位）。 */
  shutdown(): void;
}

/** main 注入的权限读写依赖（Electron systemPreferences / shell.openExternal）。 */
export type ComputerHostPermissionDeps = {
  api: ComputerPermissionApi;
  shell: ComputerPermissionShell;
  /** 测试注入；缺省用 process.platform。 */
  platform?: NodeJS.Platform;
};

class ComputerHostImpl implements ComputerHost {
  #userDataDir: () => string;
  #permissionDeps: ComputerHostPermissionDeps | null;
  #lastPermissionStatus: ComputerUsePermissionStatus | null = null;
  /**
   * 权限变化后不要立刻杀 sidecar（可能承载在途动作，会让结果降级为
   * not_started）；标记到下一次 invoke 前再重启，确保新动作读到的 TCC 是新的。
   */
  #restartSidecarBeforeNextInvoke = false;

  constructor(
    userDataDir: () => string,
    permissionDeps: ComputerHostPermissionDeps | null = null,
  ) {
    this.#userDataDir = userDataDir;
    this.#permissionDeps = permissionDeps;
    // cua-driver provider（P-B1 WP6）的 socket 目录要落到 userData 下：main 在
    // fork sidecar 时经环境变量带给 sidecar（sidecar 进程无 app.getPath）。
    setComputerSidecarUserDataDirectory(userDataDir());
  }

  async invoke(method: ComputerInvokeMethod, params: Record<string, unknown>): Promise<unknown> {
    if (this.#restartSidecarBeforeNextInvoke) {
      this.#restartSidecarBeforeNextInvoke = false;
      shutdownComputerSidecar();
    }
    // capabilities 直走握手（无参数）；其余按 sidecar 方法面透传。
    if (method === 'capabilities') return callComputerSidecarCapabilities();
    return callComputerSidecarAction(method as never, params);
  }

  async capabilities(): Promise<ComputerProviderCapabilities | null> {
    try {
      const result = await callComputerSidecarCapabilities();
      writeCapabilitiesRecord(this.#userDataDir(), {
        available: true,
        error: null,
        checkedAt: Date.now(),
      });
      return result;
    } catch (error) {
      // 落盘让失败离开 stdout（设置页可用性行读它，见 capabilities-record.ts）。
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[computer] capabilities handshake failed — tools stay unregistered: ${message}`,
      );
      writeCapabilitiesRecord(this.#userDataDir(), {
        available: false,
        error: message,
        checkedAt: Date.now(),
      });
      return null;
    }
  }

  /** 重新握手取最新结论（缓存可能是陈旧的上次结果；检查会启动 CuaDriver daemon）。 */
  async capabilitiesStatus(): Promise<ComputerCapabilitiesRecord> {
    const capabilities = await this.capabilities();
    if (capabilities !== null) {
      return { available: true, error: null, checkedAt: Date.now() };
    }
    const record = readCapabilitiesRecord(this.#userDataDir());
    return {
      available: false,
      error: record?.error ?? 'capabilities handshake failed',
      checkedAt: record?.checkedAt ?? Date.now(),
    };
  }

  async permissionsStatus(): Promise<ComputerPermissionsStatus> {
    if (isHostShuttingDown()) {
      return { accessibility: 'unknown', screenRecording: 'unknown' };
    }
    if (!this.#permissionDeps) {
      return { accessibility: 'unknown', screenRecording: 'unknown' };
    }
    // CuaDriver embedded 模式下 TCC 归宿主：直接读 KepCup 的 systemPreferences。
    const status = readComputerUsePermissionStatus(
      this.#permissionDeps.api,
      this.#permissionDeps.platform,
    );
    // TCC 按进程缓存：检测到新授权时标记下一次 invoke 前重启 sidecar，
    // 不打断可能正在执行的动作。
    const previous = this.#lastPermissionStatus;
    this.#lastPermissionStatus = status;
    if (
      previous !== null &&
      ((status.accessibility === 'granted' && previous.accessibility !== 'granted') ||
        (status.screenRecording === 'granted' && previous.screenRecording !== 'granted'))
    ) {
      this.#restartSidecarBeforeNextInvoke = true;
    }
    return status;
  }

  async permissionsOpen(permission: 'accessibility' | 'screen-recording'): Promise<void> {
    if (isHostShuttingDown()) {
      return;
    }
    if (!this.#permissionDeps) {
      throw new Error('computer-use permissions are not available in this host');
    }
    // AX 触发系统提示并打开辅助功能面板；屏幕录制只开面板（无 Electron 请求 API）。
    await openComputerUsePermissions(
      permission,
      this.#permissionDeps.api,
      this.#permissionDeps.shell,
      this.#permissionDeps.platform,
    );
    // TCC 按进程缓存：下一次 invoke 前重启 sidecar，读取新授权。
    this.#restartSidecarBeforeNextInvoke = true;
  }

  stop(reason?: string): { stopped: boolean } {
    if (reason !== undefined && reason.length > 0) {
      console.warn(`[computer] stopping control session: ${reason}`);
    }
    // provider 跑在 sidecar 子进程里：杀掉 sidecar，其 disconnect 处理会终止
    // CuaDriver daemon；下一次调用按需重建。
    shutdownComputerSidecar();
    return { stopped: true };
  }

  shutdown(): void {
    shutdownComputerSidecar();
  }
}

export function createComputerHost(
  userDataDir: () => string,
  permissionDeps: ComputerHostPermissionDeps | null = null,
): ComputerHost {
  return new ComputerHostImpl(userDataDir, permissionDeps);
}
