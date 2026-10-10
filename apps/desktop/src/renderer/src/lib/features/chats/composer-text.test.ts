import { describe, expect, it } from 'vitest';
import type { Bot } from '@kepcup/shared';
import { groupMentionToken } from '@kepcup/shared';
import { buildMentionTargets, resolveMentionTokens, segmentComposerText } from './composer-text';

function bot(id: string, name: string, systemRole: Bot['systemRole'] = null): Bot {
  return {
    id,
    name,
    avatar: null,
    bio: `${name}的简介`,
    profile: {} as Bot['profile'],
    status: 'active',
    systemRole,
    createdAt: 0,
    updatedAt: 0,
  } as Bot;
}

const targets = buildMentionTargets({
  memberBots: [bot('bot_jia', '阿甲')],
  allBots: [bot('bot_jia', '阿甲'), bot('bot_bing', '阿丙'), bot('bot_long', '很长很长的名字')],
  groups: [
    { id: 'conv_g1', title: '项目讨论组' },
    { id: 'conv_self', title: '当前群' },
  ],
  currentConversationId: 'conv_self',
});

describe('buildMentionTargets', () => {
  it('成员优先、去重、排除当前会话', () => {
    expect(targets.map((t) => t.token)).toEqual([
      'bot_jia',
      'bot_bing',
      'bot_long',
      groupMentionToken('conv_g1'),
    ]);
    expect(targets.map((t) => t.kind)).toEqual(['bot', 'bot', 'bot', 'group']);
  });

  it('同名先到先得（成员优先于同名外部 Bot）', () => {
    const merged = buildMentionTargets({
      memberBots: [bot('m1', '同名')],
      allBots: [bot('a1', '同名')],
      groups: [{ id: 'g1', title: '同名' }],
    });
    expect(merged).toEqual([{ token: 'm1', name: '同名', kind: 'bot', bio: '同名的简介' }]);
  });

  it('butler Bot 带 butler 标记（弹层加分区线用）', () => {
    const withButler = buildMentionTargets({
      memberBots: [bot('bot_butler', '管家', 'butler'), bot('bot_jia', '阿甲')],
      allBots: [],
      groups: [],
    });
    expect(withButler.map((t) => t.butler)).toEqual([true, false]);
  });

  it('excludeBotIds 排除指定 Bot（单聊里排除当前对话的 Bot 自己）', () => {
    const filtered = buildMentionTargets({
      memberBots: [],
      allBots: [bot('bot_self', '管家'), bot('bot_other', '阿丙')],
      groups: [],
      excludeBotIds: ['bot_self'],
    });
    expect(filtered.map((t) => t.token)).toEqual(['bot_other']);
  });
});

describe('segmentComposerText', () => {
  it('切出提及片段，其余为纯文本，拼接还原原文', () => {
    const text = '请问 @阿甲 和 @项目讨论组 怎么看？';
    const segments = segmentComposerText(text, targets);
    expect(segments).toEqual([
      { kind: 'text', text: '请问 ' },
      { kind: 'mention', text: '@阿甲', target: targets[0] },
      { kind: 'text', text: ' 和 ' },
      { kind: 'mention', text: '@项目讨论组', target: targets[3] },
      { kind: 'text', text: ' 怎么看？' },
    ]);
    expect(segments.map((s) => s.text).join('')).toBe(text);
  });

  it('名单内最长的名字优先命中', () => {
    const segments = segmentComposerText('@很长很长的名字', targets);
    expect(segments[0]?.kind).toBe('mention');
    expect((segments[0] as { target?: { token: string } }).target?.token).toBe('bot_long');
  });

  it('邮箱与无边界拼写不误判', () => {
    const segments = segmentComposerText('邮箱a@阿甲x 和 a@阿甲', targets);
    expect(segments).toEqual([{ kind: 'text', text: '邮箱a@阿甲x 和 a@阿甲' }]);
  });

  it('行首列表标记独立成片段，行中减号不标', () => {
    const segments = segmentComposerText('- 项目一\n普通-文本\n2. 第二项', targets);
    expect(segments).toEqual([
      { kind: 'list-marker', text: '-' },
      { kind: 'text', text: ' 项目一\n' },
      { kind: 'text', text: '普通-文本\n' },
      { kind: 'list-marker', text: '2.' },
      { kind: 'text', text: ' 第二项' },
    ]);
    expect(segments.map((s) => s.text).join('')).toBe('- 项目一\n普通-文本\n2. 第二项');
  });

  it('空注册表时整段为纯文本', () => {
    const segments = segmentComposerText('@阿甲 - x', []);
    expect(segments).toEqual([{ kind: 'text', text: '@阿甲 - x' }]);
  });
});

describe('resolveMentionTokens', () => {
  it('手动输入的全名解析为 token', () => {
    const tokens = resolveMentionTokens('@阿甲 @项目讨论组 看看', targets);
    expect(tokens).toEqual(['bot_jia', groupMentionToken('conv_g1')]);
  });

  it('无命中返回空', () => {
    expect(resolveMentionTokens('普通文本', targets)).toEqual([]);
  });
});
