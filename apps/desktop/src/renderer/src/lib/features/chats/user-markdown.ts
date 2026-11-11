/**
 * 用户消息正文 → markdown 源码（纯函数，无 DOM，可单测）。
 *
 * 气泡改成 markdown 渲染（与 Bot 消息同一管线）后，两件事必须显式补齐：
 *
 * 1. **@提及**：正文里的 `@名字` / `@绝对路径` 转成 markdown 链接，渲染后由
 *    `MentionLink.svelte` 还原成原来的胶囊（Bot / 项目组显示 `@名字`；本地文件 /
 *    文件夹显示 basename + 图标，`title` 给完整路径）。href 用**相对锚点**
 *    `#kepcup-mention:<kind>:<payload>`：
 *    - 相对链接不触发 streamdown 的链接安全确认（`isPathRelativeUrl` 为真 →
 *      不拦截），才能走到 `components.a` 覆盖点；
 *    - payload 用 `encodeURIComponent` 编码，路径里的空格 / 括号 / `#` 不会
 *      破坏 markdown 链接语法（目标仍用 `<...>` 包一层兜底）。
 * 2. **换行**：气泡原来是 `whitespace-pre-wrap`，单个换行（Shift+Enter）就是
 *    硬换行；markdown 会把段落内单换行折成空格。streamdown-svelte 3.0.6 没有
 *    `breaks` / remark-breaks 选项（marked 词法器不接受该参数），因此在渲染前
 *    把单换行补成 markdown 硬换行（行尾两个空格）。
 *
 * 围栏代码块、行内代码、用户自己写的 markdown 链接内部一律不动。
 */

import { parseMentionToken } from '@kepcup/shared';
import {
  localPathName,
  segmentComposerText,
  type MentionKind,
  type MentionTarget,
} from './composer-text';

/** 提及链接的 href 前缀（相对锚点，streamdown 不拦截、component 可识别）。 */
export const MENTION_HREF_PREFIX = '#kepcup-mention:';

/** 能进正文的提及种类（`pick-file` 只是 @ 菜单动作，不会出现在消息里）。 */
export type MentionHrefKind = Exclude<MentionKind, 'pick-file'>;

export interface MentionHref {
  kind: MentionHrefKind;
  /** Bot / 项目组为 token，本地路径为绝对路径（均已解码）。 */
  value: string;
}

interface TextRange {
  start: number;
  end: number;
}

/** ASCII 标点：markdown 里都可反斜杠转义，转义后字形不变（`@` 不算，无需转义）。 */
const ASCII_PUNCTUATION = /[\u0021-\u003F\u005B-\u0060\u007B-\u007E]/g;

/** 行尾已带两个空格或反斜杠：已经是硬换行，别重复加。 */
const ALREADY_HARD_BREAK = /(?: {2,}|\\)$/;

/** 围栏标记行（``` / ~~~）：开/闭围栏都不加硬换行。 */
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;

/** setext 标题下划线 / 分隔线：补空格可能改变块语义，跳过。 */
const SETEXT_OR_RULE = /^ {0,3}(?:=+|-+(?: *-+)*|[_*](?: *[_*])+)\s*$/;

/** 4 空格 / tab 缩进的块（缩进代码块、列表续行）：保守起见不加硬换行。 */
const INDENTED_LINE = /^(?: {4,}|\t)/;

/** 用户自己写的行内链接 / 图片：内部不再做提及替换（嵌套链接会破坏语法）。 */
const INLINE_LINK = /!?\[[^\]\n]*\]\([^)\n]*\)/g;

function escapeMarkdownLabel(label: string): string {
  return label.replace(ASCII_PUNCTUATION, (char) => `\\${char}`);
}

/** 提及目标 → markdown 链接 href（value 用已去掉 token 前缀的 id / 路径）。 */
export function buildMentionHref(target: MentionTarget): string {
  const parsed = parseMentionToken(target.token);
  return `${MENTION_HREF_PREFIX}${parsed.kind}:${encodeURIComponent(parsed.id)}`;
}

/** 链接 href → 提及信息；不是提及链接时返回 null。 */
export function parseMentionHref(href: string | null | undefined): MentionHref | null {
  if (!href || !href.startsWith(MENTION_HREF_PREFIX)) return null;
  const rest = href.slice(MENTION_HREF_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;
  const kind = rest.slice(0, separator);
  if (kind !== 'bot' && kind !== 'project' && kind !== 'file' && kind !== 'folder') return null;
  try {
    return { kind, value: decodeURIComponent(rest.slice(separator + 1)) };
  } catch {
    return null;
  }
}

function fenceRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let fence: { char: string; length: number } | null = null;
  let fenceStart = 0;
  let index = 0;
  while (index <= text.length) {
    const newline = text.indexOf('\n', index);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(index, lineEnd);
    if (fence === null) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open?.[1] !== undefined) {
        fence = { char: open[1][0] ?? '`', length: open[1].length };
        fenceStart = index;
      }
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (
        close?.[1] !== undefined &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length
      ) {
        ranges.push({ start: fenceStart, end: lineEnd });
        fence = null;
      }
    }
    if (newline === -1) break;
    index = newline + 1;
  }
  // 未闭合的围栏：一直保护到文末（marked 也按围栏处理）。
  if (fence !== null) ranges.push({ start: fenceStart, end: text.length });
  return ranges;
}

