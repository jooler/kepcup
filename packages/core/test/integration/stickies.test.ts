import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, openDirect } from '@kepcup/testkit';

/**
 * 辅助阅读便签（main.db stickies）：create/list/update 走 RPC；删除对话
 * 时随 conversations 行 FK 级联删除（含 global：来源对话是所有者）。
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

async function listStickies(): Promise<
  Array<{ id: string; conversationId: string; scope: string; position: unknown }>
> {
  const result = (await stack.core.rpc.call('stickies.list', {})) as {
    stickies: Array<{ id: string; conversationId: string; scope: string; position: unknown }>;
  };
  return result.stickies;
}

describe('stickies rpc', () => {
  it('create → list 回读；未知对话被拒', async () => {
    await expect(
      stack.core.rpc.call('stickies.create', {
        conversationId: 'conv_missing',
        text: '孤儿便签',
        scope: 'conversation',
        position: null,
        z: 1,
      }),
    ).rejects.toThrow();

    const created = (await stack.core.rpc.call('stickies.create', {
      conversationId: convA.id,
      text: '第一张便签',
      scope: 'conversation',
      position: null,
      z: 1,
    })) as { stickie: { id: string; text: string; position: null } };
    expect(created.stickie.text).toBe('第一张便签');
    expect(created.stickie.id.startsWith('stc_')).toBe(true);
    expect(created.stickie.position).toBeNull();

    const rows = await listStickies();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversationId).toBe(convA.id);
  });

  it('update 位置 / 作用域 / 层号', async () => {
    const created = (await stack.core.rpc.call('stickies.create', {
      conversationId: convA.id,
      text: '第二张便签',
      scope: 'conversation',
      position: null,
      z: 2,
    })) as { stickie: { id: string } };

    const updated = (await stack.core.rpc.call('stickies.update', {
      id: created.stickie.id,
      position: { x: 40, y: 80 },
      scope: 'global',
      z: 9,
    })) as { stickie: { scope: string; position: { x: number; y: number }; z: number } };
    expect(updated.stickie.scope).toBe('global');
    expect(updated.stickie.position).toEqual({ x: 40, y: 80 });
    expect(updated.stickie.z).toBe(9);

    // 局部更新：未携带的字段保持不变。
    const moved = (await stack.core.rpc.call('stickies.update', {
      id: created.stickie.id,
      position: { x: 10, y: 20 },
    })) as { stickie: { scope: string; position: { x: number }; z: number } };
    expect(moved.stickie.position).toEqual({ x: 10, y: 20 });
    expect(moved.stickie.scope).toBe('global');
    expect(moved.stickie.z).toBe(9);
  });

  it('delete 移除单张', async () => {
    const created = (await stack.core.rpc.call('stickies.create', {
      conversationId: convA.id,
      text: '待删除',
      scope: 'conversation',
      position: null,
      z: 3,
    })) as { stickie: { id: string } };
    await stack.core.rpc.call('stickies.delete', { id: created.stickie.id });
    const rows = await listStickies();
    expect(rows.some((s) => s.id === created.stickie.id)).toBe(false);
  });

  it('删除对话：该对话来源的便签（含 global）随 FK 级联删除，其他对话不受影响', async () => {
    await stack.core.rpc.call('stickies.create', {
      conversationId: convB.id,
      text: '乙对话的便签',
      scope: 'conversation',
      position: null,
      z: 4,
    });
    // convA 里钉的 global 便签：来源对话删除时一并清理（来源是所有者）。
    await stack.core.rpc.call('stickies.create', {
      conversationId: convA.id,
      text: '甲对话钉的全局便签',
      scope: 'global',
      position: { x: 12, y: 64 },
      z: 5,
    });

    await stack.core.rpc.call('conversations.delete', { id: convA.id });

    const rows = await listStickies();
    expect(rows.map((s) => s.conversationId)).toEqual([convB.id]);
    const remaining = (await stack.core.rpc.call('stickies.list', {})) as {
      stickies: Array<{ text: string }>;
    };
    expect(remaining.stickies.map((s) => s.text)).toEqual(['乙对话的便签']);
  });
});
