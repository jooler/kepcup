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
          // D105 computer-use sidecar：独立入口（对齐 orca 的多入口做法）。文件名
          // 固定为 computer-sidecar.js——helper 的 socket peer 校验按命令行路径
          // `/out/main/computer-sidecar.js`（打包后 app.asar.unpacked 前缀）识别
          // sidecar，改名会让连接被拒。运行时由 src/main/computer/forked-child-entry-path.ts
          // 解析（asar.unpacked 同 stdio-proxy 先例）。
          'computer-sidecar': resolve(__dirname, 'src/main/computer/computer-sidecar.ts'),
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
