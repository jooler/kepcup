import { z } from 'zod';

/**
 * 对话便签（右栏 Bot 详情「便签」tab）：用户手动记录协作中值得留存的信息
 * （启动命令、测试账号等）。只属于当前用户，不进入 Bot 上下文、不开放工具。
 * 行在 main.db `conversation_notes`，随所属对话删除级联清理。
 */

/** 单条便签的正文上限（代码片段 / 命令也可能较长）。 */
export const CONVERSATION_NOTE_TEXT_MAX_CHARS = 20000;

export const conversationNoteSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  text: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ConversationNote = z.infer<typeof conversationNoteSchema>;
