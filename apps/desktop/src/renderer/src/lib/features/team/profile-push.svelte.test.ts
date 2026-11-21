import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileCategory } from '@kepcup/shared';


/**
 * 画像上行（T7 步骤 5，62.05 §1）：
 * - 确认清单默认勾选规则（boundaries 类 / 凭据模式 / 敏感话题默认不勾选）；
 * - 手动刷新不限次；自动路径每日至多一次（localStorage 记 UTC 日）；
 * - 确认只上行勾选条目（team.profile.push，经团队连接）。
 */

const h = vi.hoisted(() => ({
  localCalls: [] as string[],
  profileItems: [] as Array<{ id: string; category: string; content: string; status: string }>,
  teamCalls: [] as Array<{ method: string; input: unknown }>,
  teamResponder: null as null | ((method: string, input: unknown) => unknown),
  sourcesChanged: [] as Array<() => void>,
  connectedHandlers: [] as Array<() => void>,
  storage: null as null | Map<string, string>,
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

// 团队来源：假注册表（profile-push 只用 sources/get/onConnected/callTeam）。
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
      get: (source: string) => ({
        status: 'connected',
        memberId: source === 'team:h1' ? 'mbr_self' : null,
        onConnected: (handler: () => void) => {
          h.connectedHandlers.push(handler);
          return () => undefined;
        },
        callTeam: async (method: string, input?: unknown) => {
          h.teamCalls.push({ method, input });
          if (h.teamResponder === null) throw new Error('no responder');
          return h.teamResponder(method, input);
        },
        call: async (method: string, input?: unknown) => {
          h.teamCalls.push({ method, input });
          return {};
        },
      }),
    },
  };
});

// endpoint.ts 在模块加载时读 window.kepcup —— 先打桩再导入被测模块。
vi.stubGlobal('window', { kepcup: { isWeb: false } });

// localStorage 桩（每日一次的自动路径判定）。
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

beforeEach(() => {
  h.localCalls = [];
  h.teamCalls = [];
  h.teamResponder = () => ({ added: 0, skipped: 0 });
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
    await profilePush.confirm();
    expect(h.teamCalls).toEqual([
      {
        method: 'team.profile.push',
        input: { items: [{ category: 'basic', content: '偏好简洁回复' }] },
      },
    ]);
    expect(profilePush.lastResult).toEqual({ added: 1, skipped: 2 });
  });

  it('手动勾选敏感条目后随确认上行（成员知情选择）', async () => {
    await profilePush.openManual('team:h1');
    profilePush.toggle('p_boundaries');
    await profilePush.confirm();
    const input = h.teamCalls[0]!.input as { items: Array<{ category: string }> };
    expect(input.items.map((item) => item.category)).toEqual(['basic', 'boundaries']);
  });
});

describe('自动路径每日至多一次', () => {
  it('首次连接成功弹清单并记 UTC 日；同日不再自动弹，手动不受限', async () => {
    profilePush.start();
    // onSourcesChanged 的广播在微任务里（见 mock）：等一拍再模拟连接成功。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.connectedHandlers.length).toBeGreaterThan(0);
    for (const handler of [...h.connectedHandlers]) handler();
    await vi.waitFor(() => expect(profilePush.open).toBe(true));
    expect(globalThis.localStorage.getItem('kepcup.teamServers.profilePush.day.h1')).toBe(
      new Date().toISOString().slice(0, 10),
    );

    profilePush.close();
    // 同日再连：不自动弹。
    const openCountBefore = h.localCalls.filter((method) => method === 'profile.list').length;
    for (const handler of [...h.connectedHandlers]) handler();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(profilePush.open).toBe(false);
    expect(h.localCalls.filter((method) => method === 'profile.list').length).toBe(openCountBefore);

    // 手动入口不限次。
    await profilePush.openManual('team:h1');
    expect(profilePush.open).toBe(true);
  });
});
