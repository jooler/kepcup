#!/usr/bin/env node
// 外部验证脚本（用户待办 U1，部署后运行）：对线上 CIMD 地址做授权服务器视角的检查。
//   node infra/cloudflare/oauth-cimd/verify.mjs [url]
// 检查：HTTP 200、Content-Type 为 application/json、无重定向、体积 ≤5 KB、
// client_id 与 URL 逐字相等、内容与仓库文件一致；Cache-Control / CORS 头缺失只警告。
// 只依赖 Node 内置模块与全局 fetch（Node 18+）。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'https://kepcup.com/oauth/client.json';
const MAX_BYTES = 5 * 1024;
const TIMEOUT_MS = 10_000;
const repoFile = fileURLToPath(new URL('./public/oauth/client.json', import.meta.url));

const url = process.argv[2] ?? DEFAULT_URL;
const failures = [];
const warnings = [];
const fail = (message) => failures.push(message);
const warn = (message) => warnings.push(message);

const local = await readFile(repoFile, 'utf8');
const localDoc = JSON.parse(local);

let response;
try {
  response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // 模拟授权服务器的服务端抓取：不带浏览器 UA / cookie。
    headers: { accept: 'application/json', 'user-agent': 'kepcup-cimd-verify/1' },
  });
} catch (error) {
  console.error(`FAIL  无法获取 ${url}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (response.status >= 300 && response.status < 400) {
  fail(
    `发生重定向（${response.status} → ${response.headers.get('location') ?? '?'}）：CIMD 不得重定向`,
  );
} else if (response.status !== 200) {
  fail(`HTTP 状态应为 200，实际 ${response.status}`);
}
if (response.headers.get('cf-mitigated') !== null) {
  fail(
    `被 Cloudflare 防护拦截（cf-mitigated: ${response.headers.get('cf-mitigated')}）：见 README 的 Bot Fight Mode 一节`,
  );
}

const contentType = response.headers.get('content-type') ?? '';
if (!/^application\/json\b/i.test(contentType)) {
  fail(`Content-Type 应为 application/json，实际 "${contentType}"`);
}
const cacheControl = response.headers.get('cache-control') ?? '';
if (!/max-age=\d+/.test(cacheControl) || !/\bpublic\b/.test(cacheControl)) {
  warn(`Cache-Control 期望 "public, max-age=86400"，实际 "${cacheControl}"`);
}
if (response.headers.get('access-control-allow-origin') !== '*') {
  warn('缺少 Access-Control-Allow-Origin: *');
}

const body = await response.text();
const size = Buffer.byteLength(body, 'utf8');
if (size > MAX_BYTES) fail(`文档 ${size} 字节，超过 5 KB 上限`);

let remoteDoc = null;
try {
  remoteDoc = JSON.parse(body);
} catch {
  fail('响应体不是合法 JSON');
}
if (remoteDoc !== null) {
  if (remoteDoc.client_id !== url) fail(`client_id（${remoteDoc.client_id}）与请求 URL 不逐字相等`);
  if (body !== local) {
    // 字节级不同但 JSON 等价（例如换行风格）只警告；内容不同才失败。
    if (JSON.stringify(remoteDoc) === JSON.stringify(localDoc)) {
      warn('内容与仓库文件 JSON 等价，但字节不完全一致（空白 / 换行）');
    } else {
      fail('线上内容与仓库文件不一致（部署的不是当前版本？）');
    }
  }
}

process.stdout.write(`URL           ${url}\n`);
process.stdout.write(`status        ${response.status}\n`);
process.stdout.write(`content-type  ${contentType}\n`);
process.stdout.write(`cache-control ${cacheControl}\n`);
process.stdout.write(`size          ${size} B\n`);
for (const message of warnings) console.warn(`WARN  ${message}`);
for (const message of failures) console.error(`FAIL  ${message}`);
if (failures.length > 0) process.exit(1);
process.stdout.write('OK    CIMD 文档可被授权服务器正常抓取，且与仓库一致' + '\n');
