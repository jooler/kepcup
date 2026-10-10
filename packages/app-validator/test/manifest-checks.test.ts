import { describe, expect, it } from 'vitest';
import { checkManifest, checkToolPolicyKeys, checkUiFlag } from '../src/checks/manifest.js';
import { find, labels } from './support.js';

function manifest(meta: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    name: 'com.example/acme',
    title: 'Acme',
    description: 'Acme issue tracker',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
    _meta: {
      'app.kepcup/connector': {
        slug: 'acme',
        icon: 'acme.svg',
        category: 'project',
        tier: 'community',
        auth: { kind: 'oauth', registration: 'auto', clientRef: null },
        privacyPolicy: 'https://example.com/privacy',
        ...meta,
      },
    },
    ...top,
  };
}

describe('checkManifest', () => {
  it('accepts a valid community manifest (releaseGate may be absent)', () => {
    const result = checkManifest(manifest());
    expect(result.entry?.name).toBe('com.example/acme');
    expect(result.remote?.url).toBe('https://mcp.example.com/mcp');
    expect(labels(result, 'error')).toEqual([]);
    expect(find(result, 'manifest.release-gate')?.severity).toBe('info');
    expect(find(result, 'manifest.tier')?.severity).toBe('info');
  });

  it('reports non-object input', () => {
    expect(labels(checkManifest([]), 'error')).toEqual(['manifest.json']);
    expect(labels(checkManifest('x'), 'error')).toEqual(['manifest.json']);
  });

  it('reports a missing _meta extension with a hint', () => {
    const result = checkManifest({ ...manifest(), _meta: {} });
    expect(result.entry).toBeNull();
    expect(labels(result, 'error')).toEqual(['manifest.meta-missing']);
    expect(find(result, 'manifest.meta-missing')?.hint).toContain('app.kepcup/connector');
  });

  it.each([
    ['slug', { slug: 'My_App' }, 'manifest.slug'],
    ['icon', { icon: '../x.svg' }, 'manifest.icon'],
    ['category', { category: 'games' }, 'manifest.category'],
    ['tier', { tier: 'platinum' }, 'manifest.tier'],
    [
      'auth',
      { auth: { kind: 'oauth', registration: 'preregistered', clientRef: null } },
      'manifest.auth',
    ],
    ['privacyPolicy', { privacyPolicy: 'not a url' }, 'manifest.privacy-policy'],
  ])('flags a bad %s', (_name, meta, id) => {
    const result = checkManifest(manifest(meta));
    expect(result.entry).toBeNull();
    expect(labels(result, 'error')).toContain(id);
  });

  it('flags schema problems outside the extension', () => {
    const result = checkManifest(manifest({}, { name: 'no-namespace' }));
    expect(labels(result, 'error')).toContain('manifest.schema');
    const noRemote = checkManifest(manifest({}, { remotes: [] }));
    expect(labels(noRemote, 'error')).toContain('manifest.remote');
  });

  it('rejects tier builtin and warns about verified / developer', () => {
    expect(labels(checkManifest(manifest({ tier: 'builtin' })), 'error')).toEqual([
      'manifest.tier',
    ]);
    expect(labels(checkManifest(manifest({ tier: 'verified' })), 'warn')).toEqual([
      'manifest.tier',
    ]);
    expect(labels(checkManifest(manifest({ tier: 'developer' })), 'warn')).toEqual([
      'manifest.tier',
    ]);
  });

  it('requires an https remote (loopback http only warns)', () => {
    const http = checkManifest(
      manifest({}, { remotes: [{ type: 'streamable-http', url: 'http://mcp.example.com/mcp' }] }),
    );
    expect(labels(http, 'error')).toContain('manifest.remote');
    expect(http.remote).toBeNull();
    const loopback = checkManifest(
      manifest({}, { remotes: [{ type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' }] }),
    );
    expect(labels(loopback, 'error')).toEqual([]);
    expect(labels(loopback, 'warn')).toContain('manifest.remote');
    expect(loopback.remote?.url).toBe('http://127.0.0.1:9/mcp');
  });

  it('rejects an sse-only remote and warns about a leftover sse entry', () => {
    const sseOnly = checkManifest(
      manifest({}, { remotes: [{ type: 'sse', url: 'https://x.example.com/sse' }] }),
    );
    expect(labels(sseOnly, 'error')).toContain('manifest.remote');
    const both = checkManifest(
      manifest(
        {},
        {
          remotes: [
            { type: 'streamable-http', url: 'https://x.example.com/mcp' },
            { type: 'sse', url: 'https://x.example.com/sse' },
          ],
        },
      ),
    );
    expect(labels(both, 'warn')).toContain('manifest.remote');
    expect(both.remote?.url).toBe('https://x.example.com/mcp');
  });

  it('treats a package-only entry as having no remote to probe', () => {
    const result = checkManifest(
      manifest(
        {},
        {
          remotes: [],
          packages: [{ registryType: 'mcpb', identifier: 'https://x.example.com/a.mcpb' }],
        },
      ),
    );
    expect(result.entry).not.toBeNull();
    expect(result.remote).toBeNull();
    expect(labels(result, 'error')).toEqual([]);
  });

  it('requires an https privacy policy', () => {
    const result = checkManifest(manifest({ privacyPolicy: 'http://example.com/privacy' }));
    expect(labels(result, 'error')).toContain('manifest.privacy-policy');
  });
});

describe('checkToolPolicyKeys / checkUiFlag', () => {
  it('flags toolPolicy keys that name no listed tool', () => {
    const { entry } = checkManifest(
      manifest({ toolPolicy: { ghost: { risk: 'write' }, real: { risk: 'write' } } }),
    );
    const checks = checkToolPolicyKeys(entry!, ['real']);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.message).toContain('ghost');
    expect(checkToolPolicyKeys(entry!, ['real', 'ghost'])).toEqual([]);
  });

  it('compares the ui flag with the tools', () => {
    const off = checkManifest(manifest()).entry!;
    const on = checkManifest(manifest({ ui: true })).entry!;
    expect(checkUiFlag(off, 0)).toEqual([]);
    expect(checkUiFlag(off, 2)[0]?.severity).toBe('warn');
    expect(checkUiFlag(on, 0)[0]?.severity).toBe('warn');
    expect(checkUiFlag(on, 1)).toEqual([]);
  });
});
