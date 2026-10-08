import { describe, expect, it, vi } from 'vitest';
import type { SensorKind } from '@kepcup/shared';
import { SensorHub, isSelectedDeviceMissing, type SensorState } from './hub';
import { getDriver } from './registry';
import { LEGACY_MIC_DEVICE_KEY, SENSOR_PREFS_KEY, type StorageLike } from './preferences';
import { SensorDisabledError, type SensorDriver } from './types';

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

function fakeStream(): { stream: MediaStream; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn();
  const track = { stop, readyState: 'live' };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, stop };
}

function fakeDriver(kind: SensorKind, overrides: Partial<SensorDriver> = {}): SensorDriver {
  return {
    kind,
    listDevices: () => Promise.resolve([]),
    permissionStatus: () => Promise.resolve('granted'),
    ensureAccess: () => Promise.resolve('granted'),
    openSettings: () => {},
    open: (deviceId) =>
      Promise.resolve({
        stream: fakeStream().stream,
        requestedDeviceId: deviceId,
        fellBack: false,
      }),
    ...overrides,
  };
}

function hubWith(
  drivers: Partial<Record<SensorKind, SensorDriver>> = {},
  storage: StorageLike | null = memoryStorage(),
  onDeviceChange?: (listener: () => void) => () => void,
): SensorHub {
  return new SensorHub({
    storage,
    driverFor: (kind) => drivers[kind] ?? fakeDriver(kind),
    onDeviceChange: onDeviceChange ?? (() => () => {}),
  });
}

describe('SensorHub defaults and persistence', () => {
  it('starts microphone enabled and camera disabled', () => {
    const { microphone, camera } = hubWith().snapshot;
    expect(microphone.enabled).toBe(true);
    expect(camera.enabled).toBe(false);
  });

  it('migrates the legacy mic device id', () => {
    const hub = hubWith({}, memoryStorage({ [LEGACY_MIC_DEVICE_KEY]: 'legacy' }));
    expect(hub.snapshot.microphone.deviceId).toBe('legacy');
  });

  it('persists enable / device choices and restores them', () => {
    const storage = memoryStorage();
    const hub = hubWith({}, storage);
    hub.setEnabled('camera', true);
    hub.setDeviceId('microphone', 'mic-2');
    expect(JSON.parse(storage.getItem(SENSOR_PREFS_KEY) ?? '{}').sensors).toEqual({
      microphone: { enabled: true, deviceId: 'mic-2' },
      camera: { enabled: true, deviceId: '' },
    });
    const restored = hubWith({}, storage);
    expect(restored.snapshot.camera.enabled).toBe(true);
    expect(restored.snapshot.microphone.deviceId).toBe('mic-2');
  });

  it('keeps working when storage is unavailable', () => {
    const hub = hubWith({}, null);
    hub.setDeviceId('microphone', 'x');
    expect(hub.snapshot.microphone.deviceId).toBe('x');
  });
});

