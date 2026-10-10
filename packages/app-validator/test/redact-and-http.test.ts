import { afterEach, describe, expect, it } from 'vitest';
import { BlockedUrlError, createGuardedFetch } from '../src/io/http.js';
import { redactCheck, redactText, redactUrl } from '../src/redact.js';
import { makeCheck } from '../src/types.js';
import { isNonPublicHostname } from '../src/util.js';
import { validate } from '../src/validate.js';
import { startHarness, type Harness } from './support.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe('redaction', () => {
  it('keeps origin + path only', () => {
    expect(redactUrl('https://u:p@example.com/a/b?token=SECRET#frag')).toBe(
      'https://example.com/a/b',
    );
    expect(redactUrl('./server.json')).toBe('./server.json');
    expect(redactUrl('http://127.0.0.1:8080/x?y=1')).toBe('http://127.0.0.1:8080/x');
  });

  it('redacts urls inside messages, hints, subjects and details', () => {
    const check = redactCheck(
      makeCheck('manifest.load', 'error', 'Cannot read https://a:b@x.example/m.json?sig=SECRET.', {
        hint: 'try https://x.example/m.json?sig=SECRET again',
        subject: 'https://x.example/?k=SECRET',
        details: { url: 'https://x.example/p?q=SECRET', list: ['https://y.example/?t=SECRET'] },
      }),
    );
    expect(JSON.stringify(check)).not.toMatch(/SECRET|a:b/);
    expect(check.message).toBe('Cannot read https://x.example/m.json.');
    expect(redactText('see https://x.example/a?b=c, then')).toBe('see https://x.example/a, then');
  });

  it('keeps query strings and credentials out of the report', async () => {
    harness = await startHarness({ requireAuth: false });
    harness.files.setFile(
      'm.json?sig=SECRET',
      JSON.stringify(harness.manifest()),
      'application/json',
    );
    const ok = await validate({
      target: `${harness.files.url}/m.json?sig=SECRET`,
      timeoutMs: 5000,
    });
    expect(ok.target).toBe(`${harness.files.url}/m.json`);
    expect(JSON.stringify(ok)).not.toContain('SECRET');

    // fetch refuses credentials in URLs; the error message must not leak them either
    const withCreds = await validate({
      target: `http://user:hunter2@127.0.0.1:${harness.files.port}/m.json?sig=SECRET`,
      timeoutMs: 2000,
    });
    expect(withCreds.exitCode).toBe(1);
    expect(JSON.stringify(withCreds)).not.toMatch(/SECRET|hunter2/);

    const queryRemote = harness.manifest({
      remotes: [{ type: 'streamable-http', url: `${harness.fake.mcpUrl}?key=SECRET` }],
    });
    const report = await validate({ target: harness.serve(queryRemote), timeoutMs: 5000 });
    expect(report.remote).toBe(harness.fake.mcpUrl);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });
});

describe('isNonPublicHostname', () => {
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['[::1]', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['::ffff:127.0.0.1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['example.com', false],
    ['8.8.8.8', false],
  ])('%s -> %s', (host, expected) => {
    expect(isNonPublicHostname(host)).toBe(expected);
  });
});

describe('guarded fetch redirect policy', () => {
  function redirecting(location: string): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://public.example/')) {
        return new Response(null, { status: 302, headers: { location } });
      }
      return new Response('reached', { status: 200 });
    }) as typeof fetch;
  }

  it.each([
    'http://127.0.0.1:9/secret',
    'http://localhost/secret',
    'https://10.0.0.5/admin',
    'https://169.254.169.254/latest/meta-data',
  ])('a public url cannot be redirected to %s', async (location) => {
    const guarded = createGuardedFetch({
      crossOriginRedirects: true,
      fetchImpl: redirecting(location),
    });
    await expect(guarded('https://public.example/start')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('a public url may still redirect to another public host', async () => {
    const guarded = createGuardedFetch({
      crossOriginRedirects: true,
      fetchImpl: redirecting('https://www.public2.example/policy'),
    });
    expect(await (await guarded('https://public.example/start')).text()).toBe('reached');
  });

  it('a loopback start (local development) may stay local, and allowLoopback:false forbids it', async () => {
    const fetchImpl = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    expect(await (await createGuardedFetch({ fetchImpl })('http://127.0.0.1:9/x')).text()).toBe(
      'ok',
    );
    await expect(
      createGuardedFetch({ fetchImpl, allowLoopback: false })('http://127.0.0.1:9/x'),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    // a public server's metadata cannot point the CLI at loopback even for a non-redirect fetch
    await expect(
      createGuardedFetch({ fetchImpl, allowLoopback: false })('https://10.1.1.1/x'),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
