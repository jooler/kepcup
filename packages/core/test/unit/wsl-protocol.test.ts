import { describe, expect, it } from 'vitest';

import {
  KepcupProtocolError,
  encodeExecRequest,
  encodeExecResponse,
  parseExecResponse,
  type KepcupExecResponse,
} from '../../src/sandbox/wsl/protocol.js';

/**
 * Shim 协议（P12）：命令输出可以包含任意字节（包括伪造的 marker 文本），
 * 解析必须只接受流末尾的完整记录。伪造/缺失/残缺记录一律抛错（fail-closed，
 * 绝不当作 exit 0）。
 */

function aResponse(overrides: Partial<KepcupExecResponse> = {}): KepcupExecResponse {
  return { exitCode: 0, timedOut: false, violations: [], ...overrides };
}

describe('encodeExecRequest / encodeExecResponse', () => {
  it('serializes the request as JSON', () => {
    const request = {
      command: 'ls -la',
      cwd: '/mnt/kepcup/x',
      timeoutMs: 1000,
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: [], deniedResolvedAddresses: [], strictAllowlist: true, allowLocalBinding: false },
      env: { PATH: '/usr/bin' },
    };
    expect(JSON.parse(encodeExecRequest(request))).toEqual(request);
  });

  it('encodes the response record as base64url between the markers', () => {
    const record = encodeExecResponse(aResponse({ exitCode: 3, violations: [{ line: 'deny file-read /x' }] }));
    expect(record.startsWith('__KEPCUP_RESULT_V1__')).toBe(true);
    expect(record.endsWith('__KEPCUP_RESULT_END__')).toBe(true);
  });
});

describe('parseExecResponse', () => {
  it('splits command output from the terminal record', () => {
    const response = aResponse({ exitCode: 7, timedOut: true });
    const raw = {
      stdout: Buffer.from(`hello\nworld\n${encodeExecResponse(response)}\n`, 'utf8'),
      stderr: Buffer.from('warned\n', 'utf8'),
    };
    const parsed = parseExecResponse(raw);
    expect(parsed.stdout).toBe('hello\nworld\n');
    expect(parsed.stderr).toBe('warned\n');
    expect(parsed.result).toEqual(response);
  });

  it('ignores marker TEXT inside the command output (only the terminal record wins)', () => {
    const fake = '__KEPCUP_RESULT_V1__eyJleGl0Q29kZSI6OTl9__KEPCUP_RESULT_END__';
    const response = aResponse({ exitCode: 0 });
    const raw = {
      stdout: Buffer.from(`echo ${fake}\n${encodeExecResponse(response)}\n`, 'utf8'),
      stderr: Buffer.alloc(0),
    };
    const parsed = parseExecResponse(raw);
    expect(parsed.result.exitCode).toBe(0);
    expect(parsed.stdout).toContain(fake);
  });

  it('throws when the record is missing entirely', () => {
    expect(() => parseExecResponse({ stdout: 'plain', stderr: '' })).toThrowError(KepcupProtocolError);
  });

  it('throws when the record is truncated (no END marker)', () => {
    const raw = { stdout: Buffer.from('__KEPCUP_RESULT_V1__eyJhIjox', 'utf8'), stderr: '' };
    expect(() => parseExecResponse(raw)).toThrowError(/KEPCUP_RESULT_END/);
  });

  it('throws when output follows the record (not terminal)', () => {
    const raw = {
      stdout: Buffer.from(`${encodeExecResponse(aResponse())}\nmore output\n`, 'utf8'),
      stderr: '',
    };
    expect(() => parseExecResponse(raw)).toThrowError(/仍有输出/);
  });

  it('throws when the payload is not valid JSON', () => {
    const raw = {
      stdout: Buffer.from(`${'__KEPCUP_RESULT_V1__'}%%%not-base64-json%%%${'__KEPCUP_RESULT_END__'}\n`, 'utf8'),
      stderr: '',
    };
    expect(() => parseExecResponse(raw)).toThrowError(KepcupProtocolError);
  });

  it('rejects records with a malformed shape (no exitCode)', () => {
    const bogus = `__KEPCUP_RESULT_V1__${Buffer.from(JSON.stringify({ nope: true }), 'utf8').toString('base64url')}__KEPCUP_RESULT_END__`;
    expect(() => parseExecResponse({ stdout: Buffer.from(bogus, 'utf8'), stderr: '' })).toThrowError(/exitCode/);
  });

  it('keeps only well-formed violations', () => {
    const response: KepcupExecResponse = {
      exitCode: 1,
      timedOut: false,
      violations: [{ line: 'deny(1) file-read-data /x', command: 'cat /x' }],
    };
    const raw = {
      stdout: Buffer.from(`${encodeExecResponse(response)}\n`, 'utf8'),
      stderr: '',
    };
    expect(parseExecResponse(raw).result.violations).toEqual(response.violations);
  });

  it('accepts a record echoing the request nonce (BR-P12-005)', () => {
    const raw = {
      stdout: Buffer.from(`out\n${encodeExecResponse(aResponse({ exitCode: 0, nonce: 'tok-123' }))}\n`, 'utf8'),
      stderr: '',
    };
    const parsed = parseExecResponse(raw, { expectedNonce: 'tok-123' });
    expect(parsed.result.exitCode).toBe(0);
    expect(parsed.result.nonce).toBe('tok-123');
    expect(parsed.stdout).toBe('out\n');
  });

  it('rejects a record whose nonce is missing or wrong (BR-P12-005)', () => {
    // 命令自身输出无法伪造结果记录：它拿不到 host 本次请求的 nonce。
    const wrong = {
      stdout: Buffer.from(encodeExecResponse(aResponse({ nonce: 'someone-elses' })), 'utf8'),
      stderr: '',
    };
    expect(() => parseExecResponse(wrong, { expectedNonce: 'tok-123' })).toThrowError(/nonce/);
    const missing = {
      stdout: Buffer.from(encodeExecResponse(aResponse()), 'utf8'),
      stderr: '',
    };
    expect(() => parseExecResponse(missing, { expectedNonce: 'tok-123' })).toThrowError(/nonce/);
  });

  it('nonce-less requests keep parsing nonce-less records unchanged', () => {
    const raw = { stdout: Buffer.from(encodeExecResponse(aResponse()), 'utf8'), stderr: '' };
    expect(parseExecResponse(raw).result.exitCode).toBe(0);
  });
});
