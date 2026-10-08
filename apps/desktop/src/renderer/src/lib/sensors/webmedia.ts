import { sensorDescriptor, type SensorKind, type SensorPermissionStatus } from '@kepcup/shared';
import type { OpenedSensor, SensorAccess, SensorBridge, SensorDevice, SensorDriver } from './types';

/**
 * webmedia 基座（docs/design/31-sensors.md §2.2，D76）：麦克风与摄像头共用的
 * 枚举 / 授权门 / 打开（含回退）。各传感器只提供自己的约束。
 *
 * 授权门语义沿用 26 号设计：macOS TCC 弹框只出现一次，not-determined 时由主进程
 * 主动拉起；denied / restricted 只能引导去系统设置。无桥环境（单测 / 非
 * Electron 宿主）放行。
 */

export interface WebmediaDriverOptions {
  kind: SensorKind;
  /** enumerateDevices 的 kind 过滤。 */
  deviceKind: 'audioinput' | 'videoinput';
  /** getUserMedia 的轨道键。 */
  trackKey: 'audio' | 'video';
  /** 软性（ideal）约束；精确约束在部分设备上会 OverconstrainedError。 */
  constraints: MediaTrackConstraints;
  /** 注入点（单测）；默认取 navigator.mediaDevices。 */
  mediaDevices?: () => MediaDevices | undefined;
  bridge?: () => SensorBridge | undefined;
}

/** 把底层异常转成可直接展示的技术性原因（调试定位用）。 */
export function describeMediaError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
}

export function createWebmediaDriver(options: WebmediaDriverOptions): SensorDriver {
  const { kind, deviceKind, trackKey, constraints } = options;
  if (sensorDescriptor(kind).transport !== 'webmedia') {
    throw new Error(`Sensor ${kind} is not a webmedia sensor`);
  }
  const mediaDevices = options.mediaDevices ?? (() => globalThis.navigator?.mediaDevices);
  const bridge =
    options.bridge ?? (() => (globalThis as { window?: { kepcup?: SensorBridge } }).window?.kepcup);

  async function permissionStatus(): Promise<SensorPermissionStatus> {
    const b = bridge();
    if (b === undefined) return 'granted';
    return b.sensorPermissionStatus(kind);
  }

  return {
    kind,
    async listDevices(): Promise<SensorDevice[]> {
      try {
        const devices = (await mediaDevices()?.enumerateDevices()) ?? [];
        return devices
          .filter((device) => device.kind === deviceKind)
          .map((device) => ({ deviceId: device.deviceId, label: device.label }));
      } catch {
        return [];
      }
    },
    permissionStatus,
    async ensureAccess(): Promise<SensorAccess> {
      const b = bridge();
      if (b === undefined) return 'granted';
      const status = await b.sensorPermissionStatus(kind);
      if (status === 'granted') return 'granted';
      if (status === 'not-determined') {
        // 系统授权弹框在这里被拉起；用户拒绝 → denied（之后只能去系统设置）。
        return (await b.sensorPermissionRequest(kind)) ? 'granted' : 'denied';
      }
      if (status === 'denied' || status === 'restricted') return 'denied';
      return 'unavailable';
    },
    openSettings(): void {
      void bridge()?.sensorOpenSettings(kind);
    },
    async open(deviceId: string): Promise<OpenedSensor> {
      const md = mediaDevices();
      if (md === undefined) throw new Error('mediaDevices unavailable');
      const exact: MediaTrackConstraints = { deviceId: { exact: deviceId } };
      // 依次尝试：软约束+指定设备 → 仅指定设备 → 系统默认（设备不可用）。
      // 无指定设备时：软约束 → 裸设备。
      const attempts: Array<{ track: MediaTrackConstraints | true; fellBack: boolean }> =
        deviceId.length > 0
          ? [
              { track: { ...constraints, ...exact }, fellBack: false },
              { track: exact, fellBack: false },
              { track: true, fellBack: true },
            ]
          : [
              { track: { ...constraints }, fellBack: false },
              { track: true, fellBack: false },
            ];
      let lastError: unknown;
      for (const attempt of attempts) {
        try {
          const stream = await md.getUserMedia({ [trackKey]: attempt.track });
          return { stream, requestedDeviceId: deviceId, fellBack: attempt.fellBack };
        } catch (error) {
          lastError = error;
          const name = errorName(error);
          // 只有「约束 / 设备不满足」才继续降级；授权被拒等直接上抛。
          const degradable =
            name === 'OverconstrainedError' || (deviceId.length > 0 && name === 'NotFoundError');
          if (!degradable) break;
        }
      }
      throw new Error(describeMediaError(lastError), { cause: lastError });
    },
  };
}
