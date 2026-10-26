import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 读随包的内置连接器条目（D104 P0b 起原随包 catalog.json 的 `connectors` 数组
 * 分布在内置插件 com.kepcup/connections 的各 `server.json` 里）。
 * 顺序 = `plugin.json` 里 `contributions.connectors` 的顺序。
 */

export const SHIPPED_PLUGINS_DIR: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'apps/desktop/resources/plugins',
);

const CONNECTIONS_PLUGIN_JSON = path.join(
  SHIPPED_PLUGINS_DIR,
  'com.kepcup',
  'connections',
  'plugin.json',
);

/** The shipped builtin connector entries, in `plugin.json` order (raw server.json objects). */
export function readShippedConnectorEntries(): Array<Record<string, unknown>> {
  const manifest = JSON.parse(readFileSync(CONNECTIONS_PLUGIN_JSON, 'utf8')) as {
    contributions: { connectors: Array<{ file: string }> };
  };
  return manifest.contributions.connectors.map((contribution) =>
    JSON.parse(
      readFileSync(
        path.join(SHIPPED_PLUGINS_DIR, 'com.kepcup', 'connections', ...contribution.file.split('/')),
        'utf8',
      ),
    ),
  );
}
