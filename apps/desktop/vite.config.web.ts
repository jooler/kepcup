import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type PreviewServer, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

/**
 * web 构建配置（D96 WP5，design 46 §5.5）：renderer 同一份 Svelte 源码的第二入口
 * （index.web.html + src/web-main.ts），产物落 `infra/cloudflare/relay/public`——
 * 中转 Worker（WP3）同源托管 PWA 静态资产，配对链接的 relay 参数指向哪里，
 * 应用就从哪里加载。
 *
 * 托管路径约定（审查修复）：manifest / SW 注册 / start_url 都是根绝对路径——本
 * 构建只支持托管在站点根（线上 remote.kepcup.com 即根；`base:'./'` 只让带 hash
 * 的 assets 引用路径健壮，不构成对子路径托管的支持）。
 *
 * 与 electron.vite.config.ts 的 renderer 段保持一致的部分：$lib alias、svelte +
 * tailwindcss 插件。差异：`__KEPCUP_TEST_HOOKS__` 恒 false（dev 状态栏与 e2e
 * seam 从 web 产物里 DCE 掉）；`emptyOutDir: false`（目录里有 Worker 的占位
 * README/verify.mjs 之外的同级文件吗——没有，但保守不清空，index.html 会被覆盖）。
 */

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};

/**
 * 入口 html 的源文件名是 index.web.html（与 Electron 的 index.html 并存于 renderer
 * 根），但产物必须叫 index.html——Worker 的 SPA 回退与配对链接 `https://<origin>/`
 * 都落到根路径。emptyOutDir:false 下重命名正好整体覆盖 WP3 的占位页。
 */
const renameEntryHtmlToIndex = {
  // post：等 vite:build-html 先把入口 html 作为 asset 加进 bundle，再改名。
  enforce: 'post' as const,
  name: 'rename-web-entry-html',
  generateBundle(_options: unknown, bundle: Record<string, { type: string; fileName: string }>) {
    for (const output of Object.values(bundle)) {
      if (output.type === 'asset' && output.fileName === 'index.web.html') {
        output.fileName = 'index.html';
      }
    }
  },
};

/**
 * 构建前清掉上一轮的 hash 资产（审查修复）：emptyOutDir:false 是为了不动目录里
 * 的非产物文件，但 assets/ 里带 hash 的旧产物会跨构建无限累积（部署包膨胀、
 * sw 的 cache-first 永不过期）。
 */
const cleanHashedAssets = {
  name: 'clean-web-hashed-assets',
  buildStart() {
    rmSync(resolve(__dirname, '../../infra/cloudflare/relay/public/assets'), {
      force: true,
      recursive: true,
    });
  },
};

/**
 * preview server 的路径语义对齐真实部署（2026-11-11）：真实宿主（apps/server
 * static.ts / relay Worker 的 SPA 回退）对 /api、/admin 返回 REST 语义、/ws 是
 * WS 升级——都不会回退到 SPA 的 index.html。vite preview 缺省把未知路径全部
 * 回退成 200+HTML，认证探测层（authed-transport probeServerAuth 只看状态码）
 * 会把 200 误判为「密码模式已登录」，冒烟停在 booting（D102 探测语义修订后
 * preview 环境回归；生产部署不受影响）。
 */
const previewNoSpaFallback = {
  name: 'preview-no-spa-fallback',
  configurePreviewServer(server: PreviewServer) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0] ?? '';
      if (url.startsWith('/api/') || url.startsWith('/admin/')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      next();
    });
  },
};

/**
 * dev 代理目标（server.proxy 只作用于 dev server——build:web 与 playwright 的
 * vite preview 完全不经过它，生产仍由宿主同源托管）。web 客户端与宿主服务器
 * 全同源：/api/auth/* 登录 Cookie（HttpOnly）+ /rpc WS 升级自动带 Cookie，dev
 * 下由 vite 把两路转发到本机 server（apps/server 与 apps/team-server 同一托管
 * 约定；KEPCUP_TEAM_DEV_TARGET 可改指向，与团队管理台的 dev 代理同名同义）。
 */
const devProxyTarget = process.env.KEPCUP_TEAM_DEV_TARGET || 'http://127.0.0.1:8643';

/**
 * dev server 独有适配（build 与 preview 不经过 configureServer）：
 * - `/` 重写进 web 入口 index.web.html——web 入口与 Electron 的 index.html 同
 *   目录并存，vite dev 的 spa fallback 会把后者当根入口；生产（apps/server /
 *   team-server 的 static.ts）按根路径托管 web 构建，dev 对齐这一语义。
 * - /sw.js 回 404——dev 下 public/sw.js 会被静态服务，SW 注册成功会把 dev 资源
 *   缓存进 CacheStorage 干扰 HMR；注册侧本就 .catch(() => {}) 静默兜底
 *   （web-main.ts），404 即天然跳过，无需改渲染层源码。
 */
const devServerAdapt = {
  name: 'web-dev-server-adapt',
  configureServer(server: ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0] ?? '';
      if (url === '/') {
        req.url = '/index.web.html';
        return next();
      }
      if (url === '/sw.js') {
        res.statusCode = 404;
        res.end();
        return;
      }
      next();
    });
  },
};

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  // 相对 base：同一构建可被自建中转托管在任意路径下（配对 URL 带出真实地址）。
  base: './',
  server: {
    proxy: {
      '/api': {
        target: devProxyTarget,
        changeOrigin: true,
      },
      '/rpc': {
        // WS 同源转发。CSWSH 纵深：cookie 握手校验 Origin.host === Host（升级
        // 门，session-hub 同款），vite 代理 changeOrigin 只改 Host 不改 Origin
        // ——不重写 Origin 的话 dev 下握手一律 403。改写后 Origin.host 与被
        // changeOrigin 改写过的 Host 一致，校验通过。
        target: devProxyTarget,
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            proxyReq.setHeader('origin', devProxyTarget);
          });
        },
      },
    },
  },
  resolve: {
    alias: {
      $lib: resolve(__dirname, 'src/renderer/src/lib'),
    },
  },
  plugins: [
    tailwindcss(),
    svelte({ configFile: resolve(__dirname, 'svelte.config.js') }),
    renameEntryHtmlToIndex,
    cleanHashedAssets,
    previewNoSpaFallback,
    devServerAdapt,
  ],
  define: {
    __KEPCUP_TEST_HOOKS__: 'false',
    __KEPCUP_WEB_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // D102 headless 服务端打包：KEPCUP_WEB_OUTDIR 把同一份 web 产物改投
    // apps/server/web（pack-server.mjs 用）；缺省仍投中转 Worker 的 public。
    outDir:
      process.env.KEPCUP_WEB_OUTDIR !== undefined && process.env.KEPCUP_WEB_OUTDIR !== ''
        ? resolve(__dirname, process.env.KEPCUP_WEB_OUTDIR)
        : resolve(__dirname, '../../infra/cloudflare/relay/public'),
    // 改投目录（打包场景）整目录归 web 产物，允许清空；缺省目录里混有 Worker
    // 的占位文件，不能清。
    emptyOutDir:
      process.env.KEPCUP_WEB_OUTDIR !== undefined && process.env.KEPCUP_WEB_OUTDIR !== '',
    // vite 的内联 module preload polyfill 过不了 index.web.html 的 CSP
    // （script-src 'self'）；现代浏览器不需要它。
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.web.html'),
    },
  },
});
