import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
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

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  // 相对 base：同一构建可被自建中转托管在任意路径下（配对 URL 带出真实地址）。
  base: './',
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
  ],
  define: {
    __KEPCUP_TEST_HOOKS__: 'false',
    __KEPCUP_WEB_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: resolve(__dirname, '../../infra/cloudflare/relay/public'),
    emptyOutDir: false,
    // vite 的内联 module preload polyfill 过不了 index.web.html 的 CSP
    // （script-src 'self'）；现代浏览器不需要它。
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.web.html'),
    },
  },
});
