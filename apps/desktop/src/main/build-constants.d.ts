/**
 * Bundler-injected build-time constant (P13 产物剔除机制, see
 * packages/core/src/build-constants.d.ts). electron-vite defines it `true`
 * for dev/e2e builds and `false` for the packaged artifact (esbuild define +
 * minify folds guarded branches away). In packaged builds any test seam below
 * must be dead code.
 */
declare const __KEPCUP_TEST_HOOKS__: boolean;
