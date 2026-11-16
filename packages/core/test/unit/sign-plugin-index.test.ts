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
  /** 纯函数：清单 → 索引 categories（D124 P4 补 capability-model 分支）。 */
  categoriesOf(manifest: unknown): string[];
}
const script = (await import(/* @vite-ignore */ pathToFileURL(scriptPath).href)) as SignScript;

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

async function signFixture(
  options: {
    tier?: string;
    engines?: Record<string, string>;
    platforms?: string[];
    icon?: string;
    usage?: string | null;
    expectExit?: number;
  } = {},
): Promise<{ artifact: Artifact; sha256: string; id: string; version: string; errors: string[] }> {
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
      ...(options.icon !== undefined ? { icon: 'icon.svg' } : {}),
      ...(options.usage !== undefined ? { usage: options.usage } : {}),
    },
    ...(options.icon !== undefined
      ? { extraEntries: [{ name: 'icon.svg', data: options.icon }] }
      : {}),
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
  const errors: string[] = [];
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
    {
      out: () => {},
      err: (message) => {
        errors.push(message);
      },
    },
  );
  expect(exit).toBe(options.expectExit ?? 0);
  return {
    artifact: { outDir, keysFile, pem },
    sha256: fixture.sha256,
    id: manifestShape.id,
    version: manifestShape.version,
    errors,
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
    // No declared icon → null; the market card falls back to the host default icon.
    expect((index.entries[0] as { summary: { icon: unknown } }).summary.icon).toBeNull();
    // Content-addressed package copy with the exact bytes.
    const copy = path.join(artifact.outDir, 'packages', `${sha256}.kepcup`);
    expect(existsSync(copy)).toBe(true);
    expect(createHash('sha256').update(readFileSync(copy)).digest('hex')).toBe(sha256);
  });

  it('refuses to sign a package whose manifest has no usage (activation instructions)', async () => {
    await expect(signFixture({ usage: null })).rejects.toThrow(/usage/);
  });

  it('embeds the declared package icon into the signed index', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>';
    const { artifact } = await signFixture({ icon: svg });
    const { indexBytes, sig, keys } = readArtifact(artifact);
    const verified = verifySignedIndex(indexBytes, sig, keys, pluginIndexSchema, PLUGIN_LIMITS);
    expect(verified.ok).toBe(true);
    const index = (verified as { ok: true; index: { entries: unknown[] } }).index;
    expect((index.entries[0] as { summary: { icon: string } }).summary.icon).toBe(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    );
  });

  it('derives the capability-model category and summary for D124 data plugins', async () => {
    // `categoriesOf` 单测（脚本纯函数）+ 端到端：能力模型包的索引条目带
    // categories ['capability-model'] 与「N 个模型」概述（D124 P4 市场条目）。
    expect(script.categoriesOf({ contributions: { capabilityModels: [{ id: 'x' }] } })).toEqual([
      'capability-model',
    ]);
    expect(script.categoriesOf({ contributions: {} })).toEqual([]);

    const outDir = path.join(root, `out-cm-${Math.random().toString(36).slice(2, 8)}`);
    const keyDir = path.join(root, `key-cm-${Math.random().toString(36).slice(2, 8)}`);
    script.generateDevKey(keyDir, 'cm-test');
    const pem = readFileSync(path.join(keyDir, 'dev-key.pem'), 'utf8');
    const keysFile = path.join(keyDir, 'dev-keys.json');
    const packagesDir = path.join(root, `pkg-cm-${Math.random().toString(36).slice(2, 8)}`);
    const fixture = await buildPluginFixture({
      dir: packagesDir,
      fileName: 'bailian.kepcup',
      manifest: {
        engines: { kepcup: '>=0.5.14' },
        instances: ['capability-model'],
        contributions: {
          capabilityModels: [
            {
              id: 'qwen-image',
              capability: 'image',
              model: 'qwen-image',
              engine: 'dashscope',
              displayName: 'Qwen-Image 图片生成',
            },
          ],
        },
      },
    });
    const catalog = path.join(root, `catalog-cm-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(
      catalog,
      JSON.stringify([
        {
          file: 'bailian.kepcup',
          tier: 'verified',
          summary: { name: '阿里云百炼', description: '官方模型条目包', author: 'KepCup' },
        },
      ]),
    );
    const exit = await script.run(
      [
        '--out',
        outDir,
        '--key-id',
        'cm-test',
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
    const indexBytes = readFileSync(path.join(outDir, 'plugins', 'v1', 'index.json'));
    const verified = verifySignedIndex(
      indexBytes,
      readFileSync(path.join(outDir, 'plugins', 'v1', 'index.json.sig'), 'utf8'),
      JSON.parse(readFileSync(keysFile, 'utf8')) as unknown[],
      pluginIndexSchema,
      PLUGIN_LIMITS,
    );
    expect(verified.ok).toBe(true);
    const index = (verified as { ok: true; index: { entries: unknown[] } }).index;
    expect(index.entries).toHaveLength(1);
    expect(pluginIndexEntrySchema.safeParse(index.entries[0]).success).toBe(true);
    expect(index.entries[0]).toMatchObject({
      id: fixture.manifest.id,
      tier: 'verified',
      engines: { kepcup: '>=0.5.14' },
      categories: ['capability-model'],
      capabilitySummary: '提供 1 个模型；可添加多个厂商账号',
    });
    void fixture.sha256;
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
    expect(verifySignedIndex(tampered, sig, keys, pluginIndexSchema, PLUGIN_LIMITS)).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('--verify checks the index signature and the package copies', async () => {
    const { artifact, sha256 } = await signFixture();
    const quiet = { out: () => {}, err: () => {} };
    expect(
      await script.run(['--verify', artifact.outDir, '--keys', artifact.keysFile], {}, quiet),
    ).toBe(0);
    // Corrupt the package copy → verify fails.
    writeFileSync(path.join(artifact.outDir, 'packages', `${sha256}.kepcup`), Buffer.from('x'));
    expect(
      await script.run(['--verify', artifact.outDir, '--keys', artifact.keysFile], {}, quiet),
    ).toBe(1);
  });

  it('refuses an uncurated package', async () => {
    const outDir = path.join(root, `out-bad-${Math.random().toString(36).slice(2, 8)}`);
    const keyDir = path.join(root, `key-bad-${Math.random().toString(36).slice(2, 8)}`);
    script.generateDevKey(keyDir, 'dev-1');
    const pem = readFileSync(path.join(keyDir, 'dev-key.pem'), 'utf8');
    const keysFile = path.join(keyDir, 'dev-keys.json');
    const packagesDir = path.join(root, `pkg-bad-${Math.random().toString(36).slice(2, 8)}`);
    await buildPluginFixture({
      dir: packagesDir,
      fileName: 'demo.kepcup',
      skills: [{ name: 'x' }],
    });
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

/**
 * D125 P4：执行型包在签名前跑静态扫描——通过 / warn 的包把结果写进索引条目
 * `runtimeScan`，违规包直接拒签（fail 不出包）。
 */
describe('sign-plugin-index.mjs · runtime 静态扫描钩子（D125 P4）', () => {
  const runtimeManifest = {
    instances: ['capability-model'],
    engines: { kepcup: '>=0.5.14' },
    runtime: {
      entry: 'dist/main.js',
      hostApi: '^1',
      network: { allow: ['api.example.com'] },
    },
    contributions: {
      capabilityModels: [{ id: 'img', capability: 'image', model: 'm' }],
    },
  };

  async function signRuntimeFixture(
    code: string,
    extraEntries: Array<{ name: string; data?: string; mode?: number; symlink?: boolean }> = [],
    manifest: typeof runtimeManifest = runtimeManifest,
    tier: 'verified' | 'community' = 'verified',
  ): Promise<{ exit: number; errors: string[]; out: string[]; outDir: string; keysFile: string }> {
    const outDir = path.join(root, `out-rt-${Math.random().toString(36).slice(2, 8)}`);
    const keyDir = path.join(root, `key-rt-${Math.random().toString(36).slice(2, 8)}`);
    script.generateDevKey(keyDir, 'rt-test');
    const pem = readFileSync(path.join(keyDir, 'dev-key.pem'), 'utf8');
    const keysFile = path.join(keyDir, 'dev-keys.json');
    const packagesDir = path.join(root, `pkg-rt-${Math.random().toString(36).slice(2, 8)}`);
    await buildPluginFixture({
      dir: packagesDir,
      fileName: 'runtime.kepcup',
      manifest,
      extraEntries: [
        { name: 'dist/main.js', data: code },
        { name: 'package.json', data: '{"type":"module"}' },
        ...extraEntries,
      ],
    });
    const catalog = path.join(root, `catalog-rt-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(
      catalog,
      JSON.stringify([
        {
          file: 'runtime.kepcup',
          tier,
          summary: { name: 'Runtime Fixture', description: 'runtime scan fixture', author: 'T' },
        },
      ]),
    );
    const errors: string[] = [];
    const out: string[] = [];
    let exit: number;
    try {
      exit = await script.run(
        [
          '--out',
          outDir,
          '--key-id',
          'rt-test',
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
        { out: (message) => out.push(message), err: (message) => errors.push(message) },
      );
    } catch (error) {
      // `run()` throws SignError (the CLI wrapper turns it into exit 1): capture it as the
      // failure evidence the real signing job prints.
      errors.push(error instanceof Error ? error.message : String(error));
      exit = 1;
    }
    return { exit, errors, out, outDir, keysFile };
  }

  it('passes a clean executable package and records runtimeScan in the index entry', async () => {
    const run = await signRuntimeFixture("await fetch('https://api.example.com/v1');");
    expect(run.exit).toBe(0);
    const index = JSON.parse(
      readFileSync(path.join(run.outDir, 'plugins', 'v1', 'index.json'), 'utf8'),
    ) as { entries: Array<Record<string, unknown>> };
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({
      categories: ['capability-model'],
      runtimeScan: { status: 'pass', errors: [], warnings: [] },
    });
    expect(pluginIndexEntrySchema.safeParse(index.entries[0]).success).toBe(true);
  });

  it('records warn (unknown host) but still signs — manual review is the release gate', async () => {
    const run = await signRuntimeFixture(
      "await fetch('https://api.example.com'); await fetch('https://unknown.example.net');",
    );
    expect(run.exit).toBe(0);
    const index = JSON.parse(
      readFileSync(path.join(run.outDir, 'plugins', 'v1', 'index.json'), 'utf8'),
    ) as { entries: Array<{ runtimeScan?: { status: string; warnings: string[] } }> };
    expect(index.entries[0]?.runtimeScan?.status).toBe('warn');
    expect(index.entries[0]?.runtimeScan?.warnings.join(' ')).toContain('unknown.example.net');
  });

  it('refuses to sign a community-tier executable package（客户端必拒装，别发布装不上的版本）', async () => {
    const run = await signRuntimeFixture(
      "await fetch('https://api.example.com/v1');",
      [],
      undefined,
      'community',
    );
    expect(run.exit).toBe(1);
    expect(run.errors.join(' ')).toContain('tier "verified"');
  });

  it('refuses to sign a package whose code fails the scan (eval / native)', async () => {
    const evaled = await signRuntimeFixture('eval("1")');
    expect(evaled.exit).toBe(1);
    expect(evaled.errors.join(' ')).toMatch(/static scan failed/);
    expect(existsSync(path.join(evaled.outDir, 'plugins', 'v1', 'index.json'))).toBe(false);

    const native = await signRuntimeFixture('globalThis.ok = 1;', [
      { name: 'lib/native.node', data: 'x' },
    ]);
    expect(native.exit).toBe(1);
    expect(native.errors.join(' ')).toMatch(/native/);
  });

  it('scans the declared entry even when it has no JS extension', async () => {
    const extensionless = await signRuntimeFixture(
      'globalThis.unused = 1;',
      [{ name: 'main', data: 'eval("1")' }],
      {
        ...runtimeManifest,
        runtime: { ...runtimeManifest.runtime, entry: 'main' },
      },
    );
    expect(extensionless.exit).toBe(1);
    expect(extensionless.errors.join(' ')).toMatch(/static scan failed/);
  });

  it('refuses executable-bit and symlink entries before publish', async () => {
    const executable = await signRuntimeFixture('globalThis.ok = 1;', [
      { name: 'bin/run', data: '#!/bin/sh', mode: 0o755 },
    ]);
    expect(executable.exit).toBe(1);
    const symlink = await signRuntimeFixture('globalThis.ok = 1;', [
      { name: 'dist/link', data: '/etc/passwd', symlink: true },
    ]);
    expect(symlink.exit).toBe(1);
    expect(symlink.errors.join(' ')).toMatch(/符号链接/);
  });
});
