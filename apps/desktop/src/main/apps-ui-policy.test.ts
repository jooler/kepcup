import { describe, expect, test } from 'vitest';
import { isPermissionAllowed } from './app-permissions';
import {
  appFrameNavigationVerdict,
  appUiResponseHeaders,
  createOpenExternalRateLimiter,
  externalLinkBridgeScript,
  fileAppResponseHeaders,
  isOpenablePreviewLinkUrl,
  parseAppUiUrl,
  parseFileAppUrl,
  PREVIEW_EXTERNAL_LINK_SCHEMES,
  scrollbarBackstopScript,
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
    expect(appFrameNavigationVerdict({ isMainFrame: false, frameUrl: loaded })).toBe('block');
  });
  test('the first load (about:blank / empty) and main-frame navigations are not touched here', () => {
    expect(appFrameNavigationVerdict({ isMainFrame: false, frameUrl: 'about:blank' })).toBe(
      'allow',
    );
    expect(appFrameNavigationVerdict({ isMainFrame: false, frameUrl: '' })).toBe('allow');
    expect(
      appFrameNavigationVerdict({
        isMainFrame: false,
        frameUrl: undefined,
        targetUrl: 'https://example.com/',
      }),
    ).toBe('allow');
    expect(
      appFrameNavigationVerdict({ isMainFrame: true, frameUrl: 'kepcup-app://app-x/abc' }),
    ).toBe('allow');
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
      for (const permission of [
        'media',
        'clipboard-sanitized-write',
        'fullscreen',
        'geolocation',
      ]) {
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
      appFrameNavigationVerdict({ isMainFrame: false, frameUrl: undefined, targetUrl: app }),
    ).toBe('block');
    expect(
      appFrameNavigationVerdict({ isMainFrame: true, frameUrl: 'file:///', targetUrl: app }),
    ).toBe('block');
    expect(
      appFrameNavigationVerdict({
        isMainFrame: true,
        frameUrl: 'file:///',
        targetUrl: 'file:///x',
      }),
    ).toBe('allow');
  });
  test('a known, not yet loaded frame may load its page once', () => {
    expect(
      appFrameNavigationVerdict({
        isMainFrame: false,
        frameUrl: 'about:blank',
        targetUrl: app,
      }),
    ).toBe('allow');
    expect(appFrameNavigationVerdict({ isMainFrame: false, frameUrl: app, targetUrl: app })).toBe(
      'block',
    );
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
    expect(appFrameNavigationVerdict({ isMainFrame: false, frameUrl: page, targetUrl: page })).toBe(
      'allow',
    );
    expect(
      appFrameNavigationVerdict({
        isMainFrame: false,
        frameUrl: page,
        targetUrl: `kepcup-file://${token}/assets/a.png`,
      }),
    ).toBe('allow');
  });
  test('external links become open-external (handed to the system browser)', () => {
    expect(
      appFrameNavigationVerdict({
        isMainFrame: false,
        frameUrl: page,
        targetUrl: 'https://example.com/',
      }),
    ).toBe('open-external');
    expect(
      appFrameNavigationVerdict({
        isMainFrame: false,
        frameUrl: page,
        targetUrl: 'mailto:hi@example.com',
      }),
    ).toBe('open-external');
  });
  test('cross-token / privileged / unknown schemes / top-level are blocked', () => {
    expect(
      appFrameNavigationVerdict({ isMainFrame: false, frameUrl: page, targetUrl: other }),
    ).toBe('block');
    expect(
      appFrameNavigationVerdict({
        isMainFrame: false,
        frameUrl: page,
        targetUrl: 'kepcup-app://app-x/AbCdEfGhIjKlMnOpQrStUv',
      }),
    ).toBe('block');
    expect(
      appFrameNavigationVerdict({
        isMainFrame: false,
        frameUrl: page,
        targetUrl: 'javascript:alert(1)',
      }),
    ).toBe('block');
    expect(
      appFrameNavigationVerdict({ isMainFrame: true, frameUrl: 'file:///', targetUrl: page }),
    ).toBe('block');
    expect(
      appFrameNavigationVerdict({
        isMainFrame: false,
        frameUrl: 'about:blank',
        targetUrl: page,
      }),
    ).toBe('allow');
  });
});

describe('preview external-link allowlist', () => {
  test('accepts http / https / mailto / tel', () => {
    for (const url of [
      'https://example.com/a?b=1#top',
      'http://example.com/',
      'http://127.0.0.1:3000/x',
      'mailto:hi@example.com',
      'tel:+8610086',
    ]) {
      expect(isOpenablePreviewLinkUrl(url), url).toBe(true);
    }
  });
  test('rejects non-allowlisted schemes, credential URLs and hostless http(s)', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///etc/passwd',
      'kepcup-file://f0123456789abcdef01234567/index.html',
      'kepcup-app://app-x/AbCdEfGhIjKlMnOpQrStUv',
      'https://user:pw@example.com/',
      'http:///',
      'https:///',
      'not a url',
      '',
    ]) {
      expect(isOpenablePreviewLinkUrl(url), url).toBe(false);
    }
  });
});

describe('external link bridge script', () => {
  const script = externalLinkBridgeScript(PREVIEW_EXTERNAL_LINK_SCHEMES, 'kepcup:open-external');
  test('embeds the schemes and message type, single-line ascii', () => {
    expect(script).toContain(JSON.stringify([...PREVIEW_EXTERNAL_LINK_SCHEMES]));
    expect(script).toContain(JSON.stringify('kepcup:open-external'));
    expect(script).not.toMatch(/[\n\r]/);
    expect(/^[\x20-\x7e]*$/.test(script)).toBe(true);
  });
  test('guards against re-injection and intercepts clicks on allowlisted anchors only', () => {
    expect(script).toContain('if(window.parent!==window.top)return;');
    expect(script).toContain('if(window.__kepcupExtLink)return;');
    expect(script).toContain("addEventListener('click'");
    expect(script).toContain('u.protocol===location.protocol&&u.host===location.host');
    expect(script).toContain('ok.indexOf(u.protocol)===-1');
    expect(script).toContain('if(u.username!==""||u.password!=="")return;');
    expect(script).toContain('ev.preventDefault()');
    expect(script).toContain('window.parent.postMessage({type:TYPE,url:u.toString()},"*")');
  });
});

describe('open-external rate limiter', () => {
  test('allows the initial burst, then blocks until tokens refill over time', () => {
    let now = 1_000;
    const limiter = createOpenExternalRateLimiter(() => now);
    const sender = {};
    for (let i = 0; i < 4; i += 1) {
      expect(limiter.tryTake(sender), `take ${i}`).toBe(true);
    }
    expect(limiter.tryTake(sender)).toBe(false);
    now += 9_999;
    expect(limiter.tryTake(sender)).toBe(false);
    now += 1;
    expect(limiter.tryTake(sender)).toBe(true);
    expect(limiter.tryTake(sender)).toBe(false);
  });
  test('buckets are independent per sender and cap at the burst size', () => {
    let now = 0;
    const limiter = createOpenExternalRateLimiter(() => now);
    const a = {};
    const b = {};
    expect(limiter.tryTake(a)).toBe(true);
    expect(limiter.tryTake(b)).toBe(true);
    now += 1_000_000;
    for (let i = 0; i < 4; i += 1) {
      expect(limiter.tryTake(a), `a take ${i}`).toBe(true);
    }
    expect(limiter.tryTake(a)).toBe(false);
    expect(limiter.tryTake(b)).toBe(true);
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
