import type { Clock } from '../infra/clock.js';

/**
 * 按 key 的令牌桶（D120 审查修复）：超限丢更新 / 回 RATE_LIMITED，不断开连接。
 * 内存态，不需要持久化；key 用 clientId。
 */
export class TokenBucket {
  readonly #clock: Clock;
  readonly #ratePerSecond: number;
  readonly #burst: number;
  readonly #buckets = new Map<string, { tokens: number; last: number }>();

  constructor(clock: Clock, ratePerSecond: number, burst: number) {
    this.#clock = clock;
    this.#ratePerSecond = ratePerSecond;
    this.#burst = burst;
  }

  take(key: string): boolean {
    const now = this.#clock.now();
    const existing = this.#buckets.get(key);
    const tokens =
      existing === undefined
        ? this.#burst
        : Math.min(
            this.#burst,
            existing.tokens + ((now - existing.last) / 1000) * this.#ratePerSecond,
          );
    if (tokens < 1) {
      this.#buckets.set(key, { tokens, last: now });
      return false;
    }
    this.#buckets.set(key, { tokens: tokens - 1, last: now });
    return true;
  }

  clear(): void {
    this.#buckets.clear();
  }
}
