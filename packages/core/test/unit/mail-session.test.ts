import { describe, expect, it, afterEach, vi } from 'vitest';
import { AppError, type MailListen } from '@kepcup/shared';
import type { CoreLogger } from '../../src/infra/logger.js';
import type { FetchedMail, MailboxState } from '../../src/mail/message.js';
import { MailSessionHub, type MailFailureInfo } from '../../src/mail/session.js';
import type { MailAccountRecord } from '../../src/mail/store.js';
import { MockImap, deferred, sleep, until } from '../support/mock-mail-imap.js';

/**
 * 会话层（D84 复审修复）：失败计数、认证失败停止重试、工具调用与 IDLE 的并发、
 * 停止后迟到的回调、连接级错误打断等待。用脚本化的 MailImap，不碰网络。
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as CoreLogger;

function account(overrides: Partial<MailAccountRecord> = {}): MailAccountRecord {
  return {
    id: 'mal_test',
    address: 'bot@example.com',
    label: 'test',
    provider: 'custom',
    imapHost: '127.0.0.1',
    imapPort: 993,
    imapSecure: 'ssl',
    smtpHost: '127.0.0.1',
    smtpPort: 465,
    smtpSecure: 'ssl',
    username: 'bot@example.com',
    mode: 'auto',
    pollIntervalSec: 3600,
    status: 'idle',
    listen: null,
    lastUid: 5,
    uidValidity: 1,
    unseenCount: null,
    lastError: null,
    lastOkAt: null,
    failureStreak: 0,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides,
  };
}

interface Harness {
  hub: MailSessionHub;
  record: MailAccountRecord;
  opens: number;
  ready: Array<{ listen: MailListen; mailbox: MailboxState }>;
  messages: FetchedMail[][];
  failures: Array<{ error: string; streak: number; info: MailFailureInfo }>;
  clients: MockImap[];
  /** 每次调用退避函数时收到的入参（streak + flaps）。 */
  backoffArgs: number[];
  /** 每次 open 调用前取下一个脚本；返回 Error 即 open 失败。 */
  script: Array<() => MockImap | Error>;
}

const hubs: MailSessionHub[] = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.stopAll();
});

function harness(overrides: Partial<MailAccountRecord> = {}): Harness {
  const h: Harness = {
    hub: undefined as unknown as MailSessionHub,
    record: account(overrides),
    opens: 0,
    ready: [],
    messages: [],
    failures: [],
    clients: [],
    backoffArgs: [],
    script: [],
  };
  h.hub = new MailSessionHub({
    open: async () => {
      h.opens += 1;
      const next = h.script.shift();
      const result = next === undefined ? new MockImap() : next();
      if (result instanceof Error) throw result;
      h.clients.push(result);
      return result;
    },
    load: () => h.record,
    password: () => 'secret',
    onReady: (_id, listen, mailbox) => h.ready.push({ listen, mailbox }),
    onMessages: (_id, messages) => h.messages.push(messages),
    onFailure: (_id, error, streak, info) => h.failures.push({ error, streak, info }),
    logger,
    backoffMs: (n) => {
      h.backoffArgs.push(n);
      return 5;
    },
  });
  hubs.push(h.hub);
  return h;
}

function authError(text = 'Invalid credentials'): Error {
  return Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
    responseText: text,
  });
}

/** imapflow 对任何 LOGIN 的 NO 都会设 authenticationFailed，没有 serverResponseCode 的版本。 */
function loginNo(text: string): Error {
  return Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: text });
}

describe('failure streak (review #2)', () => {
  it('clears the streak once the connection is ready, so a later drop starts at 1 again', async () => {
    const h = harness();
    const dropping = (): MockImap => {
      const client = new MockImap();
      client.idleImpl = async () => {
        throw new Error('connection reset');
      };
      return client;
    };
    // 先连不上两次（streak 1、2），然后连上又掉线三次：每次掉线都应该是 streak 1。
    h.script = [
      () => new Error('ECONNREFUSED'),
      () => new Error('ECONNREFUSED'),
      dropping,
      dropping,
      dropping,
    ];
    h.hub.start(h.record.id);
    await until(() => h.failures.length >= 5, 'five failures');
    expect(h.failures.slice(0, 5).map((failure) => failure.streak)).toEqual([1, 2, 1, 1, 1]);
    expect(h.failures.every((failure) => !failure.info.fatal)).toBe(true);
  });

  it('keeps counting while the connection never gets ready (SELECT keeps failing)', async () => {
    const h = harness();
    const failingSelect = (): MockImap => {
      const client = new MockImap();
      client.selectBarrier = Promise.reject(new Error('NO select failed'));
      client.selectBarrier.catch(() => undefined);
      return client;
    };
    h.script = [failingSelect, failingSelect, failingSelect];
    h.hub.start(h.record.id);
    await until(() => h.failures.length >= 3, 'three failures');
    expect(h.failures.slice(0, 3).map((failure) => failure.streak)).toEqual([1, 2, 3]);
  });
});

