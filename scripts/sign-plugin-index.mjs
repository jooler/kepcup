#!/usr/bin/env node
// Builds and signs the KepCup plugin marketplace index (D104 P1-1, docs/design/51-plugin-system.md
// §6.1). Runs OFFLINE in CI; Cloudflare hosts the signed index files (infra/cloudflare/directory/
// public/plugins/v1/) and the packages go to R2 content-addressed storage.
//
//   # sign: build index.json from a packages dir (+ curation file) and sign it
//   KEPCUP_PLUGIN_SIGNING_KEY=... node scripts/sign-plugin-index.mjs \
//     --out <dir> --key-id <id> --packages <dir> --catalog <curation.json> \
//     [--revoked <revoked.json>] [--download-base https://pkg.kepcup.com] \
//     [--generated-at <iso|epoch-ms>]
//   # verify a signed marketplace artifact tree (public key list from shared, or --keys <json>)
//   node scripts/sign-plugin-index.mjs --verify <dir> [--keys <keys.json>]
//   # throwaway keypair for tests (refuses to write inside the repository tree)
//   node scripts/sign-plugin-index.mjs --generate-dev-key <dir> [--key-id <id>]
//
// Output layout:
//   <out>/plugins/v1/index.json      { version: 1, generatedAt, keyId, entries[], revoked[] }
//   <out>/plugins/v1/index.json.sig  base64 Ed25519 signature over the EXACT bytes of index.json
//   <out>/packages/{sha256}.kepcup   content-addressed package copies (upload these to R2)
//
// The private key comes ONLY from the env var KEPCUP_PLUGIN_SIGNING_KEY (PKCS8 PEM, or the
// base64 of the 32-byte raw seed). It is never read from a file in the repository and never
// printed. The production public key list is compiled into @kepcup/shared
// (PLUGIN_INDEX_PUBLIC_KEYS — empty = the marketplace is closed until the key is registered).
// The marketplace key is INDEPENDENT of the connector-directory key (do not reuse KEPCUP_CONNECTOR_SIGNING_KEY).
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const SIGNING_KEY_ENV = 'KEPCUP_PLUGIN_SIGNING_KEY';
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
// Ed25519 DER prefixes: PKCS8 (followed by the 32-byte seed) and SPKI (followed by the raw key).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Fails with a message (no stack) — exit code 1 from main(). */
export class SignError extends Error {}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// --- keys (Ed25519, independent secret from the app's other signing material) -------------

/** Private key from the env value: PKCS8 PEM, or base64 of the raw 32-byte seed. */
export function privateKeyFromEnv(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SignError(
      `${SIGNING_KEY_ENV} is not set (the signing key is read from the environment only)`,
    );
  }
  const text = value.trim();
  try {
    if (text.includes('BEGIN')) return createPrivateKey(text);
    const seed = Buffer.from(text, 'base64');
    if (seed.length !== 32) throw new Error('seed length');
    return createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    // Deliberately no detail: the message must never echo any part of the secret.
    throw new SignError(
      `${SIGNING_KEY_ENV} is not a valid Ed25519 key (PKCS8 PEM or base64 32-byte seed)`,
    );
  }
}

export function rawPublicKeyBase64(privateKey) {
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(der).subarray(SPKI_PREFIX.length).toString('base64');
}

function publicKeyObject(rawBase64) {
  const raw = Buffer.from(rawBase64, 'base64');
  if (raw.length !== 32) throw new SignError('public key must be 32 raw bytes (base64)');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

// --- optional validators through the built workspace packages ---------------------------

async function loadDist(relative) {
  const dist = path.join(repoRoot, relative);
  if (!existsSync(dist)) return null;
  return import(pathToFileURL(dist).href);
}

async function loadShared() {
  return loadDist('packages/shared/dist/index.js');
}

async function loadPackageGuard() {
  const guard = await loadDist('packages/package-guard/dist/index.js');
  if (guard === null) {
    throw new SignError(
      'packages/package-guard/dist is not built: run `pnpm --filter @kepcup/package-guard build`',
    );
  }
  return guard;
}

// --- build ------------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new SignError(
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseGeneratedAt(value) {
  if (value === undefined) return Date.now();
  const ms = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value));
  if (Number.isNaN(ms))
    throw new SignError(`--generated-at is not an ISO date or epoch ms: ${value}`);
  // Clients refuse indexes dated more than a day ahead (and would ratchet on a far-future one).
  if (ms > Date.now() + 24 * 60 * 60 * 1000) {
    throw new SignError('--generated-at is more than one day in the future');
  }
  return ms;
}

