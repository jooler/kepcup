import { describe, expect, it } from 'vitest';
import {
  appLoopbackKey,
  buildAppCspHeader,
  isToolVisibleToApp,
  mcpAppResourceUriOf,
  normalizeAppCspSource,
  sanitizeAppCsp,
} from '../../src/index.js';

describe('normalizeAppCspSource', () => {
  const strict = { loopbackOrigin: null };
  it('accepts exact https / wss domains, normalizing case, with an optional port', () => {
    expect(normalizeAppCspSource('https://API.Example.com', strict)).toBe(
      'https://api.example.com',
    );
    expect(normalizeAppCspSource('wss://rt.example.com:8443', strict)).toBe(
      'wss://rt.example.com:8443',
    );
  });

  it('rejects every wildcard — public-suffix wildcards would allow the whole internet', () => {
    for (const bad of [
      'https://*.example.com',
      'https://*.co.uk',
      'https://*.github.io',
      'https://*.s3.amazonaws.com',
      'https://*.herokuapp.com',
      'https://*',
      'https://*.com',
      'https://sub.*.example.com',
      'wss://*.example.com',
      'https://example.com:*',
      '*',
      '*.example.com',
    ]) {
      expect(normalizeAppCspSource(bad, strict), bad).toBeNull();
      expect(normalizeAppCspSource(bad, { loopbackOrigin: '127.0.0.1:80' }), bad).toBeNull();
    }
  });

  it('rejects everything else that could widen the policy', () => {
    for (const bad of [
      "'self'",
      "'unsafe-eval'",
      'data:',
      'blob:',
      'https:',
      'http://example.com',
      'ws://example.com',
      'https://example.com/path',
      'https://example.com?x=1',
      'https://example.com#x',
      'https://user@example.com',
      'https://example.com; script-src *',
      'https://example.com https://other.com',
      'https://1.2.3.4',
      'https://[::2]',
      'https://example.com:99999',
      'https://example.com:0',
      'https://exa_mple.com',
      'https://-bad.example.com',
      'ftp://example.com',
      'https://com',
      '',
      ' ',
      'x'.repeat(300),
    ]) {
      expect(normalizeAppCspSource(bad, strict), JSON.stringify(bad.slice(0, 50))).toBeNull();
    }
  });

  it('local names and IPs are rejected unless they are exactly the owning local server', () => {
    const strictNames = [
      'https://localhost',
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://[::1]:5000',
      'https://app.localhost',
      'https://evil.localhost:443',
      'http://127.0.0.2:80',
      'ws://127.0.0.1:9',
    ];
    for (const bad of strictNames) {
      expect(normalizeAppCspSource(bad, strict), bad).toBeNull();
      expect(normalizeAppCspSource(bad, { loopbackOrigin: null }), bad).toBeNull();
    }
    const dev = { loopbackOrigin: '127.0.0.1:9999' };
    expect(normalizeAppCspSource('http://127.0.0.1:9999', dev)).toBe('http://127.0.0.1:9999');
    expect(normalizeAppCspSource('ws://127.0.0.1:9999', dev)).toBe('ws://127.0.0.1:9999');
    // Same host, other port / no port / wildcard port / other loopback name: still rejected.
    for (const bad of [
      'http://127.0.0.1:9998',
      'http://127.0.0.1',
      'http://127.0.0.1:*',
      'http://localhost:9999',
      'http://127.0.0.2:9999',
      'http://[::1]:9999',
    ]) {
      expect(normalizeAppCspSource(bad, dev), bad).toBeNull();
    }
    const named = { loopbackOrigin: 'localhost:3000' };
    expect(normalizeAppCspSource('http://localhost:3000', named)).toBe('http://localhost:3000');
    expect(normalizeAppCspSource('http://localhost:3001', named)).toBeNull();
    // Default ports are compared after completion.
    expect(normalizeAppCspSource('http://localhost', { loopbackOrigin: 'localhost:80' })).toBe(
      'http://localhost',
    );
  });

  it('appLoopbackKey completes default ports', () => {
    expect(appLoopbackKey('http://127.0.0.1:43231/mcp')).toBe('127.0.0.1:43231');
    expect(appLoopbackKey('http://localhost/mcp')).toBe('localhost:80');
    expect(appLoopbackKey('https://localhost/mcp')).toBe('localhost:443');
    expect(appLoopbackKey('nonsense')).toBeNull();
  });
});

