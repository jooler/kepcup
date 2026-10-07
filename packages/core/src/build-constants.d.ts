/**
 * Bundler-injected build-time constants (docs/dev/phases/P13-release.md
 * 注意事项「产物剔除」). Ambient declaration for the whole package; the
 * runtime default for plain tsc output is registered by infra/test-hooks.ts.
 */
declare const __KEPCUP_TEST_HOOKS__: boolean | undefined;
/**
 * D72 发行门禁放行清单（apps/desktop/scripts/dist.mjs 经 esbuild define 注入；
 * 其余构建中未定义 → agent/external/catalog.ts 视为不过滤）。
 */
declare const __KEPCUP_AGENT_RELEASE_GATES__: readonly string[] | undefined;
