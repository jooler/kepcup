import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Episode } from '@kepcup/shared';

/**
 * 协作回合 store（D92 T1a WP8）：episode.updated 事件写入 byId、pausedCount
 * 按「该会话 + paused」计数、resume / stop 成功后写入新状态、失败不改状态
 * （只 toast）。在真实的 Svelte 运行时里跑（desktop-svelte 项目），RPC 层
 * 全部 mock，与 app-detail.svelte.test.ts 同一套写法。
 */

const handlers = new Map<string, (payload: unknown) => void>();
let nextEpisode: Episode | null = null;
let failNext = false;
const toasts: string[] = [];

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => undefined;
    },
    call: async (method: string, input: unknown) => {
      if (method === 'episodes.get') {
        if (failNext) throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' });
        if (nextEpisode === null || nextEpisode.id !== (input as { id: string }).id) {
          throw Object.assign(new Error('no row'), { code: 'NOT_FOUND' });
        }
        return { episode: nextEpisode };
      }
      if (method === 'episodes.resume' || method === 'episodes.stop') {
        if (failNext) throw Object.assign(new Error('boom'), { code: 'INTERNAL' });
        if (nextEpisode === null) throw Object.assign(new Error('no row'), { code: 'NOT_FOUND' });
        return { episode: nextEpisode };
      }
      return {};
    },
  },
}));

vi.mock('svelte-sonner', () => ({
  toast: { error: (message: string) => void toasts.push(message) },
}));

const { episodes } = await import('./episodes.svelte');

function episode(partial: Partial<Episode> & { id: string }): Episode {
  return {
    conversationId: 'conv_1',
    status: 'paused',
    hops: 2,
    pausedAt: 1,
    pendingCount: 1,
    createdAt: 1,
    ...partial,
  };
}

const emit = (payload: { episode: Episode }): void => {
  handlers.get('episode.updated')!(payload);
};

beforeEach(() => {
  nextEpisode = null;
  failNext = false;
  toasts.length = 0;
  episodes.byId = {};
  // 注册 episode.updated 订阅（幂等；handlers 由 mock 的 onEvent 收集）。
  episodes.start();
});

describe('episodes store: 事件写入与 pausedCount', () => {
  it('episode.updated 事件把回合写入 byId（同 id 覆盖）', () => {
    emit({ episode: episode({ id: 'epi_1' }) });
    expect(episodes.byId['epi_1']?.status).toBe('paused');
    emit({ episode: episode({ id: 'epi_1', status: 'active', pendingCount: 0 }) });
    expect(episodes.byId['epi_1']?.status).toBe('active');
    expect(Object.keys(episodes.byId)).toHaveLength(1);
  });

  it('pausedCount 只计该会话暂停中的回合', () => {
    emit({ episode: episode({ id: 'epi_1' }) });
    emit({ episode: episode({ id: 'epi_2', conversationId: 'conv_2' }) });
    emit({ episode: episode({ id: 'epi_3', status: 'stopped' }) });
    expect(episodes.pausedCount('conv_1')).toBe(1);
    expect(episodes.pausedCount('conv_2')).toBe(1);
    expect(episodes.pausedCount('conv_3')).toBe(0);
    expect(episodes.pausedCount(null)).toBe(0);
    expect(episodes.pausedCount(undefined)).toBe(0);
  });
});

describe('episodes store: load / resume / stop', () => {
  it('load 成功写入；找不到（NOT_FOUND）静默忽略、不写入', async () => {
    nextEpisode = episode({ id: 'epi_1' });
    await episodes.load('epi_1');
    expect(episodes.byId['epi_1']?.id).toBe('epi_1');

    nextEpisode = null;
    await episodes.load('epi_9');
    expect(episodes.byId['epi_9']).toBeUndefined();
  });

  it('resume 成功后写入 active 状态', async () => {
    emit({ episode: episode({ id: 'epi_1' }) });
    nextEpisode = episode({ id: 'epi_1', status: 'active', pendingCount: 0, pausedAt: null });
    await episodes.resume('epi_1');
    expect(episodes.byId['epi_1']?.status).toBe('active');
    expect(episodes.pausedCount('conv_1')).toBe(0);
  });

  it('stop 成功后写入 stopped 状态', async () => {
    emit({ episode: episode({ id: 'epi_1' }) });
    nextEpisode = episode({ id: 'epi_1', status: 'stopped', pendingCount: 0, pausedAt: null });
    await episodes.stop('epi_1');
    expect(episodes.byId['epi_1']?.status).toBe('stopped');
  });

  it('失败不改状态，只 toast', async () => {
    emit({ episode: episode({ id: 'epi_1' }) });
    failNext = true;
    await episodes.resume('epi_1');
    expect(episodes.byId['epi_1']?.status).toBe('paused');
    expect(toasts).toHaveLength(1);
    await episodes.stop('epi_1');
    expect(episodes.byId['epi_1']?.status).toBe('paused');
    expect(toasts).toHaveLength(2);
  });
});
