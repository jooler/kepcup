import type { ZodType, ZodError } from 'zod';
import { AppError, type RpcTransport } from '@kepcup/shared';
import {
  toErrorEnvelope,
  unwrapErrorEnvelope,
  type RpcErrorEnvelope,
  type RpcMethodSpec,
} from '@kepcup/shared';
import { createBirpc, type BirpcReturn } from 'birpc';

// The envelope format and RpcMethodSpec are shared with createRpcChannel
// (packages/shared/src/rpc/channel.ts); re-exported here so existing core
// imports keep working.
export { toErrorEnvelope, unwrapErrorEnvelope };
export type { RpcErrorEnvelope, RpcMethodSpec };

type RemoteFunctions = Record<string, (...args: unknown[]) => unknown>;
type LocalFunctions = Record<string, ((payload: unknown) => void) | undefined>;

export interface RpcServerHandle {
  /** Push an event to the connected client (fire-and-forget). */
  pushEvent(name: string, payload: unknown): void;
  close(): void;
}

export interface CreateRpcServerOptions {
  transport: RpcTransport;
  methods: Record<string, RpcMethodSpec>;
  /** Locally-handled event names for the remote side; unused on the server. */
  timeoutMs?: number;
  /**
   * Called for every failed method call (after the error is normalized into
   * an envelope, before it crosses the wire). The envelope is all the client
   * ever sees, so this is the only place the core can log what failed.
   */
  onError?: (method: string, error: RpcErrorEnvelope) => void;
}

/**
 * Binds validated RPC methods to a transport. Input is checked with the
 * method's zod schema (INVALID_INPUT on failure); output is checked to catch
 * handler bugs (INTERNAL). All failures cross the wire as error envelopes.
 */
export function createRpcServer(options: CreateRpcServerOptions): RpcServerHandle {
  const handlers: LocalFunctions = {};
  for (const [name, spec] of Object.entries(options.methods)) {
    handlers[name] = async (input: unknown) => {
      try {
        const parsed = parseOrThrow(spec.input, input, name);
        const result = await spec.handle(parsed);
        const outCheck = spec.output.safeParse(result);
        if (!outCheck.success) {
          throw new AppError('INTERNAL', `Invalid output for ${name}`, {
            issues: summarizeIssues(outCheck.error),
          });
        }
        return outCheck.data;
      } catch (error) {
        const envelope = isEnvelope(error) ? error : toErrorEnvelope(error);
        options.onError?.(name, envelope);
        throw envelope;
      }
    };
  }

  const rpc: BirpcReturn<RemoteFunctions, LocalFunctions> = createBirpc<
    RemoteFunctions,
    LocalFunctions
  >(handlers, {
    post: (data) => options.transport.post(data),
    on: (fn) => {
      options.transport.onData(fn as (data: unknown) => void);
    },
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });

  return {
    pushEvent(name, payload) {
      void rpc.$callEvent(name, payload).catch(() => {
        // Delivery failures surface through transport state; events are fire-and-forget.
      });
    },
    close() {
      rpc.$close();
    },
  };
}

function parseOrThrow(schema: ZodType, input: unknown, method: string): unknown {
  const check = schema.safeParse(input);
  if (!check.success) {
    throw new AppError('INVALID_INPUT', `Invalid input for ${method}`, {
      issues: summarizeIssues(check.error),
    });
  }
  return check.data;
}

function summarizeIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function isEnvelope(value: unknown): value is RpcErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as RpcErrorEnvelope).__kepcupError === true
  );
}
