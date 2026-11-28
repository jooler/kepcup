import { describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import { zhCN } from '../../i18n/locales/zh-CN';
import {
  CHAT_DISPLAY_DEFAULTS,
  CHAT_DISPLAY_LOCKED_KEYS,
  CHAT_DISPLAY_TOGGLE_KEYS,
  NOTICE_UNREAD_MAX_AGE_MS,
  chatDisplayCategory,
  isChatDisplayKeyEnabled,
  isNoticeFresh,
  isNoticeVisible,
  isVisibleWithChatDisplay,
  loadChatDisplayPrefs,
  mergeNoticeReadCursors,
  noticeReadKey,
  saveChatDisplayPrefs,
  type NoticeDisplayState,
} from './chat-display';

/**
 * 对话信息展示（设置 → 通用）的纯逻辑：类目映射与 MessageBubble 渲染调度
 * 一致；可开关类勾选后常驻（任务卡默认常驻），未勾选类目按未读 / 已读放行
 * （30 天保留窗口），锁定类目永远可见。
 */

/** 固定「现在」，避免依赖真实时钟。 */
const NOW = 1_800_000_000_000;
/** 窗口内（一分钟前）与窗口外（超期一分钟）的时间点。 */
const FRESH = NOW - 60_000;
const STALE = NOW - NOTICE_UNREAD_MAX_AGE_MS - 60_000;

type MsgInit = Partial<Omit<Message, 'content'>> &
  Pick<Message, 'id' | 'kind' | 'senderType'> & { content?: unknown };

function msg(partial: MsgInit): Message {
  return {
    conversationId: 'c1',
    seq: 1,
    content: { text: 'hi' },
    status: 'normal',
    createdAt: 1,
    runId: null,
    senderBotId: null,
    batchId: null,
    replyTo: null,
    ...partial,
  } as Message;
}

/** 邮件通知卡（可开关类目的代表），显式给 id / seq / createdAt。 */
function mailAt(id: string, seq: number, createdAt: number): Message {
  return msg({ id, seq, kind: 'card', senderType: 'bot', content: { cardType: 'mail' }, createdAt });
}

describe('chatDisplayCategory（与 MessageBubble 渲染调度一致）', () => {
  it('system_event：可开关的只有定时卡与交接记录，其余灰色提示条归系统通知', () => {
    const event = (name: string, content: Record<string, unknown> = {}) =>
      msg({ id: 'm', kind: 'system_event', senderType: 'system', content: { event: name, ...content } });
    expect(chatDisplayCategory(event('schedule_created'))).toBe('scheduleCards');
    expect(chatDisplayCategory(event('schedule_offer'))).toBe('scheduleCards');
    expect(chatDisplayCategory(event('bot_handover'))).toBe('handoverNotes');
    expect(chatDisplayCategory(event('bot_handed_over'))).toBe('handoverNotes');
    expect(chatDisplayCategory(event('run_interrupted'))).toBe('systemNotices');
    expect(chatDisplayCategory(event('project_member_joined'))).toBe('systemNotices');
    expect(chatDisplayCategory(event('mail_status'))).toBe('systemNotices');
  });

  it('system_event：需用户接手的交互卡都是锁定类（返回 null）', () => {
    const event = (name: string, content: Record<string, unknown> = {}) =>
      msg({ id: 'm', kind: 'system_event', senderType: 'system', content: { event: name, ...content } });
    // 委托提示（管家路由）与委派卡同族。
    expect(chatDisplayCategory(event('route_suggestion'))).toBe(null);
    // 初始化访谈（问题卡 / 工作目录卡）、任务提问、对话内设置卡、协作暂停卡。
    expect(chatDisplayCategory(event('bot_setup_question', { options: ['a'] }))).toBe(null);
    expect(chatDisplayCategory(event('bot_setup_path_question'))).toBe(null);
    expect(chatDisplayCategory(event('task_question'))).toBe(null);
    expect(chatDisplayCategory(event('setting_card', { setting: {} }))).toBe(null);
    expect(chatDisplayCategory(event('episode_paused'))).toBe(null);
  });

  it('card：任务 / 邮件 / IM / 监看可开关；审批回执归可开关；产物、委派与决议锁定', () => {
    const card = (cardType: string, content: Record<string, unknown> = {}) =>
      msg({ id: 'm', kind: 'card', senderType: 'bot', content: { cardType, ...content } });
    expect(chatDisplayCategory(card('task'))).toBe('taskCards');
    expect(chatDisplayCategory(card('mail'))).toBe('mailCards');
    expect(chatDisplayCategory(card('im'))).toBe('imCards');
    expect(chatDisplayCategory(card('watch'))).toBe('watchCards');
    expect(chatDisplayCategory(card('access', { approvalId: 'apr_1' }))).toBe('approvalReceipts');
    // 锁定：Bot 产物、委派、决议。
    expect(chatDisplayCategory(card('present'))).toBe(null);
    expect(chatDisplayCategory(card('bot_widget'))).toBe(null);
    expect(chatDisplayCategory(card('mcp_app'))).toBe(null);
    expect(chatDisplayCategory(card('delegation_sent'))).toBe(null);
    expect(chatDisplayCategory(card('delegation_received'))).toBe(null);
    expect(chatDisplayCategory(card('delegation_result'))).toBe(null);
    expect(chatDisplayCategory(card('resolution'))).toBe(null);
  });

  it('普通用户 / Bot 文本消息不属任何可关类目（锁定）', () => {
    expect(chatDisplayCategory(msg({ id: 'm', kind: 'text', senderType: 'user' }))).toBe(null);
    expect(chatDisplayCategory(msg({ id: 'm', kind: 'text', senderType: 'bot' }))).toBe(null);
    // 工作台派发也是用户消息（锁定）。
    expect(
      chatDisplayCategory(
        msg({ id: 'm', kind: 'text', senderType: 'user', content: { origin: 'workbench', text: 'x' } }),
      ),
    ).toBe(null);
  });
});

describe('isVisibleWithChatDisplay（可开关类按各项默认值，显式勾选覆盖）', () => {
  const mail = msg({ id: 'm', kind: 'card', senderType: 'bot', content: { cardType: 'mail' } });
  const taskCard = msg({ id: 'm', kind: 'card', senderType: 'bot', content: { cardType: 'task' } });
  const botText = msg({ id: 'm', kind: 'text', senderType: 'bot' });

  it('缺省按 CHAT_DISPLAY_DEFAULTS：任务卡显示，通知类隐藏；显式勾选覆盖', () => {
    // 每个可开关键都有默认值；任务卡默认显示，其余默认隐藏。
    for (const key of CHAT_DISPLAY_TOGGLE_KEYS) {
      expect(CHAT_DISPLAY_DEFAULTS[key]).toBe(key === 'taskCards');
    }
    // 缺省 notice（旧调用方 / 纯单测）= 旧行为：未勾选类目一律隐藏。
    expect(isVisibleWithChatDisplay(taskCard, {})).toBe(true);
    expect(isVisibleWithChatDisplay(taskCard, { taskCards: false })).toBe(false);
    expect(isVisibleWithChatDisplay(mail, {})).toBe(false);
    expect(isVisibleWithChatDisplay(mail, { mailCards: true })).toBe(true);
    // Bot 文本永远是 Bot 消息：任何勾选状态都可见。
    expect(isVisibleWithChatDisplay(botText, {})).toBe(true);
  });

  it('isChatDisplayKeyEnabled：显式值优先，缺省回落默认', () => {
    expect(isChatDisplayKeyEnabled({}, 'taskCards')).toBe(true);
    expect(isChatDisplayKeyEnabled({ taskCards: false }, 'taskCards')).toBe(false);
    expect(isChatDisplayKeyEnabled({}, 'mailCards')).toBe(false);
    expect(isChatDisplayKeyEnabled({ mailCards: true }, 'mailCards')).toBe(true);
  });
});

describe('未勾选类目的通知可见性（未读显示、已读收起、30 天窗口、keep 豁免）', () => {
  const hidden = { mailCards: false };

  it('未读且在窗口内 → 显示；已读（seq ≤ 游标）→ 不再显示', () => {
    const notice: NoticeDisplayState = { readThrough: 10 };
    expect(isVisibleWithChatDisplay(mailAt('a', 11, FRESH), hidden, notice, NOW)).toBe(true);
    expect(isVisibleWithChatDisplay(mailAt('b', 10, FRESH), hidden, notice, NOW)).toBe(false);
    expect(isVisibleWithChatDisplay(mailAt('c', 5, FRESH), hidden, notice, NOW)).toBe(false);
  });

  it('超 30 天未读 → 不再显示（历史积压不轰炸）；勾选了的类目不受窗口影响', () => {
    const notice: NoticeDisplayState = { readThrough: 0 };
    expect(isVisibleWithChatDisplay(mailAt('a', 11, STALE), hidden, notice, NOW)).toBe(false);
    expect(isVisibleWithChatDisplay(mailAt('a', 11, STALE), { mailCards: true }, notice, NOW)).toBe(
      true,
    );
  });

  it('keep 集合（本次查看已显示）豁免已读与过期——保持可见直到切换主体内容', () => {
    const notice: NoticeDisplayState = { readThrough: 20, keepIds: new Set(['kept']) };
    // kept：seq 15 已被游标越过、createdAt 已过期，仍要显示（显示到一半被
    // 抽走更糟）；其余已读条目照常隐藏。
    expect(isVisibleWithChatDisplay(mailAt('kept', 15, STALE), hidden, notice, NOW)).toBe(true);
    expect(isVisibleWithChatDisplay(mailAt('other', 15, FRESH), hidden, notice, NOW)).toBe(false);
  });
});

describe('通知已读游标的纯逻辑（IndexedDB 值的载入 / 合并 / 新鲜度）', () => {
  it('noticeReadKey：键带来源（本机与团队会话 id 不保证唯一）', () => {
    expect(noticeReadKey('local', 'conv1')).toBe('local:conv1');
    expect(noticeReadKey('team_a', 'conv1')).toBe('team_a:conv1');
  });

  it('isNoticeFresh：createdAt 距今 30 天为界（UTC 毫秒）', () => {
    const at = (offsetFromNow: number): Message =>
      msg({ id: 'm', kind: 'text', senderType: 'bot', createdAt: NOW + offsetFromNow });
    expect(isNoticeFresh(at(-NOTICE_UNREAD_MAX_AGE_MS), NOW)).toBe(true);
    expect(isNoticeFresh(at(-NOTICE_UNREAD_MAX_AGE_MS - 1), NOW)).toBe(false);
  });

  it('isNoticeVisible：未读且窗口内显示；keep 豁免已读与过期', () => {
    const notice: NoticeDisplayState = { readThrough: 5 };
    expect(isNoticeVisible(mailAt('a', 6, FRESH), notice, NOW)).toBe(true);
    expect(isNoticeVisible(mailAt('b', 5, FRESH), notice, NOW)).toBe(false);
    expect(isNoticeVisible(mailAt('c', 6, STALE), notice, NOW)).toBe(false);
    expect(
      isNoticeVisible(mailAt('d', 5, STALE), { ...notice, keepIds: new Set(['d']) }, NOW),
    ).toBe(true);
  });

  it('mergeNoticeReadCursors：max 合并——启动载入不回退早期推进', () => {
    expect(mergeNoticeReadCursors({ a: 5, b: 2 }, { b: 7, c: 1 })).toEqual({ a: 5, b: 7, c: 1 });
  });
});

describe('勾选状态的存取', () => {
  it('键清单自洽：锁定与可开关无交集，且每项都有默认值', () => {
    const locked = new Set<string>(CHAT_DISPLAY_LOCKED_KEYS);
    for (const key of CHAT_DISPLAY_TOGGLE_KEYS) {
      expect(locked.has(key)).toBe(false);
      expect(typeof CHAT_DISPLAY_DEFAULTS[key]).toBe('boolean');
    }
    expect(CHAT_DISPLAY_LOCKED_KEYS.length).toBeGreaterThan(0);
    expect(CHAT_DISPLAY_TOGGLE_KEYS.length).toBeGreaterThan(0);
  });

  it('每个类目键都有设置页文案与提示（GeneralSection 用 as MessageKey 动态拼键，编译器不查，这里钉住）', () => {
    for (const key of [...CHAT_DISPLAY_LOCKED_KEYS, ...CHAT_DISPLAY_TOGGLE_KEYS]) {
      expect(zhCN[`settings.chatDisplay.${key}`], `settings.chatDisplay.${key}`).toBeDefined();
      expect(
        zhCN[`settings.chatDisplay.${key}Hint`],
        `settings.chatDisplay.${key}Hint`,
      ).toBeDefined();
    }
  });

  it('load 认已登记键的布尔值（显式选择），坏数据回空', () => {
    const storage = {
      getItem: (key: string) =>
        key === 'kepcup.chat-display'
          ? JSON.stringify({ mailCards: true, taskCards: false, bogus: 'x', watchCards: 'yes' })
          : null,
      setItem: () => {},
    } as unknown as Storage;
    expect(loadChatDisplayPrefs(storage)).toEqual({ mailCards: true, taskCards: false });
    expect(loadChatDisplayPrefs(null)).toEqual({});
    const broken = { getItem: () => 'not json', setItem: () => {} } as unknown as Storage;
    expect(loadChatDisplayPrefs(broken)).toEqual({});
  });

  it('save 只落与默认不同的键（缺省态不占存储；改回默认即从存储消失）', () => {
    let written = '';
    const storage = {
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        written = value;
      },
    } as unknown as Storage;
    // taskCards: true 是默认 → 不落；mailCards: true / taskCards: false 与默认不同 → 落。
    saveChatDisplayPrefs(storage, { mailCards: true, taskCards: false });
    expect(JSON.parse(written)).toEqual({ mailCards: true, taskCards: false });
    // 全部按默认：落空对象。
    let empty = 'x';
    const capture = {
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        empty = value;
      },
    } as unknown as Storage;
    saveChatDisplayPrefs(capture, { taskCards: true, mailCards: false });
    expect(JSON.parse(empty)).toEqual({});
    // null storage：静默不写。
    expect(() => saveChatDisplayPrefs(null, { mailCards: true })).not.toThrow();
  });
});
