import { describe, expect, it, vi } from 'vitest';
import type { SensorKind } from '@kepcup/shared';
import type { SensorBridge } from './types';
import { createWebmediaDriver } from './webmedia';

function overconstrained(): DOMException {
  return new DOMException('no match', 'OverconstrainedError');
}

function fakeMediaDevices(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  devices: Array<Partial<MediaDeviceInfo>> = [],
): MediaDevices {
  return {
    getUserMedia,
    enumerateDevices: () => Promise.resolve(devices as MediaDeviceInfo[]),
  } as unknown as MediaDevices;
}

const STREAM = { id: 'stream' } as unknown as MediaStream;

function micDriver(md: MediaDevices | undefined, bridge?: SensorBridge) {
  return createWebmediaDriver({
    kind: 'microphone',
    deviceKind: 'audioinput',
    trackKey: 'audio',
    constraints: { echoCancellation: true },
    mediaDevices: () => md,
    bridge: () => bridge,
  });
}

describe('webmedia driver: listDevices', () => {
  it('filters by device kind', async () => {
    const md = fakeMediaDevices(
      () => Promise.resolve(STREAM),
      [
        { kind: 'audioinput', deviceId: 'a', label: 'Mic' },
        { kind: 'videoinput', deviceId: 'v', label: 'Cam' },
        { kind: 'audiooutput', deviceId: 'o', label: 'Speaker' },
      ],
    );
    expect(await micDriver(md).listDevices()).toEqual([{ deviceId: 'a', label: 'Mic' }]);
  });

  it('returns [] when enumeration fails or mediaDevices is missing', async () => {
    const failing = {
      enumerateDevices: () => Promise.reject(new Error('x')),
    } as unknown as MediaDevices;
    expect(await micDriver(failing).listDevices()).toEqual([]);
    expect(await micDriver(undefined).listDevices()).toEqual([]);
  });
});

describe('webmedia driver: open', () => {
  it('uses soft constraints on the default device, no fallback flag', async () => {
    const getUserMedia = vi.fn(() => Promise.resolve(STREAM));
    const opened = await micDriver(fakeMediaDevices(getUserMedia)).open('');
    expect(opened).toEqual({ stream: STREAM, requestedDeviceId: '', fellBack: false });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true } });
  });

  it('requests the exact device first', async () => {
    const getUserMedia = vi.fn(() => Promise.resolve(STREAM));
    const opened = await micDriver(fakeMediaDevices(getUserMedia)).open('mic-1');
    expect(opened.fellBack).toBe(false);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, deviceId: { exact: 'mic-1' } },
    });
  });

  it('drops soft constraints but keeps the chosen device when only they fail', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(overconstrained())
      .mockResolvedValueOnce(STREAM);
    const opened = await micDriver(fakeMediaDevices(getUserMedia)).open('mic-1');
    expect(opened.fellBack).toBe(false);
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'mic-1' } } });
  });

  it('falls back to the system default and reports it when the device is gone', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(overconstrained())
      .mockRejectedValueOnce(overconstrained())
      .mockResolvedValueOnce(STREAM);
    const opened = await micDriver(fakeMediaDevices(getUserMedia)).open('gone');
    expect(opened.fellBack).toBe(true);
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true });
  });

  it('falls back to a bare default device without flagging when none was chosen', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(overconstrained())
      .mockResolvedValueOnce(STREAM);
    const opened = await micDriver(fakeMediaDevices(getUserMedia)).open('');
    expect(opened.fellBack).toBe(false);
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true });
  });

  it('does not degrade on permission errors', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    await expect(micDriver(fakeMediaDevices(getUserMedia)).open('mic-1')).rejects.toThrow(
      /NotAllowedError/,
    );
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('surfaces the last error when every attempt fails', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(overconstrained());
    await expect(micDriver(fakeMediaDevices(getUserMedia)).open('mic-1')).rejects.toThrow(
      /OverconstrainedError/,
    );
    expect(getUserMedia).toHaveBeenCalledTimes(3);
  });

  it('throws when mediaDevices is unavailable', async () => {
    await expect(micDriver(undefined).open('')).rejects.toThrow(/unavailable/);
  });
});

describe('webmedia driver: access gate', () => {
  function bridge(
    status: Awaited<ReturnType<SensorBridge['sensorPermissionStatus']>>,
    grant = true,
  ) {
    const kinds: SensorKind[] = [];
    const impl: SensorBridge = {
      sensorPermissionStatus: (kind) => {
        kinds.push(kind);
        return Promise.resolve(status);
      },
      sensorPermissionRequest: () => Promise.resolve(grant),
      sensorOpenSettings: () => Promise.resolve(),
    };
    return { impl, kinds };
  }

  it('passes without a bridge (unit / non-Electron host)', async () => {
    expect(await micDriver(undefined).ensureAccess()).toBe('granted');
  });

  it('maps TCC states', async () => {
    expect(await micDriver(undefined, bridge('granted').impl).ensureAccess()).toBe('granted');
    expect(await micDriver(undefined, bridge('denied').impl).ensureAccess()).toBe('denied');
    expect(await micDriver(undefined, bridge('restricted').impl).ensureAccess()).toBe('denied');
    expect(await micDriver(undefined, bridge('unknown').impl).ensureAccess()).toBe('unavailable');
  });

  it('asks the OS when not determined', async () => {
    expect(await micDriver(undefined, bridge('not-determined', true).impl).ensureAccess()).toBe(
      'granted',
    );
    expect(await micDriver(undefined, bridge('not-determined', false).impl).ensureAccess()).toBe(
      'denied',
    );
  });

  it('passes its own kind to the bridge', async () => {
    const b = bridge('granted');
    await micDriver(undefined, b.impl).ensureAccess();
    expect(b.kinds).toEqual(['microphone']);
  });
});
