import type { PluginItemKind } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';

/**
 * Ledger for the plugin system (D104, docs/design/51-plugin-system.md §7):
 * `plugins` rows (one per installed plugin) and `plugin_items` — the projection
 * ledger that uninstall / rollback / conflict checks read instead of reverse-
 * engineering ownership from the projected services. Row mapping is snake_case in
 * SQL, camelCase here (same shape as `board/board-store.ts`).
 */

export interface PluginRow {
  id: string;
  version: string;
  origin: 'marketplace' | 'local';
  tier: 'verified' | 'community' | 'developer';
  state: 'installing' | 'installed' | 'uninstalling';
  enabled: boolean;
  packageSha256: string;
  marketplace: string | null;
  /** Relative to `{home}/plugins`: `{ns}/{name}@{version}` (lower-cased). */
  dir: string;
  installedAt: number;
  updatedAt: number;
}

export type PluginRowPatch = Partial<
  Pick<
    PluginRow,
    'version' | 'tier' | 'state' | 'enabled' | 'packageSha256' | 'marketplace' | 'dir' | 'updatedAt'
  >
>;

interface PluginDbRow {
  id: string;
  version: string;
  origin: string;
  tier: string;
  state: string;
  enabled: number;
  package_sha256: string;
  marketplace: string | null;
  dir: string;
  installed_at: number;
  updated_at: number;
}

interface ItemDbRow {
  kind: string;
  ref: string;
}

function pluginFromRow(row: PluginDbRow): PluginRow {
  return {
    id: row.id,
    version: row.version,
    origin: row.origin as PluginRow['origin'],
    tier: row.tier as PluginRow['tier'],
    state: row.state as PluginRow['state'],
    enabled: row.enabled === 1,
    packageSha256: row.package_sha256,
    marketplace: row.marketplace,
    dir: row.dir,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

export class PluginStore {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  /** All plugins, oldest install first (stable for the UI list). */
  list(): PluginRow[] {
    const rows = this.#db
      .prepare('select * from plugins order by installed_at asc, id asc')
      .all() as PluginDbRow[];
    return rows.map(pluginFromRow);
  }

  get(id: string): PluginRow | null {
    const row = this.#db.prepare('select * from plugins where id = ?').get(id) as
      PluginDbRow | undefined;
    return row === undefined ? null : pluginFromRow(row);
  }

  insert(row: PluginRow): void {
    this.#db
      .prepare(
        `insert into plugins (id, version, origin, tier, state, enabled, package_sha256, marketplace, dir, installed_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.version,
        row.origin,
        row.tier,
        row.state,
        row.enabled ? 1 : 0,
        row.packageSha256,
        row.marketplace,
        row.dir,
        row.installedAt,
        row.updatedAt,
      );
  }

  update(id: string, patch: PluginRowPatch): void {
    const columns: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.version !== undefined) {
      columns.push('version = ?');
      values.push(patch.version);
    }
    if (patch.tier !== undefined) {
      columns.push('tier = ?');
      values.push(patch.tier);
    }
    if (patch.state !== undefined) {
      columns.push('state = ?');
      values.push(patch.state);
    }
    if (patch.enabled !== undefined) {
      columns.push('enabled = ?');
      values.push(patch.enabled ? 1 : 0);
    }
    if (patch.packageSha256 !== undefined) {
      columns.push('package_sha256 = ?');
      values.push(patch.packageSha256);
    }
    if (patch.marketplace !== undefined) {
      columns.push('marketplace = ?');
      values.push(patch.marketplace);
    }
    if (patch.dir !== undefined) {
      columns.push('dir = ?');
      values.push(patch.dir);
    }
    if (patch.updatedAt !== undefined) {
      columns.push('updated_at = ?');
      values.push(patch.updatedAt);
    }
    if (columns.length === 0) return;
    this.#db.prepare(`update plugins set ${columns.join(', ')} where id = ?`).run(...values, id);
  }

  /** Deletes the plugin row; `plugin_items` rows go with it (FK ON DELETE CASCADE). */
  delete(id: string): void {
    this.#db.prepare('delete from plugins where id = ?').run(id);
  }

  /** Every ledger item of one plugin (all kinds, insertion order). */
  items(pluginId: string): Array<{ kind: PluginItemKind; ref: string }> {
    const rows = this.#db
      .prepare('select kind, ref from plugin_items where plugin_id = ? order by rowid asc')
      .all(pluginId) as ItemDbRow[];
    return rows.map((row) => ({ kind: row.kind as PluginItemKind, ref: row.ref }));
  }

  /** Ledger refs of one kind, in insertion order (rowid). */
  refs(pluginId: string, kind: PluginItemKind): string[] {
    const rows = this.#db
      .prepare('select ref from plugin_items where plugin_id = ? and kind = ? order by rowid asc')
      .all(pluginId, kind) as Array<{ ref: string }>;
    return rows.map((row) => row.ref);
  }

  /** Registers a projected item BEFORE it is written; idempotent. */
  addItem(pluginId: string, kind: PluginItemKind, ref: string): void {
    this.#db
      .prepare('insert or ignore into plugin_items (plugin_id, kind, ref) values (?, ?, ?)')
      .run(pluginId, kind, ref);
  }

  removeItem(pluginId: string, kind: PluginItemKind, ref: string): void {
    this.#db
      .prepare('delete from plugin_items where plugin_id = ? and kind = ? and ref = ?')
      .run(pluginId, kind, ref);
  }

  /** Which plugin owns a projected item (the `plugin_items_ref` index serves this lookup). */
  ownerOf(kind: PluginItemKind, ref: string): string | null {
    const row = this.#db
      .prepare('select plugin_id from plugin_items where kind = ? and ref = ? limit 1')
      .get(kind, ref) as { plugin_id: string } | undefined;
    return row === undefined ? null : row.plugin_id;
  }
}
