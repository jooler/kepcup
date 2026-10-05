import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

/**
 * Build-time switch for test-only code paths (see packages/core/src/infra/
 * test-hooks.ts): `true` for dev/e2e builds, `false` only for the packaged
 * artifact (scripts/dist.mjs sets KEPCUP_PACKAGE_BUILD=1) so the mock-LLM
 * seeding, the memory/file keystores and the WSL fixture runner are removed
 * from the bundle by dead-code elimination.
 */
const testHooksDefine = {
  __KEPCUP_TEST_HOOKS__: JSON.stringify(process.env.KEPCUP_PACKAGE_BUILD !== '1'),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: testHooksDefine,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'core-entry/index': resolve(__dirname, 'src/core-entry/index.ts'),
        },
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
  },
  preload: {
    // Sandboxed preloads must be CommonJS; electron-vite would otherwise emit
    // ESM because the package is type:module.
    plugins: [externalizeDepsPlugin()],
    define: testHooksDefine,
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        $lib: resolve(__dirname, 'src/renderer/src/lib'),
      },
    },
    plugins: [tailwindcss(), svelte({ configFile: resolve(__dirname, 'svelte.config.js') })],
    define: testHooksDefine,
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
