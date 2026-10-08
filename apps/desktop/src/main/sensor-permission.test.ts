import { describe, expect, test, vi } from 'vitest';
import {
  parseSensorKind,
  sensorPermissionRequest,
  sensorPermissionStatus,
  sensorSettingsUrl,
  type MediaAccessApi,
} from './sensor-permission.js';

function fakeApi(status: ReturnType<MediaAccessApi['getMediaAccessStatus']> = 'not-determined') {
  const getMediaAccessStatus = vi.fn(() => status);
  const askForMediaAccess = vi.fn(() => Promise.resolve(true));
  return {
    api: { getMediaAccessStatus, askForMediaAccess } satisfies MediaAccessApi,
    getMediaAccessStatus,
    askForMediaAccess,
  };
}

describe('sensor permission gate (D76)', () => {
  test('macOS maps kind to the TCC media type', async () => {
    const { api, getMediaAccessStatus, askForMediaAccess } = fakeApi('denied');
    expect(sensorPermissionStatus('microphone', api, 'darwin')).toBe('denied');
    expect(sensorPermissionStatus('camera', api, 'darwin')).toBe('denied');
    expect(getMediaAccessStatus).toHaveBeenNthCalledWith(1, 'microphone');
    expect(getMediaAccessStatus).toHaveBeenNthCalledWith(2, 'camera');
    await expect(sensorPermissionRequest('camera', api, 'darwin')).resolves.toBe(true);
    expect(askForMediaAccess).toHaveBeenCalledWith('camera');
  });

  test.each(['win32', 'linux'] as const)(
    '%s has no TCC gate: always granted, api untouched',
    async (platform) => {
      const { api, getMediaAccessStatus, askForMediaAccess } = fakeApi('denied');
      expect(sensorPermissionStatus('microphone', api, platform)).toBe('granted');
      await expect(sensorPermissionRequest('camera', api, platform)).resolves.toBe(true);
      expect(getMediaAccessStatus).not.toHaveBeenCalled();
      expect(askForMediaAccess).not.toHaveBeenCalled();
      expect(sensorSettingsUrl('camera', platform)).toBeNull();
    },
  );

  test('settings deep links per kind on macOS', () => {
    expect(sensorSettingsUrl('microphone', 'darwin')).toMatch(/Privacy_Microphone$/);
    expect(sensorSettingsUrl('camera', 'darwin')).toMatch(/Privacy_Camera$/);
  });

  test('unknown kinds are rejected at the IPC boundary', () => {
    expect(parseSensorKind('camera')).toBe('camera');
    for (const bad of ['temperature', '', 42, null, undefined, { kind: 'camera' }]) {
      expect(() => parseSensorKind(bad)).toThrow();
    }
  });
});
