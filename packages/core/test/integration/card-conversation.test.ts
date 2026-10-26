import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation, ShareTargets } from '@kepcup/shared';
import { createTestStack, makeBot, makeProject, type TestStack } from '@kepcup/testkit';
import type { BoardService } from '../../src/board/board-service.js';
import type { ConversationsService } from '../../src/domain/conversations.js';

/**
 * Card conversations (P2 B2): one open chat per card, hidden from lists,
 * the address book, direct-chat queries, and share targets.
 */

let stack: TestStack;
let leadId: string;
let memberId: string;
let projectId: string;
let todoId: string;

beforeAll(async () => {
  stack = await createTestStack();
  leadId = (await makeBot(stack.core, 'Lead')).id;
  memberId = (await makeBot(stack.core, 'Member')).id;
  projectId = (await makeProject(stack.core, 'Card chats', [leadId, memberId])).id;
  const columnId = board().get(projectId, ['Todo'], 'user').columns[0]!.id;
  todoId = board().createCard(projectId, columnId, 'Ship the notes', undefined, 'user').id;
}, 60_000);

afterAll(() => stack.cleanup());

function board(): BoardService {
  return stack.core.services.board!;
}

function conversations(): ConversationsService {
  return stack.core.services.domain!.conversations;
}

function openCount(cardTodoId: string): number {
  const row = stack.core.services.mainDb!.prepare(
    "select count(*) as n from conversations where type = 'card' and card_todo_id = ? and read_only = 0",
  ).get(cardTodoId) as { n: number };
  return row.n;
}

async function shareTargets(): Promise<ShareTargets> {
  const spec = stack.core.services.platformMethods['share.targets'];
  if (!spec) throw new Error('share.targets is not registered');
  return spec.handle(undefined) as Promise<ShareTargets>;
}

describe('ensureCardConversation', () => {
  it('creates a card chat, reuses it for the same bot, and closes the other', () => {
    const events: Conversation[] = [];
    const stop = stack.core.onEvent('conversation.updated', (payload) => {
      events.push(payload.conversation);
    });
    const created = conversations().ensureCardConversation({
      projectId,
      todoId,
      botId: leadId,
      title: 'Ship the notes',
    });
    expect(created.created).toBe(true);
    expect(created.conversation).toMatchObject({
      type: 'card',
      directBotId: leadId,
      parentProjectId: projectId,
      cardTodoId: todoId,
      title: 'Ship the notes',
      readOnly: false,
    });
    expect(events.map((conversation) => conversation.id)).toContain(created.conversation.id);
    const member = stack.core.services.mainDb!.prepare(
      'select bot_id from conversation_members where conversation_id = ?',
    ).get(created.conversation.id) as { bot_id: string };
    expect(member.bot_id).toBe(leadId);

    const again = conversations().ensureCardConversation({
      projectId,
      todoId,
      botId: leadId,
      title: 'Ship the notes',
    });
    expect(again.created).toBe(false);
    expect(again.conversation.id).toBe(created.conversation.id);
    expect(again.updated).toEqual([]);

    const replaced = conversations().ensureCardConversation({
      projectId,
      todoId,
      botId: memberId,
      title: 'Ship the notes',
    });
    expect(replaced.created).toBe(true);
    expect(replaced.conversation.directBotId).toBe(memberId);
    expect(conversations().get(created.conversation.id)?.readOnly).toBe(true);
    expect(conversations().openCardConversation(todoId)?.id).toBe(replaced.conversation.id);
    expect(conversations().readOnlyCardConversationsOf({ todoId }).map((row) => row.id)).toEqual([
      created.conversation.id,
    ]);
    expect(openCount(todoId)).toBe(1);

    const reopened = conversations().ensureCardConversation({
      projectId,
      todoId,
      botId: leadId,
      title: 'Renamed notes',
    });
    expect(reopened.created).toBe(false);
    expect(reopened.conversation.id).toBe(created.conversation.id);
    expect(reopened.conversation.readOnly).toBe(false);
    expect(reopened.conversation.title).toBe('Renamed notes');
    expect(conversations().get(replaced.conversation.id)?.readOnly).toBe(true);
    expect(openCount(todoId)).toBe(1);

    const titled = conversations().setCardTitle(todoId, 'Latest title');
    expect(titled.map((row) => row.id).sort()).toEqual(
      [created.conversation.id, replaced.conversation.id].sort(),
    );
    expect(
      conversations()
        .cardConversations({ todoId })
        .every((row) => row.title === 'Latest title'),
    ).toBe(true);
    stop();
  });

  it('rejects a second open row for the same card', () => {
    const open = conversations().openCardConversation(todoId);
    expect(open).not.toBeNull();
    expect(() => {
      stack.core.services.mainDb!.prepare(
        `insert into conversations
           (id, type, title, direct_bot_id, parent_project_id, card_todo_id, created_at)
         values ('conv_second_open', 'card', 'x', ?, ?, ?, 1)`,
      ).run(memberId, projectId, todoId);
    }).toThrow(/UNIQUE constraint failed/i);
    expect(openCount(todoId)).toBe(1);
  });

  it('keeps a single open row when ensure is called back to back for two bots', () => {
    for (let i = 0; i < 6; i += 1) {
      conversations().ensureCardConversation({
        projectId,
        todoId,
        botId: i % 2 === 0 ? leadId : memberId,
        title: `pass ${i}`,
      });
      expect(openCount(todoId)).toBe(1);
    }
  });
});

