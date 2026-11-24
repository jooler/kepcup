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
 * 摘要、交接记录）默认隐藏，用户在设置里勾选后才出现；任务卡是任务的进度
 * 与结果汇报，默认显示（用户可取消）。
 *
 * 值只存渲染层 localStorage（owner = 'renderer'，core 读不到也写不了），存储
 * 只记与默认不同的显式选择；缺省（没存）= 按 `CHAT_DISPLAY_DEFAULTS`。这里
 * 只放纯数据与纯函数，响应式包装在 `chat-display.svelte.ts`。
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

/** 该消息是否应出现在对话列表里（transcript-visibility 之后的展示层开关）。 */
export function isVisibleWithChatDisplay(message: Message, prefs: ChatDisplayPrefs): boolean {
  const category = chatDisplayCategory(message);
  return category === null || isChatDisplayKeyEnabled(prefs, category);
}
