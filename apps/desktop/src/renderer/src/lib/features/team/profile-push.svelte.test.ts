import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileCategory } from '@kepcup/shared';


/**
 * 画像上行（T7 步骤 5，62.05 §1 + 启动静默同步）：
 * - 确认清单默认勾选规则（boundaries 类 / 凭据模式 / 敏感话题默认不勾选）；
 *   已在服务端的条目默认也不勾选（勾了只是 skipped）。
 * - 自动路径只在真·上线边沿（connections.onTeamOnline）触发，每会话每服务器
 *   至多一次：对比服务端分桶（经团队连接的 member scope `profile.list`）——
 *   从未上行且有差额才弹清单（每日至多一次）；已上行则非敏感、非明确拒绝的
 *   差额静默上行，完全同步则什么都不发生。
 * - 手动刷新不限次；确认回写 pushed 标记与拒绝集。
 */

const h = vi.hoisted(() => ({
  localCalls: [] as string[],
  profileItems: [] as Array<{ id: string; category: string; content: string; status: string }>,
  /** 服务端分桶（经团队连接的 profile.list 返回）。 */
  serverProfileItems: [] as Array<{ category: string; content: string; status?: string }>,
  serverProfileError: false,
  teamCalls: [] as Array<{ method: string; input: unknown }>,
  teamResponder: null as null | ((method: string, input: unknown) => unknown),
  sourcesChanged: [] as Array<() => void>,
  onlineHandlers: new Map<string, Array<() => void>>(),
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    connection: 'connected',
    onEvent: () => () => undefined,
    onConnected: () => () => undefined,
    call: async (method: string) => {
      h.localCalls.push(method);
      if (method === 'profile.list') return { items: h.profileItems };
      return { ok: true };
    },
    callTeam: async () => {
      throw new Error('no team context');
    },
  },
}));

// 团队来源：假注册表（profile-push 只用 sources / get / onTeamOnline / call / callTeam）。
vi.mock('$lib/rpc/connections.svelte', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- 测试 mock 的模块类型标注。
  const actual = (await importOriginal()) as typeof import('$lib/rpc/connections.svelte');
  return {
    ...actual,
    connections: {
      sources: () => ['local', 'team:h1'],
      onSourcesChanged: (callback: () => void) => {
        h.sourcesChanged.push(callback);
        // 注册即触发（等价注册表在 start 后立即广播一次现有来源）。
        queueMicrotask(callback);
        return () => undefined;
      },
      onTeamOnline: (hash: string, handler: () => void) => {
        const handlers = h.onlineHandlers.get(hash) ?? [];
        handlers.push(handler);
        h.onlineHandlers.set(hash, handlers);
        return () => undefined;
      },
      get: (source: string) => ({
        status: 'connected',
        memberId: source === 'team:h1' ? 'mbr_self' : null,
        onConnected: () => () => undefined,
        callTeam: async (method: string, input?: unknown) => {
          h.teamCalls.push({ method, input });
          if (h.teamResponder === null) throw new Error('no responder');
          return h.teamResponder(method, input);
        },
        call: async (method: string, input?: unknown) => {
          h.teamCalls.push({ method, input });
          if (method === 'profile.list') {
            if (h.serverProfileError) throw new Error('server unavailable');
            return { items: h.serverProfileItems };
          }
          return {};
        },
      }),
    },
  };
});

// endpoint.ts 在模块加载时读 window.kepcup —— 先打桩再导入被测模块。
vi.stubGlobal('window', { kepcup: { isWeb: false } });

// localStorage 桩（每日一次的弹框判定 + pushed / 拒绝集记账）。
vi.stubGlobal(
  'localStorage',
  (() => {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    };
  })(),
);

const { profilePushCheckedByDefault } = await import('./profile-sensitive');
const { profilePush } = await import('./profile-push.svelte');

function profileItem(
  id: string,
  category: ProfileCategory,
  content: string,
  status = 'active',
): { id: string; category: ProfileCategory; content: string; status: string } {
  return { id, category, content, status };
}

function store_get(key: string): string | null {
  return (globalThis.localStorage.getItem as (key: string) => string | null)(key);
}

/** 模拟真·上线边沿（平台 WS connected + 端口就绪）。 */
function goOnline(): void {
  for (const handler of h.onlineHandlers.get('h1') ?? []) handler();
}

beforeEach(() => {
  h.localCalls = [];
  h.teamCalls = [];
  h.teamResponder = () => ({ added: 0, skipped: 0 });
  h.serverProfileItems = [];
  h.serverProfileError = false;
  h.profileItems = [
    profileItem('p_basic', 'basic', '偏好简洁回复'),
    profileItem('p_boundaries', 'boundaries', '不要在周末打扰我'),
    profileItem('p_cred', 'work', '我的 API token 是 sk-abcdefghijklmnopqrst'),
    profileItem('p_sensitive', 'health' as ProfileCategory, '最近在治疗失眠'),
    profileItem('p_finance', 'interests', '月薪五万'),
    profileItem('p_old', 'basic', '已过时的偏好', 'superseded'),
  ];
  globalThis.localStorage.clear();
  profilePush.close();
  profilePush.items = [];
  profilePush.resetSyncStateForTests();
});

