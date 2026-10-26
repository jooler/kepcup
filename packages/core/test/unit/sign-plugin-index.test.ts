import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { pluginIndexEntrySchema, pluginIndexSchema } from '@kepcup/shared';
import { verifySignedIndex } from '../../src/infra/signed-index.js';
import { buildPluginFixture } from '@kepcup/testkit';

/**
 * 市场签名脚本（D104 P1-1 步骤 7）：一次性密钥 + 真实 `.kepcup` 夹具跑「签名 → 泛化
 * `verifySignedIndex` 验过 → 篡改一字节验不过」；产物条目逐条过 `pluginIndexEntrySchema`；
 * `--verify` 模式核对内容寻址包副本。
 */

const PLUGIN_LIMITS = { maxBytes: 8 * 1024 * 1024, maxSigBytes: 1024 };

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '../../../../scripts/sign-plugin-index.mjs');
interface SignScript {
  generateDevKey(dir: string, keyId?: string): { pemFile: string; keysFile: string; keyId: string };
  run(
    argv: string[],
    env?: NodeJS.ProcessEnv,
    io?: { out(message: string): void; err(message: string): void },
  ): Promise<number>;
}
const script = (await import(
  /* @vite-ignore */ pathToFileURL(scriptPath).href
)) as SignScript;

