import { multistream, pino as pinoFactory, type Logger } from 'pino';
import pinoRollFactory from 'pino-roll';

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|authorization|cookie|credential)/i;

export const REDACTED = '[REDACTED]';

/**
 * Redacts sensitive keys anywhere in a structured value. Used on every log
 * record before it reaches a stream, and by the run-step writer for anything
 * it persists (01-conventions.md).
 */
export function redactRecord<T>(record: T, seen = new WeakSet<object>()): T {
  if (typeof record !== 'object' || record === null) return record;
  if (seen.has(record as object)) return record;
  seen.add(record as object);

  if (Array.isArray(record)) {
    return record.map((item) => redactRecord(item, seen)) as unknown as T;
  }
  if (record instanceof Date || Buffer.isBuffer(record)) return record;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = REDACTED;
    } else {
      output[key] = redactRecord(value, seen);
    }
  }
  return output as unknown as T;
}

/**
 * Replaces known secret values inside arbitrary strings. The caller passes
 * decrypted secrets (from the sensitive-data table); they never reach a log
 * file or a run step.
 */
export function createValueRedactor(secrets: readonly string[]): (text: string) => string {
  const nonEmpty = secrets.filter((s) => s.length > 0);
  return (text: string) => {
    let result = text;
    for (const secret of nonEmpty) {
      result = result.split(secret).join(REDACTED);
    }
    return result;
  };
}

interface RedactableTarget {
  write(chunk: unknown): unknown;
  end(): void;
  once(event: string, listener: () => void): unknown;
  /** SonicBoom sets this once `end()` has torn the fd down. */
  destroyed?: boolean;
}

/** Sync throw from SonicBoom.write, or a stream write after destroy/end. */
function isClosedDestinationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = 'message' in error ? String(error.message) : '';
  if (message === 'SonicBoom destroyed') return true;
  const code = 'code' in error ? error.code : undefined;
  return (
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_STREAM_CLOSED' ||
    code === 'ERR_STREAM_WRITE_AFTER_END'
  );
}

/**
 * A log after `close()` must not throw. Callers often log from a fire-and-forget
 * `.catch()` (env install, startup checks); a throw there is an unhandled rejection
 * and fails the process. Real IO errors still propagate.
 */
function writeOrIgnoreClosed(target: RedactableTarget, chunk: unknown): void {
  if (target.destroyed === true) return;
  try {
    const result = target.write(chunk);
    if (isThenable(result)) {
      void result.then(
        () => undefined,
        (error: unknown) => {
          if (isClosedDestinationError(error)) return;
          // A rejected write must not sit as an unhandled rejection. Surface it
          // the same way an 'error' event with no listener would.
          process.nextTick(() => {
            throw error instanceof Error ? error : new Error(String(error));
          });
        },
      );
    }
  } catch (error) {
    if (!isClosedDestinationError(error)) throw error;
  }
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * pino serializes records (including child bindings) before handing them to
 * the destination stream, so the destination is the single point where every
 * record can be redacted reliably.
 */
function redactingStream(target: RedactableTarget): RedactableTarget {
  return {
    write(chunk) {
      const text = typeof chunk === 'string' ? chunk : String(chunk);
      // Parse/redact failures fall back to the original chunk. Write failures
      // are separate: a destroyed SonicBoom throws, and retrying the write
      // throws again.
      try {
        const record = JSON.parse(text) as unknown;
        writeOrIgnoreClosed(target, `${JSON.stringify(redactRecord(record))}\n`);
      } catch (error) {
        if (isClosedDestinationError(error)) return;
        writeOrIgnoreClosed(target, chunk);
      }
    },
    end() {
      try {
        target.end();
      } catch (error) {
        if (!isClosedDestinationError(error)) throw error;
      }
    },
    once(event, listener) {
      return target.once(event, listener);
    },
  };
}

export interface CoreLogger extends Logger {
  /** Ends the rotating file stream and resolves once it is flushed. */
  close(): Promise<void>;
}

export interface CreateLoggerOptions {
  logsDir: string;
  /** Also write to stdout (dev mode). */
  dev?: boolean;
  level?: string;
}

const RETAINED_LOG_FILES = 14;

export async function createLogger(options: CreateLoggerOptions): Promise<CoreLogger> {
  const rollStream = await pinoRollFactory({
    file: `${options.logsDir}/kepcup.log`,
    frequency: 'daily',
    limit: { count: RETAINED_LOG_FILES },
    mkdir: true,
    extension: 'log',
  });
  // pino-roll's SonicBoom emits 'error' from async flush/reopen/close. With no
  // listener Node throws. Destroyed/closed is expected after shutdown; other
  // IO errors still fail the process.
  rollStream.on('error', (error: unknown) => {
    if (isClosedDestinationError(error)) return;
    throw error instanceof Error ? error : new Error(String(error));
  });

  const streams: RedactableTarget[] = [rollStream];
  if (options.dev) {
    streams.push({
      write(chunk) {
        process.stdout.write(typeof chunk === 'string' ? chunk : String(chunk));
      },
      end() {},
      once() {},
    });
  }

  const logger = pinoFactory(
    {
      level: options.level ?? 'info',
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
    multistream(
      streams.map((stream) => ({ level: 'trace' as const, stream: redactingStream(stream) })),
    ),
  );

  const coreLogger = logger as CoreLogger;
  coreLogger.close = () => {
    // The file destination opens and flushes asynchronously; wait for the
    // underlying stream to close so no records are lost on shutdown.
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref?.();
      rollStream.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        rollStream.end();
      } catch (error) {
        if (!isClosedDestinationError(error)) throw error;
        clearTimeout(timer);
        resolve();
      }
    });
  };
  return coreLogger;
}
