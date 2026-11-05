import {
  MICRO_APP_CONSENTS_MAX,
  MICRO_APP_CONSENT_STORAGE_KEY,
  type MicroAppConsentRecord,
  type WidgetCard,
} from '@kepcup/shared';

/**
 * 微应用的运行确认（D112，设计 55 §5.2 / Q8）：**按能力面指纹**记忆，键 = widgetId
 * （而非版本 / 代码摘要）——指纹不变（只改代码）沿用上次确认，卡片标「代码已更新，
 * 权限未扩大」；指纹变化（新增能力、放宽网络、扩大域名）强制重新确认。
 *
 * 与存量组件的逐版本确认（consent.svelte.ts，`(sha256|queriesSha256)`）是两套独立
 * 存储：存量路径零变化是 P0 硬验收。确认状态放 `$state` 快照（同组件侧：海报的
 * `$derived` 在确认后立即重新求值），写穿 localStorage。
 */

/** 存储面（node 测试注入替身）。 */
export type MicroAppConsentStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): MicroAppConsentStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function parseRecords(raw: string | null): Record<string, MicroAppConsentRecord> {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, MicroAppConsentRecord> = {};
    for (const [widgetId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as Record<string, unknown>)['fingerprint'] === 'string' &&
        typeof (value as Record<string, unknown>)['bundleSha256'] === 'string' &&
        typeof (value as Record<string, unknown>)['at'] === 'number'
      ) {
        out[widgetId] = {
          fingerprint: (value as Record<string, unknown>)['fingerprint'] as string,
          bundleSha256: (value as Record<string, unknown>)['bundleSha256'] as string,
          at: (value as Record<string, unknown>)['at'] as number,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export class MicroAppConsentStore {
  readonly #storage: MicroAppConsentStorage | null;
  #snapshot: Record<string, MicroAppConsentRecord> = $state({});

  constructor(storage: MicroAppConsentStorage | null = defaultStorage()) {
    this.#storage = storage;
    if (storage !== null) {
      try {
        this.#snapshot = parseRecords(storage.getItem(MICRO_APP_CONSENT_STORAGE_KEY));
      } catch {
        this.#snapshot = {};
      }
    }
  }

  /**
   * 该微应用的当前确认是否覆盖给定指纹。返回 `codeUpdated`（同指纹、bundle 变了）供
   * 卡片标「代码已更新，权限未扩大」——这不是重新确认的理由，能力面没变。
   */
  consented(
    widgetId: string,
    fingerprint: string,
    bundleSha256?: string,
  ): { ok: true; codeUpdated: boolean } | { ok: false } {
    const record = this.#snapshot[widgetId];
    if (record === undefined || record.fingerprint !== fingerprint) return { ok: false };
    return { ok: true, codeUpdated: bundleSha256 !== undefined && record.bundleSha256 !== bundleSha256 };
  }

  /** 顺手读当前记录（卡片徽标：bundle 变了标「代码已更新」）。 */
  recordOf(widgetId: string): MicroAppConsentRecord | undefined {
    return this.#snapshot[widgetId];
  }

  remember(widgetId: string, fingerprint: string, bundleSha256: string, at: number): void {
    const all = { ...this.#snapshot };
    all[widgetId] = { fingerprint, bundleSha256, at };
    const keys = Object.keys(all);
    // 有界：超限丢最旧的确认（重新确认一次即可，安全侧无害）。
    while (keys.length > MICRO_APP_CONSENTS_MAX) {
      delete all[keys.shift() ?? ''];
    }
    this.#snapshot = all;
    if (this.#storage !== null) {
      try {
        this.#storage.setItem(MICRO_APP_CONSENT_STORAGE_KEY, JSON.stringify(all));
      } catch {
        // 隐私模式等存储不可用：仅本次会话内免确认。
      }
    }
  }
}

/** 应用级单例。 */
export const microAppConsents = new MicroAppConsentStore();

/** 卡片侧的门控读法（响应式）：带清单的微应用用这个，存量组件用 `widgetConsented`。 */
export function microAppCardConsented(
  card: WidgetCard,
  fingerprint: string,
  bundleSha256?: string,
): { ok: true; codeUpdated: boolean } | { ok: false } {
  return microAppConsents.consented(card.widgetId, fingerprint, bundleSha256);
}

export function rememberMicroAppConsent(
  card: WidgetCard,
  fingerprint: string,
  bundleSha256: string,
): void {
  microAppConsents.remember(card.widgetId, fingerprint, bundleSha256, Date.now());
}