const root = mkdtempSync(path.join(tmpdir(), 'sign-plugin-index-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const GENERATED_AT = Date.parse('2026-10-10T00:00:00.000Z');

interface Artifact {
  outDir: string;
  keysFile: string;
  pem: string;
}

async function signFixture(options: {
  tier?: string;
  engines?: Record<string, string>;
  platforms?: string[];
} = {}): Promise<{ artifact: Artifact; sha256: string; id: string; version: string }> {
  const outDir = path.join(root, `out-${Math.random().toString(36).slice(2, 8)}`);
  const keyDir = path.join(root, `key-${Math.random().toString(36).slice(2, 8)}`);
  const keyId = 'sign-plugin-test';
  script.generateDevKey(keyDir, keyId);
  const pem = readFileSync(path.join(keyDir, 'dev-key.pem'), 'utf8');
  const keysFile = path.join(keyDir, 'dev-keys.json');

  const packagesDir = path.join(root, `pkg-${Math.random().toString(36).slice(2, 8)}`);
  const fixture = await buildPluginFixture({
    dir: packagesDir,
    fileName: 'demo.kepcup',
    manifest: {
      ...(options.engines !== undefined ? { engines: options.engines } : {}),
      ...(options.platforms !== undefined ? { platforms: options.platforms } : {}),
    },
    skills: [{ name: 'signed-demo' }],
  });
  const manifestShape = fixture.manifest as { id: string; version: string };
  const catalog = path.join(root, `catalog-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(
    catalog,
    JSON.stringify([
      {
        file: 'demo.kepcup',
        tier: options.tier ?? 'verified',
        summary: { name: 'Signed Demo', description: 'A signed fixture plugin', author: 'Tester' },
      },
    ]),
  );
  const exit = await script.run(
    [
      '--out',
      outDir,
      '--key-id',
      keyId,
      '--packages',
      packagesDir,
      '--catalog',
      catalog,
      '--download-base',
      'https://pkg.test',
      '--generated-at',
      String(GENERATED_AT),
      '--keys',
      keysFile,
    ],
    { KEPCUP_PLUGIN_SIGNING_KEY: pem },
    { out: () => {}, err: () => {} },
  );
  expect(exit).toBe(0);
  return {
    artifact: { outDir, keysFile, pem },
    sha256: fixture.sha256,
    id: manifestShape.id,
    version: manifestShape.version,
  };
}

function readArtifact(artifact: Artifact): { indexBytes: Buffer; sig: string; keys: unknown[] } {
  return {
    indexBytes: readFileSync(path.join(artifact.outDir, 'plugins', 'v1', 'index.json')),
    sig: readFileSync(path.join(artifact.outDir, 'plugins', 'v1', 'index.json.sig'), 'utf8'),
    keys: JSON.parse(readFileSync(artifact.keysFile, 'utf8')) as unknown[],
  };
}

describe('sign-plugin-index.mjs', () => {
  it('signs a marketplace artifact tree that the generic verifySignedIndex accepts', async () => {
    const { artifact, sha256, id, version } = await signFixture();
    const { indexBytes, sig, keys } = readArtifact(artifact);

    const verified = verifySignedIndex(indexBytes, sig, keys, pluginIndexSchema, PLUGIN_LIMITS);
    expect(verified.ok).toBe(true);
    const index = (verified as { ok: true; index: { entries: unknown[] } }).index;
    expect(index.entries).toHaveLength(1);
    // 产物条目逐条能过 pluginIndexEntrySchema。
    expect(pluginIndexEntrySchema.safeParse(index.entries[0]).success).toBe(true);
    expect(index.entries[0]).toMatchObject({
      id,
      version,
      sha256,
      tier: 'verified',
      downloadUrl: `https://pkg.test/${sha256}.kepcup`,
      categories: ['skill'],
      summary: { name: 'Signed Demo', author: 'Tester' },
    });
    expect(index.entries[0] as { updatedAt: number }).toMatchObject({ updatedAt: GENERATED_AT });
    // Content-addressed package copy with the exact bytes.
    const copy = path.join(artifact.outDir, 'packages', `${sha256}.kepcup`);
    expect(existsSync(copy)).toBe(true);
    expect(createHash('sha256').update(readFileSync(copy)).digest('hex')).toBe(sha256);
  });

  it('a one-byte tamper breaks the verification', async () => {
    const { artifact } = await signFixture();
    const { indexBytes, sig, keys } = readArtifact(artifact);
    const tampered = Buffer.from(indexBytes);
    // Flip one hex digit inside an entry's sha256: the JSON stays valid (and schema-valid),
    // so the rejection must come from the signature check itself.
    const marker = indexBytes.indexOf('"sha256":"');
    expect(marker).toBeGreaterThan(0);
    const digit = tampered[marker + '"sha256":"'.length]!;
    tampered[marker + '"sha256":"'.length] = digit === 0x61 ? 0x62 : 0x61;
    expect(
      verifySignedIndex(tampered, sig, keys, pluginIndexSchema, PLUGIN_LIMITS),
    ).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('--verify checks the index signature and the package copies', async () => {
    const { artifact, sha256 } = await signFixture();
    const quiet = { out: () => {}, err: () => {} };
    expect(await script.run(['--verify', artifact.outDir, '--keys', artifact.keysFile], {}, quiet)).toBe(0);
    // Corrupt the package copy → verify fails.
    writeFileSync(path.join(artifact.outDir, 'packages', `${sha256}.kepcup`), Buffer.from('x'));
    expect(await script.run(['--verify', artifact.outDir, '--keys', artifact.keysFile], {}, quiet)).toBe(1);
  });

  it('refuses an uncurated package', async () => {
    const outDir = path.join(root, `out-bad-${Math.random().toString(36).slice(2, 8)}`);
    const keyDir = path.join(root, `key-bad-${Math.random().toString(36).slice(2, 8)}`);
    script.generateDevKey(keyDir, 'dev-1');
    const pem = readFileSync(path.join(keyDir, 'dev-key.pem'), 'utf8');
    const keysFile = path.join(keyDir, 'dev-keys.json');
    const packagesDir = path.join(root, `pkg-bad-${Math.random().toString(36).slice(2, 8)}`);
    await buildPluginFixture({ dir: packagesDir, fileName: 'demo.kepcup', skills: [{ name: 'x' }] });
    const catalog = path.join(root, 'catalog-bad.json');
    writeFileSync(catalog, JSON.stringify([]));
    await expect(
      script.run(
        [
          '--out',
          outDir,
          '--key-id',
          'dev-1',
          '--packages',
          packagesDir,
          '--catalog',
          catalog,
          '--download-base',
          'https://pkg.test',
          '--keys',
          keysFile,
        ],
        { KEPCUP_PLUGIN_SIGNING_KEY: pem },
        { out: () => {}, err: () => {} },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('no curation entry') });
  });
});
