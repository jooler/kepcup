import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCli } from '../src/cli.js';
import { formatReport } from '../src/report.js';
import {
  REPORT_SCHEMA_VERSION,
  makeCheck,
  summarize,
  type ValidationReport,
} from '../src/types.js';
import { startHarness, type Harness } from './support.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) },
  };
}

describe('parseArgs', () => {
  it('parses validate with all options', () => {
    expect(
      parseArgs(['validate', 'a.json', '--auth', '--json', '--no-browser', '--timeout', '2500']),
    ).toEqual({
      command: 'validate',
      target: 'a.json',
      auth: true,
      json: true,
      noBrowser: true,
      timeoutMs: 2500,
    });
    expect(parseArgs(['validate', '--timeout=900', 'https://x.example/server.json'])).toMatchObject(
      {
        target: 'https://x.example/server.json',
        timeoutMs: 900,
        auth: false,
      },
    );
  });

  it.each([
    [[], 'Missing command'],
    [['frobnicate'], 'Unknown command'],
    [['validate'], 'Missing the server.json'],
    [['validate', 'a', 'b'], 'Exactly one'],
    [['validate', 'a', '--bogus'], 'Unknown option'],
    [['validate', 'a', '--timeout'], '--timeout'],
    [['validate', 'a', '--timeout', 'soon'], '--timeout'],
    [['validate', 'a', '--timeout', '5'], '--timeout'],
  ])('rejects %j', (argv, message) => {
    const parsed = parseArgs(argv);
    expect(parsed.command).toBe('error');
    expect((parsed as { message: string }).message).toContain(message);
  });

  it('recognises help and version anywhere', () => {
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['validate', 'x', '-h']).command).toBe('help');
    expect(parseArgs(['--version']).command).toBe('version');
  });

  it('parses init plugin and pack', () => {
    expect(
      parseArgs([
        'init',
        'plugin',
        './demo',
        '--id',
        'io.github.a/demo',
        '--name',
        'Demo',
        '--force',
      ]),
    ).toEqual({
      command: 'initPlugin',
      dir: './demo',
      id: 'io.github.a/demo',
      name: 'Demo',
      force: true,
    });
    expect(parseArgs(['pack', './demo', '--out=./out.kepcup', '--json'])).toEqual({
      command: 'packPlugin',
      dir: './demo',
      out: './out.kepcup',
      json: true,
    });
  });

  it.each([
    [['init', 'server', './demo'], 'plugin'],
    [['init', 'plugin'], 'Missing the plugin directory'],
    [['init', 'plugin', './demo', '--id'], '--id needs'],
    [['init', 'plugin', './demo', '--bogus'], 'Unknown option'],
    [['pack'], 'Missing the plugin directory'],
    [['pack', './demo', '--out'], '--out needs'],
    [['pack', './demo', '--bogus'], 'Unknown option'],
  ])('rejects %j', (argv, message) => {
    const parsed = parseArgs(argv);
    expect(parsed.command).toBe('error');
    expect((parsed as { message: string }).message).toContain(message);
  });
});

describe('formatReport', () => {
  it('shows hints and doc anchors for problems only', () => {
    const checks = [
      makeCheck('tool.title', 'warn', 'Tool has no title.', {
        subject: 'get_a',
        hint: 'Set a title.',
      }),
      makeCheck('manifest.schema', 'info', 'valid'),
    ];
    const report: ValidationReport = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      target: 't.json',
      remote: null,
      auth: false,
      summary: summarize(checks),
      exitCode: 0,
      checks,
    };
    const text = formatReport(report);
    expect(text).toContain('WARN  tool.title [get_a]  Tool has no title.');
    expect(text).toContain('hint: Set a title.');
    expect(text).toContain('docs: README.md#tool-title');
    expect(text).toContain('PASS: 0 error(s), 1 warning(s), 1 passed/info.');
    expect(text.match(/docs:/g)).toHaveLength(1);
  });
});

