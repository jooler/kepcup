import { describe, expect, it } from 'vitest';
import type { Bot, Conversation, Message } from '@kepcup/shared';
import { botProfileSchema, groupMentionToken } from '@kepcup/shared';
import { buildSystemPrompt } from '../../src/agent/context/system-prompt.js';
import {
  buildConversationContext,
  buildTriggerSegment,
  renderMessageLine,
  type RenderMessageOptions,
} from '../../src/agent/context/conversation.js';

const TIME_ZONE = 'Asia/Shanghai';

function makeBot(id: string, name: string): Bot {
  return {
    id,
    name,
    avatar: null,
    bio: '测试',
    profile: botProfileSchema.parse({
      identity: { name, bio: '测试' },
      persona: { personality: '严谨' },
      role: { expertise: '编程' },
      boundaries: ['不做坏事'],
      runtime: { model: '', light_model: '' },
    }),
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeMessage(overrides: Partial<Message> & { id: string; seq: number }): Message {
  return {
    conversationId: 'conv_1',
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    content: { text: 'hello' },
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 1_759_136_400_000,
    attachments: [],
    ...overrides,
  };
}

const renderOptions: RenderMessageOptions = {
  selfBotId: 'bot_self',
  timeZone: TIME_ZONE,
  botNames: new Map([
    ['bot_self', '我自己'],
    ['bot_other', '别人'],
    ['bot_gone', 'bot_gone'],
  ]),
};

function makeConversation(): Conversation {
  return {
    id: 'conv_1',
    type: 'direct',
    title: null,
    directBotId: 'bot_self',
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 0,
  };
}

describe('system prompt assembly', () => {
  it('butler rules follow the loop tool surface: tasks never reference turn-only proposal tools (D75/dev 30 §1.2)', () => {
    const butler = makeBot('bot_butler', '管家');
    butler.systemRole = 'butler';
    const base = {
      bot: butler,
      conversation: makeConversation(),
      timeZone: TIME_ZONE,
      now: new Date('2026-09-29T08:00:00Z'),
    };

    // 对话轮：完整规则 + 「建 Bot 直接提议、不派任务」。
    const turn = buildSystemPrompt({ ...base, loop: 'turn' });
    expect(turn).toContain('<butler_rules>');
    expect(turn).toContain('这一轮直接用 propose_* 提交提议卡');
    expect(turn).toContain('不要为此用 start_task 派任务');
    expect(turn).toContain('用 suggest_route 出一张路由卡');

    // 任务（缺省 loop）：propose_* / suggest_route / delegate_to_bot 是对话轮
    // 工具面——任务里注入对话轮版会指挥模型调用不存在的工具（只能编造「已创建」）。
    const task = buildSystemPrompt(base);
    expect(task).toContain('<butler_rules>');
    expect(task).toContain('都在对话轮工具面');
    expect(task).toContain('不要声称已经创建了任何 Bot 或群');
    expect(task).not.toContain('这一轮直接用 propose_* 提交提议卡');
    expect(task).not.toContain('用 suggest_route 出一张路由卡');
  });

  it('non-butler bots get no butler rules section', () => {
    const prompt = buildSystemPrompt({
      bot: makeBot('bot_self', '小艾'),
      conversation: makeConversation(),
      timeZone: TIME_ZONE,
      now: new Date('2026-09-29T08:00:00Z'),
    });
    expect(prompt).not.toContain('<butler_rules>');
  });

  it('assembles sections in the documented order with tags', () => {
    const prompt = buildSystemPrompt({
      bot: makeBot('bot_self', '小艾'),
      conversation: makeConversation(),
      timeZone: TIME_ZONE,
      now: new Date('2026-09-29T08:00:00Z'),
    });
    const rulesIndex = prompt.indexOf('<platform_rules>');
    const identityIndex = prompt.indexOf('<identity>');
    const personaIndex = prompt.indexOf('<persona>');
    const infoIndex = prompt.indexOf('<conversation_info>');
    expect(rulesIndex).toBeGreaterThanOrEqual(0);
    expect(identityIndex).toBeGreaterThan(rulesIndex);
    expect(personaIndex).toBeGreaterThan(identityIndex);
    expect(infoIndex).toBeGreaterThan(personaIndex);
    expect(prompt).toContain('send_message');
    expect(prompt).toContain('<untrusted>');
    expect(prompt).toContain('小艾');
    expect(prompt).toContain('不做坏事');
  });

  it('includes the P07 platform rules 8/9 and the memory sections in order', () => {
    const prompt = buildSystemPrompt({
      bot: makeBot('bot_self', '小艾'),
      conversation: makeConversation(),
      timeZone: TIME_ZONE,
      now: new Date('2026-09-29T08:00:00Z'),
      userProfile: '画像卡片内容',
      myState: '<my_state>\n- 承诺（2026-10-02 前）：交报告\n</my_state>',
      relevantMemories: '<relevant_memories>\n- [mem_1] 内容\n</relevant_memories>',
    });
    // 平台规则 9~11（P07 起；自我迭代条随对话式创建一并加入；过程沟通规则
    // 3/4 为 loop 中间过程投送新增，todo/loop-interim-updates.md）。D75 W2：
    // 缺省是任务版规则，去掉了群聊 skip_reply 一条（任务的 skip_reply 并入
    // 第 2 条「没有需要交回的内容」），编号前移一位；审查 L1：任务不 @ 群成员，
    // 「只能用 mention_bot_ids」一条也去掉，再前移一位。
    expect(prompt).toContain('8. 记忆：用户明确要求记住时调用 remember');
    expect(prompt).toContain('9. 用户可以要求你更新你自己的 Profile');
    expect(prompt).toContain('propose_profile_change');
    expect(prompt).toContain('10. 注入的记忆可能已过时');
    expect(prompt).not.toContain('mention_bot_ids');
    expect(prompt).toContain('memory_feedback');
    // 段落顺序：persona → user_profile → my_state → relevant_memories → conversation_info。
    const personaIndex = prompt.indexOf('<persona>');
    const profileIndex = prompt.indexOf('<user_profile>');
    const myStateIndex = prompt.indexOf('<my_state>');
    const memoriesIndex = prompt.indexOf('<relevant_memories>');
    const infoIndex = prompt.indexOf('<conversation_info>');
    expect(profileIndex).toBeGreaterThan(personaIndex);
    expect(myStateIndex).toBeGreaterThan(profileIndex);
    expect(memoriesIndex).toBeGreaterThan(myStateIndex);
    expect(infoIndex).toBeGreaterThan(memoriesIndex);
    expect(prompt).toContain('画像卡片内容');
    // 空段整体省略：不给注入时三个段都不出现。
    const bare = buildSystemPrompt({
      bot: makeBot('bot_self', '小艾'),
      conversation: makeConversation(),
      timeZone: TIME_ZONE,
      now: new Date('2026-09-29T08:00:00Z'),
    });
    expect(bare).not.toContain('<user_profile>');
    expect(bare).not.toContain('<my_state>');
    expect(bare).not.toContain('<relevant_memories>');
  });

  it('omits empty persona sections entirely', () => {
    const bot = makeBot('bot_self', '空白');
    bot.profile.persona = {
      personality: '',
      tone: '',
      style: '',
      values: '',
      sample_dialogues: '',
    };
    const prompt = buildSystemPrompt({
      bot,
      conversation: makeConversation(),
      timeZone: TIME_ZONE,
      now: new Date(),
    });
    expect(prompt).not.toContain('<persona>');
  });
});

describe('conversation context', () => {
  it('renders the recent window oldest-first with ids, time and sender', () => {
    const context = buildConversationContext({
      summary: '之前的摘要',
      recent: [
        makeMessage({ id: 'msg_1', seq: 1, content: { text: '第一条' } }),
        makeMessage({
          id: 'msg_2',
          seq: 2,
          senderType: 'bot',
          senderBotId: 'bot_self',
          content: { text: '回复' },
        }),
        makeMessage({
          id: 'msg_3',
          seq: 3,
          senderType: 'bot',
          senderBotId: 'bot_other',
          content: { text: '别的 bot 的话' },
        }),
      ],
      options: renderOptions,
    });
    expect(context).toContain('<summary>');
    expect(context).toContain('之前的摘要');
    const m1 = context.indexOf('msg_1');
    const m2 = context.indexOf('msg_2');
    const m3 = context.indexOf('msg_3');
    expect(m1).toBeGreaterThan(0);
    expect(m2).toBeGreaterThan(m1);
    expect(m3).toBeGreaterThan(m2);
    expect(context).toContain('我自己（你）');
    expect(context).toContain('<untrusted>别的 bot 的话</untrusted>');
  });

  it('marks edited messages and includes attachment summaries', () => {
    const context = buildConversationContext({
      summary: null,
      recent: [
        makeMessage({
          id: 'msg_9',
          seq: 9,
          status: 'edited',
          content: { text: '改过的' },
          attachments: [
            {
              id: 'att_1',
              conversationId: 'conv_1',
              messageId: 'msg_9',
              draftId: null,
              fileName: 'error.log',
              mime: 'text/plain',
              size: 12_288,
              sha256: 'x',
              relPath: 'att_1_error.log',
              createdAt: 0,
            },
          ],
        }),
      ],
      options: renderOptions,
    });
    expect(context).toContain('（已编辑）');
    expect(context).toContain('att_1 error.log [text/plain] 12KB');
  });

  it('never includes recalled messages', () => {
    const context = buildConversationContext({
      summary: null,
      recent: [
        makeMessage({ id: 'msg_1', seq: 1, status: 'recalled', content: { text: '已撤回内容' } }),
        makeMessage({ id: 'msg_2', seq: 2, content: { text: '保留' } }),
      ],
      options: renderOptions,
    });
    expect(context).not.toContain('已撤回内容');
    expect(context).toContain('保留');
  });

  it('respects the message-count and token budgets from the newest side', () => {
    const recent = Array.from({ length: 40 }, (_, i) =>
      makeMessage({ id: `msg_${i}`, seq: i + 1, content: { text: `消息内容 ${i}` } }),
    );
    const context = buildConversationContext({ summary: null, recent, options: renderOptions });
    // RECENT_MESSAGES_MAX = 30 -> the oldest 10 messages must be dropped.
    expect(context).not.toContain('msg_9 ');
    expect(context).toContain('msg_39');
    expect(context).toContain('msg_10');
  });

  it('shows deleted bots by their id', () => {
    const context = buildConversationContext({
      summary: null,
      recent: [
        makeMessage({
          id: 'msg_1',
          seq: 1,
          senderType: 'bot',
          senderBotId: 'bot_gone',
          content: { text: '遗言' },
        }),
      ],
      options: renderOptions,
    });
    expect(context).toContain('bot_gone');
  });
});

describe('trigger segment', () => {
  it('renders the trigger batch with its reason', () => {
    const segment = buildTriggerSegment({
      reason: 'direct',
      messages: [makeMessage({ id: 'msg_5', seq: 5, content: { text: '触发' } })],
      options: renderOptions,
    });
    expect(segment).toContain('<trigger reason="direct">');
    expect(segment).toContain('msg_5');
    expect(segment).toContain('触发');
  });
});

describe('user message mention legend', () => {
  const optionsWithGroups: RenderMessageOptions = {
    ...renderOptions,
    mentionLabels: new Map([[groupMentionToken('conv_g1'), '项目讨论组']]),
  };

  it('appends the mention legend: bots by name, groups labeled as group chats', () => {
    const line = renderMessageLine(
      makeMessage({
        id: 'msg_9',
        seq: 9,
        content: { text: '@别人 @项目讨论组 看看这个' },
        mentions: ['bot_other', groupMentionToken('conv_g1'), 'bot_gone'],
      }),
      optionsWithGroups,
    );
    expect(line).toContain('（提及：@别人、@项目讨论组（群聊）、@bot_gone）');
    expect(line).toContain('@别人 @项目讨论组 看看这个');
    // 图例跟在正文后、是宿主生成的元数据（顺序：正文 → 图例）。
    expect(line.indexOf('看看这个')).toBeLessThan(line.indexOf('（提及：'));
  });

  it('group tokens without a label still render legibly', () => {
    const line = renderMessageLine(
      makeMessage({
        id: 'msg_10',
        seq: 10,
        content: { text: 'x' },
        mentions: [groupMentionToken('conv_missing')],
      }),
      renderOptions,
    );
    expect(line).toContain('（提及：@某群聊）');
  });

  it('bot/system messages without mentions stay unchanged', () => {
    const line = renderMessageLine(
      makeMessage({ id: 'msg_11', seq: 11, content: { text: '普通' } }),
      optionsWithGroups,
    );
    expect(line).not.toContain('（提及：');
  });
});
