import { AppError, isVendorId, settingsSchema, type Settings } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

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

/** Typed access to the single settings row (`key = 'app'`). */
export class SettingsService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  get(): Settings {
    const row = this.db.prepare('select value_json from settings where key = ?').get(SETTINGS_KEY) as
      | { value_json: string }
      | undefined;
    if (!row) return storedSettingsSchema.parse({});
    const parsed = storedSettingsSchema.safeParse(dropUnknownVendors(JSON.parse(row.value_json)));
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
