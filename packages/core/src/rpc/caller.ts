import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Caller context (62.11 C1, docs/design/62-team-server/11-core-seams.md): who is
 * invoking an RPC method. Hosts that embed core (team server, remote hub, …)
 * wrap their per-connection method dispatch in `withCaller`; the identity then
 * travels with the async call chain (AsyncLocalStorage, same pattern as
 * `remote/audit.ts` `withRemoteSource`) without changing the
 * `RpcMethodSpec.handle(input)` signature.
 *
 * Read discipline: `currentCaller()` may only be read at the RPC binding layer
 * (`rpc/bindings.ts` and other `*-bindings.ts`); bindings pass the identity
 * down as an explicit parameter. Domain / dispatch / memory code must not read
 * it — the ALS context propagates into background runs and jobs triggered by
 * an RPC, and reading it there would wrongly attribute host-driven work to a
 * caller.
 *
 * Dormant by default: without a `withCaller` wrapper `currentCaller()` returns
 * null and every runtime path behaves exactly as before.
 */

export interface RpcCaller {
  /** Opaque human-principal id (`mbr_*` at the team layer; core does not care). */
  principalId: string;
  /** Device the call originates from, when the host knows one. */
  deviceId?: string;
}

const storage = new AsyncLocalStorage<RpcCaller>();

/** Run `task` inside the given caller context (the host's RPC wrapper). */
export function withCaller<T>(caller: RpcCaller, task: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(storage.run(caller, task));
}

/** Current caller context, or null when no `withCaller` wrapper is active. */
export function currentCaller(): RpcCaller | null {
  const caller = storage.getStore();
  return caller === undefined ? null : caller;
}
