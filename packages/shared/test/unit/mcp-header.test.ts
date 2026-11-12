import { describe, expect, it } from 'vitest';

import {
  ensureBearerPrefix,
  normalizeMcpHeaderValueForStorage,
  normalizeMcpHeaderValueForWire,
  stripBearerPrefix,
} from '../../src/domain/mcp-header.js';

/**
 * 凭据方案的归一化纯函数（腾讯文档 MCP 401 `Bearer token required` 的修复）：
 * 保存只存裸凭据、发送补前缀，两边都必须幂等，且绝不能把凭据内容改坏。
 */

describe('stripBearerPrefix', () => {
  it('去掉任意大小写与多余空白的前缀，只留裸凭据', () => {
    expect(stripBearerPrefix('Bearer abc123')).toBe('abc123');
    expect(stripBearerPrefix('bearer abc123')).toBe('abc123');
    expect(stripBearerPrefix('BEARER abc123')).toBe('abc123');
    expect(stripBearerPrefix('  Bearer   abc123  ')).toBe('abc123');
    expect(stripBearerPrefix('Bearer\tabc123')).toBe('abc123');
    expect(stripBearerPrefix('Bearer \n abc123')).toBe('abc123');
  });

  it('裸凭据只做首尾去空白，内容一个字符都不改', () => {
    expect(stripBearerPrefix('  abc123  ')).toBe('abc123');
    // 内部字符（含 - . _ 与大小写）原样保留。
    expect(stripBearerPrefix('aBc-1_2.3/x')).toBe('aBc-1_2.3/x');
  });

  it('幂等', () => {
    const once = stripBearerPrefix(' Bearer abc123 ');
    expect(stripBearerPrefix(once)).toBe(once);
  });

  it('只粘了 `Bearer` 这个词时不清空凭据', () => {
    expect(stripBearerPrefix('Bearer')).toBe('Bearer');
    expect(stripBearerPrefix('bearer   ')).toBe('bearer');
  });
});

describe('ensureBearerPrefix', () => {
  it('裸凭据补一个前缀', () => {
    expect(ensureBearerPrefix('abc123')).toBe('Bearer abc123');
    expect(ensureBearerPrefix('  abc123\n')).toBe('Bearer abc123');
  });

  it('已带前缀不重复叠加（含大小写 / 空白变体），统一规范成 `Bearer <token>`', () => {
    expect(ensureBearerPrefix('Bearer abc123')).toBe('Bearer abc123');
    expect(ensureBearerPrefix('bearer abc123')).toBe('Bearer abc123');
    expect(ensureBearerPrefix('BEARER   abc123')).toBe('Bearer abc123');
    expect(ensureBearerPrefix('  Bearer\t\n abc123 ')).toBe('Bearer abc123');
    expect(ensureBearerPrefix('Bearer Bearer abc123')).toBe('Bearer Bearer abc123');
  });

  it('空值 / 纯空白不补成 `Bearer `', () => {
    expect(ensureBearerPrefix('')).toBe('');
    expect(ensureBearerPrefix('   ')).toBe('   ');
  });

  it('幂等', () => {
    const once = ensureBearerPrefix('abc123');
    expect(ensureBearerPrefix(once)).toBe(once);
  });
});

describe('normalizeMcpHeaderValueForStorage / ForWire', () => {
  it('声明了 bearer 才归一化；未声明原样返回（其他 header / API key 不受影响）', () => {
    expect(normalizeMcpHeaderValueForStorage('bearer', 'Bearer abc')).toBe('abc');
    expect(normalizeMcpHeaderValueForStorage(undefined, 'Bearer abc')).toBe('Bearer abc');
    expect(normalizeMcpHeaderValueForWire('bearer', 'abc')).toBe('Bearer abc');
    expect(normalizeMcpHeaderValueForWire(undefined, 'abc')).toBe('abc');
  });

  it('保存 → 发送 往返后只有一个前缀', () => {
    for (const input of ['abc', 'Bearer abc', 'bearer   abc', '  BEARER\nabc ']) {
      const stored = normalizeMcpHeaderValueForStorage('bearer', input);
      expect(stored).toBe('abc');
      expect(normalizeMcpHeaderValueForWire('bearer', stored)).toBe('Bearer abc');
    }
  });
});
