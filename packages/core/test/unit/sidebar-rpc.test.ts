import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SidebarLayout } from '@kepcup/shared';
import { createTestStack, makeBot, type TestStack } from '@kepcup/testkit';

/**
 * 左栏分组 RPC（`sidebar.*`）：方法已绑定、写入返回完整投影，并且真的落到
 * main.db（重读 `sidebar.get` 结果一致）。表结构与顺序语义由
 * sidebar-service.test.ts 覆盖，这里验到绑定层。
 */

let stack: TestStack;
let conversationId: string;

beforeAll(async () => {
  stack = await createTestStack();
  const bot = await makeBot(stack.core, '分组测试 Bot');
  const opened = (await call('conversations.openDirect', { botId: bot.id })) as {
    conversation: { id: string };
  };
  conversationId = opened.conversation.id;
}, 60_000);

afterAll(() => stack.cleanup());

async function call<T>(method: string, input: unknown): Promise<T> {
  return (await stack.core.rpc.call(method, input)) as T;
}

async function layout(): Promise<SidebarLayout> {
  return (await call<{ layout: SidebarLayout }>('sidebar.get', {})).layout;
}

describe('sidebar RPC', () => {
  it('binds every sidebar method', () => {
    const methods = stack.core.services.appMethods;
    for (const name of [
      'sidebar.get',
      'sidebar.sections.create',
      'sidebar.sections.rename',
      'sidebar.sections.delete',
      'sidebar.sections.move',
      'sidebar.sections.collapse',
      'sidebar.assign',
      'sidebar.unassign',
      'sidebar.pin',
      'sidebar.import',
    ]) {
      expect(methods[name]).toBeDefined();
    }
  });

  it('建组 + 归类 + 重命名 + 折叠 + 置顶都落库', async () => {
    const created = await call<{ layout: SidebarLayout; sectionId: string }>(
      'sidebar.sections.create',
      { id: 'ssc_rpc', name: '工作', conversationId },
    );
    expect(created.sectionId).toBe('ssc_rpc');
    expect(created.layout.assignments).toEqual({ [conversationId]: 'ssc_rpc' });
    expect(await layout()).toEqual(created.layout);

    const renamed = await call<{ layout: SidebarLayout }>('sidebar.sections.rename', {
      id: 'ssc_rpc',
      name: '项目',
    });
    expect(renamed.layout.sections).toEqual([{ id: 'ssc_rpc', name: '项目' }]);

    const collapsed = await call<{ layout: SidebarLayout }>('sidebar.sections.collapse', {
      id: 'ssc_rpc',
      collapsed: true,
    });
    expect(collapsed.layout.collapsed).toEqual({ ssc_rpc: true });

    // 用户重新移入会展开目标
    const reassigned = await call<{ layout: SidebarLayout }>('sidebar.assign', {
      conversationId,
      sectionId: 'ssc_rpc',
    });
    expect(reassigned.layout.collapsed).toEqual({});

    const pinned = await call<{ layout: SidebarLayout }>('sidebar.pin', {
      conversationId,
      pinned: true,
    });
    expect(pinned.layout.pinned).toEqual({ [conversationId]: true });
    expect((await layout()).pinned).toEqual({ [conversationId]: true });
  });

  it('后台清理移回未指定但不展开；删组后会话回到未指定', async () => {
    // 先把「未指定」折叠起来，确认 unassign 不会展开它
    await call('sidebar.sections.collapse', { id: 'unassigned', collapsed: true });
    const cleaned = await call<{ layout: SidebarLayout }>('sidebar.unassign', {
      conversationId,
    });
    expect(cleaned.layout.assignments).toEqual({});
    expect(cleaned.layout.collapsed).toEqual({ unassigned: true });

    await call('sidebar.assign', { conversationId, sectionId: 'ssc_rpc' });
    const removed = await call<{ layout: SidebarLayout }>('sidebar.sections.delete', {
      id: 'ssc_rpc',
    });
    expect(removed.layout.sections).toEqual([]);
    expect(removed.layout.assignments).toEqual({});
    expect(removed.layout.collapsed).toEqual({});
  });

  it('未知分组 / 会话 → INVALID_INPUT / NOT_FOUND', async () => {
    await expect(
      call('sidebar.sections.rename', { id: 'missing', name: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call('sidebar.sections.rename', { id: 'unassigned', name: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      call('sidebar.assign', { conversationId, sectionId: 'missing' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      call('sidebar.pin', { conversationId: 'conv_missing', pinned: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
