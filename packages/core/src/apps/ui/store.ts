import { createHash, randomBytes } from 'node:crypto';
import {
  MCP_APP_CALLS_INFLIGHT_MAX,
  MCP_APP_CALLS_PER_SECOND,
  MCP_APP_CONVERSATION_PENDING_MAX,
  MCP_APP_DENY_LOCK_MS,
} from '@kepcup/shared';
import type { Clock } from '../../infra/clock.js';

/**
 * 内存里的 MCP App 资源登记（D73 P3 §7.5）。一张卡片每次挂载 `apps.ui.open` 登记一条：HTML（来自
 * `resources/read`，永不落盘、永不进模型上下文）、响应头 CSP、所属 server / 会话 / Bot。
 *
 * 凭据 = 128 位随机 `id`（iframe 路径里的不透明段，也是 `apps.ui.callTool` 等的句柄）；`host` 由 server id
 * 派生成 DNS 安全的标签（`kepcup-app://{host}/{id}`），使每个应用连接有独立的 CSP `'self'` 来源。
 * 滑动 TTL + 条数上限（最旧先淘汰）；断开 / 停用的应用在使用处再校验存活，不依赖这里的主动失效。
 */

export interface UiResourceInput {
  serverId: string;
  messageId: string;
  conversationId: string;
  botId: string | null;
  toolName: string;
  resourceUri: string;
  html: string;
  /** 完整的响应头 CSP（来自清洗后的 `_meta.ui.csp`）。 */
  csp: string;
}

export interface UiResource extends UiResourceInput {
  id: string;
  host: string;
  expiresAt: number;
  /** Aborted when the resource is closed / expires / is evicted / its server goes away: pending approvals are cancelled. */
  abort: AbortController;
}

/** `kepcup-app://{host}/…` 的 host：由 server id 派生，DNS 安全、固定长度。 */
export function appUiHostFor(serverId: string): string {
  return `app-${createHash('sha256').update(serverId).digest('hex').slice(0, 24)}`;
}

export interface UiResourceStoreOptions {
  clock: Clock;
  ttlMs: number;
  max: number;
}

export class UiResourceStore {
  readonly #entries = new Map<string, UiResource>();
  /** 每个资源最近发起 `tools/call` 的时间戳（滚动 1 秒窗口）与在途数。 */
  readonly #calls = new Map<string, { stamps: number[]; inflight: number }>();
  /** (resource id + tool) → time until which a user-denied tool is not asked about again. */
  readonly #denied = new Map<string, number>();
  /** conversation id → UI-initiated gateway calls (possibly waiting for approval) in flight. */
  readonly #pendingByConversation = new Map<string, number>();
  readonly #options: UiResourceStoreOptions;

  constructor(options: UiResourceStoreOptions) {
    this.#options = options;
  }

  put(input: UiResourceInput): UiResource {
    this.#sweep();
    while (this.#entries.size >= this.#options.max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.remove(oldest.value);
    }
    const id = randomBytes(16).toString('base64url');
    const entry: UiResource = {
      ...input,
      id,
      host: appUiHostFor(input.serverId),
      expiresAt: this.#options.clock.now() + this.#options.ttlMs,
      abort: new AbortController(),
    };
    this.#entries.set(id, entry);
    return entry;
  }

  /** 取用并滑动续期；过期 / 不存在 = undefined。 */
  get(id: string): UiResource | undefined {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const now = this.#options.clock.now();
    if (entry.expiresAt <= now) {
      this.remove(id);
      return undefined;
    }
    entry.expiresAt = now + this.#options.ttlMs;
    return entry;
  }

  remove(id: string): void {
    const entry = this.#entries.get(id);
    this.#entries.delete(id);
    this.#calls.delete(id);
    for (const key of this.#denied.keys()) {
      if (key.startsWith(`${id}\u0000`)) this.#denied.delete(key);
    }
    entry?.abort.abort();
  }

  /** The user denied `tool` on this card: stay quiet about it for {@link MCP_APP_DENY_LOCK_MS}. */
  lockDeniedTool(id: string, tool: string): void {
    this.#denied.set(`${id}\u0000${tool}`, this.#options.clock.now() + MCP_APP_DENY_LOCK_MS);
  }

  isToolLocked(id: string, tool: string): boolean {
    const key = `${id}\u0000${tool}`;
    const until = this.#denied.get(key);
    if (until === undefined) return false;
    if (until <= this.#options.clock.now()) {
      this.#denied.delete(key);
      return false;
    }
    return true;
  }

  /**
   * At most {@link MCP_APP_CONVERSATION_PENDING_MAX} UI-initiated calls per conversation may be in
   * the gateway (i.e. possibly waiting on an approval card) at once; more fail fast so a page can
   * not bury the user in cards.
   */
  tryAcquireConversationSlot(conversationId: string): (() => void) | null {
    const current = this.#pendingByConversation.get(conversationId) ?? 0;
    if (current >= MCP_APP_CONVERSATION_PENDING_MAX) return null;
    this.#pendingByConversation.set(conversationId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.#pendingByConversation.get(conversationId) ?? 1) - 1;
      if (next <= 0) this.#pendingByConversation.delete(conversationId);
      else this.#pendingByConversation.set(conversationId, next);
    };
  }

  /** 某 server 的全部资源失效（连接断开 / 删除）。 */
  invalidateServer(serverId: string): number {
    let removed = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.serverId === serverId) {
        this.remove(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * 限流：每个资源每秒至多 {@link MCP_APP_CALLS_PER_SECOND} 次、同时在途至多
   * {@link MCP_APP_CALLS_INFLIGHT_MAX} 个。通过则登记一次占用并返回释放函数；超限返回 null。
   */
  tryAcquireCall(id: string): (() => void) | null {
    const now = this.#options.clock.now();
    const state = this.#calls.get(id) ?? { stamps: [], inflight: 0 };
    state.stamps = state.stamps.filter((stamp) => now - stamp < 1000);
    if (state.stamps.length >= MCP_APP_CALLS_PER_SECOND) return null;
    if (state.inflight >= MCP_APP_CALLS_INFLIGHT_MAX) return null;
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
    const now = this.#options.clock.now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.remove(id);
    }
  }
}
