import {
  AppError,
  isVendorId,
  mcpServerSchema,
  settingsSchema,
  type Settings,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';

const SETTINGS_KEY = 'app';

const storedSettingsSchema = settingsSchema;

/**
 * 读取时丢弃已从预置移除的厂商（如 siliconflow）的配置：厂商 id 是严格
 * 枚举，残留引用会让整个设置加载失败。约定是不做旧数据迁移——未知的
 * 厂商条目直接删除，能力引用置空，让当下实现保持正确即可。
 */
function dropUnknownVendors(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const data = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(data.vendorProviders)) {
    data.vendorProviders = data.vendorProviders.filter(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        isVendorId((entry as { id?: string }).id ?? ''),
    );
  }
  if (typeof data.capabilityModels === 'object' && data.capabilityModels !== null) {
    const models = { ...(data.capabilityModels as Record<string, unknown>) };
    for (const key of Object.keys(models)) {
      const entry = models[key];
      if (
        typeof entry === 'object' &&
        entry !== null &&
        !isVendorId((entry as { vendor?: string }).vendor ?? '')
      ) {
        models[key] = null;
      }
    }
    data.capabilityModels = models;
  }
  return data;
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
  readonly #warnedMcp = new Set<string>();

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
    const parsed = storedSettingsSchema.safeParse(
      dropInvalidMcpServers(dropUnknownVendors(JSON.parse(row.value_json)), (dropped) => {
        const key = `${dropped.index}:${dropped.id}`;
        if (this.#warnedMcp.has(key)) return;
        this.#warnedMcp.add(key);
        this.logger?.warn(
          { serverId: dropped.id, issues: dropped.issues },
          'settings: an invalid MCP server entry was dropped on read',
        );
      }),
    );
    if (!parsed.success) {
      throw new AppError('INTERNAL', 'Stored settings are invalid', {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  update(patch: Partial<Settings>): Settings {
    const current = this.get();
    const next = storedSettingsSchema.parse({ ...current, ...patch });
    this.db
      .prepare(
        'insert into settings (key, value_json, updated_at) values (?, ?, ?) ' +
          'on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at',
      )
      .run(SETTINGS_KEY, JSON.stringify(next), this.clock.now());
    return next;
  }
}
