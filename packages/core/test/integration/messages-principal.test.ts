import { afterEach, describe, expect, it } from 'vitest';
import type { Conversation, Message } from '@kepcup/shared';
import { AppError } from '@kepcup/shared';
import { withCaller, type CoreHarness } from '@kepcup/core';
import { createTestStack, listRuns, makeBot, waitFor, type TestStack } from '@kepcup/testkit';

/**
 * Principalized messages bindings (62.11 C4 / C6): sender attribution from the
 * caller context, eligibility checks on send/list, self-only edit / recall and
 * the incremental pull (afterSeq / changedSince / cursor). Dormancy: no-caller
 * cases keep the single-user behaviour.
 *
 * The harness RPC client hops over a MessagePort (no AsyncLocalStorage across
 * it), so tests dispatch against `services.appMethods` inside `withCaller`,
 * mirroring the RPC server's input/output parsing.
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

async function callAs(
  core: CoreHarness,
  method: string,
  input?: Record<string, unknown>,
  principalId?: string,
): Promise<unknown> {
  const spec = core.services.appMethods[method];
  if (spec === undefined) throw new Error(`method not bound: ${method}`);
  // voidInput methods take no input (z.void()); the rest parse like the RPC
  // server does.
  const parsed = input === undefined ? undefined : spec.input.safeParse(input);
  if (parsed !== undefined && !parsed.success) {
    throw new AppError('INVALID_INPUT', `Invalid input for ${method}`);
  }
  const task = async () => spec.output.parse(await spec.handle(parsed?.data));
  return principalId === undefined ? task() : withCaller({ principalId }, task);
}

async function openDirectAs(
  core: CoreHarness,
  botId: string,
  principalId: string,
): Promise<Conversation> {
  const result = (await callAs(core, 'conversations.openDirect', { botId }, principalId)) as {
    conversation: Conversation;
  };
  return result.conversation;
}

async function sendAs(
  core: CoreHarness,
  conversationId: string,
  text: string,
  principalId?: string,
): Promise<Message> {
  const result = (await callAs(core, 'messages.send', { conversationId, text }, principalId)) as {
    message: Message;
  };
  return result.message;
}

/** Content-change time moves in wall-clock ms; keep edits off the create ms. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('messages bindings with a caller principal', () => {
  it('stamps the sending principal on sent messages (name null this phase)', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小艾');
    const conv = await openDirectAs(core, bot.id, 'mbr_A');

    const message = await sendAs(core, conv.id, '第一条', 'mbr_A');
    expect(message.senderPrincipalId).toBe('mbr_A');
    expect(message.senderName ?? null).toBeNull();
    expect(message.senderType).toBe('user');
  });

  it('enforces send eligibility on direct / dm / project conversations', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小阿');
    const domain = core.services.domain!;

    const direct = await openDirectAs(core, bot.id, 'mbr_A');
    await sendAs(core, direct.id, '主人发言', 'mbr_A');
    await expect(sendAs(core, direct.id, '外来者', 'mbr_B')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const dm = domain.conversations.openDm(['mbr_A', 'mbr_B']).conversation;
    await sendAs(core, dm.id, '成员 A', 'mbr_A');
    await sendAs(core, dm.id, '成员 B', 'mbr_B');
    await expect(sendAs(core, dm.id, '外来者', 'mbr_C')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const project = (await callAs(
      core,
      'projects.create',
      {
        title: '发布组',
        leadBotId: bot.id,
        memberBotIds: [bot.id],
        principalIds: ['mbr_A'],
      },
      'mbr_A',
    )) as { conversation: Conversation };
    await sendAs(core, project.conversation.id, '负责人发言', 'mbr_A');
    await expect(
      sendAs(core, project.conversation.id, '外来者', 'mbr_C'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The direct / project sends routed turns asynchronously (the unscripted
    // mock fails them fast). Let the routing settle before afterEach closes
    // the stack, or the route chain races the database close (the unhandled
    // rejection this file used to ship with).
    for (const conversationId of [direct.id, project.conversation.id]) {
      await waitFor(
        async () =>
          (await listRuns(core, conversationId)).find(
            (r) => r.loopType === 'turn' && (r.status === 'completed' || r.status === 'failed'),
          ) ?? null,
        { label: 'turn to settle' },
      );
    }
  });

  it('only the sending principal may edit or recall', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小艾');
    const conv = await openDirectAs(core, bot.id, 'mbr_A');
    const message = await sendAs(core, conv.id, '原文', 'mbr_A');

    await expect(
      callAs(core, 'messages.edit', { id: message.id, text: '冒改' }, 'mbr_B'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(callAs(core, 'messages.recall', { id: message.id }, 'mbr_B')).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );

    const edited = ((await callAs(core, 'messages.edit', { id: message.id, text: '改后' }, 'mbr_A')) as {
      messages: Message[];
    }).messages[0]!;
    expect((edited.content as { text: string }).text).toBe('改后');
    expect(edited.status).toBe('edited');

    const recalled = ((await callAs(core, 'messages.recall', { id: message.id }, 'mbr_A')) as {
      messages: Message[];
    }).messages[0]!;
    expect(recalled.status).toBe('recalled');
  });

  it('pulls messages after a seq in ascending order', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小艾');
    const conv = await openDirectAs(core, bot.id, 'mbr_A');
    const [one, two, three] = [
      await sendAs(core, conv.id, '一', 'mbr_A'),
      await sendAs(core, conv.id, '二', 'mbr_A'),
      await sendAs(core, conv.id, '三', 'mbr_A'),
    ];

    const page = ((await callAs(
      core,
      'messages.list',
      { conversationId: conv.id, afterSeq: one!.seq },
      'mbr_A',
    )) as { messages: Message[] }).messages;
    expect(page.map((m) => m.id)).toEqual([two!.id, three!.id]);
    expect(page.map((m) => m.seq)).toEqual([two!.seq, three!.seq]);
  });

  it('catches up edits and recalls via changedSince with a monotonic cursor', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小艾');
    const conv = await openDirectAs(core, bot.id, 'mbr_A');
    const one = await sendAs(core, conv.id, '第一条', 'mbr_A');
    const two = await sendAs(core, conv.id, '第二条', 'mbr_A');

    const first = (await callAs(
      core,
      'messages.list',
      { conversationId: conv.id, changedSince: 0 },
      'mbr_A',
    )) as { messages: Message[]; cursor?: number };
    expect(first.messages.map((m) => m.id).sort()).toEqual([one.id, two.id].sort());
    const cursorOne = first.cursor;
    expect(cursorOne).toBeTypeOf('number');

    await tick();
    const edited = ((await callAs(core, 'messages.edit', { id: one.id, text: '第一改' }, 'mbr_A')) as {
      messages: Message[];
    }).messages[0]!;

    const second = (await callAs(
      core,
      'messages.list',
      { conversationId: conv.id, changedSince: cursorOne },
      'mbr_A',
    )) as { messages: Message[]; cursor?: number };
    // The edit bumped the row's change time, so it comes back (even though its
    // seq is older than the cursor's sequence neighbourhood).
    expect(second.messages.map((m) => m.id)).toEqual([one.id]);
    expect(second.messages[0]!.status).toBe('edited');
    expect((second.messages[0]!.content as { text: string }).text).toBe('第一改');
    const cursorTwo = second.cursor;
    expect(cursorTwo!).toBeGreaterThanOrEqual(cursorOne!);
    // The change time really moved past the first cursor (trigger-maintained).
    expect((edited.updatedAt ?? edited.createdAt) + 0).toBeGreaterThan(cursorOne!);

    await tick();
    await callAs(core, 'messages.recall', { id: two.id }, 'mbr_A');

    const third = (await callAs(
      core,
      'messages.list',
      { conversationId: conv.id, changedSince: cursorTwo },
      'mbr_A',
    )) as { messages: Message[]; cursor?: number };
    expect(third.messages.map((m) => m.id)).toEqual([two.id]);
    expect(third.messages[0]!.status).toBe('recalled');
    expect(third.cursor!).toBeGreaterThanOrEqual(cursorTwo!);

    const fourth = (await callAs(
      core,
      'messages.list',
      { conversationId: conv.id, changedSince: third.cursor },
      'mbr_A',
    )) as { messages: Message[] };
    expect(fourth.messages).toEqual([]);
  });

  it('passes origin avatar and the avatar bot name into the message content (62.11 步骤 4.6)', async () => {
    const { core } = await start();
    const domain = core.services.domain!;
    // A dm carries no Bot member, so the send routes nowhere (no run to settle).
    const dm = domain.conversations.openDm(['mbr_A', 'mbr_B']).conversation;

    const withAvatar = (await callAs(
      core,
      'messages.send',
      { conversationId: dm.id, text: '分身代回', origin: 'avatar', avatar: { botName: '小影' } },
      'mbr_A',
    )) as { message: Message };
    expect(withAvatar.message.senderPrincipalId).toBe('mbr_A');
    expect((withAvatar.message.content as { origin?: string }).origin).toBe('avatar');
    expect((withAvatar.message.content as { avatar?: { botName: string } }).avatar).toEqual({
      botName: '小影',
    });

    // The bare marker (origin without an avatar object) is valid too.
    const bare = (await callAs(
      core,
      'messages.send',
      { conversationId: dm.id, text: '裸标记', origin: 'avatar' },
      'mbr_A',
    )) as { message: Message };
    expect((bare.message.content as { origin?: string }).origin).toBe('avatar');
    expect((bare.message.content as { avatar?: unknown }).avatar).toBeUndefined();

    // Dormant: without the fields the content keeps the legacy shape.
    const plain = (await callAs(
      core,
      'messages.send',
      { conversationId: dm.id, text: '普通消息' },
      'mbr_A',
    )) as { message: Message };
    expect((plain.message.content as { origin?: string }).origin).toBeUndefined();
    expect((plain.message.content as { avatar?: unknown }).avatar).toBeUndefined();
  });

  it('rejects mutually exclusive pagination params via zod', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小艾');
    const conv = await openDirectAs(core, bot.id, 'mbr_A');
    await expect(
      callAs(core, 'messages.list', { conversationId: conv.id, afterSeq: 1, changedSince: 1 }, 'mbr_A'),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      callAs(core, 'messages.list', { conversationId: conv.id, beforeSeq: 1, afterSeq: 1 }, 'mbr_A'),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps single-user behaviour when no caller is present', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小艾');
    const conv = await openDirectAs(core, bot.id);

    const message = await sendAs(core, conv.id, '单用户消息');
    expect(message.senderPrincipalId ?? null).toBeNull();
    expect(message.senderName ?? null).toBeNull();

    const edited = ((await callAs(core, 'messages.edit', {
      id: message.id,
      text: '单用户改',
    })) as { messages: Message[] }).messages[0]!;
    expect(edited.status).toBe('edited');
    const recalled = ((await callAs(core, 'messages.recall', { id: message.id })) as {
      messages: Message[];
    }).messages[0]!;
    expect(recalled.status).toBe('recalled');

    const page = ((await callAs(core, 'messages.list', {
      conversationId: conv.id,
      afterSeq: 0,
    })) as { messages: Message[] }).messages;
    expect(page.length).toBeGreaterThan(0);
  });
});
