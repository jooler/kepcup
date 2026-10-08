import { describe, expect, it } from 'vitest';

import { LeaseService } from '../../src/project/lease.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { SlotYieldingLeaseService } from '../../src/scheduler/slot-yielding-lease.js';

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

describe('Scheduler agent slots (D72 P6 审查 C1)', () => {
  // Agents with parallel sessions: the override is the limit (start.ts wires
  // `agentConcurrency()` over the catalog).
  const parallel = {
    agentConcurrency: (id: string, config: Readonly<Record<string, number | undefined>>) =>
      config[`agent:${id}`] ?? 2,
  };
  it('background jobs on agent:* keep one slot free for responses', async () => {
    const scheduler = new Scheduler(logger, parallel);
    scheduler.setConcurrency({ default: 4, 'agent:a': 2 });
    const started: string[] = [];
    const hold = deferred();
    const job = (priority: 0 | 2, provider: string, key: string) =>
      scheduler.submit({
        priority,
        provider,
        key,
        run: async () => {
          started.push(key);
          await hold.promise;
        },
      });
    job(2, 'agent:a', 'bg1');
    job(2, 'agent:a', 'bg2');
    await waitUntil(() => started.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    // The second background job waits (2 - 1 slots for background) although
    // the global background-loop cap would allow it.
    expect(started).toEqual(['bg1']);
    job(0, 'agent:a', 'user');
    await waitUntil(() => started.includes('user'));
    // Another provider's background job may take the second global slot.
    job(2, 'p', 'p1');
    await waitUntil(() => started.includes('p1'));
    expect(started).not.toContain('bg2');
    hold.release();
    await waitUntil(() => started.includes('bg2'));
    scheduler.stop();
  });

  it('a limit of 1 reserves nothing (a queued job still runs)', async () => {
    const scheduler = new Scheduler(logger, parallel);
    scheduler.setConcurrency({ default: 4, 'agent:a': 1 });
    let ran = false;
    scheduler.submit({
      priority: 2,
      provider: 'agent:a',
      key: 'bg',
      run: async () => {
        ran = true;
      },
    });
    await waitUntil(() => ran);
  });
  it('D75 task jobs keep one provider slot free for conversation replies', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 3 });
    const started: string[] = [];
    const blockers = [deferred(), deferred(), deferred()];
    for (const [index, blocker] of blockers.entries()) {
      scheduler.submit({
        priority: 1,
        provider: 'p',
        key: `task:t${index}`,
        run: async () => {
          started.push(`task:t${index}`);
          await blocker.promise;
        },
      });
    }
    await waitUntil(() => started.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual(['task:t0', 'task:t1']); // the third slot stays free
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'bot:conv',
      run: async () => void started.push('reply'),
    });
    await waitUntil(() => started.includes('reply'));
    blockers[0]!.release();
    await waitUntil(() => started.includes('task:t2'));
    for (const blocker of blockers) blocker.release();
    scheduler.stop();
  });
});

