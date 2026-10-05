/**
 * Per-key async mutex: serializes async operations that share one mutable
 * resource identified by a string key. Same chaining pattern as the P04
 * checkpoint queue (project/checkpoints.ts #chain) extracted so later
 * consumers reuse one implementation — P08 per-bot authored-skill git
 * repositories here, P09 wiki maintenance next.
 *
 * The chain tail is removed once it settles, so idle keys do not accumulate.
 */
export class KeyedMutex {
  readonly #chains = new Map<string, Promise<unknown>>();

  /** Runs `body` exclusively among callers with the same key (FIFO). */
  run<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const next = previous.then(body, body);
    const tail = next.catch(() => {}); // the chain never rejects
    this.#chains.set(key, tail);
    void tail.then(() => {
      if (this.#chains.get(key) === tail) this.#chains.delete(key);
    });
    return next;
  }

  /**
   * Drops the chain for a key whose resource is gone (e.g. bot deleted),
   * resolving once everything queued for the key has drained (BR-P09-010).
   * The chain is never cut while a body is in flight: cutting it would let a
   * new caller race the body that still owns the resource. Callers that
   * remove the underlying resource should await this before destroying it.
   * Queued bodies observe the removal themselves (existence re-checks).
   */
  async forget(key: string): Promise<void> {
    const tail = this.#chains.get(key);
    if (tail !== undefined) await tail;
  }
}
