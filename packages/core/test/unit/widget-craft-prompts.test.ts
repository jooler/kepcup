import { describe, expect, it } from 'vitest';
import type { Bot, Conversation } from '@kepcup/shared';
import { botProfileSchema } from '@kepcup/shared';
import { buildSystemPrompt } from '../../src/agent/context/system-prompt.js';
import {
  buildStageInput,
  craftSystemPrompt,
  reviewSystemPrompt,
  specStageInput,
} from '../../src/widgets/craft/prompts.js';

/**
 * 制作 loop 的页面形态约束：iframe 里只放用户要的内容。
 * 截图里的「版式预览 / HTML 源码」工具条、脚注和状态条是模型写进 HTML 的，
 * 不是卡片外壳；提示要拦住这种预览壳。
 */

const stage = {
  draftDir: '/draft',
  brief: '复刻这一页',
  title: '预览',
  acceptanceHints: [],
  modifying: false,
  resumeNote: null,
  spec: '规格',
  acceptance: '[]',
};

describe('widget craft prompts: content only, no preview shell', () => {
  it('系统提示告诉制作模型不要套预览壳或源码面板', () => {
    const prompt = craftSystemPrompt();
    expect(prompt).toContain('## 页面里放什么');
    expect(prompt).toContain('不要再套一层预览壳');
    expect(prompt).toContain('加载前的源码审查');
    expect(prompt).not.toContain('用户每次加载都会看到你的源码并确认');
  });

  it('SPEC / BUILD / REVIEW 都带着同一条约束', () => {
    expect(specStageInput(stage)).toContain('不追加点击、展开、查看源码');
    expect(specStageInput(stage)).toContain('steps 用空数组');
    expect(specStageInput(stage)).not.toContain('至少 2 条 must');
    expect(buildStageInput(stage)).toContain('那一页铺满文档');
    expect(reviewSystemPrompt()).toContain('出现就记 P1');
  });

  it('「不加没要求的操作」只管复刻 / 静态展示；计算器、追踪表照常做交互', () => {
    const spec = specStageInput(stage);
    expect(spec).toContain('复刻 / 静态展示类（版式、海报、一段结果）用户没要求操作就不写交互');
    expect(spec).toContain('计算器、追踪表这类靠操作才能用的组件，照常规划它该有的交互');
    expect(spec).toContain(
      '组件本身靠操作使用（计算器、追踪表等），或用户原文要求了操作时，写动作',
    );
    expect(spec).not.toContain('用户没要求操作就不写交互。');
    expect(buildStageInput(stage)).toContain('spec 规划的交互（计算器、追踪表等）要做全');
    expect(craftSystemPrompt()).toContain('这类复刻 / 静态展示不要另加点击展开');
    expect(craftSystemPrompt()).toContain('计算器、追踪表、待办、记账这类本身靠操作才能用的组件');
  });

  it('验收示例用明显的占位文字，不给模型可照抄的具体词', () => {
    const spec = specStageInput(stage);
    expect(spec).not.toContain('"textContains": "进展"');
    expect(spec).toContain('"textContains": "‹标题里的原文›"');
    expect(spec).toContain('选择器和文字都是占位');
  });

  it('任务规则要求 brief 只描述内容，不要求组件内源码查看', () => {
    const bot: Bot = {
      id: 'bot_1',
      name: '小艾',
      avatar: null,
      bio: '',
      profile: botProfileSchema.parse({
        identity: { name: '小艾', bio: '' },
        persona: {},
        role: {},
        boundaries: [],
        runtime: { model: '', light_model: '' },
      }),
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    };
    const conversation = { id: 'conv_1', type: 'direct', title: null } as Conversation;
    const task = buildSystemPrompt({
      bot,
      conversation,
      timeZone: 'UTC',
      now: new Date(0),
    });
    expect(task).toContain('用户没说的操作不要写进 brief');
    expect(task).not.toContain('主要交互');
  });
});
