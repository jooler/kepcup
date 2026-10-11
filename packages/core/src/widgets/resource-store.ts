import { createHash, randomBytes } from 'node:crypto';
import {
  BOT_WIDGET_CALLS_INFLIGHT_MAX,
  BOT_WIDGET_CALLS_PER_SECOND,
  BOT_WIDGET_RESOURCES_MAX,
  BOT_WIDGET_RESOURCE_TTL_MS,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';

/**
 * 内存里的 Bot Widget 资源登记（D81，设计 32 §5）——与 MCP Apps 的
 * `UiResourceStore`（apps/ui/store.ts）同构但独立：widget 的 HTML 来自本机库的
 * `widget_versions`（不是 MCP `resources/read`），没有 server / 工具语义。
 *
 * 凭据 = 128 位随机 `id`；host 由 widgetId 派生成 `widget-{sha256-24}`，通过
 * `parseAppUiUrl` 的 host 校验，且前缀 `widget-` 供主进程协议处理器分流到
 * `widgets.ui.resource`。滑动 TTL + 条数上限（最旧先淘汰）；组件库里的行永不
 * 变（版本只增），过期重开即重新登记。能力桥调用（P1）按资源限速：每秒
 * {@link BOT_WIDGET_CALLS_PER_SECOND} 次、在途至多 {@link BOT_WIDGET_CALLS_INFLIGHT_MAX}。
 */

export interface WidgetResourceInput {
  widgetId: string;
  version: number;
  messageId: string;
  conversationId: string;
  botId: string | null;
  html: string;
  /** 完整的响应头 CSP（widget 固定禁网：`buildAppCspHeader` 空域输出）。 */
  csp: string;
}

export interface WidgetResource extends WidgetResourceInput {
  id: string;
  host: string;
  expiresAt: number;
}

/** `kepcup-app://widget-{hash}/…` 的 host（前缀供主进程分流）。 */
export function widgetUiHostFor(widgetId: string): string {
  return `widget-${createHash('sha256').update(widgetId).digest('hex').slice(0, 24)}`;
}

export interface WidgetResourceStoreOptions {
  clock: Clock;
  ttlMs?: number;
  max?: number;
}

export class WidgetResourceStore {
  readonly #entries = new Map<string, WidgetResource>();
  /** 每个资源最近发起能力桥调用的时间戳（滚动 1 秒窗口）与在途数。 */
  readonly #calls = new Map<string, { stamps: number[]; inflight: number }>();
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #max: number;

  constructor(options: WidgetResourceStoreOptions) {
    this.#clock = options.clock;
    this.#ttlMs = options.ttlMs ?? BOT_WIDGET_RESOURCE_TTL_MS;
    this.#max = options.max ?? BOT_WIDGET_RESOURCES_MAX;
  }

  put(input: WidgetResourceInput): WidgetResource {
    this.#sweep();
    while (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.remove(oldest.value);
    }
    const id = randomBytes(16).toString('base64url');
    const entry: WidgetResource = {
      ...input,
      id,
      host: widgetUiHostFor(input.widgetId),
      expiresAt: this.#clock.now() + this.#ttlMs,
    };
    this.#entries.set(id, entry);
    return entry;
  }

  /** 取用并滑动续期；过期 / 不存在 = undefined。 */
  get(id: string): WidgetResource | undefined {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const now = this.#clock.now();
    if (entry.expiresAt <= now) {
      this.remove(id);
      return undefined;
    }
    entry.expiresAt = now + this.#ttlMs;
    return entry;
  }

  remove(id: string): void {
    this.#entries.delete(id);
    this.#calls.delete(id);
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * 能力桥限流（P1）：每个资源每秒至多 {@link BOT_WIDGET_CALLS_PER_SECOND} 次、同时在途至多
   * {@link BOT_WIDGET_CALLS_INFLIGHT_MAX} 个。通过则登记一次占用并返回释放函数；超限返回 null。
   * 在途上限是为 P2 的异步能力（query）预留的：当前 storage 调用全同步、释放前不会有并发，
   * inflight 实际恒为 0，生效的只有每秒次数。
   */
  tryAcquireCall(id: string): (() => void) | null {
    const now = this.#clock.now();
    const state = this.#calls.get(id) ?? { stamps: [], inflight: 0 };
    state.stamps = state.stamps.filter((stamp) => now - stamp < 1000);
    if (state.stamps.length >= BOT_WIDGET_CALLS_PER_SECOND) return null;
    if (state.inflight >= BOT_WIDGET_CALLS_INFLIGHT_MAX) return null;
    state.stamps.push(now);
    state.inflight += 1;
    this.#calls.set(id, state);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.inflight = Math.max(0, state.inflight - 1);
    };
  }

  #sweep(): void {
    const now = this.#clock.now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.remove(id);
    }
  }
}
