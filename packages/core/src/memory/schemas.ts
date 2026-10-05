import { Type } from '@earendil-works/pi-ai';
import {
  memoryKindSchema,
  memorySourceSchema,
  memorySensitivitySchema,
  profileCategorySchema,
} from '@kepcup/shared';
import { z } from 'zod';

/**
 * Structured output schemas of the P07 background loops
 * (docs/dev/04-agent-runtime.md "反思 / 画像整理 / 记忆整理"). TypeBox feeds
 * the `submit` tool; the parallel zod schemas validate the model's answer.
 */

export const reflectionOutputSchema = z.object({
  runSummary: z.string().min(1).max(2000),
  memories: z.array(
    z.object({
      kind: memoryKindSchema,
      content: z.string().min(1).max(2000),
      subject: z.string().max(200).nullable().optional(),
      source: memorySourceSchema,
      evidenceMessageIds: z.array(z.string()),
      confidence: z.number().min(0).max(1),
      sensitivity: memorySensitivitySchema,
      privateToBot: z.boolean(),
      dueAt: z.string().nullable().optional(),
      validUntil: z.string().nullable().optional(),
    }),
  ),
  profileProposals: z.array(
    z.object({
      category: profileCategorySchema,
      content: z.string().min(1).max(2000),
      source: memorySourceSchema,
      evidenceMessageIds: z.array(z.string()),
      confidence: z.number().min(0).max(1),
      validUntil: z.string().nullable().optional(),
    }),
  ),
  wikiSuggestions: z.array(
    z.object({
      sourceType: z.enum(['attachment', 'url', 'workspace_file']),
      ref: z.string().min(1),
      note: z.string(),
    }),
  ),
  skillSuggestion: z
    .object({ name: z.string().min(1), description: z.string(), reason: z.string() })
    .nullable()
    .optional(),
});
export type ReflectionOutput = z.infer<typeof reflectionOutputSchema>;

export const reflectionParametersSchema = Type.Object({
  runSummary: Type.String({ description: '本次执行的一段话摘要（写入执行记录）' }),
  memories: Type.Array(
    Type.Object({
      kind: Type.Union(
        ['fact', 'preference', 'commitment', 'feedback', 'episode', 'lesson', 'self_note'].map(
          (k) => Type.Literal(k),
        ),
      ),
      content: Type.String({ description: '一句自然语言陈述' }),
      subject: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      source: Type.Union([Type.Literal('explicit'), Type.Literal('inferred')]),
      evidenceMessageIds: Type.Array(Type.String()),
      confidence: Type.Number({ description: '0~1' }),
      sensitivity: Type.Union([Type.Literal('normal'), Type.Literal('sensitive')]),
      privateToBot: Type.Boolean({ description: '用户说“只告诉你”时为 true' }),
      dueAt: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'ISO 时间，承诺截止' }),
      ),
      validUntil: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
  profileProposals: Type.Array(
    Type.Object({
      category: Type.Union(
        ['basic', 'communication', 'work', 'interests', 'boundaries', 'recent'].map((c) =>
          Type.Literal(c),
        ),
      ),
      content: Type.String(),
      source: Type.Union([Type.Literal('explicit'), Type.Literal('inferred')]),
      evidenceMessageIds: Type.Array(Type.String()),
      confidence: Type.Number(),
      validUntil: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
  wikiSuggestions: Type.Array(
    Type.Object({
      sourceType: Type.Union(['attachment', 'url', 'workspace_file'].map((s) => Type.Literal(s))),
      ref: Type.String(),
      note: Type.String(),
    }),
  ),
  skillSuggestion: Type.Optional(
    Type.Union([
      Type.Object({ name: Type.String(), description: Type.String(), reason: Type.String() }),
      Type.Null(),
    ]),
  ),
});

export const curationOutputSchema = z.object({
  operations: z.array(
    z.union([
      z.object({
        op: z.literal('add'),
        proposalId: z.string(),
        category: profileCategorySchema,
        content: z.string().min(1),
      }),
      z.object({
        op: z.literal('update'),
        itemId: z.string(),
        content: z.string().min(1),
        proposalId: z.string(),
      }),
      z.object({
        op: z.literal('supersede'),
        itemId: z.string(),
        proposalId: z.string(),
        content: z.string().min(1),
      }),
      z.object({
        op: z.literal('keep_both'),
        itemId: z.string(),
        proposalId: z.string(),
        note: z.string(),
      }),
      z.object({ op: z.literal('reject'), proposalId: z.string(), reason: z.string() }),
    ]),
  ),
  card: z.string(),
});
export type CurationOutput = z.infer<typeof curationOutputSchema>;

export const curationParametersSchema = Type.Object({
  operations: Type.Array(
    Type.Union([
      Type.Object({
        op: Type.Literal('add'),
        proposalId: Type.String(),
        category: Type.Union(
          ['basic', 'communication', 'work', 'interests', 'boundaries', 'recent'].map((c) =>
            Type.Literal(c),
          ),
        ),
        content: Type.String(),
      }),
      Type.Object({
        op: Type.Literal('update'),
        itemId: Type.String(),
        content: Type.String(),
        proposalId: Type.String(),
      }),
      Type.Object({
        op: Type.Literal('supersede'),
        itemId: Type.String(),
        proposalId: Type.String(),
        content: Type.String(),
      }),
      Type.Object({
        op: Type.Literal('keep_both'),
        itemId: Type.String(),
        proposalId: Type.String(),
        note: Type.String({ description: '冲突说明，Bot 会找时机向用户确认' }),
      }),
      Type.Object({ op: Type.Literal('reject'), proposalId: Type.String(), reason: Type.String() }),
    ]),
  ),
  card: Type.String({ description: '重新编译的画像卡片，不超过预算' }),
});

export const consolidationOutputSchema = z.object({
  operations: z.array(
    z.union([
      z.object({
        op: z.literal('merge'),
        itemIds: z.array(z.string()).min(2),
        content: z.string().min(1),
      }),
      z.object({ op: z.literal('expire'), itemIds: z.array(z.string()).min(1) }),
      z.object({
        op: z.literal('summarize_episodes'),
        itemIds: z.array(z.string()).min(1),
        content: z.string().min(1),
      }),
    ]),
  ),
});
export type ConsolidationOutput = z.infer<typeof consolidationOutputSchema>;

export const consolidationParametersSchema = Type.Object({
  operations: Type.Array(
    Type.Union([
      Type.Object({
        op: Type.Literal('merge'),
        itemIds: Type.Array(Type.String(), { minItems: 2 }),
        content: Type.String(),
      }),
      Type.Object({ op: Type.Literal('expire'), itemIds: Type.Array(Type.String()) }),
      Type.Object({
        op: Type.Literal('summarize_episodes'),
        itemIds: Type.Array(Type.String()),
        content: Type.String(),
      }),
    ]),
  ),
});
