import { resolveConnectTarget } from './connect';
import {
  RECENT_TARGETS_CAP,
  toRecentTarget,
  upsertRecent,
  type RecentTarget,
} from './target-model';

/**
 * 最近连接的响应式 store(D122 §3):runes 状态 + 可注入存储后端。默认后端是
 * Capacitor Preferences(原生 Key-Value,动态 import——纯浏览器 dev 与 Node 测试
 * 环境没有原生桥);测试注入内存后端,不触网。
 */

const STORAGE_KEY = 'kepcup.mobile.recentTargets.v1';

/** 逐项校验持久化数据(Preferences 可被设备本地篡改;坏条目丢弃而非卡死 UI)。 */
function isRecentTarget(value: unknown): value is RecentTarget {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === 'pairing' || v.kind === 'server') &&
    typeof v.id === 'string' &&
    typeof v.label === 'string' &&
    typeof v.raw === 'string' &&
    typeof v.addedAt === 'number' &&
    Number.isFinite(v.addedAt) &&
    typeof v.lastUsedAt === 'number' &&
    Number.isFinite(v.lastUsedAt)
  );
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

async function preferencesStore(): Promise<KeyValueStore> {
  const { Preferences } = await import('@capacitor/preferences');
  return {
    get: async (key) => (await Preferences.get({ key })).value ?? null,
    set: async (key, value) => {
      await Preferences.set({ key, value });
    },
  };
}

export class RecentTargetsStore {
  list = $state<RecentTarget[]>([]);
  loaded = $state(false);

  #backend: KeyValueStore | null = null;

  /** 应用启动时调用一次;重复调用是 no-op(幂等,防热重载双写)。 */
  async init(backend: KeyValueStore | null = null): Promise<void> {
    if (this.#backend !== null) return;
    this.#backend = backend ?? (await preferencesStore());
    const raw = await this.#backend.get(STORAGE_KEY);
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        this.list = Array.isArray(parsed)
          ? parsed.filter(isRecentTarget).slice(0, RECENT_TARGETS_CAP)
          : [];
      } catch {
        this.list = [];
      }
    }
    this.loaded = true;
  }

  /** 解析并记录一个目标(扫码 / 输入成功后调用),返回是否有效。 */
  async record(raw: string, now: number = Date.now()): Promise<boolean> {
    const target = resolveConnectTarget(raw);
    if (target === null) return false;
    this.list = upsertRecent(this.list, toRecentTarget(target, now));
    await this.#persist();
    return true;
  }

  async remove(id: string): Promise<void> {
    this.list = this.list.filter((item) => item.id !== id);
    await this.#persist();
  }

  async clear(): Promise<void> {
    this.list = [];
    await this.#persist();
  }

  async #persist(): Promise<void> {
    if (this.#backend === null) return;
    await this.#backend.set(STORAGE_KEY, JSON.stringify(this.list));
  }
}

export const recentTargets = new RecentTargetsStore();
