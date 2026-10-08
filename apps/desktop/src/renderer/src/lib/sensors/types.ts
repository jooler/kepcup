import type { SensorKind, SensorPermissionStatus } from '@kepcup/shared';

/**
 * 传感器渲染层类型（docs/design/31-sensors.md §2.2，D76）。
 * driver 只负责「怎么接」；启停、设备偏好、状态聚合在 hub。
 */

export interface SensorDevice {
  deviceId: string;
  label: string;
}

/** 授权门结果：unavailable = 查不到状态（桥异常 / unknown），调用方给通用失败提示。 */
export type SensorAccess = 'granted' | 'denied' | 'unavailable';

/** webmedia 传感器 open 的产物。 */
export interface OpenedSensor {
  stream: MediaStream;
  /** 调用方请求的设备（空串 = 系统默认）。 */
  requestedDeviceId: string;
  /** 请求了具体设备却因其不可用而回退到系统默认——必须向用户显式报告，不能静默。 */
  fellBack: boolean;
}

export interface SensorDriver {
  readonly kind: SensorKind;
  listDevices(): Promise<SensorDevice[]>;
  /** 只读系统权限状态（不弹框）。 */
  permissionStatus(): Promise<SensorPermissionStatus>;
  /** 授权门：not-determined 时主动拉起系统授权框；被拒返回 denied。 */
  ensureAccess(): Promise<SensorAccess>;
  /** 深链系统设置对应面板（denied 后的唯一去路）。 */
  openSettings(): void;
  open(deviceId: string): Promise<OpenedSensor>;
}

/** 传感器被用户停用时 open 的拒绝（隐私总闸，D76-5）。 */
export class SensorDisabledError extends Error {
  constructor(readonly kind: SensorKind) {
    super(`Sensor disabled: ${kind}`);
    this.name = 'SensorDisabledError';
  }
}

/** 渲染层看到的主进程桥子集（window.kepcup；无桥环境为 undefined）。 */
export interface SensorBridge {
  sensorPermissionStatus(kind: SensorKind): Promise<SensorPermissionStatus>;
  sensorPermissionRequest(kind: SensorKind): Promise<boolean>;
  sensorOpenSettings(kind: SensorKind): Promise<void>;
}
