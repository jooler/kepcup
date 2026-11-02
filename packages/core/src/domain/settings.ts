import {
  AppError,
  isVendorId,
  migrateLegacyModelProviders,
  mcpServerSchema,
  providerInstanceSchema,
  settingsSchema,
  type Settings,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';

const SETTINGS_KEY = 'app';

const storedSettingsSchema = settingsSchema;

/**
 * 读取时归一化供应商数据（docs/design/16-capability-models.md，v0.5.6 实例化）：
 *
 * - `modelProviders` 逐条 safeParse，不合规的丢弃（告警一次）——手改过的库、
 *   旧版本写入的条目不能让整份设置读不出来；`vendor` 不在厂商枚举里的实例
 *   一并丢弃（与「不做迁移、直接删除」的既有约定一致）。
 * - `capabilityModels.*.provider` 指向的实例不存在时置空（实例被丢弃 / 手改
 *   指向了不存在的 id），避免运行时按悬空引用报错。
 *
 * legacy `vendorProviders` / `customProviders` 在此之前已由
 * `migrateLegacyModelProviders` 搬进实例列表，这里不再清理。
 */
function normalizeModelProviders(
  raw: unknown,
  onDropped: (dropped: { index: number; id: string; issues: string[] }) => void,
): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.modelProviders)) return raw;
  const kept: unknown[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of data.modelProviders.entries()) {
    const parsed = providerInstanceSchema.safeParse(entry);
    const id = (entry as { id?: unknown } | null)?.id;
    if (!parsed.success) {
      onDropped({
        index,
        id: typeof id === 'string' ? id.slice(0, 80) : String(typeof id),
        issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message),
      });
      continue;
    }
    if (parsed.data.vendor !== null && !isVendorId(parsed.data.vendor)) {
      onDropped({
        index,
        id: parsed.data.id.slice(0, 80),
        issues: [`unknown vendor "${parsed.data.vendor}"`],
      });
      continue;
    }
    // id 是注册表 / 密钥 / ref 的命名空间：重复实例只保留首条（schema 不约束
    // 唯一性，手改过的库不能让 setProvider 静默互相覆盖）。
    if (ids.has(parsed.data.id)) {
      onDropped({
        index,
        id: parsed.data.id.slice(0, 80),
        issues: ['duplicate provider instance id'],
      });
      continue;
    }
    kept.push(parsed.data);
    ids.add(parsed.data.id);
  }
  const next: Record<string, unknown> =
    kept.length === data.modelProviders.length ? data : { ...data, modelProviders: kept };
  if (typeof next.capabilityModels === 'object' && next.capabilityModels !== null) {
    const models = { ...(next.capabilityModels as Record<string, unknown>) };
    for (const key of Object.keys(models)) {
      const entry = models[key];
      const provider = (entry as { provider?: unknown } | null)?.provider;
      if (typeof provider !== 'string' || !ids.has(provider)) models[key] = null;
    }
    next.capabilityModels = models;
  }
  return next;
}

/**
 * 读取时逐条校验 MCP 服务器（D91 后续）：`McpServer.id` 在 schema 层有字符集约束，而整份设置是
 * 整体 zod 解析——存量里哪怕一条不合规（手改过的库、旧版本写入的 id），整份设置就读不出来，
 * 应用起不来。所以先逐条 `safeParse`，不合规的丢弃（告警一次），其余照常读；写路径一律拒绝
 * （`update()` 的整体解析与 `settings.update` 的入参 schema）。不需要迁移：下一次保存设置时
 * 被丢弃的条目自然不再写回。
 */
function dropInvalidMcpServers(
  raw: unknown,
  onDropped: (dropped: { index: number; id: string; issues: string[] }) => void,
): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.mcpServers)) return raw;
  const kept = data.mcpServers.filter((entry, index) => {
    const parsed = mcpServerSchema.safeParse(entry);
    if (parsed.success) return true;
    const id = (entry as { id?: unknown } | null)?.id;
    onDropped({
      index,
      id: typeof id === 'string' ? id.slice(0, 80) : String(typeof id),
      issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message),
    });
    return false;
  });
  return kept.length === data.mcpServers.length ? raw : { ...data, mcpServers: kept };
}

/** Typed access to the single settings row (`key = 'app'`). */
export class SettingsService {
  /** 已告警过的坏条目（`get()` 很频繁，同一条只报一次）。 */
  readonly #warned = new Set<string>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
    private readonly logger?: Pick<CoreLogger, 'warn'>,
  ) {}

  get(): Settings {
    const row = this.db.prepare('select value_json from settings where key = ?').get(SETTINGS_KEY) as
      | { value_json: string }
      | undefined;
    if (!row) return storedSettingsSchema.parse({});
    const pre = migrateLegacyModelProviders(
      dropInvalidMcpServers(JSON.parse(row.value_json), (dropped) => {
        this.#warnDropped(`mcpServer:${dropped.index}:${dropped.id}`, dropped);
      }) as Record<string, unknown>,
    );
    const parsed = storedSettingsSchema.safeParse(
      normalizeModelProviders(pre.data, (dropped) => {
        this.#warnDropped(`providerInstance:${dropped.index}:${dropped.id}`, dropped);
      }),
    );
    if (!parsed.success) {
      throw new AppError('INTERNAL', 'Stored settings are invalid', {
        issues: parsed.error.issues,
      });
    }
    // 存量迁移（legacy 字段 → modelProviders）产生变化时写回一次，让存储
    // 尽快收敛到新形状；迁移是纯函数，写回失败也只是下次再迁一遍。
    if (pre.changed) this.#write(parsed.data);
    return parsed.data;
  }

  update(patch: Partial<Settings>): Settings {
    const current = this.get();
    const next = storedSettingsSchema.parse({ ...current, ...patch });
    this.#write(next);
    return next;
  }

  #write(next: Settings): void {
    this.db
      .prepare(
        'insert into settings (key, value_json, updated_at) values (?, ?, ?) ' +
          'on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at',
      )
      .run(SETTINGS_KEY, JSON.stringify(next), this.clock.now());
  }

  #warnDropped(key: string, dropped: { id: string; issues: string[] }): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.logger?.warn(
      { id: dropped.id, issues: dropped.issues },
      'settings: an invalid entry was dropped on read',
    );
  }
}
