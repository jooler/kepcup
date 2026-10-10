import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalEntriesJson as sharedCanonical,
  stableStringify as sharedStable,
} from '@kepcup/shared';
import { fakeCatalogEntry } from '../support/catalog-connect-env.js';
import { SIGN_SCRIPT_PATH, signScript } from '../support/directory-fixture.js';

/**
 * `scripts/sign-connector-index.mjs`（D73 P3 §7.1）：构建 + 签名 + 验证 + 一次性测试密钥；
 * 私钥只从环境变量读、永不输出；规范化序列化与 shared 逐字节一致。
 */

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'signidx-'));
  dirs.push(dir);
  return dir;
};

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}
async function script(args: string[], env: Record<string, string> = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run('node', [SIGN_SCRIPT_PATH, ...args], {
      env: { PATH: process.env['PATH'] ?? '', HOME: tmp(), ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function catalogFile(dir: string, entries: unknown[]): string {
  const file = path.join(dir, 'catalog.json');
  writeFileSync(file, JSON.stringify({ version: 1, connectors: entries }));
  return file;
}
const entry = (slug: string, version = '1.0.0') =>
  fakeCatalogEntry({ slug, version, tier: 'verified', url: `https://${slug}.example.com/mcp` });

async function devKey(): Promise<{ pem: string; keysFile: string; dir: string }> {
  const dir = tmp();
  const out = await script(['--generate-dev-key', dir]);
  expect(out.code, out.stderr).toBe(0);
  return {
    dir,
    pem: readFileSync(path.join(dir, 'dev-key.pem'), 'utf8'),
    keysFile: path.join(dir, 'dev-keys.json'),
  };
}

describe('sign -> verify roundtrip', () => {
  it('signs the bundled catalog and verifies against the matching public key', async () => {
    const key = await devKey();
    const out = path.join(tmp(), 'out');
    const signed = await script(['--out', out, '--key-id', 'dev-1'], {
      KEPCUP_CONNECTOR_SIGNING_KEY: key.pem,
    });
    expect(signed.code, signed.stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['deltas', 'index.json', 'index.json.sig']);
    const index = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'));
    expect(index).toMatchObject({ version: 1, keyId: 'dev-1' });
    expect(index.entries.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(index.generatedAt))).toBe(false);
    const verified = await script(['--verify', out, '--keys', key.keysFile]);
    expect(verified.code, verified.stderr).toBe(0);
    expect(verified.stdout).toContain('OK');
  });

  it('accepts a base64 raw seed as the key and an explicit generatedAt', async () => {
    const key = await devKey();
    const { createPrivateKey } = await import('node:crypto');
    const der = createPrivateKey(key.pem).export({ format: 'der', type: 'pkcs8' });
    const seed = Buffer.from(der).subarray(-32).toString('base64');
    const out = path.join(tmp(), 'out');
    const catalog = catalogFile(tmp(), [entry('alpha')]);
    const signed = await script(
      ['--out', out, '--key-id', 'dev-1', '--catalog', catalog, '--generated-at', '1790000000000'],
      { KEPCUP_CONNECTOR_SIGNING_KEY: seed },
    );
    expect(signed.code, signed.stderr).toBe(0);
    expect((await script(['--verify', out, '--keys', key.keysFile])).code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8')).generatedAt).toBe(
      new Date(1790000000000).toISOString(),
    );
  });

  it('a tampered index.json, a wrong keyId and a revoked key all fail verification', async () => {
    const key = await devKey();
    const out = path.join(tmp(), 'out');
    const catalog = catalogFile(tmp(), [entry('alpha')]);
    await script(['--out', out, '--key-id', 'dev-1', '--catalog', catalog], {
      KEPCUP_CONNECTOR_SIGNING_KEY: key.pem,
    });
    const keys = JSON.parse(readFileSync(key.keysFile, 'utf8'));

    const wrongId = path.join(tmp(), 'wrong.json');
    writeFileSync(wrongId, JSON.stringify([{ ...keys[0], keyId: 'other' }]));
    expect((await script(['--verify', out, '--keys', wrongId])).stderr).toContain('unknown keyId');

    const revoked = path.join(tmp(), 'revoked.json');
    writeFileSync(revoked, JSON.stringify([{ ...keys[0], revoked: true }]));
    expect((await script(['--verify', out, '--keys', revoked])).stderr).toContain('revoked');

    const file = path.join(out, 'index.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('alpha', 'omega'));
    const tampered = await script(['--verify', out, '--keys', key.keysFile]);
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toContain('signature does not match');
  });

  it('an empty production key list refuses to verify without --keys', async () => {
    const out = path.join(tmp(), 'out');
    mkdirSync(out);
    writeFileSync(path.join(out, 'index.json'), '{}');
    writeFileSync(path.join(out, 'index.json.sig'), '');
    const result = await script(['--verify', out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('public key list is empty');
  });
});

describe('the secret key is never printed', () => {
  it('stdout and stderr (success and every failure path) contain no part of the key', async () => {
    const key = await devKey();
    const body = key.pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    const results: Result[] = [];
    const catalog = catalogFile(tmp(), [entry('alpha')]);
    const secretEnv = { KEPCUP_CONNECTOR_SIGNING_KEY: key.pem };
    results.push(
      await script(
        ['--out', path.join(tmp(), 'o1'), '--key-id', 'dev-1', '--catalog', catalog],
        secretEnv,
      ),
    );
    results.push(
      await script(
        ['--out', path.join(tmp(), 'o2'), '--key-id', 'bad id!', '--catalog', catalog],
        secretEnv,
      ),
    );
    results.push(
      await script(
        ['--out', path.join(tmp(), 'o3'), '--key-id', 'k', '--catalog', '/nonexistent.json'],
        secretEnv,
      ),
    );
    results.push(
      await script(['--out', path.join(tmp(), 'o4'), '--key-id', 'k', '--catalog', catalog], {
        KEPCUP_CONNECTOR_SIGNING_KEY: 'SUPERSECRETVALUEwhichisnotakey==',
      }),
    );
    results.push(
      await script(['--out', path.join(tmp(), 'o5'), '--key-id', 'k', '--catalog', catalog]),
    );
    for (const result of results) {
      const text = result.stdout + result.stderr;
      expect(text).not.toContain(body.slice(0, 24));
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain('SUPERSECRETVALUE');
    }
    expect(results[0]!.code).toBe(0);
    expect(results.slice(1).every((r) => r.code === 1)).toBe(true);
    // The invalid-key failure says what is wrong without echoing the value.
    expect(results[3]!.stderr).toContain('not a valid Ed25519 key');
    expect(results[4]!.stderr).toContain('is not set');
  });

  it('only reads the key from the environment (no key-file flag exists)', async () => {
    const key = await devKey();
    const result = await script(['--key-file', path.join(key.dir, 'dev-key.pem'), '--out', tmp()]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown argument');
  });
});

describe('dev key helper', () => {
  it('writes a 0600 key outside the repository and refuses a path inside it', async () => {
    const dir = tmp();
    const ok = await script(['--generate-dev-key', dir]);
    expect(ok.code).toBe(0);
    const { statSync } = await import('node:fs');
    expect(statSync(path.join(dir, 'dev-key.pem')).mode & 0o777).toBe(0o600);
    const inRepo = await script([
      '--generate-dev-key',
      path.join(path.dirname(SIGN_SCRIPT_PATH), '..', 'tmp-should-not-exist'),
    ]);
    expect(inRepo.code).toBe(1);
    expect(inRepo.stderr).toContain('repository tree');
    const viaScripts = await script(['--generate-dev-key', path.dirname(SIGN_SCRIPT_PATH)]);
    expect(viaScripts.code).toBe(1);
  });
});

describe('deltas', () => {
  it('writes a content-addressed delta against --previous, verifies, and refuses a regressing generatedAt', async () => {
    const key = await devKey();
    const env = { KEPCUP_CONNECTOR_SIGNING_KEY: key.pem };
    const first = path.join(tmp(), 'v1');
    const second = path.join(tmp(), 'v2');
    const cat1 = catalogFile(tmp(), [entry('alpha'), entry('beta')]);
    const cat2 = catalogFile(tmp(), [entry('alpha', '1.1.0'), entry('gamma')]);
    await script(
      ['--out', first, '--key-id', 'dev-1', '--catalog', cat1, '--generated-at', '1790000000000'],
      env,
    );
    const signed = await script(
      [
        '--out',
        second,
        '--key-id',
        'dev-1',
        '--catalog',
        cat2,
        '--previous',
        first,
        '--generated-at',
        '1790000001000',
      ],
      env,
    );
    expect(signed.code, signed.stderr).toBe(0);
    const index = JSON.parse(readFileSync(path.join(second, 'index.json'), 'utf8'));
    expect(index.deltas).toHaveLength(1);
    const ref = index.deltas[0];
    const prev = JSON.parse(readFileSync(path.join(first, 'index.json'), 'utf8'));
    expect(ref.from).toBe(signScript.entriesHash(prev.entries));
    expect(ref.to).toBe(signScript.entriesHash(index.entries));
    expect(ref.path).toBe(`deltas/${ref.from}-${ref.to}.json`);
    const delta = JSON.parse(readFileSync(path.join(second, ref.path), 'utf8'));
    expect(delta.remove).toEqual(['test.beta/mcp']);
    expect(delta.upsert.map((e: { name: string }) => e.name).sort()).toEqual([
      'test.alpha/mcp',
      'test.gamma/mcp',
    ]);
    expect((await script(['--verify', second, '--keys', key.keysFile])).code).toBe(0);

    // A missing / tampered delta file fails verification.
    writeFileSync(path.join(second, ref.path), '{}');
    expect((await script(['--verify', second, '--keys', key.keysFile])).stderr).toContain(
      'delta sha256 mismatch',
    );

    const regress = await script(
      [
        '--out',
        tmp(),
        '--key-id',
        'dev-1',
        '--catalog',
        cat2,
        '--previous',
        first,
        '--generated-at',
        '1790000000000',
      ],
      env,
    );
    expect(regress.code).toBe(1);
    expect(regress.stderr).toContain('strictly after');
  });
});

describe('canonical form matches @kepcup/shared byte for byte', () => {
  it('stableStringify and canonicalEntriesJson agree', () => {
    const sample = [
      { name: 'b/y', z: [3, { b: 1, a: undefined, c: null }], s: 'é"\n' },
      { name: 'a/x', n: 1.5, t: true },
    ];
    expect(signScript.stableStringify(sample)).toBe(sharedStable(sample));
    expect(signScript.canonicalEntriesJson(sample)).toBe(sharedCanonical(sample));
  });
});

describe('script safety nets', () => {
  it('refuses a far-future --generated-at', async () => {
    const key = await devKey();
    const catalog = catalogFile(tmp(), [entry('alpha')]);
    const result = await script(
      [
        '--out',
        tmp(),
        '--key-id',
        'dev-1',
        '--catalog',
        catalog,
        '--generated-at',
        String(Date.now() + 5 * 86400_000),
      ],
      { KEPCUP_CONNECTOR_SIGNING_KEY: key.pem },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('in the future');
  });

  it('validation is fatal without packages/shared/dist unless --skip-validation is explicit', async () => {
    const key = await devKey();
    // A copy of the script in a layout without a built shared package.
    const fake = tmp();
    mkdirSync(path.join(fake, 'scripts'));
    const copy = path.join(fake, 'scripts', 'sign-connector-index.mjs');
    writeFileSync(copy, readFileSync(SIGN_SCRIPT_PATH));
    const catalog = catalogFile(tmp(), [entry('alpha')]);
    const env = {
      PATH: process.env['PATH'] ?? '',
      HOME: tmp(),
      KEPCUP_CONNECTOR_SIGNING_KEY: key.pem,
    };
    const args = ['--out', path.join(tmp(), 'o'), '--key-id', 'dev-1', '--catalog', catalog];
    const fatal = await run('node', [copy, ...args], { env }).then(
      () => ({ code: 0, stderr: '' }),
      (e: { code?: number; stderr?: string }) => ({ code: e.code ?? 1, stderr: e.stderr ?? '' }),
    );
    expect(fatal.code).toBe(1);
    expect(fatal.stderr).toContain('--skip-validation');
    const skipped = await run('node', [copy, ...args, '--skip-validation'], { env });
    expect(skipped.stdout).toContain('signed 1 entries');
  });

  it('the self-check honours the listed key: wrong public key or closed validity window fails', async () => {
    const key = await devKey();
    const keys = JSON.parse(readFileSync(key.keysFile, 'utf8'));
    const catalog = catalogFile(tmp(), [entry('alpha')]);
    const env = { KEPCUP_CONNECTOR_SIGNING_KEY: key.pem };
    const base = ['--key-id', 'dev-1', '--catalog', catalog];
    const withKeys = (list: unknown) => {
      const file = path.join(tmp(), 'keys.json');
      writeFileSync(file, JSON.stringify(list));
      return file;
    };
    const other = await devKey();
    const otherKeys = JSON.parse(readFileSync(other.keysFile, 'utf8'));
    const mismatch = await script(
      [
        '--out',
        tmp(),
        ...base,
        '--keys',
        withKeys([{ ...keys[0], publicKey: otherKeys[0].publicKey }]),
      ],
      env,
    );
    expect(mismatch.stderr).toContain('does not match the public key listed');
    const expired = await script(
      ['--out', tmp(), ...base, '--keys', withKeys([{ ...keys[0], validUntil: 1000 }])],
      env,
    );
    expect(expired.code).toBe(1);
    expect(expired.stderr).toContain('validity window');
    const revoked = await script(
      ['--out', tmp(), ...base, '--keys', withKeys([{ ...keys[0], revoked: true }])],
      env,
    );
    expect(revoked.stderr).toContain('revoked');
    const fine = await script(['--out', tmp(), ...base, '--keys', withKeys(keys)], env);
    expect(fine.code, fine.stderr).toBe(0);
  });
});
