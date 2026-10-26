import { describe, expect, it } from 'vitest';
import { botProfileSchema, type Bot, type Conversation } from '@kepcup/shared';
import { buildSystemPrompt, CARD_RULES } from '../../src/agent/context/system-prompt.js';

/**
 * Card-chat prompt (D103 §7.1): the conversation_info branch, CARD_RULES, and
 * the absence of project lead / member rules.
 */

function bot(): Bot {
  return {
    id: 'bot_member',
    name: '成员乙',
    avatar: null,
    bio: '成员乙的简介',
    profile: botProfileSchema.parse({
      identity: { name: '成员乙', bio: '成员乙的简介' },
      persona: { personality: '严谨' },
      role: { expertise: '编程' },
      boundaries: [],
      runtime: { model: '', light_model: '' },
    }),
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

function cardConversation(): Conversation {
  return {
    id: 'conv_card',
    type: 'card',
    title: 'Ship the notes',
    directBotId: 'bot_member',
    leadBotId: null,
    parentProjectId: 'conv_project',
    cardTodoId: 'todo_card',
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
    conversation: cardConversation(),
    timeZone: 'Asia/Shanghai',
    now: new Date(0),
    projectRole: 'lead',
    members: [
      { id: 'bot_lead', name: '负责人甲', bio: '简介', role: '职责', isLead: true },
    ],
    card: {
      projectName: '发布项目组',
      goal: '把每个版本按时发布',
      text: '写完发布说明',
      statusLabel: '待开始',
      columnName: '进行中',
      scheduleWhen: '工作日 09:00',
      wikiTopics: '- 发布流程（pages/release.md）',
    },
    projectWikiTopics: '项目 wiki 由多人维护。\n- 发布流程（pages/release.md）',
    ...overrides,
  } as never);
}

describe('card conversation prompt', () => {
  it('renders the card branch with a schedule, a goal, and the wiki topic section', () => {
    const text = prompt();
    expect(text).toContain('对话类型：项目组「发布项目组」看板卡片对话（仅你与用户）');
    expect(text).toContain('项目目标：把每个版本按时发布');
    expect(text).toContain('卡片（待开始，分栏「进行中」）：\n写完发布说明');
    expect(text).toContain('执行时间：工作日 09:00');
    expect(text).toContain('项目 wiki：');
    expect(text).toContain('- 发布流程（pages/release.md）');
    expect(text).toContain('<project_wiki_topics>');
    expect(text).toContain('<card_rules>');
    expect(text).toContain(CARD_RULES);
    expect(text).not.toContain('<project_lead_rules>');
    expect(text).not.toContain('<project_member_rules>');
    expect(text).not.toContain('项目负责人：');
    expect(text).not.toContain('成员名片：');
    expect(text).not.toContain('你是本项目组的负责人');
    expect(text).not.toContain('你是本项目组的成员');
  });

  it('omits the goal, the schedule, and the wiki section when they are absent', () => {
    const text = prompt({
      card: {
        projectName: '发布项目组',
        goal: null,
        text: '只写正文',
        statusLabel: '执行中',
        columnName: 'Todo',
        scheduleWhen: null,
      },
      projectWikiTopics: undefined,
    });
    expect(text).toContain('卡片（执行中，分栏「Todo」）：\n只写正文');
    expect(text).toContain('看板卡片对话（仅你与用户）');
    expect(text).not.toContain('项目目标：');
    expect(text).not.toContain('执行时间：');
    expect(text).not.toContain('项目 wiki：');
    expect(text).not.toContain('<project_wiki_topics>');
    expect(text).toContain('<card_rules>');
    expect(text).not.toContain('<project_lead_rules>');
    expect(text).not.toContain('<project_member_rules>');
  });

  it('does not inject card rules into a direct chat', () => {
    const text = buildSystemPrompt({
      loop: 'turn',
      bot: bot(),
      conversation: {
        ...cardConversation(),
        id: 'conv_direct',
        type: 'direct',
        title: null,
        parentProjectId: null,
        cardTodoId: null,
      },
      timeZone: 'UTC',
      now: new Date(0),
    });
    expect(text).toContain('对话类型：单聊（你与用户一对一）');
    expect(text).not.toContain('<card_rules>');
    expect(text).not.toContain('看板卡片对话');
  });
});
