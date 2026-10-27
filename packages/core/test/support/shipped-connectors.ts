import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 读官方插件开发目录的连接器条目（原随包 catalog.json → 内置插件 com.kepcup/connections
 * → D104 商店化后为 plugins/connector-<slug>/ 的独立插件）。测试夹具把它们当作
 * 「随包快照来源」使用，因此 tier 覆写回 `builtin`（与商店化前的目录合并语义一致）。
 */

export const SHIPPED_PLUGINS_DIR: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'plugins',
);

/** The connector entries from `plugins/connector-*`, sorted by slug (raw server.json objects). */
export function readShippedConnectorEntries(): Array<Record<string, unknown>> {
  const slugs = readdirSync(SHIPPED_PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('connector-'))
    .map((e) => e.name.slice('connector-'.length))
    .sort();
  if (slugs.length === 0) throw new Error(`no connector-* plugins under ${SHIPPED_PLUGINS_DIR}`);
  return slugs.map((slug) => {
    const entry = JSON.parse(
      readFileSync(
        path.join(SHIPPED_PLUGINS_DIR, `connector-${slug}`, 'connectors', slug, 'server.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const meta = (entry._meta as Record<string, Record<string, unknown>>)?.['app.kepcup/connector'];
    if (meta && meta.tier === 'community') meta.tier = 'builtin';
    return entry;
  });
}
