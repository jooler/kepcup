import { describe, expect, it } from 'vitest';
import {
  generateMasterKey,
  deriveKey,
  seal,
  open,
  KEY_INFO,
  MASTER_KEY_BYTES,
} from '../../src/infra/crypto.js';

describe('crypto', () => {
  it('derives stable, purpose-specific 32-byte keys', () => {
    const master = generateMasterKey();
    const a1 = deriveKey(master, KEY_INFO.mainDb);
    const a2 = deriveKey(master, KEY_INFO.mainDb);
    const b = deriveKey(master, KEY_INFO.runsDb);
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
    expect(a1.length).toBe(32);
    expect(master.length).toBe(MASTER_KEY_BYTES);
  });

  it('round-trips seal/open with AAD', () => {
    const key = deriveKey(generateMasterKey(), 'test');
    const sealed = seal(key, 'hello world', 'row_1');
    expect(sealed.equals(Buffer.from('hello world'))).toBe(false);
    expect(open(key, sealed, 'row_1').toString('utf8')).toBe('hello world');
  });

  it('detects tampering with the ciphertext', () => {
    const key = deriveKey(generateMasterKey(), 'test');
    const sealed = seal(key, 'hello world', 'row_1');
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => open(key, sealed, 'row_1')).toThrow();
  });

  it('rejects a different AAD', () => {
    const key = deriveKey(generateMasterKey(), 'test');
    const sealed = seal(key, 'hello world', 'row_1');
    expect(() => open(key, sealed, 'row_2')).toThrow();
  });

  it('rejects a different key', () => {
    const key = deriveKey(generateMasterKey(), 'test');
    const other = deriveKey(generateMasterKey(), 'test');
    const sealed = seal(key, 'hello world', 'row_1');
    expect(() => open(other, sealed, 'row_1')).toThrow();
  });

  it('rejects truncated payloads', () => {
    const key = deriveKey(generateMasterKey(), 'test');
    expect(() => open(key, Buffer.from([1, 2, 3]), 'row_1')).toThrow();
  });
});