describe('runCli', () => {
  it('prints usage / version with exit code 0', async () => {
    const a = io();
    expect(await runCli(['--help'], a.io)).toBe(0);
    expect(a.out.join('')).toContain('Usage: kepcup-app validate');
    const b = io();
    expect(await runCli(['-v'], b.io)).toBe(0);
    expect(b.out.join('')).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 2 on usage errors, writing to stderr only', async () => {
    const a = io();
    expect(await runCli(['validate'], a.io)).toBe(2);
    expect(a.out).toEqual([]);
    expect(a.err.join('')).toContain('Missing the server.json');
  });

  it('exits 2 when the validator itself fails', async () => {
    const a = io();
    const code = await runCli(['validate', 'x.json'], {
      ...a.io,
      validate: () => Promise.reject(new Error('boom')),
    });
    expect(code).toBe(2);
    expect(a.out).toEqual([]);
    expect(a.err.join('')).toContain('boom');
  });

  it('prints the stable JSON report and exits 0 / 1 by error count', async () => {
    harness = await startHarness({ requireAuth: false });
    const good = io();
    const code = await runCli(
      ['validate', harness.serve(harness.manifest()), '--json', '--timeout', '5000'],
      good.io,
    );
    expect(code).toBe(0);
    expect(good.err).toEqual([]); // --json keeps stderr quiet
    const report = JSON.parse(good.out.join('')) as ValidationReport;
    expect(report.schemaVersion).toBe(1);
    expect(Object.keys(report).sort()).toEqual([
      'auth',
      'checks',
      'exitCode',
      'mode',
      'remote',
      'schemaVersion',
      'summary',
      'target',
    ]);
    expect(report.mode).toBe('connector');
    expect(report.exitCode).toBe(0);
    expect(report.checks[0]).toMatchObject({
      id: expect.any(String),
      severity: expect.any(String),
      message: expect.any(String),
      doc: expect.any(String),
    });

    const bad = io();
    const failing = harness.manifest();
    (failing._meta as Record<string, Record<string, unknown>>)['app.kepcup/connector']!.tier =
      'builtin';
    expect(await runCli(['validate', harness.serve(failing), '--timeout', '5000'], bad.io)).toBe(1);
    expect(bad.out.join('')).toContain('FAIL: 1 error(s)');
    expect(bad.out.join('')).toContain('ERROR manifest.tier');
  });

  it('runs --auth through the injected browser', async () => {
    harness = await startHarness({ cimdSupported: true });
    const run = io();
    const code = await runCli(['validate', harness.serve(harness.manifest()), '--auth', '--json'], {
      ...run.io,
      openBrowser: harness.openBrowser,
      validateOverrides: { clientIdUrl: harness.cimdUrl },
    });
    expect(code).toBe(0);
    const report = JSON.parse(run.out.join('')) as ValidationReport;
    expect(report.auth).toBe(true);
    expect(report.checks.some((c) => c.id === 'auth.flow' && c.severity === 'info')).toBe(true);
  });

  it('plugin mode end to end: init → validate --json → pack --json → validate the archive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'app-validator-cli-plugin-'));
    try {
      const dir = path.join(root, 'demo');
      const init = io();
      expect(await runCli(['init', 'plugin', dir, '--id', 'io.github.tester/demo'], init.io)).toBe(
        0,
      );

      const text = io();
      expect(await runCli(['validate', dir], text.io)).toBe(0);
      // Progress lines reach stderr in plugin mode too (text output only).
      expect(text.err.join('')).toContain('Checking plugin.json');

      const validated = io();
      expect(await runCli(['validate', dir, '--json'], validated.io)).toBe(0);
      const report = JSON.parse(validated.out.join('')) as ValidationReport;
      expect(report.mode).toBe('plugin');
      expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
      expect(report.target).toBe(dir);
      expect(validated.err.join('')).toBe('');

      const out = path.join(root, 'demo.kepcup');
      const packed = io();
      expect(await runCli(['pack', dir, '--out', out, '--json'], packed.io)).toBe(0);
      const result = JSON.parse(packed.out.join('')) as { path: string; sha256: string };
      expect(result.path).toBe(out);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

      const archive = io();
      expect(await runCli(['validate', out, '--json'], archive.io)).toBe(0);
      expect((JSON.parse(archive.out.join('')) as ValidationReport).mode).toBe('plugin');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