describe('Scheduler × write leases: no hold-and-wait (D75 审查 H2)', () => {
  const key = '/proj';
  const identity = (runId: string) => ({ runId, botId: 'b', conversationId: 'c', loopType: 'turn' as const });

  /**
   * The reviewed deadlock: a write task T took the project lease and queues
   * for a slot; a response run R holds the slot and then waits for the lease.
   */
  async function contend(limit: number, leases: LeaseService, scheduler: Scheduler) {
    scheduler.setConcurrency({ default: limit });
    const order: string[] = [];
    const rStarted = deferred();
    const rMayWrite = deferred();
    let rDone = false;
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'bot:conv-b',
      runId: 'run_r',
      run: async () => {
        rStarted.release();
        await rMayWrite.promise;
        order.push('r-waits');
        await leases.acquire(identity('run_r'), key);
        order.push('r-has-lease');
        leases.release('run_r');
        rDone = true;
      },
    });
    await rStarted.promise;
    // T: lease first (outside any slot, like #startTask), then its job.
    await leases.acquire(identity('task_t'), key);
    let tDone = false;
    scheduler.submit({
      priority: 1,
      provider: 'p',
      key: 'task:task_t',
      runId: 'task_t',
      run: async () => {
        order.push('t-runs');
        leases.release('task_t');
        tDone = true;
      },
    });
    rMayWrite.release();
    await waitUntil(() => rDone && tDone, 2_000);
    return order;
  }

  for (const limit of [1, 2]) {
    it(`provider limit ${limit}: the waiting run yields its slot, the task runs, then the run resumes`, async () => {
      const scheduler = new Scheduler(logger);
      const leases = new SlotYieldingLeaseService();
      leases.attachScheduler(scheduler);
      expect(await contend(limit, leases, scheduler)).toEqual(['r-waits', 't-runs', 'r-has-lease']);
      scheduler.stop();
    });

    it(`provider limit ${limit}: without the yield the same schedule deadlocks (reproduction)`, async () => {
      const scheduler = new Scheduler(logger);
      await expect(contend(limit, new LeaseService(), scheduler)).rejects.toThrow(
        'scheduler condition not met',
      );
      scheduler.stop();
    });
  }

  it('a lease granted at once keeps the slot; a wait of another run (not the job’s) does not yield', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const leases = new SlotYieldingLeaseService();
    leases.attachScheduler(scheduler);
    const started: string[] = [];
    const hold = deferred();
    await leases.acquire(identity('holder'), key);
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'a',
      runId: 'run_a',
      run: async () => {
        started.push('a');
        await leases.acquire(identity('run_a'), '/other'); // immediate: no yield
        // A wait by some other run inside this job's async context: no yield.
        void leases.acquire(identity('run_x'), key);
        await hold.promise;
      },
    });
    scheduler.submit({ priority: 0, provider: 'p', key: 'b', run: async () => void started.push('b') });
    await waitUntil(() => started.includes('a'));
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toEqual(['a']);
    hold.release();
    await waitUntil(() => started.includes('b'));
    leases.release('holder');
    scheduler.stop();
  });

  it('a yielded job resumes ahead of queued jobs once its lease is granted', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const leases = new SlotYieldingLeaseService();
    leases.attachScheduler(scheduler);
    const events: string[] = [];
    const holdOther = deferred();
    await leases.acquire(identity('holder'), key);
    scheduler.submit({
      priority: 1,
      provider: 'p',
      key: 'r',
      runId: 'run_r',
      run: async () => {
        await leases.acquire(identity('run_r'), key);
        events.push('r-resumed');
      },
    });
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'other',
      run: async () => {
        events.push('other');
        await holdOther.promise;
      },
    });
    // r yielded its slot: the queued job runs meanwhile.
    await waitUntil(() => events.includes('other'));
    scheduler.submit({ priority: 0, provider: 'p', key: 'late', run: async () => void events.push('late') });
    leases.release('holder'); // r's lease granted; it waits for the slot …
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['other']);
    holdOther.release(); // … and takes it before the queued job.
    await waitUntil(() => events.includes('late'));
    expect(events).toEqual(['other', 'r-resumed', 'late']);
    scheduler.stop();
  });

  it('cancelQueued removes a job that has not started (its signal aborts)', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const hold = deferred();
    let ran = false;
    scheduler.submit({ priority: 0, provider: 'p', key: 'busy', run: () => hold.promise });
    scheduler.submit({ priority: 1, provider: 'p', key: 'task:t', run: async () => void (ran = true) });
    expect(scheduler.pendingForKey('task:t')).toBe(1);
    expect(scheduler.cancelQueued('task:t')).toBe(true);
    expect(scheduler.pendingForKey('task:t')).toBe(0);
    expect(scheduler.cancelQueued('busy')).toBe(false); // already running
    hold.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(false);
    scheduler.stop();
  });
});

describe('Scheduler: tasks never starve conversation replies (D75 审查 M3)', () => {
  it('provider limit 1: a reply borrows one slot while a task holds the only one', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const started: string[] = [];
    const task = deferred();
    const reply = deferred();
    scheduler.submit({
      priority: 1,
      provider: 'p',
      key: 'task:long',
      run: async () => {
        started.push('task');
        await task.promise;
      },
    });
    await waitUntil(() => started.includes('task'));
    const job = (priority: 0 | 1, name: string, wait?: Promise<void>) =>
      scheduler.submit({
        priority,
        provider: 'p',
        key: name,
        run: async () => {
          started.push(name);
          if (wait) await wait;
        },
      });
    job(1, 'scheduled'); // priority 1 does not borrow
    job(0, 'reply-1', reply.promise);
    await waitUntil(() => started.includes('reply-1'));
    job(0, 'reply-2'); // the borrowed slot is taken: no second borrow
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toEqual(['task', 'reply-1']);
    reply.release();
    await waitUntil(() => started.includes('reply-2'));
    expect(started).not.toContain('scheduled');
    task.release();
    await waitUntil(() => started.includes('scheduled'));
    scheduler.stop();
  });

  it('no borrowing while a non-task job holds a slot', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const started: string[] = [];
    const hold = deferred();
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'reply-a',
      run: async () => {
        started.push('reply-a');
        await hold.promise;
      },
    });
    scheduler.submit({ priority: 0, provider: 'p', key: 'reply-b', run: async () => void started.push('reply-b') });
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toEqual(['reply-a']);
    hold.release();
    await waitUntil(() => started.includes('reply-b'));
    scheduler.stop();
  });
});

