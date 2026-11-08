import type {
  ComputerInvokeMethod,
  ComputerPermissionsStatus,
  ComputerProviderCapabilities,
} from '@kepcup/shared';
import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
  setComputerSidecarUserDataDirectory,
} from './computer/sidecar-client';
import { shutdownComputerProviders } from './computer/computer-provider-lifecycle';
import {
  getComputerUsePermissionStatus,
  openComputerUsePermissions,
} from './computer/macos-computer-use-permissions';
import type { ComputerUsePermissionStatus as OrcaPermissionStatus } from './computer/computer-use-permissions-types';
import {
  readCapabilitiesRecord,
  writeCapabilitiesRecord,
  type ComputerCapabilitiesRecord,
} from './computer/capabilities-record';

/**
 * 计算机操控的 main 侧宿主（D105，docs/design/52 §3）：B 口 `computer.*` 的
 * serverMethods 与 renderer 的 IPC（kill switch / 权限引导）都指向这一个聚合，
 * 薄封装编排层（src/main/computer/，移植自 orca）：
 * - 数据面 `invoke` 白名单透传 sidecar（core 的 computer_* 工具调用）；
 * - 控制面 capabilities（结果落盘 userData，见 computer/capabilities-record.ts）/
 *   capabilitiesStatus（设置页可用性行）/ permissionsStatus / permissionsOpen / stop；
 * - `shutdown()` 进 beginQuit（沿 orca 的 provider shutdown 语义：terminate
 *   helper、回收 sidecar；下一次调用按需重建）。
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

/** orca 权限状态 → shared 三态（helper 不可用时整体 unknown，非 macOS 同）。 */
function mapPermissionStatus(
  status: OrcaPermissionStatus,
  helperUnavailable: boolean,
): 'granted' | 'not-granted' | 'unknown' {
  if (status === 'granted') return 'granted';
  if (helperUnavailable || status === 'unsupported') return 'unknown';
  return 'not-granted';
}

class ComputerHostImpl implements ComputerHost {
  #userDataDir: () => string;

  constructor(userDataDir: () => string) {
    this.#userDataDir = userDataDir;
    // cua-driver provider（P-B1 WP6）的 socket 目录要落到 userData 下：main 在
    // fork sidecar 时经环境变量带给 sidecar（sidecar 进程无 app.getPath）。
    setComputerSidecarUserDataDirectory(userDataDir());
  }

  async invoke(method: ComputerInvokeMethod, params: Record<string, unknown>): Promise<unknown> {
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

  /** 重新握手取最新结论（缓存可能是陈旧的上次结果；检查本身与权限检测一样会拉起 helper）。 */
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
    try {
      // 检测本身会以 --permission-status-file 拉起 helper：首次进设置页即注册 TCC
      //（docs/design/52 §6 权限引导语义，沿 orca permission-status 的静置检测）。
      const result = await getComputerUsePermissionStatus();
      const unavailable = result.helperUnavailableReason !== null;
      return {
        accessibility: mapPermissionStatus(
          result.permissions[0]?.status ?? 'unsupported',
          unavailable,
        ),
        screenRecording: mapPermissionStatus(
          result.permissions[1]?.status ?? 'unsupported',
          unavailable,
        ),
      };
    } catch (error) {
      console.warn(
        `[computer] permission status check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { accessibility: 'unknown', screenRecording: 'unknown' };
    }
  }

  async permissionsOpen(permission: 'accessibility' | 'screen-recording'): Promise<void> {
    // openComputerUsePermissions 拉起 helper 的 --permissions 前台引导窗口
    //（打开系统设置的 TCC 面板）；节流 / 排队语义由编排层持有（沿 orca）。
    // 编排层的权限 id 沿 orca 命名：screen-recording → screenshots。
    const result = await openComputerUsePermissions(
      permission === 'screen-recording' ? 'screenshots' : 'accessibility',
    );
    if (result.helperAppPath === null && result.platform === 'darwin') {
      throw new Error('KepCup Computer Use.app was not found');
    }
  }

  stop(reason?: string): { stopped: boolean } {
    if (reason !== undefined && reason.length > 0) {
      console.warn(`[computer] stopping control session: ${reason}`);
    }
    // helper 单会话：terminate helper + 回收 provider/sidecar，下次调用按需重建。
    shutdownComputerProviders();
    return { stopped: true };
  }

  shutdown(): void {
    shutdownComputerProviders();
  }
}

export function createComputerHost(userDataDir: () => string): ComputerHost {
  return new ComputerHostImpl(userDataDir);
}
