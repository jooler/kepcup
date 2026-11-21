import { afterEach, describe, expect, it } from 'vitest';
import type { CollabDraft, CollabDraftChangedPayload } from '@kepcup/shared';
import { AppError } from '@kepcup/shared';
import { withCaller, type CoreHarness } from '@kepcup/core';
import { createTestStack, makeBot, type TestStack } from '@kepcup/testkit';

/**
 * Principalized composer drafts (62.11 C5): the binding layer keys every draft
 * operation by the caller principal, so two principals in the same conversation
 * keep independent drafts and leases, and a send clears only the sender's
 * bucket. Dormancy: without a caller the key is the single-user '' bucket and
 * the pre-existing lease semantics hold.
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

function doc(text: string): unknown {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function draftText(draft: CollabDraft): string {
  const first = (draft.doc as { content?: Array<{ content?: Array<{ text?: string }> }> }).content?.[0]
    ?.content?.[0]?.text;
  return first ?? '';
}

interface DraftView {
  draft: CollabDraft;
  lease: { ownerClientId: string } | null;
}

async function draftOf(
  core: CoreHarness,
  conversationId: string,
  principalId?: string,
): Promise<DraftView> {
  return (await callAs(core, 'collab.draft.get', { conversationId }, principalId)) as DraftView;
}

describe('collab draft bindings with a caller principal', () => {
  it('keeps two principals in one conversation independent', async () => {
    const { core } = await start();
    const dm = core.services.domain!.conversations.openDm(['mbr_A', 'mbr_B']).conversation;

    // Each principal holds their own lease in the same conversation.
    const claimA = (await callAs(
      core,
      'collab.draft.claim',
      { conversationId: dm.id, clientId: 'client-a', clientName: 'A' },
      'mbr_A',
    )) as DraftView;
    expect(claimA.lease?.ownerClientId).toBe('client-a');
    const claimB = (await callAs(
      core,
      'collab.draft.claim',
      { conversationId: dm.id, clientId: 'client-b', clientName: 'B' },
      'mbr_B',
    )) as DraftView;
    expect(claimB.lease?.ownerClientId).toBe('client-b');

    // Updates land in separate buckets (both from version 0).
    const updateA = (await callAs(
      core,
      'collab.draft.update',
      { conversationId: dm.id, clientId: 'client-a', baseVersion: 0, doc: doc('A 的草稿') },
      'mbr_A',
    )) as { version: number };
    expect(updateA.version).toBe(1);
    const updateB = (await callAs(
      core,
      'collab.draft.update',
      { conversationId: dm.id, clientId: 'client-b', baseVersion: 0, doc: doc('B 的草稿') },
      'mbr_B',
    )) as { version: number };
    expect(updateB.version).toBe(1);

    const viewA = await draftOf(core, dm.id, 'mbr_A');
    expect(draftText(viewA.draft)).toBe('A 的草稿');
    const viewB = await draftOf(core, dm.id, 'mbr_B');
    expect(draftText(viewB.draft)).toBe('B 的草稿');
  });

  it('does not let one principal steal another principal lease (and keeps in-bucket busy)', async () => {
    const { core } = await start();
    const dm = core.services.domain!.conversations.openDm(['mbr_A', 'mbr_B']).conversation;

    await callAs(
      core,
      'collab.draft.claim',
      { conversationId: dm.id, clientId: 'client-a', clientName: 'A' },
      'mbr_A',
    );

    // A second client inside A's bucket still collides with the lease.
    await expect(
      callAs(
        core,
        'collab.draft.claim',
        { conversationId: dm.id, clientId: 'client-a2', clientName: 'A' },
        'mbr_A',
      ),
    ).rejects.toMatchObject({ code: 'DRAFT_BUSY' });

    // B's bucket is unaffected: claiming succeeds despite A holding a lease.
    const claimB = (await callAs(
      core,
      'collab.draft.claim',
      { conversationId: dm.id, clientId: 'client-b', clientName: 'B' },
      'mbr_B',
    )) as DraftView;
    expect(claimB.lease?.ownerClientId).toBe('client-b');
  });

  it('clears only the sending principal bucket on draft send', async () => {
    const { core } = await start();
    const dm = core.services.domain!.conversations.openDm(['mbr_A', 'mbr_B']).conversation;

    await callAs(
      core,
      'collab.draft.claim',
      { conversationId: dm.id, clientId: 'client-a', clientName: 'A' },
      'mbr_A',
    );
    await callAs(
      core,
      'collab.draft.claim',
      { conversationId: dm.id, clientId: 'client-b', clientName: 'B' },
      'mbr_B',
    );
    await callAs(
      core,
      'collab.draft.update',
      { conversationId: dm.id, clientId: 'client-a', baseVersion: 0, doc: doc('A 要说的话') },
      'mbr_A',
    );
    const updateB = (await callAs(
      core,
      'collab.draft.update',
      { conversationId: dm.id, clientId: 'client-b', baseVersion: 0, doc: doc('B 要说的话') },
      'mbr_B',
    )) as { version: number };

    // A sends: the message goes out and only A's draft disappears.
    const sent = (await callAs(
      core,
      'collab.draft.send',
      { conversationId: dm.id, clientId: 'client-a', baseVersion: 1, text: 'A 要说的话' },
      'mbr_A',
    )) as { message: { senderPrincipalId?: string | null } };
    expect(sent.message.senderPrincipalId ?? null).toBe('mbr_A');

    const viewA = await draftOf(core, dm.id, 'mbr_A');
    expect(draftText(viewA.draft)).toBe('');
    expect(viewA.draft.version).toBe(0);
    expect(viewA.lease).toBeNull();

    const viewB = await draftOf(core, dm.id, 'mbr_B');
    expect(draftText(viewB.draft)).toBe('B 要说的话');
    expect(viewB.draft.version).toBe(updateB.version);
    expect(viewB.lease?.ownerClientId).toBe('client-b');
  });

  it('carries the principalKey on draft events', async () => {
    const { core } = await start();
    const dm = core.services.domain!.conversations.openDm(['mbr_A', 'mbr_B']).conversation;

    const changed: CollabDraftChangedPayload[] = [];
    const unsubscribe = core.onEvent('collab.draftChanged', (payload) => {
      changed.push(payload as CollabDraftChangedPayload);
    });

    await callAs(
      core,
      'collab.draft.claim',
      { conversationId: dm.id, clientId: 'client-a', clientName: 'A' },
      'mbr_A',
    );
    await callAs(
      core,
      'collab.draft.update',
      { conversationId: dm.id, clientId: 'client-a', baseVersion: 0, doc: doc('事件载荷') },
      'mbr_A',
    );
    core.services.collabDrafts!.flushNow();
    unsubscribe();

    expect(changed.length).toBeGreaterThan(0);
    for (const payload of changed) {
      expect(payload.conversationId).toBe(dm.id);
      expect((payload as { principalKey?: string }).principalKey).toBe('mbr_A');
    }
  });

  it('keeps single-user draft behaviour when no caller is present', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小艾');
    const direct = (await callAs(core, 'conversations.openDirect', {
      botId: bot.id,
    })) as { conversation: { id: string } };
    const conversationId = direct.conversation.id;

    // First claim holds the lease; a different client in the same ('') bucket
    // is busy, exactly as before principalization.
    const claim = (await callAs(core, 'collab.draft.claim', {
      conversationId,
      clientId: 'client-1',
      clientName: '本机',
    })) as DraftView;
    expect(claim.lease?.ownerClientId).toBe('client-1');
    await expect(
      callAs(core, 'collab.draft.claim', { conversationId, clientId: 'client-2', clientName: '另一端' }),
    ).rejects.toMatchObject({ code: 'DRAFT_BUSY' });

    await callAs(core, 'collab.draft.update', {
      conversationId,
      clientId: 'client-1',
      baseVersion: 0,
      doc: doc('单用户草稿'),
    });
    const before = await draftOf(core, conversationId);
    expect(draftText(before.draft)).toBe('单用户草稿');

    await callAs(core, 'collab.draft.send', {
      conversationId,
      clientId: 'client-1',
      baseVersion: 1,
      text: '单用户草稿',
    });
    const after = await draftOf(core, conversationId);
    expect(draftText(after.draft)).toBe('');
    expect(after.lease).toBeNull();

    // The sent message carries no sending principal (single-user install).
    const sentMessage = (await callAs(core, 'messages.list', { conversationId })) as {
      messages: Array<{ senderPrincipalId?: string | null }>;
    };
    expect(sentMessage.messages.every((m) => (m.senderPrincipalId ?? null) === null)).toBe(true);
  });
});
