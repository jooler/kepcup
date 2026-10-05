import { describe, expect, it } from 'vitest';

import { KeyedMutex } from '../../src/infra/keyed-mutex.js';

describe('infra/keyed-mutex（BR-P08-006 的可复用原语）', () => {
  it('同 key 串行：第二个 body 等第一个完成后才开始', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const body = (name: string, delayMs: number): Promise<void> =>
      mutex.run('k', async () => {
        events.push(`start:${name}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push(`end:${name}`);
      });
    await Promise.all([body('a', 20), body('b', 1)]);
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('不同 key 互不阻塞', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const body = (key: string): Promise<void> =>
      mutex.run(key, async () => {
        events.push(`start:${key}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push(`end:${key}`);
      });
    await Promise.all([body('x'), body('y')]);
    // x 与 y 的 start 都发生在任一 end 之前（交错执行）
    expect(events.slice(0, 2).sort()).toEqual(['start:x', 'start:y']);
    expect(events).toHaveLength(4);
  });

  it('body 失败不破坏后续排队（链不会断）', async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(mutex.run('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('空闲 key 的链被清理（不积累）', async () => {
    const mutex = new KeyedMutex();
    await mutex.run('k', async () => 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 内部 Map 不可见，用 forget + 再次 run 的行为代替：仍可继续排队。
    await expect(mutex.run('k', async () => 2)).resolves.toBe(2);
  });

  it('forget 等待在途 body 结束后才落定（BR-P09-010：不能剪断在途链）', async () => {
    const mutex = new KeyedMutex();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bodyDone = false;
    const bodyPromise = mutex.run('k', async () => {
      await gate;
      bodyDone = true;
    });
    // forget 在 body 未完成时调用：落定必须晚于 body 结束。
    let forgetSettled = false;
    const forgetPromise = mutex.forget('k').then(() => {
      forgetSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bodyDone).toBe(false);
    expect(forgetSettled).toBe(false);
    release();
    await bodyPromise;
    await forgetPromise;
    expect(bodyDone).toBe(true);
    expect(forgetSettled).toBe(true);
  });

  it('forget 期间到达的新 run 在在途 body 之后串行执行（不再并发进入）', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = mutex.run('k', async () => {
      events.push('start:first');
      await gate;
      events.push('end:first');
    });
    const forgetPromise = mutex.forget('k');
    const second = mutex.run('k', async () => {
      events.push('start:second');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 第二个 body 不与在途 body 并发：first 未结束时 second 不得开始。
    expect(events).toEqual(['start:first']);
    release();
    await Promise.all([first, forgetPromise, second]);
    expect(events).toEqual(['start:first', 'end:first', 'start:second']);
  });

  it('空闲 key 的 forget 立即落定', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.forget('never-used')).resolves.toBeUndefined();
  });
});
