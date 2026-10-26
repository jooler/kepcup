import { z } from 'zod';
import { scheduleKindSchema, todoRunSchema, todoSourceSchema, todoStatusSchema } from './types.js';

/**
 * One column of a project's single board (D103, docs/design/50-project-board.md §5).
 */
export const boardColumnSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  position: z.number(),
  createdAt: z.number(),
});
export type BoardColumn = z.infer<typeof boardColumnSchema>;

/**
 * Schedule slice carried on a board card. Same shape as `TodoEntry['schedule']`
 * (time lives on the workbench schedule row; P1 cards are unscheduled).
 */
export const boardCardScheduleSchema = z
  .object({
    id: z.string(),
    kind: scheduleKindSchema,
    runAt: z.number().nullable(),
    cron: z.string().nullable(),
    timezone: z.string(),
    nextFireAt: z.number().nullable(),
  })
  .nullable();

/**
 * Full card projection. Execution fields are part of the contract from P1 onward;
 * P1 always fills assignee / conversationId / counts / task with the empty defaults.
 * `id` is the todo id.
 */
export const boardCardSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  columnId: z.string(),
  position: z.number(),
  text: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  todo: z.object({
    status: todoStatusSchema,
    blockedReason: z.string().nullable(),
    source: todoSourceSchema,
    assignee: z
      .object({
        botId: z.string(),
        name: z.string(),
      })
      .nullable(),
    schedule: boardCardScheduleSchema,
    lastRun: todoRunSchema.nullable(),
  }),
  conversationId: z.string().nullable(),
  unreadCount: z.number(),
  pendingApprovals: z.number(),
  task: z
    .object({
      running: z.number(),
      queued: z.number(),
      queueReason: z.string().nullable(),
      /** A task in the card conversation is waiting on `ask_user`. */
      awaitingInput: z.boolean(),
    })
    .nullable(),
});
export type BoardCard = z.infer<typeof boardCardSchema>;

/** Tab badge counts (P3 reads this; the schema is fixed in P1). */
export const boardSummarySchema = z.object({
  unread: z.number(),
  pendingApprovals: z.number(),
  delivered: z.number(),
});
export type BoardSummary = z.infer<typeof boardSummarySchema>;
