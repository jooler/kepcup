import { afterEach, describe, expect, it } from 'vitest';
import { validate } from '../src/validate.js';
import { GOOD_TOOLS, find, labels, startHarness, type Harness } from './support.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function run(
  h: Harness,
  manifest: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return validate({ target: h.serve(manifest), timeoutMs: 5000, ...extra });
}

describe('validate: open server (no auth required)', () => {
  it('lists and checks tools without authorization', async () => {
    harness = await startHarness({ requireAuth: false });
    const report = await run(harness, harness.manifest());
    expect(labels(report, 'error')).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.remote).toBe(harness.fake.mcpUrl);
    expect(find(report, 'remote.open')?.severity).toBe('info');
    expect(find(report, 'mcp.session')).toBeDefined();
    expect(find(report, 'tools.list')?.message).toContain('3 tool(s)');
    expect(find(report, 'tools.risk-summary')?.message).toContain(
      '1 read, 1 write and 1 destructive',
    );
    expect(find(report, 'manifest.privacy-policy')?.severity).toBe('info');
    // no OAuth discovery for an open server
    expect(report.checks.some((c) => c.id === 'remote.prm')).toBe(false);
    expect(report.summary.errors).toBe(0);
    expect(report.checks.every((c) => c.doc === c.id.replaceAll('.', '-'))).toBe(true);
  });

  it('flags annotation / title / schema problems in the tool list (exit code 1)', async () => {
    harness = await startHarness({
      requireAuth: false,
      tools: [
        { name: 'delete_page', description: 'Delete a page', annotations: { readOnlyHint: true } },
        { name: 'send_message', title: 'Send', description: 'Send it' },
        { name: 'get_page', description: 'Get a page.' },
        { name: 'x'.repeat(70), title: 'Long', annotations: { readOnlyHint: true } },
      ],
    });
    const report = await run(harness, harness.manifest());
    expect(report.exitCode).toBe(1);
    expect(labels(report, 'error')).toEqual(
      expect.arrayContaining([
        'tool.readonly-claim[delete_page]',
        'tool.write-unannotated[send_message]',
        `tool.name-length[${'x'.repeat(70)}]`,
      ]),
    );
    expect(labels(report, 'warn')).toEqual(
      expect.arrayContaining(['tool.title[delete_page]', 'tool.annotations-missing[get_page]']),
    );
  });

  it('checks MCP Apps resources: CSP missing and wildcard are errors, explicit allowlists pass', async () => {
    harness = await startHarness({
      requireAuth: false,
      tools: [
        {
          ...GOOD_TOOLS[0]!,
          name: 'show_good',
          _meta: { ui: { resourceUri: 'ui://acme/good.html' } },
        },
        {
          ...GOOD_TOOLS[0]!,
          name: 'show_open',
          _meta: { ui: { resourceUri: 'ui://acme/open.html' } },
        },
        {
          ...GOOD_TOOLS[0]!,
          name: 'show_nocsp',
          _meta: { ui: { resourceUri: 'ui://acme/nocsp.html' } },
        },
        {
          ...GOOD_TOOLS[0]!,
          name: 'show_gone',
          _meta: { ui: { resourceUri: 'ui://acme/gone.html' } },
        },
      ],
      resources: [
        {
          uri: 'ui://acme/good.html',
          mimeType: 'text/html;profile=mcp-app',
          text: '<html>ok</html>',
          contentMeta: { ui: { csp: { connectDomains: ['https://api.acme.example'] } } },
        },
        {
          uri: 'ui://acme/open.html',
          mimeType: 'text/html;profile=mcp-app',
          text: '<html>ok</html>',
          contentMeta: { ui: { csp: { connectDomains: ['*'] } } },
        },
        {
          uri: 'ui://acme/nocsp.html',
          mimeType: 'text/html;profile=mcp-app',
          text: '<html>ok</html>',
        },
      ],
    });
    const report = await run(harness, harness.manifest({}, { ui: true }));
    const errors = labels(report, 'error');
    expect(errors).toContain('ui.csp-wildcard[ui://acme/open.html]');
    expect(errors).toContain('ui.csp-missing[ui://acme/nocsp.html]');
    expect(errors).toContain('ui.resource-missing[ui://acme/gone.html]');
    expect(errors.filter((e) => e.includes('good.html'))).toEqual([]);
    expect(find(report, 'ui.csp', 'ui://acme/good.html')?.severity).toBe('info');
    expect(labels(report, 'warn').filter((w) => w.startsWith('manifest.ui'))).toEqual([]);
  });

  it('warns when the manifest ui flag disagrees with the tools', async () => {
    harness = await startHarness({ requireAuth: false });
    const report = await run(harness, harness.manifest({}, { ui: true }));
    expect(labels(report, 'warn')).toContain('manifest.ui');
  });
});

