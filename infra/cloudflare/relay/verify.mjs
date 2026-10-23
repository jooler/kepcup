#!/usr/bin/env node
// 外部冒烟脚本(WP7 部署后运行,占位骨架先写好):
//   node infra/cloudflare/relay/verify.mjs [base-url]
// 默认 base-url = https://remote.kepcup.com;本地联调传 http://127.0.0.1:8787。
// 检查:/healthz 返回 200 文本;静态资产(/)200;WSS 握手——合法 ULID + role=viewer
// 能完成升级(anchor 不在也能连,DO 直接接受 viewer),非法 sid / role 在升级前被
// 400 拒绝。只依赖 Node 内置模块与全局 fetch / WebSocket(Node 22+)。
// TODO(WP6/WP7):配对 → RPC → 事件广播的全链路冒烟(需要真 anchor,联调时补)。
const DEFAULT_BASE = 'https://remote.kepcup.com';
const TIMEOUT_MS = 20_000;

const base = (process.argv[2] ?? DEFAULT_BASE).replace(/\/+$/, '');
const wsBase = base.replace(/^http/, 'ws');
const failures = [];
const fail = (message) => failures.push(message);

async function get(path) {
  const response = await fetch(`${base}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': 'kepcup-relay-verify/1' },
  });
  return response;
}

// ---- /healthz -----------------------------------------------------------------
try {
  const res = await get('/healthz');
  const body = await res.text();
  if (res.status !== 200) fail(`/healthz 返回 HTTP ${res.status}`);
  else if (!/^ok\b/.test(body)) fail(`/healthz 内容异常:${body.slice(0, 64)}`);
} catch (error) {
  fail(`/healthz 请求失败:${error instanceof Error ? error.message : String(error)}`);
}

// ---- 静态资产 ------------------------------------------------------------------
try {
  const res = await get('/');
  if (res.status !== 200) fail(`/ 返回 HTTP ${res.status}(静态资产 / SPA 回退异常)`);
} catch (error) {
  fail(`/ 请求失败:${error instanceof Error ? error.message : String(error)}`);
}

// ---- WSS 握手 ------------------------------------------------------------------
/** 尝试建立 WebSocket;resolve { ok, error? }——非 101 的升级以 error 事件收场。 */
function probe(url) {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // 已关闭
      }
      resolve({ ok, error });
    };
    ws.addEventListener('open', () => done(true));
    ws.addEventListener('error', () => done(false));
    setTimeout(() => done(false, 'timeout'), TIMEOUT_MS);
  });
}

// 合法形状的 ULID(Crockford Base32,26 位;与 shared 的 RELAY_SESSION_ID_PATTERN 同形)
const VALID_SID = '01JSCE8XFN2QRSTVWXYZKHJ4M9';
const open = await probe(`${wsBase}/ws/${VALID_SID}?role=viewer`);
if (!open.ok) fail(`合法 sid 的 WSS 握手失败(viewer 应能直连 DO)`);
for (const [label, path] of [
  ['非法 sid', '/ws/not-a-ulid?role=viewer'],
  ['非法 role', `/ws/${VALID_SID}?role=admin`],
]) {
  const bad = await probe(`${wsBase}${path}`);
  if (bad.ok) fail(`${label} 竟然握手成功(应在升级前被 400 拒绝):${path}`);
}

for (const message of failures) console.error(`FAIL  ${message}`);
if (failures.length > 0) process.exit(1);
process.stdout.write(`base    ${base}\n`);
process.stdout.write('OK      /healthz、静态资产、WSS 握手全部通过\n');