/** Contribution categories present in the manifest (skills→skill, connectors→connector, …). */
export function categoriesOf(manifest) {
  const contributions = manifest?.contributions ?? {};
  const categories = [];
  if ((contributions.skills ?? []).length > 0) categories.push('skill');
  if ((contributions.connectors ?? []).length > 0) categories.push('connector');
  if ((contributions.mcp ?? []).length > 0) categories.push('mcp');
  if ((contributions.mail ?? []).length > 0) categories.push('mail');
  return categories;
}

/**
 * One index entry per `*.kepcup` in `packagesDir`. `catalog` is the curation file
 * (`[{ file, tier, summary: { name, description, author } }]`); every package MUST be
 * curated (tier is trust metadata, never taken from the package). Package bytes are
 * verified through @kepcup/package-guard's ZipArchive and the manifest through
 * @kepcup/shared's pluginManifestSchema (when built). Returns the entries plus the
 * content-addressed package copies to make (`{ sha256, sourcePath }`).
 */
export async function collectPluginEntries({
  packagesDir,
  catalog,
  downloadBase,
  generatedAt,
  log,
}) {
  if (downloadBase === undefined) {
    throw new SignError('--download-base is required (e.g. https://pkg.kepcup.com)');
  }
  if (!downloadBase.startsWith('https://')) {
    throw new SignError('--download-base must be an https URL');
  }
  const curation = catalog !== undefined ? readJson(catalog) : undefined;
  if (!Array.isArray(curation)) {
    throw new SignError(`${catalog} is not a curation file ([{ file, tier, summary }, ...])`);
  }
  const byFile = new Map(curation.map((item) => [String(item.file), item]));
  if (byFile.size !== curation.length) {
    throw new SignError('the curation file lists the same file twice');
  }

  const guard = await loadPackageGuard();
  const shared = await loadShared();
  const files = readdirSync(packagesDir)
    .filter((name) => name.endsWith('.kepcup'))
    .sort();
  if (files.length === 0) {
    throw new SignError(`no .kepcup packages found in ${packagesDir}`);
  }
  const entries = [];
  const packages = [];
  for (const name of files) {
    const item = byFile.get(name);
    if (item === undefined) {
      throw new SignError(
        `package ${name} has no curation entry; every published package needs { file, tier, summary } in --catalog`,
      );
    }
    if (item.tier !== 'verified' && item.tier !== 'community') {
      throw new SignError(`curation entry ${name}: tier must be "verified" or "community"`);
    }
    const filePath = path.join(packagesDir, name);
    const bytes = readFileSync(filePath);
    const sha256 = sha256Hex(bytes);
    const size = bytes.length;

    // Reading through the guarded zip rejects hostile archives before anything is published.
    const zip = await guard.ZipArchive.open(filePath, {
      error: (m) => new SignError(m),
      label: name,
    });
    try {
      const manifestEntry = zip.entries.find((candidate) => candidate.name === 'plugin.json');
      if (manifestEntry === undefined) {
        throw new SignError(`${name} has no plugin.json`);
      }
      const manifest = JSON.parse((await zip.read(manifestEntry)).toString('utf8'));
      if (shared !== null) {
        const parsed = shared.pluginManifestSchema.safeParse(manifest);
        if (!parsed.success) {
          throw new SignError(
            `${name}: manifest is not a valid plugin manifest: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
          );
        }
      }
      const summary = item.summary ?? {};
      if (typeof summary.name !== 'string' || summary.name.length === 0) {
        throw new SignError(`curation entry ${name}: summary.name is required`);
      }
      const entry = {
        id: manifest.id,
        version: manifest.version,
        tier: item.tier,
        sha256,
        size,
        downloadUrl: `${downloadBase.replace(/\/+$/, '')}/${sha256}.kepcup`,
        ...(manifest.engines !== undefined ? { engines: manifest.engines } : {}),
        ...(manifest.platforms !== undefined ? { platforms: manifest.platforms } : {}),
        categories: categoriesOf(manifest),
        summary: {
          name: String(summary.name).slice(0, 100),
          description: String(summary.description ?? '').slice(0, 500),
          author:
            summary.author === null || summary.author === undefined
              ? null
              : String(summary.author).slice(0, 100),
        },
        // Deterministic builds pass --generated-at; otherwise the package mtime stands.
        updatedAt: generatedAt !== undefined ? generatedAt : Math.floor(statSync(filePath).mtimeMs),
      };
      entries.push(entry);
      packages.push({ sha256, sourcePath: filePath });
      log?.(`packaged ${name} (${manifest.id}@${manifest.version}, ${item.tier})`);
    } finally {
      await zip.close();
    }
  }
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.id}@${entry.version}`;
    if (seen.has(key)) throw new SignError(`duplicate plugin ${key} in the packages dir`);
    seen.add(key);
  }
  return { entries, packages };
}

/**
 * Builds `{ index, indexBytes }` for the entries (+ optional revoked list). Pure; exported
 * for tests. `generatedAt` is epoch ms.
 */
export function buildPluginIndexBytes({ entries, revoked, keyId, generatedAt }) {
  const index = {
    version: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    keyId,
    entries,
    ...(revoked !== undefined ? { revoked } : { revoked: [] }),
  };
  const indexBytes = Buffer.from(`${JSON.stringify(index)}\n`);
  if (indexBytes.length > MAX_INDEX_BYTES) {
    throw new SignError('index.json exceeds the 8 MiB client limit');
  }
  return { index, indexBytes };
}

/** Ed25519 signature (base64) over the exact bytes. */
export function signBytes(bytes, privateKey) {
  return cryptoSign(null, bytes, privateKey).toString('base64');
}

// --- verify -----------------------------------------------------------------------------

/**
 * Verifies `indexBytes` + signature text against a key list. Returns `{ ok, ... }`; never
 * throws on bad input. `readPackage(rel)` (optional) checks the content-addressed package
 * copies: sha256 (from the file name and bytes) and the declared size.
 */
export function verifyPluginIndexBytes(indexBytes, sigText, keys, { readFile } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  let index;
  try {
    index = JSON.parse(Buffer.from(indexBytes).toString('utf8'));
  } catch {
    return fail('index.json is not valid JSON');
  }
  if (
    !index ||
    index.version !== 1 ||
    typeof index.keyId !== 'string' ||
    !Array.isArray(index.entries) ||
    !Array.isArray(index.revoked ?? [])
  ) {
    return fail('index.json has the wrong shape');
  }
  const generatedAt =
    typeof index.generatedAt === 'number'
      ? index.generatedAt
      : Date.parse(String(index.generatedAt));
  const key = keys.find((candidate) => candidate.keyId === index.keyId);
  if (!key) return fail(`unknown keyId "${String(index.keyId).slice(0, 64)}"`);
  if (key.revoked === true) return fail(`key "${key.keyId}" is revoked`);
  if (
    generatedAt < (key.validFrom ?? 0) ||
    (key.validUntil !== undefined && generatedAt >= key.validUntil)
  ) {
    return fail(`generatedAt is outside the validity window of key "${key.keyId}"`);
  }
  const signature = Buffer.from(String(sigText).trim(), 'base64');
  if (signature.length !== 64) return fail('signature is not a 64-byte base64 value');
  let valid;
  try {
    valid = cryptoVerify(null, indexBytes, publicKeyObject(key.publicKey), signature);
  } catch {
    valid = false;
  }
  if (!valid) return fail('signature does not match index.json');
  if (readFile) {
    for (const entry of index.entries) {
      const rel = `${entry.sha256}.kepcup`;
      let bytes;
      try {
        bytes = readFile(rel);
      } catch {
        return fail(`package missing: ${rel}`);
      }
      if (sha256Hex(bytes) !== entry.sha256) return fail(`package sha256 mismatch: ${rel}`);
      if (bytes.length !== entry.size) return fail(`package size mismatch: ${rel}`);
    }
  }
  return {
    ok: true,
    keyId: index.keyId,
    generatedAt,
    entries: index.entries.length,
    revoked: (index.revoked ?? []).length,
  };
}

async function defaultKeys() {
  const shared = await loadShared();
  if (shared === null) {
    throw new SignError(
      'packages/shared/dist is not built; run `pnpm --filter @kepcup/shared build` or pass --keys',
    );
  }
  return [...shared.PLUGIN_INDEX_PUBLIC_KEYS];
}

export async function verifyMarketplace(dir, keysFile) {
  const keys = keysFile ? readJson(keysFile) : await defaultKeys();
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new SignError(
      'the public key list is empty; register the public key in PLUGIN_INDEX_PUBLIC_KEYS or pass --keys <file> to verify against a specific key',
    );
  }
  const indexBytes = readFileSync(path.join(dir, 'plugins', 'v1', 'index.json'));
  const sigText = readFileSync(path.join(dir, 'plugins', 'v1', 'index.json.sig'), 'utf8');
  return verifyPluginIndexBytes(indexBytes, sigText, keys, {
    readFile: (rel) => readFileSync(path.join(dir, 'packages', rel)),
  });
}

// --- dev key ----------------------------------------------------------------------------

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realpathLoose(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Writes a THROWAWAY keypair (tests only) to `dir`: `dev-key.pem` (0600) and `dev-keys.json`
 * (the public key list entry). Refuses a directory inside this repository.
 */
export function generateDevKey(dir, keyId = 'dev-1') {
  const target = realpathLoose(dir);
  if (isInside(target, realpathLoose(repoRoot))) {
    throw new SignError(
      'refusing to write a key inside the repository tree; pass a path outside it (e.g. a temp dir)',
    );
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const pemFile = path.join(target, 'dev-key.pem');
  writeFileSync(pemFile, pem, { mode: 0o600 });
  const keysFile = path.join(target, 'dev-keys.json');
  writeFileSync(
    keysFile,
    `${JSON.stringify([{ keyId, publicKey: rawPublicKeyBase64(privateKey), validFrom: 0, revoked: false }], null, 2)}\n`,
  );
  return { pemFile, keysFile, keyId };
}

// --- main -------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  const valued = new Set([
    '--out',
    '--packages',
    '--catalog',
    '--revoked',
    '--download-base',
    '--key-id',
    '--generated-at',
    '--verify',
    '--keys',
    '--generate-dev-key',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!valued.has(arg)) throw new SignError(`unknown argument: ${arg}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new SignError(`${arg} needs a value`);
    args[arg.slice(2)] = value;
  }
  return args;
}

export async function run(
  argv,
  env = process.env,
  io = { out: (m) => console.log(m), err: (m) => console.error(m) },
) {
  const args = parseArgs(argv);
  if (args['generate-dev-key'] !== undefined) {
    const { pemFile, keysFile, keyId } = generateDevKey(args['generate-dev-key'], args['key-id']);
    io.out(`dev keypair written (throwaway, tests only): ${pemFile}, ${keysFile} (keyId ${keyId})`);
    return 0;
  }
  if (args.verify !== undefined) {
    const result = await verifyMarketplace(args.verify, args.keys);
    if (!result.ok) {
      io.err(`VERIFY FAILED: ${result.reason}`);
      return 1;
    }
    io.out(
      `OK  keyId=${result.keyId} generatedAt=${new Date(result.generatedAt).toISOString()} entries=${result.entries} revoked=${result.revoked}`,
    );
    return 0;
  }
  if (args.out === undefined)
    throw new SignError('--out <dir> is required (or use --verify / --generate-dev-key)');
  if (args.packages === undefined) throw new SignError('--packages <dir> is required');
  if (args.catalog === undefined) throw new SignError('--catalog <json> is required');
  const keyId = args['key-id'] ?? env.KEPCUP_PLUGIN_SIGNING_KEY_ID;
  if (!keyId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId)) {
    throw new SignError(
      '--key-id <id> (or KEPCUP_PLUGIN_SIGNING_KEY_ID) is required: [A-Za-z0-9._-], max 64',
    );
  }
  const privateKey = privateKeyFromEnv(env[SIGNING_KEY_ENV]);
  const generatedAt = parseGeneratedAt(args['generated-at']);
  // An explicit --generated-at also pins the entries' updatedAt (deterministic output);
  // otherwise updatedAt comes from each package file's mtime.
  const { entries, packages } = await collectPluginEntries({
    packagesDir: args.packages,
    catalog: args.catalog,
    downloadBase: args['download-base'],
    ...(args['generated-at'] !== undefined ? { generatedAt } : {}),
    log: (message) => io.out(message),
  });
  const revoked = args.revoked !== undefined ? readJson(args.revoked) : [];
  if (!Array.isArray(revoked)) throw new SignError('--revoked is not a JSON array');
  if (sharedDistAvailable()) {
    await validateRevoked(revoked);
  }
  const { indexBytes } = buildPluginIndexBytes({ entries, revoked, keyId, generatedAt });
  const signature = signBytes(indexBytes, privateKey);
  // Self-check before anything is published: the signature must verify with the matching
  // public key. If the keyId is in the public key list (shared constants, or --keys), the
  // check uses THAT entry; otherwise clients reject the index until the key is registered.
  const derivedPublic = rawPublicKeyBase64(privateKey);
  const keyList = args.keys ? readJson(args.keys) : await defaultKeys().catch(() => []);
  const listed = keyList.find((candidate) => candidate.keyId === keyId) ?? null;
  if (listed !== null && listed.publicKey !== derivedPublic) {
    throw new SignError(`the signing key does not match the public key listed for "${keyId}"`);
  }
  if (listed === null) {
    io.out(
      `warning: keyId "${keyId}" is not in PLUGIN_INDEX_PUBLIC_KEYS; clients reject this index until it is added`,
    );
  }
  const selfCheck = verifyPluginIndexBytes(indexBytes, signature, [
    listed ?? { keyId, publicKey: derivedPublic, validFrom: 0, revoked: false },
  ]);
  if (!selfCheck.ok) throw new SignError(`self-check failed: ${selfCheck.reason}`);
  // Content-addressed package copies (upload {out}/packages/* to R2).
  for (const pkg of packages) {
    const target = path.join(args.out, 'packages', `${pkg.sha256}.kepcup`);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(pkg.sourcePath, target);
  }
  mkdirSync(path.join(args.out, 'plugins', 'v1'), { recursive: true });
  writeFileSync(path.join(args.out, 'plugins', 'v1', 'index.json'), indexBytes);
  writeFileSync(path.join(args.out, 'plugins', 'v1', 'index.json.sig'), `${signature}\n`);
  io.out(
    `signed ${entries.length} entries (+${revoked.length} revoked) (keyId=${keyId}) -> ${path.resolve(args.out)}`,
  );
  io.out(`publicKey(base64, for PLUGIN_INDEX_PUBLIC_KEYS)=${derivedPublic}`);
  return 0;
}

function sharedDistAvailable() {
  return existsSync(path.join(repoRoot, 'packages/shared/dist/index.js'));
}

async function validateRevoked(revoked) {
  const shared = await loadShared();
  for (const item of revoked) {
    const parsed = shared.pluginIndexRevokedSchema.safeParse(item);
    if (!parsed.success) {
      throw new SignError(
        `revoked entry is not valid: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
  }
}

async function main() {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof SignError ? `error: ${error.message}` : 'error: unexpected failure',
    );
    process.exitCode = 1;
  }
}

// argv[1] 与 import.meta.url 都按 realpath 比较：macOS 的临时目录在符号链接下
// （/var → /private/var），直接比较会让脚本被复制到 tmpdir 后静默不执行。
if (process.argv[1]) {
  let invoked = pathToFileURL(process.argv[1]).href;
  try {
    invoked = pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // argv[1] 不存在等：保持原路径比较。
  }
  if (import.meta.url === invoked) await main();
}
