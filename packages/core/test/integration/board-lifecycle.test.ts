import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, makeProject, type TestStack } from '@kepcup/testkit';
import type { BoardService } from '../../src/board/board-service.js';

/**
 * Deleting a card, a column, or the project removes the card conversation
 * and its runs, FTS rows, schedule, and todo. Member removal and bot deletion
 * clear the executor. The cascade order does not raise a foreign-key error.
 */

let stack: TestStack;
let leadId: string;
let memberId: string;

beforeAll(async () => {
  stack = await createTestStack();
  leadId = (await makeBot(stack.core, 'Lead')).id;
  memberId = (await makeBot(stack.core, 'Member')).id;
}, 60_000);

afterAll(() => stack.cleanup());

function board(): BoardService {
  return stack.core.services.board!;
}

async function projectWithCard(text: string): Promise<{
  projectId: string;
  columnId: string;
  cardId: string;
}> {
  const projectId = (
    await makeProject(stack.core, text, [leadId, memberId], { leadBotId: leadId })
  ).id;
  const columnId = board().get(projectId, ['Todo', 'Doing'], 'user').columns[0]!.id;
  const cardId = board().createCard(projectId, columnId, text, undefined, 'user').id;
  return { projectId, columnId, cardId };
}

function count(sql: string, ...params: string[]): number {
  const row = stack.core.services.mainDb!.prepare(sql).get(...params) as { n: number };
  return row.n;
}

function seedExecution(cardId: string, botId: string): string {
  const assigned = board().assign(cardId, botId, 'user');
  const conversationId = assigned.card.conversationId!;
  board().schedule(cardId, '2099-03-01T00:00:00.000Z', 'user');
  stack.core.services.domain!.messages.append({
    conversationId,
    senderType: 'user',
    kind: 'text',
    text: '卡片里的一句话',
  });
  stack.core.services.domain!.runs.create({
    botId,
    conversationId,
    loopType: 'turn',
    triggerReason: 'direct',
    triggerMessageIds: [],
  });
  return conversationId;
}

function expectGone(conversationId: string, cardId: string): void {
  expect(
    count('select count(*) as n from conversations where id = ?', conversationId),
  ).toBe(0);
  expect(
    count(
      "select count(*) as n from conversations where type = 'card' and card_todo_id = ?",
      cardId,
    ),
  ).toBe(0);
  expect(count('select count(*) as n from messages_fts where conversation_id = ?', conversationId)).toBe(
    0,
  );
  expect(count('select count(*) as n from todos where id = ?', cardId)).toBe(0);
  expect(count('select count(*) as n from board_cards where todo_id = ?', cardId)).toBe(0);
  expect(
    stack.core.services.schedules!.store.listActiveForTodo(cardId),
  ).toEqual([]);
  expect(stack.core.services.domain!.runs.listByConversation(conversationId, 20)).toEqual([]);
}

describe('board lifecycle', () => {
  it('removes the conversation, runs, FTS, schedule, and todo with the card', async () => {
    const { cardId } = await projectWithCard('删卡');
    const conversationId = seedExecution(cardId, memberId);
    expect(count('select count(*) as n from messages_fts where conversation_id = ?', conversationId)).toBeGreaterThan(
      0,
    );
    await board().deleteCard(cardId, 'user');
    expectGone(conversationId, cardId);
  }, 30_000);

  it('uses the same path when a column deletes its cards', async () => {
    const { projectId, columnId, cardId } = await projectWithCard('删栏');
    const extra = board().createColumn(projectId, 'Extra', null, 'user');
    const conversationId = seedExecution(cardId, memberId);
    await board().deleteColumn(columnId, true, 'user');
    expectGone(conversationId, cardId);
    const remaining = board()
      .get(projectId, undefined, 'user')
      .columns.map((column) => column.id);
    expect(remaining).not.toContain(columnId);
    expect(remaining).toContain(extra.id);
  }, 30_000);

  it('deletes card conversations before the project row', async () => {
    const { projectId, cardId } = await projectWithCard('删项目');
    const conversationId = seedExecution(cardId, memberId);
    await expect(
      stack.core.services.domain!.lifecycle.deleteConversation(projectId),
    ).resolves.toBeUndefined();
    expectGone(conversationId, cardId);
    expect(count('select count(*) as n from conversations where id = ?', projectId)).toBe(0);
    expect(count('select count(*) as n from board_columns where project_id = ?', projectId)).toBe(0);
  }, 30_000);

  it('clears the executor when the member leaves or the bot is deleted', async () => {
    const left = await projectWithCard('移出');
    const leftConversation = seedExecution(left.cardId, memberId);
    await stack.core.rpc.call('projects.removeMember', {
      conversationId: left.projectId,
      botId: memberId,
    });
    const afterLeave = board().get(left.projectId, undefined, 'user').cards[0]!;
    expect(afterLeave.todo.assignee).toBeNull();
    expect(afterLeave.todo.blockedReason).toBe('执行成员已移出项目组');
    expect(stack.core.services.domain!.conversations.get(leftConversation)?.readOnly).toBe(true);
    expect(stack.core.services.schedules!.store.listActiveForTodo(left.cardId)).toEqual([]);

    const gone = await projectWithCard('删除 Bot');
    const goneConversation = seedExecution(gone.cardId, memberId);
    await stack.core.rpc.call('bots.delete', { id: memberId });
    const afterDelete = board().get(gone.projectId, undefined, 'user').cards[0]!;
    expect(afterDelete.todo.assignee).toBeNull();
    expect(afterDelete.todo.blockedReason).toBe('执行成员已删除');
    expect(stack.core.services.domain!.conversations.get(goneConversation)?.readOnly).toBe(true);
    expect(stack.core.services.schedules!.store.listActiveForTodo(gone.cardId)).toEqual([]);
  }, 30_000);
});
