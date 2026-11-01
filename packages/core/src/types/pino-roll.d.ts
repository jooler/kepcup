declare module 'pino-roll' {
  export interface PinoRollOptions {
    file: string;
    frequency?: 'daily' | 'hourly' | 'minutely' | number | string;
    limit?: { count?: number; size?: string | number };
    mkdir?: boolean;
    extension?: string;
    dateFormat?: string;
    symlink?: boolean;
  }

  /**
   * CJS export: an async factory for the rotating destination stream (SonicBoom,
   * an EventEmitter). `on` is the persistent listener (`error`); `once` is used
   * for `close`.
   */
  export default function createWriteStream(options: PinoRollOptions): Promise<{
    write(chunk: unknown): unknown;
    end(): void;
    once(event: string, listener: () => void): unknown;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    /** Set once `end()` has torn the fd down; later `write` throws. */
    destroyed?: boolean;
  }>;
}