describe('Scheduler round 2 (D75 审查复核 #1 #3 #4 #7)', () => {
  it('#1 parallel waits of one job: the slot comes back only when the last wait ends', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const a = deferred();
    const b = deferred();
    const events: string[] = [];
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'j',
      runId: 'run_j',
      run: async () => {
        await Promise.all([
          scheduler.yieldSlotWhile('run_j', a.promise).then(() => events.push('a-done')),
          scheduler.yieldSlotWhile('run_j', b.promise).then(() => events.push('b-done')),
        ]);
        events.push('j-done');
      },
    });
    a.release();
    await waitUntil(() => events.includes('a-done'));
    // b still waits: the job must not hold the slot — the job that ends b's wait can run.
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'l',
      run: async () => {
        events.push('l');
        b.release();
      },
    });
    await waitUntil(() => events.includes('j-done'), 1_000);
    expect(events).toEqual(['a-done', 'l', 'b-done', 'j-done']);
    scheduler.stop();
  });

  it('#3 a job that ends before its yielded wait does not leak a slot', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const late = deferred();
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'j',
      runId: 'run_j',
      run: async () => {
        void scheduler.yieldSlotWhile('run_j', late.promise);
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    late.release();
    await new Promise((r) => setTimeout(r, 10));
    let ran = false;
    scheduler.submit({ priority: 0, provider: 'p', key: 'next', run: async () => void (ran = true) });
    await waitUntil(() => ran, 1_000);
    scheduler.stop();
  });

  it('#7 a job whose run throws synchronously releases its slot', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    expect(() =>
      scheduler.submit({
        priority: 0,
        provider: 'p',
        key: 'boom',
        run: () => {
          throw new Error('sync boom');
        },
      }),
    ).not.toThrow();
    let ran = false;
    scheduler.submit({ priority: 0, provider: 'p', key: 'next', run: async () => void (ran = true) });
    await waitUntil(() => ran, 1_000);
    scheduler.stop();
  });

  it('#4 a task job holding its lease starts under the plain limit; tasks never borrow', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 2 });
    const started: string[] = [];
    const hold = deferred();
    const job = (key: string, priority: 0 | 1, leaseHeld?: boolean) =>
      scheduler.submit({
        priority,
        provider: 'p',
        key,
        ...(leaseHeld ? { leaseHeld } : {}),
        run: async () => {
          started.push(key);
          await hold.promise;
        },
      });
    job('reply', 0);
    job('task:read', 1); // keeps a slot free for replies: waits
    job('task:write', 0, true); // holds its lease: may take the last slot
    await waitUntil(() => started.includes('task:write'));
    job('task:write2', 0, true); // every slot taken: a task never borrows
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toEqual(['reply', 'task:write']);
    hold.release();
    await waitUntil(() => started.length === 4);
    scheduler.stop();
  });

  it('#4 lease-holding write tasks still leave one slot to replies among tasks', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 2 });
    const started: string[] = [];
    const hold = deferred();
    const job = (key: string, priority: 0 | 1, leaseHeld?: boolean) =>
      scheduler.submit({
        priority,
        provider: 'p',
        key,
        ...(leaseHeld ? { leaseHeld } : {}),
        run: async () => {
          started.push(key);
          await hold.promise;
        },
      });
    job('task:w1', 0, true);
    await waitUntil(() => started.includes('task:w1'));
    job('task:w2', 0, true); // a slot is free, but it is the replies' one
    job('reply', 1);
    await waitUntil(() => started.includes('reply'));
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toEqual(['task:w1', 'reply']);
    hold.release();
    await waitUntil(() => started.length === 3);
    scheduler.stop();
  });
});

