import { describe, expect, it } from 'vitest';
import { SPEECH_TEXT_LIMIT, extractSpeechText } from './extractSpeechText';

/** 53 号「Bot 语音播报链路」对朗读文本提取的要求（代码块 / 行内 code / 链接 / 图片 / 表格 / 标题 / 引用 / 强调 / 截断）。 */

describe('extractSpeechText（围栏代码块整体跳过）', () => {
  it('带语言标注的围栏整段丢弃，围栏外内容保留', () => {
    const md = ['先说结论。', '', '```ts', 'const x = 1;', '```', '', '再说一句。'].join('\n');
    expect(extractSpeechText(md).text).toBe('先说结论。\n再说一句。');
  });

  it('多个围栏逐段跳过；~~~ 围栏同样处理', () => {
    const md = ['A', '```', 'code1', '```', 'B', '~~~py', 'code2', '~~~', 'C'].join('\n');
    expect(extractSpeechText(md).text).toBe('A\nB\nC');
  });

  it('未闭合的围栏剥到结尾（不留半截代码）', () => {
    const md = ['说明', '```js', 'unclosed()', 'still code'].join('\n');
    expect(extractSpeechText(md).text).toBe('说明');
  });

  it('四反引号包三反引号（LLM 常见形态）整段跳过：内部 ``` 不提前闭合', () => {
    const md = ['前', '````', '```js', 'const x = 1;', '```', '````', '后'].join('\n');
    expect(extractSpeechText(md).text).toBe('前\n后');
  });

  it('四反引号围栏须由 ≥4 个反引号闭合：三反引号闭合行只是内容', () => {
    const md = ['````md', '# inside', '```', '````', '正文'].join('\n');
    expect(extractSpeechText(md).text).toBe('正文');
  });

  it('~~~ 围栏内的 ``` 行不提前闭合（跨字符不配对）', () => {
    const md = ['说明', '~~~', '```python', 'print(1)', '```', '~~~', '结尾'].join('\n');
    expect(extractSpeechText(md).text).toBe('说明\n结尾');
  });

  it('带尾随内容的围栏行不是闭合行：不出栏、不吞后续正文', () => {
    // `~~~ x` 是栏内内容（CommonMark：闭合行只能是 run + 空白），裸 ~~~ 才闭合。
    const md = ['~~~', 'c', '~~~ x', '~~~', 'b'].join('\n');
    expect(extractSpeechText(md).text).toBe('b');
    const code = ['```', 'const a = 1;', '``` trailing', 'more', '```', '后'].join('\n');
    expect(extractSpeechText(code).text).toBe('后');
  });

  it('围栏内的 markdown 标记（链接 / 表格管道）不参与后续剥除', () => {
    const md = ['```', '| a | b |', '- [x] done', '```', '正文'].join('\n');
    expect(extractSpeechText(md).text).toBe('正文');
  });
});

describe('extractSpeechText（行内 code / 链接 / 图片）', () => {
  it('行内 code 去反引号、保留文字', () => {
    expect(extractSpeechText('运行 `pnpm test` 即可').text).toBe('运行 pnpm test 即可');
  });

  it('链接保留文本、丢 URL；裸 URL 原样保留', () => {
    expect(
      extractSpeechText('见 [文档](https://example.com/a?b=1) 与 https://example.com').text,
    ).toBe('见 文档 与 https://example.com');
  });

  it('图片整体丢弃（有无 alt 文本都不读）', () => {
    expect(extractSpeechText('前 ![截图](https://e.com/a.png) 后').text).toBe('前 后');
    expect(extractSpeechText('前 ![](https://e.com/a.png) 后').text).not.toContain('png');
  });

  it('图片嵌在链接里时整体丢成空文本', () => {
    expect(extractSpeechText('[![alt](i.png)](https://e.com)').text).toBe('');
  });
});

describe('extractSpeechText（表格 / 标题 / 引用 / 列表 / 分隔线）', () => {
  it('表格：分隔行丢弃、管道换空格、单元格文字保留', () => {
    const md = ['| 名称 | 数量 |', '| --- | --- |', '| 苹果 | 3 |'].join('\n');
    expect(extractSpeechText(md).text).toBe('名称 数量\n苹果 3');
  });

  it('标题：1-6 级 # 剥除；#hashtag（无空格）不是标题', () => {
    expect(extractSpeechText('## 二级标题\n#### 四级\n#tag 不剥').text).toBe(
      '二级标题\n四级\n#tag 不剥',
    );
  });

  it('引用：> 剥除（含多层 >>）', () => {
    expect(extractSpeechText('> 引用一句\n>> 深层引用').text).toBe('引用一句\n深层引用');
  });

  it('列表标记剥除（无序 / 有序），内容保留', () => {
    expect(extractSpeechText('- 第一项\n* 第二项\n3. 第三项').text).toBe('第一项\n第二项\n第三项');
  });

  it('分隔线（--- / *** / ___）整行丢弃', () => {
    expect(extractSpeechText('上\n---\n***\n下').text).toBe('上\n下');
  });
});

