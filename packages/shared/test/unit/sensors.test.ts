import { describe, expect, it } from 'vitest';
import {
  SENSOR_KINDS,
  sensorDataShapeSchema,
  sensorDescriptor,
  sensorKindSchema,
  sensorOsMediaTypeSchema,
  sensorTransportSchema,
} from '../../src/index.js';

/** D76 传感器登记表（纯数据）。 */

describe('sensor kinds registry', () => {
  it('covers every SensorKind exactly once', () => {
    const ids = SENSOR_KINDS.map((descriptor) => descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...sensorKindSchema.options].sort());
  });

  it('every descriptor has valid enum fields and an i18n key', () => {
    for (const descriptor of SENSOR_KINDS) {
      expect(sensorTransportSchema.safeParse(descriptor.transport).success).toBe(true);
      expect(sensorDataShapeSchema.safeParse(descriptor.dataShape).success).toBe(true);
      if (descriptor.osMediaType !== null) {
        expect(sensorOsMediaTypeSchema.safeParse(descriptor.osMediaType).success).toBe(true);
      }
      expect(descriptor.i18nKey).toBe(`sensors.${descriptor.id}`);
    }
  });

  it('stream shapes pair with their webmedia os media type', () => {
    for (const descriptor of SENSOR_KINDS) {
      if (descriptor.dataShape === 'stream-audio')
        expect(descriptor.osMediaType).toBe('microphone');
      if (descriptor.dataShape === 'stream-video') expect(descriptor.osMediaType).toBe('camera');
    }
  });

  it('privacy defaults: microphone on (legacy behavior), camera off', () => {
    expect(sensorDescriptor('microphone').defaultEnabled).toBe(true);
    expect(sensorDescriptor('camera').defaultEnabled).toBe(false);
  });
});
