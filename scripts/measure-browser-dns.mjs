#!/usr/bin/env node
// P11 技术点②实测脚本（docs/dev/phases/P11-browser.md 需验证技术点）：
// `onBeforeRequest` 中异步 DNS 解析给每个请求增加的延迟。
//
// 方法（与 apps/desktop/src/main/browser-host.ts 的 #intercept/#resolveHost
// 同一算法、同一判定函数）：对主机名做 `dns.lookup(host, { all: true })`
// （进程内正缓存 + 负缓存 + 在途去重，同 BROWSER_DNS_*_TTL_MS 常量），
// 随后调用 shared 的 decideBrowserRequest 纯函数。分别测量：
//   1) 缓存冷（每主机首次，真实 DNS 查询）
//   2) 缓存热（命中进程内缓存，60s TTL 内重复）
//   3) IP 字面量 / loopback（不查 DNS，直接判定）
// 每次 = resolveHost + decide 的完整耗时（即拦截器为该请求增加的延迟）。
//
// 运行：node scripts/measure-browser-dns.mjs  （需先 pnpm -r build 生成 shared dist）

import dns from 'node:dns';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shared = await import(pathToFileURL(path.join(root, 'packages/shared/dist/index.js')).href);

const DNS_POSITIVE_TTL_MS = shared.BROWSER_DNS_CACHE_TTL_MS;
const DNS_NEGATIVE_TTL_MS = shared.BROWSER_DNS_NEGATIVE_TTL_MS;

/** Mirrors BrowserHost#resolveHost (cache + in-flight dedupe). */
const cache = new Map();
const inflight = new Map();
function resolveHost(host) {
  if (shared.isLoopbackHostname(host)) return Promise.resolve(['127.0.0.1', '::1']);
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) return Promise.resolve([host]);
  const now = Date.now();
  const cached = cache.get(host);
  if (cached && cached.expires > now) {
    return Promise.resolve(cached.addresses ?? []);
  }
  const pending = inflight.get(host);
  if (pending) return pending;
  const lookup = new Promise((resolve) => {
    dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
      resolve(error || addresses.length === 0 ? null : addresses.map((a) => a.address));
    });
  })
    .then((addresses) => {
      cache.set(host, { addresses, expires: Date.now() + (addresses === null ? DNS_NEGATIVE_TTL_MS : DNS_POSITIVE_TTL_MS) });
      return addresses ?? [];
    })
    .finally(() => inflight.delete(host));
  inflight.set(host, lookup);
  return lookup;
}

async function timeIntercept(host, context) {
  const start = performance.now();
  const addresses = await resolveHost(host);
  shared.decideBrowserRequest({ host, addresses, scheme: 'http:', context });
  return performance.now() - start;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { mean, p50: pct(50), p95: pct(95), max: sorted[sorted.length - 1] };
}

function report(label, values) {
  const s = stats(values);
  const f = (v) => `${v.toFixed(3)}ms`;
  console.log(
    `${label.padEnd(34)} n=${String(values.length).padEnd(4)} mean=${f(s.mean)} p50=${f(s.p50)} p95=${f(s.p95)} max=${f(s.max)}`,
  );
  return s;
}

const PUBLIC_HOSTS = ['example.com', 'registry.npmjs.org', 'api.github.com', 'httpbin.org', 'www.baidu.com'];

console.log(`# P11 技术点②：onBeforeRequest 异步 DNS 解析延迟（本机实测）`);
console.log(`# 时间：${new Date().toISOString()}  平台：${process.platform} ${process.arch}`);
console.log(`# 判定上下文：allowLoopback=true（拦截器其余开销为一次 promise 调度）\n`);

// 1) 缓存冷：每主机首次真实查询。
const cold = [];
for (const host of PUBLIC_HOSTS) {
  cold.push(await timeIntercept(host, { allowLoopback: true }));
}
report('冷（首次真实 DNS 查询）', cold);

// 2) 缓存热：TTL 内重复 200 次/主机。
const warm = [];
for (let i = 0; i < 200; i += 1) {
  for (const host of PUBLIC_HOSTS) {
    warm.push(await timeIntercept(host, { allowLoopback: true }));
  }
}
report('热（进程内缓存命中）', warm);

// 3) 不需要 DNS 的请求：IP 字面量与 loopback。
const literal = [];
for (let i = 0; i < 1000; i += 1) {
  literal.push(await timeIntercept('192.168.1.1', { allowLoopback: true }));
  literal.push(await timeIntercept('127.0.0.1', { allowLoopback: true }));
}
report('IP 字面量 / loopback（无 DNS）', literal);

// 4) 拦截结论抽查（证明测量路径确实走了判定函数）。
const decisions = [
  ['example.com', { allowLoopback: false }, 'allow'],
  ['127.0.0.1', { allowLoopback: false }, 'cancel'],
  ['127.0.0.1', { allowLoopback: true }, 'allow'],
  ['192.168.1.1', { allowLoopback: true }, 'cancel'],
  ['169.254.169.254', { allowLoopback: true }, 'cancel'],
];
for (const [host, context, expected] of decisions) {
  const addresses = await resolveHost(host);
  const decision = shared.decideBrowserRequest({ host, addresses, scheme: 'http:', context });
  const got = decision.action;
  console.log(`# 判定 ${host} (allowLoopback=${String(context.allowLoopback)}) → ${got}${got === expected ? '' : ` ！！期望 ${expected}`}`);
}
