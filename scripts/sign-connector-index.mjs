#!/usr/bin/env node
// Builds and signs the KepCup connector directory index (D73 P3 §7.1,
// docs/design/29-connected-apps.md §11.4 / §15.2). Runs OFFLINE in CI; Cloudflare only hosts
// the signed files (infra/cloudflare/directory/).
//
//   # sign: build index.json (+ deltas) from the bundled catalog and sign it
//   KEPCUP_CONNECTOR_SIGNING_KEY=... node scripts/sign-connector-index.mjs \
//     --out <dir> --key-id <id> [--catalog <catalog.json>] [--extra-dir <dir>] \
//     [--previous <dir>] [--generated-at <iso|epoch-ms>]
//   # verify a signed directory (public key list from shared, or --keys <json>)
//   node scripts/sign-connector-index.mjs --verify <dir> [--keys <keys.json>]
//   # throwaway keypair for tests (refuses to write inside the repository tree)
//   node scripts/sign-connector-index.mjs --generate-dev-key <dir> [--key-id <id>]
//
// Output layout (what `dl.kepcup.com/connectors/v1/` serves):
//   index.json               { version: 1, generatedAt, keyId, entries: server.json[], deltas? }
//   index.json.sig           base64 Ed25519 signature over the EXACT bytes of index.json
//   deltas/{from}-{to}.json  content-addressed, immutable; from/to = sha256 of the canonical
//                            (name-sorted, key-sorted) entry set
//
// The private key comes ONLY from the env var KEPCUP_CONNECTOR_SIGNING_KEY (PKCS8 PEM, or the
// base64 of the 32-byte raw seed). It is never read from a file in the repository and never
// printed. The production public key list is compiled into @kepcup/shared
// (CONNECTOR_INDEX_PUBLIC_KEYS) and is EMPTY until the real key exists (user action U5).
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const DEFAULT_CATALOG = path.join(repoRoot, 'apps/desktop/resources/connectors/catalog.json');
const SIGNING_KEY_ENV = 'KEPCUP_CONNECTOR_SIGNING_KEY';
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_DELTA_CHAIN = 8;
// Ed25519 DER prefixes: PKCS8 (followed by the 32-byte seed) and SPKI (followed by the raw key).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Fails with a message (no stack) — exit code 1 from main(). */
export class SignError extends Error {}

// --- canonical form (must match shared `stableStringify` / `canonicalEntriesJson`) ------

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(value[key])}`);
  }
  return `{${parts.join(',')}}`;
}

const nameOf = (entry) => (entry && typeof entry.name === 'string' ? entry.name : '');

export function canonicalEntriesJson(entries) {
  const sorted = [...entries].sort((a, b) =>
    nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0,
  );
  return stableStringify(sorted);
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const entriesHash = (entries) => sha256Hex(canonicalEntriesJson(entries));

// --- keys -----------------------------------------------------------------------------

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

// --- build ----------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new SignError(
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Optional strict schema check through the built @kepcup/shared (skipped, with a note, if unbuilt). */
async function loadShared() {
  const dist = path.join(repoRoot, 'packages/shared/dist/index.js');
  if (!existsSync(dist)) return null;
  return import(pathToFileURL(dist).href);
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

/** Entries from the catalog file plus every `*.json` (object or array) in `extraDir`. */
export function collectEntries({ catalog = DEFAULT_CATALOG, extraDir } = {}) {
  const file = readJson(catalog);
  if (!file || file.version !== 1 || !Array.isArray(file.connectors)) {
    throw new SignError(`${catalog} is not a catalog file ({ version: 1, connectors: [...] })`);
  }
  const entries = [...file.connectors];
  if (extraDir) {
    for (const name of readdirSync(extraDir)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      const parsed = readJson(path.join(extraDir, name));
      entries.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
  }
  const seen = new Set();
  for (const entry of entries) {
    const name = nameOf(entry);
    if (name === '') throw new SignError('an entry has no "name"');
    if (seen.has(name)) throw new SignError(`duplicate entry name: ${name}`);
    seen.add(name);
  }
  return entries;
}

async function validateEntries(entries, log, { skip = false } = {}) {
  const shared = await loadShared();
  if (shared === null) {
    // Fatal by default: a CI run must never publish entries nobody validated.
    if (!skip) {
      throw new SignError(
        'packages/shared/dist is not built, so entries cannot be validated: run `pnpm --filter @kepcup/shared build` (or pass --skip-validation for local dev only)',
      );
    }
    log('warning: --skip-validation: entries were only checked structurally');
    return;
  }
  for (const entry of entries) {
    const parsed = shared.connectorCatalogEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new SignError(
        `entry ${nameOf(entry)} is not a valid catalog entry: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
  }
}

