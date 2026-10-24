import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * PWA 静态托管（D102 §3.1）：web 构建产物（`vite.config.web.ts` 产物，由打包
 * 脚本放进包内 `web/`）由服务端同源托管——配对链接的 origin 指向服务端自身，
 * 扫码打开即是完整客户端。SPA 回退 index.html；hashed 资产强缓存；入口与
 * sw.js 不缓存。
 */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function resolveWebDir(explicit: string | null): string | null {
  if (explicit !== null) return explicit;
  // dist/../web（打包布局：dist/cli.js + web/）。
  const packaged = path.resolve(new URL('..', import.meta.url).pathname, 'web');
  return existsSync(packaged) ? packaged : null;
}

export function serveStatic(
  webDir: string,
  pathname: string,
  res: ServerResponse,
): boolean {
  if (pathname.includes('..')) {
    res.writeHead(400).end();
    return true;
  }
  let filePath = path.join(webDir, pathname === '/' ? 'index.html' : pathname);
  let stat = existsSync(filePath) ? statSync(filePath) : null;
  if ((stat === null || !stat.isFile()) && !path.extname(pathname)) {
    // SPA 回退：无扩展名的未知路径回 index.html（web 构建只支持根路径托管）。
    filePath = path.join(webDir, 'index.html');
    stat = existsSync(filePath) ? statSync(filePath) : null;
  }
  if (stat === null || !stat.isFile()) {
    res
      .writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
      })
      .end('not found');
    return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME_TYPES[ext] ?? 'application/octet-stream';
  const hashed = pathname.startsWith('/assets/');
  res.writeHead(200, {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'cache-control': hashed
      ? 'public, max-age=31536000, immutable'
      : 'no-cache, must-revalidate',
  });
  createReadStream(filePath).pipe(res);
  return true;
}
