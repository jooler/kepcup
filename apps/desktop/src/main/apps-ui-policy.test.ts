import { describe, expect, test } from 'vitest';
import { isPermissionAllowed } from './app-permissions';
import {
  appUiResponseHeaders,
  parseAppUiUrl,
  shouldBlockAppFrameNavigation,
} from './apps-ui-policy';

describe('kepcup-app:// URL parsing', () => {
  const id = 'AbCdEfGhIjKlMnOpQrStUv';
  test('accepts exactly kepcup-app://{host}/{resourceId}', () => {
    expect(parseAppUiUrl(`kepcup-app://app-0123456789abcdef01234567/${id}`)).toEqual({
      host: 'app-0123456789abcdef01234567',
      resourceId: id,
    });
  });

  test('rejects every other shape', () => {
    for (const bad of [
      'https://app-0123/AbCdEfGhIjKlMnOpQrStUv',
      `kepcup-app://app-x/${id}/extra`,
      `kepcup-app://app-x/${id}?q=1`,
      `kepcup-app://app-x/${id}#frag`,
      `kepcup-app://user:pw@app-x/${id}`,
      `kepcup-app://app-x:8080/${id}`,
      'kepcup-app://app-x/',
      'kepcup-app://app-x/short',
      `kepcup-app://app-x/${id}%2e%2e`,
      'kepcup-app:///onlypath',
      'not a url',
      '',
    ]) {
      expect(parseAppUiUrl(bad), bad).toBeNull();
    }
  });
});

describe('page response headers', () => {
  test('carry the per-app CSP and deny every powerful feature', () => {
    const headers = appUiResponseHeaders("default-src 'none'");
    expect(headers['content-security-policy']).toBe("default-src 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['referrer-policy']).toBe('no-referrer');
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(headers['permissions-policy']).toContain(`${feature}=()`);
    }
  });
});

describe('sub-frame navigation guard', () => {
  test('a sub-frame already showing a kepcup-app page may not navigate anywhere', () => {
    const loaded = 'kepcup-app://app-x/AbCdEfGhIjKlMnOpQrStUv';
    expect(shouldBlockAppFrameNavigation({ isMainFrame: false, frameUrl: loaded })).toBe(true);
  });
  test('the first load (about:blank / empty) and main-frame navigations are not touched here', () => {
    expect(shouldBlockAppFrameNavigation({ isMainFrame: false, frameUrl: 'about:blank' })).toBe(
      false,
    );
    expect(shouldBlockAppFrameNavigation({ isMainFrame: false, frameUrl: '' })).toBe(false);
    expect(
      shouldBlockAppFrameNavigation({
        isMainFrame: false,
        frameUrl: undefined,
        targetUrl: 'https://example.com/',
      }),
    ).toBe(false);
    expect(
      shouldBlockAppFrameNavigation({ isMainFrame: true, frameUrl: 'kepcup-app://app-x/abc' }),
    ).toBe(false);
  });
});

describe('default-session permission allowlist vs kepcup-app frames', () => {
  test('every permission requested from a kepcup-app page is denied', () => {
    for (const appUrl of ['file:///', 'http://localhost:5173']) {
      for (const permission of [
        'media',
        'clipboard-sanitized-write',
        'fullscreen',
        'geolocation',
        'notifications',
      ]) {
        expect(
          isPermissionAllowed({
            permission,
            requestingUrl: 'kepcup-app://app-0123456789abcdef01234567/AbCdEfGhIjKlMnOpQrStUv',
            mediaTypes: ['audio', 'video'],
            appUrl,
          }),
          `${permission} @ ${appUrl}`,
        ).toBe(false);
      }
    }
  });
});

describe('sub-frame navigation guard fails closed', () => {
  const app = 'kepcup-app://app-x/AbCdEfGhIjKlMnOpQrStUv';
  test('an unknown frame may not navigate to a kepcup-app page, nor may the top-level window', () => {
    expect(
      shouldBlockAppFrameNavigation({ isMainFrame: false, frameUrl: undefined, targetUrl: app }),
    ).toBe(true);
    expect(
      shouldBlockAppFrameNavigation({ isMainFrame: true, frameUrl: 'file:///', targetUrl: app }),
    ).toBe(true);
    expect(
      shouldBlockAppFrameNavigation({
        isMainFrame: true,
        frameUrl: 'file:///',
        targetUrl: 'file:///x',
      }),
    ).toBe(false);
  });
  test('a known, not yet loaded frame may load its page once', () => {
    expect(
      shouldBlockAppFrameNavigation({
        isMainFrame: false,
        frameUrl: 'about:blank',
        targetUrl: app,
      }),
    ).toBe(false);
    expect(
      shouldBlockAppFrameNavigation({ isMainFrame: false, frameUrl: app, targetUrl: app }),
    ).toBe(true);
  });
});