function readPrevious(dir) {
  const file = path.join(dir, 'index.json');
  if (!existsSync(file)) throw new SignError(`--previous: ${file} does not exist`);
  const bytes = readFileSync(file);
  const index = JSON.parse(bytes.toString('utf8'));
  return {
    dir,
    bytes,
    index,
    generatedAt: toMs(index.generatedAt),
    hash: entriesHash(index.entries ?? []),
  };
}

function toMs(value) {
  if (typeof value === 'number') return value;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Builds `{ indexBytes, files }` for the entries. `files` = the delta files to write
 * (relative path -> bytes). Pure apart from reading `previous` delta files.
 */
export function buildIndex({ entries, keyId, generatedAt, previous }) {
  const index = { version: 1, generatedAt: new Date(generatedAt).toISOString(), keyId, entries };
  const files = new Map();
  const to = entriesHash(entries);
  const deltas = [];
  if (previous) {
    if (generatedAt <= previous.generatedAt) {
      throw new SignError(
        `generatedAt (${new Date(generatedAt).toISOString()}) must be strictly after the previous index (${new Date(previous.generatedAt).toISOString()}); clients reject rollbacks`,
      );
    }
    const prevEntries = previous.index.entries ?? [];
    const prevByName = new Map(prevEntries.map((entry) => [nameOf(entry), entry]));
    const nextNames = new Set(entries.map(nameOf));
    if (previous.hash !== to) {
      const upsert = entries.filter((entry) => {
        const old = prevByName.get(nameOf(entry));
        return old === undefined || stableStringify(old) !== stableStringify(entry);
      });
      const remove = [...prevByName.keys()].filter((name) => !nextNames.has(name)).sort();
      const delta = { version: 1, from: previous.hash, to, upsert, remove };
      const bytes = Buffer.from(`${JSON.stringify(delta)}\n`);
      const rel = `deltas/${previous.hash}-${to}.json`;
      files.set(rel, bytes);
      deltas.push({ from: previous.hash, to, path: rel, sha256: sha256Hex(bytes) });
    }
    // Carry earlier steps over (their files are immutable) as long as the chain stays short.
    for (const ref of previous.index.deltas ?? []) {
      if (deltas.length >= MAX_DELTA_CHAIN) break;
      const source = path.join(previous.dir, ref.path);
      if (!existsSync(source)) continue;
      const bytes = readFileSync(source);
      if (sha256Hex(bytes) !== ref.sha256) continue;
      files.set(ref.path, bytes);
      deltas.push(ref);
    }
  }
  if (deltas.length > 0) index.deltas = deltas;
  const indexBytes = Buffer.from(`${JSON.stringify(index)}\n`);
  if (indexBytes.length > MAX_INDEX_BYTES)
    throw new SignError('index.json exceeds the 4 MiB client limit');
  return { index, indexBytes, files };
}

/** Ed25519 signature (base64) over the exact bytes. */
export function signBytes(bytes, privateKey) {
  return cryptoSign(null, bytes, privateKey).toString('base64');
}

// --- verify ---------------------------------------------------------------------------

/**
 * Verifies `indexBytes` + signature text against a key list. Returns `{ ok, ... }`; never throws
 * on bad input. `readFile(rel)` (optional) is used to check the listed delta files.
 */
export function verifyIndexBytes(indexBytes, sigText, keys, { readFile } = {}) {
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
    !Array.isArray(index.entries)
  ) {
    return fail('index.json has the wrong shape');
  }
  const generatedAt = toMs(index.generatedAt);
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
  if (readFile && Array.isArray(index.deltas)) {
    const to = entriesHash(index.entries);
    for (const ref of index.deltas) {
      if (ref.path !== `deltas/${ref.from}-${ref.to}.json`)
        return fail(`delta path mismatch: ${ref.path}`);
      let bytes;
      try {
        bytes = readFile(ref.path);
      } catch {
        return fail(`delta file missing: ${ref.path}`);
      }
      if (sha256Hex(bytes) !== ref.sha256) return fail(`delta sha256 mismatch: ${ref.path}`);
    }
    if (index.deltas.length > 0 && index.deltas[0].to !== to) {
      return fail('the newest delta does not end at the current entry set');
    }
  }
  return {
    ok: true,
    keyId: index.keyId,
    generatedAt,
    entries: index.entries.length,
    entriesHash: entriesHash(index.entries),
    deltas: (index.deltas ?? []).length,
  };
}

