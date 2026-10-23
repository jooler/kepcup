import { createHash, randomBytes } from 'node:crypto';
import {
  BOT_WIDGET_CALLS_BURST,
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
 * `widgets.ui.resource`。滑动 TTL + 条数上限（**最久未用**先淘汰：每次取用都把条目
 * 挪到队尾，正在交互的卡不会因为新开第 65 张而失效）；TTL 只回收渲染端没来得及
 * close 的孤儿条目——挂着不动的卡过期 / 被淘汰后，渲染端遇到
 * `WIDGET_RESOURCE_EXPIRED` 会自动重新 open 并重放这次调用（BotWidgetCard）。
 * 组件库里的行不改（版本只增），重开即重新登记。能力桥调用按资源限流：令牌桶
 * 容量 {@link BOT_WIDGET_CALLS_BURST}、每秒回填 {@link BOT_WIDGET_CALLS_PER_SECOND}、
 * 在途至多 {@link BOT_WIDGET_CALLS_INFLIGHT_MAX}。
 */

export interface WidgetResourceInput {
  widgetId: string;
  version: number;
  messageId: string;
  conversationId: string;
  botId: string | null;
  html: string;
  /** 完整的响应头 CSP（widget 完整 WebApp 档：`buildWidgetRuntimeCspHeader` 输出）。 */
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
  /** 每个资源的令牌桶（余量 + 上次回填时刻）与在途数。 */
  readonly #calls = new Map<string, { tokens: number; refilledAt: number; inflight: number }>();
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

  /** 取用并滑动续期（同时挪到 LRU 队尾）；过期 / 不存在 = undefined。 */
  get(id: string): WidgetResource | undefined {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const now = this.#clock.now();
    if (entry.expiresAt <= now) {
      this.remove(id);
      return undefined;
    }
    entry.expiresAt = now + this.#ttlMs;
    // Map 按插入序迭代：删了再插 = 最近使用，put 的淘汰从队首（最久未用）开始。
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    return entry;
  }

  remove(id: string): void {
    this.#entries.delete(id);
    this.#calls.delete(id);
  }

  /**
   * 组件被删除时摘掉它的全部在途资源；给了 `throughVersion` 则只摘 version ≤ 它的
   * （版本修剪）。下一次桥调用即 WIDGET_RESOURCE_EXPIRED。
   */
  removeForWidget(widgetId: string, throughVersion?: number): void {
    for (const [id, entry] of this.#entries) {
      if (entry.widgetId !== widgetId) continue;
      if (throughVersion !== undefined && entry.version > throughVersion) continue;
      this.remove(id);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * 能力桥限流：令牌桶——容量 {@link BOT_WIDGET_CALLS_BURST}（看板一次性并发拉取全部
   * 查询模板不会被拒），按每秒 {@link BOT_WIDGET_CALLS_PER_SECOND} 个回填（持续速率
   * 上限）；同时在途至多 {@link BOT_WIDGET_CALLS_INFLIGHT_MAX}（query 在子进程里异步
   * 执行，在途是真实并发）。通过则扣一个令牌、登记一次占用并返回释放函数；超限返回 null。
   */
  tryAcquireCall(id: string): (() => void) | null {
    const now = this.#clock.now();
    const state = this.#calls.get(id) ?? {
      tokens: BOT_WIDGET_CALLS_BURST,
      refilledAt: now,
      inflight: 0,
    };
    const elapsed = Math.max(0, now - state.refilledAt);
    state.tokens = Math.min(
      BOT_WIDGET_CALLS_BURST,
      state.tokens + (elapsed * BOT_WIDGET_CALLS_PER_SECOND) / 1000,
    );
    state.refilledAt = now;
    this.#calls.set(id, state);
    if (state.tokens < 1) return null;
    if (state.inflight >= BOT_WIDGET_CALLS_INFLIGHT_MAX) return null;
    state.tokens -= 1;
    state.inflight += 1;
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
