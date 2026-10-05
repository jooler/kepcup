import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/*.svelte-check/**',
      'docs/**',
      'resources/**',
      'playwright-report/**',
      'test-results/**',
      'packages/core/src/**/migrations/**',
      // P12 rootfs build scripts: distro-side CI artifacts (CommonJS/bash by
      // contract, executed inside the image build — not app source).
      'apps/desktop/scripts/build-wsl-rootfs/**',
      // P13 packaging hook: electron-builder contract requires CommonJS
      // (module.exports = { beforePack, afterPack }) — build tooling, not app code.
      'apps/desktop/scripts/pack-hooks.cjs',
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
);
