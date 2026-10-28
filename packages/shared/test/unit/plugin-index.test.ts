import { describe, expect, it } from 'vitest';
import {
  PLUGIN_INDEX_PUBLIC_KEYS,
  PLUGIN_PACKAGE_MAX_BYTES,
  pluginIndexEntrySchema,
  pluginIndexRevokedSchema,
  pluginIndexSchema,
  pluginMarketEntrySchema,
  pluginMarketStatusSchema,
  pluginsMarketplaceListOutputSchema,
  pluginsMarketplaceRefreshOutputSchema,
  pluginsMarketplaceUpdatedPayloadSchema,
  pluginMarketplaceUrlSchema,
  pluginMarketplacePublicKeySchema,
  isHttpsMarketplaceUrl,
  pluginSourceSchema,
  pluginSummarySchema,
} from '../../src/index.js';

/**
 * 插件市场索引契约（D104 P1-1 步骤 2.1 / 2.3）：信封与条目 schema、坏条目不影响信封、
 * `revoked` 默认值、`downloadUrl` 必须 https、市场视图与设置键形状。
 */

const key = {
  keyId: 'kepcup-plugins-test',
  publicKey: 'A'.repeat(43) + '=',
  validFrom: 0,
  revoked: false,
};

const entry = {
  id: 'io.github.alice/doc-tools',
  version: '1.2.0',
  tier: 'verified',
  sha256: 'a'.repeat(64),
  size: 1024,
  downloadUrl: 'https://pkg.example.com/abcdef.kepcup',
  categories: ['skill'],
  summary: { name: '文档工具集' },
  updatedAt: 1,
};

const envelope = {
  version: 1 as const,
  generatedAt: Date.parse('2026-10-10T00:00:00.000Z'),
  keyId: 'kepcup-plugins-test',
  entries: [entry],
};

describe('pluginIndexSchema (envelope)', () => {
  it('accepts a minimal envelope and defaults revoked to []', () => {
    const parsed = pluginIndexSchema.parse(envelope);
    expect(parsed.revoked).toEqual([]);
    expect(parsed.entries).toEqual([entry]);
  });

  it('generatedAt accepts an ISO string and normalizes to epoch ms', () => {
    const parsed = pluginIndexSchema.parse({ ...envelope, generatedAt: '2026-10-10T00:00:00Z' });
    expect(parsed.generatedAt).toBe(Date.parse('2026-10-10T00:00:00.000Z'));
  });

  it('a malformed entry does not invalidate the envelope (per-entry checks live in core)', () => {
    const bad = { ...entry, version: 'not-a-version' };
    const parsed = pluginIndexSchema.parse({ ...envelope, entries: [bad, entry] });
    expect(parsed.entries).toHaveLength(2);
    expect(pluginIndexEntrySchema.safeParse(parsed.entries[0]).success).toBe(false);
    expect(pluginIndexEntrySchema.safeParse(parsed.entries[1]).success).toBe(true);
  });

  it('rejects an unknown version, an oversized entry list and a bad keyId', () => {
    expect(pluginIndexSchema.safeParse({ ...envelope, version: 2 }).success).toBe(false);
    expect(
      pluginIndexSchema.safeParse({ ...envelope, entries: Array(5001).fill(entry) }).success,
    ).toBe(false);
    expect(pluginIndexSchema.safeParse({ ...envelope, keyId: 'bad id!' }).success).toBe(false);
  });
});

describe('pluginIndexEntrySchema', () => {
  it('accepts a full entry and defaults summary fields', () => {
    const parsed = pluginIndexEntrySchema.parse(entry);
    expect(parsed.summary).toEqual({ name: '文档工具集', description: '', author: null });
  });

  it('rejects a non-https / overlong downloadUrl', () => {
    expect(
      pluginIndexEntrySchema.safeParse({ ...entry, downloadUrl: 'http://pkg.example.com/a.kepcup' })
        .success,
    ).toBe(false);
    expect(
      pluginIndexEntrySchema.safeParse({
        ...entry,
        downloadUrl: `https://x.test/${'a'.repeat(500)}`,
      }).success,
    ).toBe(false);
  });

  it('rejects an uppercase sha256, a size above the package cap and an unknown tier', () => {
    expect(pluginIndexEntrySchema.safeParse({ ...entry, sha256: 'A'.repeat(64) }).success).toBe(
      false,
    );
    expect(
      pluginIndexEntrySchema.safeParse({ ...entry, size: PLUGIN_PACKAGE_MAX_BYTES + 1 }).success,
    ).toBe(false);
    expect(pluginIndexEntrySchema.safeParse({ ...entry, tier: 'developer' }).success).toBe(false);
  });
});

describe('pluginIndexRevokedSchema', () => {
  it('defaults action to warn and reason to empty; version is optional', () => {
    const parsed = pluginIndexRevokedSchema.parse({ id: 'io.github.alice/doc-tools' });
    expect(parsed).toEqual({ id: 'io.github.alice/doc-tools', action: 'warn', reason: '' });
    expect(
      pluginIndexRevokedSchema.safeParse({ id: 'x.y/z', version: '1.0.0', action: 'disable' })
        .success,
    ).toBe(true);
  });
});

