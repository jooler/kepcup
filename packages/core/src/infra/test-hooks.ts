/**
 * Build-time switch for TEST-ONLY code paths (P13 产物剔除, docs/dev/phases/
 * P13-release.md 注意事项): the mock-LLM seeding (KEPCUP_MOCK_LLM_URL),
 * the memory/file keystores (KEPCUP_KEYSTORE=memory/file) and the WSL
 * fixture runner (KEPCUP_WSL_TEST_FIXTURE) must not ship in the packaged
 * artifact. Guarded call sites read the ambient constant
 * `__KEPCUP_TEST_HOOKS__` directly so that bundlers can fold them:
 *
 * - Packaging bundle (scripts/dist.mjs): esbuild `define` = `false` — guarded
 *   branches become `if (false)`, are dead-code-eliminated together with their
 *   imports, and the markers disappear from the artifact (grep-verified).
 * - electron-vite dev/e2e bundles + vitest: `define` = `true` (default when
 *   KEPCUP_PACKAGE_BUILD is unset).
 * - Plain tsc output (this package's dist/, which dev and e2e consume through
 *   node_modules): no define exists, so the check below registers a global
 *   default of `true` — bare references then resolve through globalThis and
 *   dev/e2e behavior is unchanged. The ambient type declaration lives in
 *   src/build-constants.d.ts.
 */
if (typeof __KEPCUP_TEST_HOOKS__ === 'undefined') {
  (globalThis as { __KEPCUP_TEST_HOOKS__?: boolean }).__KEPCUP_TEST_HOOKS__ = true;
}