describe('cardContext', () => {
  it('reads the current card text and status for the prompt', () => {
    const context = board().cardContext(conversations().openCardConversation(todoId)!.id);
    expect(context).toMatchObject({
      projectName: 'Card chats',
      text: 'Ship the notes',
      statusLabel: '未指派',
      columnName: 'Todo',
      scheduleWhen: null,
    });
    board().updateCard(todoId, 'Ship the revised notes', 'user');
    expect(board().cardContext(conversations().openCardConversation(todoId)!.id)?.text).toBe(
      'Ship the revised notes',
    );
  });
});

describe('card chats stay out of the roster', () => {
  it('list, listVisible, conversations.all, direct queries, and share targets exclude card', async () => {
    const cardId = conversations().openCardConversation(todoId)!.id;
    expect(conversations().list().some((row) => row.type === 'card' || row.id === cardId)).toBe(
      false,
    );
    expect(conversations().listVisible().some((row) => row.id === cardId)).toBe(false);
    const all = await stack.core.rpc.call('conversations.all');
    const roster = (all as { conversations: Array<{ id: string; type: string }> }).conversations;
    expect(roster.some((row) => row.id === cardId || row.type === 'card')).toBe(false);
    const listed = await stack.core.rpc.call('conversations.list');
    const visible = (listed as { conversations: Array<{ id: string }> }).conversations;
    expect(visible.some((row) => row.id === cardId)).toBe(false);

    expect(conversations().listDirectByBot(leadId).some((row) => row.id === cardId)).toBe(false);
    expect(conversations().listDirectByBot(memberId).some((row) => row.id === cardId)).toBe(false);
    expect(conversations().openDirect(leadId).conversation.type).toBe('direct');
    expect(conversations().openDirect(leadId).conversation.id).not.toBe(cardId);

    const targets = await shareTargets();
    expect(targets.projects.some((project) => project.id === cardId)).toBe(false);
    expect(targets.bots.some((bot) => bot.id === cardId)).toBe(false);

    // Handover adapters and the address-book archive query select type = 'direct'
    // or type = 'project'. A card row matches neither.
    const card = conversations().get(cardId)!;
    expect(card.type === 'direct' && card.directBotId === leadId).toBe(false);
    expect(card.type === 'project').toBe(false);

    const kind = (await stack.core.services.platformMethods['conversations.kind']!.handle({
      id: cardId,
    })) as { type: string | null };
    expect(kind.type).toBe('card');
  });

  it('does not count an open card chat in the bot deletion preview', () => {
    conversations().ensureCardConversation({
      projectId,
      todoId,
      botId: leadId,
      title: 'Ship the notes',
    });
    conversations().openDirect(leadId);
    const openCards = conversations()
      .cardConversations({ botId: leadId })
      .filter((row) => !row.readOnly);
    expect(openCards.length).toBeGreaterThan(0);
    const directOpen = conversations()
      .listDirectByBot(leadId)
      .filter((row) => !row.readOnly).length;
    expect(stack.core.services.domain!.lifecycle.deletionPreview(leadId).conversations).toBe(
      directOpen,
    );
  });
});
