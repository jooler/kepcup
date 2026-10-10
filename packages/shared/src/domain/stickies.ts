import { z } from 'zod';

/**
 * 辅助阅读便签（渲染层在消息里选中文本钉出，浮在对话容器上层，类
 * mac stickies）。行在 main.db `stickies`；conversation 作用域只在来源
 * 对话显示，global 作用域在所有对话显示且共享位置与层号。
 */

export const stickieScopeSchema = z.enum(['conversation', 'global']);
export type StickieScope = z.infer<typeof stickieScopeSchema>;

/** 选中文本钉出的便签正文上限（长回复也可能整段钉住）。 */
export const STICKIE_TEXT_MAX_CHARS = 20000;

export const stickiePositionSchema = z.object({ x: z.number().int(), y: z.number().int() });
export type StickiePosition = z.infer<typeof stickiePositionSchema>;

export const stickieSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  scope: stickieScopeSchema,
  text: z.string(),
  /** 对话容器内的左上角（px）；null = 尚未放置（渲染层取默认落点后回写）。 */
  position: stickiePositionSchema.nullable(),
  /** 点击置顶的层号：单调递增，值大者在上。 */
  z: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Stickie = z.infer<typeof stickieSchema>;
