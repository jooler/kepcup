import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Grant } from '@kepcup/shared';

/**
 * Approvals and grants can be loaded for more than one conversation at once.
 * `permissions.grants` stays the foreground (main view) list.
 */

const handlers = new Map<string, (payload: unknown) => void>();
const grantsByConversation: Record<string, Grant[]> = {};

function grant(id: string, conversationId: string): Grant {
  return {
    id,
    botId: 'bot_1',
    conversationId,
    path: '/tmp',
    access: 'read',
    duration: 'conversation',
    runId: null,
    approvalId: null,
    createdAt: 1,
    revokedAt: null,
  };
}

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    call: async (method: string, params?: { conversationId?: string }) => {
      if (method === 'grants.list') {
        return { grants: grantsByConversation[params?.conversationId ?? ''] ?? [] };
      }
      if (method === 'approvals.list') return { approvals: [] };
      return {};
    },
  },
}));

const { permissions } = await import('./permissions.svelte');

beforeEach(() => {
  for (const key of Object.keys(grantsByConversation)) delete grantsByConversation[key];
  permissions.grants = [];
  permissions.approvals = {};
});

describe('permissions.loadForConversation', () => {
  it('keeps a foreground grants list and a second conversation side by side', async () => {
    grantsByConversation['conv_main'] = [grant('g_main', 'conv_main')];
    grantsByConversation['conv_card'] = [grant('g_card', 'conv_card')];

    permissions.start();
    await permissions.loadForConversation('conv_main');
    await permissions.loadForConversation('conv_card', { foreground: false });

    expect(permissions.grants.map((item) => item.id)).toEqual(['g_main']);
    expect(permissions.grantsOf('conv_card').map((item) => item.id)).toEqual(['g_card']);
    expect(permissions.grantsOf('conv_main').map((item) => item.id)).toEqual(['g_main']);

    handlers.get('grant.changed')?.({
      conversationId: 'conv_card',
      grants: [grant('g_card_2', 'conv_card')],
    });
    expect(permissions.grants.map((item) => item.id)).toEqual(['g_main']);
    expect(permissions.grantsOf('conv_card').map((item) => item.id)).toEqual(['g_card_2']);

    handlers.get('grant.changed')?.({
      conversationId: 'conv_main',
      grants: [],
    });
    expect(permissions.grants).toEqual([]);
  });
});
