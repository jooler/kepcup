import { describe, expect, it } from 'vitest';
import { botProfileSchema, type Bot, type BotCard, type Conversation } from '@kepcup/shared';
import { buildSystemPrompt } from '../../src/agent/context/system-prompt.js';

/**
 * WP4 §3.A：`<conversation_info>` 的项目组分支（目标 / 负责人行带「（你）」 /
 * 成员卡 `[负责人]` 标记、缺项整行省略、无 token 预算）与按 `projectRole`
 * 注入的负责人 / 成员规则段（位置在 `conversation_info` 之后、`<workdir>` 之前；
 * 单聊与任务面不注入）。
 */

function makeBot(id: string, name: string): Bot {
  return {
    id,
    name,
    avatar: null,
    bio: `${name}的简介`,
    profile: botProfileSchema.parse({
      identity: { name, bio: `${name}的简介` },
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

function makeProject(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_p',
    type: 'project',
    title: '发布项目组',
    goal: '把每个版本按时发布',
    leadBotId: 'bot_lead',
    directBotId: null,
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 0,
    ...overrides,
  };
}

function card(id: string, name: string, isLead?: boolean): BotCard {
  return { id, name, bio: `${name}简介`, role: `${name}职责`, ...(isLead ? { isLead: true } : {}) };
}

const LEAD = makeBot('bot_lead', '负责人甲');
const MEMBER = makeBot('bot_member', '成员乙');

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    loop: 'turn',
    bot: MEMBER,
    conversation: makeProject(),
    timeZone: 'Asia/Shanghai',
    now: new Date(0),
    members: [card('bot_lead', '负责人甲', true), card('bot_member', '成员乙')],
    ...overrides,
  };
}

describe('<conversation_info> 项目组分支（WP4 §3.A）', () => {
  it('输出对话类型、项目目标、负责人行（self 是负责人时带「（你）」）与带 [负责人] 标记的成员名片', () => {
    const prompt = buildSystemPrompt(baseInput({ bot: LEAD, projectRole: 'lead' }) as never);
    expect(prompt).toContain('对话类型：项目组「发布项目组」');
    expect(prompt).toContain('项目目标：把每个版本按时发布');
    expect(prompt).toContain('项目负责人：负责人甲（你）');
    expect(prompt).toContain('- 负责人甲（bot_lead）：负责人甲简介；职责：负责人甲职责 [负责人]');
    expect(prompt).toContain('- 成员乙（bot_member）：成员乙简介；职责：成员乙职责');
  });

  it('self 不是负责人时负责人行不带「（你）」', () => {
    const prompt = buildSystemPrompt(baseInput({ projectRole: 'member' }) as never);
    expect(prompt).toContain('项目负责人：负责人甲');
    expect(prompt).not.toContain('负责人甲（你）');
  });

  it('目标缺失时整行省略；无标题时对话类型不带书名号', () => {
    const prompt = buildSystemPrompt(
      baseInput({ conversation: makeProject({ goal: null, title: null }) }) as never,
    );
    expect(prompt).toContain('对话类型：项目组');
    expect(prompt).not.toContain('项目目标：');
    expect(prompt).not.toContain('「」');
  });

  it('成员卡没有 isLead 时负责人行整行省略（leadName 取成员卡里 isLead 的那张）', () => {
    const prompt = buildSystemPrompt(
      baseInput({
        members: [card('bot_lead', '负责人甲'), card('bot_member', '成员乙')],
      }) as never,
    );
    expect(prompt).not.toContain('项目负责人：');
    expect(prompt).not.toContain('[负责人]');
  });
});

describe('projectRole 规则段注入（WP4 §3.A.4）', () => {
  it("projectRole='lead' 注入 project_lead_rules；不注入成员规则", () => {
    const prompt = buildSystemPrompt(baseInput({ bot: LEAD, projectRole: 'lead' }) as never);
    expect(prompt).toContain('<project_lead_rules>');
    expect(prompt).toContain('你是本项目组的负责人。');
    expect(prompt).toContain('你的权力限于本项目组');
    expect(prompt).not.toContain('<project_member_rules>');
  });

  it("projectRole='member' 注入 project_member_rules 并代入负责人名字", () => {
    const prompt = buildSystemPrompt(baseInput({ projectRole: 'member' }) as never);
    expect(prompt).toContain('<project_member_rules>');
    expect(prompt).toContain('你是本项目组的成员，负责人是 负责人甲。');
    expect(prompt).toContain('- 完成负责人交办的事后，@ 负责人汇报结论与产出位置。');
    expect(prompt).not.toContain('<project_lead_rules>');
  });

  it('缺省 projectRole 不注入任何规则段（项目组对话）', () => {
    const prompt = buildSystemPrompt(baseInput({}) as never);
    expect(prompt).not.toContain('<project_lead_rules>');
    expect(prompt).not.toContain('<project_member_rules>');
    // conversation_info 本身还在。
    expect(prompt).toContain('对话类型：项目组「发布项目组」');
  });

  it('任务面不注入规则段（任务不能 @ 成员）', () => {
    const task = buildSystemPrompt(baseInput({ loop: 'task', projectRole: 'lead' }) as never);
    expect(task).not.toContain('<project_lead_rules>');
    expect(task).not.toContain('<project_member_rules>');
  });

  it('单聊不注入规则段，也不出现项目组行', () => {
    const direct: Conversation = {
      id: 'conv_d',
      type: 'direct',
      title: null,
      goal: null,
      leadBotId: null,
      directBotId: 'bot_member',
      readOnly: false,
      summary: null,
      summaryUptoSeq: 0,
      lastSeq: 0,
      lastReadSeq: 0,
      lastMessageAt: null,
      createdAt: 0,
    };
    const prompt = buildSystemPrompt(
      baseInput({ conversation: direct, members: undefined, projectRole: 'member' }) as never,
    );
    expect(prompt).toContain('对话类型：单聊（你与用户一对一）');
    expect(prompt).not.toContain('<project_lead_rules>');
    expect(prompt).not.toContain('<project_member_rules>');
  });

  it('规则段位置在 conversation_info 之后、绑定的 <workdir> 之前', () => {
    const prompt = buildSystemPrompt(
      baseInput({ projectRole: 'lead', workdir: '工作目录说明' }) as never,
    );
    const infoAt = prompt.indexOf('</conversation_info>');
    const leadAt = prompt.indexOf('<project_lead_rules>');
    const workdirAt = prompt.indexOf('<workdir>');
    expect(infoAt).toBeGreaterThanOrEqual(0);
    expect(leadAt).toBeGreaterThan(infoAt);
    expect(workdirAt).toBeGreaterThan(leadAt);
  });
});
