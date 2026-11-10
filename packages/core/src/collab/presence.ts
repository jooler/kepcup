import {
  COLLAB_PRESENCE_BROADCAST_MS,
  COLLAB_PRESENCE_MAX_HZ,
  COLLAB_PRESENCE_SWEEP_MS,
  COLLAB_PRESENCE_TTL_MS,
  collabColorForClient,
  type CollabPresenceChangedPayload,
  type CollabPresenceEntry,
  type CollabPresenceLeaveInput,
  type CollabPresenceState,
  type CollabPresenceUpdateInput,
  type CollabSelection,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import { sanitizeClientName } from './client-name.js';
import { TokenBucket } from './rate-limit.js';

/**
 * 多客户端在线状态（D119，docs/design/57-multi-client-collaboration.md §3）。
 *
 * 纯内存：不落库、不进审计、不进 Bot 上下文。条目按 `clientId` 聚合，内部
 * 记录该客户端的全部连接 id（多标签页）：一个标签页关闭不会把同一客户端的
 * 其他标签页一起判离线。
 *
 * 事件按会话合流后广播全量条目（单会话条目很少，全量比增量简单且不会丢更新）。
 */

interface PresenceEntry {
  clientId: string;
  clientName: string;
  connectionId: string;
  conversationId: string | null;
  state: CollabPresenceState;
  selection: CollabSelection | null;
  updatedAt: number;
  /** 该客户端当前存活的连接 id（多标签页）。 */
  connections: Set<string>;
}

export interface PresenceServiceDeps {
  clock: Clock;
  /** 发布 `collab.presenceChanged`；由宿主接到 core 事件总线。 */
  publish: (name: 'collab.presenceChanged', payload: CollabPresenceChangedPayload) => void;
}

function sanitizeName(name: string): string {
  return sanitizeClientName(name);
}

function sameSelection(a: CollabSelection | null, b: CollabSelection | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.anchor === b.anchor && a.head === b.head && a.docVersion === b.docVersion;
}

function sameVisibleState(a: PresenceEntry, b: PresenceEntry): boolean {
  return (
    a.clientName === b.clientName &&
    a.connectionId === b.connectionId &&
    a.conversationId === b.conversationId &&
    a.state === b.state &&
    sameSelection(a.selection, b.selection)
  );
}

export class PresenceService {
  readonly #deps: PresenceServiceDeps;
  readonly #entries = new Map<string, PresenceEntry>();
  readonly #updates: TokenBucket;
  /** 待广播的会话（null = 不在任何会话的在线条目）。 */
  readonly #dirty = new Set<string | null>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(deps: PresenceServiceDeps) {
    this.#deps = deps;
    this.#updates = new TokenBucket(deps.clock, COLLAB_PRESENCE_MAX_HZ, COLLAB_PRESENCE_MAX_HZ * 2);
    this.#sweepTimer = setInterval(() => this.sweepExpired(), COLLAB_PRESENCE_SWEEP_MS);
    this.#sweepTimer.unref?.();
  }

  update(input: CollabPresenceUpdateInput): void {
    if (this.#closed) return;
    // 超限直接丢这一帧（设计 §8：丢帧而不是断开）；客户端下一次心跳会重报。
    if (!this.#updates.take(input.clientId)) return;
    const now = this.#deps.clock.now();
    const existing = this.#entries.get(input.clientId);
    const previousConversation = existing?.conversationId ?? null;
    const next: PresenceEntry = {
      clientId: input.clientId,
      clientName: sanitizeName(input.clientName),
      connectionId: input.connectionId,
      conversationId: input.conversationId,
      state: input.state ?? existing?.state ?? 'viewing',
      selection: input.selection !== undefined ? input.selection : (existing?.selection ?? null),
      updatedAt: now,
      connections: existing?.connections ?? new Set<string>(),
    };
    next.connections.add(input.connectionId);
    this.#entries.set(input.clientId, next);

    // 心跳只刷新 updatedAt，不产生可见变化，不广播。首次出现只广播新会话，
    // 不为「在线但不在任何会话」多发一帧。
    if (existing === undefined) {
      this.#dirty.add(next.conversationId);
      this.#scheduleFlush();
    } else if (!sameVisibleState(existing, next)) {
      this.#dirty.add(previousConversation);
      this.#dirty.add(next.conversationId);
      this.#scheduleFlush();
    }
  }

  leave(input: CollabPresenceLeaveInput): void {
    if (this.#closed) return;
    const entry = this.#entries.get(input.clientId);
    if (entry === undefined) return;
    if (input.connectionId !== undefined) {
      entry.connections.delete(input.connectionId);
      if (entry.connections.size > 0) return;
    }
    this.#entries.delete(input.clientId);
    this.#dirty.add(entry.conversationId);
    this.#scheduleFlush();
  }

  list(conversationId?: string): CollabPresenceEntry[] {
    const values = [...this.#entries.values()]
      .filter((entry) => conversationId === undefined || entry.conversationId === conversationId)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    return values.map((entry) => this.#toWire(entry));
  }

  /** 过期清扫（折返点：TTL 只影响展示，不清草稿）。测试直接调用。 */
  sweepExpired(): void {
    if (this.#closed) return;
    const now = this.#deps.clock.now();
    let changed = false;
    for (const [clientId, entry] of this.#entries) {
      if (now - entry.updatedAt <= COLLAB_PRESENCE_TTL_MS) continue;
      this.#entries.delete(clientId);
      this.#dirty.add(entry.conversationId);
      changed = true;
    }
    if (changed) this.#scheduleFlush();
  }

  /** 立即冲刷待广播队列（测试 / 关闭前）。 */
  flushNow(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#dirty.size === 0) return;
    const conversations = [...this.#dirty];
    this.#dirty.clear();
    for (const conversationId of conversations) {
      this.#deps.publish('collab.presenceChanged', {
        conversationId,
        entries: this.list(conversationId ?? undefined),
      });
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    this.#entries.clear();
    this.#dirty.clear();
    this.#updates.clear();
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null || this.#closed) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flushNow();
    }, COLLAB_PRESENCE_BROADCAST_MS);
    this.#flushTimer.unref?.();
  }

  #toWire(entry: PresenceEntry): CollabPresenceEntry {
    return {
      clientId: entry.clientId,
      clientName: entry.clientName,
      color: collabColorForClient(entry.clientId),
      connectionId: entry.connectionId,
      conversationId: entry.conversationId,
      state: entry.state,
      selection: entry.selection,
      updatedAt: entry.updatedAt,
    };
  }
}