async function defaultKeys() {
  const shared = await loadShared();
  if (shared === null) {
    throw new SignError(
      'packages/shared/dist is not built; run `pnpm --filter @kepcup/shared build` or pass --keys',
    );
  }
  return [...shared.CONNECTOR_INDEX_PUBLIC_KEYS];
}

export async function verifyDirectory(dir, keysFile) {
  const keys = keysFile ? readJson(keysFile) : await defaultKeys();
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new SignError(
      'the public key list is empty (the production list stays empty until the real key exists, U5); pass --keys <file> to verify against a specific key',
    );
  }
  const indexBytes = readFileSync(path.join(dir, 'index.json'));
  const sigText = readFileSync(path.join(dir, 'index.json.sig'), 'utf8');
  return verifyIndexBytes(indexBytes, sigText, keys, {
    readFile: (rel) => readFileSync(path.join(dir, rel)),
  });
}

// --- dev key --------------------------------------------------------------------------

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

// --- main -----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  const valued = new Set([
    '--out',
    '--catalog',
    '--extra-dir',
    '--previous',
    '--key-id',
    '--generated-at',
    '--verify',
    '--keys',
    '--generate-dev-key',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-validation') {
      args['skip-validation'] = true;
      continue;
    }
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
    const result = await verifyDirectory(args.verify, args.keys);
    if (!result.ok) {
      io.err(`VERIFY FAILED: ${result.reason}`);
      return 1;
    }
    io.out(
      `OK  keyId=${result.keyId} generatedAt=${new Date(result.generatedAt).toISOString()} entries=${result.entries} deltas=${result.deltas} entriesHash=${result.entriesHash}`,
    );
    return 0;
  }
  if (args.out === undefined)
    throw new SignError('--out <dir> is required (or use --verify / --generate-dev-key)');
  const keyId = args['key-id'] ?? env.KEPCUP_CONNECTOR_SIGNING_KEY_ID;
  if (!keyId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId)) {
    throw new SignError(
      '--key-id <id> (or KEPCUP_CONNECTOR_SIGNING_KEY_ID) is required: [A-Za-z0-9._-], max 64',
    );
  }
  const privateKey = privateKeyFromEnv(env[SIGNING_KEY_ENV]);
  const entries = collectEntries({ catalog: args.catalog, extraDir: args['extra-dir'] });
  await validateEntries(entries, (message) => io.out(message), {
    skip: args['skip-validation'] === true,
  });
  const previous = args.previous ? readPrevious(args.previous) : undefined;
  const { indexBytes, files } = buildIndex({
    entries,
    keyId,
    generatedAt: parseGeneratedAt(args['generated-at']),
    previous,
  });
  const signature = signBytes(indexBytes, privateKey);
  // Self-check before anything is published: the signature must verify with the matching public key.
  // If the keyId is in the public key list (shared constants, or --keys), the check uses THAT
  // entry: its public key must match the signing key, and generatedAt must fall inside its
  // validity window / it must not be revoked. Otherwise clients would reject the index.
  const derivedPublic = rawPublicKeyBase64(privateKey);
  const keyList = args.keys ? readJson(args.keys) : await defaultKeys().catch(() => []);
  const listed = keyList.find((candidate) => candidate.keyId === keyId) ?? null;
  if (listed !== null && listed.publicKey !== derivedPublic) {
    throw new SignError(`the signing key does not match the public key listed for "${keyId}"`);
  }
  if (listed === null) {
    io.out(
      `warning: keyId "${keyId}" is not in the public key list; clients reject this index until it is added`,
    );
  }
  const selfCheck = verifyIndexBytes(indexBytes, signature, [
    listed ?? { keyId, publicKey: derivedPublic, validFrom: 0, revoked: false },
  ]);
  if (!selfCheck.ok) throw new SignError(`self-check failed: ${selfCheck.reason}`);
  mkdirSync(path.join(args.out, 'deltas'), { recursive: true });
  writeFileSync(path.join(args.out, 'index.json'), indexBytes);
  writeFileSync(path.join(args.out, 'index.json.sig'), `${signature}\n`);
  for (const [rel, bytes] of files) writeFileSync(path.join(args.out, rel), bytes);
  io.out(
    `signed ${entries.length} entries (keyId=${keyId}, entriesHash=${selfCheck.entriesHash}, deltas=${files.size}) -> ${path.resolve(args.out)}`,
  );
  io.out(`publicKey(base64, for CONNECTOR_INDEX_PUBLIC_KEYS)=${rawPublicKeyBase64(privateKey)}`);
  return 0;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
