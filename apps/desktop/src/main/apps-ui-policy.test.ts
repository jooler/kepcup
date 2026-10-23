import { describe, expect, test } from 'vitest';
import { isPermissionAllowed } from './app-permissions';
import {
  appUiResponseHeaders,
  fileAppResponseHeaders,
  parseAppUiUrl,
  parseFileAppUrl,
  scrollbarBackstopScript,
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

  test('kepcup-file (directory preview, docs/design/47) origins are denied too', () => {
    for (const appUrl of ['file:///', 'http://localhost:5173']) {
      for (const permission of ['media', 'clipboard-sanitized-write', 'fullscreen', 'geolocation']) {
        expect(
          isPermissionAllowed({
            permission,
            requestingUrl: 'kepcup-file://f0123456789abcdef01234567/index.html',
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

describe('kepcup-file:// URL parsing', () => {
  const token = 'f0123456789abcdef01234567';
  test('accepts token host + multi-segment path and decodes segments', () => {
    expect(parseFileAppUrl(`kepcup-file://${token}/index.html`)).toEqual({
      token,
      rel: 'index.html',
    });
    expect(parseFileAppUrl(`kepcup-file://${token}/assets/js/app.min.js?q=3#top`)).toEqual({
      token,
      rel: 'assets/js/app.min.js',
    });
    expect(parseFileAppUrl(`kepcup-file://${token}/%E4%B8%AD%E6%96%87%20%E5%90%8D.png`)).toEqual({
      token,
      rel: '中文 名.png',
    });
  });

  test('dot segments are clamped to the token root by URL normalization (cannot escape)', () => {
    // WHATWG URL 解析对 standard scheme 收敛点段：`/../secret` → `/secret`。
    // token 根就是 Web 根，向上跳不出前缀；真正越界由 core 侧 isInsidePath 兜底。
    expect(parseFileAppUrl(`kepcup-file://${token}/../secret`)).toEqual({
      token,
      rel: 'secret',
    });
  });

  test('rejects every other shape', () => {
    for (const bad of [
      'https://x/index.html',
      `kepcup-file://otherhost/index.html`,
      `kepcup-file://F0123456789abcdef01234567/index.html`,
      `kepcup-file://${token}`,
      `kepcup-file://${token}/`,
      `kepcup-file://${token}/a%5Cb`,
      `kepcup-file://${token}/a%2%2eb`,
      `kepcup-file://user:pw@${token}/index.html`,
      `kepcup-file://${token}:8080/index.html`,
      `kepcup-file://${token}//double`,
      'not a url',
      '',
    ]) {
      expect(parseFileAppUrl(bad), bad).toBeNull();
    }
  });
});

describe('kepcup-file response headers', () => {
  test('carry the sandbox-only CSP (full webapp tier) and deny powerful features', () => {
    const headers = fileAppResponseHeaders('text/html');
    expect(headers['content-type']).toBe('text/html');
    expect(headers['content-security-policy']).toBe(
      'sandbox allow-scripts allow-same-origin allow-forms allow-modals; frame-ancestors file: http://localhost:*',
    );
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['cache-control']).toBe('no-store');
    for (const feature of ['camera', 'microphone', 'geolocation']) {
      expect(headers['permissions-policy']).toContain(`${feature}=()`);
    }
  });
});

describe('kepcup-file sub-frame navigation guard', () => {
  const token = 'f0123456789abcdef01234567';
  const page = `kepcup-file://${token}/index.html`;
  const other = `kepcup-file://f0123456789abcdef01234568/index.html`;
  test('same-token self navigation is allowed (multi-page webapps)', () => {
    expect(
      shouldBlockAppFrameNavigation({ isMainFrame: false, frameUrl: page, targetUrl: page }),
    ).toBe(false);
    expect(
      shouldBlockAppFrameNavigation({
        isMainFrame: false,
        frameUrl: page,
        targetUrl: `kepcup-file://${token}/assets/a.png`,
      }),
    ).toBe(false);
  });
  test('cross-token / other schemes / top-level are blocked', () => {
    expect(
      shouldBlockAppFrameNavigation({ isMainFrame: false, frameUrl: page, targetUrl: other }),
    ).toBe(true);
    expect(
      shouldBlockAppFrameNavigation({
        isMainFrame: false,
        frameUrl: page,
        targetUrl: 'https://example.com/',
      }),
    ).toBe(true);
    expect(
      shouldBlockAppFrameNavigation({
        isMainFrame: false,
        frameUrl: page,
        targetUrl: 'kepcup-app://app-x/AbCdEfGhIjKlMnOpQrStUv',
      }),
    ).toBe(true);
    expect(
      shouldBlockAppFrameNavigation({ isMainFrame: true, frameUrl: 'file:///', targetUrl: page }),
    ).toBe(true);
    expect(
      shouldBlockAppFrameNavigation({
        isMainFrame: false,
        frameUrl: 'about:blank',
        targetUrl: page,
      }),
    ).toBe(false);
  });
});

describe('scrollbar backstop script', () => {
  const css = '::-webkit-scrollbar{width:8px}';
  const script = scrollbarBackstopScript(css, 'data-kepcup-scrollbar');
  test('embeds the marker check and the css constant, single-line ascii', () => {
    expect(script).toContain("querySelector('style[data-kepcup-scrollbar]')");
    expect(script).toContain(JSON.stringify(css));
    expect(script).not.toMatch(/[\n\r]/);
    expect(/^[\x20-\x7e]*$/.test(script)).toBe(true);
  });
  test('checks page stylesheets before injecting', () => {
    expect(script).toContain('::-webkit-scrollbar|scrollbar-(width|color)');
    expect(script).toContain('cssRules');
    expect(script).toContain('head.insertBefore(style,head.firstChild)');
  });
});
