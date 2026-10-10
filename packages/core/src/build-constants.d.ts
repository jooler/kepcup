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
/**
 * D73 连接应用目录发行门禁放行清单（apps/desktop/scripts/dist.mjs 经 esbuild define 注入
 * connector-release-gates.json；其余构建中未定义 → apps/catalog.ts 视为不过滤）。
 */
declare const __KEPCUP_CONNECTOR_RELEASE_GATES__: readonly string[] | undefined;
/**
 * D73 P2 预注册 OAuth 客户端表（apps/desktop/scripts/dist.mjs 经 esbuild define 注入
 * oauth-clients.json；其余构建中未定义 → apps/oauth-clients.ts 退回读文件 / 空表）。
 */
declare const __KEPCUP_OAUTH_CLIENTS__:
  | Readonly<Record<string, { issuer: string; clientId: string; clientSecret?: string }>>
  | undefined;
