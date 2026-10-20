/**
 * Composer 文本纯函数（无 DOM，可单测）：@ 提及的名称注册表与分词。
 * 编辑器内的列表/提及行为由 TipTap 原生接管；这里的分词仍服务于两处
 * ——用户气泡（MessageBody）里 @ 部分的着色，以及草稿/手打名称的
 * 结构化 token 解析（composer-editor.mergeMentionTokens）。
 */

import type { Bot } from '@kepcup/shared';
import { parseLocalPathMentionToken, projectMentionToken } from '@kepcup/shared';

// --- @ 提及 -----------------------------------------------------------------

/**
 * 候选/提及种类。`pick-file` 是 @ 菜单里的动作项（选择本地文件或文件夹），
 * 不会进入消息 mentions；`file` / `folder` 是已选中的本地路径提及。
 */
export type MentionKind = 'bot' | 'project' | 'file' | 'folder' | 'pick-file';

export interface MentionTarget {
  /** 存进 message.mentions 的 token：Bot 用裸 id，项目组用 `project:<id>`，本地路径用 `file:`/`folder:` 前缀。 */
  token: string;
  /**
   * 匹配/展示名：Bot 名、项目组标题；本地路径提及存完整路径（正文里就是
   * `@完整路径`，气泡里换成 basename + 图标展示）。
   */
  name: string;
  kind: MentionKind;
  /** Bot 简介（弹层副标题）。 */
  bio?: string;
  /** 管家（特殊成员：弹层里行下加分隔线分区）。 */
  butler?: boolean;
  /** Bot 头像值（preset:/upload:）；弹层用它与名称着色。 */
  avatar?: string;
  /** 本地文件/文件夹的绝对路径（kind 为 file/folder 时有值）。 */
  path?: string;
}

/** @ 菜单里的「选择文件或文件夹」动作项 token（只用于弹层，不发送）。 */
export const PICK_FILE_MENTION_TOKEN = '__kepcup_pick_local_path__';

export function createPickFileTarget(name: string): MentionTarget {
  return { token: PICK_FILE_MENTION_TOKEN, name, kind: 'pick-file' };
}

/** 本地路径的展示名（basename；根目录等退化时回退完整路径）。 */
export function localPathName(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .at(-1) ?? path
  );
}

/**
 * 从消息 mentions 里还原本地路径提及的展示目标。正文是 `@完整路径`，因此
 * name 用路径本身（分词匹配用），展示层再换成 basename + 图标。
 */
export function buildLocalPathMentionTargets(tokens: readonly string[]): MentionTarget[] {
  const targets: MentionTarget[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    const local = parseLocalPathMentionToken(token);
    if (local === null) continue;
    seen.add(token);
    targets.push({ token, name: local.path, kind: local.kind, path: local.path });
  }
  return targets;
}

/**
 * 名称注册表：当前项目成员优先，其余活跃 Bot 次之，其他项目组最后。同名先到
 * 先得（成员优先于同名的外部 Bot/项目组）；当前会话自己不作候选。
 */
export function buildMentionTargets(input: {
  memberBots: Bot[];
  allBots: Bot[];
  projects: { id: string; title: string | null }[];
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
    avatar?: string | null,
  ): void => {
    const trimmed = (rawName ?? '').trim();
    if (trimmed.length === 0 || seenNames.has(trimmed) || seenTokens.has(token)) return;
    seenNames.add(trimmed);
    seenTokens.add(token);
    targets.push({
      token,
      name: trimmed,
      kind,
      bio,
      butler,
      ...(avatar === null || avatar === undefined ? {} : { avatar }),
    });
  };
  for (const bot of input.memberBots) {
    if (!excluded.has(bot.id)) {
      push(bot.id, bot.name, 'bot', bot.bio, bot.systemRole === 'butler', bot.avatar);
    }
  }
  for (const bot of input.allBots) {
    if (!excluded.has(bot.id)) {
      push(bot.id, bot.name, 'bot', bot.bio, bot.systemRole === 'butler', bot.avatar);
    }
  }
  for (const project of input.projects) {
    if (project.id === input.currentConversationId) continue;
    push(projectMentionToken(project.id), project.title, 'project');
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
 *
 * 本地文件/文件夹的正文是 `@绝对路径`：按 token 里的路径做**字面**匹配，
 * 不套用 Bot/项目组的边界规则（用户常写成「看@/tmp/a.md」，`@` 前是中文，
 * 边界规则会漏掉）。
 */
export function segmentComposerText(text: string, targets: MentionTarget[]): ComposerSegment[] {
  const localByText = new Map<string, MentionTarget>();
  for (const target of targets) {
    if (
      (target.kind === 'file' || target.kind === 'folder') &&
      target.path !== undefined &&
      target.path.length > 0
    ) {
      localByText.set(`@${target.path}`, target);
    }
  }
  const localPatterns = [...localByText.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);

  const byName = new Map<string, MentionTarget>();
  for (const target of targets) {
    if (target.kind !== 'file' && target.kind !== 'folder') byName.set(target.name, target);
  }
  const nameRegex = byName.size > 0 ? buildMentionRegex([...byName.keys()]) : null;
  const sources = [...localPatterns, ...(nameRegex === null ? [] : [nameRegex.source])];
  const mentionRegex = sources.length > 0 ? new RegExp(sources.join('|'), 'gu') : null;

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
      const target =
        match[1] !== undefined ? byName.get(match[1] ?? '') : localByText.get(match[0]);
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