describe('validate: server that requires authorization', () => {
  it('runs reachability + discovery and skips tools without --auth', async () => {
    harness = await startHarness({ cimdSupported: true });
    const report = await run(harness, harness.manifest());
    expect(labels(report, 'error')).toEqual([]);
    expect(report.exitCode).toBe(0);
    for (const id of [
      'remote.reachable',
      'remote.challenge',
      'remote.prm',
      'remote.as-metadata',
      'remote.pkce',
      'remote.iss',
      'remote.client-registration',
      'remote.revocation',
    ]) {
      expect(find(report, id)?.severity, id).toBe('info');
    }
    expect(find(report, 'auth.skipped')?.message).toContain('--auth');
    expect(report.checks.some((c) => c.id === 'tools.list')).toBe(false);
    // only the unauthenticated probe hit the MCP endpoint
    expect(harness.fake.mcpRequests.every((r) => r.token === null)).toBe(true);
    expect(harness.fake.authorizeRequests).toHaveLength(0);
  });

  it('reports a server with weak OAuth support', async () => {
    harness = await startHarness({
      cimdSupported: false,
      dcrEnabled: false,
      issParameterSupported: false,
      revocationSupported: false,
      challengeResourceMetadata: false,
    });
    const report = await run(harness, harness.manifest());
    expect(labels(report, 'error')).toEqual(['remote.client-registration']);
    expect(labels(report, 'warn')).toEqual(
      expect.arrayContaining(['remote.challenge', 'remote.iss', 'remote.revocation']),
    );
    expect(report.exitCode).toBe(1);
  });

  it('accepts DCR when CIMD is not offered', async () => {
    harness = await startHarness({ cimdSupported: false, dcrEnabled: true });
    const report = await run(harness, harness.manifest());
    expect(labels(report, 'error')).toEqual([]);
    expect(find(report, 'remote.client-registration')?.message).toContain(
      'Dynamic client registration',
    );
  });

  it('errors on missing PRM, missing AS metadata and PKCE without S256', async () => {
    harness = await startHarness({ prmEnabled: false });
    expect(labels(await run(harness, harness.manifest()), 'error')).toContain('remote.prm');
    await harness.stop();
    harness = await startHarness({ discovery: 'none' });
    expect(labels(await run(harness, harness.manifest()), 'error')).toContain('remote.as-metadata');
    await harness.stop();
    harness = await startHarness({ codeChallengeMethodsSupported: ['plain'] });
    expect(labels(await run(harness, harness.manifest()), 'error')).toContain('remote.pkce');
  });
});

describe('validate: target loading and privacy policy', () => {
  it('reads a local file as well as a URL', async () => {
    harness = await startHarness({ requireAuth: false });
    const viaFile = await validate({
      target: await harness.writeFile(harness.manifest()),
      timeoutMs: 5000,
    });
    const viaUrl = await run(harness, harness.manifest());
    expect(viaFile.exitCode).toBe(0);
    expect(viaUrl.exitCode).toBe(0);
    expect(viaFile.checks.map((c) => c.id)).toEqual(viaUrl.checks.map((c) => c.id));
  });

  it('reports unreadable, non-JSON and non-200 targets as manifest errors', async () => {
    harness = await startHarness({ requireAuth: false });
    const missing = await validate({ target: '/nonexistent/server.json', timeoutMs: 2000 });
    expect(labels(missing, 'error')).toEqual(['manifest.load']);
    harness.files.setFile('broken.json', '{ nope', 'application/json');
    const broken = await validate({ target: `${harness.files.url}/broken.json`, timeoutMs: 2000 });
    expect(labels(broken, 'error')).toEqual(['manifest.json']);
    const notFound = await validate({
      target: `${harness.files.url}/absent.json`,
      timeoutMs: 2000,
    });
    expect(labels(notFound, 'error')).toEqual(['manifest.load']);
    expect(broken.exitCode).toBe(1);
  });

  it('flags an unreachable, empty or tiny privacy policy', async () => {
    harness = await startHarness({ requireAuth: false });
    harness.files.setFile(
      'empty',
      '<html><body><script>var x=1</script></body></html>',
      'text/html',
    );
    harness.files.setFile('tiny', '<html><body>Hi</body></html>', 'text/html');
    const withPolicy = (path: string) =>
      harness!.manifest({}, { privacyPolicy: `${harness!.files.url}/${path}` });
    expect(labels(await run(harness, withPolicy('missing')), 'error')).toEqual([
      'manifest.privacy-policy',
    ]);
    expect(labels(await run(harness, withPolicy('empty')), 'error')).toEqual([
      'manifest.privacy-policy',
    ]);
    expect(labels(await run(harness, withPolicy('tiny')), 'warn')).toContain(
      'manifest.privacy-policy',
    );
    const closed = harness.manifest({}, { privacyPolicy: 'http://127.0.0.1:1/privacy' });
    expect(labels(await run(harness, closed), 'error')).toEqual(['manifest.privacy-policy']);
  });

  it('reports an unreachable remote and skips the tool checks', async () => {
    harness = await startHarness({ requireAuth: false });
    const manifest = harness.manifest({
      remotes: [{ type: 'streamable-http', url: 'http://127.0.0.1:1/mcp' }],
    });
    const report = await run(harness, manifest);
    expect(labels(report, 'error')).toEqual(['remote.reachable']);
    expect(find(report, 'tools.skipped')?.severity).toBe('info');
  });

  it('flags an unexpected status from the MCP endpoint', async () => {
    harness = await startHarness({ requireAuth: false });
    const manifest = harness.manifest({
      remotes: [{ type: 'streamable-http', url: `${harness.files.url}/nothing` }],
    });
    const report = await run(harness, manifest);
    expect(labels(report, 'error')).toEqual(['remote.reachable']);
  });
});
