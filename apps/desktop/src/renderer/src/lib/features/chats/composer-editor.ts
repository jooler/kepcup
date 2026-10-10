/**
 * Composer 的 TipTap 编辑器辅助：编辑器扩展集（markdown 序列化规格补齐）
 * 与无 DOM 的纯函数（提及 token 收集/合并）。序列化行为由
 * composer-editor.test.ts 用 MarkdownManager 直接验证（无需编辑器实例）。
 */

import type { JSONContent } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import Mention from '@tiptap/extension-mention';
import type { MentionTarget } from './composer-text';
import { resolveMentionTokens } from './composer-text';

/**
 * 编辑器扩展里的基础节点集。mention 节点补 renderMarkdown（序列化成
 * `@名字` 纯文本，AI 收到的就是可读的提及），hardBreak 补换行序列化
 * （Shift+Enter 的软换行不丢）。序列化行为由 composer-editor.test.ts
 * 用 MarkdownManager 直接验证（无需编辑器实例）。
 */
export const composerNodes = [
  Document,
  Paragraph,
  Text,
  HardBreak.extend({
    renderMarkdown() {
      return '\n';
    },
  }),
  BulletList,
  OrderedList,
  ListItem,
];

/** mention 节点（component 侧再 .configure 挂 suggestion 弹层）。 */
export const composerMention = Mention.extend({
  renderMarkdown(node: JSONContent) {
    const label = node.attrs?.label ?? node.attrs?.id ?? '';
    return `@${label}`;
  },
});

/** 遍历编辑器文档 JSON，按出现顺序收集 mention 节点的结构化 token。 */
export function collectMentionTokens(doc: JSONContent): string[] {
  const tokens: string[] = [];
  const walk = (node: JSONContent | undefined): void => {
    if (!node) return;
    if (node.type === 'mention') {
      const token = node.attrs?.id;
      if (typeof token === 'string' && token.length > 0 && !tokens.includes(token)) {
        tokens.push(token);
      }
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return tokens;
}

/**
 * 发送时的提及 token：文档里的 mention 节点 ∪ 正文里手打的全名。重载的
 * 草稿/手动输入都是纯 markdown 文本（mention 节点不往返），正则解析兜底。
 */
export function mergeMentionTokens(
  doc: JSONContent,
  markdown: string,
  targets: MentionTarget[],
): string[] {
  return [...new Set([...collectMentionTokens(doc), ...resolveMentionTokens(markdown, targets)])];
}
