/**
 * Bundler-injected build-time constants (docs/dev/phases/P13-release.md
 * 注意事项「产物剔除」). Ambient declaration for the whole package; the
 * runtime default for plain tsc output is registered by infra/test-hooks.ts.
 */
declare const __KEPCUP_TEST_HOOKS__: boolean | undefined;
