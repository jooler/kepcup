import os from 'node:os';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { canonicalPath, resolvePaths } from '../../src/infra/paths.js';
import { buildSandboxPolicy, alwaysDeniedAddresses, alwaysDeniedDomainEntries } from '../../src/sandbox/policy.js';
import { childEnvFor, srtNetworkConfigFor } from '../../src/sandbox/backend-srt.js';
import type { SandboxNetworkPolicy } from '../../src/sandbox/types.js';
const paths = resolvePaths('/tmp/kepcup-policy-test');

function policyFor(network: SandboxNetworkPolicy) {
  return buildSandboxPolicy({
    platform: process.platform,
    paths,
    workspacePath: workspace(),
    network,
  });
}

function workspace(): string {
  return path.join(paths.home, 'bots', 'bot_1', 'workspaces', 'conv_1');
}

describe('buildSandboxPolicy', () => {
  it('marks the workspace and app caches read-write, never the tmpdir ancestor', () => {
    const policy = policyFor({ mode: 'open', allowDomains: [] });
    expect(policy.readWrite).toContain(workspace());
    expect(policy.readWrite).toContain(paths.cacheNpmDir);
    // os.tmpdir() is an ancestor of the data home in tests; allowing it would
    // un-do the home deny in the sandbox profile. srt manages TMPDIR itself.
    expect(policy.readWrite).not.toContain(os.tmpdir());
    expect(policy.readWrite).toContain(paths.cachePipDir);
    expect(policy.readWrite).toContain(paths.cacheXdgDir);
    expect(policy.readWrite).toContain(paths.cacheCargoDir);
  });

  it('denies the user home, the data home and system locations from reading', () => {
    const policy = policyFor({ mode: 'open', allowDomains: [] });
    // The canonical user home itself (BR-P02-001), not just the data home:
    // ~/Documents, shell history and source trees must stay unreadable.
    expect(policy.denyRead).toContain(canonicalPath(os.homedir()));
    expect(policy.denyRead).toContain(paths.home);
    expect(policy.denyRead.length).toBeGreaterThanOrEqual(2);
    // The workspace is under the denied home but re-exposed via readWrite.
    expect(policy.readWrite).toContain(workspace());
  });

  it('keeps a real toolchain root read-only when it exists', () => {
    const policy = policyFor({ mode: 'open', allowDomains: [] });
    // /usr exists on macOS and Linux CI runners.
    expect(policy.readOnly).toContain('/usr');
  });

  it('merges effective grants into readWrite/readOnly (P03)', () => {
    const writeGrant = {
      id: 'grt_w',
      botId: 'bot_1',
      conversationId: 'conv_1',
      path: '/tmp/granted-write',
      access: 'write' as const,
      duration: 'once' as const,
      runId: null,
      approvalId: null,
      createdAt: 0,
      revokedAt: null,
    };
    const readGrant = { ...writeGrant, id: 'grt_r', path: '/tmp/granted-read', access: 'read' as const };
    const policy = buildSandboxPolicy({
      platform: process.platform,
      paths,
      workspacePath: workspace(),
      network: { mode: 'none', allowDomains: [] },
      grants: [writeGrant, readGrant],
    });
    expect(policy.readWrite).toContain('/tmp/granted-write');
    expect(policy.readWrite).not.toContain('/tmp/granted-read');
    expect(policy.readOnly).toContain('/tmp/granted-read');
  });

  it('removes a granted path from denyRead (policy level)', () => {
    // The data home is always in denyRead; at the policy layer a covering
    // grant removes it (the gateway never creates such a grant for the data
    // home — this pins the denyRead filtering logic itself).
    const preGrant = buildSandboxPolicy({
      platform: process.platform,
      paths,
      workspacePath: workspace(),
      network: { mode: 'none', allowDomains: [] },
    });
    expect(preGrant.denyRead).toContain(paths.home);
    const postGrant = buildSandboxPolicy({
      platform: process.platform,
      paths,
      workspacePath: workspace(),
      network: { mode: 'none', allowDomains: [] },
      grants: [
        {
          id: 'grt_s',
          botId: 'bot_1',
          conversationId: 'conv_1',
          path: paths.home,
          access: 'read',
          duration: 'once',
          runId: null,
          approvalId: null,
          createdAt: 0,
          revokedAt: null,
        },
      ],
    });
    expect(postGrant.denyRead).not.toContain(paths.home);
    expect(postGrant.readOnly).toContain(paths.home);
  });

  it('points package-manager caches at the app cache directory', () => {
    const policy = policyFor({ mode: 'open', allowDomains: [] });
    expect(policy.env['npm_config_cache']).toBe(paths.cacheNpmDir);
    expect(policy.env['PIP_CACHE_DIR']).toBe(paths.cachePipDir);
    expect(policy.env['XDG_CACHE_HOME']).toBe(paths.cacheXdgDir);
    expect(policy.env['CARGO_HOME']).toBe(paths.cacheCargoDir);
    expect(policy.env['UV_CACHE_DIR']).toBe(paths.cacheUvDir);
    // Never the user's real caches (PATH carries the host lookup path and is
    // exempt; every other entry is an app-cache path).
    for (const [name, value] of Object.entries(policy.env)) {
      if (name === 'PATH') continue;
      expect(value.startsWith(paths.home + path.sep)).toBe(true);
      expect(value).not.toContain(os.homedir());
    }
  });

  it('prefixes PATH with installed toolchain bin dirs and exposes the toolchains root read-only (P06)', () => {
    // Policy only lists the toolchains root when it exists (created at startup).
    mkdirSync(paths.toolchainsDir, { recursive: true });
    const prefix = ['/tc/uv', '/tc/node/bin'].join(path.delimiter);
    const policy = buildSandboxPolicy({
      platform: process.platform,
      paths,
      workspacePath: workspace(),
      network: { mode: 'open', allowDomains: [] },
      toolchainPathPrefix: prefix,
      toolchainsRoot: paths.toolchainsDir,
    });
    expect(policy.env['PATH']).toBe(`${prefix}${path.delimiter}${process.env.PATH ?? ''}`);
    // The toolchains root lives under the denied data home and is re-exposed
    // read-only (srt read model: deny-then-allow, last match wins).
    expect(policy.readOnly).toContain(paths.toolchainsDir);
    const without = buildSandboxPolicy({
      platform: process.platform,
      paths,
      workspacePath: workspace(),
      network: { mode: 'open', allowDomains: [] },
    });
    expect(without.env['PATH']).toBe(process.env.PATH ?? '');
    // Default wiring: the existing toolchains root stays read-only even
    // without an explicit prefix (production always has the dir).
    expect(without.readOnly).toContain(paths.toolchainsDir);
  });

  it('builds the sandbox child environment from the host allowlist plus policy env', () => {
    const child = childEnvFor(
      { PATH: '/usr/bin:/bin', HOME: '/home/u', SECRET_TOKEN: 'leak-me', APP_SUPER_SECRET: 'leak-me-too' },
      { npm_config_cache: paths.cacheNpmDir },
    );
    expect(child['PATH']).toBe('/usr/bin:/bin');
    expect(child['HOME']).toBe('/home/u');
    expect(child['npm_config_cache']).toBe(paths.cacheNpmDir);
    expect(Object.keys(child)).not.toContain('SECRET_TOKEN');
    expect(Object.keys(child)).not.toContain('APP_SUPER_SECRET');
  });
});