describe('marketplace RPC views', () => {
  it('status parses the disabled / healthy shapes', () => {
    expect(
      pluginMarketStatusSchema.parse({
        state: 'disabled',
        disabledReason: 'no_keys',
        lastSync: null,
        generatedAt: null,
        error: null,
        endpoint: 'official',
      }),
    ).toMatchObject({ state: 'disabled' });
    expect(
      pluginMarketStatusSchema.safeParse({
        state: 'ok',
        disabledReason: null,
        lastSync: 1,
        generatedAt: 1,
        error: null,
        endpoint: 'custom',
      }).success,
    ).toBe(true);
    expect(pluginMarketStatusSchema.safeParse({ state: 'nope' }).success).toBe(false);
  });

  it('list / refresh outputs and the updated payload parse', () => {
    const status = {
      state: 'ok',
      disabledReason: null,
      lastSync: 1,
      generatedAt: 1,
      error: null,
      endpoint: 'official',
    } as const;
    expect(pluginsMarketplaceListOutputSchema.parse({ status, entries: [] })).toEqual({
      status,
      entries: [],
    });
    expect(pluginsMarketplaceRefreshOutputSchema.parse({ status })).toEqual({ status });
    expect(pluginsMarketplaceUpdatedPayloadSchema.parse({ generatedAt: null })).toEqual({
      generatedAt: null,
    });
    const marketEntry = {
      id: 'io.github.alice/doc-tools',
      version: '1.2.0',
      tier: 'verified',
      name: '文档工具集',
      description: '',
      author: null,
      categories: ['skill'],
      size: 1,
      updatedAt: 1,
      compatible: true,
      incompatibleReason: null,
      installed: null,
      revoked: null,
    };
    expect(pluginMarketEntrySchema.safeParse(marketEntry).success).toBe(true);
  });
});

describe('marketplace settings keys', () => {
  it('the URL accepts empty or https without credentials and rejects the rest', () => {
    expect(pluginMarketplaceUrlSchema.safeParse('').success).toBe(true);
    expect(
      pluginMarketplaceUrlSchema.safeParse('https://market.example.com/plugins/v1').success,
    ).toBe(true);
    expect(pluginMarketplaceUrlSchema.safeParse('http://market.example.com').success).toBe(false);
    expect(
      pluginMarketplaceUrlSchema.safeParse('https://user:pass@market.example.com').success,
    ).toBe(false);
    expect(isHttpsMarketplaceUrl('https://u@h')).toBe(false);
  });

  it('the public key accepts empty or a 44-char base64 raw key', () => {
    expect(pluginMarketplacePublicKeySchema.safeParse('').success).toBe(true);
    expect(pluginMarketplacePublicKeySchema.safeParse(key.publicKey).success).toBe(true);
    expect(pluginMarketplacePublicKeySchema.safeParse('short').success).toBe(false);
    expect(pluginMarketplacePublicKeySchema.safeParse(`${'!'.repeat(43)}=`).success).toBe(false);
  });
});

describe('source and summary additions', () => {
  it('pluginSourceSchema accepts the marketplace branch', () => {
    expect(pluginSourceSchema.safeParse({ kind: 'marketplace', id: 'io.a/b' }).success).toBe(true);
    expect(
      pluginSourceSchema.safeParse({ kind: 'marketplace', id: 'io.a/b', version: '1.0.0' }).success,
    ).toBe(true);
    expect(
      pluginSourceSchema.safeParse({ kind: 'marketplace', id: 'io.a/b', version: 'x' }).success,
    ).toBe(false);
    expect(pluginSourceSchema.safeParse({ kind: 'marketplace' }).success).toBe(false);
  });

  it('pluginSummarySchema keeps revoked nullable with a default of null', () => {
    const summary = {
      id: 'io.github.alice/doc-tools',
      name: '文档工具集',
      version: '1.2.0',
      description: '',
      author: null,
      origin: 'local',
      tier: 'developer',
      state: 'installed',
      enabled: true,
      dirPath: null,
      marketplace: null,
      installedAt: 1,
      updatedAt: 1,
      counts: { skills: 0, connectors: 0, mcp: 0, mail: 0 },
      items: [],
      updateAvailable: null,
      configFields: [],
      instanceCounts: { mail: 0, mcp: 0 },
      providesInstances: [],
    };
    expect(pluginSummarySchema.parse(summary).revoked).toBeNull();
    expect(pluginSummarySchema.safeParse({ ...summary, revoked: 'disable' }).success).toBe(true);
    expect(pluginSummarySchema.safeParse({ ...summary, revoked: 'nope' }).success).toBe(false);
  });

  it('the production public-key list carries exactly the registered marketplace key', () => {
    expect(PLUGIN_INDEX_PUBLIC_KEYS).toHaveLength(1);
    expect(PLUGIN_INDEX_PUBLIC_KEYS[0].keyId).toBe('kepcup-plugins-2026-1');
    expect(PLUGIN_INDEX_PUBLIC_KEYS[0].revoked).toBe(false);
  });
});
