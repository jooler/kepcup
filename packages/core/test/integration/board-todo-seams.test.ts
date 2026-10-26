import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, type TodoEntry } from '@kepcup/shared';
import { createTestStack, makeBot, makeProject, type TestStack } from '@kepcup/testkit';
import { buildWorkbenchSection } from '../../src/workbench/context.js';
import { buildWorkbenchTools, type WorkbenchToolFacade } from '../../src/tools/workbench-tools.js';

/**
 * Board cards stay out of the workbench (P1 step 4). The side row is the switch.
 */

let stack: TestStack;
let members: string[];

beforeAll(async () => {
  stack = await createTestStack();
  const lead = await makeBot(stack.core, 'Lead');
  const other = await makeBot(stack.core, 'Member');
  members = [lead.id, other.id];
}, 60_000);

afterAll(() => stack.cleanup());

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof AppError ? String(error.code) : 'OTHER';
  }
}

function facade(): WorkbenchToolFacade {
  const todos = stack.core.services.todos!;
  const memos = stack.core.services.memos!;
  return {
    isButler: () => true,
    listTodos: (filter) => todos.list(filter),
    getTodo: (id) => todos.get(id).todo,
    createTodo: (input) => todos.create(input),
    updateTodo: (id, input) => todos.update(id, input),
    startTodo: (id, actor) => todos.start(id, actor),
    completeTodo: (id) => todos.complete(id),
    cancelTodo: (id) => todos.cancel(id),
    listMemos: (filter) => memos.list(filter),
    createMemo: (input) => memos.create(input),
    updateMemo: (id, patch) => memos.update(id, patch),
    deleteMemo: (id) => memos.delete(id),
    describeWhen: () => 'sometime',
    describeTime: () => 'today',
    contextSection: () =>
      buildWorkbenchSection({
        todos: todos.list({ statuses: ['draft', 'scheduled', 'in_progress', 'delivered'] }),
        memos: memos.list(),
        now: Date.now(),
        timeZone: 'UTC',
      }),
    isTainted: () => false,
    now: () => Date.now(),
  };
}

function tool(name: string) {
  const found = buildWorkbenchTools({
    identity: {
      runId: 'run_seam',
      botId: 'bot_butler',
      conversationId: 'conv_seam',
      loopType: 'turn',
    },
    workbench: facade(),
    triggerFromUser: true,
  }).find((item) => item.name === name);
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found;
}

describe('board todo seams', () => {
  it('hides board cards from todos.list, list_todos, and the workbench section', async () => {
    const project = await makeProject(stack.core, 'seam', members);
    const columnId = stack.core.services.board!.get(project.id, ['Todo'], 'user').columns[0]!.id;
    const card = stack.core.services.board!.createCard(
      project.id,
      columnId,
      'Board only card',
      undefined,
      'user',
    );
    const ordinary = (await stack.core.rpc.call('todos.create', { title: 'Ordinary todo' })) as {
      todo: TodoEntry;
    };

    const listed = (await stack.core.rpc.call('todos.list', {})) as { todos: TodoEntry[] };
    expect(listed.todos.map((todo) => todo.id)).toContain(ordinary.todo.id);
    expect(listed.todos.map((todo) => todo.id)).not.toContain(card.id);
    expect(listed.todos.every((todo) => todo.board === null)).toBe(true);

    const got = stack.core.services.todos!.get(card.id).todo;
    expect(got.board).toEqual({ projectId: project.id, columnId });

    const listedByTool = await tool('list_todos').execute({});
    expect(listedByTool.ok).toBe(true);
    expect(listedByTool.content).toContain(ordinary.todo.id);
    expect(listedByTool.content).not.toContain(card.id);
    expect(listedByTool.content).not.toContain('Board only card');

    const section = facade().contextSection();
    expect(section).toContain('草案 1 条');
    expect(section).not.toContain('Board only card');
    expect(section).not.toContain(card.id);

    const mixed = buildWorkbenchSection({
      todos: [ordinary.todo, { ...got, title: 'Board only card' }],
      memos: [],
      now: Date.now(),
      timeZone: 'UTC',
    });
    expect(mixed).toContain('草案 1 条');
    expect(mixed).not.toContain(card.id);
  });

  it('rejects non-board mutations with BOARD_MANAGED and leaves ordinary todos alone', async () => {
    const project = await makeProject(stack.core, 'guard', members);
    const columnId = stack.core.services.board!.get(project.id, ['Todo'], 'user').columns[0]!.id;
    const card = stack.core.services.board!.createCard(
      project.id,
      columnId,
      'Managed',
      undefined,
      'user',
    );
    const todos = stack.core.services.todos!;

    expect(todos.get(card.id).runs).toEqual([]);
    expect(todos.get(card.id).todo.id).toBe(card.id);
    expect(codeOf(() => todos.update(card.id, { title: 'nope' }))).toBe('BOARD_MANAGED');
    expect(codeOf(() => todos.update(card.id, { title: 'nope', actor: 'butler' }))).toBe(
      'BOARD_MANAGED',
    );
    expect(codeOf(() => todos.complete(card.id))).toBe('BOARD_MANAGED');
    expect(codeOf(() => todos.purge(card.id))).toBe('BOARD_MANAGED');
    expect(codeOf(() => todos.start(card.id))).toBe('BOARD_MANAGED');
    expect(codeOf(() => todos.cancel(card.id))).toBe('BOARD_MANAGED');
    expect(codeOf(() => todos.reopen(card.id))).toBe('BOARD_MANAGED');

    const update = await tool('update_todo').execute({ id: card.id, title: 'nope' });
    expect(update.ok).toBe(false);
    expect(update.errorCode).toBe('BOARD_MANAGED');
    const close = await tool('close_todo').execute({ id: card.id, outcome: 'cancelled' });
    expect(close.ok).toBe(false);
    expect(close.errorCode).toBe('BOARD_MANAGED');

    expect(stack.core.services.board!.get(project.id, undefined, 'user').cards[0]?.text).toBe(
      'Managed',
    );

    const ordinary = todos.create({ title: 'Still editable' }).todo;
    const edited = todos.update(ordinary.id, { title: 'Edited' }).todo;
    expect(edited.title).toBe('Edited');
    expect(edited.board).toBeNull();
    expect(todos.list().map((todo) => todo.id)).toContain(ordinary.id);

    const boardEvents: unknown[] = [];
    const todoEvents: unknown[] = [];
    const stopBoard = stack.core.services.events.on('board.changed', (payload) => {
      boardEvents.push(payload);
    });
    const stopTodos = stack.core.services.events.on('todos.changed', (payload) => {
      todoEvents.push(payload);
    });
    stack.core.services.board!.updateCard(card.id, 'Managed again', 'user');
    expect(todoEvents).toEqual([]);
    expect(boardEvents).toEqual([{ projectId: project.id, cardId: card.id, columnId }]);
    todos.update(ordinary.id, { notes: 'note' });
    expect(todoEvents).toEqual([{ todoId: ordinary.id }]);
    stopBoard();
    stopTodos();

    // Unassigned drafts are reconciled and left in place.
    expect(todos.reconcile()).not.toContain(card.id);
    expect(stack.core.services.board!.get(project.id, undefined, 'user').cards[0]?.id).toBe(
      card.id,
    );
  });
});
