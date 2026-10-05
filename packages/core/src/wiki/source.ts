import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError, WIKI_SOURCE_MAX_BYTES } from '@kepcup/shared';

import { canonicalPath, type AppPaths } from '../infra/paths.js';
import { shQuote } from '../infra/shell.js';
import { buildSandboxPolicy } from '../sandbox/policy.js';
import { isInsidePath } from '../sandbox/sensitive-paths.js';
import type { SandboxBackend, SandboxNetworkPolicy } from '../sandbox/types.js';
import type { CoreLogger } from '../infra/logger.js';

/**
 * Ingest source preparation (任务 3): content hashing, dated + hashed raw
 * file naming, same-hash dedupe and the sandboxed URL fetch. The naming and
 * policy helpers are pure so unit tests cover them without any IO.
 */

/** Length of the content-hash segment embedded in raw file names. */
export const RAW_HASH_CHARS = 12;
/** `YYYYMMDD-{hash12}-{name}` — the hash sits at the fixed offset 9..21. */
export const RAW_HASH_OFFSET = 9;

export function shortHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, RAW_HASH_CHARS);
}

/** `2026-10-01` → `20261001`. */
export function localDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

/** Strips path separators / control chars from a source file name. */
export function sanitizeSourceName(name: string): string {
  const cleaned = path
    .basename(name)
    .replaceAll(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._]+/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'source';
}

export function rawFileName(date: Date, hash12: string, name: string): string {
  return `${localDateStamp(date)}-${hash12}-${sanitizeSourceName(name)}`;
}

/** The embedded hash segment of a raw file name, or null for foreign names. */
export function hashSuffixOf(fileName: string): string | null {
  if (fileName.length <= RAW_HASH_OFFSET + RAW_HASH_CHARS + 1) return null;
  if (fileName[RAW_HASH_OFFSET + RAW_HASH_CHARS] !== '-') return null;
  const hash = fileName.slice(RAW_HASH_OFFSET, RAW_HASH_OFFSET + RAW_HASH_CHARS);
  return /^[0-9a-f]{12}$/.test(hash) ? hash : null;
}

/** Finds an existing raw file carrying the same content hash (dedupe). */
export function findRawByHash(rawDir: string, hash12: string): string | null {
  let names: string[];
  try {
    names = readdirSync(rawDir);
  } catch {
    return null;
  }
  return names.find((name) => hashSuffixOf(name) === hash12) ?? null;
}

// --- URL sources -------------------------------------------------------------

export function isLoopbackHost(host: string): boolean {
  const lowered = host.toLowerCase();
  return lowered === 'localhost' || lowered.endsWith('.localhost') || lowered === '::1' || lowered.startsWith('127.');
}

/**
 * Network-policy adjudication for one URL fetch (任务 3: "受网络策略约束").
 * The bot's Profile policy gates the target host; the sandbox policy is then
 * the least-privilege intersection (allowlist with exactly this host, loopback
 * only for loopback targets — the sandbox denies loopback otherwise, exactly
 * like project-bound conversations).
 */
