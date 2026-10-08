import { sensorDescriptor, type SensorKind } from '@kepcup/shared';
import { cameraDriver } from './camera';
import { microphoneDriver } from './microphone';
import type { SensorDriver } from './types';

/**
 * kind → driver 映射（docs/design/31-sensors.md §2.2）。本期只有 webmedia
 * transport 有实现；描述表里 transport 非 webmedia 的 kind 在此显式抛错，
 * 不静默。
 */
const WEBMEDIA_DRIVERS: Partial<Record<SensorKind, SensorDriver>> = {
  microphone: microphoneDriver,
  camera: cameraDriver,
};

export function getDriver(kind: SensorKind): SensorDriver {
  const transport = sensorDescriptor(kind).transport;
  if (transport !== 'webmedia') {
    throw new Error(`Sensor transport not implemented: ${transport} (${kind})`);
  }
  const driver = WEBMEDIA_DRIVERS[kind];
  if (driver === undefined) throw new Error(`No driver registered for sensor: ${kind}`);
  return driver;
}
