import type { Message } from '@kepcup/shared';
// 相对导入：本模块被纯逻辑单测（desktop 项目）直接引入，那边没有 $lib 别名。
import { SETTING_CARD_EVENT } from '@kepcup/shared';

/**
 * 对话信息展示（设置 → 通用 →「对话信息展示设置」）：用户可选哪些内容出现在
 * Bot 对话列表里。核心原则——Bot 是用户的员工：用户消息、Bot 消息、委派提示、
 * Bot 的产物（汇报 / 组件）以及需要用户接手的交互卡（初始化访谈、任务提问、
 * 设置卡、协作暂停卡、决议卡）和执行状态行都是**对话本身或必须接手的事**，
 * 始终显示（锁定，不可取消）。
 *
 * 通知与过程类内容（系统通知、定时任务卡、审批回执、邮件 / IM / 监看到达
 * 摘要、交接记录）默认不常驻：**未勾选的类目不再硬隐藏**——30 天内的未读
 * 条目仍会出现在对话里让用户看见，已读（打开过该会话）或超 30 天未读的
 * 条目不再显示；已显示的条目在本次查看期间保持可见（视图 keep 集合，见
 * `NoticeDisplayState`），直到用户切换主体内容（会话被切换 / 关闭）才收起。
 * 勾选了的类目照旧常驻显示；任务卡是任务的进度与结果汇报，默认常驻（用户
 * 可取消）。
 *
 * 值只存渲染层：勾选状态在 localStorage（owner = 'renderer'，core 读不到也
 * 写不了），只记与默认不同的显式选择，缺省（没存）= 按 `CHAT_DISPLAY_DEFAULTS`。
 * 通知已读游标按会话一条（`{source}:{conversationId}` → seq），走 IndexedDB
 * ——会话（尤其任务卡会话）按使用量增长、无上限，localStorage 会撞每源配额。
 * 没有记录的会话游标为 0，30 天内的历史存量条目全部按未读处理（会出现一次，
 * 看过后收起）。这里只放纯数据与纯函数，响应式与 IndexedDB 包装在
 * `chat-display.svelte.ts`。
 */

/** 锁定类：一定显示，不出现在勾选列表的可操作区（设置页只作说明展示）。 */
export const CHAT_DISPLAY_LOCKED_KEYS = [
  'userMessages',
  'botMessages',
  'delegation',
  'botOutputs',
  'setupInterview',
  'taskQuestion',
  'settingCards',
  'episodePaused',
  'resolutionCards',
  'runStatusLines',
] as const;
export type ChatDisplayLockedKey = (typeof CHAT_DISPLAY_LOCKED_KEYS)[number];

/** 可开关类：默认状态见 `CHAT_DISPLAY_DEFAULTS`（用户勾选可覆盖默认）。 */
export const CHAT_DISPLAY_TOGGLE_KEYS = [
  'taskCards',
  'systemNotices',
  'scheduleCards',
  'approvalReceipts',
  'mailCards',
  'imCards',
  'watchCards',
  'handoverNotes',
] as const;
export type ChatDisplayToggleKey = (typeof CHAT_DISPLAY_TOGGLE_KEYS)[number];

/**
 * 可开关类目的默认勾选状态：任务结果是要看的汇报，任务卡默认显示；其余
 * 通知 / 过程类默认隐藏（用户在设置里勾选后才出现）。
 */
export const CHAT_DISPLAY_DEFAULTS: Readonly<Record<ChatDisplayToggleKey, boolean>> = {
  taskCards: true,
  systemNotices: false,
  scheduleCards: false,
  approvalReceipts: false,
  mailCards: false,
  imCards: false,
  watchCards: false,
  handoverNotes: false,
};

/** 该类目当前是否显示：显式勾选优先，没动过用默认值。 */
export function isChatDisplayKeyEnabled(
  prefs: ChatDisplayPrefs,
  key: ChatDisplayToggleKey,
): boolean {
  return prefs[key] ?? CHAT_DISPLAY_DEFAULTS[key];
}

