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

  /** CJS export: an async factory for the rotating destination stream (SonicBoom). */
  export default function createWriteStream(options: PinoRollOptions): Promise<{
    write(chunk: unknown): unknown;
    end(): void;
    once(event: string, listener: () => void): unknown;
  }>;
}
