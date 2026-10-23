import {
  BOT_WIDGET_CONSENT_STORAGE_KEY,
  BOT_WIDGET_CONSENTS_MAX,
  type WidgetCard,
} from '@kepcup/shared';

/**
 * 组件按版本的运行确认（设计 32 §2 信任模型）：「HTML sha256 + 查询摘要」为指纹，
 * 同版本只确认一次（localStorage，有界）。BotWidgetCard（审查态）与覆盖层运行时共用。
 *
 * 确认状态放在 `$state` 快照里而不是直接读 localStorage：BotWidgetCard 的
 * `$derived(!widgetConsented(card))`（海报可点态）依赖的是快照——确认后（或同指纹的
 * 另一张卡确认后）立即重新求值；localStorage 本身不是响应式依赖，直接读会让海报
 * 在确认后仍停在「不可点」。写穿 localStorage，跨启动的记忆不变。
 */

/** 确认记忆的指纹 = HTML sha256 + 查询模板摘要（P2）：HTML 不变、仅查询变化的新版本同样视为新代码。 */
export function widgetConsentKey(card: WidgetCard): string {
  return `${card.sha256}|${card.queriesSha256}`;
}

/** 存储面（node 测试注入替身；省略 removeItem —— 这里只读写整个 key）。 */
export type ConsentStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): ConsentStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function parseConsents(raw: string | null): Record<string, boolean> {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

export class WidgetConsentStore {
  readonly #storage: ConsentStorage | null;
  /** 已确认的指纹表（构造时装载一次；之后内存快照为准，remember 写穿回 storage）。 */
  #snapshot: Record<string, boolean> = $state({});

  constructor(storage: ConsentStorage | null = defaultStorage()) {
    this.#storage = storage;
    if (storage !== null) {
      try {
        this.#snapshot = parseConsents(storage.getItem(BOT_WIDGET_CONSENT_STORAGE_KEY));
      } catch {
        this.#snapshot = {};
      }
    }
  }

  consented(card: WidgetCard): boolean {
    return this.#snapshot[widgetConsentKey(card)] === true;
  }

  remember(card: WidgetCard): void {
    const all = { ...this.#snapshot };
    all[widgetConsentKey(card)] = true;
    const keys = Object.keys(all);
    // 有界：超限丢最旧的确认（重新确认一次即可，安全侧无害）。
    while (keys.length > BOT_WIDGET_CONSENTS_MAX) {
      delete all[keys.shift() ?? ''];
    }
    this.#snapshot = all;
    if (this.#storage !== null) {
      try {
        this.#storage.setItem(BOT_WIDGET_CONSENT_STORAGE_KEY, JSON.stringify(all));
      } catch {
        // 隐私模式等存储不可用：仅本次会话内免确认，不影响功能。
      }
    }
  }
}

/** 应用级单例。 */
export const widgetConsents = new WidgetConsentStore();

/** 兼容读法（响应式）：`$derived(!widgetConsented(card))` 会随确认即时更新。 */
export function widgetConsented(card: WidgetCard): boolean {
  return widgetConsents.consented(card);
}

export function rememberWidgetConsent(card: WidgetCard): void {
  widgetConsents.remember(card);
}
