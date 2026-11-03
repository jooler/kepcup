import { flushSync } from 'svelte';
import type { Delegation } from '@kepcup/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 委派渲染端缓存（D71 v2 / D113）：懒订阅 delegation.updated、ensure 单次拉取、
 * openDetail / closeDetail、cancel 就地刷新。真实的 Svelte 响应式运行时
 * （desktop-svelte 项目）。模块单例的订阅一旦建立就保留（handler 集合不清理）。
 */

const calls: Array<{ method: string; params: unknown }> = [];
const handlers = new Map<string, Set<(payload: unknown) => void>>();
let getResult: Delegation | null = null;
let cancelResult: Delegation | null = null;
let failGet = false;

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case 'delegations.get':
          if (failGet) throw new Error('boom');
          return { delegation: getResult };
        case 'delegations.cancel':
          return { delegation: cancelResult };
        default:
          return {};
      }
    },
  },
}));

const { delegations } = await import('./delegations.svelte');

const row = (id: string, status: Delegation['status'] = 'working') =>
  ({
    id,
    fromBotId: 'bot_a',
    toBotId: 'bot_b',
    fromConversationId: 'conv_a',
    toConversationId: 'conv_b',
    exchangeConversationId: `conv_ex_${id}`,
    taskText: '查 X',
    status,
    depth: 1,
    fromRunId: null,
    sentMessageId: null,
    toMessageId: null,
    runId: null,
    resultExcerpt: null,
    resultMessageId: null,
    resultCardId: null,
    errorText: null,
    intent: 'request',
    taskIds: [],
    createdAt: 1,
    updatedAt: 1,
  }) as Delegation;

const emit = (event: string, payload: unknown): void => {
  for (const handler of handlers.get(event) ?? []) handler(payload);
};

beforeEach(() => {
  calls.length = 0;
  getResult = null;
  cancelResult = null;
  failGet = false;
  delegations.byId = {};
  delegations.openDetailId = null;
});

describe('delegations store（药丸数据与详情开关）', () => {
  it('ensure 拉取一次并写缓存；再 ensure 去重；拉取失败静默兜底', async () => {
    getResult = row('dlg_1');
    await delegations.ensure('dlg_1');
    await delegations.ensure('dlg_1');
    expect(calls.filter((c) => c.method === 'delegations.get')).toHaveLength(1);
    expect(delegations.byId['dlg_1']?.status).toBe('working');
    // 空 id 不发请求。
    await delegations.ensure('');
    expect(calls.filter((c) => c.method === 'delegations.get')).toHaveLength(1);

    failGet = true;
    await delegations.ensure('dlg_2');
    expect(delegations.byId['dlg_2']).toBeUndefined();
  });

  it('delegation.updated 推送刷新状态（药丸与详情头部实时重绘）', async () => {
    void delegations.ensure('dlg_1');
    emit('delegation.updated', { delegation: row('dlg_1', 'submitted') });
    flushSync();
    expect(delegations.byId['dlg_1']?.status).toBe('submitted');
    emit('delegation.updated', { delegation: row('dlg_1', 'completed') });
    flushSync();
    expect(delegations.byId['dlg_1']?.status).toBe('completed');
  });

  it('openDetail 记下 id 并触发 ensure；closeDetail 复位', async () => {
    getResult = row('dlg_1');
    delegations.openDetail('dlg_1');
    expect(delegations.openDetailId).toBe('dlg_1');
    await Promise.resolve();
    flushSync();
    expect(calls.some((c) => c.method === 'delegations.get')).toBe(true);
    expect(delegations.byId['dlg_1']).not.toBeUndefined();
    delegations.closeDetail();
    flushSync();
    expect(delegations.openDetailId).toBeNull();
  });

  it('cancel 用返回的委派行刷新缓存；返回 null 不写缓存', async () => {
    delegations.byId['dlg_1'] = row('dlg_1');
    cancelResult = row('dlg_1', 'cancelled');
    await delegations.cancel('dlg_1');
    expect(delegations.byId['dlg_1']?.status).toBe('cancelled');
    cancelResult = null;
    await delegations.cancel('dlg_2');
    expect(delegations.byId['dlg_2']).toBeUndefined();
  });
});
