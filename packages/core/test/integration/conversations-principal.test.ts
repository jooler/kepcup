import { afterEach, describe, expect, it } from 'vitest';
import type { Conversation } from '@kepcup/shared';
import { AppError } from '@kepcup/shared';
import { withCaller, type CoreHarness } from '@kepcup/core';
import { createTestStack, makeBot, type TestStack } from '@kepcup/testkit';

/**
 * Principalized conversations bindings (62.11 C3 / C5): per-principal direct
 * chats, dm dedup, eligibility-gated reads/writes and per-principal read state
 * (conversation_reads). Dormancy: every test case without a caller repeats the
 * pre-existing single-user behaviour.
 *
 * NOTE: the harness RPC client hops over a MessagePort, which does NOT carry
 * AsyncLocalStorage — so the tests dispatch against `services.appMethods`
 * directly (with the same input/output zod parsing as the RPC server) inside
 * `withCaller`, keeping the caller context intact.
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

describe('conversations bindings with a caller principal', () => {
  it('opens one direct chat per (bot, principal) and each list only sees its own', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小艾');

    const a = await openDirectAs(core, bot.id, 'mbr_A');
    const b = await openDirectAs(core, bot.id, 'mbr_B');
    expect(a.id).not.toBe(b.id);
    expect(a.type).toBe('direct');
    expect(a.ownerPrincipalId).toBe('mbr_A');
    expect(b.ownerPrincipalId).toBe('mbr_B');

    // Re-opening keeps the same row per (bot, principal).
    const aAgain = await openDirectAs(core, bot.id, 'mbr_A');
    expect(aAgain.id).toBe(a.id);

    const listA = ((await callAs(core, 'conversations.list', undefined, 'mbr_A')) as {
      conversations: Conversation[];
    }).conversations;
    const listB = ((await callAs(core, 'conversations.list', undefined, 'mbr_B')) as {
      conversations: Conversation[];
    }).conversations;
    expect(listA.map((c) => c.id)).toEqual([a.id]);
    expect(listB.map((c) => c.id)).toEqual([b.id]);

    // The address book roster behaves the same way (archived included).
    const allA = ((await callAs(core, 'conversations.all', undefined, 'mbr_A')) as {
      conversations: Conversation[];
    }).conversations;
    expect(allA.map((c) => c.id)).toEqual([a.id]);
  });

  it('dedups dm conversations by the unordered principal pair and keeps a self dm single', async () => {
    const { core } = await start();
    const domain = core.services.domain!;
    const openDm = (ids: string[]): Conversation => domain.conversations.openDm(ids).conversation;

    const ab = openDm(['mbr_A', 'mbr_B']);
    const ba = openDm(['mbr_B', 'mbr_A']);
    expect(ba.id).toBe(ab.id);
    expect(ab.type).toBe('dm');

    const self = openDm(['mbr_A', 'mbr_A']);
    expect(self.id).not.toBe(ab.id);
    expect(self.type).toBe('dm');
    const selfAgain = openDm(['mbr_A']);
    expect(selfAgain.id).toBe(self.id);

    // The dm view carries the participant roster for the renderer's member card.
    const view = ((await callAs(core, 'conversations.get', { id: ab.id }, 'mbr_A')) as {
      conversation: Conversation;
    }).conversation;
    expect(view.id).toBe(ab.id);
    expect([...(view.peerPrincipalIds ?? [])].sort()).toEqual(['mbr_A', 'mbr_B']);
  });

  it('listForPrincipal returns owner / participant conversations only', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小阿');
    const domain = core.services.domain!;

    const direct = await openDirectAs(core, bot.id, 'mbr_A');
    const dm = domain.conversations.openDm(['mbr_A', 'mbr_B']).conversation;

    const mine = await domain.conversations.listForPrincipal('mbr_A', { visibleOnly: true });
    expect(mine.map((c) => c.id).sort()).toEqual([direct.id, dm.id].sort());
    const theirs = await domain.conversations.listForPrincipal('mbr_C', { visibleOnly: true });
    expect(theirs.map((c) => c.id)).toEqual([]);
  });

  it('rejects get / archive / members without eligibility with NOT_FOUND', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小艾');
    const a = await openDirectAs(core, bot.id, 'mbr_A');

    // B must not learn that A's conversation exists.
    await expect(callAs(core, 'conversations.get', { id: a.id }, 'mbr_B')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      callAs(core, 'conversations.archive', { id: a.id }, 'mbr_B'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      callAs(core, 'conversations.members', { conversationId: a.id }, 'mbr_B'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      callAs(core, 'conversations.markRead', { conversationId: a.id, seq: 10 }, 'mbr_B'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // A still passes.
    const view = ((await callAs(core, 'conversations.get', { id: a.id }, 'mbr_A')) as {
      conversation: Conversation;
    }).conversation;
    expect(view.id).toBe(a.id);
  });

  it('writes per-principal read state so unread counts do not interfere', async () => {
    const { core } = await start();
    const domain = core.services.domain!;
    const dm = domain.conversations.openDm(['mbr_A', 'mbr_B']).conversation;

    // A speaks into the dm (no bots inside, so no run is routed).
    const sent = (await callAs(core, 'messages.send', { conversationId: dm.id, text: '你好' }, 'mbr_A')) as {
      message: { seq: number };
    };
    expect(sent.message.seq).toBeGreaterThan(0);

    const unreadOf = async (principalId: string): Promise<number> => {
      const view = ((await callAs(core, 'conversations.get', { id: dm.id }, principalId)) as {
        conversation: Conversation;
      }).conversation;
      return view.unreadCount ?? 0;
    };

    expect(await unreadOf('mbr_A')).toBeGreaterThan(0);
    expect(await unreadOf('mbr_B')).toBeGreaterThan(0);

    // A reads up to the message: only A's bucket moves.
    await callAs(core, 'conversations.markRead', { conversationId: dm.id, seq: sent.message.seq }, 'mbr_A');
    expect(await unreadOf('mbr_A')).toBe(0);
    expect(await unreadOf('mbr_B')).toBeGreaterThan(0);

    const reads = core.services.mainDb!
      .prepare('select * from conversation_reads where conversation_id = ?')
      .all(dm.id) as Array<{ principal_id: string; last_read_seq: number }>;
    expect(reads).toEqual([{ conversation_id: dm.id, principal_id: 'mbr_A', last_read_seq: sent.message.seq }]);
  });

  it('keeps single-user behaviour when no caller is present', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小艾');

    // Dormant openDirect: NULL owner, one row per bot.
    const first = (await callAs(core, 'conversations.openDirect', { botId: bot.id })) as {
      conversation: Conversation;
      created: boolean;
    };
    expect(first.created).toBe(true);
    expect(first.conversation.ownerPrincipalId ?? null).toBeNull();
    const second = (await callAs(core, 'conversations.openDirect', { botId: bot.id })) as {
      conversation: Conversation;
      created: boolean;
    };
    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);

    // Dormant list still sees the conversation.
    const list = ((await callAs(core, 'conversations.list')) as { conversations: Conversation[] })
      .conversations;
    expect(list.map((c) => c.id)).toContain(first.conversation.id);

    // Dormant markRead writes the old column, not conversation_reads.
    const conv = first.conversation;
    await callAs(core, 'conversations.markRead', { conversationId: conv.id, seq: conv.lastSeq });
    const row = core.services.mainDb!
      .prepare('select last_read_seq from conversations where id = ?')
      .get(conv.id) as { last_read_seq: number };
    expect(row.last_read_seq).toBe(conv.lastSeq);
    const reads = core.services.mainDb!
      .prepare('select count(*) as n from conversation_reads where conversation_id = ?')
      .get(conv.id) as { n: number };
    expect(reads.n).toBe(0);
  });
});
