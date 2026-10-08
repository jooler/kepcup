import { sensorKindSchema, type SensorKind } from '@kepcup/shared';

/**
 * 传感器偏好持久化（docs/design/31-sensors.md §2.2，D76）：渲染层本机偏好，
 * 单键 `kepcup.sensors.v1`；不进 core 用户数据。localStorage 不可用 / 损坏时
 * 静默降级（只影响跨会话记忆，当次仍生效）。
 */

export const SENSOR_PREFS_KEY = 'kepcup.sensors.v1';
/** 26 号设计的旧键：仅在新键不存在时读取一次，不删除（回滚安全）。 */
export const LEGACY_MIC_DEVICE_KEY = 'kepcup.micDeviceId';

export interface SensorPref {
  /** undefined = 用描述表的 defaultEnabled。 */
  enabled?: boolean;
  /** 空串 / undefined = 系统默认。 */
  deviceId?: string;
}
export type SensorPrefs = Partial<Record<SensorKind, SensorPref>>;

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** 手写校验（渲染层不依赖 zod）：只收形态正确的字段，其余丢弃。 */
function parsePref(value: unknown): SensorPref {
  const pref: SensorPref = {};
  if (typeof value !== 'object' || value === null) return pref;
  const { enabled, deviceId } = value as Record<string, unknown>;
  if (typeof enabled === 'boolean') pref.enabled = enabled;
  if (typeof deviceId === 'string') pref.deviceId = deviceId;
  return pref;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadSensorPrefs(storage: StorageLike | null = defaultStorage()): SensorPrefs {
  if (storage === null) return {};
  try {
    const raw = storage.getItem(SENSOR_PREFS_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      const { version, sensors } = parsed as { version?: unknown; sensors?: unknown };
      if (version !== 1 || typeof sensors !== 'object' || sensors === null) return {};
      const prefs: SensorPrefs = {};
      for (const [key, value] of Object.entries(sensors)) {
        const kind = sensorKindSchema.safeParse(key);
        if (kind.success) prefs[kind.data] = parsePref(value);
      }
      return prefs;
    }
    // 新键不存在：导入旧麦克风设备偏好并写回（旧键保留）。
    const legacy = storage.getItem(LEGACY_MIC_DEVICE_KEY);
    if (legacy !== null && legacy.length > 0) {
      const migrated: SensorPrefs = { microphone: { deviceId: legacy } };
      saveSensorPrefs(migrated, storage);
      return migrated;
    }
  } catch {
    // 存储不可用 / JSON 损坏：按无偏好处理。
  }
  return {};
}

export function saveSensorPrefs(
  prefs: SensorPrefs,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    // 回滚保护：新版本写的更高版本偏好不被旧版本覆盖。
    const existing = storage.getItem(SENSOR_PREFS_KEY);
    if (existing !== null) {
      const version = (JSON.parse(existing) as { version?: unknown } | null)?.version;
      if (typeof version === 'number' && version > 1) return;
    }
    storage.setItem(SENSOR_PREFS_KEY, JSON.stringify({ version: 1, sensors: prefs }));
  } catch {
    // 静默：只影响跨会话记忆。
  }
}
