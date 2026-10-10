import type { ZodError, ZodType } from 'zod';
import { createBirpc, type BirpcReturn } from 'birpc';
import { AppError } from '../errors.js';
import { RPC_CALL_TIMEOUT_MS } from '../constants.js';
import type { RpcTransport } from './transport.js';

/**
 * Wire-level error envelope (mirrors core/rpc/server.ts, which re-exports
 * these). birpc serializes thrown errors as-is, but a structured clone across
 * a MessagePort drops custom properties of Error instances; plain objects
 * survive. Handlers throw this object instead of an Error and clients unwrap
 * it back into an AppError.
 */
export interface RpcErrorEnvelope {
  __kepcupError: true;
  code: string;
  message: string;
  details?: unknown;
}

export function toErrorEnvelope(error: unknown): RpcErrorEnvelope {
  if (error instanceof AppError) {
    return error.details !== undefined
      ? {
          __kepcupError: true,
          code: error.code,
          message: error.message,
          details: error.details,
        }
      : { __kepcupError: true, code: error.code, message: error.message };
  }
  return {
    __kepcupError: true,
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function unwrapErrorEnvelope(error: unknown): Error {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as RpcErrorEnvelope).__kepcupError === true
  ) {
    const envelope = error as RpcErrorEnvelope;
    return new AppError(envelope.code, envelope.message, envelope.details);
  }
  if (error instanceof Error) {
    return new AppError('INTERNAL', error.message);
  }
  return new AppError('INTERNAL', String(error));
}

export interface RpcMethodSpec {
  input: ZodType;
  output: ZodType;
  handle: (input: unknown) => Promise<unknown>;
}

function summarizeIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

async function runSpec(spec: RpcMethodSpec, input: unknown, name: string): Promise<unknown> {
  const parsed = spec.input.safeParse(input);
  if (!parsed.success) {
    throw new AppError('INVALID_INPUT', `Invalid input for ${name}`, {
      issues: summarizeIssues(parsed.error),
    });
  }
  const result = await spec.handle(parsed.data);
  const outCheck = spec.output.safeParse(result);
  if (!outCheck.success) {
    throw new AppError('INTERNAL', `Invalid output for ${name}`, {
      issues: summarizeIssues(outCheck.error),
    });
  }
  return outCheck.data;
}

export interface RpcChannel {
  /** Calls a method served by the remote side of this transport. */
  call(method: string, input?: unknown): Promise<unknown>;
  /** Push an event to the remote side (fire-and-forget). */
  pushEvent(name: string, payload: unknown): void;
  /** Rejects calls that are still pending (used when the transport dies). */
  rejectPending(reason: string): void;
  close(): void;
}

export interface CreateRpcChannelOptions {
  transport: RpcTransport;
  /** Methods served locally for the remote side (zod-validated). */
  methods: Record<string, RpcMethodSpec>;
  /** Event names pushed by the remote side; locally handled here. */
  eventHandlers?: Record<string, ((payload: unknown) => void) | undefined>;
  timeoutMs?: number;
}

/**
 * One birpc instance per transport that BOTH serves validated methods and
 * calls the remote side. The platform port (B) uses this on both ends: the
 * core serves system.shutdown / power.* and calls browser.* (P11), the main
 * process serves browser.* and calls the core's platform methods. A single
 * instance per side is required — two birpc instances on one transport would
 * both answer the same request id.
 */
export function createRpcChannel(options: CreateRpcChannelOptions): RpcChannel {
  const handlers: Record<string, (payload: unknown) => unknown> = {};
  for (const [name, spec] of Object.entries(options.methods)) {
    handlers[name] = async (input: unknown) => {
      try {
        return await runSpec(spec, input, name);
      } catch (error) {
        throw toErrorEnvelope(error);
      }
    };
  }
  for (const [name, handler] of Object.entries(options.eventHandlers ?? {})) {
    handlers[name] = handler ?? (() => undefined);
  }

  const rpc: BirpcReturn<Record<string, (...args: unknown[]) => unknown>, typeof handlers> =
    createBirpc<Record<string, (...args: unknown[]) => unknown>, typeof handlers>(handlers, {
      post: (data) => options.transport.post(data),
      on: (fn) => {
        options.transport.onData(fn as (data: unknown) => void);
      },
      timeout: options.timeoutMs ?? RPC_CALL_TIMEOUT_MS,
    });

  return {
    async call(method, input) {
      try {
        return await rpc.$call(method, input);
      } catch (error) {
        throw unwrapErrorEnvelope(error);
      }
    },
    pushEvent(name, payload) {
      void rpc.$callEvent(name, payload).catch(() => {
        // Delivery failures surface through transport state; events are fire-and-forget.
      });
    },
    rejectPending(reason) {
      void rpc.$rejectPendingCalls(({ reject }) => reject(new Error(reason)));
    },
    close() {
      rpc.$close();
    },
  };
}
