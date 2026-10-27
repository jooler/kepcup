import { describe, expect, it } from 'vitest';
import { isSafeDirectoryRemoteUrl } from '@kepcup/shared';

/**
 * `isSafeDirectoryRemoteUrl` moved to shared in D104 P2 so `kepcup-app` can reuse it.
 * The core-side cases stay in `packages/core/test/unit/directory-merge.test.ts`; this copy
 * pins the shared contract itself.
 */

describe('isSafeDirectoryRemoteUrl', () => {
  it('rejects endpoints that are not a public https hostname', () => {
    const urls = [
      'http://example.com/mcp',
      'https://127.0.0.1/mcp',
      'https://localhost/mcp',
      'https://app.localhost/mcp',
      'https://[::1]/mcp',
      'https://10.0.0.5/mcp',
      'https://user:pw@example.com/mcp',
      'https://intranet/mcp',
      'not a url',
    ];
    for (const url of urls) expect(isSafeDirectoryRemoteUrl(url), url).toBe(false);
  });

  it('accepts public https hosts, with ports and paths', () => {
    expect(isSafeDirectoryRemoteUrl('https://mcp.example.com/mcp')).toBe(true);
    expect(isSafeDirectoryRemoteUrl('https://mcp.example.com:8443/v1')).toBe(true);
    expect(isSafeDirectoryRemoteUrl('https://mcp.example.com./mcp')).toBe(true);
  });
});
