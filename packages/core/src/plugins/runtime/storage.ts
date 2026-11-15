import { AppError, PLUGIN_RUNTIME_STORAGE_QUOTA_BYTES } from '@kepcup/shared';
import type { SqliteDatabase } from '../../infra/db.js';
import type { Clock } from '../../infra/clock.js';

/**
 * 插件 KV（`plugin_storage`，迁移 0076；D125 P2，61 §4 `host.storage`）。
 *
 * 行 = `(plugin_id, key, value_json, updated_at)`；value 必须是 JSON 兼容数据
 * （敏感数据走 secrets，不进这里）。配额 10MB / 插件（61 §3.3），写前按聚合体积
 * 校验——超限拒绝而不是丢旧值。卸载时由注册表的 teardown 钩子清空（bridge
 * `clearStorage`）；表本身**不加外键**：builtin 只读目录插件不在 `plugins` 表，
 * 加了外键会让它们的 storage 写入直接失败（DEV-112 的实例面同根边界）。
 */

export interface PluginStorageEntry {
  key: string;
  valueJson: string;
  updatedAt: number;
}

interface StorageDbRow {
  key: string;
  value_json: string;
  updated_at: number;
}

/** 单键前缀匹配的 SQL 转义（`%` / `_` / `\` 都是 LIKE 元字符）。 */
function escapeLike(prefix: string): string {
  return prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export class PluginStorageStore {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;
  readonly #quotaBytes: number;

  constructor(deps: { db: SqliteDatabase; clock: Clock; quotaBytes?: number }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#quotaBytes = deps.quotaBytes ?? PLUGIN_RUNTIME_STORAGE_QUOTA_BYTES;
  }

  get quotaBytes(): number {
    return this.#quotaBytes;
  }

  get(pluginId: string, key: string): PluginStorageEntry | null {
    const row = this.#db
      .prepare(
        'select key, value_json, updated_at from plugin_storage where plugin_id = ? and key = ?',
      )
      .get(pluginId, key) as StorageDbRow | undefined;
    return row === undefined
      ? null
      : { key: row.key, valueJson: row.value_json, updatedAt: row.updated_at };
  }

  /**
   * 写入（插入或覆盖）。配额按「该插件全部值 JSON 的 UTF-8 字节数之和」计算，
   * 覆盖同键时先扣除旧值。超限抛 `INVALID_INPUT`（错误消息含配额与当前占用）——
   * 插件侧据此给出可读错误，宿主不静默丢弃旧数据。
   */
  set(pluginId: string, key: string, valueJson: string): void {
    const bytes = Buffer.byteLength(valueJson, 'utf8');
    const existing = this.get(pluginId, key);
    const current =
      this.usageBytes(pluginId) -
      (existing === null ? 0 : Buffer.byteLength(existing.valueJson, 'utf8'));
    if (current + bytes > this.#quotaBytes) {
      throw new AppError(
        'INVALID_INPUT',
        `插件存储超出 ${Math.round(this.#quotaBytes / (1024 * 1024))}MB 配额（当前 ${current} 字节，本次 ${bytes} 字节）`,
        { quotaBytes: this.#quotaBytes, usedBytes: current },
      );
    }
    const now = this.#clock.now();
    this.#db
      .prepare(
        `insert into plugin_storage (plugin_id, key, value_json, updated_at) values (?, ?, ?, ?)
         on conflict(plugin_id, key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(pluginId, key, valueJson, now);
  }

  delete(pluginId: string, key: string): boolean {
    const result = this.#db
      .prepare('delete from plugin_storage where plugin_id = ? and key = ?')
      .run(pluginId, key);
    return Number(result.changes) > 0;
  }

  list(pluginId: string, prefix?: string): string[] {
    const rows =
      prefix === undefined || prefix === ''
        ? (this.#db
            .prepare('select key from plugin_storage where plugin_id = ? order by key asc')
            .all(pluginId) as Array<{ key: string }>)
        : (this.#db
            .prepare(
              "select key from plugin_storage where plugin_id = ? and key like ? escape '\\' order by key asc",
            )
            .all(pluginId, `${escapeLike(prefix)}%`) as Array<{ key: string }>);
    return rows.map((row) => row.key);
  }

  /** 该插件当前占用（全部 value JSON 的 UTF-8 字节数之和）。 */
  usageBytes(pluginId: string): number {
    const rows = this.#db
      .prepare('select value_json from plugin_storage where plugin_id = ?')
      .all(pluginId) as Array<{ value_json: string }>;
    return rows.reduce((total, row) => total + Buffer.byteLength(row.value_json, 'utf8'), 0);
  }

  /** 卸载 / 回滚时清空（幂等）。返回删除行数。 */
  clear(pluginId: string): number {
    const result = this.#db.prepare('delete from plugin_storage where plugin_id = ?').run(pluginId);
    return Number(result.changes);
  }
}
