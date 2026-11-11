import { describe, expect, it } from 'vitest';
import type { Bot } from '@kepcup/shared';
import { fileMentionToken, folderMentionToken } from '@kepcup/shared';
import { buildLocalPathMentionTargets, buildMentionTargets } from './composer-text';
import {
  MENTION_HREF_PREFIX,
  composerTextToMarkdown,
  insertHardLineBreaks,
  mentionsToMarkdown,
  parseMentionHref,
} from './user-markdown';

function bot(id: string, name: string): Bot {
  return {
    id,
    name,
    avatar: null,
    bio: `${name}的简介`,
    profile: {} as Bot['profile'],
    status: 'active',
    systemRole: null,
    createdAt: 0,
    updatedAt: 0,
  } as Bot;
}

const targets = buildMentionTargets({
  memberBots: [bot('bot_jia', '阿甲')],
  allBots: [bot('bot_jia', '阿甲'), bot('bot_bing', '阿丙')],
  projects: [{ id: 'conv_g1', title: '项目讨论组' }],
});

const localTargets = buildLocalPathMentionTargets([
  fileMentionToken('/Users/me/我的 报告(终版).md'),
  folderMentionToken('/Users/me/素材'),
]);

const allTargets = [...targets, ...localTargets];

describe('parseMentionHref', () => {
  it('解析 bot / project / file / folder 四类提及', () => {
    expect(parseMentionHref(`${MENTION_HREF_PREFIX}bot:bot_jia`)).toEqual({
      kind: 'bot',
      value: 'bot_jia',
    });
    expect(parseMentionHref(`${MENTION_HREF_PREFIX}project:conv_g1`)).toEqual({
      kind: 'project',
      value: 'conv_g1',
    });
    expect(parseMentionHref(`${MENTION_HREF_PREFIX}file:%2Ftmp%2Fa%20b.md`)).toEqual({
      kind: 'file',
      value: '/tmp/a b.md',
    });
    expect(parseMentionHref(`${MENTION_HREF_PREFIX}folder:%2Ftmp%2F%E7%B4%A0%E6%9D%90`)).toEqual({
      kind: 'folder',
      value: '/tmp/素材',
    });
  });

  it('非提及链接、坏 payload、未知种类一律返回 null', () => {
    expect(parseMentionHref(undefined)).toBeNull();
    expect(parseMentionHref('https://example.com')).toBeNull();
    expect(parseMentionHref(`${MENTION_HREF_PREFIX}pick-file:x`)).toBeNull();
    expect(parseMentionHref(`${MENTION_HREF_PREFIX}bot`)).toBeNull();
    expect(parseMentionHref(`${MENTION_HREF_PREFIX}file:%E0%A4%A`)).toBeNull();
  });
});

describe('mentionsToMarkdown', () => {
  it('Bot / 项目组提及转成 mention 链接，标签保留 @名字', () => {
    expect(mentionsToMarkdown('请问 @阿甲 和 @项目讨论组 怎么看？', allTargets)).toBe(
      `请问 [@阿甲](<${MENTION_HREF_PREFIX}bot:bot_jia>) 和 ` +
        `[@项目讨论组](<${MENTION_HREF_PREFIX}project:conv_g1>) 怎么看？`,
    );
  });

  it('本地路径提及：标签取 basename（转义标点），href 带完整路径', () => {
    const markdown = mentionsToMarkdown(
      '看@/Users/me/我的 报告(终版).md 和 @/Users/me/素材',
      allTargets,
    );
    expect(markdown).toBe(
      `看[我的 报告\\(终版\\)\\.md](<${MENTION_HREF_PREFIX}file:` +
        `${encodeURIComponent('/Users/me/我的 报告(终版).md')}>) 和 ` +
        `[素材](<${MENTION_HREF_PREFIX}folder:${encodeURIComponent('/Users/me/素材')}>)`,
    );
    // href 解码后就是完整路径，胶囊的 title 用它。
    expect(
      parseMentionHref(
        `${MENTION_HREF_PREFIX}file:${encodeURIComponent('/Users/me/我的 报告(终版).md')}`,
      )?.value,
    ).toBe('/Users/me/我的 报告(终版).md');
  });

  it('邮箱与无边界拼写不误判为提及', () => {
    const text = '发到 a@阿甲的邮箱，还有 @阿丙x 不算';
    expect(mentionsToMarkdown(text, allTargets)).toBe(text);
  });

  it('没有 @ 或没有提及目标时原样返回', () => {
    expect(mentionsToMarkdown('普通文本\n第二行', allTargets)).toBe('普通文本\n第二行');
    expect(mentionsToMarkdown('@阿甲 你好', [])).toBe('@阿甲 你好');
  });

  it('围栏代码块与行内代码里的 @名字 保持原样', () => {
    const fenced = ['```', '@阿甲 keep', '```'].join('\n');
    expect(mentionsToMarkdown(fenced, allTargets)).toBe(fenced);
    expect(mentionsToMarkdown('提到 `@阿甲` 时', allTargets)).toBe('提到 `@阿甲` 时');
  });

  it('未闭合的围栏一直保护到文末', () => {
    const text = ['```ts', '@阿甲', 'const a = 1;'].join('\n');
    expect(mentionsToMarkdown(text, allTargets)).toBe(text);
  });

  it('行内与列表项里的提及都转成胶囊', () => {
    expect(mentionsToMarkdown('- 找 @阿甲 确认\n- 看 @/Users/me/素材', allTargets)).toBe(
      `- 找 [@阿甲](<${MENTION_HREF_PREFIX}bot:bot_jia>) 确认\n` +
        `- 看 [素材](<${MENTION_HREF_PREFIX}folder:${encodeURIComponent('/Users/me/素材')}>)`,
    );
  });

  it('用户自己写的行内链接内部不再嵌套提及链接', () => {
    const text = '[看 @阿甲](https://example.com/@阿甲)';
    expect(mentionsToMarkdown(text, allTargets)).toBe(text);
  });

  it('提及标签里的 markdown 标点被转义，不会破坏链接语法', () => {
    const odd = buildMentionTargets({
      memberBots: [],
      allBots: [bot('bot_odd', 'A_b*c[d]')],
      projects: [],
    });
    expect(mentionsToMarkdown('@A_b*c[d] 你好', odd)).toBe(
      `[@A\\_b\\*c\\[d\\]](<${MENTION_HREF_PREFIX}bot:bot_odd>) 你好`,
    );
  });
});

