import { z } from 'zod';

/**
 * 传感器登记表（docs/design/31-sensors.md，D76）。
 *
 * 硬件接入统一为「传感器」：kind（测什么）× transport（怎么接）× dataShape
 * （数据形态）三个维度分开建模。渲染层与主进程共用这一份纯数据事实；加一种
 * 传感器 = 这里加一行 + 一个 driver + 设置页一个测试插槽。
 *
 * 本期只登记 microphone / camera，且只实现 `webmedia` transport；其余取值是
 * 类型层面的预留，不对应任何实现。
 */

export const sensorKindSchema = z.enum(['microphone', 'camera']);
export type SensorKind = z.infer<typeof sensorKindSchema>;

/** 接入方式：webmedia = 渲染层 getUserMedia；其余为将来的主进程 / core 侧通道。 */
export const sensorTransportSchema = z.enum(['webmedia', 'serial', 'ble', 'hid', 'network']);
export type SensorTransport = z.infer<typeof sensorTransportSchema>;

/** 数据形态：决定下游怎么消费（流按需采集 / 抽帧；标量入时序表）。 */
export const sensorDataShapeSchema = z.enum(['stream-audio', 'stream-video', 'scalar']);
export type SensorDataShape = z.infer<typeof sensorDataShapeSchema>;

/** macOS TCC / 系统隐私面板对应的媒体类型（与 Electron systemPreferences 同名）。 */
export const sensorOsMediaTypeSchema = z.enum(['microphone', 'camera']);
export type SensorOsMediaType = z.infer<typeof sensorOsMediaTypeSchema>;

/** 系统层面的权限状态（Electron `getMediaAccessStatus` 取值 + 无权限门时的 granted）。 */
export const sensorPermissionStatusSchema = z.enum([
  'not-determined',
  'granted',
  'denied',
  'restricted',
  'unknown',
]);
export type SensorPermissionStatus = z.infer<typeof sensorPermissionStatusSchema>;

export interface SensorKindDescriptor {
  id: SensorKind;
  transport: SensorTransport;
  dataShape: SensorDataShape;
  /** 有系统权限门的传感器填媒体类型；无门（如网络传感器）为 null。 */
  osMediaType: SensorOsMediaType | null;
  /** 首次使用时的启用状态：麦克风保持现状默认开，摄像头默认关（隐私总闸）。 */
  defaultEnabled: boolean;
  /** 界面文案 key（名称 `{i18nKey}.name`、说明 `{i18nKey}.description`）。 */
  i18nKey: string;
}

export const SENSOR_KINDS: readonly SensorKindDescriptor[] = [
  {
    id: 'microphone',
    transport: 'webmedia',
    dataShape: 'stream-audio',
    osMediaType: 'microphone',
    defaultEnabled: true,
    i18nKey: 'sensors.microphone',
  },
  {
    id: 'camera',
    transport: 'webmedia',
    dataShape: 'stream-video',
    osMediaType: 'camera',
    defaultEnabled: false,
    i18nKey: 'sensors.camera',
  },
];

export function sensorDescriptor(kind: SensorKind): SensorKindDescriptor {
  const found = SENSOR_KINDS.find((descriptor) => descriptor.id === kind);
  if (found === undefined) throw new Error(`Unknown sensor kind: ${kind}`);
  return found;
}
