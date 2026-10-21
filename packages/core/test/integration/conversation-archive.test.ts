import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation } from '@kepcup/shared';
import { createTestStack, makeBot, type TestStack } from '@kepcup/testkit';

/**
 * 会话归档的 RPC 口径：从对话列表移除（归档）→ 数据全留、通讯录名册仍在 →
 * 恢复后回到列表；界面打开已归档的直聊 = 恢复它（历史延续，不新开对话）。
 */

let stack: TestStack;
let botA: string;
let botB: string;

beforeAll(async () => {
  stack = await createTestStack();
  botA = (await makeBot(stack.core, '阿甲')).id;
  botB = (await makeBot(stack.core, '阿乙')).id;
});

afterAll(async () => {
  await stack.cleanup();
});

describe('会话归档（RPC）', () => {
  it('归档项目组：列表里没有、名册里有，数据保留，恢复后回到列表', async () => {
    const created = (await stack.core.rpc.call('projects.create', {
      title: '归档项目',
      leadBotId: botA,
      memberBotIds: [botA, botB],
    })) as { conversation: Conversation };
    const projectId = created.conversation.id;

    const archived = (await stack.core.rpc.call('conversations.archive', {
      id: projectId,
    })) as { conversation: Conversation };
    expect(archived.conversation.archivedAt).not.toBeNull();

    const list = (await stack.core.rpc.call('conversations.list')) as {
      conversations: Conversation[];
    };
    expect(list.conversations.map((c) => c.id)).not.toContain(projectId);

    // 通讯录名册（含归档）：项目组条目仍在，成员也还在。
    const roster = (await stack.core.rpc.call('conversations.all')) as {
      conversations: Conversation[];
    };
    const entry = roster.conversations.find((c) => c.id === projectId);
    expect(entry).toBeDefined();
    expect(entry?.archivedAt).not.toBeNull();
    expect(entry?.memberPreviews?.length).toBe(2);
    const members = (await stack.core.rpc.call('conversations.members', {
      conversationId: projectId,
    })) as { members: unknown[] };
    expect(members.members.length).toBe(2);

    const restored = (await stack.core.rpc.call('conversations.unarchive', {
      id: projectId,
    })) as { conversation: Conversation };
    expect(restored.conversation.archivedAt ?? null).toBeNull();
    const listAfter = (await stack.core.rpc.call('conversations.list')) as {
      conversations: Conversation[];
    };
    expect(listAfter.conversations.map((c) => c.id)).toContain(projectId);
  }, 60_000);

  it('界面打开已归档的直聊 = 恢复它：同一个对话，历史延续', async () => {
    const opened = (await stack.core.rpc.call('conversations.openDirect', {
      botId: botA,
    })) as { conversation: Conversation };
    const conversationId = opened.conversation.id;

    await stack.core.rpc.call('conversations.archive', { id: conversationId });

    const reopened = (await stack.core.rpc.call('conversations.openDirect', {
      botId: botA,
    })) as { conversation: Conversation };
    expect(reopened.conversation.id).toBe(conversationId);
    expect(reopened.conversation.archivedAt ?? null).toBeNull();

    const list = (await stack.core.rpc.call('conversations.list')) as {
      conversations: Conversation[];
    };
    expect(list.conversations.map((c) => c.id)).toContain(conversationId);
  }, 60_000);
});
