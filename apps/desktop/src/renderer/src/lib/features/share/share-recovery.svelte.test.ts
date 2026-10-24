import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareFailedItem } from '@kepcup/shared';

/**
 * 分享失败恢复（D94 §8.1）：面板的状态与动作。
 * 真实的 Svelte 响应式运行时（desktop-svelte 项目）。
 */

const calls: Array<{ method: string; params: unknown }> = [];
const handlers = new Map<string, Set<(payload: unknown) => void>>();
let listResult: ShareFailedItem[] = [];
let retryState = 'done';
let failRetry = false;
let failDiscard = false;

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
        case 'share.failed.list':
          return { items: listResult };
        case 'share.failed.retry':
          if (failRetry) throw new Error('boom');
          return { state: retryState };
        case 'share.failed.discard':
          if (failDiscard) throw new Error('boom');
          return { ok: true };
        default:
          return {};
      }
    },
  },
}));

const { ShareRecoveryState } = await import('./share-recovery.svelte');

const emit = (event: string, payload: unknown = {}): void => {
  for (const handler of handlers.get(event) ?? []) handler(payload);
};

const item = (overrides: Partial<ShareFailedItem> = {}): ShareFailedItem => ({
  intakeId: 'shr_abcdefgh',
  createdAt: 1,
  expiresAt: 2,
  errorCode: 'SHARE_TARGET_NOT_FOUND',
  errorMessage: '目标已删除',
  target: { kind: 'bot', id: 'bot_x' },
  files: [{ originalName: 'a.zip', size: 10, mime: 'application/zip' }],
  ...overrides,
});

beforeEach(() => {
  calls.length = 0;
  handlers.clear();
  listResult = [];
  retryState = 'done';
  failRetry = false;
  failDiscard = false;
});

describe('ShareRecoveryState', () => {
  it('refresh 拉失败列表', async () => {
    listResult = [item()];
    const state = new ShareRecoveryState();
    await state.refresh();
    const listCall = calls.filter((c) => c.method === 'share.failed.list');
    expect(listCall).toHaveLength(1);
    // 入参必须是 {}：schema 是 z.object({})，缺参会整包被拒（回归锁）。
    expect(listCall[0]?.params).toEqual({});
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.intakeId).toBe('shr_abcdefgh');
  });

  it('start 订阅 share.failed.changed 并重拉列表', async () => {
    const state = new ShareRecoveryState();
    state.start();
    await state.refresh();
    const before = calls.filter((c) => c.method === 'share.failed.list').length;
    listResult = [item()];
    emit('share.failed.changed', { intakeId: 'shr_abcdefgh', state: 'failed' });
    await Promise.resolve();
    flushSync();
    expect(calls.filter((c) => c.method === 'share.failed.list').length).toBe(before + 1);
  });

  it('retry 带新目标，成功后收起重选块', async () => {
    const state = new ShareRecoveryState();
    state.reselecting = 'shr_abcdefgh';
    const result = await state.retry('shr_abcdefgh', { kind: 'bot', id: 'bot_y' });
    expect(result).toBe('done');
    const call = calls.find((c) => c.method === 'share.failed.retry');
    expect(call?.params).toEqual({
      intakeId: 'shr_abcdefgh',
      target: { kind: 'bot', id: 'bot_y' },
    });
    expect(state.reselecting).toBeNull();
  });

  it('retry 失败（目标仍无效）返回 failed', async () => {
    retryState = 'failed_target';
    const state = new ShareRecoveryState();
    const result = await state.retry('shr_abcdefgh', { kind: 'bot', id: 'bot_y' });
    expect(result).toBe('failed');
  });

  it('retry 抛错不崩，返回 failed', async () => {
    failRetry = true;
    const state = new ShareRecoveryState();
    const result = await state.retry('shr_abcdefgh', { kind: 'bot', id: 'bot_y' });
    expect(result).toBe('failed');
    expect(state.busyId).toBeNull();
  });

  it('discard 调 core 并刷新列表', async () => {
    const state = new ShareRecoveryState();
    const ok = await state.discard('shr_abcdefgh');
    expect(ok).toBe(true);
    expect(calls.find((c) => c.method === 'share.failed.discard')?.params).toEqual({
      intakeId: 'shr_abcdefgh',
    });
  });

  it('discard 抛错返回 false', async () => {
    failDiscard = true;
    const state = new ShareRecoveryState();
    expect(await state.discard('shr_abcdefgh')).toBe(false);
  });

  it('toggleReselect 开合重选块并清空搜索词', () => {
    const state = new ShareRecoveryState();
    state.query = 'x';
    state.toggleReselect('shr_abcdefgh');
    expect(state.reselecting).toBe('shr_abcdefgh');
    expect(state.query).toBe('');
    state.toggleReselect('shr_abcdefgh');
    expect(state.reselecting).toBeNull();
  });
});
