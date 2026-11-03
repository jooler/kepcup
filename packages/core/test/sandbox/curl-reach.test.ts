import { describe, expect, it } from 'vitest';

import { SANDBOX_CURL_REACHED, sandboxCurlReachToken } from './curl-reach.js';

describe('sandbox curl reach token', () => {
  it('treats an HTTP status as proof the request left the sandbox', () => {
    expect(sandboxCurlReachToken({ exitCode: 0, stdout: '200', stderr: '' })).toBe('200');
    expect(sandboxCurlReachToken({ exitCode: 0, stdout: '503\n', stderr: '' })).toBe('503');
    expect(SANDBOX_CURL_REACHED.test('200')).toBe(true);
    expect(SANDBOX_CURL_REACHED.test('503')).toBe(true);
  });

  it('treats peer-certificate curl exits as outbound reach', () => {
    for (const exitCode of [51, 60, 83, 90, 91]) {
      const token = sandboxCurlReachToken({
        exitCode,
        stdout: '000',
        stderr: 'curl: (60) SSL certificate problem: unable to get local issuer certificate',
      });
      expect(token, `exit ${exitCode}`).toBe('tls-peer');
      expect(SANDBOX_CURL_REACHED.test(token), `exit ${exitCode}`).toBe(true);
    }
  });

  it('does not treat a hard block or a local TLS setup error as reach', () => {
    const blocked = [
      [6, 'Could not resolve host'],
      [7, 'Failed to connect'],
      [28, 'Operation timed out'],
      [35, 'SSL connect error'],
      [56, 'Received HTTP code 403 from proxy after CONNECT'],
      [77, 'error setting certificate file'],
    ] as const;
    for (const [exitCode, stderr] of blocked) {
      const token = sandboxCurlReachToken({ exitCode, stdout: '000', stderr });
      expect(token, `exit ${exitCode}`).toBe(`exit:${exitCode} ${stderr}`);
      expect(SANDBOX_CURL_REACHED.test(token), `exit ${exitCode}`).toBe(false);
    }
    expect(SANDBOX_CURL_REACHED.test(sandboxCurlReachToken({ exitCode: null, stdout: '200', stderr: '' }))).toBe(false);
    expect(SANDBOX_CURL_REACHED.test(sandboxCurlReachToken({ exitCode: 0, stdout: '', stderr: '' }))).toBe(false);
    expect(SANDBOX_CURL_REACHED.test('exit:60')).toBe(false);
  });
});
