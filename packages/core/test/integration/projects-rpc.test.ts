import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, Conversation } from '@kepcup/shared';
import { createTestStack, listAllMessages, makeBot, type TestStack } from '@kepcup/testkit';

/** projects.* RPC（D92 T1a，todo/project/WP1 步骤 7.5）。 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

async function systemEvents(stack: TestStack, conversationId: string) {
  return (await listAllMessages(stack.core, conversationId)).filter(
    (m) => m.kind === 'system_event' && 'event' in m.content,
  );
}

describe('projects.* RPC', () => {
  it('create returns a project conversation with leadBotId', async () => {
    const stack = await start();
    const core = stack.core;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const { conversation } = (await core.rpc.call('projects.create', {
      title: '发布组',
      goal: '负责发布',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    })) as { conversation: Conversation };
    expect(conversation.type).toBe('project');
    expect(conversation.leadBotId).toBe(a.id);
    expect(conversation.goal).toBe('负责发布');
    // Creation writes no system messages (the D60 ceremony is gone).
    expect(await systemEvents(stack, conversation.id)).toEqual([]);
  });

  it('setLead changes the lead and writes the visible system message', async () => {
    const stack = await start();
    const core = stack.core;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const { conversation } = (await core.rpc.call('projects.create', {
      title: '发布组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    })) as { conversation: Conversation };
    const { conversation: updated } = (await core.rpc.call('projects.setLead', {
      conversationId: conversation.id,
      botId: b.id,
    })) as { conversation: Conversation };
    expect(updated.leadBotId).toBe(b.id);
    const events = (await systemEvents(stack, conversation.id)).map(
      (m) => (m.content as { event: string; text: string }).event,
    );
    expect(events).toEqual(['project_lead_changed']);
  });

  it('update changes title and goal', async () => {
    const stack = await start();
    const core = stack.core;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const { conversation } = (await core.rpc.call('projects.create', {
      title: '发布组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    })) as { conversation: Conversation };
    const renamed = (await core.rpc.call('projects.update', {
      conversationId: conversation.id,
      title: '新版发布组',
    })) as { conversation: Conversation };
    expect(renamed.conversation.title).toBe('新版发布组');
    const reGoaled = (await core.rpc.call('projects.update', {
      conversationId: conversation.id,
      goal: null,
    })) as { conversation: Conversation };
    expect(reGoaled.conversation.goal).toBeUndefined();
    await expect(
      core.rpc.call('projects.update', { conversationId: conversation.id }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('addMembers returns the member list and writes project_member_joined', async () => {
    const stack = await start();
    const core = stack.core;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const c = await makeBot(core, '阿丙');
    const { conversation } = (await core.rpc.call('projects.create', {
      title: '发布组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    })) as { conversation: Conversation };
    const { members } = (await core.rpc.call('projects.addMembers', {
      conversationId: conversation.id,
      botIds: [c.id],
    })) as { members: Array<{ bot: Bot; joinedAt: number }> };
    expect(members.map((m) => m.bot.id).sort()).toEqual([a.id, b.id, c.id].sort());
    const events = (await systemEvents(stack, conversation.id)).map(
      (m) => (m.content as { event: string; text: string }),
    );
    expect(events).toEqual([
      { event: 'project_member_joined', text: '阿丙 已加入项目组' },
    ]);
  });

  it('removeMember refuses the lead and removes a regular member', async () => {
    const stack = await start();
    const core = stack.core;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const { conversation } = (await core.rpc.call('projects.create', {
      title: '发布组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    })) as { conversation: Conversation };
    await expect(
      core.rpc.call('projects.removeMember', { conversationId: conversation.id, botId: a.id }),
    ).rejects.toMatchObject({ code: 'PROJECT_LEAD_REQUIRED' });
    const { ok } = (await core.rpc.call('projects.removeMember', {
      conversationId: conversation.id,
      botId: b.id,
    })) as { ok: boolean };
    expect(ok).toBe(true);
    const { members } = (await core.rpc.call('conversations.members', {
      conversationId: conversation.id,
    })) as { members: Array<{ bot: Bot }> };
    expect(members.map((m) => m.bot.id)).toEqual([a.id]);
  });

  it('conversations.list carries leadBotId and memberPreviews for projects', async () => {
    const stack = await start();
    const core = stack.core;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const { conversation } = (await core.rpc.call('projects.create', {
      title: '发布组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    })) as { conversation: Conversation };
    const listed = (await core.rpc.call('conversations.list')) as {
      conversations: Conversation[];
    };
    const view = listed.conversations.find((c) => c.id === conversation.id);
    expect(view?.leadBotId).toBe(a.id);
    expect(view?.memberPreviews?.map((m) => m.id)).toEqual([a.id, b.id]);
    // A direct chat carries no previews / lead.
    const { conversation: direct } = (await core.rpc.call('conversations.openDirect', {
      botId: a.id,
    })) as { conversation: Conversation };
    const directView = listed.conversations.find((c) => c.id === direct.id);
    expect(directView?.leadBotId ?? null).toBeNull();
    expect(directView?.memberPreviews).toBeUndefined();
  });

  it('bots.deletionPreview lists ledProjects', async () => {
    const stack = await start();
    const core = stack.core;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const { conversation } = (await core.rpc.call('projects.create', {
      title: '发布组',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    })) as { conversation: Conversation };
    const preview = (await core.rpc.call('bots.deletionPreview', { id: a.id })) as {
      ledProjects: Array<{ id: string; title: string | null }>;
    };
    expect(preview.ledProjects).toEqual([{ id: conversation.id, title: '发布组' }]);
    const memberPreview = (await core.rpc.call('bots.deletionPreview', { id: b.id })) as {
      ledProjects: unknown[];
    };
    expect(memberPreview.ledProjects).toEqual([]);
  });
});
