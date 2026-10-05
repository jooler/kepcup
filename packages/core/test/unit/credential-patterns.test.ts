import { describe, expect, it } from 'vitest';

import { containsCredential } from '../../src/memory/credential-patterns.js';

describe('credential patterns (P07 写入校验)', () => {
  it('matches common API key prefixes', () => {
    expect(containsCredential('我的 key 是 sk-abcdefghij1234567890abcdefgh')).toBe(true);
    expect(containsCredential('github token ghp_abcdefghijklmnopqrstuv')).toBe(true);
    expect(containsCredential('AWS key AKIAIOSFODNN7EXAMPLE in config')).toBe(true);
    expect(containsCredential('xoxb-123456789-abcdefgh')).toBe(true);
    expect(containsCredential('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567')).toBe(true);
  });

  it('matches private key blocks', () => {
    expect(
      containsCredential('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\n-----END RSA PRIVATE KEY-----'),
    ).toBe(true);
    expect(
      containsCredential(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
      ),
    ).toBe(true);
  });

  it('matches keyword:value pairs in English and Chinese', () => {
    expect(containsCredential('password: hunter2secret')).toBe(true);
    expect(containsCredential('API_KEY = "ab12cd34ef56"')).toBe(true);
    expect(containsCredential('我的密码是abc123456')).toBe(true);
    expect(containsCredential('令牌：eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi789')).toBe(true);
  });

  it('does not match prose that merely mentions the words', () => {
    expect(containsCredential('请告诉我修改密码的入口在哪里')).toBe(false);
    expect(containsCredential('密码是账户安全的第一道防线')).toBe(false);
    expect(containsCredential('I forgot my password again')).toBe(false);
    expect(containsCredential('这个服务的 token 用量需要付费')).toBe(false);
    expect(containsCredential('把 API key 放到 .env 文件里，不要提交')).toBe(false);
    expect(containsCredential('')).toBe(false);
  });
});
