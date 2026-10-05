import { describe, expect, it } from 'vitest';
import { stripMarkdown } from './strip-markdown.js';

describe('stripMarkdown', () => {
  it('returns empty for empty input', () => {
    expect(stripMarkdown('')).toBe('');
  });

  it('leaves plain text alone', () => {
    expect(stripMarkdown('你好，世界')).toBe('你好，世界');
  });

  it('drops heading, emphasis, and strike markers', () => {
    expect(stripMarkdown('# 标题\n\n这是 **粗体**、*斜体* 和 ~~删除~~')).toBe(
      '标题\n\n这是 粗体、斜体 和 删除',
    );
  });

  it('keeps link text and image alt, drops the url', () => {
    expect(
      stripMarkdown('看 [文档](https://example.com/a) 和 ![图](https://example.com/b.png)'),
    ).toBe('看 文档 和 图');
  });

  it('keeps fenced and inline code text, including markers inside code', () => {
    const md = '行内 `**不是粗体**`\n\n```ts\nconst n = 1;\n```';
    expect(stripMarkdown(md)).toBe('行内 **不是粗体**\n\nconst n = 1;');
  });

  it('flattens lists, tasks, and quotes', () => {
    const md = '> 引用\n\n- 一项\n- [x] 完成\n1. 有序';
    expect(stripMarkdown(md)).toBe('引用\n\n一项\n完成\n有序');
  });

  it('turns a table into cells without the separator', () => {
    const md = '| 名 | 值 |\n| --- | --- |\n| a | b |';
    expect(stripMarkdown(md)).toBe('名 值\n\na b');
  });

  it('drops a thematic break', () => {
    expect(stripMarkdown('上\n\n---\n\n下')).toBe('上\n\n下');
  });

  it('keeps the body of an unclosed fence', () => {
    expect(stripMarkdown('```js\nlet x = 1;')).toBe('let x = 1;');
  });

  it('does not treat underscores inside words as emphasis', () => {
    expect(stripMarkdown('keep snake_case and _强调_')).toBe('keep snake_case and 强调');
  });

  it('does not treat space-flanked asterisks as emphasis', () => {
    expect(stripMarkdown('3 * 4 = 12，即 2 * 3 * 4')).toBe('3 * 4 = 12，即 2 * 3 * 4');
  });

  it('still strips emphasis that hugs CJK text', () => {
    expect(stripMarkdown('**要点**：完成了')).toBe('要点：完成了');
  });
});
