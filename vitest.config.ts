import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// 渲染端 Svelte 响应式（`$effect` / `$state` 的 `.svelte.ts` store）的测试：vite-plugin-svelte 只装在
// apps/desktop 下，从那里解析。没有 DOM（node 环境），只跑 `.svelte.test.ts` 里的 `$effect.root`。
const desktopRequire = createRequire(new URL('./apps/desktop/package.json', import.meta.url));
const svelteDir = path.dirname(desktopRequire.resolve('svelte/package.json'));
const svelteExports = (
  JSON.parse(readFileSync(path.join(svelteDir, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { browser?: string; default?: string }>;
  }
).exports;
const { svelte } = (await import(
  pathToFileURL(desktopRequire.resolve('@sveltejs/vite-plugin-svelte')).href
)) as { svelte: (options?: Record<string, unknown>) => Plugin };

export default defineConfig({
  resolve: {
    alias: {
      '@kepcup/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@kepcup/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@kepcup/testkit': fileURLToPath(new URL('./packages/testkit/src/index.ts', import.meta.url)),
    },
  },
  // Test-only code paths stay live in every test project (see
  // packages/core/src/infra/test-hooks.ts; the dev default is true anyway).
  define: { __KEPCUP_TEST_HOOKS__: 'true' },
  test: {
    environment: 'node',
    // Native modules are loaded with Electron as the Node runtime
    // (docs/dev/05-testing.md); forks isolate native state across files.
    pool: 'forks',
    projects: [
      { test: { name: 'shared', include: ['packages/shared/test/**/*.test.ts'] } },
      { test: { name: 'core', include: ['packages/core/test/**/*.test.ts'] } },
      { test: { name: 'testkit', include: ['packages/testkit/test/**/*.test.ts'] } },
      {
        test: {
          name: 'app-validator',
          include: ['packages/app-validator/test/**/*.test.ts'],
        },
      },
      // D73 P3: sub-registry Worker (infra/cloudflare/registry), tested against in-memory SQLite.
      {
        test: { name: 'infra-registry', include: ['infra/cloudflare/registry/test/**/*.test.ts'] },
      },
      {
        test: {
          name: 'desktop',
          // `*.svelte.test.ts` 需要 Svelte 编译器（见下面的 desktop-svelte 项目）。
          exclude: ['**/node_modules/**', 'apps/desktop/src/renderer/src/**/*.svelte.test.ts'],
          include: [
            'apps/desktop/src/renderer/src/**/*.test.ts',
            // Main-process pure logic (Electron-free modules) is unit-tested
            // in place (P11 修复轮：dns-resolver / download-name).
            'apps/desktop/src/main/**/*.test.ts',
          ],
        },
      },
      {
        plugins: [
          // `svelte` 只装在 apps/desktop 下：从那里解析（含 svelte/internal/client 等子路径）。
          {
            name: 'resolve-svelte-from-desktop',
            enforce: 'pre',
            resolveId(source) {
              if (source !== 'svelte' && !source.startsWith('svelte/')) return null;
              const key = source === 'svelte' ? '.' : `./${source.slice('svelte/'.length)}`;
              const target = svelteExports[key];
              if (target === undefined) return null;
              // 与 vite 的 `browser` 条件一致：优先 browser，其次 default。
              const file =
                typeof target === 'string' ? target : (target.browser ?? target.default ?? null);
              return file === null ? null : path.join(svelteDir, file);
            },
          },
          svelte({ configFile: false, hot: false }),
        ],
        resolve: {
          alias: {
            $lib: fileURLToPath(new URL('./apps/desktop/src/renderer/src/lib', import.meta.url)),
            '@kepcup/shared': fileURLToPath(
              new URL('./packages/shared/src/index.ts', import.meta.url),
            ),
          },
          // 客户端运行时（effect 会真的跑），不是 SSR 的空实现。
          conditions: ['browser'],
        },
        test: {
          name: 'desktop-svelte',
          environment: './apps/desktop/test/svelte-client-env.ts',
          include: ['apps/desktop/src/renderer/src/**/*.svelte.test.ts'],
        },
      },
    ],
  },
});