describe('SensorHub open / privacy gate', () => {
  it('rejects open while disabled and never touches the driver', async () => {
    const open = vi.fn();
    const hub = hubWith({ camera: fakeDriver('camera', { open }) });
    await expect(hub.open('camera')).rejects.toBeInstanceOf(SensorDisabledError);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens with the chosen device and records the fallback flag', async () => {
    const open = vi.fn((deviceId: string) =>
      Promise.resolve({ stream: fakeStream().stream, requestedDeviceId: deviceId, fellBack: true }),
    );
    const hub = hubWith({ microphone: fakeDriver('microphone', { open }) });
    hub.setDeviceId('microphone', 'gone');
    const opened = await hub.open('microphone');
    expect(open).toHaveBeenCalledWith('gone');
    expect(opened.fellBack).toBe(true);
    expect(hub.snapshot.microphone.fellBack).toBe(true);
    hub.setDeviceId('microphone', '');
    expect(hub.snapshot.microphone.fellBack).toBe(false);
  });

  it('cuts off a stream that arrives after the sensor was disabled mid-open', async () => {
    const { stream, stop } = fakeStream();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const hub = hubWith({
      microphone: fakeDriver('microphone', {
        open: async (deviceId) => {
          await gate;
          return { stream, requestedDeviceId: deviceId, fellBack: false };
        },
      }),
    });
    const pending = hub.open('microphone');
    hub.setEnabled('microphone', false);
    release();
    await expect(pending).rejects.toBeInstanceOf(SensorDisabledError);
    expect(stop).toHaveBeenCalled();
  });

  it('stops already-open streams when the sensor is disabled', async () => {
    const { stream, stop } = fakeStream();
    const hub = hubWith({
      microphone: fakeDriver('microphone', {
        open: (deviceId) =>
          Promise.resolve({ stream, requestedDeviceId: deviceId, fellBack: false }),
      }),
    });
    await hub.open('microphone');
    expect(stop).not.toHaveBeenCalled();
    hub.setEnabled('microphone', false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('records the error and rethrows when open fails', async () => {
    const hub = hubWith({
      microphone: fakeDriver('microphone', { open: () => Promise.reject(new Error('busy')) }),
    });
    await expect(hub.open('microphone')).rejects.toThrow('busy');
    expect(hub.snapshot.microphone.lastError).toBe('busy');
  });
});

describe('SensorHub devices and permission', () => {
  it('refresh stores devices and permission; permission errors become unknown', async () => {
    const hub = hubWith({
      microphone: fakeDriver('microphone', {
        listDevices: () => Promise.resolve([{ deviceId: 'a', label: 'Mic A' }]),
        permissionStatus: () => Promise.reject(new Error('bridge down')),
      }),
    });
    await hub.refresh('microphone');
    expect(hub.snapshot.microphone.devices).toEqual([{ deviceId: 'a', label: 'Mic A' }]);
    expect(hub.snapshot.microphone.permission).toBe('unknown');
  });

  it('lets only the latest overlapping refresh land', async () => {
    const resolvers: Array<(devices: Array<{ deviceId: string; label: string }>) => void> = [];
    const hub = hubWith({
      microphone: fakeDriver('microphone', {
        listDevices: () => new Promise((resolve) => resolvers.push(resolve)),
      }),
    });
    const first = hub.refresh('microphone');
    const second = hub.refresh('microphone');
    resolvers[1]?.([{ deviceId: 'new', label: 'New' }]);
    await second;
    resolvers[0]?.([{ deviceId: 'old', label: 'Old' }]);
    await first;
    expect(hub.snapshot.microphone.devices).toEqual([{ deviceId: 'new', label: 'New' }]);
  });

  it('ensureAccess syncs the permission state', async () => {
    const hub = hubWith({
      camera: fakeDriver('camera', { ensureAccess: () => Promise.resolve('denied') }),
    });
    expect(await hub.ensureAccess('camera')).toBe('denied');
    expect(hub.snapshot.camera.permission).toBe('denied');
  });

  it('refreshes every sensor on devicechange and stops on dispose', async () => {
    let fire: () => void = () => {};
    const stop = vi.fn();
    const listDevices = vi.fn(() => Promise.resolve([]));
    const hub = hubWith(
      {
        microphone: fakeDriver('microphone', { listDevices }),
        camera: fakeDriver('camera', { listDevices }),
      },
      memoryStorage(),
      (listener) => {
        fire = listener;
        return stop;
      },
    );
    const dispose = hub.start();
    expect(hub.start()).toBe(dispose); // 幂等
    fire();
    await vi.waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2));
    dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers with fresh snapshots', () => {
    const hub = hubWith();
    const seen: boolean[] = [];
    const off = hub.subscribe((snapshot) => seen.push(snapshot.camera.enabled));
    hub.setEnabled('camera', true);
    off();
    hub.setEnabled('camera', false);
    expect(seen).toEqual([true]);
  });
});

describe('isSelectedDeviceMissing', () => {
  const base: SensorState = {
    enabled: true,
    deviceId: '',
    devices: [],
    permission: 'granted',
    fellBack: false,
    lastError: null,
  };

  it('is false for the system default', () => {
    expect(isSelectedDeviceMissing({ ...base, devices: [{ deviceId: 'a', label: '' }] })).toBe(
      false,
    );
  });

  it('is true when the chosen id disappeared from a populated list', () => {
    expect(
      isSelectedDeviceMissing({
        ...base,
        deviceId: 'gone',
        devices: [{ deviceId: 'a', label: 'A' }],
      }),
    ).toBe(true);
  });

  it('cannot tell when the list has no ids (not yet authorized) or is empty', () => {
    expect(
      isSelectedDeviceMissing({ ...base, deviceId: 'x', devices: [{ deviceId: '', label: '' }] }),
    ).toBe(false);
    expect(isSelectedDeviceMissing({ ...base, deviceId: 'x' })).toBe(false);
  });
});

describe('registry', () => {
  it('returns webmedia drivers for the registered kinds', () => {
    expect(getDriver('microphone').kind).toBe('microphone');
    expect(getDriver('camera').kind).toBe('camera');
  });
});
