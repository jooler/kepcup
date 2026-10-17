import type { SqliteDatabase } from '../../src/infra/db.js';

/**
 * Inserts a `type='project'` conversation with the mandatory lead (D92 T1a).
 * `memberBotIds` defaults to `[leadBotId]`; join timestamps are distinct
 * (joined_at ordering matters for lead/preview determinism).
 */
export function insertProjectConversation(
  db: SqliteDatabase,
  input: {
    id: string;
    title?: string | null;
    goal?: string | null;
    leadBotId: string;
    memberBotIds?: string[];
  },
): void {
  db.prepare(
    "insert into conversations (id, type, title, goal, lead_bot_id, created_at) values (?, 'project', ?, ?, ?, 0)",
  ).run(input.id, input.title ?? null, input.goal ?? null, input.leadBotId);
  const members = input.memberBotIds ?? [input.leadBotId];
  members.forEach((botId, index) => {
    db.prepare(
      'insert into conversation_members (conversation_id, bot_id, joined_at) values (?, ?, ?)',
    ).run(input.id, botId, index + 1);
  });
}
