import { describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import { zhCN } from '../../i18n/locales/zh-CN';
import {
  CHAT_DISPLAY_DEFAULTS,
  CHAT_DISPLAY_LOCKED_KEYS,
  CHAT_DISPLAY_TOGGLE_KEYS,
  chatDisplayCategory,
  isChatDisplayKeyEnabled,
  isVisibleWithChatDisplay,
  loadChatDisplayPrefs,
  saveChatDisplayPrefs,
} from './chat-display';

/**
 * 对话信息展示（设置 → 通用）的纯逻辑：类目映射与 MessageBubble 渲染调度
 * 一致；可开关类目默认隐藏（勾选才显示），锁定类目永远可见。
 */

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
