import { describe, expect, it } from 'vitest';
import { botProfileSchema, type Bot, type Conversation } from '@kepcup/shared';
import { buildSystemPrompt, isCodingBot } from '../../src/agent/context/system-prompt.js';

/**
 * 编程 / 开发 Bot 的提示词强化（初始化访谈 + 运行时）：
 * - 画像（简介 / 擅长 / 职责）读起来是编程类时，任务版 `<coding_rules>` 要求
 *   复杂任务先 update_plan 拆解、只读调研交给 SubAgent（delegate_task）；
 * - 对话轮版本只做派任务的路由提示（这一轮没有 delegate_task）；
 * - 访谈期间不注入运行时段，但 `<setup_interview>` 要引导把领域写进画像，
 *   并在总结里说明之后的拆解 / 子代理工作方式。
 */

function makeBot(overrides: {
  name?: string;
  bio?: string;
  expertise?: string;
  responsibilities?: string;
  kind?: string | null;
  setupState?: 'interviewing' | null;
  systemRole?: 'butler' | null;
}): Bot {
  return {
    id: 'bot_1',
    name: overrides.name ?? '小码',
    avatar: null,
    bio: overrides.bio ?? '',
    profile: botProfileSchema.parse({
      identity: {
        name: overrides.name ?? '小码',
        bio: overrides.bio ?? '',
      },
      role: {
        expertise: overrides.expertise ?? '',
        responsibilities: overrides.responsibilities ?? '',
      },
      runtime: { model: '', light_model: '' },
    }),
    status: 'active',
    kind: overrides.kind ?? null,
    setupState: overrides.setupState ?? null,
    systemRole: overrides.systemRole ?? null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeConversation(): Conversation {
  return {
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
  };
}

function prompt(bot: Bot, loop: 'turn' | 'task', language: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  return buildSystemPrompt({
    loop,
    language,
    bot,
    conversation: makeConversation(),
    timeZone: 'Asia/Shanghai',
    now: new Date('2026-10-30T08:00:00Z'),
  });
}

const CODING_BOT = makeBot({
  name: '工程师小码',
  bio: '帮你写代码、调试和做代码审查',
  expertise: '编程与开发',
  responsibilities: '负责写代码、调试、测试与代码审查',
});

describe('isCodingBot 画像识别', () => {
  it('认得出中文画像里的编程 / 开发领域', () => {
    expect(isCodingBot(CODING_BOT)).toBe(true);
  });

  it('认得出英文画像里的软件工程 / 开发', () => {
    const bot = makeBot({
      bio: 'Software engineer',
      responsibilities: 'Write code and review pull requests',
    });
    expect(isCodingBot(bot)).toBe(true);
  });

  it('写作 / 营销类 Bot 不误判', () => {
    const bot = makeBot({
      bio: '帮你写周报和营销文案',
      expertise: '写作与文档',
      responsibilities: '负责公众号、新闻稿与社交媒体内容',
    });
    expect(isCodingBot(bot)).toBe(false);
  });
});

describe('bot.kind 优先于画像关键词', () => {
  it('kind=coding 即使还没写画像也进入编程规则', () => {
    const bot = makeBot({ name: '新 Bot', kind: 'coding' });
    expect(isCodingBot(bot)).toBe(true);
    expect(prompt(bot, 'task')).toContain('<coding_rules>');
  });

  it('kind=writing 时即使简介提到代码也不再套编程规则', () => {
    const bot = makeBot({
      bio: '帮你写技术文档，偶尔贴代码',
      expertise: '写作与文档',
      kind: 'writing',
    });
    expect(isCodingBot(bot)).toBe(false);
    expect(prompt(bot, 'task')).not.toContain('<coding_rules>');
  });

  it('自定义 kind 自身命中编码词（如「前端开发」）时按编程 Bot 处理', () => {
    const bot = makeBot({ name: '前端小助手', kind: '前端开发' });
    expect(isCodingBot(bot)).toBe(true);
    expect(prompt(bot, 'task')).toContain('<coding_rules>');
  });

  it('分类写进 <identity>，内置分类带稳定 id', () => {
    const bot = makeBot({ kind: 'coding' });
    const text = prompt(bot, 'task');
    expect(text).toContain('分类：编程与开发（coding）');
  });
});

describe('<coding_rules> 注入（任务版）', () => {
  it('编程 Bot 的任务提示词要求先规划拆解，并把只读调研委派给子代理', () => {
    const text = prompt(CODING_BOT, 'task');
    expect(text).toContain('<coding_rules>');
    expect(text).toContain('update_plan');
    expect(text).toContain('delegate_task');
    expect(text).toContain('collect_delegate_results');
    expect(text).toContain('SubAgent');
    expect(text).toContain('子代理');
    // 改代码 / 验证不能委派出去。
    expect(text).toContain('写代码、改配置、跑测试 / lint / build 与最终验证都由你自己完成');
  });

  it('紧跟在 <platform_rules> 之后', () => {
    const text = prompt(CODING_BOT, 'task');
    expect(text.indexOf('</platform_rules>')).toBeLessThan(text.indexOf('<coding_rules>'));
    expect(text.indexOf('</coding_rules>')).toBeLessThan(text.indexOf('<identity>'));
  });

  it('非编程 Bot 不注入该段', () => {
    const writer = makeBot({
      bio: '帮你写周报和营销文案',
      expertise: '写作与文档',
    });
    expect(prompt(writer, 'task')).not.toContain('<coding_rules>');
  });
});

describe('<coding_rules> 注入（对话轮版）', () => {
  it('编程 Bot 的对话轮要求复杂请求派任务，且不指挥它调用本轮的 delegate_task', () => {
    const text = prompt(CODING_BOT, 'turn');
    expect(text).toContain('<coding_rules>');
    expect(text).toContain('用 start_task 派成后台任务');
    expect(text).toContain('验收标准');
    expect(text).not.toContain('delegate_task');
  });

  it('非编程 Bot 不注入该段', () => {
    const writer = makeBot({ bio: '帮你写周报', expertise: '写作与文档' });
    expect(prompt(writer, 'turn')).not.toContain('<coding_rules>');
  });
});

describe('初始化访谈阶段的编程 Bot 引导', () => {
  it('访谈期间不注入运行时编码段，而是在访谈指引里要求写入领域并说明工作方式', () => {
    const interviewing = makeBot({
      name: '新 Bot',
      setupState: 'interviewing',
    });
    const text = prompt(interviewing, 'turn');
    expect(text).not.toContain('<coding_rules>');
    expect(text).toContain('<setup_interview>');
    expect(text).toContain('如果这个 Bot 主要做编程 / 开发');
    expect(text).toContain('role.expertise');
    expect(text).toContain('先规划拆解');
    expect(text).toContain('只读调研交给子代理');
    expect(text).toContain('访谈轮没有 delegate_task');
    expect(text).toContain('分类（kind）');
    expect(text).toContain('coding（编程与开发）');
  });

  it('英文访谈同样给出编程 Bot 的引导', () => {
    const interviewing = makeBot({ name: 'New Bot', setupState: 'interviewing' });
    const text = prompt(interviewing, 'turn', 'en-US');
    expect(text).toContain('If this bot is mainly for programming/development');
    expect(text).toContain('parallel subagents');
    expect(text).toContain('no delegate_task');
    expect(text).toContain('Bot kind');
    expect(text).toContain('coding (Programming & development)');
  });

  it('访谈结束后，画像里已有编程领域即恢复任务版编码段', () => {
    const finished = makeBot({
      bio: '写代码与调试',
      expertise: '编程与开发',
      setupState: null,
    });
    expect(prompt(finished, 'task')).toContain('<coding_rules>');
  });
});