/** 本地存储里的勾选状态：只记可开关类；缺省 = 按 `CHAT_DISPLAY_DEFAULTS`。 */
export type ChatDisplayPrefs = Partial<Record<ChatDisplayToggleKey, boolean>>;

const CHAT_DISPLAY_STORAGE_KEY = 'kepcup.chat-display';

/**
 * 从 localStorage 读勾选状态：只认已登记键的布尔值（用户的显式选择，含
 * 与默认不同的关 / 开），坏数据丢弃。缺省键在读取侧按默认值解释。
 */
export function loadChatDisplayPrefs(storage: Storage | null): ChatDisplayPrefs {
  if (storage === null) return {};
  let raw: string | null;
  try {
    raw = storage.getItem(CHAT_DISPLAY_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object') return {};
  const prefs: ChatDisplayPrefs = {};
  for (const key of CHAT_DISPLAY_TOGGLE_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'boolean') prefs[key] = value;
  }
  return prefs;
}

/** 勾选状态落 localStorage（只落与默认不同的键；写失败静默：偏好丢一帧无碍）。 */
export function saveChatDisplayPrefs(storage: Storage | null, prefs: ChatDisplayPrefs): void {
  if (storage === null) return;
  const changed: ChatDisplayPrefs = {};
  for (const key of CHAT_DISPLAY_TOGGLE_KEYS) {
    const value = prefs[key];
    if (value !== undefined && value !== CHAT_DISPLAY_DEFAULTS[key]) changed[key] = value;
  }
  try {
    storage.setItem(CHAT_DISPLAY_STORAGE_KEY, JSON.stringify(changed));
  } catch {
    // 配额 / 隐私模式写入失败：保持内存态即可。
  }
}

export type ChatDisplayCategory = ChatDisplayToggleKey;

/**
 * 消息 → 可开关类目：返回 null 表示不属于任何可关类目（锁定类消息，或
 * transcript-visibility 已另行过滤的消息），始终可见。
 *
 * 映射与 MessageBubble 的渲染调度一致：system_event 按事件名、card 按卡型。
 * 需要用户接手的交互卡（访谈 / 任务提问 / 设置卡 / 暂停卡 / 决议卡 / 路由）
 * 都是锁定类，不在这里返回。
 */
export function chatDisplayCategory(message: Message): ChatDisplayCategory | null {
  if (message.kind === 'system_event' && 'event' in message.content) {
    switch (message.content.event) {
      case 'schedule_created':
      case 'schedule_offer':
        return 'scheduleCards';
      case 'bot_handover':
      case 'bot_handed_over':
        return 'handoverNotes';
      // route_suggestion（管家路由）、初始化访谈、任务提问、设置卡、协作
      // 暂停卡：需要用户接手，锁定不可关。按事件名归类、不看 payload——
      // core 发射侧必带 payload（访谈带 options、设置卡带 setting），缺
      // payload 的存量行会落灰色提示条形态，但按锁定处理无害（不会误藏）。
      case 'route_suggestion':
      case 'bot_setup_question':
      case 'bot_setup_path_question':
      case 'task_question':
      case SETTING_CARD_EVENT:
      case 'episode_paused':
        return null;
      // 其余 system 事件（执行中断、成员变动、消息编辑、mail_status /
      // watch_status 等）都是居中灰色提示条 → 系统通知（默认隐藏）。
      default:
        return 'systemNotices';
    }
  }
  if (message.kind === 'card' && 'cardType' in message.content) {
    switch (message.content.cardType) {
      case 'task':
        return 'taskCards';
      case 'mail':
        return 'mailCards';
      case 'im':
        return 'imCards';
      case 'watch':
        return 'watchCards';
      // resolution（决议卡）锁定；present / bot_widget / mcp_app（Bot 产物）
      // 与 delegation_*（委派）锁定；带 approvalId 的其余卡是留在消息流里的
      // 审批回执（默认隐藏）。
      default:
        return 'approvalId' in message.content ? 'approvalReceipts' : null;
    }
  }
  return null;
}

/** 该消息是否应出现在对话列表里（transcript-visibility 之后的展示层开关）。
 *
 * `notice` 缺省 = 旧行为（未勾选类目一律隐藏，纯逻辑单测与旧调用方用）。
 * 消息列表（MessageList）传入当前会话的通知已读状态：未勾选类目按「未读、
 * 未过 30 天窗口，或本次查看期间已显示（keep 集合）」放行。
 */
export function isVisibleWithChatDisplay(
  message: Message,
  prefs: ChatDisplayPrefs,
  notice?: NoticeDisplayState,
  now: number = Date.now(),
): boolean {
  const category = chatDisplayCategory(message);
  if (category === null || isChatDisplayKeyEnabled(prefs, category)) return true;
  if (notice === undefined) return false;
  return isNoticeVisible(message, notice, now);
}

/**
 * 未勾选类目的通知已读状态（每个打开的会话一份）：
 * - `readThrough`：该会话的通知已读游标（渲染层 IndexedDB 持久化）。用户
 *   真正看过消息时推进（markRead 的守卫——工作台遮罩、只读——天然保证「看过
 *   才推进」）；`seq ≤ readThrough` 的未勾选条目视为已读，不再显示。
 * - `keepIds`：本次查看期间已显示过的未读条目 id（挂在 `ChatSessionView`
 *   上，随视图切换 / 关闭一起丢弃）。已读判定会在查看中途越过它们（打开
 *   会话即 markRead），keep 集合保证这些条目**保持可见**直到切换主体内容，
 *   否则条目会在标已读的一瞬间消失，用户根本来不及查看。
 */
export interface NoticeDisplayState {
  readThrough: number;
  keepIds?: ReadonlySet<string>;
}

/**
 * 未读通知的保留窗口（设置 → 通用 → 对话信息展示）：未勾选类目的条目超过
 * 30 天仍未读的，不再自动出现在对话里（历史积压不轰炸，需要时翻记录）。
 * 只约束未勾选类目——锁定类（对话本身）与勾选了的类目不受影响。
 */
export const NOTICE_UNREAD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** 该通知条目是否还在 30 天保留窗口内（`createdAt` 为 UTC 毫秒）。 */
export function isNoticeFresh(message: Message, now: number): boolean {
  return message.createdAt >= now - NOTICE_UNREAD_MAX_AGE_MS;
}

/**
 * 未勾选类目条目当前是否显示：本次查看已显示过的（keep）保持可见（豁免
 * 过期——显示到一半被抽走更糟）；否则要求未读且仍在 30 天窗口内。
 */
export function isNoticeVisible(
  message: Message,
  notice: NoticeDisplayState,
  now: number,
): boolean {
  if (notice.keepIds?.has(message.id)) return true;
  return message.seq > notice.readThrough && isNoticeFresh(message, now);
}

/** 游标存储键：会话 id 在来源之间不保证唯一（本机 / 各团队），键带来源。 */
export function noticeReadKey(source: string, conversationId: string): string {
  return `${source}:${conversationId}`;
}

/**
 * 启动载入与早期推进的合并：游标只进不退，两边取大。IndexedDB 异步载入
 * 期间内存里可能已有 markRead 推进过的新值，不能被库里的旧值覆盖。
 */
export function mergeNoticeReadCursors(
  loaded: Record<string, number>,
  pending: Record<string, number>,
): Record<string, number> {
  const merged = { ...loaded };
  for (const [key, seq] of Object.entries(pending)) {
    if (seq > (merged[key] ?? 0)) merged[key] = seq;
  }
  return merged;
}
