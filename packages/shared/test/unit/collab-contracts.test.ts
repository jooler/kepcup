import { describe, expect, it } from 'vitest';
import {
  APP_RPC_METHODS,
  COLLAB_PRESENCE_TTL_MS,
  approvalDecisionSchema,
  approvalsDecideInputSchema,
  collabColorForClient,
  collabDraftClaimInputSchema,
  collabDraftUpdateInputSchema,
  collabPresenceChangedPayloadSchema,
  collabPresenceEntrySchema,
  collabPresenceUpdateInputSchema,
  messagesSendInputSchema,
  rpcEventSchemas,
  rpcMethodSchemas,
  textContentSchema,
} from '../../src/index.js';

/** D119 多客户端在线状态：schema round-trip、方法 / 事件目录、颜色派生。 */

function entry(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'client-1',
    clientName: '小明的 MacBook',
    color: '#0284c7',
    connectionId: 'conn-1',
    conversationId: 'conv-1',
    state: 'typing' as const,
    selection: null,
    updatedAt: 1,
    ...overrides,
  };
}

describe('collab presence contracts', () => {
  it('presence entry round-trips; bad state / color / sizes rejected', () => {
    expect(collabPresenceEntrySchema.parse(entry())).toMatchObject({
      clientId: 'client-1',
      state: 'typing',
    });
    expect(collabPresenceEntrySchema.safeParse(entry({ state: 'editing' })).success).toBe(false);
    expect(collabPresenceEntrySchema.safeParse(entry({ color: 'red' })).success).toBe(false);
    expect(collabPresenceEntrySchema.safeParse(entry({ clientId: '' })).success).toBe(false);
    expect(collabPresenceEntrySchema.safeParse(entry({ clientName: 'x'.repeat(81) })).success).toBe(
      false,
    );
    expect(
      collabPresenceEntrySchema.safeParse(entry({ conversationId: null, selection: null })).success,
    ).toBe(true);
    expect(
      collabPresenceEntrySchema.safeParse(
        entry({ selection: { anchor: 1, head: 3, docVersion: 2 } }),
      ).success,
    ).toBe(true);
  });

  it('update input accepts an away client outside any conversation', () => {
    const parsed = collabPresenceUpdateInputSchema.parse({
      clientId: 'client-1',
      clientName: 'iPhone',
      connectionId: 'conn-1',
      conversationId: null,
      state: 'away',
    });
    expect(parsed).toMatchObject({ conversationId: null, state: 'away' });
    expect(
      collabPresenceUpdateInputSchema.safeParse({
        clientId: 'client-1',
        clientName: 'iPhone',
        connectionId: 'conn-1',
        conversationId: '',
      }).success,
    ).toBe(false);
  });

  it('presence methods are registered for every app endpoint', () => {
    for (const name of [
      'collab.presence.update',
      'collab.presence.leave',
      'collab.presence.list',
    ] as const) {
      expect(rpcMethodSchemas[name]).toBeDefined();
      expect(APP_RPC_METHODS).toContain(name);
    }
  });

  it('presence change event is registered with the full-entry payload', () => {
    const payload = collabPresenceChangedPayloadSchema.parse({
      conversationId: 'conv-1',
      entries: [entry()],
    });
    expect(payload.entries).toHaveLength(1);
    expect(rpcEventSchemas['collab.presenceChanged']).toBeDefined();
  });

  it('draft methods and events are registered', () => {
    for (const name of [
      'collab.draft.get',
      'collab.draft.claim',
      'collab.draft.update',
      'collab.draft.release',
      'collab.draft.send',
    ] as const) {
      expect(rpcMethodSchemas[name]).toBeDefined();
      expect(APP_RPC_METHODS).toContain(name);
    }
    for (const name of [
      'collab.draftChanged',
      'collab.draftOwnerChanged',
      'collab.draftCleared',
    ] as const) {
      expect(rpcEventSchemas[name]).toBeDefined();
    }
  });

  it('draft update accepts a rich document and rejects oversized fields', () => {
    const parsed = collabDraftUpdateInputSchema.parse({
      conversationId: 'conv-1',
      clientId: 'client-1',
      baseVersion: 0,
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
      },
      attachments: [{ attachmentId: 'att-1', fileName: 'a.png', mime: 'image/png', size: 12 }],
    });
    expect(parsed.doc.type).toBe('doc');
    expect(
      collabDraftUpdateInputSchema.safeParse({
        conversationId: '',
        clientId: 'client-1',
        baseVersion: 0,
        doc: { type: 'paragraph' },
      }).success,
    ).toBe(false);
    expect(
      collabDraftClaimInputSchema.safeParse({
        conversationId: 'conv-1',
        clientId: 'client-1',
        clientName: 'x'.repeat(81),
      }).success,
    ).toBe(false);
  });

  it('client colors are deterministic and in the palette', () => {
    const palette = new Set([
      '#e11d48',
      '#d97706',
      '#65a30d',
      '#0d9488',
      '#0284c7',
      '#7c3aed',
      '#c026d3',
      '#475569',
    ]);
    for (const id of ['client-1', 'device-abc', '另一个客户端', 'x']) {
      const color = collabColorForClient(id);
      expect(color).toBe(collabColorForClient(id));
      expect(palette.has(color)).toBe(true);
    }
  });

  it('presence TTL is longer than the browser timer-throttling floor', () => {
    expect(COLLAB_PRESENCE_TTL_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('message and approval attribution fields round-trip (D121)', () => {
    const client = { id: 'client-1', name: '小明的 MacBook' };
    expect(
      messagesSendInputSchema.parse({ conversationId: 'c', text: 'hi', client }).client,
    ).toEqual(client);
    expect(
      approvalsDecideInputSchema.parse({ id: 'approval-1', approve: true, client }).client,
    ).toEqual(client);
    expect(approvalDecisionSchema.parse({ decidedBy: client }).decidedBy).toEqual(client);
    expect(textContentSchema.parse({ text: 'hi', client }).client).toEqual(client);
    expect(rpcEventSchemas['approval.resolved']).toBeDefined();
  });
});
