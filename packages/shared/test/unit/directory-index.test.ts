import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_INDEX_PUBLIC_KEYS,
  applyDirectoryDelta,
  canonicalEntriesJson,
  connectorDeltaFileSchema,
  connectorDeltaPath,
  connectorIndexSchema,
  selectIndexKey,
  stableStringify,
  type ConnectorIndexPublicKey,
} from '../../src/index.js';

/** 签名目录索引的共享契约（D73 P3 §7.1）：信封 schema、密钥选择、规范化序列化、增量应用。 */

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

describe('connectorIndexSchema', () => {
  const base = { version: 1, generatedAt: '2026-10-10T00:00:00.000Z', keyId: 'k-1', entries: [] };

  it('normalizes generatedAt (ISO string or epoch ms) to epoch milliseconds', () => {
    expect(connectorIndexSchema.parse(base).generatedAt).toBe(Date.parse(base.generatedAt));
    expect(
      connectorIndexSchema.parse({ ...base, generatedAt: 1_700_000_000_000 }).generatedAt,
    ).toBe(1_700_000_000_000);
  });

  it('rejects a wrong version, a bad keyId, a bad date and a non-array entries', () => {
    expect(connectorIndexSchema.safeParse({ ...base, version: 2 }).success).toBe(false);
    expect(connectorIndexSchema.safeParse({ ...base, keyId: '../x' }).success).toBe(false);
    expect(connectorIndexSchema.safeParse({ ...base, generatedAt: 'yesterday' }).success).toBe(
      false,
    );
    expect(connectorIndexSchema.safeParse({ ...base, generatedAt: 0 }).success).toBe(false);
    expect(connectorIndexSchema.safeParse({ ...base, entries: {} }).success).toBe(false);
  });

  it('only accepts content-addressed delta paths', () => {
    const ok = { from: H1, to: H2, path: connectorDeltaPath(H1, H2), sha256: H1 };
    expect(connectorIndexSchema.safeParse({ ...base, deltas: [ok] }).success).toBe(true);
    expect(
      connectorIndexSchema.safeParse({ ...base, deltas: [{ ...ok, path: 'deltas/../../x.json' }] })
        .success,
    ).toBe(false);
    expect(
      connectorIndexSchema.safeParse({
        ...base,
        deltas: [{ ...ok, path: `deltas/${H2}-${H1}.json` }],
      }).success,
    ).toBe(false);
  });
});

describe('selectIndexKey', () => {
  const keys: ConnectorIndexPublicKey[] = [
    {
      keyId: 'old',
      publicKey: 'A'.repeat(43) + '=',
      validFrom: 100,
      validUntil: 200,
      revoked: false,
    },
    { keyId: 'bad', publicKey: 'A'.repeat(43) + '=', validFrom: 0, revoked: true },
    { keyId: 'new', publicKey: 'A'.repeat(43) + '=', validFrom: 150, revoked: false },
  ];

  it('picks a key by id inside its validity window', () => {
    expect(selectIndexKey(keys, 'old', 150)).toMatchObject({ ok: true });
    expect(selectIndexKey(keys, 'new', 1_000_000)).toMatchObject({ ok: true });
  });

  it('rejects unknown, revoked and out-of-window keys', () => {
    expect(selectIndexKey(keys, 'ghost', 150)).toEqual({ ok: false, reason: 'unknown_key' });
    expect(selectIndexKey(keys, 'bad', 150)).toEqual({ ok: false, reason: 'revoked_key' });
    expect(selectIndexKey(keys, 'old', 99)).toEqual({ ok: false, reason: 'key_not_valid_at' });
    expect(selectIndexKey(keys, 'old', 200)).toEqual({ ok: false, reason: 'key_not_valid_at' });
    expect(selectIndexKey([], 'old', 150)).toEqual({ ok: false, reason: 'unknown_key' });
  });
});

describe('canonical serialization and deltas', () => {
  it('stableStringify sorts keys, drops undefined and is order independent', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
    );
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('canonicalEntriesJson is independent of entry order', () => {
    const a = { name: 'a/x', v: 1 };
    const b = { name: 'b/y', v: 2 };
    expect(canonicalEntriesJson([a, b])).toBe(canonicalEntriesJson([b, a]));
  });

  it('applyDirectoryDelta removes then upserts by name', () => {
    const entries = [
      { name: 'a/x', v: 1 },
      { name: 'b/y', v: 1 },
      { name: 'c/z', v: 1 },
    ];
    const next = applyDirectoryDelta(entries, {
      remove: ['b/y'],
      upsert: [
        { name: 'a/x', v: 2 },
        { name: 'd/w', v: 1 },
      ],
    });
    expect(next.map((entry) => JSON.stringify(entry)).sort()).toEqual(
      [
        { name: 'a/x', v: 2 },
        { name: 'c/z', v: 1 },
        { name: 'd/w', v: 1 },
      ]
        .map((entry) => JSON.stringify(entry))
        .sort(),
    );
  });

  it('validates the delta file shape', () => {
    expect(
      connectorDeltaFileSchema.safeParse({
        version: 1,
        from: H1,
        to: H2,
        upsert: [],
        remove: ['com.a/b'],
      }).success,
    ).toBe(true);
    expect(
      connectorDeltaFileSchema.safeParse({ version: 1, from: 'x', to: H2, upsert: [], remove: [] })
        .success,
    ).toBe(false);
  });
});

describe('production key list', () => {
  it('is empty until the real signing key exists (U5): directory sync stays disabled', () => {
    expect(CONNECTOR_INDEX_PUBLIC_KEYS).toEqual([]);
  });
});
