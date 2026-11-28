import {
  isChatDisplayKeyEnabled,
  loadChatDisplayPrefs,
  mergeNoticeReadCursors,
  noticeReadKey,
  saveChatDisplayPrefs,
  type ChatDisplayToggleKey,
  type ChatDisplayPrefs,
} from './chat-display';
import { createBrowserIdbKvFactory, type IdbKvDatabase, type IdbKvFactory } from '$lib/persist/idb-kv';

/**
 * 对话信息展示的响应式包装：启动时从 localStorage 载入勾选状态（写盘同步），
 * 从 IndexedDB 载入通知已读游标（每会话一条，走 `lib/persist/idb-kv` 通用
 * 封装，与消息隐藏覆盖 / composer 草稿同一套管道）。消息列表（MessageList，
 * 覆盖 ChatView / CardChat / 委派详情等全部会话面）与项目组沟通 tab 未读徽标
 * 共用同一份 prefs——可开关类目按各自默认值呈现（任务卡默认常驻，其余通知类
 * 未勾选时按未读 / 已读放行），显式勾选覆盖默认。
 *
 * 通知已读游标同住这里：由 ChatSession 在 markRead（用户真正看过消息的唯一
 * 收口）时推进；MessageList 按它判断未勾选类目条目的未读 / 已读。游标走
 * IndexedDB 是因为会话（尤其任务卡会话）按使用量增长无上限，localStorage
 * 会撞每源配额；读取全部走内存 `$state`（启动时一次性载入），过滤保持同步。
 */

const NOTICE_READ_DB_NAME = 'kepcup.chat-display';
const NOTICE_READ_DB_VERSION = 1;
const NOTICE_READ_STORE = 'notice-read-through';

/**
 * 打开通知已读游标库（按会话一条记录）；传入 null（node 测试 / 隐私模式下
 * `globalThis.indexedDB` 缺席）返回 null，游标只留内存态。
 */
export function openNoticeReadKv(
  factory: IdbKvFactory | null | undefined,
): Promise<IdbKvDatabase> | null {
  if (factory === undefined || factory === null) return null;
  return factory.open(NOTICE_READ_DB_NAME, NOTICE_READ_DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(NOTICE_READ_STORE)) db.createObjectStore(NOTICE_READ_STORE);
  });
}

/** 浏览器默认库；IndexedDB 缺席为 null（node 单测注入内存替身）。 */
function defaultNoticeReadKv(): Promise<IdbKvDatabase> | null {
  const factory = globalThis.indexedDB;
  return openNoticeReadKv(factory === undefined || factory === null ? null : createBrowserIdbKvFactory(factory));
}

/**
 * 全量载入游标：只认有限非负数字（坏值丢弃，当没存过）；IndexedDB 缺席 /
 * 打开失败按空表兜底（本会话内照常工作，仅不跨重启记忆）。
 */
async function loadNoticeReadCursors(
  db: Promise<IdbKvDatabase> | null,
): Promise<Record<string, number>> {
  if (db === null) return {};
  try {
    const entries = await (await db).store(NOTICE_READ_STORE).getEntries();
    const cursors: Record<string, number> = {};
    for (const { key, value } of entries) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) cursors[key] = value;
    }
    return cursors;
  } catch {
    return {};
  }
}

export class ChatDisplayState {
  prefs = $state<ChatDisplayPrefs>(loadChatDisplayPrefs(globalThis.localStorage ?? null));
  /** 会话通知已读游标（内存镜像，启动时从 IndexedDB 一次性载入）。 */
  #noticeRead = $state<Record<string, number>>({});
  #kvDb: Promise<IdbKvDatabase> | null;
  /**
   * 游标库是否已载入。未载入期间 `noticeReadThrough` 返回 +∞（未勾选类目
   * 暂按已读兜底）：宁可让未读通知在载入完成后的下一帧才出现，也不能让
   * 已读条目先闪现、游标一到又消失。必须是 `$state`——MessageList 的
   * `display` 派生在 +∞ 早退分支读不到 `#noticeRead`，只有这个标志翻转才
   * 能让派生失效重算。载入通常在首次会话取数完成之前结束。
   */
  #noticeReadLoaded = $state(false);

  /** `db` 可注入（node 单测用内存替身）；缺省连浏览器 IndexedDB。 */
  constructor(db: Promise<IdbKvDatabase> | null = defaultNoticeReadKv()) {
    this.#kvDb = db;
    void this.#loadNoticeRead();
  }

  async #loadNoticeRead(): Promise<void> {
    const loaded = await loadNoticeReadCursors(this.#kvDb);
    // max 合并：载入期间（await 之前）markRead 可能已推进过内存游标，且更新。
    this.#noticeRead = mergeNoticeReadCursors(loaded, this.#noticeRead);
    this.#noticeReadLoaded = true;
  }

  /** 该可开关类目当前是否常驻显示（显式勾选优先，缺省按各项默认值）。 */
  isEnabled(key: ChatDisplayToggleKey): boolean {
    return isChatDisplayKeyEnabled(this.prefs, key);
  }

  /** 勾选 / 取消勾选：更新内存态并落 localStorage（只落与默认不同的键）。 */
  set(key: ChatDisplayToggleKey, visible: boolean): void {
    this.prefs = { ...this.prefs, [key]: visible };
    saveChatDisplayPrefs(globalThis.localStorage ?? null, this.prefs);
  }

  /** 该会话的通知已读游标（未载入 = +∞ 兜底；没记录 = 0 = 窗口内全未读）。 */
  noticeReadThrough(source: string, conversationId: string): number {
    if (!this.#noticeReadLoaded) return Number.POSITIVE_INFINITY;
    return this.#noticeRead[noticeReadKey(source, conversationId)] ?? 0;
  }

  /**
   * 推进通知已读游标（只进不退；无变化不写盘；写盘异步单条，不阻塞过滤）。
   * 未载入完成前不推进：此时读取侧是 +∞（什么都没显示过），先推进游标会把
   * 没显示过的未读永久标成已读——等载入后的下一次 markRead 用真实游标提交。
   */
  advanceNoticeReadThrough(source: string, conversationId: string, seq: number): void {
    if (!this.#noticeReadLoaded) return;
    const key = noticeReadKey(source, conversationId);
    if (seq <= (this.#noticeRead[key] ?? 0)) return;
    this.#noticeRead = { ...this.#noticeRead, [key]: seq };
    const db = this.#kvDb;
    if (db === null) return;
    void db
      .then((handle) => handle.store(NOTICE_READ_STORE).put(key, seq))
      .catch(() => {
        // 写失败只影响跨重启记忆，内存态仍正确。
      });
  }
}

export const chatDisplay = new ChatDisplayState();
