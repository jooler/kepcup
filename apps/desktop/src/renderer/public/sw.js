/**
 * KepCup 遥控器 Service Worker（D96 WP5，design 46 §5.5）：P0 只做静态壳缓存——
 * 不碰业务数据、不做消息推送（P1）、绝不缓存中转的 WebSocket 与 /healthz。
 *
 * 策略：
 *  - 带 hash 的构建资产（/assets/*）天然不可变：cache-first；
 *  - 同源静态资源（manifest / 图标）：stale-while-revalidate（先用缓存，后台刷新）；
 *  - 页面导航（SPA 入口 index.html，无 hash、部署即变）：network-first，超时或
 *    离线回落缓存——避免旧 index.html 引用已被新部署清掉的 hash 资产；
 *  - 其余（/ws/*、/healthz、跨域、非 GET）一律直连网络。
 */

const CACHE = 'kepcup-shell-v1';
const PRECACHE = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-256.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // 中转流量（WebSocket 握手与 /healthz）永不拦截。
  if (url.pathname.startsWith('/ws/') || url.pathname === '/healthz') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit !== undefined) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => hit);
  return hit !== undefined ? hit : refresh;
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    // 只有根导航才回落写 '/'：深链（如 /foo）的响应内容不能覆盖 SPA 入口缓存
    //（审查修复：原先任意导航响应都写 '/'，离线回落会拿到错误内容）。
    if (response.ok) {
      cache.put(request, response.clone());
      if (new URL(request.url).pathname === '/') cache.put('/', response.clone());
    }
    return response;
  } catch {
    return (await cache.match('/')) ?? Response.error();
  }
}
