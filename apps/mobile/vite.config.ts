import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

/**
 * 原生首页构建(D122):极小单页(扫码 / 地址输入 / 最近连接),产物 `dist/` 由
 * `cap sync` 投进原生工程。重型 UI(对话 / 任务 / 设置)全部来自所连服务端托管
 * 的 web 客户端——首页刻意保持小,减少因壳改动触发发版的面积。
 */

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};

export default defineConfig({
  resolve: {
    alias: {
      $lib: resolve(__dirname, 'src/lib'),
    },
  },
  plugins: [tailwindcss(), svelte({ configFile: false, hot: false })],
  define: {
    __KEPCUP_MOBILE_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