describe('sanitizeAppCsp + buildAppCspHeader', () => {
  it('defaults to deny-all', () => {
    const header = buildAppCspHeader(sanitizeAppCsp(undefined, { loopbackOrigin: null }));
    expect(header).toBe(
      [
        "default-src 'none'",
        'sandbox allow-scripts',
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        'img-src data: blob:',
        'font-src data:',
        'media-src data: blob:',
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        'frame-ancestors file: http://localhost:*',
      ].join('; '),
    );
  });

  it('puts connectDomains in connect-src only and resourceDomains in the static-resource directives', () => {
    const cleaned = sanitizeAppCsp(
      {
        connectDomains: ['https://api.example.com', 'http://evil.com', 'https://api.example.com'],
        resourceDomains: ['https://cdn.example.com'],
        frameDomains: ['https://youtube.com'],
        baseUriDomains: ['https://cdn.example.com'],
      },
      { loopbackOrigin: null },
    );
    expect(cleaned.connectDomains).toEqual(['https://api.example.com']);
    expect(cleaned.rejected).toEqual(['http://evil.com']);
    expect(cleaned.unsupported).toEqual(['frameDomains', 'baseUriDomains']);
    const header = buildAppCspHeader(cleaned);
    expect(header).toContain('connect-src https://api.example.com;');
    expect(header).toContain("script-src 'unsafe-inline' https://cdn.example.com;");
    expect(header).toContain('img-src data: blob: https://cdn.example.com;');
    expect(header).not.toContain('youtube');
    expect(header).toContain("frame-src 'none'");
    expect(header).toContain("base-uri 'none'");
  });
});

describe('tool _meta.ui helpers', () => {
  it('reads resourceUri from _meta.ui.resourceUri or the legacy flat key; only ui:// counts', () => {
    expect(mcpAppResourceUriOf({ ui: { resourceUri: 'ui://app/view.html' } })).toBe(
      'ui://app/view.html',
    );
    expect(mcpAppResourceUriOf({ 'ui/resourceUri': 'ui://legacy/v' })).toBe('ui://legacy/v');
    for (const bad of [
      undefined,
      null,
      {},
      { ui: {} },
      { ui: { resourceUri: 'https://x.com/a' } },
      { ui: { resourceUri: 'javascript:1' } },
      { ui: { resourceUri: 42 } },
      { ui: { resourceUri: 'ui://has space' } },
      { ui: 'ui://x' },
    ]) {
      expect(mcpAppResourceUriOf(bad)).toBeNull();
    }
  });

  it('a tool is visible to the app only when visibility EXPLICITLY includes "app" (stricter than the spec default)', () => {
    expect(isToolVisibleToApp({ ui: { visibility: ['app'] } })).toBe(true);
    expect(isToolVisibleToApp({ ui: { visibility: ['model', 'app'] } })).toBe(true);
    expect(isToolVisibleToApp({ ui: { visibility: ['model'] } })).toBe(false);
    expect(isToolVisibleToApp({ ui: { visibility: [] } })).toBe(false);
    expect(isToolVisibleToApp({ ui: { resourceUri: 'ui://x/y' } })).toBe(false);
    expect(isToolVisibleToApp({ ui: { visibility: 'app' } })).toBe(false);
    expect(isToolVisibleToApp(undefined)).toBe(false);
    expect(isToolVisibleToApp({})).toBe(false);
  });
});
