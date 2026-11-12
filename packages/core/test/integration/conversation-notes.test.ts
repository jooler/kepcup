import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONVERSATION_NOTE_TEXT_MAX_CHARS } from '@kepcup/shared';
import { createTestStack, makeBot, openDirect } from '@kepcup/testkit';

/**
 * 对话便签（右栏 Bot 详情「便签」tab，main.db conversation_notes）：create /
 * list / update / delete 走 RPC；删除对话时随 conversations 行 FK 级联删除。
 * 便签是纯用户数据，没有任何 Bot 工具 / 上下文入口。
 */

let stack: Awaited<ReturnType<typeof createTestStack>>;
let convA: Awaited<ReturnType<typeof openDirect>>;
let convB: Awaited<ReturnType<typeof openDirect>>;

beforeAll(async () => {
  stack = await createTestStack();
  const botA = await makeBot(stack.core, '便签甲');
  const botB = await makeBot(stack.core, '便签乙');
  convA = await openDirect(stack.core, botA.id);
  convB = await openDirect(stack.core, botB.id);
});

afterAll(async () => {
  await stack.cleanup();
});

async function listNotes(
  conversationId: string,
): Promise<Array<{ id: string; conversationId: string; text: string; updatedAt: number }>> {
  const result = (await stack.core.rpc.call('notes.list', { conversationId })) as {
    notes: Array<{ id: string; conversationId: string; text: string; updatedAt: number }>;
  };
  return result.notes;
}

describe('conversation notes rpc', () => {
  it('create → list 回读；未知对话被拒', async () => {
    await expect(
      stack.core.rpc.call('notes.create', {
        conversationId: 'conv_missing',
        text: '孤儿便签',
      }),
    ).rejects.toThrow();

    const created = (await stack.core.rpc.call('notes.create', {
      conversationId: convA.id,
      text: 'npm run dev',
    })) as { note: { id: string; text: string } };
    expect(created.note.text).toBe('npm run dev');
    expect(created.note.id.startsWith('note_')).toBe(true);

    const rows = await listNotes(convA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversationId).toBe(convA.id);
    expect(rows[0]!.text).toBe('npm run dev');
  });

  it('渲染层可预先给出 id（乐观上屏）', async () => {
    const id = 'note_01TESTID0000000000000000';
    const created = (await stack.core.rpc.call('notes.create', {
      id,
      conversationId: convA.id,
      text: '账号：tester / secret',
    })) as { note: { id: string } };
    expect(created.note.id).toBe(id);
  });

  it('update 改正文；空白内容被拒', async () => {
    const created = (await stack.core.rpc.call('notes.create', {
      conversationId: convA.id,
      text: '旧正文',
    })) as { note: { id: string } };

    await expect(
      stack.core.rpc.call('notes.update', { id: created.note.id, text: '   ' }),
    ).rejects.toThrow();

    const updated = (await stack.core.rpc.call('notes.update', {
      id: created.note.id,
      text: '新正文\n第二行',
    })) as { note: { text: string; updatedAt: number } };
    expect(updated.note.text).toBe('新正文\n第二行');
    const rows = await listNotes(convA.id);
    expect(rows.find((row) => row.id === created.note.id)?.text).toBe('新正文\n第二行');
  });

  it('正文长度上限由契约校验（20000 收、20001 拒）', async () => {
    const max = CONVERSATION_NOTE_TEXT_MAX_CHARS;
    const created = (await stack.core.rpc.call('notes.create', {
      conversationId: convA.id,
      text: 'x'.repeat(max),
    })) as { note: { id: string; text: string } };
    expect(created.note.text).toHaveLength(max);

    await expect(
      stack.core.rpc.call('notes.create', {
        conversationId: convA.id,
        text: 'x'.repeat(max + 1),
      }),
    ).rejects.toThrow();
    await expect(
      stack.core.rpc.call('notes.update', { id: created.note.id, text: 'x'.repeat(max + 1) }),
    ).rejects.toThrow();
  });

  it('update 未知 id 报 NOT_FOUND；delete 幂等', async () => {
    await expect(
      stack.core.rpc.call('notes.update', { id: 'note_missing', text: '正文' }),
    ).rejects.toThrow(/不存在/);
    await expect(stack.core.rpc.call('notes.delete', { id: 'note_missing' })).resolves.toEqual({
      ok: true,
    });
  });

  it('delete 移除单条', async () => {
    const created = (await stack.core.rpc.call('notes.create', {
      conversationId: convA.id,
      text: '待删除',
    })) as { note: { id: string } };
    await stack.core.rpc.call('notes.delete', { id: created.note.id });
    const rows = await listNotes(convA.id);
    expect(rows.some((row) => row.id === created.note.id)).toBe(false);
  });

  it('删除对话：该对话的便签随 FK 级联删除，其他对话不受影响', async () => {
    await stack.core.rpc.call('notes.create', {
      conversationId: convB.id,
      text: '乙对话的便签',
    });
    await stack.core.rpc.call('conversations.delete', { id: convA.id });

    expect(await listNotes(convA.id)).toHaveLength(0);
    const rows = await listNotes(convB.id);
    expect(rows.map((note) => note.text)).toEqual(['乙对话的便签']);
  });
});
