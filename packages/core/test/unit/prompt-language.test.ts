import { describe, expect, it } from 'vitest';
import type { Bot, Conversation } from '@kepcup/shared';
import { botProfileSchema } from '@kepcup/shared';
import { buildSystemPrompt } from '../../src/agent/context/system-prompt.js';
import {
  butlerProfileTemplate,
  butlerSetupFirstOptions,
  butlerSetupFirstQuestion,
  butlerSetupGreeting,
  butlerWelcomeText,
} from '../../src/domain/butler.js';
import {
  setupFirstOptions,
  setupFirstQuestion,
  setupGreeting,
  setupPathQuestion,
  setupPathSkipText,
} from '../../src/tools/setup-tools.js';

function makeBot(id: string, name: string): Bot {
  return {
    id,
    name,
    avatar: null,
    bio: '',
    profile: botProfileSchema.parse({ identity: { name } }),
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

const conversation: Conversation = {
  id: 'conv_1',
  type: 'direct',
  title: null,
  directBotId: 'bot_1',
  readOnly: false,
  summary: null,
  summaryUptoSeq: 0,
  lastSeq: 0,
  lastReadSeq: 0,
  lastMessageAt: null,
  createdAt: 0,
} as Conversation;

describe('language-aware prompts and deterministic copy', () => {
  it('prompts match the user language with a system-language fallback, and English interview guidance', () => {
    const bot = makeBot('bot_butler', 'Butler');
    bot.systemRole = 'butler';
    bot.setupState = 'interviewing';
    const prompt = buildSystemPrompt({
      bot,
      conversation,
      timeZone: 'UTC',
      now: new Date('2026-01-01T00:00:00Z'),
      language: 'en-US',
      loop: 'turn',
    });
    expect(prompt).toContain('<language_rules>');
    expect(prompt).toContain("Reply in the same language as the user's most recent message");
    expect(prompt).toContain('reply in English');
    expect(prompt).toContain('This is a new-user onboarding interview');
    expect(prompt).not.toContain('这是新用户的入门访谈');

    const generic = makeBot('bot_1', 'Helper');
    generic.setupState = 'interviewing';
    const genericPrompt = buildSystemPrompt({
      bot: generic,
      conversation,
      timeZone: 'UTC',
      now: new Date('2026-01-01T00:00:00Z'),
      language: 'en-US',
    });
    expect(genericPrompt).toContain('You have just been created and your profile is empty');
    expect(genericPrompt).not.toContain('你刚刚被创建');
  });

  it('Chinese remains the default', () => {
    const prompt = buildSystemPrompt({
      bot: makeBot('bot_1', '助手'),
      conversation,
      timeZone: 'Asia/Shanghai',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(prompt).toContain('使用用户最近一条消息的语言回复');
    expect(prompt).toContain('没有用户消息时');
  });

  it('butler profile, greeting, first question, options and welcome follow the language', () => {
    expect(butlerProfileTemplate('en-US').identity.name).toBe('Butler');
    expect(butlerProfileTemplate('zh-CN').identity.name).toBe('管家');
    expect(butlerSetupGreeting('en-US')).toMatch(/Butler/);
    expect(butlerSetupFirstQuestion('en-US')).toBe('What areas do you mostly need help with?');
    expect(butlerSetupFirstOptions('en-US')).toContain('Learning and research');
    expect(butlerWelcomeText('en-US')).toMatch(/^Hi,/);

    expect(setupGreeting('en-US')).toMatch(/new assistant/);
    expect(setupFirstQuestion('en-US')).toBe('What would you like me to help you with?');
    expect(setupFirstOptions('en-US')).toContain('Programming and development');
    expect(setupPathQuestion('en-US')).toMatch(/working directory/);
    expect(setupPathSkipText('en-US')).toBe('No working directory for now');
  });
});
