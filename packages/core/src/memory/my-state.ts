import { MY_STATE_COMMITMENT_HORIZON_MS, type Conversation, type Run } from '@kepcup/shared';
import type { MemoryStore } from './store.js';

export interface MyStateInput {
  botId: string;
  /** The conversation being rendered; its own runs are excluded. */
  currentConversationId: string | null;
  now: number;
  store: MemoryStore;
  /** Active runs of the bot (status filter applied here). */
  activeRuns: Run[];
  /** Loads a conversation (null = deleted). */
  getConversation(id: string): Conversation | null;
  /** Loads a trigger message of a run (for the 30-char preview). */
  getMessage(id: string): { content: unknown } | null;
}

/**
 * <my_state> assembly (docs/dev/phases/P07-memory.md 任务 10): commitments of
 * the next 7 days + this bot's running / waiting runs in OTHER conversations
 * (conversation name + first 30 chars of the trigger message — titles only,
 * never content, docs/design/04-memory.md "自我状态").
 */
export function buildMyState(input: MyStateInput): string[] {
  const lines: string[] = [];
  const horizon = input.now + MY_STATE_COMMITMENT_HORIZON_MS;
  const commitments = input.store
    .commitments()
    .filter((item) => item.dueAt !== null && item.dueAt > input.now && item.dueAt <= horizon)
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  for (const item of commitments) {
    const due = new Date(item.dueAt!).toISOString().slice(0, 10);
    lines.push(`- 承诺（${due} 前）：${item.content}`);
  }

  const elsewhere = input.activeRuns.filter(
    (run) =>
      run.botId === input.botId &&
      run.conversationId !== null &&
      run.conversationId !== input.currentConversationId &&
      (run.status === 'running' ||
        run.status === 'waiting_approval' ||
        run.status === 'waiting_lease'),
  );
  for (const run of elsewhere) {
    const conversation = input.getConversation(run.conversationId!);
    if (conversation === null) continue;
    const name = conversation.type === 'group' ? (conversation.title ?? '群聊') : '与用户的单聊';
    const trigger: { content: unknown } | null | undefined = run.triggerMessageIds
      .map((id) => input.getMessage(id))
      .find((m) => m !== null);
    const preview = first30(triggerText(trigger ?? null));
    const statusLabel = run.status === 'running' ? '进行中' : '等待中';
    lines.push(`- ${statusLabel}：${name} — ${preview}`);
  }
  return lines;
}

function triggerText(message: { content: unknown } | null): string {
  if (message === null) return '';
  const content = message.content as { text?: string } | undefined;
  return content?.text ?? '';
}

export function first30(text: string): string {
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

export function formatMyState(lines: string[]): string {
  if (lines.length === 0) return '';
  return `<my_state>\n${lines.join('\n')}\n</my_state>`;
}
