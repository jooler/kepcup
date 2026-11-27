/**
 * Admin console tests (task 5B): hidden entry without the token secret,
 * login/logout + session-cookie shape, session-cookie auth on /v1/admin/*
 * (expiry, signature tamper, key mismatch, CSRF Origin checks), page/asset
 * routes with CSP + ETag, login logging shape, and a static audit of the
 * embedded UI source (textContent-only DOM, no markup-injection sinks, every
 * DOM id wired). The bearer CLI channel is covered by admin.test.ts untouched.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  sessionCookieValue,
} from '../src/admin';
import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS } from '../src/admin-ui';
import { handleRequest } from '../src/worker';
import type { HandlerDeps } from '../src/worker';
import {
  BASE,
  NOW,
  bearer,
  makeDeps,
  seedReport,
  send,
  type Res,
  type TestRig,
} from './helpers';

const TOKEN = 'test-admin-token-0123456789abcdef';
/** 逐字锚定 CSP——若实现放松了任何一段，这里直接失败。 */
const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

let rig: TestRig;

beforeEach(() => {
  rig = makeDeps({ config: { adminToken: TOKEN } });
  seedReport(rig.d1, { id: 'rep_ui_1', clientId: 'client-ui', receivedAt: NOW - 1000 });
  seedReport(rig.d1, { id: 'rep_ui_2', clientId: 'client-ui', receivedAt: NOW - 2000, status: 'triaged' });
});

// HTML/JS/CSS 响应体不是 JSON，helpers.toRes 的 JSON.parse 会炸——这里用裸 text。
async function raw(
  deps: HandlerDeps,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; res: Response; text: string }> {
  const res = await handleRequest(new Request(`${BASE}${path}`, { headers }), deps);
  return { status: res.status, res, text: await res.text() };
}