describe('Scheduler: a stopped run never takes its slot back (D75 审查 M-1)', () => {
  function rejectable(): { promise: Promise<void>; reject: (error: Error) => void } {
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((_, rej) => {
      reject = rej;
    });
    return { promise, reject };
  }

  it('a rejected wait unwinds without a slot while another job holds it; counts stay exact', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const events: string[] = [];
    const wait = rejectable();
    const jEnd = deferred();
    const bHold = deferred();
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'task:j',
      runId: 'run_j',
      run: async () => {
        try {
          await scheduler.yieldSlotWhile('run_j', wait.promise);
        } catch {
          events.push('j-unwound');
        }
        await jEnd.promise;
        events.push('j-done');
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    // J waits slotless: B takes the only slot and keeps it.
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'b',
      run: async () => {
        events.push('b');
        await bHold.promise;
      },
    });
    await waitUntil(() => events.includes('b'));
    wait.reject(new Error('task stopped'));
    // J unwinds at once — it does not queue behind B for a slot.
    await waitUntil(() => events.includes('j-unwound'), 1_000);
    jEnd.release();
    await waitUntil(() => events.includes('j-done'), 1_000);
    // J ended slotless: B still holds the only slot — no slot was freed twice.
    scheduler.submit({ priority: 0, provider: 'p', key: 'c', run: async () => void events.push('c') });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).not.toContain('c');
    bHold.release();
    await waitUntil(() => events.includes('c'), 1_000);
    // And the slot is usable again by a job yielding later.
    const late = deferred();
    let lateDone = false;
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'task:k',
      runId: 'run_k',
      run: async () => {
        await scheduler.yieldSlotWhile('run_k', late.promise);
        lateDone = true;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    late.release();
    await waitUntil(() => lateDone, 1_000);
    scheduler.stop();
  });

  it('an abort of the run while it waits to take the slot back lets it unwind slotless', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const events: string[] = [];
    const wait = deferred();
    const bHold = deferred();
    const controller = new AbortController();
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'task:j',
      runId: 'run_j',
      run: async () => {
        await scheduler.yieldSlotWhile('run_j', wait.promise, controller.signal);
        events.push('j-resumed');
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'b',
      run: async () => {
        events.push('b');
        await bHold.promise;
      },
    });
    await waitUntil(() => events.includes('b'));
    // The wait ends while B holds the slot: J queues to take it back …
    wait.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(events).not.toContain('j-resumed');
    // … until its run is aborted: then it goes on (and ends) without one.
    controller.abort();
    await waitUntil(() => events.includes('j-resumed'), 1_000);
    scheduler.submit({ priority: 0, provider: 'p', key: 'c', run: async () => void events.push('c') });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).not.toContain('c');
    bHold.release();
    await waitUntil(() => events.includes('c'), 1_000);
    scheduler.stop();
  });

  it('a wait settling after the run was aborted does not take a slot', async () => {
    const scheduler = new Scheduler(logger);
    scheduler.setConcurrency({ default: 1 });
    const events: string[] = [];
    const wait = deferred();
    const bHold = deferred();
    const controller = new AbortController();
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'task:j',
      runId: 'run_j',
      run: async () => {
        await scheduler.yieldSlotWhile('run_j', wait.promise, controller.signal);
        events.push('j-resumed');
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    scheduler.submit({
      priority: 0,
      provider: 'p',
      key: 'b',
      run: async () => {
        events.push('b');
        await bHold.promise;
      },
    });
    await waitUntil(() => events.includes('b'));
    controller.abort();
    wait.release();
    await waitUntil(() => events.includes('j-resumed'), 1_000);
    bHold.release();
    scheduler.stop();
  });
});

describe('Scheduler × external-agent tasks (D75 W4, design 30 §8.1 / §8.5)', () => {
  const resolver = (limit: number) => ({ agentConcurrency: () => limit });

  function harness(limit: number) {
    const scheduler = new Scheduler(logger, resolver(limit));
    scheduler.setConcurrency({ default: 4 });
    const started: string[] = [];
    const hold = deferred();
    const job = (key: string, priority: 0 | 1 | 2) =>
      scheduler.submit({
        priority,
        provider: 'agent:a',
        key,
        run: async () => {
          started.push(key);
          await hold.promise;
        },
      });
    return { scheduler, started, hold, job };
  }

  it('tasks on an agent may use all of its slots (replies run on the built-in engine)', async () => {
    const { scheduler, started, hold, job } = harness(2);
    job('task:t1', 1);
    job('task:t2', 1);
    await waitUntil(() => started.length === 2);
    expect(started).toEqual(['task:t1', 'task:t2']);
    // A background loop still keeps one slot free (here: none free at all).
    job('bg', 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(started).not.toContain('bg');
    hold.release();
    await waitUntil(() => started.includes('bg'));
    scheduler.stop();
  });

  it('nothing borrows past an agent limit: without parallel sessions one prompt at a time', async () => {
    const { scheduler, started, hold, job } = harness(1);
    job('task:t1', 1);
    await waitUntil(() => started.includes('task:t1'));
    job('bot:conv', 0); // a reply would borrow on a model provider (M3), never here
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toEqual(['task:t1']);
    hold.release();
    await waitUntil(() => started.includes('bot:conv'));
    scheduler.stop();
  });
});
