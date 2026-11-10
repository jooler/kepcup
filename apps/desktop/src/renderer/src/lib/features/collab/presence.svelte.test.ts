import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D119 在线状态 store：进入 / 离开会话、typing 降级、事件按会话过滤、
 * 同输入框重复 enter 不产生额外 RPC（Composer 的 effect 会因击键频繁重跑）。
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; input: unknown }>,
  handler: null as ((payload: unknown) => void) | null,
  statusHandler: null as ((payload: unknown) => void) | null,
  list: { entries: [] as unknown[] },
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    onEvent: (name: string, fn: (payload: unknown) => void) => {
      if (name === 'collab.presenceChanged') h.handler = fn;
      if (name === 'core.status') h.statusHandler = fn;
      return () => {
        if (h.handler === fn) h.handler = null;
        if (h.statusHandler === fn) h.statusHandler = null;
      };
    },
    call: async (method: string, input?: unknown) => {
      h.calls.push({ method, input });
      if (method === 'collab.presence.list') return h.list;
      return { ok: true };
    },
  },
}));

vi.mock('./client-identity', () => ({
  clientIdentity: { id: 'self', name: 'Me', connectionId: 'conn-self', color: '#000000' },
}));

const docListeners = new Map<string, () => void>();
const fakeDocument = {
  visibilityState: 'visible',
  addEventListener: (name: string, fn: () => void) => docListeners.set(name, fn),
  removeEventListener: (name: string) => docListeners.delete(name),
};
vi.stubGlobal('document', fakeDocument);

const { presence } = await import('./presence.svelte');

function updates(): Array<Record<string, unknown>> {
  return h.calls
    .filter((call) => call.method === 'collab.presence.update')
    .map((call) => call.input as Record<string, unknown>);
}

function entry(clientId: string, state = 'viewing') {
  return {
    clientId,
    clientName: clientId,
    color: '#0284c7',
    connectionId: `conn-${clientId}`,
    conversationId: 'conv-a',
    state,
    selection: null,
    updatedAt: 1,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.calls.length = 0;
  h.handler = null;
  h.statusHandler = null;
  h.list.entries = [];
  docListeners.clear();
  fakeDocument.visibilityState = 'visible';
  presence.start();
});

afterEach(() => {
  presence.stop();
  vi.useRealTimers();
});

describe('presence store', () => {
  it('reports an online state on start (outside any conversation)', async () => {
    await Promise.resolve();
    expect(updates().at(-1)).toMatchObject({
      clientId: 'self',
      connectionId: 'conn-self',
      conversationId: null,
      state: 'viewing',
    });
  });

  it('entering a conversation fetches the snapshot and reports it', async () => {
    const source = Symbol('composer');
    presence.enter('conv-a', source);
    await Promise.resolve();
    expect(h.calls.some((call) => call.method === 'collab.presence.list')).toBe(true);
    expect(updates().at(-1)).toMatchObject({ conversationId: 'conv-a', state: 'viewing' });
  });

  it('typing goes back to viewing after the idle window', async () => {
    const source = Symbol('composer');
    presence.enter('conv-a', source);
    h.calls.length = 0;

    presence.noteTyping();
    expect(updates().at(-1)).toMatchObject({ state: 'typing' });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(updates().at(-1)).toMatchObject({ state: 'viewing' });
  });

  it('reports a heartbeat every 20 seconds', async () => {
    const source = Symbol('composer');
    presence.enter('conv-a', source);
    h.calls.length = 0;

    await vi.advanceTimersByTimeAsync(20_000);
    expect(updates().length).toBeGreaterThanOrEqual(1);
    expect(updates().at(-1)).toMatchObject({ conversationId: 'conv-a' });
  });

  it('reports away when the page becomes hidden and viewing when visible again', async () => {
    const source = Symbol('composer');
    presence.enter('conv-a', source);
    h.calls.length = 0;

    fakeDocument.visibilityState = 'hidden';
    docListeners.get('visibilitychange')?.();
    await Promise.resolve();
    expect(updates().at(-1)).toMatchObject({ state: 'away' });

    fakeDocument.visibilityState = 'visible';
    docListeners.get('visibilitychange')?.();
    await Promise.resolve();
    expect(updates().at(-1)).toMatchObject({ state: 'viewing' });
  });

  it('sends an explicit null selection when the caret is cleared', async () => {
    const source = Symbol('composer');
    presence.enter('conv-a', source);
    presence.noteSelection(2, 4, 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(updates().at(-1)?.selection).toEqual({ anchor: 2, head: 4, docVersion: 1 });

    h.calls.length = 0;
    presence.clearSelection();
    await Promise.resolve();
    expect(updates().at(-1)?.selection).toBeNull();
  });

  it('applies presence events only for the active conversation', () => {
    const source = Symbol('composer');
    presence.enter('conv-a', source);

    h.handler?.({ conversationId: null, entries: [entry('global')] });
    expect(presence.entries).toHaveLength(0);

    h.handler?.({ conversationId: 'conv-b', entries: [entry('other')] });
    expect(presence.entries).toHaveLength(0);

    h.handler?.({ conversationId: 'conv-a', entries: [entry('other', 'typing')] });
    expect(presence.entries).toEqual([entry('other', 'typing')]);
  });

  it('leaving clears the conversation and reports it', () => {
    const source = Symbol('composer');
    presence.enter('conv-a', source);
    h.calls.length = 0;

    presence.leave(source);
    expect(presence.entries).toHaveLength(0);
    expect(updates().at(-1)).toMatchObject({ conversationId: null });
  });

  it('re-entering the same conversation with the same source sends nothing', () => {
    const source = Symbol('composer');
    presence.enter('conv-a', source);
    const count = h.calls.length;

    // Composer 的会话 effect 会因草稿变化重跑；重复 enter 不能多发 RPC。
    presence.enter('conv-a', source);
    presence.enter('conv-a', source);
    expect(h.calls.length).toBe(count);
  });

  it('refreshes and re-reports when core becomes ready again', async () => {
    const source = Symbol('composer');
    presence.enter('conv-a', source);
    h.calls.length = 0;

    h.statusHandler?.({ status: 'ready' });
    await Promise.resolve();
    expect(h.calls.some((call) => call.method === 'collab.presence.list')).toBe(true);
    expect(updates().at(-1)).toMatchObject({ conversationId: 'conv-a' });
  });
});
