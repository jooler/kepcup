import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Builtin plugin resolution for the headless server (D104 P0b, Q9): the packed
 * tarball carries `plugins/` next to `dist/` (pack-server.mjs copies
 * apps/desktop/resources/plugins → package/plugins). When the env var is already
 * set it wins; otherwise a sibling `plugins/` directory is used; without either
 * the core falls back to its repo-checkout walk-up (which finds nothing in a
 * deployed package — builtin skills/connections are then simply absent).
 */
export function builtinPluginsEnv(distDir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.KEPCUP_BUILTIN_PLUGINS !== undefined && env.KEPCUP_BUILTIN_PLUGINS.length > 0) {
    return env;
  }
  const candidate = path.resolve(distDir, '..', 'plugins');
  if (existsSync(candidate)) {
    return { ...env, KEPCUP_BUILTIN_PLUGINS: candidate };
  }
  return env;
}