describe('insertHardLineBreaks', () => {
  it('段内单换行补成硬换行（两个空格）', () => {
    expect(insertHardLineBreaks('第一行\n第二行')).toBe('第一行  \n第二行');
  });

  it('空行与末尾换行不补', () => {
    expect(insertHardLineBreaks('第一段\n\n第二段')).toBe('第一段\n\n第二段');
    expect(insertHardLineBreaks('只有一行\n')).toBe('只有一行\n');
    expect(insertHardLineBreaks('只有一行')).toBe('只有一行');
  });

  it('已经是硬换行（行尾两个空格或反斜杠）时不重复补', () => {
    expect(insertHardLineBreaks('第一行  \n第二行')).toBe('第一行  \n第二行');
    expect(insertHardLineBreaks('第一行\\\n第二行')).toBe('第一行\\\n第二行');
  });

  it('围栏代码块内部保持原样', () => {
    const md = ['说明', '```js', 'const a = 1;', 'const b = 2;', '```', '结尾'].join('\n');
    expect(insertHardLineBreaks(md)).toBe(
      ['说明  ', '```js', 'const a = 1;', 'const b = 2;', '```', '结尾'].join('\n'),
    );
  });

  it('跨行的行内代码内部不插入空格', () => {
    expect(insertHardLineBreaks('看这段 `a\nb` 代码')).toBe('看这段 `a\nb` 代码');
  });

  it('分隔线与 setext 下划线不补（避免改变块语义）', () => {
    expect(insertHardLineBreaks('第一段\n\n---\n\n第二段')).toBe('第一段\n\n---\n\n第二段');
    expect(insertHardLineBreaks('标题\n===')).toBe('标题\n===');
  });

  it('列表与引用块的续行照常补硬换行', () => {
    expect(insertHardLineBreaks('- 第一步\n- 第二步')).toBe('- 第一步  \n- 第二步');
    expect(insertHardLineBreaks('> 引用一\n> 引用二')).toBe('> 引用一  \n> 引用二');
  });

  it('缩进代码块（4 空格）保守跳过', () => {
    expect(insertHardLineBreaks('    code 1\n    code 2')).toBe('    code 1\n    code 2');
  });
});

describe('composerTextToMarkdown', () => {
  it('提及与换行一起处理，且提及不会被换行处理破坏', () => {
    expect(composerTextToMarkdown('@阿甲 在吗\n看下 @/Users/me/素材', allTargets)).toBe(
      `[@阿甲](<${MENTION_HREF_PREFIX}bot:bot_jia>) 在吗  \n` +
        `看下 [素材](<${MENTION_HREF_PREFIX}folder:${encodeURIComponent('/Users/me/素材')}>)`,
    );
  });

  it('纯文本消息（无提及无换行）零改写', () => {
    expect(composerTextToMarkdown('就一句普通的话', allTargets)).toBe('就一句普通的话');
  });
});
