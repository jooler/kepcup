import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 好友层客户端状态（62.04 D129v2）的通知行为（2026-11）：
 * - 新收到的好友申请（与上一次切片的 incoming diff）弹 toast，副文带申请消息，
 *   停留 1 分钟；「去处理」跳通讯录，「忽略」关通知（条目留在通讯录）；
 * - 首拉（无上一切片）与断线后的重拉不弹——避免启动 / 重连对存量申请轰炸；
 * - 同一申请 id 只弹一次（重复 friend.requested / 幂等刷新不再响；并发 refresh
 *   在切片写入前连续触发，也只弹一次）。
 *
 * connections / toast / shell 全 mock（无网络、无 DOM）。
 */

const h = vi.hoisted(() => {
  const state = {
    sources: ['local'] as string[],
    connected: true,
    /** 每次 callTeam('team.friends.list') 依次返回的载荷。 */
    listQueue: [] as Array<Record<string, unknown>>,
    calls: [] as string[],
  };
  const teamEventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const toast = {
    // toast.info 返回通知 id（「忽略」按钮的 dismiss 目标）；签名带参让
    // mock.calls 的元组形态与真实调用一致（供用例读取 options 断言）。
    info: vi.fn((_message: string, _data?: Record<string, unknown>) => 'toast_1'),
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  };
  const openSettings = vi.fn();
  function currentList(): Record<string, unknown> {
    return state.listQueue[Math.min(state.calls.filter((c) => c === 'team.friends.list').length, state.listQueue.length) - 1] ?? {
      friends: [],
      incoming: [],
      outgoing: [],
      blocked: [],
    };
  }
  return { state, teamEventHandlers, toast, openSettings, currentList };
});

vi.mock('svelte-sonner', () => ({ toast: h.toast }));

vi.mock('$lib/stores/shell.svelte', () => ({ shell: { openSettings: h.openSettings } }));

vi.mock('$lib/rpc/connections.svelte', () => ({
  serverHashOf: (source: string) => (source === 'local' ? null : source.slice('team:'.length)),
  teamSourceId: (hash: string) => `team:${hash}`,
  connections: {
    sources: () => h.state.sources,
    onSourcesChanged: () => () => undefined,
    get: (_source: string) => ({
      status: h.state.connected ? 'connected' : 'disconnected',
      onConnected: (handler: () => void) => {
        h.teamEventHandlers.set('__connected__', new Set([handler]));
        return () => undefined;
      },
      onTeamEvent: (name: string, handler: (payload: unknown) => void) => {
        let set = h.teamEventHandlers.get(name);
        if (!set) {
          set = new Set();
          h.teamEventHandlers.set(name, set);
        }
        set.add(handler);
        return () => set?.delete(handler);
      },
      callTeam: async (method: string) => {
        h.state.calls.push(method);
        if (method === 'team.friends.list') return h.currentList();
        // 发申请走通（载荷不校验）：request() 成功后应触发一次重拉。
        if (method === 'team.friends.request') return {};
        throw new Error(`unexpected ${method}`);
      },
    }),
  },
}));

/**
 * 每个用例拿全新模块实例：FriendsState 的 #started / #wired 是模块级单例状态，
 * 跨用例残留会让 start() 变 no-op（vi.resetModules 保留 vi.mock 的桩）。
 */
type FriendsStore = Awaited<ReturnType<typeof loadStore>>;

async function loadStore() {
  return (await import('./friends.svelte')).friends;
}

async function freshStore(): Promise<FriendsStore> {
  vi.resetModules();
  return loadStore();
}

function request(id: string, name: string, message?: string) {
  return {
    id,
    from: { id: `mbr_${id}`, displayName: name, state: 'online' },
    to: { id: 'mbr_self', displayName: '沈知微', state: 'online' },
    ...(message !== undefined ? { message } : {}),
  };
}

beforeEach(() => {
  h.state.sources = ['local'];
  h.state.connected = true;
  h.state.listQueue = [];
  h.state.calls = [];
  // 事件注册表跨模块实例共享（hoisted map），新实例 #wire 会再注册——清掉旧实例
  // 的处理器，否则上一轮 store 的 refresh 也会被本用例的手动 emit 触发。
  h.teamEventHandlers.clear();
  h.toast.info.mockClear();
  h.toast.info.mockReturnValue('toast_1');
  h.toast.dismiss.mockClear();
  h.openSettings.mockClear();
});

