import { createHash, randomBytes } from 'node:crypto';
import { BOT_WIDGET_RESOURCES_MAX, BOT_WIDGET_RESOURCE_TTL_MS } from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';

/**
 * 内存里的 Bot Widget 资源登记（D81，设计 32 §5）——与 MCP Apps 的
 * `UiResourceStore`（apps/ui/store.ts）同构但独立：widget 的 HTML 来自本机库的
 * `widget_versions`（不是 MCP `resources/read`），没有 server / 工具语义，也不做
 * 界面发起调用的限流（P1 的能力桥另计）。
 *
 * 凭据 = 128 位随机 `id`；host 由 widgetId 派生成 `widget-{sha256-24}`，通过
 * `parseAppUiUrl` 的 host 校验，且前缀 `widget-` 供主进程协议处理器分流到
 * `widgets.ui.resource`。滑动 TTL + 条数上限（最旧先淘汰）；组件库里的行永不
 * 变（版本只增），过期重开即重新登记。
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
  }

  get size(): number {
    return this.#entries.size;
  }

  #sweep(): void {
    const now = this.#clock.now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.remove(id);
    }
  }
}
