import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/.astro/**',
      '**/node_modules/**',
      '**/*.svelte-check/**',
      'docs/**',
      'resources/**',
      'playwright-report/**',
      'test-results/**',
      // D102 headless 服务端：web 构建产物（pack-server.mjs 生成）与打包暂存目录。
      'apps/server/web/**',
      'release-server/**',
      'packages/core/src/**/migrations/**',
      // P12 rootfs build scripts: distro-side CI artifacts (CommonJS/bash by
      // contract, executed inside the image build — not app source).
      'apps/desktop/scripts/build-wsl-rootfs/**',
      // P13 packaging hook: electron-builder contract requires CommonJS
      // (module.exports = { beforePack, afterPack }) — build tooling, not app code.
      'apps/desktop/scripts/pack-hooks.cjs',
      // P13 品牌图标/dev 壳补丁：generate-icons-electron.cjs 是 Electron 主进程
      // 脚本（.cjs 由 Electron 拉起），patch-dev-electron.cjs 用 PlistBuddy +
      // require('electron') 改 dev 壳 Info.plist——均为构建工具链，非应用代码。
      'apps/desktop/scripts/generate-icons-electron.cjs',
      'apps/desktop/scripts/patch-dev-electron.cjs',
      // D87 P3-0 spike: a standalone Electron main-process script (CommonJS, run by the electron
      // binary directly) kept for re-running the sandbox measurements on macOS / Windows.
      'apps/desktop/scripts/spikes/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        // Bundler-injected build-time constant (see
        // apps/desktop/src/main/build-constants.d.ts).
        __KEPCUP_TEST_HOOKS__: 'readonly',
        // D72 agent catalog release gates (apps/desktop/scripts/dist.mjs).
        __KEPCUP_AGENT_RELEASE_GATES__: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte'],
      },
    },
  },
  {
    // Svelte 5 rune modules: plain TypeScript, not Svelte template syntax.
    files: ['**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parser: tseslint.parser,
    },
  },
  {
    files: ['scripts/**', 'apps/desktop/scripts/**', '**/*.config.*', 'packages/*/test/**'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // D102 headless 服务端：CLI / 服务端控制台输出就是产品面（二维码、配对链接、
    // 设备列表），与桌面「renderer 不许 console」的约束不同域。
    files: ['apps/server/src/**', 'apps/server/test/**'],
    rules: {
      'no-console': 'off',
    },
  },
);
