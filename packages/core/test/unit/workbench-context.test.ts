import { describe, expect, it } from 'vitest';
import { botProfileSchema, type Bot, type Conversation, type Message } from '@kepcup/shared';
import {
  WORKBENCH_DISPATCH_RULE,
  buildSystemPrompt,
} from '../../src/agent/context/system-prompt.js';
import { renderMessageLine, type RenderMessageOptions } from '../../src/agent/context/conversation.js';
import { reflectionInput } from '../../src/memory/reflection.js';
import { triggerFromUser } from '../../src/settings/context.js';

/**
 * 工作台派发消息在各处的对待（D90 §4.4）：不算用户本人触发、记忆反思不把管家代写的派发当用户
 * 原话、执行者提示的交付规则只在被派发的轮次出现、上下文里标明来源。
 */

function makeMessage(content: Record<string, unknown>, overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_wb',
    conversationId: 'conv_1',
    seq: 1,
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    content: content as Message['content'],
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

const dispatch = makeMessage({
  text: '【工作台】整理竞品报告',
  origin: 'workbench',
  todoId: 'todo_1',
  todoRunId: 'tdr_1',
});
const butlerDispatch = makeMessage({
  text: '【工作台】整理竞品报告（管家代你安排）',
  origin: 'workbench',
  todoId: 'todo_1',
  todoRunId: 'tdr_1',
  viaButler: true,
});
const typed = makeMessage({ text: '你好' });

describe('triggerFromUser：工作台派发不算用户本人（与委派代发相同）', () => {
  it('单独的派发消息、混进用户消息的批次都为假；用户亲手发的仍为真', () => {
    expect(triggerFromUser({ messages: [typed] })).toBe(true);
    expect(triggerFromUser({ messages: [dispatch] })).toBe(false);
    expect(triggerFromUser({ messages: [butlerDispatch] })).toBe(false);
    expect(triggerFromUser({ messages: [typed, dispatch] })).toBe(false);
  });
});

describe('上下文渲染：派发消息标明来源', () => {
  const options: RenderMessageOptions = {
    selfBotId: 'bot_self',
    timeZone: 'Asia/Shanghai',
    botNames: new Map([['bot_self', '我']]),
  };

  it('用户自己的事项标「经工作台派发」，管家创建的另标「管家代为安排」', () => {
    expect(renderMessageLine(dispatch, options)).toContain('用户（经工作台派发）]');
    expect(renderMessageLine(butlerDispatch, options)).toContain('用户（经工作台派发，管家代为安排）]');
    expect(renderMessageLine(dispatch, options)).toContain('【工作台】整理竞品报告');
  });
});

describe('记忆反思：管家代写的派发不算用户原话', () => {
  const base = {
    botMessages: [],
    runId: 'run_1',
    executionSteps: '',
    existingMemories: '',
    profileCard: '',
  };
  const asTrigger = (m: Message) => ({
    id: m.id,
    createdAt: m.createdAt,
    senderType: m.senderType,
    senderBotId: m.senderBotId,
    content: m.content,
  });

  it('source=user 的派发仍是用户的话；source=butler 的按数据对待（<untrusted>）', () => {
    const own = String(reflectionInput({ ...base, triggerMessages: [asTrigger(dispatch)] })[0]!.content);
    expect(own).toContain('[msg_wb | 用户（经工作台派发）] 【工作台】整理竞品报告');
    const butler = String(
      reflectionInput({ ...base, triggerMessages: [asTrigger(butlerDispatch)] })[0]!.content,
    );
    expect(butler).toContain('管家代用户安排的事项，非用户本人的话');
    expect(butler).toMatch(/<untrusted>[^]*整理竞品报告[^]*<\/untrusted>/);
    expect(butler).not.toContain('[msg_wb | 用户');
  });
});

describe('执行者提示：交付规则只在被工作台派发触发的轮次出现', () => {
  const bot: Bot = {
    id: 'bot_a',
    name: '阿甲',
    avatar: null,
    bio: '',
    profile: botProfileSchema.parse({
      identity: { name: '阿甲', bio: '' },
      runtime: { model: '', light_model: '' },
    }),
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  };
  const conversation = {
    id: 'conv_1',
    type: 'direct',
    title: null,
    directBotId: 'bot_a',
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 0,
  } as unknown as Conversation;
  const base = { bot, conversation, timeZone: 'UTC', now: new Date(0), loop: 'turn' as const };

  it('带 workbenchDispatch 才追加，且是编号规则；其余轮次不出现', () => {
    const withRule = buildSystemPrompt({ ...base, workbenchDispatch: true });
    expect(withRule).toContain('工作台派发的事项');
    expect(withRule).toContain('做完给出明确结论；做不了说明原因与需要什么');
    expect(withRule).toMatch(/\n\d+\. 工作台派发的事项/);
    expect(buildSystemPrompt(base)).not.toContain('工作台派发的事项');
    expect(buildSystemPrompt({ ...base, workbenchDispatch: false })).not.toContain(
      WORKBENCH_DISPATCH_RULE,
    );
  });
});
