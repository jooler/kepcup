/**
 * 去掉一段 Markdown 里的语法标记，留下可读文本。
 * 标题、强调、链接、列表、引用、表格和代码围栏等标记会去掉；
 * 正文、链接文字、图片替代文字和代码内容会保留。
 * 未闭合的围栏（例如流式输出）也能处理，不会抛错。
 *
 * Svelte 里：`import { stripMarkdown } from '$lib/strip-markdown';`
 */
export function stripMarkdown(markdown: string): string {
  if (!markdown) return '';

  const slots: string[] = [];
  let text = markdown.replace(/\r\n?/g, '\n');
  text = protectFences(text, slots);
  text = protectInlineCode(text, slots);
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, '$1');
  text = text.replace(/(?<!\$)\$([^$\n]+)\$(?!\$)/g, '$1');
  text = stripLinks(text);
  text = text.replace(/<\/?[A-Za-z][^>\n]*>/g, '');
  text = text
    .split('\n')
    .map((line) => stripLine(line))
    .join('\n');
  text = stripEmphasis(text);
  text = text.replace(/\[\^[^\]]+\]/g, '');
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return restore(text, slots);
}

const SLOT = /\uE000(\d+)\uE001/g;

function hold(slots: string[], value: string): string {
  const id = slots.length;
  slots.push(value);
  return `\uE000${id}\uE001`;
}

function protectFences(text: string, slots: string[]): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? '');
    if (!open) {
      out.push(lines[i] ?? '');
      i += 1;
      continue;
    }
    const fence = open[1] ?? '```';
    const marker = fence[0] ?? '`';
    const len = fence.length;
    const body: string[] = [];
    i += 1;
    const closeRe = new RegExp(`^[ \\t]{0,3}${marker}{${len},}[ \\t]*$`);
    while (i < lines.length) {
      if (closeRe.test(lines[i] ?? '')) {
        i += 1;
        break;
      }
      body.push(lines[i] ?? '');
      i += 1;
    }
    out.push(hold(slots, body.join('\n')));
  }
  return out.join('\n');
}

function protectInlineCode(text: string, slots: string[]): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      out += text[i];
      i += 1;
      continue;
    }
    let n = 0;
    while (text[i + n] === '`') n += 1;
    const closer = findClosingRun(text, i + n, n);
    if (closer < 0) {
      out += text.slice(i);
      break;
    }
    let body = text.slice(i + n, closer);
    if (body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '') {
      body = body.slice(1, -1);
    }
    out += hold(slots, body);
    i = closer + n;
  }
  return out;
}

function findClosingRun(text: string, from: number, n: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== '`') continue;
    let run = 0;
    while (text[i + run] === '`') run += 1;
    if (run === n) return i;
    i += run - 1;
  }
  return -1;
}

function stripLinks(text: string): string {
  const target = '(?:<[^>\\n]+>|[^\\s)\\n]+)(?:\\s+(?:"[^"\\n]*"|\'[^\'\\n]*\'))?';
  const label = '((?:\\\\.|[^\\]\\n])+)';
  let s = text.replace(new RegExp(`!\\[${label}\\]\\(${target}\\)`, 'g'), '$1');
  s = s.replace(new RegExp(`\\[${label}\\]\\(${target}\\)`, 'g'), '$1');
  s = s.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1');
  return s;
}

function stripLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  if (/^\[[^\]]+\]:\s+\S/.test(trimmed)) return '';
  if (/^\[\^[^\]]+\]:/.test(trimmed)) return '';
  if (/^(?:[-*_]\s*){3,}$/.test(trimmed) || /^=+$/.test(trimmed)) return '';
  if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(trimmed)) return '';

  let s = trimmed;
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(/^>\s?/, '');
  }
  s = s.replace(/^#{1,6}(?:[ \t]+|$)/, '');
  s = s.replace(/[ \t]+#+\s*$/, '');
  s = s.replace(/^(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '');
  if ((s.match(/\|/g) || []).length >= 2) {
    s = s
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
      .join(' ');
  }
  return s.trim();
}

function stripEmphasis(text: string): string {
  // 星号规则要求内容两端非空白：否则「3 * 4」这类乘号会被当成斜体连内容一起吃掉
  // （CommonMark 的左右 flanking 规则的简化版）。`__` 不加词边界守卫——词内双下划线
  // 按 CommonMark 本就渲染为强调，且加了会破坏「**加粗**中文」这类紧邻场景。
  const rules: RegExp[] = [
    /\*\*\*(\S(?:[^*\n]*\S)?)\*\*\*/g,
    /___([^_\n]+)___/g,
    /\*\*(\S(?:[^*\n]*\S)?)\*\*/g,
    /__([^_\n]+)__/g,
    /~~([^~\n]+)~~/g,
    /\*(\S(?:[^*\n]*\S)?)\*/g,
    /(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu,
  ];
  let s = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const before = s;
    for (const rule of rules) s = s.replace(rule, '$1');
    if (s === before) break;
  }
  return s;
}

function restore(text: string, slots: string[]): string {
  return text.replace(SLOT, (_m, id: string) => slots[Number(id)] ?? '');
}