describe('默认勾选规则（62.05 §1 类别过滤）', () => {
  it('boundaries / 凭据模式 / 敏感话题默认不勾选，其余默认勾选', () => {
    expect(profilePushCheckedByDefault('boundaries', '任意内容')).toBe(false);
    expect(profilePushCheckedByDefault('basic', '密码是 hunter2forever')).toBe(false);
    expect(profilePushCheckedByDefault('basic', 'sk-abcdefghijklmnopqrst')).toBe(false);
    expect(profilePushCheckedByDefault('basic', '确诊了高血压')).toBe(false);
    expect(profilePushCheckedByDefault('basic', '月薪三万')).toBe(false);
    expect(profilePushCheckedByDefault('basic', '离婚了')).toBe(false);
    expect(profilePushCheckedByDefault('basic', '偏好中文交流')).toBe(true);
    expect(profilePushCheckedByDefault('work', '负责市场推广')).toBe(true);
    // 边界词不误伤：普通叙述里出现「密码是必要的」不算凭据。
    expect(profilePushCheckedByDefault('basic', '密码是必要的')).toBe(true);
  });
});

describe('确认清单与上行', () => {
  it('打开清单：敏感条目默认不勾选、superseded 不带；确认只上行勾选条目', async () => {
    await profilePush.openManual('team:h1');
    expect(h.localCalls).toContain('profile.list');
    expect(profilePush.open).toBe(true);
    const items = profilePush.items;
    expect(items.map((item) => item.id)).toEqual([
      'p_basic',
      'p_boundaries',
      'p_cred',
      'p_sensitive',
      'p_finance',
    ]);
    const checked = Object.fromEntries(items.map((item) => [item.id, item.checked]));
    expect(checked).toEqual({
      p_basic: true,
      p_boundaries: false,
      p_cred: false,
      p_sensitive: false,
      p_finance: false,
    });

    h.teamResponder = () => ({ added: 1, skipped: 2 });
    h.teamCalls = []; // 清掉开清单时的两端 profile.list 读取记录，只看上行调用。
    const result = await profilePush.confirm();
    expect(h.teamCalls).toEqual([
      {
        method: 'team.profile.push',
        input: { items: [{ category: 'basic', content: '偏好简洁回复' }] },
      },
    ]);
    expect(result).toEqual({ added: 1, skipped: 2 });
    // 成功即关闭：留在原地会让用户以为还有事务没做完（再点会撞服务端限流）。
    expect(profilePush.open).toBe(false);
    // 确认成功回写 pushed 标记（之后启动走静默同步，不再弹框）。
    expect(store_get('kepcup.teamServers.profilePush.pushed.h1')).toBe('1');
  });

  it('已在服务端的条目默认不勾选（勾了也只是 skipped）', async () => {
    h.serverProfileItems = [{ category: 'basic', content: '偏好简洁回复' }];
    await profilePush.openManual('team:h1');
    const checked = Object.fromEntries(profilePush.items.map((item) => [item.id, item.checked]));
    expect(checked['p_basic']).toBe(false);
    expect(checked['p_boundaries']).toBe(false);
  });

  it('上行失败保留对话框与错误行，重试成功后关闭', async () => {
    await profilePush.openManual('team:h1');
    h.teamResponder = () => {
      throw new Error('boom');
    };
    expect(await profilePush.confirm()).toBeNull();
    expect(profilePush.error).not.toBeNull();
    expect(profilePush.open).toBe(true);

    h.teamResponder = () => ({ added: 0, skipped: 1 });
    expect(await profilePush.confirm()).toEqual({ added: 0, skipped: 1 });
    expect(profilePush.open).toBe(false);
    expect(profilePush.error).toBeNull();
  });

  it('手动勾选敏感条目后随确认上行（成员知情选择），未勾选的差额进拒绝集', async () => {
    await profilePush.openManual('team:h1');
    profilePush.toggle('p_boundaries');
    h.teamCalls = []; // 只看上行调用。
    await profilePush.confirm();
    const input = h.teamCalls[0]!.input as { items: Array<{ category: string }> };
    expect(input.items.map((item) => item.category)).toEqual(['basic', 'boundaries']);
    // 拒绝集 = 未勾选且不在服务端的条目（规范化后小写折叠）。
    const declined = JSON.parse(store_get('kepcup.teamServers.profilePush.declined.h1') ?? '[]');
    expect(declined).toContain('work\u0000我的 api token 是 sk-abcdefghijklmnopqrst');
    expect(declined).not.toContain('boundaries\u0000不要在周末打扰我');
  });
});

