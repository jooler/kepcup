import type { FetchedMail, MailImap, MailSearchQuery, MailboxState } from '../../src/mail/message.js';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class MockImap implements MailImap {
  capabilities: string[] = ['IDLE'];
  closed = false;
  idleCalls = 0;
  readonly errorListeners = new Set<(error: Error) => void>();
  /** 下一次 SELECT 要等的闸门。 */
  selectBarrier: Promise<void> | null = null;
  searchBarrier: Promise<void> | null = null;
  fetchBarrier: Promise<void> | null = null;
  searchResult: number[] = [];
  fetchResult: FetchedMail[] = [];
  /** idle 的行为；默认等 signal 中止，2 秒兜底。 */
  idleImpl: ((signal: AbortSignal) => Promise<'exists' | 'timeout' | 'close'>) | null = null;
  noopImpl: (() => Promise<void>) | null = null;

  mailbox: MailboxState = { uidNext: 6, uidValidity: 1, unseen: 0 };

  async selectInbox(): Promise<MailboxState> {
    if (this.selectBarrier !== null) await this.selectBarrier;
    return this.mailbox;
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async search(_query: MailSearchQuery): Promise<number[]> {
    if (this.searchBarrier !== null) await this.searchBarrier;
    return this.searchResult;
  }

  async fetch(): Promise<FetchedMail[]> {
    if (this.fetchBarrier !== null) await this.fetchBarrier;
    return this.fetchResult;
  }

  async idle(signal: AbortSignal): Promise<'exists' | 'timeout' | 'close'> {
    this.idleCalls += 1;
    if (this.idleImpl !== null) return await this.idleImpl(signal);
    if (signal.aborted) return 'timeout';
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 2000);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve('timeout');
        },
        { once: true },
      );
    });
  }

  async noop(): Promise<void> {
    if (this.noopImpl !== null) await this.noopImpl();
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
