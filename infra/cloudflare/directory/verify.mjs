#!/usr/bin/env node
// 外部验证脚本（部署后运行）：拉取线上签名目录索引并用公钥列表验签。
//   node infra/cloudflare/directory/verify.mjs [base-url] [--keys <keys.json>]
// 默认 base-url = https://dl.kepcup.com/connectors/v1；公钥列表默认取已构建的
// @kepcup/shared 的 CONNECTOR_INDEX_PUBLIC_KEYS（需先 `pnpm --filter @kepcup/shared build`），
// 也可用 --keys 指定 JSON（数组，元素同 CONNECTOR_INDEX_PUBLIC_KEYS）。
// 检查：HTTP 200、无重定向、体积上限、签名有效、密钥未吊销且在有效期内、增量文件存在且
// sha256 一致；Cache-Control 与期望不符只警告。只依赖 Node 内置模块与全局 fetch。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyIndexBytes } from '../../../scripts/sign-connector-index.mjs';

const DEFAULT_BASE = 'https://dl.kepcup.com/connectors/v1';
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const argv = process.argv.slice(2);
let base = DEFAULT_BASE;
let keysFile;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--keys') keysFile = argv[++i];
  else base = argv[i].replace(/\/+$/, '');
}

const failures = [];
const warnings = [];
const fail = (message) => failures.push(message);
const warn = (message) => warnings.push(message);

async function loadKeys() {
  if (keysFile) return JSON.parse(await readFile(keysFile, 'utf8'));
  const dist = path.join(root, 'packages/shared/dist/index.js');
  const shared = await import(pathToFileURL(dist).href).catch(() => null);
  if (!shared) {
    console.error(
      'FAIL  packages/shared/dist 未构建：先运行 `pnpm --filter @kepcup/shared build`，或用 --keys 指定公钥',
    );
    process.exit(1);
  }
  return [...shared.CONNECTOR_INDEX_PUBLIC_KEYS];
}

async function get(url) {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': 'kepcup-directory-verify/1' },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${url} 发生重定向（${response.status}）`);
  }
  if (response.status !== 200) throw new Error(`${url} 返回 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error(`${url} 超过 ${MAX_BYTES} 字节上限`);
  return { bytes, headers: response.headers };
}

const keys = await loadKeys();
if (keys.length === 0) {
  console.error('FAIL  公钥列表为空（生产列表在用户生成真实密钥前保持为空，U5）；可用 --keys 指定');
  process.exit(1);
}

let index;
let sig;
try {
  index = await get(`${base}/index.json`);
  sig = await get(`${base}/index.json.sig`);
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const indexCache = index.headers.get('cache-control') ?? '';
if (!/max-age=\d+/.test(indexCache) || /immutable/.test(indexCache)) {
  warn(`index.json 的 Cache-Control 期望 "public, max-age=300"，实际 "${indexCache}"`);
}

const deltaBodies = new Map();
const parsed = JSON.parse(index.bytes.toString('utf8'));
for (const ref of parsed.deltas ?? []) {
  try {
    const delta = await get(`${base}/${ref.path}`);
    deltaBodies.set(ref.path, delta.bytes);
    if (!/immutable/.test(delta.headers.get('cache-control') ?? '')) {
      warn(`${ref.path} 的 Cache-Control 期望含 immutable`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

const result = verifyIndexBytes(index.bytes, sig.bytes.toString('utf8'), keys, {
  readFile: (rel) => {
    const body = deltaBodies.get(rel);
    if (!body) throw new Error('missing');
    return body;
  },
});
if (!result.ok) fail(result.reason);

process.stdout.write(`base          ${base}\n`);
process.stdout.write(`cache-control ${indexCache}\n`);
if (result.ok) {
  process.stdout.write(
    `keyId         ${result.keyId}\ngeneratedAt   ${new Date(result.generatedAt).toISOString()}\nentries       ${result.entries}\ndeltas        ${result.deltas}\n`,
  );
}
for (const message of warnings) console.warn(`WARN  ${message}`);
for (const message of failures) console.error(`FAIL  ${message}`);
if (failures.length > 0) process.exit(1);
process.stdout.write('OK    线上目录索引签名有效\n');
