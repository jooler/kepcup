import { describe, expect, it } from 'vitest';
import { botProfileSchema, type Bot, type Conversation } from '@kepcup/shared';
import { buildSystemPrompt } from '../../src/agent/context/system-prompt.js';

/**
 * 语音对话模式提示词（docs/design/53-voice-conversation.md 修订 v3）：只在
 * 对话轮且会话处于语音模式时注入 `<voice_conversation>`——立刻简短反馈（先
 * send_message 再拉起任务）、结论式回复、口语化、不调语音合成工具；普通
 * 对话轮与任务轮都不出现。
 */

function bot(): Bot {
  return {
    id: 'bot_1',
    name: '助手',
    avatar: null,
    bio: '',
    profile: botProfileSchema.parse({
      identity: { name: '助手', bio: '' },
      persona: { personality: '' },
      role: { expertise: '' },
      boundaries: [],
      runtime: { model: '', light_model: '' },
    }),
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

function conversation(): Conversation {
  return {
    id: 'conv_1',
    type: 'direct',
    title: '助手',
    directBotId: 'bot_1',
    leadBotId: null,
    parentProjectId: null,
    cardTodoId: null,
    workdirId: null,
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 0,
  };
}

function prompt(overrides: Record<string, unknown> = {}): string {
  return buildSystemPrompt({
    loop: 'turn',
    bot: bot(),
    conversation: conversation(),
    timeZone: 'Asia/Shanghai',
    now: new Date(0),
    ...overrides,
  });
}

describe('buildSystemPrompt 语音对话模式', () => {
  it('语音模式的对话轮注入 <voice_conversation>（反馈 / 结论 / 口语化 / 不合成）', () => {
    const text = prompt({ voiceMode: true });
    expect(text).toContain('<voice_conversation>');
    expect(text).toContain('立刻给反馈');
    expect(text).toContain('send_message');
    expect(text).toContain('只给结论');
    expect(text).toContain('没有待提交文件');
    expect(text).toContain('不要调用 generate_speech');
  });

  it('非语音模式 / 缺省不带该段（其余提示词不受影响）', () => {
    expect(prompt()).not.toContain('<voice_conversation>');
    expect(prompt({ voiceMode: false })).not.toContain('<voice_conversation>');
    expect(prompt()).toContain('<platform_rules>');
  });

  it('任务轮即使是语音模式会话也不注入（任务结果由对话轮转述）', () => {
    const text = prompt({ loop: 'task', voiceMode: true });
    expect(text).not.toContain('<voice_conversation>');
  });

  it('英文界面用英文规则（同一条 immediate feedback / conclusion-only 约束）', () => {
    const text = prompt({ voiceMode: true, language: 'en-US' });
    expect(text).toContain('You are in voice conversation mode');
    expect(text).toContain('start_task');
    expect(text).toContain('Do not call generate_speech');
    expect(text).not.toContain('立刻给反馈');
  });
});
