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
      '@kepcup/package-guard': fileURLToPath(
        new URL('./packages/package-guard/src/index.ts', import.meta.url),
      ),
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
      {
        test: {
          name: 'core',
          include: ['packages/core/test/**/*.test.ts'],
          // Windows runners are several times slower to spawn / hit the disk.
          ...(process.platform === 'win32' ? { testTimeout: 30_000, hookTimeout: 60_000 } : {}),
          setupFiles: ['./vitest.setup.ts'],
        },
      },
      {
        test: {
          name: 'testkit',
          include: ['packages/testkit/test/**/*.test.ts'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
      {
        test: {
          name: 'app-validator',
          include: ['packages/app-validator/test/**/*.test.ts'],
        },
      },
      { test: { name: 'package-guard', include: ['packages/package-guard/test/**/*.test.ts'] } },
      // D102 headless 服务端：直连监听层 / CLI 解析 / 全链路（临时目录 + memory keystore）。
      {
        test: {
          name: 'server',
          include: ['apps/server/test/**/*.test.ts'],
          // Same as core: Windows is several times slower for scrypt / disk.
          ...(process.platform === 'win32' ? { testTimeout: 30_000, hookTimeout: 60_000 } : {}),
        },
      },
      // D73 P3: sub-registry Worker (infra/cloudflare/registry), tested against in-memory SQLite.
      {
        test: { name: 'infra-registry', include: ['infra/cloudflare/registry/test/**/*.test.ts'] },
      },
      // D96 WP3: relay Worker (infra/cloudflare/relay) — DO 路由逻辑为纯类 + mock socket,
      // 不用 miniflare(本仓测试跑在 Electron-as-Node 运行时下,见 relay/README)。
      {
        test: { name: 'infra-relay', include: ['infra/cloudflare/relay/test/**/*.test.ts'] },
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
      svelteClientProject('desktop-svelte', './apps/desktop/src/renderer/src/lib', [
        'apps/desktop/src/renderer/src/**/*.svelte.test.ts',
      ]),
      // D122 手机原生壳首页(apps/mobile):纯逻辑(connect / target-model / scan)。
      // src 下也收(svelte store 的纯函数部分可能放 src),排除 .svelte.test.ts 归上面的项目。
      {
        test: {
          name: 'mobile',
          include: ['apps/mobile/test/**/*.test.ts', 'apps/mobile/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'apps/mobile/src/**/*.svelte.test.ts'],
        },
      },
      svelteClientProject('mobile-svelte', './apps/mobile/src/lib', [
        'apps/mobile/src/**/*.svelte.test.ts',
      ]),
    ],
  },
});

/**
 * Svelte 客户端测试项目的单一来源(desktop 与 mobile 共用,D122 审查修复:原先
 * desktop-svelte / mobile-svelte 两块 30 行配置逐行复制,插件与解析规则会漂移):
 * `svelte` 只装在 apps/desktop 下、从那里解析(含 svelte/internal/client 等子路径,
 * 两包版本一致由 pnpm 锁文件保证);`$lib` 按包指向;客户端运行时(effect 会真的
 * 跑),不是 SSR 的空实现。
 */
function svelteClientProject(name: string, libDir: string, include: string[]) {
  return {
    plugins: [
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
        $lib: fileURLToPath(new URL(libDir, import.meta.url)),
        '@kepcup/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      },
      conditions: ['browser'],
    },
    test: {
      name,
      environment: './apps/desktop/test/svelte-client-env.ts',
      include,
    },
  };
}
