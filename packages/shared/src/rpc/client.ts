import { createBirpc, type BirpcReturn } from 'birpc';
import { AppError } from '../errors.js';
import { RPC_CALL_TIMEOUT_MS } from '../constants.js';
import type { RpcTransport } from './transport.js';

type RemoteFunctions = Record<string, (...args: unknown[]) => unknown>;
type LocalFunctions = Record<string, ((payload: unknown) => void) | undefined>;

export interface RpcClient {
  call(method: string, input?: unknown): Promise<unknown>;
  /** Reject calls that are still pending (used when the transport dies). */
  rejectPending(reason: string): void;
  close(): void;
}

export interface CreateRpcClientOptions {
  transport: RpcTransport;
  /** Handlers invoked when the remote side pushes an event, keyed by event name. */
  eventHandlers?: LocalFunctions;
  timeoutMs?: number;
}

export function createRpcClient(options: CreateRpcClientOptions): RpcClient {
  const rpc: BirpcReturn<RemoteFunctions, LocalFunctions> = createBirpc<
    RemoteFunctions,
    LocalFunctions
  >(options.eventHandlers ?? {}, {
    post: (data) => options.transport.post(data),
    on: (fn) => {
      options.transport.onData(fn as (data: unknown) => void);
    },
    timeout: options.timeoutMs ?? RPC_CALL_TIMEOUT_MS,
  });

  return {
    async call(method, input) {
      try {
        // JSON 线（WebSocket / 中转）会把 `[undefined]` 序列化成 `[null]`，
        // z.void() 拒绝 null——无参调用统一发空参数组（MessagePort 结构化克隆
        // 路径下 apply(rpc, []) 与 apply(rpc, [undefined]) 语义相同，桌面不受影响）。
        if (input === undefined) {
          return await rpc.$callRaw({ method, args: [] });
        }
        return await rpc.$call(method, input);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { __kepcupError?: unknown }).__kepcupError === true
        ) {
          const envelope = error as { code: string; message: string; details?: unknown };
          throw new AppError(envelope.code, envelope.message, envelope.details);
        }
        if (error instanceof Error) {
          // Transport-level failures (closed port, missing function, timeout).
          throw new AppError('INTERNAL', error.message);
        }
        throw new AppError('INTERNAL', String(error));
      }
    },
    rejectPending(reason) {
      void rpc.$rejectPendingCalls(({ reject }) => reject(new Error(reason)));
    },
    close() {
      rpc.$close();
    },
  };
}