export function fetchPolicyFor(
  url: string,
  botNetwork: SandboxNetworkPolicy,
): { ok: true; host: string; policy: SandboxNetworkPolicy } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'URL 无法解析' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `URL 协议必须是 http/https（收到 ${parsed.protocol}）` };
  }
  const host = parsed.hostname.toLowerCase();
  if (botNetwork.mode === 'none') {
    return { ok: false, reason: '该 Bot 的网络策略为禁止联网，无法抓取网页' };
  }
  if (botNetwork.mode === 'allowlist') {
    const allowed = botNetwork.allowDomains.some(
      (domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`),
    );
    if (!allowed) {
      return {
        ok: false,
        reason: `目标主机 ${host} 不在该 Bot 的网络允许名单中，无法抓取`,
      };
    }
  }
  return {
    ok: true,
    host,
    policy: {
      mode: 'allowlist',
      allowDomains: [host],
      allowLocalhost: isLoopbackHost(host),
    },
  };
}

const FETCH_TIMEOUT_MS = 60_000;
const CURL_MAX_TIME_SECONDS = 45;

/**
 * Fetches one URL inside the sandbox with `curl` (fail-closed: no sandbox, no
 * fetch). The body returns via stdout; the core process owns writing raw/.
 *
 * Size and binary handling (BR-P09-006): `--max-filesize` aborts mid-transfer
 * even when the response has no Content-Length (verified against a local
 * chunked server — curl exits 63 at the limit), so the buffered body is
 * bounded by WIKI_SOURCE_MAX_BYTES. Wiki material is textual: the returned
 * text must round-trip as UTF-8 without NUL or replacement characters —
 * binary payloads and non-UTF-8 text are explicitly rejected instead of
 * being silently corrupted by the utf8 stdout transport (documented
 * difference vs byte-lossless transport; byte-lossless return would need a
 * platform-specific base64 channel inside the sandbox).
 */
export async function fetchUrlInSandbox(input: {
  sandbox: SandboxBackend;
  paths: AppPaths;
  url: string;
  botNetwork: SandboxNetworkPolicy;
  logger: CoreLogger;
}): Promise<Buffer> {
  const verdict = fetchPolicyFor(input.url, input.botNetwork);
  if (!verdict.ok) throw new AppError('INVALID_INPUT', verdict.reason);

  const availability = await input.sandbox.probe();
  if (!availability.available) {
    // Fail-closed (design/13): fetching never happens outside the sandbox.
    throw new AppError(
      'SANDBOX_UNAVAILABLE',
      `沙箱不可用（${availability.reason ?? '未知原因'}），无法安全抓取网页`,
    );
  }
  // The temp directory is the probe's cwd precedent: srt redirects it to a
  // sandbox-private writable location, so no data-directory re-exposure needed.
  const cwd = canonicalPath(os.tmpdir());
  const policy = buildSandboxPolicy({
    platform: process.platform,
    paths: input.paths,
    workspacePath: cwd,
    network: verdict.policy,
  });
  const command = `curl -fsSL --max-time ${CURL_MAX_TIME_SECONDS} --max-filesize ${WIKI_SOURCE_MAX_BYTES} ${shQuote(input.url)}`;
  const result = await input.sandbox.exec({
    command,
    cwd,
    policy,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].filter((s) => s.length > 0).join('\n').trim();
    throw new AppError(
      'INVALID_INPUT',
      `网页抓取失败（curl 退出码 ${result.exitCode ?? 'unknown'}）：${detail.slice(0, 300) || '无输出'}`,
    );
  }
  const reason = fetchableTextVerdict(result.stdout);
  if (reason !== null) {
    throw new AppError('INVALID_INPUT', reason);
  }
  const body = Buffer.from(result.stdout, 'utf8');
  if (body.length === 0) {
    throw new AppError('INVALID_INPUT', '网页抓取结果为空');
  }
  if (body.length > WIKI_SOURCE_MAX_BYTES) {
    throw new AppError('INVALID_INPUT', '网页内容超过大小上限，已放弃入库');
  }
  input.logger.info({ host: verdict.host, bytes: body.length }, 'wiki URL fetched in sandbox');
  return body;
}

/**
 * Pure verdict for fetched text: null when the content is storable wiki
 * material, otherwise the rejection reason (BR-P09-006). NUL bytes mean
 * binary; U+FFFD means the byte stream was not valid UTF-8 (the sandbox
 * transport decodes stdout as UTF-8, so non-UTF-8 text would be corrupted).
 */
export function fetchableTextVerdict(text: string): string | null {
  if (text.length === 0) return '网页抓取结果为空';
  if (text.includes('\u0000')) return '网页内容是二进制数据，不支持入库';
  if (text.includes('\uFFFD')) return '网页内容不是 UTF-8 文本，无法无损入库，已拒绝';
  return null;
}

/** Sanity re-check used by the file source path: must be inside `root`. */
export function isInsideRoot(target: string, root: string): boolean {
  return isInsidePath(canonicalPath(target), canonicalPath(root));
}