describe('好友申请通知（2026-11）', () => {
  it('首拉有存量申请不弹 toast（启动不轰炸）', async () => {
    const friends = await freshStore();
    h.state.listQueue = [{ friends: [], incoming: [request('frq_1', '顾念', '你好')], outgoing: [], blocked: [] }];
    friends.start();
    await vi.waitFor(() => expect(h.state.calls).toContain('team.friends.list'));
    expect(h.toast.info).not.toHaveBeenCalled();
  });

  it('事件到达后新申请弹 toast：副文带申请消息、去处理跳通讯录', async () => {
    const friends = await freshStore();
    h.state.listQueue = [
      { friends: [], incoming: [], outgoing: [], blocked: [] },
      { friends: [], incoming: [request('frq_2', 'jerr', '测试好友效果')], outgoing: [], blocked: [] },
    ];
    friends.start();
    await vi.waitFor(() => expect(h.state.calls.filter((c) => c === 'team.friends.list').length).toBe(1));
    expect(h.toast.info).not.toHaveBeenCalled();

    // friend.requested 事件 → 重拉 → diff 出新申请
    for (const handler of h.teamEventHandlers.get('friend.requested') ?? []) handler({});
    await vi.waitFor(() => expect(h.toast.info).toHaveBeenCalledTimes(1));
    expect(h.toast.info).toHaveBeenCalledWith(
      expect.stringContaining('jerr'),
      expect.objectContaining({
        description: '测试好友效果',
        // 停留 1 分钟（仅此 toast，不动全局 Toaster）。
        duration: 60_000,
        action: expect.objectContaining({ label: expect.any(String) }),
        cancel: expect.objectContaining({ label: expect.any(String) }),
      }),
    );
    // 「去处理」跳通讯录；「忽略」立即关通知（toast.dismiss 带 info 返回的 id）。
    const options = h.toast.info.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
      cancel: { onClick: () => void };
    };
    options.action.onClick();
    expect(h.openSettings).toHaveBeenCalledWith('contacts');
    options.cancel.onClick();
    expect(h.toast.dismiss).toHaveBeenCalledWith('toast_1');
  });

  it('同一申请只弹一次（幂等刷新 / 重复事件不再响）', async () => {
    const friends = await freshStore();
    h.state.listQueue = [
      { friends: [], incoming: [], outgoing: [], blocked: [] },
      { friends: [], incoming: [request('frq_3', 'jerr')], outgoing: [], blocked: [] },
      { friends: [], incoming: [request('frq_3', 'jerr')], outgoing: [], blocked: [] },
    ];
    friends.start();
    await vi.waitFor(() => expect(h.state.calls.filter((c) => c === 'team.friends.list').length).toBe(1));
    for (const handler of h.teamEventHandlers.get('friend.requested') ?? []) handler({});
    await vi.waitFor(() => expect(h.toast.info).toHaveBeenCalledTimes(1));
    // 再来一次相同列表的刷新（重复事件）——不新增 toast。
    for (const handler of h.teamEventHandlers.get('friend.requested') ?? []) handler({});
    await vi.waitFor(() => expect(h.state.calls.filter((c) => c === 'team.friends.list').length).toBe(3));
    expect(h.toast.info).toHaveBeenCalledTimes(1);
  });

  it('并发 refresh 只弹一次（切片写入前连续两次事件共享同一新申请）', async () => {
    const friends = await freshStore();
    h.state.listQueue = [
      { friends: [], incoming: [], outgoing: [], blocked: [] },
      { friends: [], incoming: [request('frq_4', 'jerr', '并发到货')], outgoing: [], blocked: [] },
    ];
    friends.start();
    await vi.waitFor(() => expect(h.state.calls.filter((c) => c === 'team.friends.list').length).toBe(1));

    // 连续两次事件、不等第一次 refresh 写回切片：两次 RPC 都读到同一条新申请
    //（竞态下各自 diff 都会视其为新），实例级已弹集合兜底只弹一次。
    for (const handler of h.teamEventHandlers.get('friend.requested') ?? []) handler({});
    for (const handler of h.teamEventHandlers.get('friend.requested') ?? []) handler({});
    await vi.waitFor(() => expect(h.state.calls.filter((c) => c === 'team.friends.list').length).toBe(3));
    expect(h.toast.info).toHaveBeenCalledTimes(1);
    expect(h.toast.info).toHaveBeenCalledWith(expect.stringContaining('jerr'), expect.anything());
  });
});

describe('发送申请后的切片收敛（2026-11）', () => {
  it('request() 成功后立即重拉：outgoing 进入切片（弹框按钮据此禁用）', async () => {
    const friends = await freshStore();
    h.state.listQueue = [
      { friends: [], incoming: [], outgoing: [], blocked: [] },
      {
        friends: [],
        incoming: [],
        outgoing: [
          {
            id: 'frq_9',
            from: { id: 'mbr_self', displayName: 'jerr', state: 'online' },
            to: { id: 'mbr_shen', displayName: '沈知微', state: 'online' },
          },
        ],
        blocked: [],
      },
    ];
    friends.start();
    await vi.waitFor(() => expect(h.state.calls.filter((c) => c === 'team.friends.list').length).toBe(1));

    await friends.request('local', 'shenzhiwei', '交个朋友');
    // RPC 成功后补一次 refresh：切片 outgoing 以服务端 pending 为准，
    // 对方拒绝 / 接受 / 移除后 friend.* 事件 → refresh → 禁用自动解除。
    await vi.waitFor(() => expect(h.state.calls.filter((c) => c === 'team.friends.list').length).toBe(2));
    expect(
      friends.sliceOf('local')?.outgoing.some((request) => request.to.id === 'mbr_shen'),
    ).toBe(true);
  });
});
