import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appToolName, sha256Hex, toolDefinitionHash } from '../../src/index.js';

/** The shared policy helpers must stay byte-identical to the node:crypto originals. */
describe('sha256Hex (pure JS)', () => {
  const nodeHash = (text: string): string => createHash('sha256').update(text).digest('hex');

  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with node:crypto for padding boundaries and non-ASCII input', () => {
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const text = 'x'.repeat(length);
      expect(sha256Hex(text)).toBe(nodeHash(text));
    }
    for (const text of ['日本語のツール', 'emoji 🚀🔥', '\u0000​\ud83d', 'a'.repeat(100_000)]) {
      expect(sha256Hex(text)).toBe(nodeHash(text));
    }
    for (let i = 0; i < 50; i += 1) {
      const text = randomBytes(1 + i * 7).toString('base64');
      expect(sha256Hex(text)).toBe(nodeHash(text));
    }
  });

  it('keeps toolDefinitionHash and appToolName identical to the node:crypto implementation', () => {
    const tool = {
      name: 'create_issue',
      title: 'Create issue',
      description: 'd',
      inputSchema: { type: 'object', properties: { b: {}, a: {} } },
      annotations: { readOnlyHint: false },
    };
    const canonical =
      '{"annotations":{"readOnlyHint":false},"description":"d","inputSchema":{"properties":{"a":{},"b":{}},"type":"object"},"name":"create_issue","title":"Create issue"}';
    expect(toolDefinitionHash(tool)).toBe(nodeHash(canonical));
    const long = 'x'.repeat(80);
    const raw = `app_linear_${long}`;
    expect(appToolName('linear', long)).toBe(`${raw.slice(0, 41)}_${nodeHash(raw).slice(0, 8)}`);
  });
});
