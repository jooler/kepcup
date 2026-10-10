import { describe, expect, it } from 'vitest';
import { MarkdownManager } from '@tiptap/markdown';
import { groupMentionToken } from '@kepcup/shared';
import { buildMentionTargets, type MentionTarget } from './composer-text';
import {
  collectMentionTokens,
  composerMention,
  composerNodes,
  mergeMentionTokens,
} from './composer-editor';

/** 与 Composer 相同的提及注册表（成员阿甲 + 外部 Bot + 一个群）。 */
const targets: MentionTarget[] = buildMentionTargets({
  memberBots: [],
  allBots: [
    {
      id: 'bot_jia',
      name: '阿甲',
      avatar: null,
      bio: '',
      profile: {} as never,
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  groups: [{ id: 'conv_g1', title: '项目讨论组' }],
});

const manager = new MarkdownManager({ extensions: [...composerNodes, composerMention] });

describe('composer markdown round-trip', () => {
  it('普通段落原样往返', () => {
    const md = '第一行\n第二行';
    expect(manager.serialize(manager.parse(md))).toBe(md);
  });

  it('有序/无序列表往返（发送给 AI 的就是标准 markdown）', () => {
    const ordered = '1. 第一步\n2. 第二步';
    expect(manager.serialize(manager.parse(ordered))).toBe(ordered);
    const bullet = '- 待办甲\n- 待办乙';
    expect(manager.serialize(manager.parse(bullet))).toBe(bullet);
  });

  it('列表与后续段落往返', () => {
    const md = '- 项目一\n- 项目二\n\n总结一句';
    expect(manager.serialize(manager.parse(md))).toBe(md);
  });

  it('mention 节点序列化为 @名字 纯文本', () => {
    const json = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '请问 ' },
            { type: 'mention', attrs: { id: 'bot_jia', label: '阿甲' } },
            { type: 'text', text: ' 看看' },
          ],
        },
      ],
    };
    expect(manager.serialize(json)).toBe('请问 @阿甲 看看');
  });

  it('硬换行序列化为单个换行', () => {
    const json = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '甲' },
            { type: 'hardBreak' },
            { type: 'text', text: '乙' },
          ],
        },
      ],
    };
    expect(manager.serialize(json)).toBe('甲\n乙');
  });
});

describe('mention token collection', () => {
  it('按出现顺序收集文档里的 mention 节点并去重', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: groupMentionToken('conv_g1'), label: '项目讨论组' } },
            { type: 'text', text: ' 和 ' },
            { type: 'mention', attrs: { id: 'bot_jia', label: '阿甲' } },
            { type: 'mention', attrs: { id: 'bot_jia', label: '阿甲' } },
          ],
        },
      ],
    };
    expect(collectMentionTokens(doc)).toEqual([groupMentionToken('conv_g1'), 'bot_jia']);
  });

  it('merge = 文档节点 ∪ 正文手打名称的正则解析', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'mention', attrs: { id: 'bot_jia', label: '阿甲' } }],
        },
      ],
    };
    expect(mergeMentionTokens(doc, '后面补一句 @项目讨论组', targets)).toEqual([
      'bot_jia',
      groupMentionToken('conv_g1'),
    ]);
  });

  it('纯文本草稿（mention 节点已退化）靠正则兜底', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '@阿甲 看看' }] }],
    };
    expect(mergeMentionTokens(doc, '@阿甲 看看', targets)).toEqual(['bot_jia']);
  });
});
