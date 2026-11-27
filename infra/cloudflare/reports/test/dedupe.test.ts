/**
 * dedupe.ts unit vectors: canonicalJson semantics, the shared fixture hashes
 * (the cross-runtime contract with core's node:crypto twin), and tamper sensitivity.
 */

import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  canonicalJson,
  computeContentHash,
  computePayloadHash,
  contentSource,
  dedupePayload,
  sha256Hex,
} from '../src/dedupe';
import type { ReportMessage } from '../src/types';
import { NOW, cloneFixture, finalize, loadFixture } from './helpers';

describe('canonicalJson', () => {
  it('sorts object keys recursively (lexicographic)', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [2, { h: 1, g: 2 }] } })).toBe(
      '{"a":{"c":[2,{"g":2,"h":1}],"d":1},"b":1}',
    );
  });

  it('preserves array order (only object keys are sorted)', () => {
    expect(canonicalJson([{ z: 1, y: 2 }, { z: 3, y: 4 }])).toBe(
      '[{"y":2,"z":1},{"y":4,"z":3}]',
    );
  });

  it('keeps JSON.stringify semantics for edge values', () => {
    // undefined-valued object keys are omitted; undefined array elements become null.
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(1e21)).toBe('1e+21');
    // strings escape exactly like JSON.stringify
    expect(canonicalJson({ k: '引号"与\n换行' })).toBe('{"k":"引号\\"与\\n换行"}');
  });

  it('is unicode-stable: astral characters survive the round trip', () => {
    const value = { emoji: '👍', cjk: '小助手', surrogate: '𠮷' };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
    expect(canonicalJson({ b: '𠮷', a: 'x' })).toBe('{"a":"x","b":"𠮷"}');
  });

  it('rejects pathological nesting instead of blowing the stack', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 50; i++) deep = [deep];
    expect(() => canonicalJson(deep)).not.toThrow(); // 50 levels are fine (real payloads are ~6)
    let tooDeep: unknown = 1;
    for (let i = 0; i < 200; i++) tooDeep = [tooDeep];
    expect(() => canonicalJson(tooDeep)).toThrow(RangeError);
  });
});

describe('shared fixture vectors (contract with core)', () => {
  it('computes the fixture content hash: sha256(message.text) utf8', async () => {
    const fixture = loadFixture();
    expect(fixture.message.kind).toBe('text');
    expect(await computeContentHash(fixture.message)).toBe(fixture.hashes.content);
    expect(await computeContentHash(fixture.message)).toBe(
      '69a79ef10ef88c2403a2379e49c17cea33d273aac4c6d325076e9c19fa21c911',
    );
  });

  it('computes the fixture payload hash over the dedupe payload', async () => {
    const fixture = loadFixture();
    const stripped = dedupePayload(fixture);
    expect(Object.keys(stripped)).not.toContain('reportId');
    expect(Object.keys(stripped)).not.toContain('createdAt');
    expect(Object.keys(stripped)).not.toContain('hashes');
    expect(await computePayloadHash(fixture)).toBe(fixture.hashes.payload);
    expect(await computePayloadHash(fixture)).toBe(
      '66f397f8a4cdc8489775eb3c706cccc7dfe0e9c2fea3ea43a1aed5170353215b',
    );
  });

  it('dedupes away reportId/createdAt changes: same content, new id => same payload hash', async () => {
    const fixture = loadFixture();
    const nextClick = await finalize({
      ...cloneFixture(),
      reportId: 'rep_RETRYDIFFERENTID0000000000',
      createdAt: fixture.createdAt + 5_000,
    });
    expect(nextClick.hashes.payload).toBe(fixture.hashes.payload);
    expect(nextClick.hashes.content).toBe(fixture.hashes.content);
  });

  it('card messages hash the canonical card JSON', async () => {
    const card: ReportMessage = {
      id: 'msg_card',
      seq: 1,
      kind: 'card',
      status: 'normal',
      createdAt: NOW,
      editedAt: null,
      runId: null,
      text: '',
      content: { type: 'table', rows: ['a', 'b'] },
      truncated: false,
      attachments: [],
    };
    expect(contentSource(card)).toBe(canonicalJson(card.content));
    expect(await computeContentHash(card)).toBe(
      await sha256Hex('{"rows":["a","b"],"type":"table"}'),
    );
    // content missing entirely falls back to {text}
    const bare: ReportMessage = { ...card, content: null };
    expect(contentSource(bare)).toBe('{"text":""}');
  });

  it('changing any covered byte changes the hashes', async () => {
    const fixture = loadFixture();
    const tamperedText = await finalize({
      ...cloneFixture(),
      message: { ...cloneFixture().message, text: `${fixture.message.text}！` },
    });
    expect(tamperedText.hashes.content).not.toBe(fixture.hashes.content);
    expect(tamperedText.hashes.payload).not.toBe(fixture.hashes.payload);

    const tamperedMeta = await finalize({
      ...cloneFixture(),
      bot: { ...cloneFixture().bot, name: '改名' },
    });
    expect(tamperedMeta.hashes.content).toBe(fixture.hashes.content); // text untouched
    expect(tamperedMeta.hashes.payload).not.toBe(fixture.hashes.payload);

    const garbageHashes = cloneFixture();
    garbageHashes.hashes = { content: '0'.repeat(64), payload: 'f'.repeat(64) };
    // hashes 本身不参与 payload hash：重算结果不受其字段值影响
    expect(await computePayloadHash(garbageHashes)).toBe(fixture.hashes.payload);
  });
});

describe('bucketOf', () => {
  it('floors the server clock into time buckets', () => {
    expect(bucketOf(NOW, 86_400_000)).toBe(Math.floor(NOW / 86_400_000));
    expect(bucketOf(86_400_000 * 3 + 1, 86_400_000)).toBe(3);
  });

  it('uses bucket 0 for permanent dedupe (window 0)', () => {
    expect(bucketOf(NOW, 0)).toBe(0);
    expect(bucketOf(1, 0)).toBe(0);
  });
});
