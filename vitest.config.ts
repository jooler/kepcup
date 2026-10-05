import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@kepcup/shared': fileURLToPath(
        new URL('./packages/shared/src/index.ts', import.meta.url),
      ),
      '@kepcup/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@kepcup/testkit': fileURLToPath(
        new URL('./packages/testkit/src/index.ts', import.meta.url),
      ),
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
          name: 'desktop',
          include: [
            'apps/desktop/src/renderer/src/**/*.test.ts',
            // Main-process pure logic (Electron-free modules) is unit-tested
            // in place (P11 修复轮：dns-resolver / download-name).
            'apps/desktop/src/main/**/*.test.ts',
          ],
        },
      },
    ],
  },
});