function cookie(value: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${value}` };
}

function validCookie(): Promise<Record<string, string>> {
  return sessionCookieValue(rig.now() + SESSION_TTL_MS, TOKEN).then(cookie);
}

async function login(body: string): Promise<Res> {
  return send(rig.deps, '/admin/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

// ------------------------------------------------------------------ hidden entry

describe('hidden entry (REPORT_ADMIN_TOKEN unset)', () => {
  it('every /admin* route is 404 without the token configured', async () => {
    const hidden = makeDeps();
    const outcomes: Array<Promise<{ status: number }>> = [
      raw(hidden.deps, '/admin'),
      raw(hidden.deps, '/admin/'),
      raw(hidden.deps, '/admin/', bearer('whatever')),
      raw(hidden.deps, '/admin/app.js'),
      raw(hidden.deps, '/admin/app.css'),
      send(hidden.deps, '/admin/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN }),
      }).then((r) => ({ status: r.res.status })),
      send(hidden.deps, '/admin/session', { method: 'DELETE' }).then((r) => ({ status: r.res.status })),
    ];
    for (const outcome of outcomes) {
      expect((await outcome).status).toBe(404);
    }
  });

  it('/v1/admin/* stays 404 even with a syntactically valid session cookie', async () => {
    const hidden = makeDeps(); // no token -> session key also undefined
    const value = await sessionCookieValue(NOW + SESSION_TTL_MS, TOKEN);
    const { res } = await raw(hidden.deps, '/v1/admin/reports', cookie(value));
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------------------------ login / logout

describe('POST /admin/session (login)', () => {
  it('a wrong token is 401 and sets no cookie', async () => {
    const { res, body } = await login(JSON.stringify({ token: 'wrong-token' }));
    expect(res.status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('malformed bodies and non-string tokens are 401 (no error echo)', async () => {
    for (const body of ['{broken', '', JSON.stringify({}), JSON.stringify({ token: 42 })]) {
      const { res } = await login(body);
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('an oversized body (over the 4 KiB login cap) is 401, not 413/500', async () => {
    // 合法 JSON 但超 LOGIN_BODY_MAX_BYTES：流式计数截停，按登录失败处理。
    const { res } = await login(JSON.stringify({ token: TOKEN, junk: 'x'.repeat(8192) }));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('the correct token sets a __Host- cookie with the full attribute set', async () => {
    const { res, body } = await login(JSON.stringify({ token: TOKEN }));
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, expiresAt: NOW + SESSION_TTL_MS });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) {
      expect(setCookie).toContain(attr);
    }
    // value = <ms epoch exp>.<64 hex hmac>
    const value = setCookie.slice(setCookie.indexOf('=') + 1).split(';')[0]!;
    expect(value).toMatch(/^\d+\.[0-9a-f]{64}$/);
    // 端到端自洽：这枚 cookie 能直接过 /v1/admin 鉴权。
    const list = await raw(rig.deps, '/v1/admin/reports', cookie(value));
    expect(list.status).toBe(200);
  });

  it('GET /admin/session is 405; DELETE clears the cookie with Max-Age=0', async () => {
    const probe = await raw(rig.deps, '/admin/session');
    expect(probe.status).toBe(405);
    expect(probe.res.headers.get('allow')).toBe('POST, DELETE');
    const { res } = await send(rig.deps, '/admin/session', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('SameSite=Strict');
  });
});

// ------------------------------------------------------------------ session auth

describe('session-cookie auth on /v1/admin/*', () => {
  it('a valid cookie authorizes list / detail / stats', async () => {
    expect((await raw(rig.deps, '/v1/admin/reports', await validCookie())).status).toBe(200);
    expect((await raw(rig.deps, '/v1/admin/reports/rep_ui_1', await validCookie())).status).toBe(200);
    expect((await raw(rig.deps, '/v1/admin/stats', await validCookie())).status).toBe(200);
  });

  it('an expired exp is 401', async () => {
    const expired = await sessionCookieValue(rig.now() - 1, TOKEN);
    const { status } = await raw(rig.deps, '/v1/admin/reports', cookie(expired));
    expect(status).toBe(401);
  });

  it('a tampered signature is 401', async () => {
    const value = await sessionCookieValue(rig.now() + SESSION_TTL_MS, TOKEN);
    const last = value.slice(-1);
    const tampered = value.slice(0, -1) + (last === '0' ? '1' : '0');
    const { status } = await raw(rig.deps, '/v1/admin/reports', cookie(tampered));
    expect(status).toBe(401);
  });

  it('a cookie signed with a different key (rotated token) is 401', async () => {
    const stale = await sessionCookieValue(rig.now() + SESSION_TTL_MS, 'previous-token');
    const { status } = await raw(rig.deps, '/v1/admin/reports', cookie(stale));
    expect(status).toBe(401);
  });

  it('garbage cookie values are 401, not 500', async () => {
    for (const garbage of ['', 'notacookie', '12345', 'abc.def', 'x.y.z']) {
      const { status } = await raw(rig.deps, '/v1/admin/reports', cookie(garbage));
      expect(status).toBe(401);
    }
  });

  it('cookie PATCH with a cross-origin Origin is 403 and writes nothing', async () => {
    const { status } = await send(rig.deps, '/v1/admin/reports/rep_ui_1', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(await validCookie()),
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ status: 'triaged' }),
    }).then((r) => ({ status: r.res.status }));
    expect(status).toBe(403);
    const row = rig.d1.rows<{ status: string }>(
      'SELECT status FROM reports WHERE id = ?',
      'rep_ui_1',
    )[0]!;
    expect(row.status).toBe('new');
  });

  it('cookie PATCH with a same-origin Origin passes', async () => {
    const { res } = await send(rig.deps, '/v1/admin/reports/rep_ui_1', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(await validCookie()),
        origin: BASE, // rig 的请求 URL 源（https://reports.test）
      },
      body: JSON.stringify({ status: 'triaged' }),
    });
    expect(res.status).toBe(200);
  });

  it('cookie PATCH without an Origin header passes', async () => {
    const { res } = await send(rig.deps, '/v1/admin/reports/rep_ui_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await validCookie()) },
      body: JSON.stringify({ status: 'triaged' }),
    });
    expect(res.status).toBe(200);
  });

  it('cookie DELETE with a cross-origin Origin is 403', async () => {
    const { res } = await send(rig.deps, '/v1/admin/clients/client-ui', {
      method: 'DELETE',
      headers: { ...(await validCookie()), origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(rig.d1.rows('SELECT * FROM reports WHERE client_id = ?', 'client-ui')).toHaveLength(2);
  });

  it('a cross-origin Origin does not affect bearer auth (CLI channel unchanged)', async () => {
    const { res } = await send(rig.deps, '/v1/admin/reports/rep_ui_1', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...bearer(TOKEN),
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ status: 'triaged' }),
    });
    expect(res.status).toBe(200);
  });

  it('Origin is ignored for cookie-authenticated reads', async () => {
    const { status } = await raw(rig.deps, '/v1/admin/reports', {
      ...(await validCookie()),
      origin: 'https://evil.example',
    });
    expect(status).toBe(200);
  });
});

// ------------------------------------------------------------------ pages & assets

describe('console pages and assets', () => {
  it('GET /admin/ serves the HTML shell with strict CSP, no-store, nosniff', async () => {
    const page = await raw(rig.deps, '/admin/');
    expect(page.status).toBe(200);
    expect(page.res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(page.res.headers.get('cache-control')).toBe('no-store');
    expect(page.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.res.headers.get('access-control-allow-origin')).toBeNull();
    expect(page.text).toBe(ADMIN_HTML);
    expect(ADMIN_HTML).toContain('id="login-token"');
    expect(ADMIN_HTML).toContain('/admin/app.js');
  });

  it('GET /admin redirects 308 to /admin/', async () => {
    const { status, res } = await raw(rig.deps, '/admin');
    expect(status).toBe(308);
    expect(res.headers.get('location')).toBe('/admin/');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('POST to the page path is 405', async () => {
    const { res } = await send(rig.deps, '/admin/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('app.js and app.css serve with exact content types and CSP', async () => {
    const js = await raw(rig.deps, '/admin/app.js');
    expect(js.status).toBe(200);
    expect(js.res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(js.text).toBe(ADMIN_JS);
    const css = await raw(rig.deps, '/admin/app.css');
    expect(css.status).toBe(200);
    expect(css.res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(css.res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(css.text).toBe(ADMIN_CSS);
  });

  it('assets answer 304 on a matching If-None-Match, 200 on mismatch', async () => {
    const first = await raw(rig.deps, '/admin/app.js');
    const etag = first.res.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    const second = await raw(rig.deps, '/admin/app.js', { 'if-none-match': etag });
    expect(second.status).toBe(304);
    expect(second.text).toBe('');
    expect(second.res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    const third = await raw(rig.deps, '/admin/app.js', { 'if-none-match': '"deadbeefdeadbeef"' });
    expect(third.status).toBe(200);
  });

  it('unknown /admin/* paths are 404', async () => {
    expect((await raw(rig.deps, '/admin/unknown')).status).toBe(404);
    expect((await raw(rig.deps, '/admin/app.jsx')).status).toBe(404);
    expect((await raw(rig.deps, '/administrator')).status).toBe(404);
  });

  it('no token material in any asset', () => {
    for (const asset of [ADMIN_HTML, ADMIN_JS, ADMIN_CSS]) {
      expect(asset).not.toContain(TOKEN);
      expect(asset).not.toContain('REPORT_ADMIN_TOKEN');
    }
  });
});

// ------------------------------------------------------------------ logging

describe('login logging (§8)', () => {
  it('failed and successful logins log only the generic route line', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    try {
      await login(JSON.stringify({ token: 'wrong-token' }));
      await login(JSON.stringify({ token: TOKEN }));
    } finally {
      spy.mockRestore();
    }
    expect(logs).toHaveLength(2);
    expect(logs).toContain(JSON.stringify({ path: '/admin/session', method: 'POST', status: 401 }));
    expect(logs).toContain(JSON.stringify({ path: '/admin/session', method: 'POST', status: 200 }));
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
});

// ------------------------------------------------------------------ static audit

describe('static audit of the embedded UI source', () => {
  const source = readFileSync(new URL('../src/admin-ui.ts', import.meta.url), 'utf8');

  it('contains no markup-injection sinks anywhere (comments included)', () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      expect(source.includes(sink), `admin-ui.ts must not contain "${sink}"`).toBe(false);
    }
  });

  it('builds all dynamic content through textContent', () => {
    expect((source.match(/textContent/g) ?? []).length).toBeGreaterThan(5);
  });

  it('the HTML shell has no inline event handlers', () => {
    expect(/\son[a-z]+\s*=/i.test(ADMIN_HTML)).toBe(false);
  });

  it('every DOM id the client JS looks up exists in the HTML', () => {
    const wanted = [...ADMIN_JS.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]!);
    expect(wanted.length).toBeGreaterThan(10);
    for (const id of new Set(wanted)) {
      expect(ADMIN_HTML, `missing id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it('the client JS parses (syntax smoke)', () => {
    expect(() => new Function(ADMIN_JS)).not.toThrow();
  });
});
