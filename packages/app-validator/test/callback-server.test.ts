import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CallbackTimeoutError,
  startCallbackServer,
  type CallbackServer,
} from '../src/io/callback-server.js';

let server: CallbackServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function get(port: number, path: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: host !== undefined ? { host } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('loopback callback server', () => {
  it('delivers the matching callback once and shows a result page', async () => {
    server = await startCallbackServer({ state: 'good-state', ports: [] });
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`);
    const waiting = server.waitForCallback(2000);
    const browser = get(
      server.port,
      '/callback?code=abc&iss=https%3A%2F%2Fi.example&state=good-state',
    );
    const delivery = await waiting;
    expect(delivery.params).toEqual({ code: 'abc', iss: 'https://i.example' });
    delivery.respond({ ok: true });
    const page = await browser;
    expect(page.status).toBe(200);
    expect(page.body).toContain('Authorized');
  });

  it('ignores callbacks with a wrong state without consuming the flow', async () => {
    server = await startCallbackServer({ state: 'good-state', ports: [] });
    const waiting = server.waitForCallback(2000);
    expect((await get(server.port, '/callback?code=x&state=evil')).status).toBe(400);
    expect((await get(server.port, '/callback?code=x')).status).toBe(400);
    expect((await get(server.port, '/other?state=good-state')).status).toBe(404);
    const browser = get(server.port, '/callback?code=real&state=good-state');
    const delivery = await waiting;
    expect(delivery.params.code).toBe('real');
    delivery.respond({ ok: false, reason: '<script>x</script>' });
    const page = await browser;
    expect(page.body).toContain('&lt;script&gt;');
  });

  it('rejects a foreign Host header (DNS rebinding guard)', async () => {
    server = await startCallbackServer({ state: 's', ports: [] });
    const waiting = server.waitForCallback(300);
    waiting.catch(() => undefined);
    const response = await get(server.port, '/callback?code=x&state=s', 'evil.example');
    expect(response.status).toBe(400);
    await expect(waiting).rejects.toBeInstanceOf(CallbackTimeoutError);
  });

  it('rejects the pending wait when closed', async () => {
    server = await startCallbackServer({ state: 's', ports: [] });
    const waiting = server.waitForCallback(5000);
    await server.close();
    await expect(waiting).rejects.toThrow(/cancelled/);
  });
});