describe('启动自动同步（真·上线边沿）', () => {
  it('首次上线有差额 → 弹清单并记 UTC 日；同日不再自动弹，手动不受限', async () => {
    profilePush.start();
    // onSourcesChanged 的广播在微任务里（见 mock）：等一拍再模拟上线。
    await new Promise((resolve) => setTimeout(resolve, 0));
    goOnline();
    await vi.waitFor(() => expect(profilePush.open).toBe(true));
    // 弹框前已对比服务端（读了团队连接上的 profile.list）。
    expect(h.teamCalls.some((call) => call.method === 'profile.list')).toBe(true);
    expect(store_get('kepcup.teamServers.profilePush.day.h1')).toBe(
      new Date().toISOString().slice(0, 10),
    );

    profilePush.close();
    // 同日再上线：不自动弹（会话内也只同步一次）。
    const reads = h.teamCalls.filter((call) => call.method === 'profile.list').length;
    goOnline();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(profilePush.open).toBe(false);
    expect(h.teamCalls.filter((call) => call.method === 'profile.list').length).toBe(reads);

    // 手动入口不限次。
    await profilePush.openManual('team:h1');
    expect(profilePush.open).toBe(true);
  });

  it('从未上行但服务端已有全部条目（如他机推过）→ 不弹框', async () => {
    h.serverProfileItems = h.profileItems
      .filter((item) => item.status === 'active')
      .map((item) => ({ category: item.category, content: item.content }));
    profilePush.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    goOnline();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(profilePush.open).toBe(false);
    expect(h.teamCalls.some((call) => call.method === 'team.profile.push')).toBe(false);
  });

  it('已上行且完全同步 → 不弹框、不重复上行', async () => {
    globalThis.localStorage.setItem('kepcup.teamServers.profilePush.pushed.h1', '1');
    h.serverProfileItems = h.profileItems
      .filter((item) => item.status === 'active')
      .map((item) => ({ category: item.category, content: item.content }));
    profilePush.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    goOnline();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(profilePush.open).toBe(false);
    expect(h.teamCalls.some((call) => call.method === 'team.profile.push')).toBe(false);
  });

  it('已上行 + 新增非敏感条目 → 静默上行差额，不弹框', async () => {
    globalThis.localStorage.setItem('kepcup.teamServers.profilePush.pushed.h1', '1');
    h.serverProfileItems = [{ category: 'basic', content: '偏好简洁回复' }];
    h.profileItems = [
      profileItem('p_basic', 'basic', '偏好简洁回复'),
      profileItem('p_new', 'work', '负责支付模块'),
    ];
    h.teamResponder = () => ({ added: 1, skipped: 0 });
    profilePush.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    goOnline();
    await vi.waitFor(() =>
      expect(h.teamCalls.some((call) => call.method === 'team.profile.push')).toBe(true),
    );
    expect(profilePush.open).toBe(false);
    expect(h.teamCalls.find((call) => call.method === 'team.profile.push')?.input).toEqual({
      items: [{ category: 'work', content: '负责支付模块' }],
    });
  });

  it('已上行 + 新增敏感条目 → 不静默上行（只经确认清单 / 手动入口）', async () => {
    globalThis.localStorage.setItem('kepcup.teamServers.profilePush.pushed.h1', '1');
    h.serverProfileItems = [{ category: 'basic', content: '偏好简洁回复' }];
    h.profileItems = [
      profileItem('p_basic', 'basic', '偏好简洁回复'),
      profileItem('p_new', 'health' as ProfileCategory, '最近在治疗失眠'),
    ];
    profilePush.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    goOnline();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(profilePush.open).toBe(false);
    expect(h.teamCalls.some((call) => call.method === 'team.profile.push')).toBe(false);
  });

  it('拒绝集拦截静默同步：确认时明确不要的条目不再自动上行', async () => {
    globalThis.localStorage.setItem('kepcup.teamServers.profilePush.pushed.h1', '1');
    globalThis.localStorage.setItem(
      'kepcup.teamServers.profilePush.declined.h1',
      JSON.stringify(['work\u0000负责支付模块']),
    );
    h.serverProfileItems = [{ category: 'basic', content: '偏好简洁回复' }];
    h.profileItems = [
      profileItem('p_basic', 'basic', '偏好简洁回复'),
      profileItem('p_new', 'work', '负责支付模块'),
    ];
    profilePush.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    goOnline();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.teamCalls.some((call) => call.method === 'team.profile.push')).toBe(false);
  });

  it('服务端条目读不到（旧版服务器）→ 按空集兜底，静默上行幂等', async () => {
    globalThis.localStorage.setItem('kepcup.teamServers.profilePush.pushed.h1', '1');
    h.serverProfileError = true;
    h.profileItems = [profileItem('p_basic', 'basic', '偏好简洁回复')];
    h.teamResponder = () => ({ added: 1, skipped: 0 });
    profilePush.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    goOnline();
    await vi.waitFor(() =>
      expect(h.teamCalls.some((call) => call.method === 'team.profile.push')).toBe(true),
    );
    expect(profilePush.open).toBe(false);
  });

  it('本机画像为空 → 会话内不再自动触发（也不弹空清单）', async () => {
    h.profileItems = [];
    profilePush.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    goOnline();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(profilePush.open).toBe(false);
    expect(h.teamCalls.some((call) => call.method === 'team.profile.push')).toBe(false);
    expect(h.teamCalls.some((call) => call.method === 'profile.list')).toBe(false);
  });
});
