import { describe, expect, it } from 'vitest';
import {
  createMemoryIdbKvFactory,
  type IdbKvDatabase,
  type IdbKvFactory,
} from '$lib/persist/idb-kv';
import { ChatDisplayState, openNoticeReadKv } from './chat-display.svelte';

/**
 * 通知已读游标的 IndexedDB 集成（经 lib/persist/idb-kv 通用封装）：node 单测
 * 跑在内存替身上，钉住「推进落盘 → 新实例启动载入恢复」与坏值丢弃。
 */

/** 落盘 / 载入是异步的（fire-and-forget）；多轮微任务把写链冲到底。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function stateOn(kv: IdbKvFactory): ChatDisplayState {
  return new ChatDisplayState(openNoticeReadKv(kv));
}

describe('通知已读游标持久化（IndexedDB）', () => {
  it('advance 落盘，新实例启动载入恢复；游标只进不退', async () => {
    const kv = createMemoryIdbKvFactory();
    const first = stateOn(kv);
    await settle();
    first.advanceNoticeReadThrough('local', 'conv_1', 20);
    first.advanceNoticeReadThrough('local', 'conv_2', 5);
    await settle();
    // 更小的 seq 不回退游标、也不写盘。
    first.advanceNoticeReadThrough('local', 'conv_1', 15);
    await settle();
    const second = stateOn(kv);
    await settle();
    expect(second.noticeReadThrough('local', 'conv_1')).toBe(20);
    expect(second.noticeReadThrough('local', 'conv_2')).toBe(5);
    // 没记录的会话 = 0（窗口内全部未读——存量数据即此待遇）；键带来源。
    expect(second.noticeReadThrough('local', 'conv_3')).toBe(0);
    expect(second.noticeReadThrough('team_a', 'conv_1')).toBe(0);
  });

  it('坏值丢弃：非数字 / 非有限 / 负数当没存过', async () => {
    const kv = createMemoryIdbKvFactory();
    const db = await openNoticeReadKv(kv);
    const store = db?.store('notice-read-through');
    await store?.put('local:conv_ok', 20);
    await store?.put('local:conv_text', 'x');
    await store?.put('local:conv_negative', -1);
    await store?.put('local:conv_nan', Number.NaN);
    const state = stateOn(kv);
    await settle();
    expect(state.noticeReadThrough('local', 'conv_ok')).toBe(20);
    expect(state.noticeReadThrough('local', 'conv_text')).toBe(0);
    expect(state.noticeReadThrough('local', 'conv_negative')).toBe(0);
    expect(state.noticeReadThrough('local', 'conv_nan')).toBe(0);
  });

  it('IndexedDB 缺席（null 库）只留内存态，不抛错', async () => {
    const state = new ChatDisplayState(null);
    await settle();
    state.advanceNoticeReadThrough('local', 'conv_1', 7);
    await settle();
    expect(state.noticeReadThrough('local', 'conv_1')).toBe(7);
  });

  it('未载入完成前不推进游标（+∞ 兜底期，防止把没显示过的未读标成已读）', async () => {
    let resolveDb!: (db: IdbKvDatabase) => void;
    const deferred = new Promise<IdbKvDatabase>((resolve) => {
      resolveDb = resolve;
    });
    const kv = createMemoryIdbKvFactory();
    const state = new ChatDisplayState(deferred);
    // 未载入：读取为 +∞（未勾选类目暂按已读兜底），advance 被门控不落任何值。
    expect(state.noticeReadThrough('local', 'conv_1')).toBe(Number.POSITIVE_INFINITY);
    state.advanceNoticeReadThrough('local', 'conv_1', 20);
    await settle();
    const db = await openNoticeReadKv(kv);
    resolveDb(db as IdbKvDatabase);
    await settle();
    // 载入完成：游标仍是 0（载入前的推进被门控丢弃），读取回到正常口径。
    expect(state.noticeReadThrough('local', 'conv_1')).toBe(0);
    // 载入后的推进恢复正常。
    state.advanceNoticeReadThrough('local', 'conv_1', 20);
    await settle();
    expect(state.noticeReadThrough('local', 'conv_1')).toBe(20);
  });
});