describe('srt network config mapping', () => {
  const denied = alwaysDeniedAddresses();
  const { domains: deniedDomains } = alwaysDeniedDomainEntries();

  it('denies loopback, RFC1918, link-local and metadata addresses in every mode', () => {
    for (const group of ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']) {
      expect(denied).toContain(group);
    }
    expect(denied).toContain('localhost');
    expect(denied).toContain('::1');
    expect(denied).toContain('100.100.100.200'); // Alibaba metadata
    expect(denied).toContain('168.63.129.16'); // Azure WireServer
  });

  it('splits hostname entries out of the resolved-address list', () => {
    const { domains, resolvedAddresses } = alwaysDeniedDomainEntries();
    expect(domains).toContain('localhost');
    expect(resolvedAddresses).not.toContain('localhost');
    expect(resolvedAddresses).toContain('192.168.0.0/16');
  });

  it('configures none mode as a strict empty allowlist', () => {
    const config = srtNetworkConfigFor(policyFor({ mode: 'none', allowDomains: [] }));
    expect(config.allowedDomains).toEqual([]);
    expect(config.strictAllowlist).toBe(true);
    expect(config.allowLocalBinding).toBe(false);
    expect(config.deniedDomains).toEqual(deniedDomains);
    expect(config.deniedResolvedAddresses).toEqual(denied.filter((entry) => entry !== 'localhost'));
  });

  it('configures allowlist mode with the profile domains', () => {
    const config = srtNetworkConfigFor(
      policyFor({ mode: 'allowlist', allowDomains: ['example.com', '*.github.com'] }),
    );
    expect(config.allowedDomains).toEqual(['example.com', '*.github.com']);
    expect(config.strictAllowlist).toBe(true);
  });

  it('configures open mode to fall through to the always-allow callback', () => {
    const config = srtNetworkConfigFor(policyFor({ mode: 'open', allowDomains: [] }));
    expect(config.allowedDomains).toEqual([]);
    expect(config.strictAllowlist).toBe(false);
    expect(config.deniedDomains).toEqual(deniedDomains);
  });
});