describe('extractSpeechText（强调标记）', () => {
  it('** / * / *** / __ / ___ / ~~ 成对剥除', () => {
    expect(extractSpeechText('**加粗** 与 *斜体*').text).toBe('加粗 与 斜体');
    expect(extractSpeechText('***粗斜***、__下划线__、~~删除~~').text).toBe('粗斜、下划线、删除');
  });

  it('不成对 / 词内下划线（snake_case）不动', () => {
    expect(extractSpeechText('snake_case_name 与 lone_underscore').text).toBe(
      'snake_case_name 与 lone_underscore',
    );
  });

  it('词内单星（a*b*c / 2*3*4）不是强调：原样保留，不剥成 abc / 234', () => {
    expect(extractSpeechText('计算 2*3*4 的值').text).toBe('计算 2*3*4 的值');
    expect(extractSpeechText('密钥 a*b*c 已生成').text).toBe('密钥 a*b*c 已生成');
  });

  it('词内近似不误伤：任一侧贴空白的单星对仍剥除（a*b* c / *b*c）', () => {
    expect(extractSpeechText('a*b* c 与 *b*c 都是强调').text).toBe('ab c 与 bc 都是强调');
  });

  it('词内双星（a**b**c）不是强调：与单星同口径原样保留', () => {
    expect(extractSpeechText('a**b**c 与 x**y**z').text).toBe('a**b**c 与 x**y**z');
    // 正常粗体（贴空白）照剥。
    expect(extractSpeechText('这是 **粗体** 文字').text).toBe('这是 粗体 文字');
  });
});

describe('extractSpeechText（截断边界）', () => {
  it('恰好 2000 字：不截断', () => {
    const text = 'a'.repeat(SPEECH_TEXT_LIMIT);
    const result = extractSpeechText(text);
    expect(result).toEqual({ text, truncated: false });
  });

  it('2001 字：截到 2000 并标记 truncated', () => {
    const result = extractSpeechText('b'.repeat(SPEECH_TEXT_LIMIT + 1));
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(SPEECH_TEXT_LIMIT);
  });

  it('多字节字符按码点截断，不截半个字符', () => {
    const emoji = '😀';
    const result = extractSpeechText(emoji.repeat(SPEECH_TEXT_LIMIT + 1));
    expect(result.truncated).toBe(true);
    expect(Array.from(result.text).length).toBe(SPEECH_TEXT_LIMIT);
    // 末尾仍是完整 emoji（无孤立代理对）。
    expect(Array.from(result.text).at(-1)).toBe(emoji);
  });

  it('截断在 markdown 剥除之后计算（代码块字数不计入）', () => {
    const md = `${'前'.repeat(100)}\n${'```'}\n${'x'.repeat(SPEECH_TEXT_LIMIT)}\n${'```'}\n${'后'.repeat(50)}`;
    const result = extractSpeechText(md);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(`${'前'.repeat(100)}\n${'后'.repeat(50)}`);
  });
});

describe('extractSpeechText（组合文档 / 空结果）', () => {
  it('混合文档：剥标记后保留可朗读文本', () => {
    const md = [
      '## 结论',
      '',
      '**可行**，参考 [方案](https://e.com/p)。',
      '',
      '| 步骤 | 说明 |',
      '| --- | --- |',
      '| 1 | 先装依赖 `pnpm i` |',
      '',
      '> 注意：图片 ![图](i.png) 不读。',
      '',
      '```bash',
      'echo done',
      '```',
    ].join('\n');
    expect(extractSpeechText(md).text).toBe(
      ['结论', '可行，参考 方案。', '步骤 说明', '1 先装依赖 pnpm i', '注意：图片 不读。'].join(
        '\n',
      ),
    );
  });

  it('纯代码块 / 纯图片消息提取为空（调用方跳过播报）', () => {
    expect(extractSpeechText('```\nonly code\n```').text).toBe('');
    expect(extractSpeechText('![a](x.png)').text).toBe('');
    expect(extractSpeechText(' \n\t ').text).toBe('');
  });
});
