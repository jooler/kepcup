export interface EventBus<M extends object> {
  on<K extends keyof M & string>(event: K, handler: (payload: M[K]) => void): () => void;
  emit<K extends keyof M & string>(event: K, payload: M[K]): void;
  /** Remove every listener; used on shutdown. */
  clear(): void;
}

/** In-process pub/sub. Cross-process notification goes through RPC events instead. */
export function createEventBus<M extends object>(): EventBus<M> {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  return {
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler as (payload: unknown) => void);
      return () => {
        set?.delete(handler as (payload: unknown) => void);
      };
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch {
          // A listener must never break the emitter; listener bugs surface in their own scope.
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}
