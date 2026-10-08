import { describe, expect, it } from 'vitest';
import {
  LEGACY_MIC_DEVICE_KEY,
  SENSOR_PREFS_KEY,
  loadSensorPrefs,
  saveSensorPrefs,
  type StorageLike,
} from './preferences';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const throwingStorage: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('sensor preferences (D76)', () => {
  it('round-trips through the v1 key', () => {
    const storage = memoryStorage();
    saveSensorPrefs(
      { microphone: { enabled: false, deviceId: 'mic-1' }, camera: { enabled: true } },
      storage,
    );
    expect(loadSensorPrefs(storage)).toEqual({
      microphone: { enabled: false, deviceId: 'mic-1' },
      camera: { enabled: true },
    });
  });

  it('imports the legacy mic device id once and keeps the legacy key', () => {
    const storage = memoryStorage({ [LEGACY_MIC_DEVICE_KEY]: 'legacy-mic' });
    expect(loadSensorPrefs(storage)).toEqual({ microphone: { deviceId: 'legacy-mic' } });
    expect(storage.data.get(LEGACY_MIC_DEVICE_KEY)).toBe('legacy-mic');
    expect(JSON.parse(storage.data.get(SENSOR_PREFS_KEY) ?? '{}')).toEqual({
      version: 1,
      sensors: { microphone: { deviceId: 'legacy-mic' } },
    });
  });

  it('prefers the v1 key over the legacy key', () => {
    const storage = memoryStorage({ [LEGACY_MIC_DEVICE_KEY]: 'legacy-mic' });
    saveSensorPrefs({ microphone: { deviceId: 'new-mic' } }, storage);
    expect(loadSensorPrefs(storage).microphone?.deviceId).toBe('new-mic');
  });

  it('ignores corrupt payloads, unknown kinds and malformed fields', () => {
    expect(loadSensorPrefs(memoryStorage({ [SENSOR_PREFS_KEY]: '{not json' }))).toEqual({});
    expect(
      loadSensorPrefs(memoryStorage({ [SENSOR_PREFS_KEY]: '{"version":2,"sensors":{}}' })),
    ).toEqual({});
    expect(
      loadSensorPrefs(
        memoryStorage({
          [SENSOR_PREFS_KEY]: JSON.stringify({
            version: 1,
            sensors: { temperature: { enabled: true }, camera: { enabled: 'yes', deviceId: 5 } },
          }),
        }),
      ),
    ).toEqual({ camera: {} });
  });

  it('does not overwrite a newer-version blob', () => {
    const newer = JSON.stringify({ version: 2, sensors: {} });
    const storage = memoryStorage({ [SENSOR_PREFS_KEY]: newer });
    saveSensorPrefs({ camera: { enabled: true } }, storage);
    expect(storage.data.get(SENSOR_PREFS_KEY)).toBe(newer);
  });

  it('degrades silently when storage is unavailable', () => {
    expect(loadSensorPrefs(throwingStorage)).toEqual({});
    expect(() => saveSensorPrefs({ camera: { enabled: true } }, throwingStorage)).not.toThrow();
    expect(loadSensorPrefs(null)).toEqual({});
    expect(() => saveSensorPrefs({}, null)).not.toThrow();
  });
});