describe('flap penalty (round 2 #2)', () => {
  it('keeps the flap penalty across a failed connection attempt, and clears it only after a stable connection', async () => {
    let offset = 0;
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      const h = harness();
      const dropping = (afterMs: number): MockImap => {
        const client = new MockImap();
        client.idleImpl = async () => {
          offset += afterMs;
          throw new Error('connection reset');
        };
        return client;
      };
      h.script = [
        () => dropping(1_000), // 就绪后 1 秒掉线：flaps=1，退避入参 streak(1)+1
        () => new Error('ECONNREFUSED'), // 没连上：flaps 必须保持 1，不能回落
        () => dropping(1_000), // 又一次秒掉：flaps=2
        () => dropping(31_000), // 稳定 31 秒后掉线：flaps 清零
        () => new Error('ECONNREFUSED'),
      ];
      h.hub.start(h.record.id);
      // until() 用 Date.now 计超时，这里 Date.now 被拨快了，所以自己按次数轮询。
      for (let i = 0; i < 400 && h.backoffArgs.length < 5; i += 1) await sleep(5);
      // 入参 = streak + flaps：[掉线 1+1, 连接失败 2+1（旧实现 flaps 清零会是 2）, 掉线 1+2, 稳定后掉线 1+0, 连接失败 2+0]
      expect(h.backoffArgs.slice(0, 5)).toEqual([2, 3, 3, 1, 2]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('authentication failure (review #8)', () => {
  it('stops retrying after the server rejects the credentials, and a restart tries again', async () => {
    const h = harness();
    h.script = [() => authError(), () => authError()];
    h.hub.start(h.record.id);
    await until(() => h.failures.length >= 1, 'first failure');
    expect(h.failures[0]?.info.fatal).toBe(true);
    // 退避只有 5ms；如果没停，这段时间里早就又试了好几次。
    await sleep(150);
    expect(h.opens).toBe(1);
    expect(h.failures).toHaveLength(1);
    // 用户更新授权码后 restart：重新尝试。
    h.hub.restart(h.record.id);
    await until(() => h.failures.length >= 2, 'second failure');
    expect(h.opens).toBe(2);
  });

  it('keeps backing off (does not stop) when the server refuses because of throttling', async () => {
    const h = harness();
    h.script = [
      () => loginNo('Too many login attempts, try again later'),
      () => loginNo('login frequency limited'),
      () => new MockImap(),
    ];
    h.hub.start(h.record.id);
    await until(() => h.ready.length >= 1, 'ready after throttling');
    expect(h.failures.map((failure) => failure.info.fatal)).toEqual([false, false]);
  });

  it('stops on QQ-style wrong-password reply even though it also mentions frequency / busy (round 2 #1)', async () => {
    const h = harness();
    h.script = [
      () =>
        loginNo(
          'login fail. Account is abnormal, service is not open, password is incorrect, login frequency limited, or system is busy.',
        ),
      () => new MockImap(),
    ];
    h.hub.start(h.record.id);
    await until(() => h.failures.length >= 1, 'failure');
    expect(h.failures[0]?.info.fatal).toBe(true);
    await sleep(100);
    expect(h.opens).toBe(1);
  });

  it('gives up after three consecutive auth-like refusals even if the text keeps saying "try again later"', async () => {
    const h = harness();
    h.script = [
      () => loginNo('Login frequency limited, try again later'),
      () => loginNo('Login frequency limited, try again later'),
      () => loginNo('Login frequency limited, try again later'),
      () => new MockImap(),
    ];
    h.hub.start(h.record.id);
    await until(() => h.failures.length >= 3, 'three failures');
    expect(h.failures.map((failure) => failure.info.fatal)).toEqual([false, false, true]);
    await sleep(100);
    expect(h.opens).toBe(3);
    expect(h.ready).toHaveLength(0);
  });

  it('does not count a network error in between as consecutive, and a ready connection resets the count', async () => {
    const h = harness();
    h.script = [
      () => loginNo('try again later'),
      () => loginNo('try again later'),
      () => new MockImap(),
    ];
    h.hub.start(h.record.id);
    await until(() => h.ready.length >= 1, 'ready');
    expect(h.failures.map((failure) => failure.info.fatal)).toEqual([false, false]);
  });

  it('treats a missing stored password as fatal', async () => {
    const h = harness();
    const hub = new MailSessionHub({
      open: async () => {
        throw new Error('should not connect without a password');
      },
      load: () => h.record,
      password: () => null,
      onReady: () => undefined,
      onMessages: () => undefined,
      onFailure: (_id, error, streak, info) => h.failures.push({ error, streak, info }),
      logger,
      backoffMs: () => 5,
    });
    hubs.push(hub);
    hub.start(h.record.id);
    await until(() => h.failures.length >= 1, 'failure');
    expect(h.failures[0]?.info.fatal).toBe(true);
    await sleep(80);
    expect(h.failures).toHaveLength(1);
  });
});

describe('tool calls vs IDLE (review #10)', () => {
  it('does not park a second concurrent call behind an IDLE that starts after the first call began', async () => {
    const h = harness();
    const client = new MockImap();
    h.script = [() => client];
    h.hub.start(h.record.id);
    await until(() => client.idleCalls >= 1, 'first idle');

    // 让下一轮补拉停在 SEARCH 上，造出「调用到达时主循环正在补拉」的窗口。
    const searchGate = deferred();
    client.searchBarrier = searchGate.promise;
    h.hub.wake(h.record.id);
    await until(() => client.searchBarrier !== null && client.idleCalls === 1, 'catch-up started');
    await sleep(20);

    // 第一次调用排在补拉后面；补拉结束后主循环把 IDLE 排在它后面。
    const firstGate = deferred();
    const first = h.hub.use(h.record, async () => {
      await firstGate.promise;
      return 'first';
    });
    searchGate.resolve();
    client.searchBarrier = null;
    await sleep(30);

    // 第一次调用还在跑、IDLE 已排队时，第二次调用到达。
    const second = h.hub.use(h.record, async () => 'second');
    firstGate.resolve();
    await expect(first).resolves.toBe('first');
    // 旧实现：IDLE 读到的是 wake 之后换上的新信号，没人打断，second 要等到 IDLE 超时（这里的兜底是 2 秒）。
    const outcome = await Promise.race([second, sleep(600).then(() => 'timeout')]);
    expect(outcome).toBe('second');
  });

  it('runs two parallel calls (list + read style) without waiting for an IDLE timeout', async () => {
    const h = harness();
    const client = new MockImap();
    h.script = [() => client];
    h.hub.start(h.record.id);
    await until(() => client.idleCalls >= 1, 'idle');
    const started = Date.now();
    const results = await Promise.all([
      h.hub.use(h.record, async () => 'list'),
      h.hub.use(h.record, async () => 'read'),
    ]);
    expect(results).toEqual(['list', 'read']);
    expect(Date.now() - started).toBeLessThan(1000);
    // 调用结束后回到 IDLE。
    await until(() => client.idleCalls >= 2, 'back to idle');
  });
});

describe('late callbacks after stop (review #11)', () => {
  it('does not report ready when the account is stopped while SELECT is in flight', async () => {
    const h = harness();
    const client = new MockImap();
    const gate = deferred();
    client.selectBarrier = gate.promise;
    h.script = [() => client];
    h.hub.start(h.record.id);
    await until(() => h.opens === 1, 'opened');
    await sleep(20);
    h.hub.stop(h.record.id);
    gate.resolve();
    await sleep(50);
    expect(h.ready).toHaveLength(0);
    expect(client.closed).toBe(true);
    expect(h.messages).toHaveLength(0);
  });

  it('does not ingest mail fetched after the account was stopped', async () => {
    const h = harness();
    const client = new MockImap();
    client.searchResult = [6];
    const gate = deferred();
    client.fetchBarrier = gate.promise;
    client.fetchResult = [
      { uid: 6, from: 'a', to: [], subject: 's', date: '', text: 't', attachments: [] },
    ];
    h.script = [() => client];
    h.hub.start(h.record.id);
    await until(() => h.ready.length === 1, 'ready');
    await sleep(30);
    h.hub.stop(h.record.id);
    gate.resolve();
    await sleep(50);
    expect(h.messages).toHaveLength(0);
  });

  it('delivers fetched mail batch by batch while alive', async () => {
    const h = harness();
    const client = new MockImap();
    client.searchResult = Array.from({ length: 25 }, (_v, i) => 6 + i);
    client.fetchResult = [
      { uid: 6, from: 'a', to: [], subject: 's', date: '', text: 't', attachments: [] },
    ];
    h.script = [() => client];
    h.hub.start(h.record.id);
    await until(() => h.messages.length >= 2, 'two batches');
    h.hub.stop(h.record.id);
  });
});

describe('connection-level errors (review #1)', () => {
  it('reconnects promptly when the connection emits an error while the loop is waiting', async () => {
    // 轮询模式、间隔一小时：没有打断的话，循环要睡一小时才会发现连接早就断了。
    const h = harness({ mode: 'poll_only' });
    const first = new MockImap();
    h.script = [() => first];
    h.hub.start(h.record.id);
    await until(() => h.ready.length === 1, 'ready');
    await sleep(20);
    first.emitError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await until(() => h.failures.length === 1, 'failure reported');
    expect(h.failures[0]?.error).toContain('ECONNRESET');
    await until(() => h.ready.length === 2, 'reconnected');
    expect(first.closed).toBe(true);
    expect(first.errorListeners.size).toBe(0);
  });

  it('surfaces an error that arrives during IDLE as a failed session and reconnects', async () => {
    const h = harness();
    const first = new MockImap();
    // IDLE 只在被打断时返回——错误回调必须能打断它，循环才能立刻发现连接坏了。
    first.idleImpl = (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve('timeout'), { once: true });
      });
    h.script = [() => first];
    h.hub.start(h.record.id);
    await until(() => first.idleCalls === 1, 'idle');
    first.emitError(new Error('socket timeout'));
    await until(() => h.failures.length === 1, 'failure reported');
    expect(h.failures[0]?.error).toContain('socket timeout');
    await until(() => h.ready.length === 2, 'reconnected');
  });
});

describe('wake during poll catch-up (lost-wake race)', () => {
  it('does not drop a wake that arrives between catch-up and the poll delay', async () => {
    const h = harness({ mode: 'poll_only', pollIntervalSec: 3600, lastUid: 5 });
    const client = new MockImap();
    client.capabilities = [];
    // 第一次补拉停在 SEARCH：wake 落在「补拉结束 → 进入 3600s delay」之间。
    const searchGate = deferred();
    client.searchBarrier = searchGate.promise;
    h.script = [() => client];
    h.hub.start(h.record.id);
    await until(() => h.ready.length >= 1, 'ready');
    await until(() => client.searchBarrier !== null, 'catch-up search started');
    h.hub.wake(h.record.id);
    client.searchResult = [6];
    client.fetchResult = [
      {
        uid: 6,
        from: 'a@b.c',
        to: [],
        subject: 'after wake',
        date: '2026-10-24T00:00:00.000Z',
        text: 'x',
        attachments: [],
      },
    ];
    searchGate.resolve();
    client.searchBarrier = null;
    // 旧实现会换掉 AbortController，随后 delay 睡满 pollInterval；这里必须在远短于 3600s 内补到。
    await until(() => h.messages.length >= 1, 'catch-up after wake', 2000);
    expect(h.messages[0]?.map((m) => m.uid)).toEqual([6]);
  });
});

describe('AppError passthrough', () => {
  it('classifies an AppError MAIL_AUTH_FAILED from the opener as fatal', async () => {
    const h = harness();
    h.script = [() => new AppError('MAIL_AUTH_FAILED', '登录失败') as unknown as Error];
    h.hub.start(h.record.id);
    await until(() => h.failures.length === 1, 'failure');
    expect(h.failures[0]?.info.fatal).toBe(true);
  });
});
