import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabDraft } from '@kepcup/shared';

/**
 * D120 共享草稿 store：claim / 只读镜像 / 版本化上传 / 接管 / 发送清空 /
 * IME 组合期不广播。
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; input: Record<string, unknown> }>,
  handlers: new Map<string, (payload: unknown) => void>(),
  draft: {
    conversationId: 'conv-1',
    doc: { type: 'doc', content: [] },
    mentions: [],
    replyTo: null,
    attachments: [],
    version: 0,
    updatedAt: 0,
  } as CollabDraft,
  lease: null as Record<string, unknown> | null,
  busy: false,
  updateError: null as (Error & { code?: string }) | null,
  composer: {
    hasContent: false,
    dirtyNow: false,
    localVersion: 0,
    localDoc: { type: 'doc', content: [] } as CollabDraft['doc'],
    hydrated: [] as string[],
    applied: [] as Array<Record<string, unknown>>,
    synced: [] as Array<{ version: number; dirty: boolean }>,
    dirty: [] as string[],
    cleared: [] as string[],
    clearedUploads: [] as string[],
  },
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    onEvent: (name: string, fn: (payload: unknown) => void) => {
      h.handlers.set(name, fn);
      return () => h.handlers.delete(name);
    },
    call: async (method: string, input?: Record<string, unknown>) => {
      h.calls.push({ method, input: input ?? {} });
      if (method === 'collab.draft.get') {
        return { draft: h.draft, lease: h.lease };
      }
      if (method === 'collab.draft.claim') {
        if (h.busy && input?.force !== true) {
          const error = new Error('busy') as Error & { code: string };
          error.code = 'DRAFT_BUSY';
          throw error;
        }
        h.busy = false;
        h.lease = {
          ownerClientId: input?.clientId,
          ownerConnectionId: input?.connectionId ?? 'conn-x',
          ownerName: input?.clientName,
          expiresAt: 2,
        };
        return { draft: h.draft, lease: h.lease };
      }
      if (method === 'collab.draft.update') {
        if (h.updateError !== null) {
          const error = h.updateError;
          if ((error as { code?: string }).code === 'DRAFT_STALE') {
            // 模拟“别处已推进版本”：重载后客户端用新 baseVersion 重试。
            h.updateError = null;
            h.draft = { ...h.draft, version: h.draft.version + 1 };
          }
          throw error;
        }
        h.draft = {
          ...h.draft,
          doc: input?.doc as CollabDraft['doc'],
          version: h.draft.version + 1,
        };
        return { version: h.draft.version, updatedAt: 1 };
      }
      if (method === 'collab.draft.send') {
        return { message: {}, runId: null };
      }
      return { ok: true };
    },
  },
}));

vi.mock('$lib/features/chats/composer-drafts.svelte', () => ({
  composerDrafts: {
    hydrate: (conversationId: string) => h.composer.hydrated.push(conversationId),
    hasContent: () => h.composer.hasContent,
    isDirty: () => h.composer.dirtyNow,
    syncVersion: () => h.composer.localVersion,
    loadDraft: () => ({ doc: h.composer.localDoc, mentions: [], reply: null }),
    attachmentsMetadata: () => [],
    applyServerDraft: (_conversationId: string, input: Record<string, unknown>) =>
      h.composer.applied.push(input),
    setSyncState: (_conversationId: string, state: { version: number; dirty: boolean }) =>
      h.composer.synced.push(state),
    markDirty: (conversationId: string) => h.composer.dirty.push(conversationId),
    clearDocState: (conversationId: string) => h.composer.cleared.push(conversationId),
    clearUploads: (conversationId: string) => h.composer.clearedUploads.push(conversationId),
  },
}));

vi.mock('./client-identity', () => ({
  clientIdentity: { id: 'self', name: 'Me', connectionId: 'conn-self', color: '#000000' },
}));

const { SharedDraftStore } = await import('./shared-draft.svelte');
let sharedDraft: InstanceType<typeof SharedDraftStore>;

function calls(method: string) {
  return h.calls.filter((call) => call.method === method);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.calls.length = 0;
  h.handlers.clear();
  h.updateError = null;
  h.draft = {
    conversationId: 'conv-1',
    doc: { type: 'doc', content: [] },
    mentions: [],
    replyTo: null,
    attachments: [],
    version: 0,
    updatedAt: 0,
  };
  h.lease = null;
  h.busy = false;
  h.composer.hasContent = false;
  h.composer.dirtyNow = false;
  h.composer.localVersion = 0;
  h.composer.localDoc = { type: 'doc', content: [] };
  h.composer.hydrated.length = 0;
  h.composer.applied.length = 0;
  h.composer.synced.length = 0;
  h.composer.dirty.length = 0;
  h.composer.cleared.length = 0;
  h.composer.clearedUploads.length = 0;
  sharedDraft = new SharedDraftStore();
  sharedDraft.start();
});

afterEach(() => {
  sharedDraft.stop();
  vi.useRealTimers();
});

describe('shared draft store', () => {
  it('claims an empty draft and becomes the owner', async () => {
    await sharedDraft.enter('conv-1', Symbol('composer'));
    expect(h.composer.hydrated).toContain('conv-1');
    expect(calls('collab.draft.claim')).toHaveLength(1);
    expect(sharedDraft.state).toBe('owner');
    expect(sharedDraft.owner?.id).toBe('self');
  });

  it('applies the server draft when there are no local changes', async () => {
    h.draft = { ...h.draft, version: 3 };
    await sharedDraft.enter('conv-1', Symbol('composer'));
    expect(h.composer.applied.at(-1)).toMatchObject({ version: 3 });
    expect(sharedDraft.version).toBe(3);
    expect(calls('collab.draft.update')).toHaveLength(0);
  });

  it('migrates local content when the server draft is empty', async () => {
    h.composer.hasContent = true;
    h.composer.dirtyNow = true;
    h.composer.localDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'local text' }] }],
    };
    await sharedDraft.enter('conv-1', Symbol('composer'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls('collab.draft.update')).toHaveLength(1);
    expect(calls('collab.draft.update')[0]?.input).toMatchObject({
      baseVersion: 0,
      connectionId: 'conn-self',
    });
    expect(sharedDraft.version).toBe(1);
  });

  it('becomes a reader when another client holds the lease', async () => {
    h.busy = true;
    h.lease = {
      ownerClientId: 'other',
      ownerConnectionId: 'conn-other',
      ownerName: 'Other',
      expiresAt: 2,
    };
    await sharedDraft.enter('conv-1', Symbol('composer'));
    expect(sharedDraft.state).toBe('reader');
    expect(sharedDraft.owner).toEqual({ id: 'other', name: 'Other' });
  });

  it('explicit takeover force-claims the lease', async () => {
    h.busy = true;
    h.lease = {
      ownerClientId: 'other',
      ownerConnectionId: 'conn-other',
      ownerName: 'Other',
      expiresAt: 2,
    };
    await sharedDraft.enter('conv-1', Symbol('composer'));
    expect(sharedDraft.state).toBe('reader');

    await sharedDraft.takeover();
    expect(calls('collab.draft.claim').at(-1)?.input.force).toBe(true);
    expect(sharedDraft.state).toBe('owner');
  });

  it('demotes the old owner to reader on a takeover event', async () => {
    await sharedDraft.enter('conv-1', Symbol('composer'));
    expect(sharedDraft.state).toBe('owner');

    h.handlers.get('collab.draftOwnerChanged')?.({
      conversationId: 'conv-1',
      owner: { id: 'other', name: 'Other' },
      ownerConnectionId: 'conn-other',
      expiresAt: 2,
    });
    expect(sharedDraft.state).toBe('reader');
    expect(sharedDraft.owner).toEqual({ id: 'other', name: 'Other' });
  });

  it('recovers from a stale update by reloading and retrying the pending text', async () => {
    await sharedDraft.enter('conv-1', Symbol('composer'));
    h.calls.length = 0;
    const stale = new Error('stale') as Error & { code: string };
    stale.code = 'DRAFT_STALE';
    h.updateError = stale;

    sharedDraft.noteLocalChange({
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
      mentions: [],
      replyTo: null,
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.updateError).toBeNull();
    expect(sharedDraft.state).toBe('owner');
    expect(calls('collab.draft.update').length).toBeGreaterThanOrEqual(2);
    expect(sharedDraft.version).toBe(2);
  });

  it('retains pending text through an offline failure and pushes it after reconnect', async () => {
    await sharedDraft.enter('conv-1', Symbol('composer'));
    h.calls.length = 0;
    h.updateError = new Error('offline');

    sharedDraft.noteLocalChange({
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'offline text' }] }],
      },
      mentions: [],
      replyTo: null,
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(sharedDraft.state).toBe('offline');

    // 网络恢复：core ready 重新 get + claim，然后重推本地 pending。
    h.updateError = null;
    h.calls.length = 0;
    h.handlers.get('core.status')?.({ status: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    const update = calls('collab.draft.update').at(-1);
    expect(update?.input).toMatchObject({ baseVersion: 0 });
    expect(sharedDraft.state).toBe('owner');
  });

  it('debounces local changes into a versioned update', async () => {
    await sharedDraft.enter('conv-1', Symbol('composer'));
    h.calls.length = 0;

    sharedDraft.noteLocalChange({
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
      mentions: ['bot:1'],
      replyTo: null,
      attachments: [],
    });
    expect(calls('collab.draft.update')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls('collab.draft.update')).toHaveLength(1);
    expect(sharedDraft.version).toBe(1);
    expect(h.composer.synced.at(-1)).toEqual({ version: 1, dirty: false });
  });

  it('holds updates while the IME composition is active', async () => {
    await sharedDraft.enter('conv-1', Symbol('composer'));
    h.calls.length = 0;

    sharedDraft.setComposing(true);
    sharedDraft.noteLocalChange({
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
      mentions: [],
      replyTo: null,
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(calls('collab.draft.update')).toHaveLength(0);

    sharedDraft.setComposing(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls('collab.draft.update')).toHaveLength(1);
  });

  it('mirrors draft events for readers and ignores owner echoes', async () => {
    h.busy = true;
    h.lease = {
      ownerClientId: 'other',
      ownerConnectionId: 'conn-other',
      ownerName: 'Other',
      expiresAt: 2,
    };
    await sharedDraft.enter('conv-1', Symbol('composer'));
    h.composer.applied.length = 0;

    h.handlers.get('collab.draftChanged')?.({
      conversationId: 'conv-1',
      draft: { ...h.draft, version: 4 },
    });
    expect(h.composer.applied.at(-1)).toMatchObject({ version: 4 });

    // 持有者忽略回声。
    h.busy = false;
    h.lease = null;
    await sharedDraft.takeover();
    h.composer.applied.length = 0;
    h.handlers.get('collab.draftChanged')?.({
      conversationId: 'conv-1',
      draft: { ...h.draft, version: 5 },
    });
    expect(h.composer.applied).toHaveLength(0);
  });

  it('clears the editor when the draft is sent', async () => {
    await sharedDraft.enter('conv-1', Symbol('composer'));
    const result = await sharedDraft.send({ text: 'hello' });
    expect(result).toEqual({ ok: true });
    expect(calls('collab.draft.send')).toHaveLength(1);
    expect(sharedDraft.state).toBe('no-owner');
    expect(h.composer.cleared).toContain('conv-1');
  });
});
