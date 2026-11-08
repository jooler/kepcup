import {
  COLLAB_PRESENCE_HEARTBEAT_MS,
  COLLAB_TYPING_IDLE_MS,
  type CollabPresenceChangedPayload,
  type CollabPresenceEntry,
  type CollabPresenceListOutput,
  type CollabPresenceState,
} from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { clientIdentity } from './client-identity';

/**
 * 多客户端在线状态（D119，docs/design/57-multi-client-collaboration.md §3）。
 *
 * 一个客户端同一时刻只在一个会话里报 presence（主对话或看板卡片对话）。
 * Composer 挂载时 `enter(conversationId, source)`，卸载时 `leave(source)`；
 * source 是每个 Composer 实例的 symbol，避免后挂载的输入框被先卸载的实例清掉。
 *
 * 心跳 20s；typing 3s 无输入降回 viewing；后台标签页立即报 away。服务端不落库，
 * TTL 90s 兜底离线。
 */

type Source = symbol;

/** 客户端测试环境没有 DOM；真实渲染层恒有。 */
function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

class PresenceState {
  /** 当前会话的其他客户端（含自己，由 UI 过滤）。 */
  entries = $state<CollabPresenceEntry[]>([]);

  #conversationId: string | null = null;
  #state: CollabPresenceState = 'viewing';
  #selection: { anchor: number; head: number; docVersion: number } | null = null;
  #selectionTimer: ReturnType<typeof setTimeout> | null = null;
  #source: Source | null = null;
  /** 同时挂载的输入框（主对话 / 看板卡片）：最后 enter 的为当前 presence。 */
  #sources: Source[] = [];
  #sourceConversations = new Map<Source, string | null>();
  #started = false;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #typingTimer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;
  #unsubscribeStatus: (() => void) | null = null;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribe = core.onEvent('collab.presenceChanged', (payload) => {
      const data = payload as CollabPresenceChangedPayload;
      // null 会话是「在线但不在任何会话」的全局列表，不在输入区展示。
      if (this.#conversationId === null || data.conversationId !== this.#conversationId) return;
      this.entries = data.entries;
    });
    // core 重启 / 重连后在线表在服务端已清空：重新拉快照并重报自己。
    this.#unsubscribeStatus = core.onEvent('core.status', (payload) => {
      if ((payload as { status?: string }).status !== 'ready') return;
      void this.#refresh();
      this.#send();
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.#onPageHide);
    }
    this.#heartbeat = setInterval(() => this.#send(), COLLAB_PRESENCE_HEARTBEAT_MS);
    this.#send();
  }

  /** 进入会话（幂等）；同一客户端切会话时服务端自动把条目挪到新会话。 */
  enter(conversationId: string | null, source: Source): void {
    // 同一输入框实例 + 同一会话：effect 会因草稿变化频繁重跑，这里必须直接返回，
    // 否则每次击键都会多发 list/update 两个 RPC。
    if (this.#conversationId === conversationId && this.#source === source) return;
    this.#sources = this.#sources.filter((candidate) => candidate !== source);
    this.#sources.push(source);
    this.#sourceConversations.set(source, conversationId);
    this.#activate(conversationId, source);
  }

  /** Composer 卸载：若它是当前 presence，回落到上一个仍在挂载的输入框。 */
  leave(source: Source): void {
    this.#sources = this.#sources.filter((candidate) => candidate !== source);
    this.#sourceConversations.delete(source);
    if (this.#source !== source) return;
    const next = this.#sources.at(-1);
    if (next !== undefined) {
      this.#activate(this.#sourceConversations.get(next) ?? null, next);
      return;
    }
    this.#source = null;
    this.#conversationId = null;
    this.entries = [];
    this.#clearTypingTimer();
    this.#selection = null;
    this.#state = pageHidden() ? 'away' : 'viewing';
    this.#send();
  }

  #activate(conversationId: string | null, source: Source): void {
    const changed = this.#conversationId !== conversationId;
    this.#source = source;
    this.#conversationId = conversationId;
    if (changed) {
      this.entries = [];
      this.#clearTypingTimer();
      this.#selection = null;
      this.#state = pageHidden() ? 'away' : 'viewing';
    }
    void this.#refresh();
    this.#send();
  }

  /**
   * 编辑者光标（D121）：只在持有共享草稿租约时上报。服务端与 presence 一起
   * 合流（≤10Hz 客户端节流），只传 ProseMirror 位置，不重复传文档。
   */
  noteSelection(anchor: number, head: number, docVersion: number): void {
    if (this.#conversationId === null) return;
    this.#selection = { anchor, head, docVersion };
    if (this.#selectionTimer !== null) return;
    this.#selectionTimer = setTimeout(() => {
      this.#selectionTimer = null;
      this.#send();
    }, 100);
  }

  clearSelection(): void {
    if (this.#selection === null) return;
    this.#selection = null;
    this.#send();
  }

  /** 设备名等身份信息变化后立即重报（服务端按可见字段变化广播）。 */
  refresh(): void {
    this.#send();
  }

  /** 输入框内容变化：进入 typing，3s 无输入后降回 viewing。 */
  noteTyping(): void {
    if (this.#conversationId === null) return;
    if (this.#state !== 'typing') {
      this.#state = 'typing';
      this.#send();
    }
    if (this.#typingTimer !== null) clearTimeout(this.#typingTimer);
    this.#typingTimer = setTimeout(() => {
      this.#typingTimer = null;
      if (this.#state !== 'typing') return;
      this.#state = pageHidden() ? 'away' : 'viewing';
      this.#send();
    }, COLLAB_TYPING_IDLE_MS);
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    this.#clearTypingTimer();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#unsubscribeStatus?.();
    this.#unsubscribeStatus = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.#onPageHide);
    }
    this.#leaveServer();
    this.#source = null;
    this.#sources = [];
    this.#sourceConversations.clear();
    this.#conversationId = null;
    this.#state = 'viewing';
    this.#selection = null;
    this.entries = [];
  }

  #onVisibilityChange = (): void => {
    const next: CollabPresenceState = pageHidden()
      ? 'away'
      : this.#typingTimer !== null
        ? 'typing'
        : 'viewing';
    if (this.#state === next) return;
    this.#state = next;
    this.#send();
  };

  #onPageHide = (): void => {
    this.#leaveServer();
  };

  #leaveServer(): void {
    void core
      .call('collab.presence.leave', {
        clientId: clientIdentity.id,
        connectionId: clientIdentity.connectionId,
      })
      .catch(() => {
        // 页面正在卸载：送达与否由服务端 TTL 兜底。
      });
  }

  #refresh(): void {
    const conversationId = this.#conversationId;
    if (conversationId === null) {
      this.entries = [];
      return;
    }
    void core
      .call('collab.presence.list', { conversationId })
      .then((result) => {
        if (this.#conversationId !== conversationId) return;
        this.entries = (result as CollabPresenceListOutput).entries;
      })
      .catch(() => {
        // 未连接时由后续事件 / 心跳自愈。
      });
  }

  #send(): void {
    void core
      .call('collab.presence.update', {
        clientId: clientIdentity.id,
        clientName: clientIdentity.name,
        connectionId: clientIdentity.connectionId,
        conversationId: this.#conversationId,
        state: this.#state,
        // 显式 null：服务端把“缺省”理解为保持旧值，光标必须能被清掉。
        selection: this.#selection,
      })
      .catch(() => {
        // 断线期间的更新丢弃；重连后心跳会重报当前状态。
      });
  }

  #clearTypingTimer(): void {
    if (this.#typingTimer !== null) {
      clearTimeout(this.#typingTimer);
      this.#typingTimer = null;
    }
  }
}

export const presence = new PresenceState();
