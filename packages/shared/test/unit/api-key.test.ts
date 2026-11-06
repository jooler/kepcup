import { describe, expect, it } from 'vitest';
import { maskApiKey } from '../../src/index.js';

describe('maskApiKey', () => {
  it('保留前 10 个字符里第一个 - 及其前缀，末尾留 4 位', () => {
    expect(maskApiKey('sk-proj-abcdefghijklmnop')).toBe('sk-.......mnop');
    expect(maskApiKey('sk-ant-api03-zzzz')).toBe('sk-.......zzzz');
  });

  it('前 10 个字符没有 - 时保留前 4 位', () => {
    expect(maskApiKey('abcdefghijklmnop')).toBe('abcd.......mnop');
    expect(maskApiKey('1234567890abcdef')).toBe('1234.......cdef');
  });

  it('短 Key 不暴露前缀 / 后缀，整体掩掉', () => {
    expect(maskApiKey('sk-1234')).toBe('.......');
    expect(maskApiKey('abcdefgh')).toBe('.......');
  });

  it('掩码结果不含 Key 中段', () => {
    const key = 'sk-proj-SUPERSECRETMIDDLE-wxyz';
    expect(maskApiKey(key)).toBe('sk-.......wxyz');
    expect(maskApiKey(key)).not.toContain('SUPERSECRET');
  });
});
