import { describe, expect, test } from 'vitest';
import { isAppOrigin, isPermissionAllowed } from './app-permissions.js';

const DEV = 'http://localhost:5173/';
const PACKAGED = 'file:///opt/KepCup/resources/app/out/renderer/index.html';

describe('app permission policy (D76-7)', () => {
  test('allows media (audio / video) from the app itself', () => {
    expect(
      isPermissionAllowed({
        permission: 'media',
        requestingUrl: DEV,
        mediaTypes: ['audio', 'video'],
        appUrl: DEV,
      }),
    ).toBe(true);
    expect(
      isPermissionAllowed({
        permission: 'media',
        requestingUrl: PACKAGED,
        mediaTypes: ['video'],
        appUrl: PACKAGED,
      }),
    ).toBe(true);
  });

  test('allows the copy / fullscreen permissions the UI uses', () => {
    for (const permission of ['clipboard-sanitized-write', 'fullscreen']) {
      expect(isPermissionAllowed({ permission, requestingUrl: DEV, appUrl: DEV })).toBe(true);
    }
  });

  test('denies everything else', () => {
    for (const permission of [
      'notifications',
      'geolocation',
      'display-capture',
      'clipboard-read',
      'openExternal',
      'hid',
      'serial',
      'midi',
    ]) {
      expect(isPermissionAllowed({ permission, requestingUrl: DEV, appUrl: DEV })).toBe(false);
    }
  });

  test('denies media requests that carry unknown track types', () => {
    expect(
      isPermissionAllowed({
        permission: 'media',
        requestingUrl: DEV,
        mediaTypes: ['audio', 'screen'],
        appUrl: DEV,
      }),
    ).toBe(false);
  });

  test('denies requests from any other origin, even for allowed permissions', () => {
    expect(
      isPermissionAllowed({
        permission: 'media',
        requestingUrl: 'https://evil.example/',
        mediaTypes: ['audio'],
        appUrl: DEV,
      }),
    ).toBe(false);
    expect(isAppOrigin('http://localhost:9999/', DEV)).toBe(false);
    expect(isAppOrigin('https://example.com/', PACKAGED)).toBe(false);
    expect(isAppOrigin('not a url', DEV)).toBe(false);
  });
});
