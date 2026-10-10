/**
 * Composer 文本纯函数（无 DOM，可单测）：@ 提及的名称注册表与分词。
 * 编辑器内的列表/提及行为由 TipTap 原生接管；这里的分词仍服务于两处
 * ——用户气泡（MessageBody）里 @ 部分的着色，以及草稿/手打名称的
 * 结构化 token 解析（composer-editor.mergeMentionTokens）。
 */

import type { Bot } from '@kepcup/shared';
import { groupMentionToken } from '@kepcup/shared';

// --- @ 提及 -----------------------------------------------------------------

export type MentionKind = 'bot' | 'group';

export interface MentionTarget {
  /** 存进 message.mentions 的 token：Bot 用裸 id，群用 `group:<id>`。 */
  token: string;
  /** 展示名（Bot 名或群标题）。 */
  name: string;
  kind: MentionKind;
  /** Bot 简介（弹层副标题）。 */
  bio?: string;
  /** 管家（特殊成员：弹层里行下加分隔线分区）。 */
  butler?: boolean;
}

/**
 * 名称注册表：当前群成员优先，其余活跃 Bot 次之，其他群聊最后。同名先到
 * 先得（成员优先于同名的外部 Bot/群）；当前会话自己不作候选。
 */
export function buildMentionTargets(input: {
  memberBots: Bot[];
  allBots: Bot[];
  groups: { id: string; title: string | null }[];
  currentConversationId?: string | null;
  /** 不作候选的 Bot（如单聊里当前对话的 Bot 自己——@ 自己没有意义）。 */
  excludeBotIds?: string[];
}): MentionTarget[] {
  const targets: MentionTarget[] = [];
  const seenNames = new Set<string>();
  const seenTokens = new Set<string>();
  const excluded = new Set(input.excludeBotIds ?? []);
  const push = (
    token: string,
    rawName: string | null | undefined,
    kind: MentionKind,
    bio?: string,
    butler = false,
  ): void => {
    const trimmed = (rawName ?? '').trim();
    if (trimmed.length === 0 || seenNames.has(trimmed) || seenTokens.has(token)) return;
    seenNames.add(trimmed);
    seenTokens.add(token);
    targets.push({ token, name: trimmed, kind, bio, butler });
  };
  for (const bot of input.memberBots) {
    if (!excluded.has(bot.id)) {
      push(bot.id, bot.name, 'bot', bot.bio, bot.systemRole === 'butler');
    }
  }
  for (const bot of input.allBots) {
    if (!excluded.has(bot.id)) {
      push(bot.id, bot.name, 'bot', bot.bio, bot.systemRole === 'butler');
    }
  }
  for (const group of input.groups) {
    if (group.id === input.currentConversationId) continue;
    push(groupMentionToken(group.id), group.title, 'group');
  }
  return targets;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 提及匹配：`@名字` 两侧都要落在边界上——前不含字母/数字（排除邮箱
 * `a@名字`），后不含字母/数字（`@阿甲x` 不算）。名字按长度降序进备选，
 * 长名优先命中。
 */
export function buildMentionRegex(names: string[]): RegExp | null {
  const escaped = [...new Set(names.map((n) => n.trim()))]
    .filter((n) => n.length > 0 && !n.includes('\n'))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (escaped.length === 0) return null;
  return new RegExp(
    `(?<=^|[^\\p{L}\\p{N}_@-])@(${escaped.join('|')})(?=$|[^\\p{L}\\p{N}_-])`,
    'gu',
  );
}

export type ComposerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; target: MentionTarget }
  | { kind: 'list-marker'; text: string };

/**
 * 把纯文本切成可分别着色的片段：@提及（按注册表精确匹配，手动输入的
 * 全名同样命中）、行首列表标记、其余纯文本。片段首尾相接还原原文。
 * 用于用户气泡（MessageBody）的提及着色——气泡是纯文本渲染。
 */
export function segmentComposerText(text: string, targets: MentionTarget[]): ComposerSegment[] {
  const byName = new Map<string, MentionTarget>();
  for (const target of targets) byName.set(target.name, target);
  const mentionRegex = byName.size > 0 ? buildMentionRegex([...byName.keys()]) : null;

  // 先按提及切开，再在纯文本片段里逐行标出列表标记。
  const mentionPass: ComposerSegment[] = [];
  if (mentionRegex === null) {
    mentionPass.push({ kind: 'text', text });
  } else {
    let cursor = 0;
    mentionRegex.lastIndex = 0;
    for (let match = mentionRegex.exec(text); match !== null; match = mentionRegex.exec(text)) {
      if (match.index > cursor) {
        mentionPass.push({ kind: 'text', text: text.slice(cursor, match.index) });
      }
      const target = byName.get(match[1] ?? '');
      mentionPass.push(
        target ? { kind: 'mention', text: match[0], target } : { kind: 'text', text: match[0] },
      );
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) mentionPass.push({ kind: 'text', text: text.slice(cursor) });
  }

  const segments: ComposerSegment[] = [];
  let lineStart = true;
  for (const segment of mentionPass) {
    if (segment.kind !== 'text') {
      lineStart = false;
      segments.push(segment);
      continue;
    }
    // 逐行扫描：行首的列表标记切成独立片段（仅着色，不改字形）。
    let rest = segment.text;
    while (rest.length > 0) {
      if (lineStart) {
        const marker = /^([ \t]*)(\d+\.|[-*+])(?=[ \t]|$)/.exec(rest);
        if (marker) {
          const indent = marker[1] ?? '';
          const token = marker[2] ?? '';
          if (indent.length > 0) segments.push({ kind: 'text', text: indent });
          segments.push({ kind: 'list-marker', text: token });
          rest = rest.slice(indent.length + token.length);
          lineStart = false;
          continue;
        }
      }
      const newline = rest.indexOf('\n');
      if (newline === -1) {
        segments.push({ kind: 'text', text: rest });
        rest = '';
      } else {
        segments.push({ kind: 'text', text: rest.slice(0, newline + 1) });
        rest = rest.slice(newline + 1);
        lineStart = true;
      }
    }
  }
  return segments;
}

/** 手动输入的 `@名字` 也解析成结构化 token（与弹层选择同一注册表）。 */
export function resolveMentionTokens(text: string, targets: MentionTarget[]): string[] {
  const regex = buildMentionRegex(targets.map((t) => t.name));
  if (regex === null) return [];
  const tokens: string[] = [];
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    const target = targets.find((t) => t.name === (match?.[1] ?? ''));
    if (target && !tokens.includes(target.token)) tokens.push(target.token);
  }
  return tokens;
}
