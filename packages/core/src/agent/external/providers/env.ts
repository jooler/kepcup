/** Copy `env` without host-controlled keys, case-insensitively (Windows env). */
export function stripEnvKeys(
  env: Readonly<Record<string, string>>,
  keys: readonly string[],
): Record<string, string> {
  const blocked = new Set(keys.map((key) => key.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([key]) => !blocked.has(key.toUpperCase())));
}
