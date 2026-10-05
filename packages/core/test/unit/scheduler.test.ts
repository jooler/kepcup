import { describe, expect, it } from 'vitest';

import { Scheduler } from '../../src/scheduler/scheduler.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('scheduler condition not met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Scheduler #drain', () => {
  it('starts a lower-priority job for another provider instead of blocking on the queue head', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const started: string[] = [];
    const blocker = deferred();

    scheduler.submit({
      priority: 0,
      provider: 'a',
      key: 'a:1',
      run: async () => {
        started.push('a:1');
        await blocker.promise;
      },
    });
    await waitUntil(() => started.includes('a:1'));

    // Queue head: provider a (blocked — a's concurrency is 1), then provider b.
    scheduler.submit({ priority: 0, provider: 'a', key: 'a:2', run: async () => void started.push('a:2') });
    scheduler.submit({ priority: 0, provider: 'b', key: 'b:1', run: async () => void started.push('b:1') });

    await waitUntil(() => started.includes('b:1')); // BR-P01-003: b must not starve
    expect(started).not.toContain('a:2');

    blocker.release();
    await waitUntil(() => started.includes('a:2'));
    scheduler.stop();
  });

  it('keeps priority order when a slot frees up', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const started: string[] = [];
    const blocker = deferred();

    scheduler.submit({
      priority: 1,
      provider: 'a',
      key: 'first',
      run: async () => {
        started.push('first');
        await blocker.promise;
      },
    });
    await waitUntil(() => started.includes('first'));
    scheduler.submit({ priority: 2, provider: 'a', key: 'bg', run: async () => void started.push('bg') });
    scheduler.submit({ priority: 0, provider: 'a', key: 'user', run: async () => void started.push('user') });

    blocker.release();
    await waitUntil(() => started.includes('bg'));
    expect(started.indexOf('user')).toBeLessThan(started.indexOf('bg'));
    scheduler.stop();
  });

  it('launches every startable job within capacity in a single drain', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 4 });
    const started: string[] = [];
    const blocker = deferred();

    for (const key of ['j1', 'j2', 'j3']) {
      scheduler.submit({
        priority: 0,
        provider: 'a',
        key,
        run: async () => {
          started.push(key);
          await blocker.promise;
        },
      });
    }
    await waitUntil(() => started.length === 3);
    blocker.release();
    scheduler.stop();
  });
});