function inlineCodeRanges(text: string, blocked: readonly TextRange[]): TextRange[] {
  const ranges: TextRange[] = [];
  let index = 0;
  while (index < text.length) {
    const covering = blocked.find((range) => index >= range.start && index < range.end);
    if (covering !== undefined) {
      index = covering.end;
      continue;
    }
    if (text[index] !== '`') {
      index += 1;
      continue;
    }
    let openLength = 0;
    while (text[index + openLength] === '`') openLength += 1;
    let cursor = index + openLength;
    let closeAt = -1;
    while (cursor < text.length) {
      if (text[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      let runLength = 0;
      while (text[cursor + runLength] === '`') runLength += 1;
      // CommonMark：闭合反引号串长度必须与开启串完全相同。
      if (runLength === openLength) {
        closeAt = cursor;
        break;
      }
      cursor += runLength;
    }
    if (closeAt === -1) {
      // 没有闭合：按字面量处理，继续往后找别的行内代码。
      index += openLength;
      continue;
    }
    ranges.push({ start: index, end: closeAt + openLength });
    index = closeAt + openLength;
  }
  return ranges;
}

/**
 * 不做任何改写的位置：围栏代码块、行内代码、用户自带的 markdown 行内链接。
 * 返回按起点排序、互不重叠的区间。
 */
export function protectedRanges(text: string): TextRange[] {
  const fences = fenceRanges(text);
  const links: TextRange[] = [];
  INLINE_LINK.lastIndex = 0;
  for (let match = INLINE_LINK.exec(text); match !== null; match = INLINE_LINK.exec(text)) {
    links.push({ start: match.index, end: match.index + match[0].length });
  }
  const ranges = [...fences, ...links, ...inlineCodeRanges(text, fences)].sort(
    (a, b) => a.start - b.start,
  );
  const merged: TextRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function overlaps(ranges: readonly TextRange[], start: number, end: number): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function covers(ranges: readonly TextRange[], position: number): boolean {
  return ranges.some((range) => position >= range.start && position < range.end);
}

function mentionMarkdown(segmentText: string, target: MentionTarget): string {
  const isLocal = target.kind === 'file' || target.kind === 'folder';
  const label = isLocal ? localPathName(target.path ?? target.name) : segmentText;
  return `[${escapeMarkdownLabel(label)}](<${buildMentionHref(target)}>)`;
}

/**
 * `@提及` → markdown 链接。原文里的围栏代码块 / 行内代码 / 行内链接内部保持
 * 原样（代码块里的 `@名字` 不该变成胶囊，也不该破坏代码内容）。
 */
export function mentionsToMarkdown(text: string, targets: MentionTarget[]): string {
  if (!text.includes('@') || targets.length === 0) return text;
  const segments = segmentComposerText(text, targets);
  if (!segments.some((segment) => segment.kind === 'mention')) return text;
  const ranges = protectedRanges(text);
  let offset = 0;
  let markdown = '';
  for (const segment of segments) {
    const start = offset;
    offset += segment.text.length;
    if (segment.kind === 'mention' && !overlaps(ranges, start, offset)) {
      markdown += mentionMarkdown(segment.text, segment.target);
      continue;
    }
    markdown += segment.text;
  }
  return markdown;
}

/**
 * 段内单换行 → markdown 硬换行（行尾补两个空格）。跳过：
 * 空行前后（段落分隔本来就在）、围栏代码块与行内代码内部、缩进代码块、
 * setext 下划线 / 分隔线、已经是硬换行的行、围栏标记行本身。
 */
export function insertHardLineBreaks(markdown: string): string {
  if (!markdown.includes('\n')) return markdown;
  const ranges = protectedRanges(markdown);
  const lines = markdown.split('\n');
  const result: string[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;
    const next = lines[index + 1];
    const hardBreak =
      line.trim().length > 0 &&
      next !== undefined &&
      next.trim().length > 0 &&
      !ALREADY_HARD_BREAK.test(line) &&
      !FENCE_LINE.test(line) &&
      !SETEXT_OR_RULE.test(line) &&
      !SETEXT_OR_RULE.test(next) &&
      !INDENTED_LINE.test(line) &&
      // 行尾的换行落在围栏 / 行内代码内部：不能往里塞空格。
      !covers(ranges, lineEnd);
    result.push(hardBreak ? `${line}  ` : line);
  }
  return result.join('\n');
}

/** 用户消息正文 → markdown 源码（提及 + 硬换行）。 */
export function composerTextToMarkdown(text: string, targets: MentionTarget[]): string {
  return insertHardLineBreaks(mentionsToMarkdown(text, targets));
}
