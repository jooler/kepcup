import type {
  ComputerInvokeMethod,
  ComputerPermissionsStatus,
  ComputerProviderCapabilities,
} from '@kepcup/shared';
import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
} from './computer/sidecar-client';
import { shutdownComputerProviders } from './computer/computer-provider-lifecycle';
import {
  getComputerUsePermissionStatus,
  openComputerUsePermissions,
} from './computer/macos-computer-use-permissions';
import type { ComputerUsePermissionStatus as OrcaPermissionStatus } from './computer/computer-use-permissions-types';

/**
 * 计算机操控的 main 侧宿主（D105，docs/design/52 §3）：B 口 `computer.*` 的
 * serverMethods 与 renderer 的 IPC（kill switch / 权限引导）都指向这一个聚合，
 * 薄封装编排层（src/main/computer/，移植自 orca）：
 * - 数据面 `invoke` 白名单透传 sidecar（core 的 computer_* 工具调用）；
 * - 控制面 capabilities / permissionsStatus / permissionsOpen / stop；
 * - `shutdown()` 进 beginQuit（沿 orca 的 provider shutdown 语义：terminate
 *   helper、回收 sidecar；下一次调用按需重建）。
 */

export interface ComputerHost {
  invoke(method: ComputerInvokeMethod, params: Record<string, unknown>): Promise<unknown>;
  capabilities(): Promise<ComputerProviderCapabilities | null>;
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
  #active = false;

  async invoke(method: ComputerInvokeMethod, params: Record<string, unknown>): Promise<unknown> {
    this.#active = true;
    // capabilities 直走握手（无参数）；其余按 sidecar 方法面透传。
    if (method === 'capabilities') return callComputerSidecarCapabilities();
    return callComputerSidecarAction(method as never, params);
  }

  async capabilities(): Promise<ComputerProviderCapabilities | null> {
    try {
      return await callComputerSidecarCapabilities();
    } catch (error) {
      console.warn(
        `[computer] capabilities handshake failed — tools stay unregistered: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async permissionsStatus(): Promise<ComputerPermissionsStatus> {
    try {
      // 检测本身会以 --permission-status-file 拉起 helper：首次进设置页即注册 TCC
      //（docs/design/52 §6 权限引导语义，沿 orca permission-status 的静置检测）。
      const result = await getComputerUsePermissionStatus();
      const unavailable = result.helperUnavailableReason !== null;
      return {
        accessibility: mapPermissionStatus(result.permissions[0]?.status ?? 'unsupported', unavailable),
        screenRecording: mapPermissionStatus(result.permissions[1]?.status ?? 'unsupported', unavailable),
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
    const wasActive = this.#active;
    // helper 单会话：terminate helper + 回收 provider/sidecar，下次调用按需重建。
    shutdownComputerProviders();
    this.#active = false;
    return { stopped: true };
  }

  shutdown(): void {
    shutdownComputerProviders();
    this.#active = false;
  }
}

export function createComputerHost(): ComputerHost {
  return new ComputerHostImpl();
}
